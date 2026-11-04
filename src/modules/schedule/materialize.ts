import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import { now, nowIso, todayIso, localToInstant, instantToLocalDate, TZ } from "../../time.js";
import { dayType, holidayYearsNeedingData, type DayType } from "../../core/holiday.js";
import { nextDate, recurrenceExhausted, type Recurrence } from "../../core/recurrence.js";
import { errorMessage } from "../../core/registry.js";
import { logger } from "../../core/logger.js";
import {
  type ScheduleInput,
  type ScheduleRow,
  type WorkdayFilter,
  parseOffsets,
  parseRecurrence,
  sourceOf,
} from "./validate.js";

/** 某次发生的事件时刻（UTC ISO）；不存在返回 null */
export function occurrenceEventAt(
  db: DatabaseSync,
  scheduleId: string,
  occurrenceKey: string,
): string | null {
  const row = db
    .prepare("SELECT event_at FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
    .get(scheduleId, occurrenceKey) as { event_at: string } | undefined;
  return row?.event_at ?? null;
}
const NEAR_HORIZON_DAYS = 62;
const FAR_HORIZON_DAYS = 400;
/** 工作日过滤暂停时的告警去重：scheduleId → 已告警的日期，避免每分钟刷屏 */
export const pausedWarned = new Map<string, string>();

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

/**
 * workday/holiday 过滤是否命中该 dayType。**单一判定**：物化与跨年复核共用，
 * 避免两处各写一份 isWork/isOff 后漂移（只改一处就会出现「复核放过、物化拒绝」的矛盾）。
 */
function workdayFilterMatches(filter: WorkdayFilter, cls: DayType): boolean {
  const isWork = cls === "workday" || cls === "weekday";
  const isOff = cls === "holiday" || cls === "weekend";
  return filter === "workday" ? isWork : isOff;
}

/**
 * 已复核过的「下一年度」集合（进程内）。跨年复核每进程每个年度只跑一次：
 * 数据就绪后已物化行不会自动重判，但复核本身要遍历 pending 行，不能每分钟跑。
 */
const crossYearRechecked = new Set<number>();

/**
 * 清空跨年复核的触发闸。仅供测试：同一进程内多个用例各自独立验证复核行为，
 * 否则先跑过的用例会把「下一年度」占住，后面的用例看不到复核（与
 * takeYearsNeedingBackfill 同类的测试可见出口）。
 */
export function resetCrossYearRecheck(): void {
  crossYearRechecked.clear();
}

/**
 * P2-5 / C-06 ②：跨年区间（12-25~12-31）的权威分类来自下一年度文件。该文件到达**前**
 * 已按星期兜底物化的 pending 行不会自动重判（「仅工作日」漏提醒 / 「仅节假日」误提醒），
 * 这里在数据就绪后按新 dayType 复核一次：
 *
 * - 新分类不再匹配过滤条件 → 置 cancelled（不复活；已 notified 的行无法撤回，不动它）；
 * - 新分类匹配但该日期缺失（旧兜底把它跳过、游标已推过它）→ 回退重物化补回。
 *
 * 只动 `workday_filter != 'any'` 的 active 日程，只碰 pending 行；重物化走 INSERT OR IGNORE，
 * 不会产生重复提醒。锚点取**今天**：过去的日期不补（避免生成一条早已过期的提醒），
 * 未来的日期照常补。返回实际复核过的日程数。
 */
export function recheckCrossYearOccurrences(db: DatabaseSync, updatedYears: number[]): number {
  const windows = updatedYears
    .filter((year) => Number.isInteger(year))
    .map((year) => ({ from: `${year - 1}-12-25`, to: `${year - 1}-12-31` }));
  if (windows.length === 0) return 0;
  const rows = db
    .prepare("SELECT * FROM schedules WHERE status = 'active' AND workday_filter != 'any'")
    .all() as unknown as ScheduleRow[];
  const today = todayIso();
  let touched = 0;
  for (const row of rows) {
    try {
      const pending = db
        .prepare(
          "SELECT occurrence_key, event_at FROM occurrences WHERE schedule_id = ? AND status = 'pending'",
        )
        .all(row.id) as { occurrence_key: string; event_at: string }[];
      let cancelled = 0;
      let missing = false;
      for (const win of windows) {
        const from = DateTime.fromISO(win.from, { zone: TZ });
        const toExclusive = DateTime.fromISO(win.to, { zone: TZ }).plus({ days: 1 });
        for (const occ of pending) {
          if (!isNormalReminderKey(occ.occurrence_key)) continue; // 派生行的有效性由 fireDue 复核
          const at = DateTime.fromISO(occ.event_at, { zone: TZ });
          if (!at.isValid || at < from || at >= toExclusive) continue;
          const dateISO = instantToLocalDate(occ.event_at);
          const cls = dayType(db, dateISO);
          if (cls === "unknown") continue; // 仍不权威：留着，下次数据齐了再复核
          if (!workdayFilterMatches(row.workday_filter, cls)) {
            db.prepare(
              "UPDATE occurrences SET status = 'cancelled' WHERE schedule_id = ? AND occurrence_key = ? AND status = 'pending'",
            ).run(row.id, occ.occurrence_key);
            cancelled += 1;
          }
        }
        // 现在应当匹配、却没有任何 occurrence 的日期：旧兜底误判把它跳过了，
        // 而物化游标已经推过它（回退重物化是唯一的补回方式）。
        for (let d = from; d <= DateTime.fromISO(win.to, { zone: TZ }); d = d.plus({ days: 1 })) {
          const dateISO = d.toISODate();
          if (dateISO === null || dateISO < today) continue; // 过去不补（不生成过期提醒）
          const cls = dayType(db, dateISO);
          if (cls === "unknown" || !workdayFilterMatches(row.workday_filter, cls)) continue;
          const existingRow = db
            .prepare("SELECT 1 FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
            .get(row.id, `${dateISO}T${row.time}#0`);
          if (existingRow === undefined) missing = true;
        }
      }
      if (cancelled === 0 && !missing) continue;
      materializeSchedule(db, row, { rewind: true, rewindFrom: today });
      updateNextRunAt(db, row.id);
      touched += 1;
      logger.info(
        `跨年节假日数据就绪后复核日程「${row.title}」(${row.id})：作废 ${cancelled} 条误判提醒${missing ? "，并回退重物化补回被跳过的日期" : ""}`,
      );
    } catch (e) {
      // 逐行隔离：一条脏数据不能带走整批复核（与 tickSchedules 的物化循环同口径）
      logger.warn(`跨年节假日复核失败（跳过该日程）: ${row.id}: ${errorMessage(e)}`);
    }
  }
  return touched;
}

/**
 * 跨年复核的进程内触发闸：每个「下一年度」只跑一次，且必须等它 status='ready'
 * （数据没到就留到下次 tick，不空转）。返回本次复核的日程数。
 */
export function recheckCrossYearOnce(db: DatabaseSync): number {
  const nextYear = now().year + 1;
  if (crossYearRechecked.has(nextYear)) return 0;
  const meta = db.prepare("SELECT status FROM cn_holiday_years WHERE year = ?").get(nextYear) as
    | { status: string }
    | undefined;
  if (meta?.status !== "ready") return 0;
  crossYearRechecked.add(nextYear);
  return recheckCrossYearOccurrences(db, [nextYear]);
}

export function insertSchedule(
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

export function updateNextRunAt(db: DatabaseSync, scheduleId: string): void {
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
 * update 时回退重物化（rewind）的锚点：**最近一个「已发过提醒、又有未触发正常提醒」的事件**。
 *
 * 不能拿 `MAX(event_at)` 当锚点（P1-1 / T-1027-02b）：循环日程的物化会预填到
 * NEAR_HORIZON_DAYS=62 天，`MAX(event_at)` 永远是 62 天后那个全 pending 的事件 →
 * 判定为「不进行中」→ 不 rewind；可 update 随后又删掉了当天事件的 pending 兄弟行
 * （#1），游标落在当天已 notified 的 #0 上，前向物化严格取更晚日期 → 当天 #1 永久丢失。
 *
 * 现在改为按「最近一个 notified 事件」判定，并返回**该事件**作为回退锚点：
 * - 该事件没有 pending 正常行（全 notified/已完成）：事件已结束，不 rewind，
 *   避免按新排期重复补发或为 count 日程造出额外事件；
 * - 全 pending：没有 notified 行，返回 null；删除后游标自然回退，前向物化即可重建；
 * - 无事件：返回 null。
 *
 * 只统计「正常提醒行」（key 以 #数字 结尾）：DELETE 只删这些行，:resend / #esc:N
 * 会被保留，不该触发回退（否则派生行 pending 会让已通知事件被补行）。
 */
export function latestInterruptedEvent(db: DatabaseSync, scheduleId: string): string | null {
  const last = db
    .prepare(
      "SELECT MAX(event_at) AS m FROM occurrences WHERE schedule_id = ? AND status = 'notified'",
    )
    .get(scheduleId) as { m: string | null };
  if (last.m === null) return null;
  const rows = db
    .prepare(
      "SELECT occurrence_key FROM occurrences WHERE schedule_id = ? AND event_at = ? AND status = 'pending'",
    )
    .all(scheduleId, last.m) as { occurrence_key: string }[];
  return rows.some((r) => isNormalReminderKey(r.occurrence_key)) ? last.m : null;
}

export interface MaterializeOptions {
  /**
   * true：从回退锚点（缺省「最近一个事件」）本身开始产出（而不是严格晚于它）。
   * update 会删掉所有 pending 的正常提醒行并立即重物化；若不回退，被删掉的
   * 兄弟偏移（如 #0 已 notified、#1 仍 pending）不会重现，用户永久丢失该次提醒。
   * INSERT OR IGNORE 保证回退不会重复既有行；调用方必须先经 latestInterruptedEvent 判定。
   */
  rewind?: boolean;
  /**
   * 回退锚点（UTC ISO 瞬间）。缺省取当前 MAX(event_at)。
   * 有它才能处理「锚点事件之后还有 done/cancelled 事件」的情形：删除 pending 行后
   * MAX(event_at) 会落在那些更晚的终态行上，光靠 rewind 会跳过真正要补的事件。
   */
  rewindFrom?: string;
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
    finalizeExhaustedSchedule(db, row, existing);
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
    // 回退一天：nextDate 会把锚点事件本身再次产出（若它在当前规则下成立），
    // 既有行被 INSERT OR IGNORE 吸收，缺失的偏移行被补回。
    const anchor = opts.rewindFrom ?? last.m;
    const anchorAt = DateTime.fromISO(anchor, { zone: TZ });
    if (anchorAt.isValid) after = anchorAt.minus({ days: 1 });
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
        // 保守暂停语义保留，但必须留痕且不能每分钟刷屏；同时登记**权威所需**的年份待补齐
        // （跨年区间 12-25~12-31 需要下一年度文件，只登记日期所属年份会去补一个已 ready 的
        // 年份，次年数据永远抓不回来 → 该日程被永久暂停，与 P2-3 同类的静默失败）。
        const needed = holidayYearsNeedingData(db, dateISO);
        for (const y of needed) yearsNeedingBackfill.add(y);
        if (pausedWarned.get(row.id) !== dateISO) {
          pausedWarned.set(row.id, dateISO);
          logger.warn(
            `日程「${row.title}」的 ${row.workday_filter} 过滤因 ${needed.join("/")} 年节假日数据未就绪而暂停`,
          );
        }
        break;
      }
      pausedWarned.delete(row.id);
      if (!workdayFilterMatches(row.workday_filter, cls)) {
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
  finalizeExhaustedSchedule(db, row, existing);
}

/**
 * P2-6 / C-07 终态收口：循环规则已耗尽（count 用尽 / until 到期）且再无 pending 提醒时，
 * 把日程置 `done` —— 否则会留下「active 但永不提醒」的半终态（用户看不出为什么停了）。
 *
 * 两条硬约束（也是最容易踩的两点）：
 * 1. **有 pending 就绝不收尾**：count 用尽时最后一次发生的提醒可能还没到点，置 done 会让
 *    fireDue 的 `s.status = 'active'` 过滤把它永久吞掉（少提醒一次）；
 * 2. **空结果 ≠ 耗尽**：年度日程的「下一条」只是落在物化前瞻（NEAR/FAR_HORIZON）之外，
 *    nextDate 同样返回 null。必须由 recurrenceExhausted 显式问「到 until 为止还有没有候选」，
 *    不能拿物化空结果当依据，否则生日/纪念日会被误判为终态。
 *
 * 终态只有 `done` 一种，与 P2-1（complete all=true）/ P2-2（一次性待办 skip）同口径。
 * 一次性日程（recurrence 为 null）不在此处收尾：它们的收尾入口是 complete/skip。
 */
function finalizeExhaustedSchedule(db: DatabaseSync, row: ScheduleRow, existing: number): void {
  if (row.status !== "active") return;
  let rec: Recurrence | null;
  try {
    rec = parseRecurrence(row.recurrence_json);
  } catch {
    return; // 规则损坏：无法判定是否耗尽，保持原状（逐行隔离由调用方负责）
  }
  if (rec === null) return;
  const pending = db
    .prepare("SELECT COUNT(*) AS n FROM occurrences WHERE schedule_id = ? AND status = 'pending'")
    .get(row.id) as { n: number };
  if (pending.n > 0) return;
  const countReached = rec.count !== undefined && existing >= rec.count;
  const untilReached = recurrenceExhausted(sourceOf(row), now());
  if (!countReached && !untilReached) return;
  const result = db
    .prepare(
      "UPDATE schedules SET status = 'done', updated_at = ? WHERE id = ? AND status = 'active'",
    )
    .run(nowIso(), row.id);
  if (Number(result.changes) > 0) {
    logger.info(
      `日程「${row.title}」(${row.id}) 的循环规则已耗尽（${countReached ? "count 已达上限" : "until 已过"}）且无待发提醒，已置为 done`,
    );
  }
}

/**
 * 正常提醒行 key 形如 `<日期>T<时刻>#<偏移序号>`；`:resend` 与 `#esc:N` 是派生行。
 * 派生行的 due_at 由触发前校验按父事件重新计算（见 resendDueOrNull / escalationDueOrNull），
 * 手工改期会被下一次校验覆盖，因此 snooze/skip 的单次处置只面向正常提醒行。
 */
export function isNormalReminderKey(key: string): boolean {
  return /#\d+$/.test(key);
}
