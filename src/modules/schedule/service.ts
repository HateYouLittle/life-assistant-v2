import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import { now, nowIso, localToInstant, instantToLocalDate, TZ } from "../../time.js";
import { dayType, ensureYears } from "../../core/holiday.js";
import {
  collapseLunarInterval,
  describeRecurrence,
  nextDate,
  recurrenceDeclaresCount,
  type OccurrenceSource,
  type Recurrence,
} from "../../core/recurrence.js";
import { errorMessage, type NotifyBlock, type Services } from "../../core/registry.js";
import { withReadTransaction, withTransaction } from "../../core/database.js";
import { ensureProfile } from "../../core/settings.js";
import { logger } from "../../core/logger.js";

export type ScheduleKind = "todo" | "birthday" | "anniversary";
export type WorkdayFilter = "any" | "workday" | "holiday";

export interface ScheduleInput {
  title: string;
  note?: string | null;
  kind: ScheduleKind;
  calendar: "solar" | "lunar";
  startDate?: string | null;
  lunarMonth?: number | null;
  lunarDay?: number | null;
  leapPolicy?: "follow" | "regular";
  lunarClamp?: boolean;
  time: string;
  allDay: boolean;
  recurrence: Recurrence | null;
  remindOffsets: number[];
  resendMinutes: number;
  /** 逾期升级阶梯（分钟偏移，升序）；null/缺省 = 不启用（此时 resend_minutes 生效） */
  escalation?: number[] | null;
  workdayFilter: WorkdayFilter;
}

export interface ScheduleRow {
  id: string;
  profile_id: string;
  title: string;
  note: string | null;
  kind: ScheduleKind;
  calendar: "solar" | "lunar";
  start_date: string | null;
  lunar_month: number | null;
  lunar_day: number | null;
  leap_policy: "follow" | "regular" | null;
  lunar_clamp: number;
  time: string;
  all_day: number;
  recurrence_json: string | null;
  remind_offsets_json: string;
  resend_minutes: number;
  escalation_json: string | null;
  workday_filter: WorkdayFilter;
  status: "active" | "done" | "cancelled";
  next_run_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

export const KIND_LABEL: Record<ScheduleKind, string> = {
  todo: "待办",
  birthday: "生日",
  anniversary: "纪念日",
};

const CATCHUP_GRACE_MINUTES = 10;
const NEAR_HORIZON_DAYS = 62;
const FAR_HORIZON_DAYS = 400;
/** 强提醒（到点重发一次）行的 occurrence_key 后缀 */
const RESEND_SUFFIX = ":resend";
/** 逾期升级行的 occurrence_key 后缀：`<eventKey>#esc:<N>`（N 从 1 起，第 0 步是截止时刻的 #0） */
const ESCALATION_SUFFIX = "#esc:";
export const MAX_ESCALATION_STEPS = 5;
export const MAX_ESCALATION_MINUTES = 43200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** add 幂等键（client_token）长度上限：与工具 schema 对齐，服务层再兜一道 */
const REQUEST_ID_MAX = 128;
/** snooze 上限：7 天。再长就不该用「推迟一次」，而应改整个日程 */
const SNOOZE_MAX_MINUTES = 10080;

/** 工作日过滤暂停时的告警去重：scheduleId → 已告警的日期，避免每分钟刷屏 */
const pausedWarned = new Map<string, string>();

/**
 * 物化撞到「节假日数据未就绪」的年份登记表：tickSchedules 收尾对这些年份调用
 * ensureYears 尝试补齐。重复抓取的间隔由 ensureYears 自身的 6h 冷却保证。
 */
const yearsNeedingBackfill = new Set<number>();

/** 取出并清空待补齐年份（tickSchedules 使用；测试据此断言登记结果） */
export function takeYearsNeedingBackfill(): number[] {
  const years = [...yearsNeedingBackfill].sort((a, b) => a - b);
  yearsNeedingBackfill.clear();
  return years;
}

export function newShortId(): string {
  return randomBytes(4).toString("hex");
}

export function parseRecurrence(json: string | null): Recurrence | null {
  if (json === null) return null;
  let rec: Recurrence;
  try {
    rec = JSON.parse(json) as Recurrence;
  } catch (e) {
    // 裸 JSON.parse 的报错看不出是哪条数据坏了；这里给出可定位的信息，
    // 由调用方逐行隔离（tickSchedules / rowToPublic），不让一条脏行带走整批。
    throw new Error(`循环规则不是合法 JSON（数据损坏，需修复该行）: ${json.slice(0, 80)}`, {
      cause: e,
    });
  }
  // 缺省 interval 必须兜底为 1，否则 recurrence 引擎会在推进日期时死循环
  const interval = typeof rec.interval === "number" && rec.interval >= 1 ? rec.interval : 1;
  return { ...rec, interval };
}

/**
 * 提醒偏移的安全解析：非法/空/非数组一律退化为 `[0]`（= 事件时刻提醒一次）。
 * 与 recurrence_json 不同，偏移坏掉不该让日程从列表里消失，兜底比抛错更有用。
 */
export function parseOffsets(json: string | null): number[] {
  if (json === null || json === "") return [0];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [0];
  }
  if (!Array.isArray(parsed)) return [0];
  const offsets = parsed.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  return offsets.length > 0 ? offsets : [0];
}

/**
 * 校验逾期升级阶梯：1-5 个非负整数分钟、首元素固定为 0（截止时刻本身）、严格升序（不重复）、
 * 最大值 ≤ 43200（30 天）。工具层（buildPartial）与服务层（validateScheduleInput）都走这里，规则唯一。
 */
export function validateEscalation(value: number[]): void {
  if (value.length < 1 || value.length > MAX_ESCALATION_STEPS) {
    throw new Error(`escalation 需要 1-${MAX_ESCALATION_STEPS} 个分钟偏移（升序）`);
  }
  if (value[0] !== 0) {
    throw new Error(
      "escalation 首元素必须为 0（0 表示截止时刻本身；后续元素是逾期后的分钟偏移，如 [0,60,360,1440]）",
    );
  }
  for (const minutes of value) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_ESCALATION_MINUTES) {
      throw new Error(
        `escalation 偏移不合法: ${String(minutes)}（需为 0-${MAX_ESCALATION_MINUTES} 的整数分钟）`,
      );
    }
  }
  for (let i = 1; i < value.length; i++) {
    if ((value[i] as number) <= (value[i - 1] as number)) {
      throw new Error("escalation 必须严格升序且不允许重复值");
    }
  }
}

/** 读库里的阶梯；NULL/空/非法一律当作「未启用」，避免脏数据把调度带偏 */
export function parseEscalation(json: string | null): number[] | null {
  if (json === null || json === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0)) return null;
  const steps = parsed as number[];
  // 与写入路径（validateEscalation）同口径：必须首元素为 0 且严格升序。
  // 脏库里乱序/非零首元素的阶梯会让「第 N 步」的语义错位，直接当作未启用。
  if (steps[0] !== 0) return null;
  for (let i = 1; i < steps.length; i++) {
    if ((steps[i] as number) <= (steps[i - 1] as number)) return null;
  }
  return steps;
}

