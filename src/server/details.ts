import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { withReadTransaction } from "../core/database.js";
import { holidayPeriods } from "../core/holiday.js";
import { type JobRunRow, type JobRunStatus, lastJobRun, recentJobRuns } from "../core/jobs.js";
import { allJobs, type JobDef } from "../core/registry.js";
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

/**
 * 分页 offset：空串/非法/负数一律回退 0。
 *
 * 与 clampLimit 的区别是**不回退成某个默认值**：offset 缺省本来就是第一页（0），
 * 而不是像 limit 那样有个业务默认。上限 100000 只为兜住恶意深分页
 * （SQLite OFFSET 需要扫过前 N 行，超深分页会拖慢单写者的库）。
 */
export function clampOffset(raw: string | undefined, max = 100_000): number {
  if (raw === undefined || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(Math.trunc(value), max));
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
  /** 本页起点（= 夹紧后的 offset，便于客户端续页时对照） */
  offset: number;
  /** 还有没有下一页：offset + 本页条数 < 总数 */
  has_more: boolean;
  /** 下一页 offset；没有更多时为 null（前端据此把按钮切成「已全部加载」） */
  next_offset: number | null;
}

export interface ExpenseScope {
  /**
   * 给了 Profile 时：可见账本 = 家庭账本（owner_profile_id IS NULL）+ 该 Profile 的个人账本；
   * 缺省 = 只家庭账本（master 的「家庭看板」口径，保持历史行为）。
   *
   * 为什么账本过滤要下推到每一条 SQL：合计/分类/按天/按账本/逐笔/上月对照共用同一口径，
   * 只在 entries 上过滤会让卡片合计与明细对不上（且会把别人的个人账本金额算进总额）。
   */
  profileId?: string;
}

export function expenseDetails(
  db: DatabaseSync,
  rawMonth: string | undefined,
  rawLimit: string | undefined,
  rawOffset?: string,
  scope?: ExpenseScope,
): ExpenseDetails {
  const month = normalizeMonth(rawMonth);
  const { from, to } = monthRange(month);
  const limit = clampLimit(rawLimit, 50);
  const offset = clampOffset(rawOffset);
  // SQL 片段只由本文件拼出（不含用户输入），Profile id 始终走参数绑定
  const ledgerFilter =
    scope?.profileId === undefined
      ? { sql: "l.owner_profile_id IS NULL", params: [] as string[] }
      : {
          sql: "(l.owner_profile_id IS NULL OR l.owner_profile_id = ?)",
          params: [scope.profileId],
        };

  // 6 条独立 SELECT 需要一个一致快照：并发写入时否则「合计」与「分类/明细」会对不上
  // （与 bookkeeping 的 summarizeExpenses 同口径）。
  return withReadTransaction(db, () => {
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(e.amount_cents), 0) AS cents, COUNT(*) AS count
       FROM expenses e JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}`,
      )
      .get(from, to, ...ledgerFilter.params) as { cents: number; count: number };

    const categories = db
      .prepare(
        `SELECT e.category, SUM(e.amount_cents) AS cents, COUNT(*) AS count FROM expenses e
       JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}
       GROUP BY e.category ORDER BY cents DESC`,
      )
      .all(from, to, ...ledgerFilter.params) as {
      category: string;
      cents: number;
      count: number;
    }[];

    const daily = db
      .prepare(
        `SELECT e.spent_on AS date, SUM(e.amount_cents) AS cents FROM expenses e
       JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}
       GROUP BY e.spent_on ORDER BY e.spent_on`,
      )
      .all(from, to, ...ledgerFilter.params) as { date: string; cents: number }[];

    const ledgers = db
      .prepare(
        `SELECT e.ledger_id AS ledger_id, l.name AS ledger_name, SUM(e.amount_cents) AS cents, COUNT(*) AS count
       FROM expenses e JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}
       GROUP BY e.ledger_id ORDER BY cents DESC`,
      )
      .all(from, to, ...ledgerFilter.params) as {
      ledger_id: string;
      ledger_name: string;
      cents: number;
      count: number;
    }[];

    // 家庭看板只展示家庭账本；带 Profile 作用域时额外含**本人**个人账本（他人个人账本永不出现）。
    // 排序补上 e.id 兜底：spent_on + created_at 完全相同的两条在分页时有稳定顺序，
    // 否则 SQLite 的返回顺序不确定，翻页可能出现重复或漏行。
    const entries = db
      .prepare(
        `SELECT e.id, e.ledger_id, l.name AS ledger_name, e.amount_cents, e.category,
              e.note, e.spent_on, e.created_by_profile
       FROM expenses e JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}
       ORDER BY e.spent_on DESC, e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
      )
      .all(from, to, ...ledgerFilter.params, limit, offset) as unknown as ExpenseEntry[];

    const prevMonth = previousMonthOf(month);
    const prevRange = monthRange(prevMonth);
    const prev = db
      .prepare(
        `SELECT COALESCE(SUM(e.amount_cents), 0) AS cents FROM expenses e
       JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}`,
      )
      .get(prevRange.from, prevRange.to, ...ledgerFilter.params) as { cents: number };

    const entriesTotal = totals.count;
    const hasMore = offset + entries.length < entriesTotal;
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
      entries_total: entriesTotal,
      offset,
      has_more: hasMore,
      // 用「实际返回条数」推进而不是 offset + limit：越界/末页不满时也不会跳过数据
      next_offset: hasMore ? offset + entries.length : null,
    };
  });
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

