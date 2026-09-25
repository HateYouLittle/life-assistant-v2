import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import { monthRange } from "../modules/bookkeeping/service.js";
import { KIND_LABEL, parseEscalation, type ScheduleKind } from "../modules/schedule/service.js";
import { TZ, todayIso } from "../time.js";

/**
 * 看板明细查询：状态页只给「概览」，点开卡片要看的逐笔/逐条数据在这里。
 * 全部只读、参数化，返回可直接 JSON 序列化的结构（日期已在服务端转成本地时区文本，
 * 前端不做时区推算）。
 */

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function normalizeMonth(
  raw: string | undefined,
  fallback: string = todayIso().slice(0, 7),
): string {
  return raw !== undefined && MONTH_RE.test(raw) ? raw : fallback;
}

function previousMonthOf(ym: string): string {
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function clampLimit(raw: string | undefined, fallback: number, max = 200): number {
  // 空串与纯空白按「未提供」处理：Number("") === 0 会被夹成 1，
  // 于是 /api/expenses?limit= 静默只返回 1 条，而不是走 fallback。
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(Math.trunc(value), max));
}

export interface ExpenseEntry {
  id: string;
  ledger_id: string;
  ledger_name: string;
  amount_cents: number;
  category: string;
  note: string | null;
  spent_on: string;
  created_by_profile: string;
}

export interface ExpenseDetails {
  month: string;
  range: { from: string; to: string };
  total_cents: number;
  count: number;
  prev: { month: string; total_cents: number };
  categories: Array<{ category: string; cents: number; count: number; share: number }>;
  daily: Array<{ date: string; cents: number }>;
  ledgers: Array<{ ledger_id: string; ledger_name: string; cents: number; count: number }>;
  entries: ExpenseEntry[];
  entries_total: number;
}

export function expenseDetails(
  db: DatabaseSync,
  rawMonth: string | undefined,
  rawLimit: string | undefined,
): ExpenseDetails {
  const month = normalizeMonth(rawMonth);
  const { from, to } = monthRange(month);
  const limit = clampLimit(rawLimit, 50);

  const totals = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS count FROM expenses WHERE spent_on >= ? AND spent_on <= ?",
    )
    .get(from, to) as { cents: number; count: number };

  const categories = db
    .prepare(
      `SELECT category, SUM(amount_cents) AS cents, COUNT(*) AS count FROM expenses
       WHERE spent_on >= ? AND spent_on <= ? GROUP BY category ORDER BY cents DESC`,
    )
    .all(from, to) as { category: string; cents: number; count: number }[];

  const daily = db
    .prepare(
      `SELECT spent_on AS date, SUM(amount_cents) AS cents FROM expenses
       WHERE spent_on >= ? AND spent_on <= ? GROUP BY spent_on ORDER BY spent_on`,
    )
    .all(from, to) as { date: string; cents: number }[];

  const ledgers = db
    .prepare(
      `SELECT e.ledger_id AS ledger_id, l.name AS ledger_name, SUM(e.amount_cents) AS cents, COUNT(*) AS count
       FROM expenses e JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? GROUP BY e.ledger_id ORDER BY cents DESC`,
    )
    .all(from, to) as { ledger_id: string; ledger_name: string; cents: number; count: number }[];

  const entries = db
    .prepare(
      `SELECT e.id, e.ledger_id, COALESCE(l.name, e.ledger_id) AS ledger_name, e.amount_cents, e.category,
              e.note, e.spent_on, e.created_by_profile
       FROM expenses e LEFT JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? ORDER BY e.spent_on DESC, e.created_at DESC LIMIT ?`,
    )
    .all(from, to, limit) as unknown as ExpenseEntry[];

  const prevMonth = previousMonthOf(month);
  const prevRange = monthRange(prevMonth);
  const prev = db
    .prepare(
      "SELECT COALESCE(SUM(amount_cents), 0) AS cents FROM expenses WHERE spent_on >= ? AND spent_on <= ?",
    )
    .get(prevRange.from, prevRange.to) as { cents: number };

  return {
    month,
    range: { from, to },
    total_cents: totals.cents,
    count: totals.count,
    prev: { month: prevMonth, total_cents: prev.cents },
    categories: categories.map((c) => ({
      category: c.category,
      cents: c.cents,
      count: c.count,
      share: totals.cents > 0 ? c.cents / totals.cents : 0,
    })),
    daily,
    ledgers,
    entries,
    entries_total: totals.count,
  };
}