/** 从 occurrence_key 解析升级步骤号；非升级行返回 null */
function escalationStepOf(occurrenceKey: string): number | null {
  const idx = occurrenceKey.lastIndexOf(ESCALATION_SUFFIX);
  if (idx < 0) return null;
  const raw = occurrenceKey.slice(idx + ESCALATION_SUFFIX.length);
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * 反解任意提醒行 key 所属的「事件前缀」`<本地日期>T<时刻>`：
 * 依次剥掉派生后缀（`#esc:N` / `:resend`）与偏移序号（`#N`）。
 * 这样 `…T09:00#0`、`…T09:00#1`、`…T09:00#0#esc:1`、`…T09:00#1:resend`
 * 都归到同一个事件。形态不符（脏 key）返回 null，由调用方退化处理。
 */
export function eventPrefixOf(occurrenceKey: string): string | null {
  let key = occurrenceKey;
  if (escalationStepOf(key) !== null) {
    key = key.slice(0, key.lastIndexOf(ESCALATION_SUFFIX));
  } else if (key.endsWith(RESEND_SUFFIX)) {
    key = key.slice(0, -RESEND_SUFFIX.length);
  }
  const matched = /^(.*)#\d+$/.exec(key);
  return matched === null ? null : (matched[1] as string);
}

/**
 * 逾期时长文案：区分分 / 小时 / 天，且不输出「0 天 0 小时」这类空单位。
 * 例：3 分 / 1 小时 3 分 / 1 天 2 小时。
 */
export function formatElapsed(fromIso: string, at: DateTime): string {
  const total = Math.max(0, Math.round(at.diff(DateTime.fromISO(fromIso), "minutes").minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  return parts.length > 0 ? parts.join(" ") : "不到 1 分";
}

export function sourceOf(row: ScheduleRow): OccurrenceSource {
  return {
    calendar: row.calendar,
    startDate: row.start_date,
    lunarMonth: row.lunar_month,
    lunarDay: row.lunar_day,
    leapPolicy: row.leap_policy ?? "follow",
    lunarClamp: row.lunar_clamp === 1,
    recurrence: parseRecurrence(row.recurrence_json),
  };
}

/**
 * update 继承既有 recurrence_json 时的**校验用**归一。与 N5（interval）同构，
 * 这里再收窄 freq 与「农历 recurrence 为 null」两种存量畸形：
 *
 * - **freq ≠ yearly**：农历引擎对 once/daily/weekly/monthly/yearly 一视同仁按农历年触发
 *   （core/recurrence.ts 的 iterate 对 calendar==="lunar" 直接 yield* iterateLunar，freq
 *   被完全丢弃）。这类行多来自 import:v1 的旧数据。校验若按原值拒，用户会被**完全锁死**：
 *   连「只改标题」都不行，唯一出路是显式传 `recurrence: {freq:"yearly", interval:1}` ——
 *   而对原本 v1 `once` 的一行，那等于把一次性事件改成每年重复。存量行只能改标题/删除才合理。
 * - **recurrence 为 null**：v1 的 `once` / `{}` / 缺字段经 import:v1 落库后是零 occurrence
 *   的死行（iterateLunar 首行 `if recurrence===null return`），同样不该把用户锁死。
 *
 * - **interval ≠ 1**（N5）：农历引擎只做 lunarYear++，与 interval=1 完全等价。
 *
 * 三条归一都**只喂 validateScheduleInput，绝不落库**：patch 显式传了 recurrence 的走正常
 * 校验（非法即报错）。落库始终用 parseRecurrence(row.recurrence_json) 的原值，否则「只改标题」
 * 会把用户的 interval/freq 静默改掉并提交，describeRecurrence 专门为存量脏数据写的
 * 「interval=N 不生效」提示也就此失去证据（提示只在纯读路径还成立）。
 * **显式传 recurrence 的 patch 不走这里**，仍按显式值严格校验（传 yearly 才放行）。
 */
function normalizeInheritedRecurrence(
  calendar: "solar" | "lunar",
  recurrence: Recurrence | null,
): Recurrence | null {
  const collapsed = collapseLunarInterval(calendar, recurrence);
  if (calendar !== "lunar") return collapsed;
  // 与引擎等价：农历下不管原 freq 是什么，实际都按农历年触发，所以校验看到 {yearly,1}
  const freqNormalized =
    collapsed === null || collapsed.freq === "yearly"
      ? collapsed
      : { ...collapsed, freq: "yearly" as const, interval: 1 };
  // recurrence=null 的农历行是死行（不是「一次性」）：给引擎等价的 yearly 让无关 patch 通过
  return freqNormalized ?? { freq: "yearly", interval: 1 };
}

export function validateScheduleInput(input: ScheduleInput): void {
  if (input.title.trim() === "") throw new Error("标题不能为空");
  if (input.title.length > 120) throw new Error("标题过长（≤120 字符）");
  if (input.calendar === "solar") {
    if (input.startDate === null || input.startDate === undefined)
      throw new Error("公历日程需要提供 date（YYYY-MM-DD）");
    if (
      !DATE_RE.test(input.startDate) ||
      !DateTime.fromISO(input.startDate, { zone: TZ }).isValid
    ) {
      throw new Error(`日期不合法: ${String(input.startDate)}`);
    }
  } else {
    const m = input.lunarMonth ?? 0;
    const d = input.lunarDay ?? 0;
    if (m < 1 || m > 12 || d < 1 || d > 30)
      throw new Error("农历日程需要 lunar_month(1-12) 与 lunar_day(1-30)");
    if (input.recurrence === null || input.recurrence.freq !== "yearly") {
      throw new Error("农历日程只支持按年循环（recurrence.freq = yearly）");
    }
    // interval 在农历路径上不参与推进（iterateLunar 只做 lunarYear++），引擎每年触发一次。
    // 曾照单全收 interval 又在回显里写「每年」，于是设 2/3 与设 1 完全等价且无任何提示 ——
    // 与「农历只支持按年循环」的既有口径一致，这里直接拒掉，不改引擎。
    if (input.recurrence.interval !== 1) {
      throw new Error(
        `农历日程只支持按年循环（recurrence.interval 必须为 1，收到 ${String(input.recurrence.interval)}；农历循环不按 interval 跳年）`,
      );
    }
    if (input.workdayFilter !== "any") throw new Error("workday/holiday 过滤仅支持公历日程");
  }
  if (!TIME_RE.test(input.time)) throw new Error(`时间不合法: ${input.time}`);
  if (input.remindOffsets.length > 5) throw new Error("remind_offsets 最多 5 个");
  if (input.recurrence?.freq === "weekly" && input.recurrence.byweekday !== undefined) {
    if (input.recurrence.byweekday.filter((d) => d >= 0 && d <= 6).length === 0) {
      throw new Error(
        "weekly 循环的 byweekday 不能为空（或全部超出 0-6）；省略该字段表示使用开始日期的星期",
      );
    }
  }
  if (
    input.recurrence?.until !== undefined &&
    input.calendar === "solar" &&
    input.startDate != null
  ) {
    if (input.recurrence.until < input.startDate) throw new Error("until 不能早于开始日期");
  }
  if (input.escalation !== null && input.escalation !== undefined) {
    if (input.kind !== "todo") throw new Error('escalation（截止型日程）只支持 kind="todo"');
    validateEscalation(input.escalation);
  }
}

/** 提醒偏移的项数上限（与 MCP schema 一致） */
export const MAX_REMIND_OFFSETS = 5;
/** 单个提醒偏移的绝对值上限（分钟，30 天；与 MCP schema 一致） */
export const MAX_REMIND_OFFSET_MINUTES = 43200;

/**
 * 提醒偏移的写入边界校验。
 *
 * MCP 入口由 zod schema 校验（1-5 项、整数、±43200），但 `/api/quick/schedules` 直接
 * 调用工具层、服务层也可能被直接调用，绕不过这一层：不在这里收口，quick 就能写入
 * `[999999]` 这类超出契约的值（提醒时刻算到 2 年后）或空数组（物化出零提醒的死日程）。
 *
 * 只校验**本次写入的值**：update 未显式传 `remindOffsets` 时沿用库里的历史值，
 * 老数据（如导入的长数组/越界值）不能被「只改标题」这类无关 patch 卡死 —— 与
 * `normalizeInheritedRecurrence` 对存量脏数据的宽容口径一致。
 */
export function validateRemindOffsets(offsets: number[]): void {
  // 直接调用服务层的入口可能传 null / 非数组（MCP 有 zod；update 的 null 已在调用方
  // 按「未提供」处理）。先给中文报错，不要让 `.length` 抛内部 TypeError。
  if (!Array.isArray(offsets)) {
    throw new Error("remind_offsets 需要是分钟偏移数组（例如 [0] 或 [-30, 0]）");
  }
  if (offsets.length < 1 || offsets.length > MAX_REMIND_OFFSETS) {
    throw new Error(`remind_offsets 需要 1-${MAX_REMIND_OFFSETS} 项`);
  }
  for (const minutes of offsets) {
    if (
      !Number.isInteger(minutes) ||
      minutes < -MAX_REMIND_OFFSET_MINUTES ||
      minutes > MAX_REMIND_OFFSET_MINUTES
    ) {
      throw new Error(
        `remind_offsets 不合法: ${String(minutes)}（需为 -${MAX_REMIND_OFFSET_MINUTES} 到 ${MAX_REMIND_OFFSET_MINUTES} 的整数分钟）`,
      );
    }
  }
}

function insertSchedule(
  db: DatabaseSync,
  profileId: string,
  input: ScheduleInput,
  id: string,
  clientToken: string | null = null,
): void {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO schedules (id, profile_id, title, note, kind, calendar, start_date, lunar_month, lunar_day,
       leap_policy, lunar_clamp, time, all_day, recurrence_json, remind_offsets_json, resend_minutes,
       escalation_json, workday_filter, status, version, created_at, updated_at, client_token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
  ).run(
    id,
    profileId,
    input.title.trim(),
    input.note ?? null,
    input.kind,
    input.calendar,
    input.calendar === "solar" ? (input.startDate ?? null) : null,
    input.calendar === "lunar" ? (input.lunarMonth ?? null) : null,
    input.calendar === "lunar" ? (input.lunarDay ?? null) : null,
    input.calendar === "lunar" ? (input.leapPolicy ?? "follow") : null,
    input.calendar === "lunar" ? (input.lunarClamp === false ? 0 : 1) : 1,
    input.time,
    input.allDay ? 1 : 0,
    input.recurrence === null ? null : JSON.stringify(input.recurrence),
    JSON.stringify(input.remindOffsets),
    input.resendMinutes,
    input.escalation === null || input.escalation === undefined
      ? null
      : JSON.stringify(input.escalation),
    input.workdayFilter,
    ts,
    ts,
    clientToken,
  );
}

export function getSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
): ScheduleRow | undefined {
  return db.prepare("SELECT * FROM schedules WHERE id = ? AND profile_id = ?").get(id, profileId) as
    | ScheduleRow
    | undefined;
}

export function listSchedules(
  db: DatabaseSync,
  profileId: string,
  status: string,
  limit: number,
): ScheduleRow[] {
  return db
    .prepare(
      "SELECT * FROM schedules WHERE profile_id = ? AND status = ? ORDER BY COALESCE(next_run_at, created_at) LIMIT ?",
    )
    .all(profileId, status, limit) as unknown as ScheduleRow[];
}

/** 是否存在 pending 的 occurrence；不按时间过滤（过期的 pending 也算存在）。走 (schedule_id, status) 索引 */
function hasPendingOccurrence(db: DatabaseSync, scheduleId: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM occurrences WHERE schedule_id = ? AND status = 'pending' LIMIT 1")
    .get(scheduleId);
  return row !== undefined;
}

function updateNextRunAt(db: DatabaseSync, scheduleId: string): void {
  db.prepare(
    `UPDATE schedules SET next_run_at = (SELECT MIN(due_at) FROM occurrences WHERE schedule_id = ? AND status = 'pending')
     WHERE id = ?`,
  ).run(scheduleId, scheduleId);
}

/** 单轮物化的候选扫描上限（正常路径；插入 10 个事件后下一轮继续，避免长任务卡 tick） */
const MATERIALIZE_ITERATIONS = 10;
/**
 * 首条豁免（该日程当前没有任何 pending）时的扫描预算：可能是稀疏过滤日程
 * （如「每周二 + 仅节假日」），下一个匹配日隔着几十个候选。预算仍被 FAR_HORIZON 截断。
 */
const EXEMPT_SCAN_ITERATIONS = 500;

/**
 * update 时是否需要回退重物化（rewind）。只有「最近一个事件处于进行中」才需要：
 * - 全 pending：删除后游标自然回退，前向物化即可重建；
 * - 全 notified / 已被 occurrence_key 完成：事件已结束，rewind 会按新排期重复补发，
 *   甚至为 count 日程造出额外事件（本轮复核发现的回归）；
 * - 既有 notified 又有 pending：删除会丢掉 pending 兄弟行，而游标停在 notified 行上，
 *   只有 rewind 才能把该事件的提醒补回来（本轮修复的目标场景）。
 */
function latestEventNeedsRewind(db: DatabaseSync, scheduleId: string): boolean {
  const last = db
    .prepare(
      "SELECT MAX(event_at) AS m FROM occurrences WHERE schedule_id = ? AND status != 'cancelled'",
    )
    .get(scheduleId) as { m: string | null };
  if (last.m === null) return false;
  const rows = db
    .prepare(
      "SELECT occurrence_key, status FROM occurrences WHERE schedule_id = ? AND event_at = ?",
    )
    .all(scheduleId, last.m) as { occurrence_key: string; status: string }[];
  const hasNotified = rows.some((r) => r.status === "notified");
  // 只统计「正常提醒行」（key 以 #数字 结尾）：update 的 DELETE 只删这些行，
  // :resend / #esc:N 会被保留，不该触发回退重物化（否则全通知的事件会因派生行被补发）。
  const hasPendingNormal = rows.some(
    (r) => r.status === "pending" && /#\d+$/.test(r.occurrence_key),
  );
  return hasNotified && hasPendingNormal;
}

export interface MaterializeOptions {
  /**
   * true：从「最近一个事件」本身开始产出（而不是严格晚于它）。
   * update 会删掉所有 pending 的正常提醒行并立即重物化；若不回退，最近事件里已提醒的
   * 兄弟偏移（如 #0 已 notified、#1 仍 pending）不会重现，用户永久丢失该次提醒。
   * INSERT OR IGNORE 保证回退不会重复既有行；调用方必须先经 latestEventNeedsRewind 判定。
   */
  rewind?: boolean;
}

/** 物化接下来一段时间的 occurrence（含提醒偏移）；节假日数据缺失时暂停在该日期之前 */
export function materializeSchedule(
  db: DatabaseSync,
  row: ScheduleRow,
  opts: MaterializeOptions = {},
): void {
  if (row.status !== "active") return;
  const rec = parseRecurrence(row.recurrence_json);
  // 已有事件按**本地日历日**去重：同一事件改 time 后 event_at 变化，但仍是同一天、
  // 同一次发生，不能计成新事件（否则 count 会凭空多出一次）。
  const existingDates = new Set(
    (
      db.prepare("SELECT DISTINCT event_at FROM occurrences WHERE schedule_id = ?").all(row.id) as {
        event_at: string;
      }[]
    ).map((r) => instantToLocalDate(r.event_at)),
  );
  let existing = existingDates.size;
  // 回退重物化（rewind）针对的是最近一个事件：改 time 时新 event_at 与原值不同，
  // 但仍是同一个日历日，不会新增日历日数量；因此这里不能因「已有事件数达上限」提前返回。
  if (rec?.count !== undefined && existing >= rec.count && opts.rewind !== true) {
    updateNextRunAt(db, row.id);
    return;
  }
  const source = sourceOf(row);
  const offsets = parseOffsets(row.remind_offsets_json);
  const last = db
    .prepare(
      "SELECT MAX(event_at) AS m FROM occurrences WHERE schedule_id = ? AND status != 'cancelled'",
    )
    .get(row.id) as { m: string | null };
  let after =
    last.m !== null
      ? DateTime.fromISO(last.m, { zone: TZ })
      : now().minus({ days: 1 }).startOf("day");
  if (opts.rewind === true && last.m !== null) {
    // 回退一天：nextDate 会把「最近一个事件」本身再次产出（若它在当前规则下成立），
    // 既有行被 INSERT OR IGNORE 吸收，缺失的偏移行被补回。
    after = DateTime.fromISO(last.m, { zone: TZ }).minus({ days: 1 });
  }
  const horizon = now().plus({ days: FAR_HORIZON_DAYS });
  const nearHorizon = now().plus({ days: NEAR_HORIZON_DAYS });

  // 首条豁免：该日程当前一条 pending 都没有时，允许越过近端地平线物化恰好 1 条，
  // 保证「下一条」永远可见。资格取自入库状态（而非本轮是否插入过），
  // 一旦真正补上第一条即失效，不会每分钟重新生效导致远期 occurrence creep。
  let exemptFirst = !hasPendingOccurrence(db, row.id);
  const budget = exemptFirst ? EXEMPT_SCAN_ITERATIONS : MATERIALIZE_ITERATIONS;

  for (let i = 0; i < budget; i++) {
    const date = nextDate(source, after, horizon);
    if (date === null) break;
    const dateISO = date.toISODate() ?? "";
    const eventAt = localToInstant(dateISO, row.time);
    // count 已达上限时，rewind 只允许补齐既有日历日的事件（改 time 重建同一天）；
    // 换 freq/相位/起始日会产出新日期，绝不能借 rewind 绕过上限（复核发现的回归）。
    if (rec?.count !== undefined && existing >= rec.count && !existingDates.has(dateISO)) break;
    // 物化前瞻：候选日期一旦越过近端地平线就停止，游标不得再前进。
    // 该判定必须在 workday/holiday 过滤之前 —— 否则被过滤掉的候选（如周末）
    // 会绕过它不断推动游标，物化范围最终被 FAR_HORIZON 或被未覆盖年份截断。
    const beyondHorizon = date > nearHorizon;
    if (beyondHorizon && !exemptFirst) break;
    if (row.workday_filter !== "any") {
      const cls = dayType(db, dateISO);
      if (cls === "unknown") {
        // 保守暂停语义保留，但必须留痕且不能每分钟刷屏；同时登记该年份待补齐
        yearsNeedingBackfill.add(Number(dateISO.slice(0, 4)));
        if (pausedWarned.get(row.id) !== dateISO) {
          pausedWarned.set(row.id, dateISO);
          logger.warn(
            `日程「${row.title}」的 ${row.workday_filter} 过滤因 ${dateISO.slice(0, 4)} 年节假日数据未就绪而暂停`,
          );
        }
        break;
      }
      pausedWarned.delete(row.id);
      const isWork = cls === "workday" || cls === "weekday";
      const isOff = cls === "holiday" || cls === "weekend";
      if (row.workday_filter === "workday" && !isWork) {
        after = date;
        continue;
      }
      if (row.workday_filter === "holiday" && !isOff) {
        after = date;
        continue;
      }
    }
    const prefix = `${dateISO}T${row.time}`;
    const insert = db.prepare(
      `INSERT OR IGNORE INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
       VALUES (?, ?, ?, ?, 'pending')`,
    );
    // 逐偏移 INSERT OR IGNORE：只要有一条真的写入，就说明这个「事件」是新的。
    // 这样既能在提醒偏移变化时补回缺失的偏移行（不静默丢提醒），
    // 又不会把已存在事件重复计入 count。
    let insertedEvent = false;
    offsets.forEach((offsetMinutes, idx) => {
      const due = DateTime.fromISO(eventAt).plus({ minutes: offsetMinutes });
      const result = insert.run(
        row.id,
        `${prefix}#${idx}`,
        eventAt,
        due.toUTC().toISO() ?? eventAt,
      );
      if (Number(result.changes) > 0) insertedEvent = true;
    });
    if (insertedEvent) {
      // 既有日历日补偏移行不算新事件（否则 count 日程会被补齐动作提前耗尽上限）
      if (!existingDates.has(dateISO)) {
        existingDates.add(dateISO);
        existing += 1;
      }
      exemptFirst = false;
    }
    after = date;
    if (rec?.count !== undefined && existing >= rec.count) break;
  }
  updateNextRunAt(db, row.id);
}

export function createSchedule(
  db: DatabaseSync,
  profileId: string,
  input: ScheduleInput,
  clientToken: string | null = null,
): ScheduleRow {
  validateScheduleInput(input);
  // 服务层再收口一道 remind_offsets 边界（MCP 有 zod，quick 直接走工具层绕过了它）。
  validateRemindOffsets(input.remindOffsets);
  ensureProfile(db, profileId);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newShortId();
    try {
      // 插入与首次物化同事务：物化失败（规则不可满足等）时整体回滚，
      // 不留「报错但日程已入库」的半成品 —— 用户重试会造出第二条同名日程。
      withTransaction(db, () => {
        insertSchedule(db, profileId, input, id, clientToken);
        const created = getSchedule(db, profileId, id);
        if (created === undefined) throw new Error("日程创建后读取失败");
        materializeSchedule(db, created);
      });
      return getSchedule(db, profileId, id) as ScheduleRow;
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) {
        // request_id 撞上已有行是**幂等命中**而不是瞬时 id 冲突：立刻抛出，
        // 由 createScheduleIdempotent 查回原日程；继续重试只会换 id 再撞同一个键。
        if (clientToken !== null && e.message.includes("client_token")) throw e;
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new Error("日程创建失败");
}

export interface CreateScheduleOutcome {
  row: ScheduleRow;
  /** true = 同 request_id 的重复调用，返回的是首次创建的原日程（未重建 occurrence、未重复提醒） */
  existed: boolean;
}

/** 校验 add 幂等键：1-128 字符（工具 schema 之外的第二道，直接调服务层也拦得住） */
export function validateRequestId(value: string): string {
  if (value.length < 1 || value.length > REQUEST_ID_MAX) {
    throw new Error(`request_id 不合法：需 1-${REQUEST_ID_MAX} 个字符`);
  }
  return value;
}

/** 按 (profile_id, client_token) 查回首次创建的日程；跨 Profile 天然隔离 */
export function getScheduleByClientToken(
  db: DatabaseSync,
  profileId: string,
  clientToken: string,
): ScheduleRow | undefined {
  return db
    .prepare("SELECT * FROM schedules WHERE profile_id = ? AND client_token = ?")
    .get(profileId, clientToken) as ScheduleRow | undefined;
}

/**
 * 带幂等键的创建：MCP 超时/网络抖动后 agent 用同一 request_id 重试时，
 * 返回首次创建的**原日程**（并标记 existed），不重建 occurrence、不重复发提醒。
 * 先查后插；并发窗口里撞唯一索引（idx_schedules_client_token）再查回，两步都走索引。
 */
export function createScheduleIdempotent(
  db: DatabaseSync,
  profileId: string,
  input: ScheduleInput,
  requestId: string | null,
): CreateScheduleOutcome {
  if (requestId === null) return { row: createSchedule(db, profileId, input), existed: false };
  validateRequestId(requestId);
  const existing = getScheduleByClientToken(db, profileId, requestId);
  if (existing !== undefined) return { row: existing, existed: true };
  try {
    return { row: createSchedule(db, profileId, input, requestId), existed: false };
  } catch (e) {
    if (e instanceof Error && e.message.includes("client_token")) {
      const row = getScheduleByClientToken(db, profileId, requestId);
      if (row !== undefined) return { row, existed: true };
    }
    throw e;
  }
}

export interface SchedulePatch extends Partial<Omit<ScheduleInput, "calendar" | "remindOffsets">> {
  calendar?: "solar" | "lunar";
  /** null 与 undefined 同义：未提供，沿用库里的历史值 */
  remindOffsets?: number[] | null;
  status?: "active" | "done" | "cancelled";
}

export function updateSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
  patch: SchedulePatch,
): ScheduleRow {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  // 只有**本次显式传入**的 remind_offsets 才做完整边界校验（quick 绕过 MCP schema 的
  // 路径主要走 create；update 的显式值同样要收口）。未传时沿用库里的历史值，
  // 存量脏数据（越界/多余项）不能被无关 patch 卡死 —— validateScheduleInput 里的
  // 「最多 5 个」长度检查保持不变，这里只补范围/整数/非空。
  // `null` 与 `undefined` 一样按「未提供」处理（JSON 里很常见）：旧实现直接取
  // `.length` 抛内部 TypeError，且下方 `??` 本来就把 null 当未提供 —— 校验必须先对齐。
  if (patch.remindOffsets !== undefined && patch.remindOffsets !== null) {
    validateRemindOffsets(patch.remindOffsets);
  }
  // 归一只服务校验：写回时仍用 inheritedRecurrence 的原值（用户设的 interval 不能被
  // 一次无关的 patch 顺手改掉）。patch 显式传了 recurrence 的按显式值校验。
  const inheritedRecurrence = parseRecurrence(row.recurrence_json);
  const merged: ScheduleInput = {
    title: patch.title ?? row.title,
    note: patch.note !== undefined ? patch.note : row.note,
    kind: patch.kind ?? row.kind,
    calendar: patch.calendar ?? row.calendar,
    startDate: patch.startDate !== undefined ? patch.startDate : row.start_date,
    lunarMonth: patch.lunarMonth !== undefined ? patch.lunarMonth : row.lunar_month,
    lunarDay: patch.lunarDay !== undefined ? patch.lunarDay : row.lunar_day,
    leapPolicy: patch.leapPolicy !== undefined ? patch.leapPolicy : (row.leap_policy ?? "follow"),
    lunarClamp: patch.lunarClamp !== undefined ? patch.lunarClamp : row.lunar_clamp === 1,
    time: patch.time ?? row.time,
    allDay: patch.allDay !== undefined ? patch.allDay : row.all_day === 1,
    recurrence: patch.recurrence !== undefined ? patch.recurrence : inheritedRecurrence,
    remindOffsets: patch.remindOffsets ?? parseOffsets(row.remind_offsets_json),
    resendMinutes: patch.resendMinutes ?? row.resend_minutes,
    escalation:
      patch.escalation !== undefined ? patch.escalation : parseEscalation(row.escalation_json),
    workdayFilter: patch.workdayFilter ?? row.workday_filter,
  };
  if (patch.status !== undefined && !["active", "done", "cancelled"].includes(patch.status)) {
    throw new Error(`状态不合法: ${String(patch.status)}`);
  }
  const status = patch.status ?? row.status;
  if (status === "active" && row.status === "done" && row.kind === "todo") {
    throw new Error("已完成的待办不能重新激活");
  }
  // patch 未显式传 recurrence 时，校验用归一值（存量农历 interval>1 与引擎行为等价，
  // 不该把这类行卡到连改名都不行）。
  validateScheduleInput({
    ...merged,
    recurrence:
      patch.recurrence === undefined
        ? normalizeInheritedRecurrence(merged.calendar, merged.recurrence)
        : merged.recurrence,
  });
  // 落库前的农历 interval 收口（写入侧单一收口，见 core/recurrence.ts）：
  // **只有本次 patch 新造出「农历+interval>1」的行**（solar→lunar 转换且没显式传
  // recurrence）才把 interval 收敛为 1 —— 校验看到的是归一值、落库若写回原值就会
  // 绕过写入侧拒错，造出引擎根本不读的 interval。
  // 对**既有**脏数据（本来就是农历、interval>1）的无关 patch（改标题/备注）仍原样
  // 保真：那次写入没造脏数据，且 describeRecurrence 的「interval=N 不生效」提示正
  // 靠它继续成立（见 N5 用例）。故收口条件要求「本次确实把日历改成了农历」。
  const storedRecurrence =
    patch.recurrence === undefined && patch.calendar === "lunar" && row.calendar !== "lunar"
      ? collapseLunarInterval(merged.calendar, merged.recurrence)
      : merged.recurrence;
  const ts = nowIso();
  withTransaction(db, () => {
    // 必须在 DELETE 之前判定：删除 pending 行后「最近事件是否进行中」的信息就没了。
    // 只有进行中的最近事件才允许回退重物化（否则全通知/已完成的事件会被重复补发）。
    const rewind = latestEventNeedsRewind(db, id);
    db.prepare(
      `UPDATE schedules SET title = ?, note = ?, kind = ?, calendar = ?, start_date = ?, lunar_month = ?,
         lunar_day = ?, leap_policy = ?, lunar_clamp = ?, time = ?, all_day = ?, recurrence_json = ?,
         remind_offsets_json = ?, resend_minutes = ?, escalation_json = ?, workday_filter = ?, status = ?,
         version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(
      merged.title.trim(),
      merged.note ?? null,
      merged.kind,
      merged.calendar,
      merged.calendar === "solar" ? (merged.startDate ?? null) : null,
      merged.calendar === "lunar" ? (merged.lunarMonth ?? null) : null,
      merged.calendar === "lunar" ? (merged.lunarDay ?? null) : null,
      merged.calendar === "lunar" ? (merged.leapPolicy ?? "follow") : null,
      merged.calendar === "lunar" ? (merged.lunarClamp === false ? 0 : 1) : 1,
      merged.time,
      merged.allDay ? 1 : 0,
      storedRecurrence === null ? null : JSON.stringify(storedRecurrence),
      JSON.stringify(merged.remindOffsets),
      merged.resendMinutes,
      merged.escalation === null ? null : JSON.stringify(merged.escalation),
      merged.workdayFilter,
      status,
      ts,
      id,
    );
    // 保留 :resend 与 #esc:* 行：它们的有效性由 fireDue 的触发前校验按当前排期判定
    // （改了 time/escalation、父事件被删/重排时在触发前作废），不能在这里一律删掉。
    db.prepare(
      `DELETE FROM occurrences WHERE schedule_id = ? AND status = 'pending'
         AND occurrence_key NOT LIKE '%' || ? AND occurrence_key NOT LIKE '%' || ?`,
    ).run(id, RESEND_SUFFIX, `${ESCALATION_SUFFIX}%`);
    // 更新与重物化同事务：物化失败整体回滚，不留「报错但改动已生效」；
    // rewind 让最近一个事件缺失的偏移行（如已 notified 的 #0 之外那条）补回来。
    const updated = getSchedule(db, profileId, id) as ScheduleRow;
    materializeSchedule(db, updated, { rewind });
  });
  return getSchedule(db, profileId, id) as ScheduleRow;
}

export interface CompleteOptions {
  /**
   * 结束整个系列（含循环日程）。循环日程裸调 complete（既无 occurrence_key 又不传 all）
   * 一律拒绝：不带 key 的「完成」会终止整条循环，而用户点「完成」绝大多数只想完成这一次。
   */
  all?: boolean;
}

export function completeSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
  occurrenceKey: string | null,
  opts: CompleteOptions = {},
): ScheduleRow {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  if (row.status !== "active") throw new Error(`日程当前状态为 ${row.status}，无需完成`);
  // 循环判定只看「是否声明了 recurrence」：recurrence_json 损坏时也按循环处理
  // （保守：无法解析时宁可要求显式 all=true，也不能一次误点清空整个系列）。
  const recurring = row.recurrence_json !== null;
  if (occurrenceKey === null && recurring && opts.all !== true) {
    throw new Error(
      "循环日程需带 occurrence_key 完成单次；结束整个系列请显式传 all=true。" +
        "可用 occurrence 列表从 schedule list 的「待办发生」或 schedule upcoming 获取。",
    );
  }
  if (occurrenceKey !== null) {
    const result = db
      .prepare(
        `UPDATE occurrences SET status = 'done'
         WHERE schedule_id = ? AND occurrence_key = ? AND status IN ('pending','notified')`,
      )
      .run(id, occurrenceKey);
    if (result.changes !== 1) throw new Error(`occurrence 不存在或已结束: ${occurrenceKey}`);
    // 同一事件的所有提醒行一并终结：`<前缀>#0..#4` 每个偏移一行，另有派生行
    // `:resend` 与 `#esc:N`。只按给定 key 收敛派生行会漏掉兄弟偏移 ——
    // 用提前 30 分钟那条（#0）完成后，正点那条（#1）仍会再推一次；
    // 反过来用 #1 完成时，锚在 #0 上的升级阶梯会继续推「仍未完成」。
    const eventPrefix = eventPrefixOf(occurrenceKey);
    if (eventPrefix === null) {
      // 脏 key（不符合 `<前缀>#<序号>` 形态）：退化为只收敛以该 key 为前缀的派生行
      db.prepare(
        `UPDATE occurrences SET status = 'done'
         WHERE schedule_id = ? AND status IN ('pending','notified')
           AND (occurrence_key = ? || '${RESEND_SUFFIX}'
                OR substr(occurrence_key, 1, length(?) + ${ESCALATION_SUFFIX.length}) = ? || '${ESCALATION_SUFFIX}')`,
      ).run(id, occurrenceKey, occurrenceKey, occurrenceKey);
    } else {
      // 派生 key 都以事件前缀开头；用 substr 前缀比较而不是 LIKE，
      // 避免 key 中的 %/_ 被当成通配符误伤
      db.prepare(
        `UPDATE occurrences SET status = 'done'
         WHERE schedule_id = ? AND status IN ('pending','notified')
           AND substr(occurrence_key, 1, ?) = ?`,
      ).run(id, eventPrefix.length + 1, `${eventPrefix}#`);
    }
    // 一次性待办：它只有这一次发生，完成该次就等于完成整条日程（与裸调 complete 对齐）。
    // 此前这里只把 occurrence 置 done、日程仍停在 active：回执写着「已完成」，但该待办
    // 永远留在 list 里、再无提醒，用户没有任何收尾入口（裸调 complete 才会转 done）。
    // 循环日程不能这么做（只完成当前一次、系列继续），损坏的 recurrence_json 按循环处理。
    if (row.recurrence_json === null && row.kind === "todo") {
      db.prepare("UPDATE schedules SET status = 'done', updated_at = ? WHERE id = ?").run(
        nowIso(),
        id,
      );
    }
  } else {
    db.prepare(
      `UPDATE occurrences SET status = 'done'
       WHERE schedule_id = ? AND status IN ('pending','notified')`,
    ).run(id);
    if (row.kind === "todo") {
      db.prepare("UPDATE schedules SET status = 'done', updated_at = ? WHERE id = ?").run(
        nowIso(),
        id,
      );
    }
  }
  updateNextRunAt(db, id);
  return getSchedule(db, profileId, id) as ScheduleRow;
}

interface OccurrenceRow {
  occurrence_key: string;
  event_at: string;
  due_at: string;
  status: "pending" | "notified" | "done" | "cancelled";
}

/**
 * 正常提醒行 key 形如 `<日期>T<时刻>#<偏移序号>`；`:resend` 与 `#esc:N` 是派生行。
 * 派生行的 due_at 由触发前校验按父事件重新计算（见 resendDueOrNull / escalationDueOrNull），
 * 手工改期会被下一次校验覆盖，因此 snooze/skip 的单次处置只面向正常提醒行。
 */
function isNormalReminderKey(key: string): boolean {
  return /#\d+$/.test(key);
}

function getOccurrence(
  db: DatabaseSync,
  scheduleId: string,
  occurrenceKey: string,
): OccurrenceRow | undefined {
  return db
    .prepare(
      `SELECT occurrence_key, event_at, due_at, status FROM occurrences
       WHERE schedule_id = ? AND occurrence_key = ?`,
    )
    .get(scheduleId, occurrenceKey) as OccurrenceRow | undefined;
}

/**
 * 缺省目标：该日程「最早未完成」的普通提醒行（pending/notified）。
 * 不取派生行的原因同上；同一事件有多个偏移行时取 due_at 最早的那条，
 * 它才是这次发生对用户最先可见的提醒。
 */
function earliestUnfinishedOccurrence(
  db: DatabaseSync,
  scheduleId: string,
): OccurrenceRow | undefined {
  const rows = db
    .prepare(
      `SELECT occurrence_key, event_at, due_at, status FROM occurrences
       WHERE schedule_id = ? AND status IN ('pending','notified')
       ORDER BY due_at, event_at`,
    )
    .all(scheduleId) as unknown as OccurrenceRow[];
  return rows.find((row) => isNormalReminderKey(row.occurrence_key));
}

function resolveDisposalTarget(
  db: DatabaseSync,
  schedule: ScheduleRow,
  occurrenceKey: string | null,
): OccurrenceRow {
  if (occurrenceKey !== null) {
    const occ = getOccurrence(db, schedule.id, occurrenceKey);
    if (occ === undefined) throw new Error(`occurrence 不存在: ${occurrenceKey}`);
    return occ;
  }
  const occ = earliestUnfinishedOccurrence(db, schedule.id);
  if (occ === undefined) {
    throw new Error(`日程「${schedule.title}」没有未完成的提醒可处置（可能已完成或已取消）`);
  }
  return occ;
}

/** 该日程剩余未完成的发生次数（按事件前缀去重；同一事件的多个提醒行只算一次） */
function countUnfinishedEvents(db: DatabaseSync, scheduleId: string): number {
  const rows = db
    .prepare(
      "SELECT occurrence_key FROM occurrences WHERE schedule_id = ? AND status IN ('pending','notified')",
    )
    .all(scheduleId) as { occurrence_key: string }[];
  const events = new Set(
    rows.map((row) => eventPrefixOf(row.occurrence_key) ?? row.occurrence_key),
  );
  return events.size;
}

/** snooze/skip 的写路径与 updateSchedule 同口径：version 自增 + updated_at 前进 */
function touchSchedule(db: DatabaseSync, scheduleId: string): void {
  db.prepare("UPDATE schedules SET version = version + 1, updated_at = ? WHERE id = ?").run(
    nowIso(),
    scheduleId,
  );
}

/** 未完成的「待办发生」：按事件前缀去重，供 list 回执给 agent 拿 occurrence_key */
export interface PendingOccurrence {
  occurrence_key: string;
  event_at: string;
  due_at: string;
}

export function pendingOccurrences(
  db: DatabaseSync,
  scheduleId: string,
  limit: number,
): PendingOccurrence[] {
  const rows = db
    .prepare(
      `SELECT occurrence_key, event_at, due_at FROM occurrences
       WHERE schedule_id = ? AND status IN ('pending','notified')
       ORDER BY event_at, due_at, occurrence_key`,
    )
    .all(scheduleId) as unknown as OccurrenceRow[];
  const seen = new Set<string>();
  const items: PendingOccurrence[] = [];
  for (const row of rows) {
    const event = eventPrefixOf(row.occurrence_key) ?? row.occurrence_key;
    if (seen.has(event)) continue;
    seen.add(event);
    items.push({
      occurrence_key: row.occurrence_key,
      event_at: row.event_at,
      due_at: row.due_at,
    });
    if (items.length >= limit) break;
  }
  return items;
}

export interface SnoozeOptions {
  /** 指定单次发生；缺省取该日程最早未完成的普通提醒行 */
  occurrenceKey?: string | null;
  /** 从现在起（原提醒更晚时从原提醒时刻起）顺延的分钟数，1-10080 */
  minutes?: number | null;
  /** 绝对时刻 HH:mm：解析为下一个该本地时刻 */
  until?: string | null;
}

export interface SnoozeOutcome {
  row: ScheduleRow;
  occurrenceKey: string;
  /** 顺延后的提醒时刻（UTC ISO，与 occurrences.due_at 同值） */
  dueAt: string;
}

/**
 * 把一次发生的提醒顺延（snooze）：
 * - 只改该行的 due_at 并重置为 pending，事件本身（event_at）不动；
 * - fireDue 按新 due_at 触发，并把通知里的时间显示改为 due_at（见 reminderBlocks 的 displayAt）；
 * - 物化用 INSERT OR IGNORE，tick 不会覆盖这一行；
 * - 通知 dedupeKey 带 due_at 后缀（见 fireDue），否则同 key 的二次提醒会被 outbox 去重吞掉。
 */
export function snoozeSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
  opts: SnoozeOptions,
): SnoozeOutcome {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  if (row.status !== "active") throw new Error(`日程当前状态为 ${row.status}，无法推迟提醒`);
  const hasMinutes = opts.minutes !== null && opts.minutes !== undefined;
  const hasUntil = opts.until !== null && opts.until !== undefined;
  if (hasMinutes === hasUntil) throw new Error("snooze 需要且只能提供 minutes 或 until 之一");
  const target = resolveDisposalTarget(db, row, opts.occurrenceKey ?? null);
  if (target.status === "done" || target.status === "cancelled") {
    throw new Error(
      `occurrence ${target.occurrence_key} 已是${target.status === "done" ? "完成" : "取消"}状态，不能 snooze`,
    );
  }
  if (!isNormalReminderKey(target.occurrence_key)) {
    throw new Error(
      `snooze 只支持普通提醒行（occurrence_key 形如 <日期>T<时刻>#N）；${target.occurrence_key} 是派生提醒行，请对同一事件的原提醒行操作`,
    );
  }
  let newDue: DateTime;
  if (hasMinutes) {
    const minutes = opts.minutes as number;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SNOOZE_MAX_MINUTES) {
      throw new Error(`snooze 的 minutes 需为 1-${SNOOZE_MAX_MINUTES} 的整数（分钟）`);
    }
    const at = now();
    // 「顺延」的基准取 max(现在, 原提醒)：未到点的提醒按原时刻后移，
    // 已经到点/提醒过的则从此刻起算，避免推迟到一个仍然过期的时刻。
    const original = DateTime.fromISO(target.due_at, { zone: TZ });
    const base = original > at ? original : at;
    newDue = base.plus({ minutes });
  } else {
    const until = opts.until as string;
    if (!TIME_RE.test(until)) throw new Error(`snooze 的 until 不合法: ${until}（需为 HH:mm）`);
    const [hour, minute] = until.split(":").map(Number) as [number, number];
    const at = now();
    let next = at.set({ hour, minute, second: 0, millisecond: 0 });
    // 「下一个该时刻」：今天这个点已过（或正好是现在）就落到明天
    if (next <= at) next = next.plus({ days: 1 });
    newDue = next;
  }
  const dueAt = newDue.toUTC().toISO() as string;
  withTransaction(db, () => {
    db.prepare(
      "UPDATE occurrences SET due_at = ?, status = 'pending' WHERE schedule_id = ? AND occurrence_key = ?",
    ).run(dueAt, id, target.occurrence_key);
    touchSchedule(db, id);
    updateNextRunAt(db, id);
  });
  return {
    row: getSchedule(db, profileId, id) as ScheduleRow,
    occurrenceKey: target.occurrence_key,
    dueAt,
  };
}

export interface SkipOutcome {
  row: ScheduleRow;
  occurrenceKey: string;
  /** 跳过这次发生之后，该日程剩余未完成的发生次数（按事件去重） */
  remaining: number;
}

/**
 * 跳过单次发生：把该事件的提醒行（含同事件的兄弟偏移与派生行）置为 cancelled。
 * 只动 occurrence 行、不改 schedules.status —— 系列继续，下一次仍会照常物化/提醒。
 * cancelled 是终态：materialize 的 INSERT OR IGNORE 不会复活它，catchupSweep 只碰 pending。
 */
export function skipSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
  occurrenceKey: string | null,
): SkipOutcome {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  if (row.status !== "active") throw new Error(`日程当前状态为 ${row.status}，无法跳过提醒`);
  const target = resolveDisposalTarget(db, row, occurrenceKey);
  if (target.status === "done" || target.status === "cancelled") {
    throw new Error(
      `occurrence ${target.occurrence_key} 已是${target.status === "done" ? "完成" : "取消"}状态，无需跳过`,
    );
  }
  const eventPrefix = eventPrefixOf(target.occurrence_key);
  let remaining = 0;
  withTransaction(db, () => {
    if (eventPrefix === null) {
      // 脏 key（不符合事件前缀形态）：只能取消它自己
      db.prepare(
        "UPDATE occurrences SET status = 'cancelled' WHERE schedule_id = ? AND occurrence_key = ? AND status IN ('pending','notified')",
      ).run(id, target.occurrence_key);
    } else {
      // 同一事件的各偏移行与派生行一并取消，否则兄弟偏移仍会再推一次
      db.prepare(
        `UPDATE occurrences SET status = 'cancelled'
         WHERE schedule_id = ? AND status IN ('pending','notified')
           AND substr(occurrence_key, 1, ?) = ?`,
      ).run(id, eventPrefix.length + 1, `${eventPrefix}#`);
    }
    touchSchedule(db, id);
    updateNextRunAt(db, id);
    remaining = countUnfinishedEvents(db, id);
  });
  return {
    row: getSchedule(db, profileId, id) as ScheduleRow,
    occurrenceKey: target.occurrence_key,
    remaining,
  };
}

export function deleteSchedule(db: DatabaseSync, profileId: string, id: string): void {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  withTransaction(db, () => {
    // recurrence.count 的次数上限依赖历史 occurrence 行数：删掉它们会让
    // 「删除后重新激活」的循环复活（与 occurrence 清理/保留策略同一豁免口径）。
    // 取消状态已能阻止 fireDue/materialize 继续触发，保留行没有行为副作用。
    if (!recurrenceDeclaresCount(row.recurrence_json)) {
      db.prepare("DELETE FROM occurrences WHERE schedule_id = ?").run(id);
    }
    db.prepare("UPDATE schedules SET status = 'cancelled', updated_at = ? WHERE id = ?").run(
      nowIso(),
      id,
    );
  });
}

export interface UpcomingItem {
  schedule_id: string;
  title: string;
  kind: ScheduleKind;
  note: string | null;
  workday_filter: WorkdayFilter;
  resend_minutes: number;
  occurrence_key: string;
  event_at: string;
  due_at: string;
  escalation_json: string | null;
}

/**
 * 接下来要发生的提醒（最多 limit 条**事件**）。
 *
 * 同一事件可能同时有多条 pending 行：多个提醒偏移（`#0..#4`）与 `:resend` / `#esc:N`
 * 派生行。直接按行返回会让同一件事重复出现、并可能把 `snooze` 不支持的派生 key 交给
 * 调用方（schema 却告诉 agent 这些 key 可直接用于 complete/snooze/skip）。因此这里按
 * 事件前缀去重（与 `pendingOccurrences` / `agendaForDate` 同口径）：
 * - 同一事件只保留一条，且**代表行必须是普通提醒行**（`<日期>T<时刻>#N`）：普通行已
 *   notified、只剩 `:resend` / `#esc:N` pending 的事件不出现 —— 它的 key 对 snooze/skip
 *   不可用，返回出去只会让 agent 照着 schema 调用、然后稳定失败；
 * - 同一事件有多条 pending 普通行时取 due_at 最早的那条；
 * - 排序仍按 due_at 升序，最后再 slice(limit)。
 *
 * 只剩派生行的事件并非「不可处理」：`complete` 接受任意 key，`schedule list` 的
 * 「待办发生」也仍会给出该事件普通行的 key（pending/notified 均收录），可据此收尾。
 *
 * 派生行在 **SQL 层就排除**（不在内存里先取一大批再丢弃）：`LIMIT rowLimit` 是按行
 * 截断的，若前 5×limit 行全是「只剩 :resend/#esc」的事件，后面的正常提醒会被整批挤出
 * 结果集（limit=1/3 直接返回空）。排除后每个事件最多 5 条 pending 普通行，5×limit 行
 * 至少覆盖 limit 个事件。末端 `isNormalReminderKey` 过滤保留作防御。
 */
export function upcoming(db: DatabaseSync, profileId: string, limit: number): UpcomingItem[] {
  const rowLimit = Math.max(limit * 5, 50);
  const rows = db
    .prepare(
      `SELECT o.occurrence_key, o.event_at, o.due_at, s.id AS schedule_id, s.title, s.kind,
              s.note, s.workday_filter, s.resend_minutes, s.escalation_json
       FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
       WHERE s.profile_id = ? AND s.status = 'active' AND o.status = 'pending' AND o.due_at >= ?
         AND instr(o.occurrence_key, '#esc:') = 0
         AND substr(o.occurrence_key, -length(':resend')) != ':resend'
       ORDER BY o.due_at LIMIT ?`,
    )
    .all(profileId, nowIso(), rowLimit) as unknown as UpcomingItem[];
  const chosen = new Map<string, UpcomingItem>();
  for (const row of rows) {
    const prefix = eventPrefixOf(row.occurrence_key) ?? row.occurrence_key;
    const eventKey = `${row.schedule_id}|${prefix}`;
    const existing = chosen.get(eventKey);
    if (existing === undefined) {
      chosen.set(eventKey, row);
      continue;
    }
    // 同事件多条：优先普通提醒行（派生行只可能来自 :resend / #esc:N）
    if (!isNormalReminderKey(existing.occurrence_key) && isNormalReminderKey(row.occurrence_key)) {
      chosen.set(eventKey, row);
    }
  }
  return [...chosen.values()]
    .filter((row) => isNormalReminderKey(row.occurrence_key))
    .sort((a, b) => (a.due_at < b.due_at ? -1 : a.due_at > b.due_at ? 1 : 0))
    .slice(0, limit);
}

/**
 * 简报议程条目（天气模块的每日简报直接 import；字段名是跨模块契约，别改名）。
 */
export interface AgendaItem {
  title: string;
  /** 事件本地时刻 HH:mm（all_day 时调用方按 all_day 显示「全天」） */
  time: string;
  all_day: boolean;
  /** todo | birthday | anniversary */
  kind: string;
  schedule_id: string;
  /** 可直接用于 complete / snooze / skip 的 occurrence_key */
  occurrence_key: string;
  /** 事件本地日期 < 查询日 */
  overdue: boolean;
  /** 事件本地日期 YYYY-MM-DD */
  event_date: string;
}

/**
 * 某 Profile 在 `date` 当天的议程：事件本地日期 <= date 且 occurrence 未结束
 * （pending/notified）的条目 —— 即「当天待办 + 逾期未完成」。
 * 按 event_at 升序（逾期的天生排在前面，同日按时刻）。
 *
 * - 同一事件有多个提醒偏移行（#0..#4）与派生行（:resend / #esc:N），按事件前缀去重，
 *   只返回一条，`occurrence_key` 优先取普通提醒行（可直接 complete/snooze/skip）；
 * - 已完成/已取消的 occurrence 不出现；日程本身非 active（已结束/已删除）也不出现；
 * - `withReadTransaction` 保证与其它读多条的报表一致的快照；查询走
 *   schedules(profile_id,status) 与 occurrences(schedule_id,status) 索引。
 */
export function agendaForDate(db: DatabaseSync, profileId: string, date: string): AgendaItem[] {
  if (!DATE_RE.test(date) || !DateTime.fromISO(date, { zone: TZ }).isValid) {
    throw new Error(`日期不合法: ${date}`);
  }
  // 本地日期 <= date ⟺ event_at < (date+1) 的本地零点。用瞬间比较，
  // 不把 +08:00 偏移硬编码进 SQL（时区常量只在 src/time.ts 维护一份）。
  const end = DateTime.fromISO(date, { zone: TZ })
    .plus({ days: 1 })
    .startOf("day")
    .toUTC()
    .toISO() as string;
  return withReadTransaction(db, () => {
    const rows = db
      .prepare(
        `SELECT s.id AS schedule_id, s.title AS title, s.kind AS kind, s.all_day AS all_day,
                o.occurrence_key AS occurrence_key, o.event_at AS event_at
         FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
         WHERE s.profile_id = ? AND s.status = 'active'
           AND o.status IN ('pending','notified') AND o.event_at < ?
         ORDER BY o.event_at, o.occurrence_key`,
      )
      .all(profileId, end) as unknown as {
      schedule_id: string;
      title: string;
      kind: string;
      all_day: number;
      occurrence_key: string;
      event_at: string;
    }[];
    const items = new Map<string, AgendaItem>();
    for (const row of rows) {
      const local = DateTime.fromISO(row.event_at, { zone: TZ });
      const eventDate = local.toISODate() ?? "";
      // 同一日程内按事件前缀去重；不同日程即使时刻相同也各算一条，故 identity 带上 schedule_id
      const event = `${row.schedule_id}|${eventPrefixOf(row.occurrence_key) ?? row.occurrence_key}`;
      const existing = items.get(event);
      if (existing === undefined) {
        items.set(event, {
          title: row.title,
          time: local.toFormat("HH:mm"),
          all_day: row.all_day === 1,
          kind: row.kind,
          schedule_id: row.schedule_id,
          occurrence_key: row.occurrence_key,
          overdue: eventDate < date,
          event_date: eventDate,
        });
      } else if (
        // 同一事件的代表 key 优先用普通提醒行（能直接 complete/snooze/skip）：
        // 极端情况下该事件只剩派生行仍 pending，first-pass 可能先拿到 `:resend`
        !isNormalReminderKey(existing.occurrence_key) &&
        isNormalReminderKey(row.occurrence_key)
      ) {
        existing.occurrence_key = row.occurrence_key;
      }
    }
    return [...items.values()];
  });
}

/** 错过补发清理：每个日程只保留最近一次过期的 pending，其余取消 */
export function catchupSweep(db: DatabaseSync): void {
  const cutoff = now().minus({ minutes: CATCHUP_GRACE_MINUTES }).toUTC().toISO() ?? nowIso();
  const groups = db
    .prepare(
      `SELECT schedule_id, COUNT(*) AS n FROM occurrences
       WHERE status = 'pending' AND due_at < ? GROUP BY schedule_id HAVING n > 1`,
    )
    .all(cutoff) as { schedule_id: string }[];
  for (const g of groups) {
    const keep = db
      .prepare(
        "SELECT MAX(due_at) AS m FROM occurrences WHERE schedule_id = ? AND status = 'pending' AND due_at < ?",
      )
      .get(g.schedule_id, cutoff) as { m: string | null };
    db.prepare(
      `UPDATE occurrences SET status = 'cancelled'
       WHERE schedule_id = ? AND status = 'pending' AND due_at < ? AND due_at < ?`,
    ).run(g.schedule_id, cutoff, keep.m ?? cutoff);
  }
}

const OCCURRENCE_CLEANUP_STATUSES = ["notified", "done", "cancelled"] as const;
export const OCCURRENCE_CLEANUP_DAYS = 90;

interface CleanupCondition {
  sql: string;
  params: string[];
}

/**
 * 清理谓词的唯一来源：预演与 job 都经它构造 SQL，避免两处判定漂移。
 * protectedIds 为使用 recurrence.count 的日程，其 occurrence 整条豁免。
 */
function cleanupCondition(protectedIds: string[], cutoff: string, prefix = ""): CleanupCondition {
  const params: string[] = [...OCCURRENCE_CLEANUP_STATUSES];
  const placeholders = OCCURRENCE_CLEANUP_STATUSES.map(() => "?").join(", ");
  let sql = `${prefix}status IN (${placeholders}) AND ${prefix}event_at < ?`;
  params.push(cutoff);
  if (protectedIds.length > 0) {
    const ids = protectedIds.map(() => "?").join(", ");
    sql += ` AND ${prefix}schedule_id NOT IN (${ids})`;
    params.push(...protectedIds);
  }
  return { sql, params };
}

/**
 * 使用 recurrence.count 的日程：次数上限按**已物化的事件历史（本地日历日）**执行
 * （见 materializeSchedule 的 existingDates，cancelled 也计入），删除历史会让已达上限的
 * 循环重新产出事件，因此这类日程的 occurrence 一律豁免。
 * 规则损坏时无法确认它是否用了 count —— 保守豁免（宁可少删，不可让上限复活）；
 * 这也保证一条脏数据不会让清理 job 与 db:cleanup:preview 整段失败。
 */
function countProtectedScheduleIds(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT id, recurrence_json FROM schedules").all() as {
    id: string;
    recurrence_json: string | null;
  }[];
  return rows.filter((row) => recurrenceDeclaresCount(row.recurrence_json)).map((row) => row.id);
}

