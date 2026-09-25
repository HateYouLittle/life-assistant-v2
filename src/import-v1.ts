import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { DateTime } from "luxon";
import { loadConfig, PROFILE_ID_RE } from "./config.js";
import { TZ } from "./time.js";
import { openDatabase, withTransaction } from "./core/database.js";
import { logger } from "./core/logger.js";
import { ensureProfile, setSetting } from "./core/settings.js";
import type { Recurrence } from "./core/recurrence.js";

/**
 * v1 → v2 一次性导入：旧库只读打开，映射 profiles/静默时段/日程/账本/支出/节假日。
 * 拒绝写入非空目标库（--force 跳过）。旧共享账本的角色/成员不迁移（v2 全局可编辑）。
 */

export interface ImportProblem {
  table: string;
  id: string;
  reason: string;
}

export interface ImportReport {
  profiles: number;
  schedules: number;
  scheduleWarnings: string[];
  /** 逐行隔离掉的坏数据（表 / 主键 / 原因）；这些行未导入 */
  problems: ImportProblem[];
  ledgers: number;
  expenses: number;
  entriesSkipped: number;
  holidayDays: number;
  holidayYears: number;
  occurrencesDropped: number;
}

/** 逐行隔离：一条坏数据不应导致整库零行导入 */
function problem(report: ImportReport, table: string, id: string, reason: string): void {
  report.problems.push({ table, id, reason });
}

/**
 * 读旧库的一张表，「表不存在」与「读失败」必须分开：
 * 前者是正常的（旧版本没有这张表），后者若也当成「没有这张表」，就会整表静默跳过、
 * 报告仍是成功（problems 为空 → 退出码 0），用户按提示重试也没用。
 * 真实触发：某行含超出 JS 安全整数范围的 int64（node:sqlite 读该行抛 ERR_OUT_OF_RANGE），
 * 或旧库仍被 v1 进程占用（SQLITE_BUSY）。
 */
function readOldTable<T>(
  report: ImportReport,
  table: string,
  missingHint: string,
  load: () => T[],
): T[] {
  try {
    return load();
  } catch (e) {
    if (/no such table/i.test(errorText(e))) {
      warnings(report, `旧库没有 ${table} 表，${missingHint}`);
    } else {
      problem(report, table, "-", `无法读取旧库的 ${table} 表，整表未导入：${errorText(e)}`);
    }
    return [];
  }
}

const DATE_RE_IMPORT = /^\d{4}-\d{2}-\d{2}$/;

