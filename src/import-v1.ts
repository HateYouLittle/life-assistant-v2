import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { openDatabase, withTransaction } from "./core/database.js";
import { logger } from "./core/logger.js";
import { ensureProfile, setSetting } from "./core/settings.js";
import type { Recurrence } from "./core/recurrence.js";

/**
 * v1 → v2 一次性导入：旧库只读打开，映射 profiles/静默时段/日程/账本/支出/节假日。
 * 拒绝写入非空目标库（--force 跳过）。旧共享账本的角色/成员不迁移（v2 全局可编辑）。
 */

export interface ImportReport {
  profiles: number;
  schedules: number;
  scheduleWarnings: string[];
  ledgers: number;
  expenses: number;
  entriesSkipped: number;
  holidayDays: number;
  holidayYears: number;
  occurrencesDropped: number;
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
  if (key in WEEKDAY_MAP) return WEEKDAY_MAP[key] ?? null;
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
): { recurrence: Recurrence | null; workdayFilter: "any" | "workday" | "holiday" } {
  if (raw === null || raw.trim() === "" || raw === "{}") return { recurrence: null, workdayFilter: "any" };
  let parsed: {
    frequency?: string;
    interval?: number;
    byWeekday?: string[];
    until?: string;
    count?: number;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    warnings.push(`日程「${title}」recurrence_json 无法解析，按一次性导入`);
    return { recurrence: null, workdayFilter: "any" };
  }
  const interval = typeof parsed.interval === "number" && parsed.interval >= 1 ? Math.min(parsed.interval, 365) : 1;
  const base = { interval, until: parsed.until, count: parsed.count };
  const weeklyDays = (parsed.byWeekday ?? [])
    .map(mapWeekday)
    .filter((d): d is number => d !== null);
  switch (parsed.frequency) {
    case "once":
      return { recurrence: null, workdayFilter: "any" };
    case "daily":
      return { recurrence: { freq: "daily", ...base }, workdayFilter: "any" };
    case "weekly":
      return { recurrence: { freq: "weekly", ...base, byweekday: weeklyDays }, workdayFilter: "any" };
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
  warnings.push(`日程「${title}」的循环类型 ${String(parsed.frequency)}（${calendar}）不支持，按每年循环导入`);
  return { recurrence: { freq: "yearly", ...base }, workdayFilter: "any" };
}

function mapReminders(raw: string | null, title: string, warnings: string[]): number[] {
  if (raw === null || raw.trim() === "") return [0];
  try {
    const parsed = JSON.parse(raw) as Array<{ minutesBefore?: number; target?: string }>;
    const offsets = parsed
      .filter((r) => r.target === undefined || r.target === "occurrence")
      .map((r) => -(typeof r.minutesBefore === "number" ? r.minutesBefore : 0));
    const deadlines = parsed.filter((r) => r.target === "deadline").length;
    if (deadlines > 0) warnings.push(`日程「${title}」有 ${deadlines} 个 deadline 提醒，v2 不支持已丢弃`);
    if (offsets.length === 0) return [0];
    return offsets.slice(0, 5);
  } catch {
    warnings.push(`日程「${title}」reminders_json 无法解析，按到点提醒导入`);
    return [0];
  }
}

export function runImport(target: ReturnType<typeof openDatabase>, oldPath: string, force = false): ImportReport {
  const report: ImportReport = {
    profiles: 0,
    schedules: 0,
    scheduleWarnings: [],
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
      throw new Error(`目标库非空（${table} 有 ${row.n} 行）。如确认覆盖请加 --force（建议先 db:backup）`);
    }
  }
  const old = new DatabaseSync(oldPath, { readOnly: true });
  try {
    withTransaction(target, () => {
      for (const row of old.prepare("SELECT profile_id FROM profiles").all() as { profile_id: string }[]) {
        ensureProfile(target, row.profile_id);
        report.profiles += 1;
      }

      let settings: Array<{ profile_id: string; quiet_start: string | null; quiet_end: string | null }> = [];
      try {
        settings = old
          .prepare("SELECT profile_id, quiet_start, quiet_end FROM profile_settings")
          .all() as typeof settings;
      } catch {
        warnings(report, "旧库没有 profile_settings 表，跳过静默时段");
      }
      for (const s of settings) {
        if (s.quiet_start !== null && s.quiet_end !== null) {
          setSetting(target, s.profile_id, "quiet_hours", { start: s.quiet_start, end: s.quiet_end });
        }
      }

      let schedules: OldSchedule[] = [];
      try {
        schedules = old.prepare("SELECT * FROM schedules").all() as unknown as OldSchedule[];
      } catch {
        warnings(report, "旧库没有 schedules 表，跳过日程");
      }
      const insertSchedule = target.prepare(
        `INSERT INTO schedules (id, profile_id, title, note, kind, calendar, start_date, lunar_month, lunar_day,
           leap_policy, lunar_clamp, time, all_day, recurrence_json, remind_offsets_json, resend_minutes,
           workday_filter, status, version, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const s of schedules) {
        const kind = ["todo", "birthday", "anniversary"].includes(s.type) ? s.type : "todo";
        const calendar = s.calendar === "lunar" ? "lunar" : "solar";
        const mappedStatus = STATUS_MAP[s.status];
        if (mappedStatus === undefined) {
          report.scheduleWarnings.push(`日程「${s.title}」旧状态「${s.status}」无法识别，按 active 处理`);
        }
        const status = mappedStatus ?? "active";
        const { recurrence, workdayFilter } = mapRecurrence(s.recurrence_json, calendar, s.title, report.scheduleWarnings);
        const offsets = mapReminders(s.reminders_json, s.title, report.scheduleWarnings);
        const resend = s.reminder_interval_minutes !== null && s.reminder_interval_minutes > 0
          ? Math.min(s.reminder_interval_minutes, 1440)
          : 0;
        if (resend > 0) {
          report.scheduleWarnings.push(`日程「${s.title}」强提醒降级为到点 ${resend} 分钟后重发一次`);
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
      }

      let occurrenceCount = 0;
      try {
        const row = old.prepare("SELECT COUNT(*) AS n FROM schedule_occurrences").get() as { n: number };
        occurrenceCount = row.n;
      } catch {
        // 无该表
      }
      report.occurrencesDropped = occurrenceCount;

      let ledgers: Array<{ id: string; name: string; created_at: string }> = [];
      try {
        ledgers = old.prepare("SELECT id, name, created_at FROM ledgers").all() as typeof ledgers;
      } catch {
        warnings(report, "旧库没有 ledgers 表，跳过账本");
      }
      const insertLedger = target.prepare("INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, ?)");
      for (const l of ledgers) {
        insertLedger.run(l.id, l.name, l.created_at);
        report.ledgers += 1;
      }
      if (report.ledgers > 0) {
        report.scheduleWarnings.push(`${report.ledgers} 个账本已迁移为全局可编辑（旧角色/成员信息不迁移）`);
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
        insertExpense.run(
          e.id,
          e.ledger_id,
          e.amount_cents,
          e.category ?? "其他",
          e.note,
          e.occurred_at.slice(0, 10),
          e.profile_id,
          e.created_at,
        );
        report.expenses += 1;
      }
      if (report.entriesSkipped > 0) {
        report.scheduleWarnings.push(`${report.entriesSkipped} 条非支出账目（收入/转账）不迁移`);
      }

      let holidayDays: Array<{ date: string; year: number; day_type: string; name: string; source: string; updated_at: string }> = [];
      try {
        holidayDays = old.prepare("SELECT * FROM cn_holiday_days").all() as unknown as typeof holidayDays;
      } catch {
        warnings(report, "旧库没有 cn_holiday_days 表，跳过节假日");
      }
      const insertDay = target.prepare(
        "INSERT OR REPLACE INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const d of holidayDays) {
        insertDay.run(d.date, d.year, d.day_type, d.name, d.source, d.updated_at);
        report.holidayDays += 1;
      }
      let holidayYears: Array<{ year: number; status: string; source: string; fetched_at: string }> = [];
      try {
        holidayYears = old
          .prepare("SELECT year, status, source, fetched_at FROM cn_holiday_year_meta WHERE status = 'ready'")
          .all() as typeof holidayYears;
      } catch {
        // 无该表
      }
      const insertYear = target.prepare(
        `INSERT OR REPLACE INTO cn_holiday_years (year, status, source, fetched_at) VALUES (?, 'ready', ?, ?)`,
      );
      for (const y of holidayYears) {
        insertYear.run(y.year, y.source, y.fetched_at);
        report.holidayYears += 1;
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

function resolveOldDbPath(from: string): string {
  if (statSync(from).isFile()) return from;
  for (const name of ["life-assistant.db", "assistant.db", "hermes.db"]) {
    const candidate = join(from, name);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`目录 ${from} 下未找到旧数据库文件（life-assistant.db / assistant.db）`);
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
  const target = openDatabase(config.dbPath);
  const oldPath = resolveOldDbPath(args[fromIndex + 1] as string);
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
    console.log(`  - ${report.occurrencesDropped} 条历史 occurrence 未迁移，v2 将按日程规则重新物化`);
  }
}

const isDirectRun = /import-v1\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) {
  main();
}