export interface OccurrenceCleanupPreview {
  /** event_at 阈值（ISO）：早于它的历史行才可能被清理 */
  cutoff: string;
  /** 按当前规则将删除的行数 */
  deletable: number;
  /** 可清理行的日程明细 */
  bySchedule: { schedule_id: string; title: string; rows: number }[];
  /** 因 recurrence.count 被整条豁免的日程数 */
  protectedByCount: number;
}

interface OccurrenceCleanupPlan {
  cutoff: string;
  protectedIds: string[];
  deletable: number;
  bySchedule: { schedule_id: string; title: string; rows: number }[];
}

/** 只读：算出 cutoff、豁免日程与可清理行明细；零写操作，preview 与 job 共用 */
function occurrenceCleanupPlan(db: DatabaseSync, days: number): OccurrenceCleanupPlan {
  const cutoff = now().minus({ days }).toUTC().toISO() ?? nowIso();
  const protectedIds = countProtectedScheduleIds(db);
  const direct = cleanupCondition(protectedIds, cutoff);
  const countRow = db
    .prepare(`SELECT COUNT(*) AS n FROM occurrences WHERE ${direct.sql}`)
    .get(...direct.params) as { n: number };
  const aliased = cleanupCondition(protectedIds, cutoff, "o.");
  const bySchedule = db
    .prepare(
      `SELECT o.schedule_id AS schedule_id, s.title AS title, COUNT(*) AS rows
       FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
       WHERE ${aliased.sql}
       GROUP BY o.schedule_id, s.title
       ORDER BY rows DESC, o.schedule_id`,
    )
    .all(...aliased.params) as unknown as {
    schedule_id: string;
    title: string;
    rows: number;
  }[];
  return { cutoff, protectedIds, deletable: countRow.n, bySchedule };
}