/** 账本名在 v2 中要求活跃账本内唯一，旧库可能重名 */
function uniqueLedgerName(
  target: ReturnType<typeof openDatabase>,
  name: string,
  selfId: string,
): string {
  // 两个条件缺一不可：
  // - 排除自身 id：重跑 --force 时同一账本已存在，否则会被无谓改名成「X (2)」（现在账本走 upsert，不会先删后插）；
  // - 只看活跃账本：v2 自身规则（createLedger/renameLedger）只要求活跃账本内唯一，
  //   已归档的同名账本不该逼着导入改名。
  const taken = (candidate: string): boolean =>
    target
      .prepare("SELECT 1 FROM ledgers WHERE name = ? AND id != ? AND archived_at IS NULL")
      .get(candidate, selfId) !== undefined;
  if (!taken(name)) return name;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${name} (${i})`;
    if (!taken(candidate)) return candidate;
  }
  return `${name} (${Date.now()})`;
}

const STATUS_MAP: Record<string, "active" | "done" | "cancelled"> = {
  active: "active",
  completed: "done",
  done: "done",
  cancelled: "cancelled",
  canceled: "cancelled",
};

const WEEKDAY_MAP: Record<string, number> = {
  mo: 0,
  tu: 1,
  we: 2,
  th: 3,
  fr: 4,
  sa: 5,
  su: 6,
  monday: 0,
  tuesday: 1,
  wednesday: 2,
  thursday: 3,
  friday: 4,
  saturday: 5,
  sunday: 6,
};

function mapWeekday(raw: string): number | null {
  const key = String(raw).trim().toLowerCase();
  // 必须用 Object.hasOwn：`"constructor" in WEEKDAY_MAP` 为真，会取到 Object 构造函数，
  // 序列化后变成 null 混进 byweekday（再由 recurrence 的过滤逻辑静默落到周一）。
  if (Object.hasOwn(WEEKDAY_MAP, key)) return WEEKDAY_MAP[key] ?? null;
  const n = Number(key);
  if (Number.isInteger(n) && n >= 0 && n <= 6) return n;
  return null;
}

interface OldSchedule {
  profile_id: string;
  id: string;
  type: string;
  title: string;
  note: string | null;
  status: string;
  calendar: string;
  date: string | null;
  lunar_month: number | null;
  lunar_day: number | null;
  leap_month_policy: string | null;
  time: string;
  all_day: number;
  recurrence_json: string | null;
  reminders_json: string | null;
  reminder_interval_minutes: number | null;
  enabled: number;
  version: number;
  created_at: string;
  updated_at: string;
}

function mapRecurrence(
  raw: string | null,
  calendar: string,
  title: string,
  warnings: string[],
  startDate: string | null,
): { recurrence: Recurrence | null; workdayFilter: "any" | "workday" | "holiday" } {
  if (raw === null || raw.trim() === "" || raw === "{}")
    return { recurrence: null, workdayFilter: "any" };
  let parsed: {
    frequency?: string;
    interval?: number;
    byWeekday?: string[];
    until?: string;
    count?: number;
  };
  try {
    const json: unknown = JSON.parse(raw);
    // 形态校验不是洁癖：直接取属性会让一条脏行（JSON null / 数组 / 标量）抛 TypeError，
    // 调用点若不在逐行 try 内，异常会穿出事务、把整次导入回滚成 0 行。
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      warnings.push(`日程「${title}」recurrence_json 不是对象，按一次性导入`);
      return { recurrence: null, workdayFilter: "any" };
    }
    parsed = json as typeof parsed;
  } catch {
    warnings.push(`日程「${title}」recurrence_json 无法解析，按一次性导入`);
    return { recurrence: null, workdayFilter: "any" };
  }
  const interval =
    typeof parsed.interval === "number" && parsed.interval >= 1
      ? Math.min(parsed.interval, 365)
      : 1;
  const base = {
    interval,
    // until/count 同样只收合法形状：非字符串的 until 会让 recurrence 引擎拿到非法边界
    until: typeof parsed.until === "string" ? parsed.until : undefined,
    count: Number.isInteger(parsed.count) ? parsed.count : undefined,
  };
  // byWeekday 可能是标量（v1 只选一个星期几时很自然）：非数组按「没有可识别星期」处理，
  // 走下面的回退分支，而不是在 .map 上抛错。
  const weeklyDays = (Array.isArray(parsed.byWeekday) ? parsed.byWeekday : [])
    .map(mapWeekday)
    .filter((d): d is number => d !== null);
  switch (parsed.frequency) {
    case "once":
      return { recurrence: null, workdayFilter: "any" };
    case "daily":
      return { recurrence: { freq: "daily", ...base }, workdayFilter: "any" };
    case "weekly": {
      // 空的 byweekday 会让 recurrence 引擎无候选日可产出，此前会导致进程同步死循环。
      // 旧库的星期写法可能认不出来，此时回退到「开始日期的星期」（等价于每周一次）。
      if (weeklyDays.length > 0) {
        return {
          recurrence: { freq: "weekly", ...base, byweekday: weeklyDays },
          workdayFilter: "any",
        };
      }
      const fallback = weekdayOf(startDate);
      if (fallback !== null) {
        warnings.push(
          `日程「${title}」的旧每周规则没有可识别的星期（byWeekday=${JSON.stringify(parsed.byWeekday ?? [])}），已按开始日期的星期导入`,
        );
        return {
          recurrence: { freq: "weekly", ...base, byweekday: [fallback] },
          workdayFilter: "any",
        };
      }
      warnings.push(
        `日程「${title}」的旧每周规则没有可识别的星期且缺少开始日期，已降级为一次性导入`,
      );
      return { recurrence: null, workdayFilter: "any" };
    }
    case "monthly":
      return { recurrence: { freq: "monthly", ...base }, workdayFilter: "any" };
    case "yearly":
      return { recurrence: { freq: "yearly", ...base }, workdayFilter: "any" };
    case "workday":
      if (calendar !== "solar") break;
      return { recurrence: { freq: "daily", ...base }, workdayFilter: "workday" };
    case "holiday":
      if (calendar !== "solar") break;
      return { recurrence: { freq: "daily", ...base }, workdayFilter: "holiday" };
  }
  warnings.push(
    `日程「${title}」的循环类型 ${String(parsed.frequency)}（${calendar}）不支持，按每年循环导入`,
  );
  return { recurrence: { freq: "yearly", ...base }, workdayFilter: "any" };
}

/** 公历日期字符串 → recurrence 的星期编号（0=周一..6=周日）；不可解析返回 null */
function weekdayOf(date: string | null): number | null {
  if (date === null || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const dt = DateTime.fromISO(date, { zone: TZ });
  return dt.isValid ? dt.weekday - 1 : null;
}

function mapReminders(raw: string | null, title: string, warnings: string[]): number[] {
  if (raw === null || raw.trim() === "") return [0];
  try {
    const json: unknown = JSON.parse(raw);
    // 与 mapRecurrence 同因：非数组（如 `{}`）取 .filter 会抛错，不能让它穿出事务
    if (!Array.isArray(json)) {
      warnings.push(`日程「${title}」reminders_json 不是数组，按到点提醒导入`);
      return [0];
    }
    const parsed = json.filter(
      (r): r is { minutesBefore?: number; target?: string } => typeof r === "object" && r !== null,
    );
    const offsets = parsed
      .filter((r) => r.target === undefined || r.target === "occurrence")
      .map((r) => -(typeof r.minutesBefore === "number" ? r.minutesBefore : 0));
    const deadlines = parsed.filter((r) => r.target === "deadline").length;
    if (deadlines > 0)
      warnings.push(`日程「${title}」有 ${deadlines} 个 deadline 提醒，v2 不支持已丢弃`);
    if (offsets.length === 0) return [0];
    return offsets.slice(0, 5);
  } catch {
    warnings.push(`日程「${title}」reminders_json 无法解析，按到点提醒导入`);
    return [0];
  }
}

/**
 * --force 的「覆盖」语义：只清除**旧库里存在、本次会重新写入的那些行**（按主键），
 * 不做全库清空，也不按 Profile / 账本整片清空。
 *
 * 为什么必须精确到主键：
 * - 通知与投递历史导入从不写入，删掉就永久丢失（重跑 --force 的动机往往只是「补一条日程」）；
 * - 按账本删账目会连带删掉 v2 期间手工录入的流水，而重导只补 v1 的行；
 * - 无关 Profile / 账本的数据更不应因为一次导入被删掉。
 *
 * 账本行不在这里删：插入改为 upsert（见 insertLedger），于是预算（budgets 外键级联）
 * 不会随重建账本被清空。
 * 删除与插入同事务 —— 中途失败会整体回滚，原数据保持不变。
 */
function forceClearImported(
  target: ReturnType<typeof openDatabase>,
  old: DatabaseSync,
  report: ImportReport,
): void {
  const idsFrom = (sql: string): string[] => {
    try {
      return (old.prepare(sql).all() as { id: string }[]).map((r) => r.id);
    } catch {
      // 旧库没有该表：本次导入也没有要写的行，无需清理
      return [];
    }
  };
  const steps: Array<{ label: string; table: string; ids: string[] }> = [
    { label: "schedules", table: "schedules", ids: idsFrom("SELECT id FROM schedules") },
    {
      label: "expenses",
      table: "expenses",
      ids: idsFrom("SELECT id FROM ledger_entries WHERE type = 'expense'"),
    },
  ];

  let cleared = 0;
  for (const step of steps) {
    if (step.ids.length === 0) continue;
    try {
      const result = target
        .prepare(`DELETE FROM ${step.table} WHERE id IN (SELECT value FROM json_each(?))`)
        .run(JSON.stringify(step.ids));
      cleared += Number(result.changes);
    } catch (e) {
      // 交付表/occurrence 由外键级联清理；这里失败不阻断导入本身
      warnings(report, `--force 清理 ${step.label} 失败（将按新增处理）：${errorText(e)}`);
    }
  }
  if (cleared > 0) {
    warnings(report, `--force 已覆盖 ${cleared} 行既有数据（仅限旧库中存在、本次会重写的行）`);
  }
}

export function runImport(
  target: ReturnType<typeof openDatabase>,
  oldPath: string,
  force = false,
): ImportReport {
  const report: ImportReport = {
    profiles: 0,
    schedules: 0,
    scheduleWarnings: [],
    problems: [],
    ledgers: 0,
    expenses: 0,
    entriesSkipped: 0,
    holidayDays: 0,
    holidayYears: 0,
    occurrencesDropped: 0,
  };
  for (const table of ["schedules", "ledgers", "notifications"]) {
    const row = target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    if (row.n > 0 && !force) {
      throw new Error(
        `目标库非空（${table} 有 ${row.n} 行）。如确认覆盖请加 --force（建议先 db:backup）`,
      );
    }
  }
  const old = new DatabaseSync(oldPath, { readOnly: true });
  try {
    withTransaction(target, () => {
      if (force) {
        forceClearImported(target, old, report);
      }
      for (const row of old.prepare("SELECT profile_id FROM profiles").all() as {
        profile_id: string;
      }[]) {
        if (!PROFILE_ID_RE.test(row.profile_id)) {
          // v2 的 Profile 名有格式约束；导入非法名会让该 Profile 永远无法通过
          // X-Hermes-Profile 访问，其依赖行也会触发外键错误。
          problem(
            report,
            "profiles",
            row.profile_id,
            `Profile 名不合法（需匹配 ${PROFILE_ID_RE}），未导入；其日程/通知也会一并跳过`,
          );
          continue;
        }
        // 按 changes 计数：重跑 --force 时 INSERT OR IGNORE 不会新增行，
        // 按调用次数累加会让「已导入 N 个 Profile」虚高（其余各项都按 changes 计）
        if (ensureProfile(target, row.profile_id)) report.profiles += 1;
      }

      const settings = readOldTable(
        report,
        "profile_settings",
        "跳过静默时段",
        () =>
          old
            .prepare("SELECT profile_id, quiet_start, quiet_end FROM profile_settings")
            .all() as Array<{
            profile_id: string;
            quiet_start: string | null;
            quiet_end: string | null;
          }>,
      );
      for (const s of settings) {
        if (s.quiet_start === null || s.quiet_end === null) continue;
        // 与上面的 profiles 主循环同样必须校验：setSetting → ensureProfile 会直接建 Profile 行，
        // 非法名（含 HTML）一旦入库，状态页把它拼进 innerHTML 就是存储型 XSS。
        if (!PROFILE_ID_RE.test(s.profile_id)) {
          problem(
            report,
            "profile_settings",
            s.profile_id,
            `Profile 名不合法（需匹配 ${PROFILE_ID_RE}），静默时段未导入`,
          );
          continue;
        }
        try {
          setSetting(target, s.profile_id, "quiet_hours", {
            start: s.quiet_start,
            end: s.quiet_end,
          });
        } catch (e) {
          problem(report, "profile_settings", s.profile_id, `静默时段未导入：${errorText(e)}`);
        }
      }

      const schedules = readOldTable(
        report,
        "schedules",
        "跳过日程",
        () => old.prepare("SELECT * FROM schedules").all() as unknown as OldSchedule[],
      );
      const insertSchedule = target.prepare(
        `INSERT INTO schedules (id, profile_id, title, note, kind, calendar, start_date, lunar_month, lunar_day,
           leap_policy, lunar_clamp, time, all_day, recurrence_json, remind_offsets_json, resend_minutes,
           workday_filter, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of schedules) {
        // 整个映射+插入都在逐行 try 内：mapRecurrence/mapReminders 读的是旧库里的
        // 自由文本列，任何未预料到的形状都只会隔离这一行，不带整次导入回滚。
        try {
          const kind = ["todo", "birthday", "anniversary"].includes(s.type) ? s.type : "todo";
          const calendar = s.calendar === "lunar" ? "lunar" : "solar";
          const mappedStatus = STATUS_MAP[s.status];
          if (mappedStatus === undefined) {
            report.scheduleWarnings.push(
              `日程「${s.title}」旧状态「${s.status}」无法识别，按 active 处理`,
            );
          }
          const status = mappedStatus ?? "active";
          const { recurrence, workdayFilter } = mapRecurrence(
            s.recurrence_json,
            calendar,
            s.title,
            report.scheduleWarnings,
            s.date,
          );
          const offsets = mapReminders(s.reminders_json, s.title, report.scheduleWarnings);
          const resend =
            s.reminder_interval_minutes !== null && s.reminder_interval_minutes > 0
              ? Math.min(s.reminder_interval_minutes, 1440)
              : 0;
          if (resend > 0) {
            report.scheduleWarnings.push(
              `日程「${s.title}」强提醒降级为到点 ${resend} 分钟后重发一次`,
            );
          }
          const leapPolicy = s.leap_month_policy === "leap" ? "follow" : "regular";
          insertSchedule.run(
            s.id,
            s.profile_id,
            s.title,
            s.note,
            kind,
            calendar,
            calendar === "solar" ? s.date : null,
            calendar === "lunar" ? s.lunar_month : null,
            calendar === "lunar" ? s.lunar_day : null,
            calendar === "lunar" ? leapPolicy : null,
            s.time,
            s.all_day,
            recurrence === null ? null : JSON.stringify(recurrence),
            JSON.stringify(offsets),
            resend,
            workdayFilter,
            status,
            Math.max(s.version, 1),
            s.created_at,
            s.updated_at,
          );
          report.schedules += 1;
        } catch (e) {
          problem(report, "schedules", s.id, `日程「${s.title}」未导入：${errorText(e)}`);
        }
      }

      let occurrenceCount = 0;
      try {
        const row = old.prepare("SELECT COUNT(*) AS n FROM schedule_occurrences").get() as {
          n: number;
        };
        occurrenceCount = row.n;
      } catch {
        // 无该表
      }
      report.occurrencesDropped = occurrenceCount;

      const ledgers = readOldTable(
        report,
        "ledgers",
        "跳过账本",
        () =>
          old.prepare("SELECT id, name, created_at FROM ledgers").all() as Array<{
            id: string;
            name: string;
            created_at: string;
          }>,
      );
      // upsert 而不是「先删后插」：删账本会级联删掉预算（budgets 外键 ON DELETE CASCADE），
      // 而预算不是导入写的、重导也补不回来。
      const insertLedger = target.prepare(
        `INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, created_at = excluded.created_at`,
      );
      for (const l of ledgers) {
        try {
          const name = uniqueLedgerName(target, l.name, l.id);
          if (name !== l.name) {
            report.scheduleWarnings.push(
              `账本「${l.name}」名称与已存在账本重复，已改名为「${name}」`,
            );
          }
          insertLedger.run(l.id, name, l.created_at);
          report.ledgers += 1;
        } catch (e) {
          problem(report, "ledgers", l.id, `账本「${l.name}」未导入：${errorText(e)}`);
        }
      }
      if (report.ledgers > 0) {
        report.scheduleWarnings.push(
          `${report.ledgers} 个账本已迁移为全局可编辑（旧角色/成员信息不迁移）`,
        );
      }

      let entries: Array<{
        id: string;
        ledger_id: string;
        type: string;
        amount_cents: number;
        category: string | null;
        note: string | null;
        occurred_at: string;
        profile_id: string;
        created_at: string;
      }> = [];
      try {
        entries = old.prepare("SELECT * FROM ledger_entries").all() as unknown as typeof entries;
      } catch {
        warnings(report, "旧库没有 ledger_entries 表，跳过账目");
      }
      const insertExpense = target.prepare(
        `INSERT INTO expenses (id, ledger_id, amount_cents, category, note, spent_on, created_by_profile, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const e of entries) {
        if (e.type !== "expense") {
          report.entriesSkipped += 1;
          continue;
        }
        // v2 有 STRICT/CHECK 约束：金额必须是正整数分、spent_on 必须是真实日历日。
        // 逐行校验并隔离，避免一条脏数据让整库导入回滚成 0 行。
        if (!Number.isInteger(e.amount_cents) || e.amount_cents <= 0) {
          problem(
            report,
            "ledger_entries",
            e.id,
            `金额不合法（${String(e.amount_cents)}），需为正整数分`,
          );
          continue;
        }
        const ledgerExists = target.prepare("SELECT 1 FROM ledgers WHERE id = ?").get(e.ledger_id);
        if (ledgerExists === undefined) {
          problem(report, "ledger_entries", e.id, `引用的账本 ${e.ledger_id} 不存在，无法导入`);
          continue;
        }
        // 无法解析的 occurred_at 绝不能把非日期写进 spent_on —— 那会让该笔金额
        // 对所有按月汇总永久不可见（spent_on >= / <= 过滤），而报告却声称已导入。
        const localDate = toLocalDate(e.occurred_at);
        if (localDate === null) {
          problem(
            report,
            "ledger_entries",
            e.id,
            `occurred_at「${e.occurred_at}」不是合法时间，日期无法确定，未导入`,
          );
          continue;
        }
        try {
          insertExpense.run(
            e.id,
            e.ledger_id,
            e.amount_cents,
            e.category ?? "其他",
            e.note,
            localDate,
            e.profile_id,
            e.created_at,
          );
          report.expenses += 1;
        } catch (err) {
          problem(report, "ledger_entries", e.id, `账目未导入：${errorText(err)}`);
        }
      }
      if (report.entriesSkipped > 0) {
        report.scheduleWarnings.push(`${report.entriesSkipped} 条非支出账目（收入/转账）不迁移`);
      }

      const holidayDays = readOldTable(
        report,
        "cn_holiday_days",
        "跳过节假日",
        () =>
          old.prepare("SELECT * FROM cn_holiday_days").all() as unknown as Array<{
            date: string;
            year: number;
            day_type: string;
            name: string;
            source: string;
            updated_at: string;
          }>,
      );
      const insertDay = target.prepare(
        "INSERT OR IGNORE INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      // 导入失败过的年份不能标记 ready：年份一旦 ready，dayType 对缺失日期会退化成
      // 「按星期猜」（周六日=weekend，其余=weekday），调休周六会被判成周末、
      // 假期里的工作日会被判成普通工作日 —— 日程静默错触发，且没有任何提示。
      const yearsWithBrokenDays = new Set<number>();
      // 键必须同时包含「行内 year」与「日期所属年份」：这里保护的是数据集的 year，
      // 而 dayType 的按星期兜底是按**日期的年份**查 cn_holiday_years。
      // 跨年行（如 2023.json 里的 2022-12-31，数据源确实存在）两者不同，
      // 只记前者会让真正有缺失的日期年份照样 ready → 退化到「按星期猜」。
      const markBroken = (d: { date: string; year: number }): void => {
        yearsWithBrokenDays.add(Number(d.date.slice(0, 4)));
        yearsWithBrokenDays.add(Number(d.year));
      };
      // OR IGNORE 会把 CHECK 违规（例如 day_type 非法）也静默吞掉：changes=0 且不抛错。
      // 所以「真的没写进去」必须靠「导入前该日期是否已存在」来区分，否则坏行会被当成正常跳过。
      const existingDates = new Set(
        (target.prepare("SELECT date FROM cn_holiday_days").all() as { date: string }[]).map(
          (r) => r.date,
        ),
      );
      for (const d of holidayDays) {
        // OR IGNORE：不覆盖目标库中由 ensureYears 抓取的更新数据（OR REPLACE 会静默覆盖）
        try {
          // 计数取 changes 而非行数：被 IGNORE 掉的行没有写入，计入会让报告
          // 声称「已导入 N 天节假日数据」而实际插入 0 行（重复导入时必然发生）。
          const result = insertDay.run(d.date, d.year, d.day_type, d.name, d.source, d.updated_at);
          const changes = Number(result.changes);
          report.holidayDays += changes;
          if (changes === 0 && !existingDates.has(d.date)) {
            problem(
              report,
              "cn_holiday_days",
              d.date,
              "节假日数据未导入：被约束拒绝（如 day_type 非法）",
            );
            markBroken(d);
          }
        } catch (e) {
          problem(report, "cn_holiday_days", d.date, `节假日数据未导入：${errorText(e)}`);
          markBroken(d);
        }
      }
      const holidayYears = readOldTable(
        report,
        "cn_holiday_year_meta",
        "跳过节假日年份元数据",
        () =>
          old
            .prepare(
              "SELECT year, status, source, fetched_at FROM cn_holiday_year_meta WHERE status = 'ready'",
            )
            .all() as Array<{ year: number; status: string; source: string; fetched_at: string }>,
      );
      const insertYear = target.prepare(
        `INSERT OR IGNORE INTO cn_holiday_years (year, status, source, fetched_at) VALUES (?, 'ready', ?, ?)`,
      );
      for (const y of holidayYears) {
        if (yearsWithBrokenDays.has(y.year)) {
          warnings(
            report,
            `${y.year} 年有节假日行未导入，未标记为 ready（避免在缺失日期上按星期猜）`,
          );
          continue;
        }
        try {
          // 同上：年份元数据也是 OR IGNORE，按 changes 计数才与实际写入一致
          const result = insertYear.run(y.year, y.source, y.fetched_at);
          report.holidayYears += Number(result.changes);
        } catch (e) {
          problem(
            report,
            "cn_holiday_years",
            String(y.year),
            `节假日年份元数据未导入：${errorText(e)}`,
          );
        }
      }
    });
  } finally {
    old.close();
  }
  return report;
}

function warnings(report: ImportReport, message: string): void {
  report.scheduleWarnings.push(message);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * V1 occurred_at 存 UTC ISO，换算到本地时区后取日历日。
 * 解析失败返回 null（由调用方隔离该行）——绝不回退成非日期字符串：
 * 那会让金额对所有按月汇总永久不可见。
 */
function toLocalDate(occurredAt: string): string | null {
  const dt = DateTime.fromISO(occurredAt, { zone: "utc" });
  if (!dt.isValid) return null;
  const local = dt.setZone(TZ).toISODate();
  if (local === null || !DATE_RE_IMPORT.test(local)) return null;
  return local;
}

const DB_CANDIDATE_NAMES = [
  "life-assistant.db",
  "life-assistant.sqlite",
  "assistant.db",
  "hermes.db",
];

/** v2 自身备份的命名（与 backup.ts 的 FILE_RE 一致） */
const V2_BACKUP_RE = /^life-assistant-\d{8}-\d{6}\.db$/;

/** 目录下疑似旧数据库（排除 -wal/-shm、备份文件与 v2 自身的备份产物） */
function scanDbFiles(from: string): string[] {
  try {
    return (
      readdirSync(from)
        // 先判扩展名再去排除项：-wal/-shm 不以 .db/.sqlite 结尾，放在后面永远不生效
        .filter((name) => name.endsWith(".db") || name.endsWith(".sqlite"))
        .filter((name) => !V2_BACKUP_RE.test(name))
        .filter((name) => !/\.bak-/.test(name) && !/\.backup-/.test(name))
        .map((name) => join(from, name))
        .sort()
    );
  } catch {
    return [];
  }
}

export function resolveOldDbPath(from: string): string {
  if (statSync(from).isFile()) return from;
  const tried: string[] = [];
  for (const name of DB_CANDIDATE_NAMES) {
    const candidate = join(from, name);
    tried.push(candidate);
    if (existsSync(candidate)) return candidate;
  }
  const scanned = scanDbFiles(from);
  if (scanned.length === 1) return scanned[0] as string;
  if (scanned.length > 1) {
    throw new Error(
      `目录 ${from} 下发现多个候选旧数据库，无法自动选择：${scanned.join(" / ")}；请用 --from 显式指定其中一个文件`,
    );
  }
  throw new Error(`目录 ${from} 下未找到旧数据库文件（已尝试：${tried.join(" / ")}）`);
}

function main(): void {
  const args = process.argv.slice(2);
  const fromIndex = args.indexOf("--from");
  if (fromIndex < 0 || args[fromIndex + 1] === undefined) {
    console.error("用法：npm run import:v1 -- --from <旧 DATA_DIR 或 旧 .db 文件> [--force]");
    process.exit(1);
  }
  const force = args.includes("--force");
  const config = loadConfig(process.env);
  let target: ReturnType<typeof openDatabase> | undefined;
  try {
    const oldPath = resolveOldDbPath(args[fromIndex + 1] as string);
    // 指向 v2 自己的数据目录会解析到目标库本身，等于自我导入
    if (resolve(oldPath) === resolve(config.dbPath)) {
      throw new Error(`源库与目标库是同一个文件：${oldPath}；--from 应指向 v1 的旧库`);
    }
    target = openDatabase(config.dbPath);
    const report = runImport(target, oldPath, force);
    logger.info(`导入完成：${JSON.stringify(report, null, 2)}`);
    console.log(
      `已导入 ${report.profiles} 个 Profile、${report.schedules} 个日程、${report.ledgers} 个账本、${report.expenses} 条支出、${report.holidayDays} 天节假日数据`,
    );
    if (report.scheduleWarnings.length > 0) {
      console.log("注意事项：");
      for (const w of report.scheduleWarnings) console.log(`  - ${w}`);
    }
    if (report.occurrencesDropped > 0) {
      console.log(
        `  - ${report.occurrencesDropped} 条历史 occurrence 未迁移，v2 将按日程规则重新物化`,
      );
    }
    if (report.problems.length > 0) {
      // 坏数据必须显式列出：静默跳过会悄悄丢钱/丢日程
      console.error(
        `\n有 ${report.problems.length} 条数据未能导入（已隔离，其余数据已正常导入）：`,
      );
      for (const p of report.problems) console.error(`  - [${p.table}] ${p.id}：${p.reason}`);
      process.exitCode = 2;
    }
  } catch (e) {
    // 不打印裸 SQLite 堆栈：给出可操作的一行信息
    console.error(`导入失败：${e instanceof Error ? e.message : String(e)}`);
    console.error("目标库未被修改（导入在单个事务内完成）；建议先 npm run db:backup 再重试。");
    process.exitCode = 1;
  } finally {
    if (target?.isOpen) target.close();
  }
}

const isDirectRun = /import-v1\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) {
  main();
}
