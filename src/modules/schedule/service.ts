import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import { now, nowIso, localToInstant, instantToLocalDate, TZ } from "../../time.js";
import { dayType, ensureYears } from "../../core/holiday.js";
import {
  describeRecurrence,
  nextDate,
  type OccurrenceSource,
  type Recurrence,
} from "../../core/recurrence.js";
import { errorMessage, type NotifyBlock, type Services } from "../../core/registry.js";
import { withTransaction } from "../../core/database.js";
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
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

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
  const rec = JSON.parse(json) as Recurrence;
  // 缺省 interval 必须兜底为 1，否则 recurrence 引擎会在推进日期时死循环
  const interval = typeof rec.interval === "number" && rec.interval >= 1 ? rec.interval : 1;
  return { ...rec, interval };
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
}

function insertSchedule(
  db: DatabaseSync,
  profileId: string,
  input: ScheduleInput,
  id: string,
): void {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO schedules (id, profile_id, title, note, kind, calendar, start_date, lunar_month, lunar_day,
       leap_policy, lunar_clamp, time, all_day, recurrence_json, remind_offsets_json, resend_minutes,
       workday_filter, status, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`,
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
    input.workdayFilter,
    ts,
    ts,
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

/** 已物化的「事件」数（同一事件的多个提醒偏移共用 event_at，只算一次） */
function countEvents(db: DatabaseSync, scheduleId: string): number {
  const row = db
    .prepare(
      "SELECT COUNT(DISTINCT event_at) AS n FROM occurrences WHERE schedule_id = ? AND status != 'cancelled'",
    )
    .get(scheduleId) as { n: number };
  return row.n;
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

/** 物化接下来一段时间的 occurrence（含提醒偏移）；节假日数据缺失时暂停在该日期之前 */
export function materializeSchedule(db: DatabaseSync, row: ScheduleRow): void {
  if (row.status !== "active") return;
  const rec = parseRecurrence(row.recurrence_json);
  let existing = countEvents(db, row.id);
  if (rec?.count !== undefined && existing >= rec.count) {
    updateNextRunAt(db, row.id);
    return;
  }
  const source = sourceOf(row);
  const offsets = JSON.parse(row.remind_offsets_json) as number[];
  const last = db
    .prepare(
      "SELECT MAX(event_at) AS m FROM occurrences WHERE schedule_id = ? AND status != 'cancelled'",
    )
    .get(row.id) as { m: string | null };
  let after =
    last.m !== null
      ? DateTime.fromISO(last.m, { zone: TZ })
      : now().minus({ days: 1 }).startOf("day");
  const horizon = now().plus({ days: FAR_HORIZON_DAYS });
  const nearHorizon = now().plus({ days: NEAR_HORIZON_DAYS });

  // 首条豁免：该日程当前一条 pending 都没有时，允许越过近端地平线物化恰好 1 条，
  // 保证「下一条」永远可见。资格取自入库状态（而非本轮是否插入过），
  // 一旦真正补上第一条即失效，不会每分钟重新生效导致远期 occurrence creep。
  let exemptFirst = !hasPendingOccurrence(db, row.id);

  for (let i = 0; i < 10; i++) {
    const date = nextDate(source, after, horizon);
    if (date === null) break;
    const dateISO = date.toISODate() ?? "";
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
    const eventAt = localToInstant(dateISO, row.time);
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
      existing += 1;
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
): ScheduleRow {
  validateScheduleInput(input);
  ensureProfile(db, profileId);
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const id = newShortId();
    try {
      withTransaction(db, () => insertSchedule(db, profileId, input, id));
      const created = getSchedule(db, profileId, id);
      if (created === undefined) throw new Error("日程创建后读取失败");
      materializeSchedule(db, created);
      return getSchedule(db, profileId, id) as ScheduleRow;
    } catch (e) {
      if (e instanceof Error && e.message.includes("UNIQUE")) {
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new Error("日程创建失败");
}

export interface SchedulePatch extends Partial<Omit<ScheduleInput, "calendar">> {
  calendar?: "solar" | "lunar";
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
    recurrence:
      patch.recurrence !== undefined ? patch.recurrence : parseRecurrence(row.recurrence_json),
    remindOffsets: patch.remindOffsets ?? (JSON.parse(row.remind_offsets_json) as number[]),
    resendMinutes: patch.resendMinutes ?? row.resend_minutes,
    workdayFilter: patch.workdayFilter ?? row.workday_filter,
  };
  if (patch.status !== undefined && !["active", "done", "cancelled"].includes(patch.status)) {
    throw new Error(`状态不合法: ${String(patch.status)}`);
  }
  const status = patch.status ?? row.status;
  if (status === "active" && row.status === "done" && row.kind === "todo") {
    throw new Error("已完成的待办不能重新激活");
  }
  validateScheduleInput(merged);
  const ts = nowIso();
  withTransaction(db, () => {
    db.prepare(
      `UPDATE schedules SET title = ?, note = ?, kind = ?, calendar = ?, start_date = ?, lunar_month = ?,
         lunar_day = ?, leap_policy = ?, lunar_clamp = ?, time = ?, all_day = ?, recurrence_json = ?,
         remind_offsets_json = ?, resend_minutes = ?, workday_filter = ?, status = ?, version = version + 1,
         updated_at = ?
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
      merged.recurrence === null ? null : JSON.stringify(merged.recurrence),
      JSON.stringify(merged.remindOffsets),
      merged.resendMinutes,
      merged.workdayFilter,
      status,
      ts,
      id,
    );
    db.prepare(
      `DELETE FROM occurrences WHERE schedule_id = ? AND status = 'pending' AND occurrence_key NOT LIKE '%' || ?`,
    ).run(id, RESEND_SUFFIX);
  });
  const updated = getSchedule(db, profileId, id) as ScheduleRow;
  materializeSchedule(db, updated);
  return getSchedule(db, profileId, id) as ScheduleRow;
}