/** 上线前预演：按 90 天保留规则当前会删除多少行、涉及哪些日程（零副作用） */
export function previewOccurrenceCleanup(
  db: DatabaseSync,
  days = OCCURRENCE_CLEANUP_DAYS,
): OccurrenceCleanupPreview {
  const plan = occurrenceCleanupPlan(db, days);
  return {
    cutoff: plan.cutoff,
    deletable: plan.deletable,
    bySchedule: plan.bySchedule,
    protectedByCount: plan.protectedIds.length,
  };
}

/** 执行清理；判定与 previewOccurrenceCleanup 完全同源，返回实际删除行数 */
export function runOccurrenceCleanup(db: DatabaseSync, days = OCCURRENCE_CLEANUP_DAYS): number {
  const plan = occurrenceCleanupPlan(db, days);
  if (plan.deletable === 0) return 0;
  return withTransaction(db, () => {
    const condition = cleanupCondition(plan.protectedIds, plan.cutoff);
    const result = db
      .prepare(`DELETE FROM occurrences WHERE ${condition.sql}`)
      .run(...condition.params);
    return Number(result.changes);
  });
}

export function reminderBlocks(
  row: ScheduleRow,
  eventAt: string,
  note: string | null,
  /**
   * 手工改期（snooze）后的提醒时刻：提醒里的「时间」改用它，而不是物化时的旧快照。
   * 不传 = 常规提醒，沿用 event_at + 日程时刻（既有形状不变）。
   */
  displayAt?: string,
): NotifyBlock {
  let timeText: string;
  if (row.all_day === 1) {
    timeText = `${instantToLocalDate(displayAt ?? eventAt)} 全天`;
  } else if (displayAt === undefined) {
    timeText = `${instantToLocalDate(eventAt)} ${row.time}`;
  } else {
    const local = DateTime.fromISO(displayAt, { zone: TZ });
    timeText = `${instantToLocalDate(displayAt)} ${local.toFormat("HH:mm")}`;
  }
  const rows: string[][] = [
    ["时间", timeText],
    ["类型", KIND_LABEL[row.kind]],
    ["重复", repeatTextOf(row)],
  ];
  if (row.note !== null && row.note !== "") rows.push(["备注", row.note]);
  return { table: { columns: ["项目", "内容"], rows }, notes: note === null ? undefined : [note] };
}