/**
 * 跨 Profile 的活跃日程（master 看板）；给了 `profileId` 时只返回该 Profile 自己的日程
 * （Profile token 打开看板时的个人视图）。日程是 Profile 私有数据，不能靠前端过滤。
 */
export function scheduleDetails(
  db: DatabaseSync,
  rawLimit: string | undefined,
  profileId?: string,
): ScheduleDetailItem[] {
  const limit = clampLimit(rawLimit, 50, 500);
  const profileFilter = profileId === undefined ? "" : " AND s.profile_id = ?";
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
       WHERE s.status = 'active'${profileFilter}
       ORDER BY COALESCE(o.event_at, '9999') ASC, s.created_at ASC
       LIMIT ?`,
    )
    .all(
      ...(profileId === undefined ? [limit] : [profileId, limit]),
    ) as unknown as ScheduleJoinRow[];

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
  /** 投递记录总数（不受 limit/offset 影响），前端据此判断还有没有下一页 */
  items_total: number;
  offset: number;
  has_more: boolean;
  next_offset: number | null;
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

/**
 * 投递明细：master 看板给全部 Profile；给了 `profileId` 时只返回该 Profile 的通知投递。
 *
 * 通知标题/正文属于 Profile 私有数据，过滤必须落在 SQL（连接 notifications 过滤），
 * 不能靠前端隐藏 —— /api/* 的响应本身就是证据。
 */
export function deliveryDetails(
  db: DatabaseSync,
  rawLimit: string | undefined,
  rawOffset?: string,
  profileId?: string,
): DeliveryDetails {
  const limit = clampLimit(rawLimit, 60, 500);
  const offset = clampOffset(rawOffset);
  // Profile 视图要连 notifications 过滤；家庭看板保持「全部投递」的历史口径
  const profileFilter =
    profileId === undefined
      ? { sql: "", params: [] as string[] }
      : { sql: " AND n.profile_id = ?", params: [profileId] };
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { n: number } | undefined)?.n ?? 0;

  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const sentRows = db
    .prepare(
      `SELECT d.sent_at FROM deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE d.status = 'sent' AND d.sent_at >= ?${profileFilter.sql}`,
    )
    .all(since, ...profileFilter.params) as { sent_at: string }[];
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
      // 状态页是共享 token 的「家庭看板」，个人账本的月报标题不应出现在这里。
      // 通知本身没有可见性列，但月报的 dedupe_key 形如 report:<ledgerId>:<YYYY-MM>，
      // 可据此识别个人账本并只脱敏标题（其余投递仍照常展示）。
      `SELECT d.id, d.notification_id,
              CASE
                WHEN n.kind = 'bookkeeping.monthly' AND EXISTS (
                  SELECT 1 FROM ledgers l
                  WHERE l.owner_profile_id IS NOT NULL
                    AND substr(n.dedupe_key, 1, length('report:' || l.id || ':')) =
                        'report:' || l.id || ':'
                ) THEN '（个人账本月报）'
                ELSE COALESCE(n.title, '（通知已删除）')
              END AS title,
              COALESCE(n.profile_id, '-') AS profile_id, d.route_name, d.status, d.attempts,
              d.confirmed_failures, d.transport_failures, d.created_at, d.sent_at, d.next_attempt_at, d.last_error
       FROM deliveries d LEFT JOIN notifications n ON n.id = d.notification_id
       ${profileId === undefined ? "" : "WHERE n.profile_id = ?"}
       ORDER BY d.created_at DESC, d.id DESC LIMIT ? OFFSET ?`,
    )
    .all(
      ...(profileId === undefined ? [limit, offset] : [profileId, limit, offset]),
    ) as unknown as DeliveryDetailItem[];

  const itemsTotal =
    profileId === undefined
      ? count("SELECT COUNT(*) AS n FROM deliveries")
      : count(
          `SELECT COUNT(*) AS n FROM deliveries d
           JOIN notifications n ON n.id = d.notification_id WHERE n.profile_id = ?`,
          profileId,
        );
  const countByStatus = (status: string): number =>
    count(
      `SELECT COUNT(*) AS n FROM deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE d.status = ?${profileFilter.sql}`,
      status,
      ...profileFilter.params,
    );
  const hasMore = offset + items.length < itemsTotal;
  return {
    counts: {
      queued: countByStatus("queued"),
      failed: countByStatus("failed"),
      fallback: countByStatus("fallback"),
      sent_24h: count(
        `SELECT COUNT(*) AS n FROM deliveries d JOIN notifications n ON n.id = d.notification_id
         WHERE d.status = 'sent' AND d.sent_at >= ?${profileFilter.sql}`,
        new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
        ...profileFilter.params,
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
    items_total: itemsTotal,
    offset,
    has_more: hasMore,
    next_offset: hasMore ? offset + items.length : null,
  };
}

export interface HolidayDetails {
  years: number[];
  year: number;
  days: Array<{ date: string; name: string; day_type: string; weekday: string }>;
  upcoming: Array<{
    date: string;
    end: string;
    name: string;
    days_until: number;
    days: number;
    /** 假期已开始且今天不是首日（首日由 days_until === 0 表达） */
    in_progress: boolean;
  }>;
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

  // year 列是「数据文件年份」，跨年条目（如 2027.json 里的 2026-12-31）会记成 2027。
  // 展示必须按**日期所属年份**筛，否则年末的元旦假期会被从当年视图里漏掉。
  const days = db
    .prepare(
      "SELECT date, name, day_type FROM cn_holiday_days WHERE date >= ? AND date <= ? ORDER BY date",
    )
    .all(`${year}-01-01`, `${year}-12-31`) as {
    date: string;
    name: string;
    day_type: string;
  }[];

  // 「接下来的假期」复用 core/holiday 的 holidayPeriods：它与 holiday {view:"next"}
  // 使用同一套「日期相邻即同一假期」的合并口径。不能从 today 开始截断 ——
  // 假期进行中时会丢掉首日与总天数，把「国庆 10-01 起共 7 天」显示成「10-03 起 5 天」。
  const upcoming: HolidayDetails["upcoming"] = holidayPeriods(db)
    .filter((period) => period.end >= today)
    .slice(0, 6)
    .map((period) => {
      const start = DateTime.fromISO(period.start, { zone: TZ });
      return {
        date: period.start,
        end: period.end,
        name: period.name,
        days_until: Math.max(
          0,
          Math.round(DateTime.fromISO(today, { zone: TZ }).diff(start, "days").days * -1),
        ),
        days: period.days,
        // 首日当天仍显示「就是今天」；只有真正进入假期中间才标「进行中」
        in_progress: period.start < today,
      };
    });

  return {
    years,
    year,
    days: days.map((d) => ({ ...d, weekday: weekdayLabel(d.date) })),
    upcoming,
  };
}

// ── 定时任务 ──────────────────────────────────────────────────────────────

export interface JobRunSummary {
  status: JobRunStatus;
  /** UTC ISO；看板/client 自行按本地时区展示（这里是瞬间，不做服务端本地化） */
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface JobDetailItem {
  module: string;
  name: string;
  /** 与 daemon 注册时同一份求值结果（config 驱动的 cron 也能拿到当前值） */
  cron: string;
  last_run: JobRunSummary | null;
  last_ok_at: string | null;
  /** 人读的「大约什么时候跑」提示；无法从 cron 概括时省略（看板只显示 cron 原文） */
  next_run_hint?: string;
  /** 最近 24 小时内该 job 的失败次数 */
  failed_24h: number;
  /** 最近 24 小时内的失败记录（最多 3 条，新的在前） */
  recent_failures: { started_at: string; error: string | null }[];
  /** 最近几次运行（最多 3 条，新的在前）：抽屉里展开「每 job 的最近运行」 */
  recent_runs: JobRunSummary[];
}

/**
 * 定时任务明细（/api/jobs 与 /api/status 的 jobs 段共用）。
 *
 * 数据源是 `job_runs` 记录而不是 daemon 内存状态：状态页只能看到库，
 * 而运行记录还包含「上次进程留下的失败」——正是需要曝光的那部分。
 * 每个 job 取 4 条轻量查询（最近一次 / 最近成功 / 24h 失败数 / 最近几次），
 * job 数量是个位数，没有必要为它写窗口函数。
 */
export function jobDetails(db: DatabaseSync, nowMs: number = Date.now()): JobDetailItem[] {
  const since24h = new Date(nowMs - 24 * 3600 * 1000).toISOString();
  const lastOkStmt = db.prepare(
    "SELECT started_at FROM job_runs WHERE job_name = ? AND status = 'ok' ORDER BY started_at DESC, id DESC LIMIT 1",
  );
  const failedCountStmt = db.prepare(
    "SELECT COUNT(*) AS n FROM job_runs WHERE job_name = ? AND status = 'failed' AND started_at >= ?",
  );
  const failuresStmt = db.prepare(
    "SELECT started_at, error FROM job_runs WHERE job_name = ? AND status = 'failed' AND started_at >= ? ORDER BY started_at DESC, id DESC LIMIT 3",
  );

  const items: JobDetailItem[] = allJobs().map(({ module, def }) => {
    const lastRun = lastJobRun(db, def.name);
    const lastOk = lastOkStmt.get(def.name) as { started_at: string } | undefined;
    const failed = failedCountStmt.get(def.name, since24h) as { n: number };
    const recentFailures = failuresStmt.all(def.name, since24h) as {
      started_at: string;
      error: string | null;
    }[];
    const item: JobDetailItem = {
      module,
      name: def.name,
      cron: jobCronExpr(def),
      last_run: lastRun === undefined ? null : summarizeRun(lastRun),
      last_ok_at: lastOk?.started_at ?? null,
      failed_24h: failed.n,
      recent_failures: recentFailures,
      recent_runs: recentJobRuns(db, { jobName: def.name, limit: 3 }).map(summarizeRun),
    };
    const hint = nextRunHint(item.cron);
    if (hint !== undefined) item.next_run_hint = hint;
    return item;
  });

  // 按 module + name 排序：注册顺序会随模块 import 顺序变化，展示顺序必须稳定
  return items.sort((a, b) =>
    a.module === b.module ? a.name.localeCompare(b.name) : a.module.localeCompare(b.module),
  );
}

function summarizeRun(row: JobRunRow): JobRunSummary {
  return {
    status: row.status,
    started_at: row.started_at,
    finished_at: row.finished_at,
    error: row.error,
  };
}

/** cron 表达式求值方式与 daemon 完全一致（函数形式从 config 惰性读取） */
function jobCronExpr(def: JobDef): string {
  try {
    return typeof def.cron === "function" ? def.cron() : def.cron;
  } catch {
    // daemon 启动时已经校验过 cron；这里失败只可能是 runtime 尚未初始化（测试/工具）。
    // 不能因此让整个状态页 500 —— 退回原样显示一个说明。
    return "(当前无法求值)";
  }
}

/**
 * 把常见 cron 翻译成一眼能懂的短语（`每天 07:00` / `每 20 分钟`）。
 * 只做展示提示，不改变任何调度语义；带日/月/星期限制的表达式返回 undefined，
 * 前端就会原样显示 cron 原文 —— 不猜。
 */
function nextRunHint(expr: string): string | undefined {
  if (expr.startsWith("(")) return undefined;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return undefined;
  const [minute = "", hour = "", dom = "", month = "", dow = ""] = parts;
  if (dom !== "*" || month !== "*" || dow !== "*") return undefined;

  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (minuteStep !== null && hour === "*") {
    const step = Number(minuteStep[1]);
    if (Number.isInteger(step) && step >= 1 && step <= 59) {
      return step === 1 ? "每分钟" : `每 ${step} 分钟`;
    }
    return undefined;
  }
  if (/^\d+$/.test(minute) && /^\d+$/.test(hour)) {
    const m = Number(minute);
    const h = Number(hour);
    if (m <= 59 && h <= 23)
      return `每天 ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
    return undefined;
  }
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (hourStep !== null && /^\d+$/.test(minute)) {
    const step = Number(hourStep[1]);
    const m = Number(minute);
    if (Number.isInteger(step) && step >= 1 && step <= 23 && m <= 59) {
      return `每 ${step} 小时（第 ${m} 分）`;
    }
  }
  return undefined;
}
