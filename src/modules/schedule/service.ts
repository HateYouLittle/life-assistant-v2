export * from "./validate.js";
export * from "./materialize.js";
export * from "./actions.js";
export * from "./fire.js";

import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import { now, nowIso, instantToLocalDate, TZ } from "../../time.js";
import { recurrenceDeclaresCount } from "../../core/recurrence.js";
import { withReadTransaction, withTransaction } from "../../core/database.js";
import { anniversaryMilestoneText, daysBetween } from "./anniversary.js";
import { DATE_RE, type ScheduleKind, type WorkdayFilter, eventPrefixOf } from "./validate.js";
import { isNormalReminderKey } from "./materialize.js";

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

/** 早报「近期纪念日」栏的回看天数：今天起 14 天内（含第 14 天） */
export const UPCOMING_SPECIAL_DAYS = 14;

/** 即将到来的生日/纪念日（天气模块的早报直接 import；字段名是跨模块契约） */
export interface UpcomingSpecialDay {
  schedule_id: string;
  title: string;
  kind: "birthday" | "anniversary";
  /** 本次发生的本地日期 YYYY-MM-DD */
  event_date: string;
  /** 距今天的天数（0 = 今天） */
  days_left: number;
  /** 「3 周年 · 第 1097 天」这类文案；只有公历纪念日有，否则 null */
  milestone: string | null;
}

/**
 * 某 Profile 从 `today` 起 `days` 天内（含两端）即将到来的生日/纪念日，按日期升序、同日按标题。
 *
 * 数据源是已物化的 occurrence（pending/notified，同一事件的多条提醒偏移按日期去重）：
 * 物化前瞻 62 天 > 14 天，窗口内的发生一定已入库；已完成/已取消的那次不再列出。
 */
export function upcomingSpecialDays(
  db: DatabaseSync,
  profileId: string,
  today: string,
  days: number = UPCOMING_SPECIAL_DAYS,
): UpcomingSpecialDay[] {
  if (!DATE_RE.test(today) || !DateTime.fromISO(today, { zone: TZ }).isValid) {
    throw new Error(`日期不合法: ${today}`);
  }
  const startDay = DateTime.fromISO(today, { zone: TZ }).startOf("day");
  const from = startDay.toUTC().toISO() as string;
  const to = startDay
    .plus({ days: days + 1 })
    .toUTC()
    .toISO() as string;
  return withReadTransaction(db, () => {
    const rows = db
      .prepare(
        `SELECT DISTINCT s.id AS schedule_id, s.title AS title, s.kind AS kind,
                s.calendar AS calendar, s.start_date AS start_date, o.event_at AS event_at
         FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
         WHERE s.profile_id = ? AND s.status = 'active' AND s.kind IN ('birthday','anniversary')
           AND o.status IN ('pending','notified') AND o.event_at >= ? AND o.event_at < ?`,
      )
      .all(profileId, from, to) as unknown as {
      schedule_id: string;
      title: string;
      kind: "birthday" | "anniversary";
      calendar: string;
      start_date: string | null;
      event_at: string;
    }[];
    const seen = new Map<string, UpcomingSpecialDay>();
    for (const row of rows) {
      const eventDate = instantToLocalDate(row.event_at);
      const key = `${row.schedule_id}|${eventDate}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        schedule_id: row.schedule_id,
        title: row.title,
        kind: row.kind,
        event_date: eventDate,
        days_left: daysBetween(today, eventDate) ?? 0,
        milestone: anniversaryMilestoneText(row, eventDate),
      });
    }
    return [...seen.values()].sort((a, b) =>
      a.event_date !== b.event_date
        ? a.event_date < b.event_date
          ? -1
          : 1
        : a.title < b.title
          ? -1
          : a.title > b.title
            ? 1
            : 0,
    );
  });
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

/** 看板日程列表的一行：日程本体 + 最近一条 pending 发生记录的事件/提醒时刻。 */
export interface ActiveScheduleRow {
  id: string;
  profile_id: string;
  title: string;
  kind: ScheduleKind;
  calendar: string;
  time: string;
  all_day: number;
  note: string | null;
  workday_filter: string;
  escalation_json: string | null;
  created_at: string;
  next_event_at: string | null;
  next_due_at: string | null;
}

/**
 * 活跃日程及其最近一次待发生的事件，按事件时间升序（无待发的排最后），同刻按创建时间。
 *
 * @param db 数据库连接
 * @param limit 最多返回条数
 * @param profileId 可选；给了只返回该 Profile 自己的日程（日程是 Profile 私有数据），缺省 = 跨 Profile
 */
export function activeSchedulesWithNextOccurrence(
  db: DatabaseSync,
  limit: number,
  profileId?: string,
): ActiveScheduleRow[] {
  const profileFilter = profileId === undefined ? "" : " AND s.profile_id = ?";
  return db
    .prepare(
      `SELECT s.id, s.profile_id, s.title, s.kind, s.calendar, s.time, s.all_day, s.note,
              s.workday_filter, s.escalation_json, s.created_at,
              o.event_at AS next_event_at, o.due_at AS next_due_at
       FROM schedules s
       LEFT JOIN occurrences o ON o.schedule_id = s.id AND o.status = 'pending'
         AND o.occurrence_key = (
           -- 取「最近的事件」而非「最近的提醒」：卡片显示的是事件日，倒计时与排序必须同源；
           -- 同一事件有多个提醒偏移时按 occurrence_key 收敛成一行，避免列表重复。
           SELECT o2.occurrence_key FROM occurrences o2
           WHERE o2.schedule_id = s.id AND o2.status = 'pending'
           ORDER BY o2.event_at ASC, o2.due_at ASC LIMIT 1
         )
       WHERE s.status = 'active'${profileFilter}
       ORDER BY COALESCE(o.event_at, '9999') ASC, s.created_at ASC
       LIMIT ?`,
    )
    .all(
      ...(profileId === undefined ? [limit] : [profileId, limit]),
    ) as unknown as ActiveScheduleRow[];
}

/** 活跃日程数：profileId 缺省 = 全部 Profile（家庭看板） */
export function countActiveSchedules(db: DatabaseSync, profileId?: string): number {
  const row =
    profileId === undefined
      ? (db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'").get() as
          | { n: number }
          | undefined)
      : (db
          .prepare("SELECT COUNT(*) AS n FROM schedules WHERE status = 'active' AND profile_id = ?")
          .get(profileId) as { n: number } | undefined);
  return row?.n ?? 0;
}