/**
 * 提醒里的循环描述：规则损坏时退化为占位文本。
 * 若在这里抛出，fireDue 的整批处理会被带走（一条脏数据冻结所有日程的提醒），
 * 而提醒本身仍然有效（时间/类型/备注都在），损失一次提醒毫无必要。
 */
function repeatTextOf(row: ScheduleRow): string {
  try {
    return describeRecurrence(sourceOf(row), row.start_date);
  } catch {
    return "（循环规则损坏，需修复）";
  }
}

interface DueRow {
  schedule_id: string;
  occurrence_key: string;
  event_at: string;
  due_at: string;
}

/**
 * 正常提醒行的 key 形如 `<date>T<HH:MM>#<序号>`；校验其时刻是否与当前排期一致。
 * 派生行的父行不再限定 #0（见 fireDue 的派生逻辑），但仍要挡住在改 time 之后残留的旧行：
 * 旧 key 里的时刻与新排期对不上。
 */
function parentMatchesScheduleTime(key: string, time: string): boolean {
  const matched = /T(\d{2}:\d{2})#\d+$/.exec(key);
  return matched !== null && matched[1] === time;
}

/**
 * 该正常提醒行是否被手工顺延过（snooze）：其 due_at 不再等于 event_at + 偏移分钟。
 * 用「与期望值不一致」而不是新增数据库列来识别 —— 不改 schema，且 update 重排后
 * pending 行会被重建（due_at 回到期望值），不会把旧改期误判成 snooze。
 */