export function completeSchedule(
  db: DatabaseSync,
  profileId: string,
  id: string,
  occurrenceKey: string | null,
): ScheduleRow {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  if (row.status !== "active") throw new Error(`日程当前状态为 ${row.status}，无需完成`);
  if (occurrenceKey !== null) {
    const result = db
      .prepare(
        `UPDATE occurrences SET status = 'done'
         WHERE schedule_id = ? AND occurrence_key = ? AND status IN ('pending','notified')`,
      )
      .run(id, occurrenceKey);
    if (result.changes !== 1) throw new Error(` occurrence 不存在或已结束: ${occurrenceKey}`);
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

export function deleteSchedule(db: DatabaseSync, profileId: string, id: string): void {
  const row = getSchedule(db, profileId, id);
  if (row === undefined) throw new Error(`日程不存在: ${id}`);
  withTransaction(db, () => {
    db.prepare("DELETE FROM occurrences WHERE schedule_id = ?").run(id);
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
  occurrence_key: string;
  event_at: string;
  due_at: string;
}

export function upcoming(db: DatabaseSync, profileId: string, limit: number): UpcomingItem[] {
  return db
    .prepare(
      `SELECT o.occurrence_key, o.event_at, o.due_at, s.id AS schedule_id, s.title, s.kind
       FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
       WHERE s.profile_id = ? AND s.status = 'active' AND o.status = 'pending' AND o.due_at >= ?
       ORDER BY o.due_at LIMIT ?`,
    )
    .all(profileId, nowIso(), limit) as unknown as UpcomingItem[];
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
 * 使用 recurrence.count 的日程：countEvents() 依赖历史行数执行「最多发生 N 次」，
 * 删除历史会让已达上限的循环重新产出事件，因此这类日程的 occurrence 一律豁免。
 */
function countProtectedScheduleIds(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT id, recurrence_json FROM schedules").all() as {
    id: string;
    recurrence_json: string | null;
  }[];
  return rows
    .filter((row) => parseRecurrence(row.recurrence_json)?.count !== undefined)
    .map((row) => row.id);
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
): NotifyBlock {
  const rows: string[][] = [
    [
      "时间",
      row.all_day === 1
        ? `${instantToLocalDate(eventAt)} 全天`
        : `${instantToLocalDate(eventAt)} ${row.time}`,
    ],
    ["类型", KIND_LABEL[row.kind]],
    ["重复", describeRecurrence(sourceOf(row), row.start_date)],
  ];
  if (row.note !== null && row.note !== "") rows.push(["备注", row.note]);
  return { table: { columns: ["项目", "内容"], rows }, notes: note === null ? undefined : [note] };
}

interface DueRow {
  schedule_id: string;
  occurrence_key: string;
  event_at: string;
  due_at: string;
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
  const eventKey = occurrenceKey.slice(0, -RESEND_SUFFIX.length);
  // key 里带着当时的提醒时刻（`<date>T<time>#0`）：改了 time 之后旧 key 不再出现在日程上，
  // 这条强提醒已无对应事件，必须作废，否则会用旧时间点推一条「强提醒」。
  if (!eventKey.endsWith(`${schedule.time}#0`)) return null;
  const parent = db
    .prepare(
      "SELECT 1 FROM occurrences WHERE schedule_id = ? AND occurrence_key = ? AND status != 'cancelled'",
    )
    .get(schedule.id, eventKey);
  if (parent === undefined) return null;
  return DateTime.fromISO(eventAt).plus({ minutes: schedule.resend_minutes }).toUTC().toISO();
}

function cancelOccurrence(db: DatabaseSync, occ: DueRow): void {
  db.prepare(
    "UPDATE occurrences SET status = 'cancelled' WHERE schedule_id = ? AND occurrence_key = ?",
  ).run(occ.schedule_id, occ.occurrence_key);
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
    const schedule = db.prepare("SELECT * FROM schedules WHERE id = ?").get(occ.schedule_id) as
      | ScheduleRow
      | undefined;
    if (schedule === undefined) continue;
    const isResend = occ.occurrence_key.endsWith(RESEND_SUFFIX);
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
    }
    const lateMinutes = at.diff(DateTime.fromISO(dueAt), "minutes").minutes;
    const note = isResend
      ? "（强提醒：以上事项仍未完成）"
      : lateMinutes > CATCHUP_GRACE_MINUTES
        ? `（补发：该提醒已错过约 ${Math.round(lateMinutes)} 分钟）`
        : null;
    await services.publishProfile(schedule.profile_id, {
      kind: "schedule.reminder",
      title: schedule.title,
      blocks: reminderBlocks(schedule, occ.event_at, note),
      dedupeKey: `sched:${schedule.id}:${occ.occurrence_key}`,
    });
    published += 1;
    db.prepare(
      "UPDATE occurrences SET status = 'notified' WHERE schedule_id = ? AND occurrence_key = ?",
    ).run(occ.schedule_id, occ.occurrence_key);
    if (
      !isResend &&
      schedule.kind === "todo" &&
      schedule.resend_minutes > 0 &&
      occ.occurrence_key.endsWith("#0")
    ) {
      // 「到点后 N 分钟重发」以事件时刻为基准：用 due_at 会被 offsets[0] 的提前量带偏
      const resendDue = DateTime.fromISO(occ.event_at).plus({ minutes: schedule.resend_minutes });
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
  for (const row of active) materializeSchedule(db, row);
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