export interface ScheduleDetailItem {
  id: string;
  profile_id: string;
  title: string;
  kind: ScheduleKind;
  kind_label: string;
  calendar: string;
  time: string;
  all_day: boolean;
  note: string | null;
  workday_filter: string;
  created_at: string;
  next_event_at: string | null;
  next_due_at: string | null;
  /** 事件日的本地文本（卡片显示的就是它） */
  next_local: string | null;
  /** 提醒时刻的本地文本；与事件同日同刻时为 null */
  remind_local: string | null;
  /** 距事件日的天数：与 next_local 同源，避免「日期写 12-13、倒计时按 12-06 算」 */
  days_until: number | null;
  /** 是否为截止型日程（设置了逾期升级阶梯）；卡片据此显示「截止」 */
  is_deadline: boolean;
}

interface ScheduleJoinRow {
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

function localStamp(iso: string | null, allDay: boolean): string | null {
  if (iso === null) return null;
  const dt = DateTime.fromISO(iso, { zone: TZ });
  if (!dt.isValid) return null;
  return allDay ? dt.toFormat("yyyy-LL-dd") : dt.toFormat("yyyy-LL-dd HH:mm");
}

export function scheduleDetails(
  db: DatabaseSync,
  rawLimit: string | undefined,
): ScheduleDetailItem[] {
  const limit = clampLimit(rawLimit, 50, 500);
  const rows = db
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
       WHERE s.status = 'active'
       ORDER BY COALESCE(o.event_at, '9999') ASC, s.created_at ASC
       LIMIT ?`,
    )
    .all(limit) as unknown as ScheduleJoinRow[];

  const todayStart = DateTime.fromISO(todayIso(), { zone: TZ });
  return rows.map((r) => {
    const allDay = r.all_day === 1;
    const remindDiffers = r.next_due_at !== null && r.next_due_at !== r.next_event_at;
    const isDeadline = parseEscalation(r.escalation_json) !== null;
    const nextLocal = localStamp(r.next_event_at ?? r.next_due_at, allDay);
    return {
      id: r.id,
      profile_id: r.profile_id,
      title: r.title,
      kind: r.kind,
      kind_label: isDeadline ? "截止" : (KIND_LABEL[r.kind] ?? r.kind),
      calendar: r.calendar,
      time: r.time,
      all_day: allDay,
      note: r.note,
      workday_filter: r.workday_filter,
      created_at: r.created_at,
      next_event_at: r.next_event_at,
      next_due_at: r.next_due_at,
      next_local: nextLocal,
      remind_local: remindDiffers ? localStamp(r.next_due_at, false) : null,
      // 按本地日历日相减，与 next_local 同源：用瞬时差会在 23:00 看「明天 09:00」时
      // 得到 0 天（不足 24 小时），与卡片上显示的日期对不上。
      days_until:
        nextLocal === null
          ? null
          : Math.round(
              DateTime.fromISO(nextLocal.slice(0, 10), { zone: TZ }).diff(todayStart, "days").days,
            ),
      is_deadline: isDeadline,
    };
  });
}

export interface DeliveryDetailItem {
  id: string;
  notification_id: string;
  title: string;
  profile_id: string;
  route_name: string;
  status: string;
  attempts: number;
  confirmed_failures: number;
  transport_failures: number;
  created_at: string;
  created_local: string;
  sent_at: string | null;
  sent_local: string | null;
  next_attempt_at: string;
  last_error: string | null;
}

export interface DeliveryDetails {
  counts: { queued: number; failed: number; fallback: number; sent_24h: number };
  daily: Array<{ date: string; label: string; sent: number }>;
  items: DeliveryDetailItem[];
}

function localDay(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: TZ });
  return dt.isValid ? (dt.toISODate() as string) : iso.slice(0, 10);
}

function localShort(iso: string | null): string | null {
  if (iso === null) return null;
  const dt = DateTime.fromISO(iso, { zone: TZ });
  return dt.isValid ? dt.toFormat("MM-dd HH:mm") : null;
}

export function deliveryDetails(db: DatabaseSync, rawLimit: string | undefined): DeliveryDetails {
  const limit = clampLimit(rawLimit, 60, 500);
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0;

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const sentRows = db
    .prepare("SELECT sent_at FROM deliveries WHERE status = 'sent' AND sent_at >= ?")
    .all(since) as { sent_at: string }[];
  const buckets = new Map<string, number>();
  const today = DateTime.fromISO(todayIso(), { zone: TZ });
  for (let i = 6; i >= 0; i -= 1) {
    buckets.set(today.minus({ days: i }).toISODate() as string, 0);
  }
  for (const row of sentRows) {
    const day = localDay(row.sent_at);
    if (buckets.has(day)) buckets.set(day, (buckets.get(day) ?? 0) + 1);
  }

  const items = db
    .prepare(
      `SELECT d.id, d.notification_id, COALESCE(n.title, '（通知已删除）') AS title,
              COALESCE(n.profile_id, '-') AS profile_id, d.route_name, d.status, d.attempts,
              d.confirmed_failures, d.transport_failures, d.created_at, d.sent_at, d.next_attempt_at, d.last_error
       FROM deliveries d LEFT JOIN notifications n ON n.id = d.notification_id
       ORDER BY d.created_at DESC LIMIT ?`,
    )
    .all(limit) as unknown as DeliveryDetailItem[];

  return {
    counts: {
      queued: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'queued'"),
      failed: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'failed'"),
      fallback: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'fallback'"),
      sent_24h: count(
        "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent' AND sent_at >= ?",
        new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      ),
    },
    daily: [...buckets.entries()].map(([date, sent]) => ({
      date,
      label: DateTime.fromISO(date, { zone: TZ }).toFormat("LL-dd"),
      sent,
    })),
    items: items.map((item) => ({
      ...item,
      created_local: localShort(item.created_at) ?? item.created_at,
      sent_local: localShort(item.sent_at),
    })),
  };
}

export interface HolidayDetails {
  years: number[];
  year: number;
  days: Array<{ date: string; name: string; day_type: string; weekday: string }>;
  upcoming: Array<{ date: string; name: string; days_until: number; days: number }>;
}

const WEEKDAY_CN = ["一", "二", "三", "四", "五", "六", "日"];

function weekdayLabel(date: string): string {
  const dt = DateTime.fromISO(date, { zone: TZ });
  return dt.isValid ? `周${WEEKDAY_CN[dt.weekday - 1] ?? ""}` : "";
}

export function holidayDetails(db: DatabaseSync, rawYear: string | undefined): HolidayDetails {
  const years = (
    db.prepare("SELECT year FROM cn_holiday_years WHERE status = 'ready' ORDER BY year").all() as {
      year: number;
    }[]
  ).map((r) => r.year);
  const today = todayIso();
  const currentYear = Number(today.slice(0, 4));
  // 默认看「还有假期的年份」：当年的假期已经过完（年末那几天）就顺延到下一年 ——
  // 只判断「年份存在」会让年末的卡片显示「暂无数据」，而不是次年元旦。
  const currentYearHasUpcoming =
    (db
      .prepare(
        "SELECT 1 FROM cn_holiday_days WHERE day_type = 'holiday' AND date >= ? AND substr(date, 1, 4) = ? LIMIT 1",
      )
      .get(today, String(currentYear)) as unknown) !== undefined;
  const fallbackYear =
    years.includes(currentYear) && currentYearHasUpcoming
      ? currentYear
      : (years.find((y) => y > currentYear) ?? years[years.length - 1] ?? currentYear);
  const parsedYear = Number(rawYear);
  const year =
    Number.isInteger(parsedYear) && parsedYear >= 2000 && parsedYear <= 2100
      ? parsedYear
      : fallbackYear;

  const days = db
    .prepare("SELECT date, name, day_type FROM cn_holiday_days WHERE year = ? ORDER BY date")
    .all(year) as { date: string; name: string; day_type: string }[];

  // 连续的同名假期日合成一段，取首日作为「下一个假期」
  const upcoming: HolidayDetails["upcoming"] = [];
  const holidayDays = days.filter((d) => d.day_type === "holiday" && d.date >= today);
  let index = 0;
  while (index < holidayDays.length && upcoming.length < 6) {
    const first = holidayDays[index] as { date: string; name: string };
    let span = 1;
    while (index + span < holidayDays.length) {
      const prev = DateTime.fromISO((holidayDays[index + span - 1] as { date: string }).date, {
        zone: TZ,
      });
      const next = DateTime.fromISO((holidayDays[index + span] as { date: string }).date, {
        zone: TZ,
      });
      if (next.diff(prev, "days").days !== 1) break;
      span += 1;
    }
    const start = DateTime.fromISO(first.date, { zone: TZ });
    upcoming.push({
      date: first.date,
      name: first.name,
      days_until: Math.max(
        0,
        Math.round(DateTime.fromISO(today, { zone: TZ }).diff(start, "days").days * -1),
      ),
      days: span,
    });
    index += span;
  }

  return {
    years,
    year,
    days: days.map((d) => ({ ...d, weekday: weekdayLabel(d.date) })),
    upcoming,
  };
}