function isSnoozedRow(schedule: ScheduleRow, occ: DueRow): boolean {
  if (!isNormalReminderKey(occ.occurrence_key)) return false;
  const matched = /#(\d+)$/.exec(occ.occurrence_key);
  if (matched === null) return false;
  const offset = parseOffsets(schedule.remind_offsets_json)[Number(matched[1])];
  if (offset === undefined) return false;
  const expected = DateTime.fromISO(occ.event_at).plus({ minutes: offset }).toUTC().toISO();
  return expected !== occ.due_at;
}

/**
 * 强提醒行的触发前校验。update 会保留 pending 的 :resend 行（本意是别丢掉强提醒），
 * 但用户改了时间、把 resend_minutes 调小/归零、或该事件已被重排删除之后，旧行仍会按
 * 旧时间点打扰一次。这里按当前日程重新判定，并强制 due_at = event_at + resend_minutes。
 * 返回 null 表示该行应作废。
 */
function resendDueOrNull(
  db: DatabaseSync,
  schedule: ScheduleRow,
  occurrenceKey: string,
  eventAt: string,
): string | null {
  if (schedule.resend_minutes <= 0) return null;
  // 当前日程已设置 escalation：resend_minutes 被忽略，遗留的 :resend 行一并作废。
  // 否则同一事件会同时收到「强提醒」与「升级链」两条「仍未完成」提醒
  // （先建 resend、后补 escalation 即可触发，复核发现的回归）。
  // 作废是终局的：之后即使再清除 escalation，本次发生的强提醒也不会复活
  // （主键已被 cancelled 行占用）——换取同一事件绝不双通知，属已知取舍。
  if (parseEscalation(schedule.escalation_json) !== null) return null;
  const eventKey = occurrenceKey.slice(0, -RESEND_SUFFIX.length);
  // key 里带着当时的提醒时刻：改了 time 之后旧 key 与新排期对不上，必须作废，
  // 否则会用旧时间点推一条「强提醒」。
  if (!parentMatchesScheduleTime(eventKey, schedule.time)) return null;
  // 父行已完成（done）时强提醒一并失效：complete 会收敛派生行，这里是第二道防线，
  // 挡住绕过 completeSchedule 直接改库把父行置 done 的路径。pending/notified 均视为在途。
  const parent = db
    .prepare(
      "SELECT 1 FROM occurrences WHERE schedule_id = ? AND occurrence_key = ? AND status IN ('pending','notified')",
    )
    .get(schedule.id, eventKey);
  if (parent === undefined) return null;
  return DateTime.fromISO(eventAt).plus({ minutes: schedule.resend_minutes }).toUTC().toISO();
}

/**
 * 逾期升级行的触发前校验（与 resendDueOrNull 同构）。update 会保留 pending 的 #esc:* 行，
 * 但用户改了 time、缩短/清除了 escalation、或父事件被删/重排之后，旧行仍会按旧排期打扰一次。
 * 这里按当前日程重新判定：该步必须仍存在（1 ≤ N < escalation.length），父事件 key 必须与当前
 * time 对得上且未被取消，due_at 强制等于 event_at + escalation[N]。返回 null 表示该行应作废。
 */
function escalationDueOrNull(
  db: DatabaseSync,
  schedule: ScheduleRow,
  occurrenceKey: string,
  eventAt: string,
): string | null {
  const step = escalationStepOf(occurrenceKey);
  if (step === null) return null;
  const escalation = parseEscalation(schedule.escalation_json);
  if (escalation === null) return null;
  // 第 0 步是截止时刻的 #0，不走此路径；#esc:N 只在第 N 个偏移仍存在时有效
  if (step < 1 || step >= escalation.length) return null;
  const suffix = `${ESCALATION_SUFFIX}${step}`;
  const parentKey = occurrenceKey.slice(0, occurrenceKey.length - suffix.length);
  // key 里带着当时的提醒时刻：改了 time 之后旧 key 与新排期对不上，必须作废
  // （父行不限定 #0，见 fireDue 的派生逻辑）。
  if (!parentMatchesScheduleTime(parentKey, schedule.time)) return null;
  // 与 resendDueOrNull 同构：父行 done（已完成）时升级行一并失效，第二道防线
  const parent = db
    .prepare(
      "SELECT 1 FROM occurrences WHERE schedule_id = ? AND occurrence_key = ? AND status IN ('pending','notified')",
    )
    .get(schedule.id, parentKey);
  if (parent === undefined) return null;
  return DateTime.fromISO(eventAt)
    .plus({ minutes: escalation[step] as number })
    .toUTC()
    .toISO();
}

/** 派生一条升级行：`<parentKey>#esc:<step>`，due_at = event_at + escalation[step]；已存在则忽略 */
function insertEscalation(
  db: DatabaseSync,
  scheduleId: string,
  parentKey: string,
  eventAt: string,
  step: number,
  escalation: number[],
): void {
  const due = DateTime.fromISO(eventAt).plus({ minutes: escalation[step] as number });
  db.prepare(
    `INSERT OR IGNORE INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
     VALUES (?, ?, ?, ?, 'pending')`,
  ).run(
    scheduleId,
    `${parentKey}${ESCALATION_SUFFIX}${step}`,
    eventAt,
    due.toUTC().toISO() ?? eventAt,
  );
}

function cancelOccurrence(db: DatabaseSync, occ: DueRow): void {
  db.prepare(
    "UPDATE occurrences SET status = 'cancelled' WHERE schedule_id = ? AND occurrence_key = ?",
  ).run(occ.schedule_id, occ.occurrence_key);
}

/**
 * 该事件前缀下是否已存在某类派生行（`:resend` 或 `#esc:N`）。
 * 用 JS 前缀匹配而不是 LIKE：数据损坏时 key 里可能混入 %/_（LIKE 通配符）误伤。
 */
function hasDerivedRow(
  db: DatabaseSync,
  scheduleId: string,
  eventPrefix: string,
  suffix: string,
): boolean {
  const head = `${eventPrefix}#`;
  const rows = db
    .prepare("SELECT occurrence_key FROM occurrences WHERE schedule_id = ?")
    .all(scheduleId) as { occurrence_key: string }[];
  return rows.some((r) => r.occurrence_key.startsWith(head) && r.occurrence_key.includes(suffix));
}

/** 到点触发提醒；返回发布的条数 */
export async function fireDue(db: DatabaseSync, services: Services, at: DateTime): Promise<number> {
  const cutoff = at.toUTC().toISO() ?? nowIso();
  const due = db
    .prepare(
      `SELECT o.schedule_id, o.occurrence_key, o.event_at, o.due_at
       FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
       WHERE o.status = 'pending' AND o.due_at <= ? AND s.status = 'active'
       ORDER BY o.due_at LIMIT 50`,
    )
    .all(cutoff) as unknown as DueRow[];
  let published = 0;
  for (const occ of due) {
    try {
      const schedule = db.prepare("SELECT * FROM schedules WHERE id = ?").get(occ.schedule_id) as
        | ScheduleRow
        | undefined;
      if (schedule === undefined) continue;
      const isResend = occ.occurrence_key.endsWith(RESEND_SUFFIX);
      const isEscalation = !isResend && escalationStepOf(occ.occurrence_key) !== null;
      let dueAt = occ.due_at;
      if (isResend) {
        const expected = resendDueOrNull(db, schedule, occ.occurrence_key, occ.event_at);
        if (expected === null) {
          cancelOccurrence(db, occ);
          continue;
        }
        if (expected !== occ.due_at) {
          db.prepare(
            "UPDATE occurrences SET due_at = ? WHERE schedule_id = ? AND occurrence_key = ?",
          ).run(expected, occ.schedule_id, occ.occurrence_key);
          if (expected > cutoff) continue; // 校正后尚未到点，本轮不推
          dueAt = expected;
        }
      } else if (isEscalation) {
        const expected = escalationDueOrNull(db, schedule, occ.occurrence_key, occ.event_at);
        if (expected === null) {
          cancelOccurrence(db, occ);
          continue;
        }
        if (expected !== occ.due_at) {
          db.prepare(
            "UPDATE occurrences SET due_at = ? WHERE schedule_id = ? AND occurrence_key = ?",
          ).run(expected, occ.schedule_id, occ.occurrence_key);
          if (expected > cutoff) continue; // 校正后尚未到点，本轮不推
          dueAt = expected;
        }
      }
      const lateMinutes = at.diff(DateTime.fromISO(dueAt), "minutes").minutes;
      const note = isEscalation
        ? `（截止已过 ${formatElapsed(occ.event_at, at)}，仍未完成）`
        : isResend
          ? "（强提醒：以上事项仍未完成）"
          : lateMinutes > CATCHUP_GRACE_MINUTES
            ? `（补发：该提醒已错过约 ${Math.round(lateMinutes)} 分钟）`
            : null;
      // 手工顺延（snooze）过的正常提醒行：通知里的「时间」取新的 due_at（而不是物化时的
      // 旧 event_at 快照）；dedupeKey 也带上 due_at，否则同一 occurrence_key 的二次提醒
      // 会被 outbox 的 (profile_id, dedupe_key) 唯一约束当成重复静默吞掉。
      const snoozed = !isResend && !isEscalation && isSnoozedRow(schedule, occ);
      const dedupeKey = snoozed
        ? `sched:${schedule.id}:${occ.occurrence_key}@${occ.due_at}`
        : `sched:${schedule.id}:${occ.occurrence_key}`;
      await services.publishProfile(schedule.profile_id, {
        kind: "schedule.reminder",
        title: schedule.title,
        blocks: reminderBlocks(schedule, occ.event_at, note, snoozed ? occ.due_at : undefined),
        dedupeKey,
      });
      published += 1;
      db.prepare(
        "UPDATE occurrences SET status = 'notified' WHERE schedule_id = ? AND occurrence_key = ?",
      ).run(occ.schedule_id, occ.occurrence_key);
      const escalation = parseEscalation(schedule.escalation_json);
      if (isEscalation) {
        const step = escalationStepOf(occ.occurrence_key);
        if (escalation !== null && step !== null && step + 1 < escalation.length) {
          const suffix = `${ESCALATION_SUFFIX}${step}`;
          const parentKey = occ.occurrence_key.slice(0, occ.occurrence_key.length - suffix.length);
          insertEscalation(db, schedule.id, parentKey, occ.event_at, step + 1, escalation);
        }
      } else if (!isResend && schedule.kind === "todo") {
        // 派生「未完成加压」行：升级阶梯下一步 / 到点重发。
        // 锚点从固定的 #0 放宽为「该事件的任意正常提醒行」：晚录入或停机跨过事件时刻时，
        // catchupSweep 会取消 #0、只保留更晚的偏移行，死守 #0 会让阶梯/重发永不启动
        // （README 承诺「到达截止时刻后按阶梯依次重发……直到 complete 才停」）。
        // 同一事件只允许一条链条：hasDerivedRow 去重，避免 #1 再派生一份。
        const eventPrefix = eventPrefixOf(occ.occurrence_key);
        if (eventPrefix !== null) {
          if (escalation !== null) {
            // 设置了阶梯：派生出 #esc:1；resend_minutes 被忽略
            // （要么按阶梯加压，要么只重发一次，同一事件不该收到两条「仍未完成」）
            if (
              escalation.length > 1 &&
              !hasDerivedRow(db, schedule.id, eventPrefix, ESCALATION_SUFFIX)
            ) {
              insertEscalation(db, schedule.id, occ.occurrence_key, occ.event_at, 1, escalation);
            }
          } else if (
            schedule.resend_minutes > 0 &&
            !hasDerivedRow(db, schedule.id, eventPrefix, RESEND_SUFFIX)
          ) {
            // 「到点后 N 分钟重发」以事件时刻为基准：用 due_at 会被偏移的提前量带偏
            const resendDue = DateTime.fromISO(occ.event_at).plus({
              minutes: schedule.resend_minutes,
            });
            db.prepare(
              `INSERT OR IGNORE INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
               VALUES (?, ?, ?, ?, 'pending')`,
            ).run(
              schedule.id,
              `${occ.occurrence_key}${RESEND_SUFFIX}`,
              occ.event_at,
              resendDue.toUTC().toISO() ?? occ.due_at,
            );
          }
        }
      }
    } catch (e) {
      // 逐行隔离：一条脏数据/一次意外失败只影响该行（occurrence 保持 pending，下一轮重试），
      // 不能让整个 tick 停摆 —— 否则所有日程的提醒与物化都会一起冻结。
      logger.warn(
        `日程提醒处理失败（该行保留 pending，下轮重试）: ${occ.schedule_id}/${occ.occurrence_key}: ${errorMessage(e)}`,
      );
    }
  }
  return published;
}

export async function tickSchedules(
  at: DateTime,
  services: Services,
  db: DatabaseSync,
  fetchYear?: (url: string) => Promise<unknown>,
): Promise<void> {
  catchupSweep(db);
  await fireDue(db, services, at);
  const active = db
    .prepare("SELECT * FROM schedules WHERE status = 'active'")
    .all() as unknown as ScheduleRow[];
  // 删除/取消的日程不会再进入 materialize，其告警去重记录需在这里回收
  const activeIds = new Set(active.map((r) => r.id));
  for (const id of [...pausedWarned.keys()]) {
    if (!activeIds.has(id)) pausedWarned.delete(id);
  }
  for (const row of active) {
    // 逐行隔离：一条脏数据（如 recurrence_json 非法）不能带走整批物化。
    // 曾经这里直接抛出，结果是该行之后的**所有**日程都不再产生 occurrence，
    // 且每分钟重复抛错，直到有人手改数据库。
    try {
      materializeSchedule(db, row);
    } catch (e) {
      logger.warn(`日程「${row.title}」(${row.id}) 物化失败，已跳过: ${errorMessage(e)}`);
    }
  }
  // 物化撞到的未就绪年份：收尾时尝试补齐。ensureYears 自带 6h 冷却
  // （cn_holiday_years.status='failed' + last_attempt_at），失败不会每分钟重试。
  const years = takeYearsNeedingBackfill();
  if (years.length === 0) return;
  try {
    const result = await ensureYears(db, years, fetchYear);
    if (result.failed.length > 0) {
      logger.warn(`日程物化补齐节假日数据失败: ${result.failed.join("; ")}`);
    }
  } catch (e) {
    logger.warn(`日程物化补齐节假日数据异常: ${errorMessage(e)}`);
  }
}
