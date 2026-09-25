import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { TZ, todayIso } from "../time.js";
import { fetchJson } from "./http.js";
import { withTransaction } from "./database.js";
import { logger } from "./logger.js";

export type DayType = "holiday" | "workday" | "weekend" | "weekday";

export interface HolidayDay {
  name: string;
  date: string;
  isOffDay: boolean;
}

export interface HolidayYearPayload {
  year: number;
  days: HolidayDay[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FESTIVALS = ["元旦", "春节", "清明节", "劳动节", "端午节", "中秋节", "国庆节"];
const FETCH_COOLDOWN_MS = 6 * 3600 * 1000;
/**
 * 调休上班日与假期的最大间隔（天）。用于把同名假期（年年都有「国庆节」）的调休日
 * 归属到正确的年份：落在假期首尾 3 周内才算这一段。实际数据里调休最多提前/推后约两周。
 */
const WORKDAY_PROXIMITY_DAYS = 21;

/** 年度数据的候选 URL（jsDelivr 优先，GitHub raw 兜底）。导出以便 doctor 与抓取共用同一份列表 */
export function holidaySourceUrls(year: number): string[] {
  return [
    `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
    `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
  ];
}

/**
 * 日期分类。规则：
 * 1. 命中 cn_holiday_days → holiday / workday（权威数据）
 * 2. 未命中但该年份 status='ready' → 按星期兜底：周六日=weekend，其余=weekday
 * 3. 未命中且该年份数据未就绪 → unknown（调用方必须暂停，不得猜测）
 */
export function dayType(db: DatabaseSync, date: string): DayType | "unknown" {
  const row = db.prepare("SELECT day_type FROM cn_holiday_days WHERE date = ?").get(date) as
    | { day_type: string }
    | undefined;
  if (row !== undefined) return row.day_type as DayType;
  const year = Number(date.slice(0, 4));
  const meta = db.prepare("SELECT status FROM cn_holiday_years WHERE year = ?").get(year) as
    | { status: string }
    | undefined;
  if (meta?.status !== "ready") return "unknown";
  const weekday = DateTime.fromISO(date, { zone: TZ }).weekday; // 6=周六 7=周日
  return weekday >= 6 ? "weekend" : "weekday";
}

export function holidayYearsReady(db: DatabaseSync): number[] {
  return (
    db.prepare("SELECT year FROM cn_holiday_years WHERE status = 'ready' ORDER BY year").all() as {
      year: number;
    }[]
  ).map((r) => r.year);
}

/**
 * 校验 holiday-cn 年度数据；返回错误列表（空 = 通过）。
 *
 * 允许「跨年日期」：上游按**假期**归档而非按日历年份 —— 例如 2023.json 声明
 * year=2023 却包含 `2022-12-31`（元旦假期从上一年的 12-31 开始）。此前要求
 * `dt.year === year`，会让该年整份数据校验失败、整年零行导入，进而使所有
 * workday/holiday 过滤的日程被暂停。
 */
export function validateYearPayload(payload: unknown): string[] {
  const errors: string[] = [];
  if (typeof payload !== "object" || payload === null) return ["payload 不是对象"];
  const p = payload as { year?: unknown; days?: unknown };
  const year = p.year;
  if (typeof year !== "number" || !Number.isInteger(year) || year < 2004 || year > 2100) {
    return ["year 字段不合法"];
  }
  if (!Array.isArray(p.days) || p.days.length === 0) return ["days 为空"];
  const seen = new Set<string>();
  const offDays: HolidayDay[] = [];
  const workdays: HolidayDay[] = [];
  for (const raw of p.days) {
    if (typeof raw !== "object" || raw === null) {
      errors.push("days 含非对象条目");
      continue;
    }
    const d = raw as { name?: unknown; date?: unknown; isOffDay?: unknown };
    if (typeof d.name !== "string" || d.name.trim() === "") {
      errors.push(`日期 ${String(d.date)} 缺少 name`);
      continue;
    }
    if (typeof d.date !== "string" || !DATE_RE.test(d.date)) {
      errors.push(`日期不合法: ${String(d.date)}`);
      continue;
    }
    const dt = DateTime.fromISO(d.date, { zone: TZ });
    // 必须是真实存在的日历日（拒绝 2026-02-30），且只接受本年度或上一年 12 月
    // 的日期 —— 上一年 12 月正是跨年假期（元旦）所在区间。
    const inYear = dt.isValid && dt.year === year;
    const crossYear = dt.isValid && dt.year === year - 1 && dt.month === 12;
    if (!inYear && !crossYear) {
      errors.push(`日期 ${d.date} 不属于 ${year} 年（或 ${year - 1} 年 12 月）或不是真实日历日`);
      continue;
    }
    if (typeof d.isOffDay !== "boolean") {
      errors.push(`日期 ${d.date} 缺少 isOffDay`);
      continue;
    }
    if (seen.has(d.date)) {
      errors.push(`日期重复: ${d.date}`);
      continue;
    }
    seen.add(d.date);
    const entry: HolidayDay = { name: d.name.trim(), date: d.date, isOffDay: d.isOffDay };
    (entry.isOffDay ? offDays : workdays).push(entry);
  }

  if (year >= 2008) {
    // 数据源在国庆与中秋重叠的年份会给出合并名（如「国庆节、中秋节」，2025/2028 均如此），
    // 因此必须按分隔符拆成原子节日名再比对，否则整年数据会被误判为「缺少节日」而拒绝导入。
    const names = new Set(
      [...offDays, ...workdays]
        .flatMap((d) => d.name.split(/[、，,／/\s]+/))
        .filter((name) => name !== ""),
    );
    for (const festival of FESTIVALS) {
      if (!names.has(festival)) errors.push(`缺少节日: ${festival}`);
    }
  }
  if (offDays.length < 20 || offDays.length > 45) {
    errors.push(`全年放假天数 ${offDays.length} 超出合理范围 [20, 45]`);
  }
  if (workdays.length > 12) {
    errors.push(`调休上班天数 ${workdays.length} 超过 12`);
  }
  for (const wd of workdays) {
    const weekday = DateTime.fromISO(wd.date, { zone: TZ }).weekday; // 6=周六 7=周日
    if (weekday < 6) errors.push(`调休上班日 ${wd.date} 不是周末`);
  }
  for (const festival of new Set(offDays.map((d) => d.name))) {
    const dates = offDays
      .filter((d) => d.name === festival)
      .map((d) => DateTime.fromISO(d.date, { zone: TZ }).toMillis())
      .sort((a, b) => a - b);
    let segments = 1;
    for (let i = 1; i < dates.length; i++) {
      if ((dates[i] as number) - (dates[i - 1] as number) > 86_400_000) segments++;
    }
    if (segments > 4) errors.push(`节日 ${festival} 连续段超过 4 段`);
  }
  return errors;
}

/** 整年替换导入（按年份删除重插），并写年份元数据 */
export function importYear(db: DatabaseSync, payload: HolidayYearPayload, source: string): number {
  const now = new Date().toISOString();
  return withTransaction(db, () => {
    db.prepare("DELETE FROM cn_holiday_days WHERE year = ?").run(payload.year);
    const select = db.prepare("SELECT year FROM cn_holiday_days WHERE date = ?");
    const upsert = db.prepare(
      `INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (date) DO UPDATE SET year = excluded.year, day_type = excluded.day_type,
         name = excluded.name, source = excluded.source, updated_at = excluded.updated_at`,
    );
    let count = 0;
    for (const day of payload.days) {
      // 跨年日期（如 2023.json 里的 2022-12-31）会同时出现在相邻两个年度的文件里。
      // 「年份更贴近该日期」的文件更权威：12-31 的归属应由其本身所属年份的 12 月文件
      // 决定，而不是下一年度文件的跨年条目。这样导入顺序不会改变最终结果。
      const dateYear = Number(day.date.slice(0, 4));
      const existing = select.get(day.date) as { year: number } | undefined;
      if (
        existing !== undefined &&
        Math.abs(existing.year - dateYear) < Math.abs(payload.year - dateYear)
      ) {
        continue;
      }
      upsert.run(
        day.date,
        payload.year,
        day.isOffDay ? "holiday" : "workday",
        day.name,
        source,
        now,
      );
      count++;
    }
    db.prepare(
      `INSERT INTO cn_holiday_years (year, status, source, fetched_at, last_attempt_at, last_error)
       VALUES (?, 'ready', ?, ?, ?, NULL)
       ON CONFLICT (year) DO UPDATE SET status = 'ready', source = excluded.source,
         fetched_at = excluded.fetched_at, last_attempt_at = excluded.last_attempt_at, last_error = NULL`,
    ).run(payload.year, source, now, now);
    return count;
  });
}

function recordFailure(db: DatabaseSync, year: number, error: string): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO cn_holiday_years (year, status, source, fetched_at, last_attempt_at, last_error)
     VALUES (?, 'failed', '', ?, ?, ?)
     ON CONFLICT (year) DO UPDATE SET status = 'failed', last_attempt_at = excluded.last_attempt_at,
       last_error = excluded.last_error
     WHERE cn_holiday_years.status != 'ready'`,
  ).run(year, now, now, error);
}

export async function fetchYearPayload(
  year: number,
  fetcher: (url: string) => Promise<unknown> = fetchJson,
): Promise<HolidayYearPayload> {
  let lastError = "";
  for (const url of holidaySourceUrls(year)) {
    try {
      const payload = (await fetcher(url)) as HolidayYearPayload;
      return payload;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(`年度数据抓取失败 ${year}: ${lastError}`);
}

/** 正在抓取的年份：同一进程内避免 refresh job 与 schedule tick 并发抓同一年 */
const inflightYears = new Set<number>();

/** 确保指定年份就绪：ready 跳过；失败后 6 小时冷却；返回本次更新的年份 */
export async function ensureYears(
  db: DatabaseSync,
  years: number[],
  fetcher?: (url: string) => Promise<unknown>,
): Promise<{ updated: number[]; skipped: number[]; failed: string[] }> {
  const updated: number[] = [];
  const skipped: number[] = [];
  const failed: string[] = [];
  for (const year of years) {
    // 并发路径：节假日 refresh job（02:00）与 schedule tick 的按需补齐都会调这里。
    // 不加这道闸，两方会同时抓同一年；更糟的是一方 importYear 置 ready 后，
    // 另一方的失败回写会把状态改回 failed —— 数据其实可用，`dayType` 却返回 unknown，
    // 所有 workday/holiday 过滤的日程集体暂停。
    if (inflightYears.has(year)) {
      skipped.push(year);
      continue;
    }
    const meta = db
      .prepare("SELECT status, last_attempt_at FROM cn_holiday_years WHERE year = ?")
      .get(year) as { status: string; last_attempt_at: string | null } | undefined;
    if (meta?.status === "ready") {
      skipped.push(year);
      continue;
    }
    if (meta?.status === "failed" && meta.last_attempt_at !== null) {
      const since = Date.now() - new Date(meta.last_attempt_at).getTime();
      if (since >= 0 && since < FETCH_COOLDOWN_MS) {
        skipped.push(year);
        continue;
      }
    }
    inflightYears.add(year);
    try {
      const payload = await fetchYearPayload(year, fetcher);
      // CDN 可能返回缓存/错配的文件；若不比对，会把错误年份「导入成功」，
      // 而请求的年份既没有数据行也没有 cn_holiday_years 行，永远 not ready 且不再冷却。
      if (payload.year !== year) {
        throw new Error(
          `年度数据错配: 请求 ${year} 年，数据里的 year 字段是 ${String(payload.year)}`,
        );
      }
      const errors = validateYearPayload(payload);
      if (errors.length > 0) throw new Error(`数据校验失败: ${errors.join("; ")}`);
      const count = importYear(db, payload, "holiday-cn");
      updated.push(year);
      logger.info(`节假日数据导入 ${year} 年 ${count} 天`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // recordFailure 带 status != 'ready' 守卫：失败不能覆盖已经就绪的年份
      recordFailure(db, year, message);
      failed.push(`${year}: ${message}`);
    } finally {
      inflightYears.delete(year);
    }
  }
  return { updated, skipped, failed };
}

/** 需要保障的年份：当年 + （10 月起）下一年 */
export function requiredYears(today: string = todayIso()): number[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month >= 10 ? [year, year + 1] : [year];
}

/** 假期区间（由连续的 holiday 行合并而成） */
export interface HolidayPeriodInfo {
  name: string;
  start: string;
  end: string;
  days: number;
  /** 该假期的调休上班日（按日期升序）；按假期名分词匹配归属 */
  workdays: string[];
}

function nameTokens(name: string): Set<string> {
  return new Set(name.split(/[、，,／/\s]+/).filter((token) => token !== ""));
}

/**
 * 全部假期区间：`day_type='holiday'` 且日期连续的行合并为一段（首尾相接即同一假期，
 * 因此跨年元旦会自然衔接）。区间名取段内出现次数最多的 name —— 数据源会用
 * 「国庆节、中秋节」这类合并名，同一段内也可能逐行不同，取众数最稳定。
 * 调休上班日按假期名分词匹配（生产库中 workday 行的 name 即所属假期名，如「国庆节」）。
 */
export function holidayPeriods(db: DatabaseSync): HolidayPeriodInfo[] {
  const holidays = db
    .prepare("SELECT date, name FROM cn_holiday_days WHERE day_type = 'holiday' ORDER BY date")
    .all() as { date: string; name: string }[];
  const workdayRows = db
    .prepare("SELECT date, name FROM cn_holiday_days WHERE day_type = 'workday' ORDER BY date")
    .all() as { date: string; name: string }[];

  const groups: { dates: string[]; names: string[] }[] = [];
  for (const row of holidays) {
    const current = groups[groups.length - 1];
    const last = current?.dates[current.dates.length - 1];
    const contiguous =
      last !== undefined &&
      DateTime.fromISO(last, { zone: TZ }).plus({ days: 1 }).toISODate() === row.date;
    if (current !== undefined && contiguous) {
      current.dates.push(row.date);
      current.names.push(row.name);
    } else {
      groups.push({ dates: [row.date], names: [row.name] });
    }
  }

  return groups.map((group) => {
    const counts = new Map<string, number>();
    for (const candidate of group.names) counts.set(candidate, (counts.get(candidate) ?? 0) + 1);
    let name = group.names[0] as string;
    let best = 0;
    for (const [candidate, count] of counts) {
      if (count > best) {
        best = count;
        name = candidate;
      }
    }
    const tokens = nameTokens(name);
    const workdays = workdayRows
      .filter((row) => {
        // 只按名字匹配是不够的：两年的「国庆节」共享同一个名字，2027 年的调休日
        // 会被算进 2026 年的假期，提醒里就会多出明年 9/10 月的日期。
        // 调休日总是紧贴假期（前后 3 周内），据此把归属限定在本段附近。
        const delta = Math.abs(
          DateTime.fromISO(row.date, { zone: TZ }).diff(
            DateTime.fromISO(group.dates[0] as string, { zone: TZ }),
            "days",
          ).days,
        );
        const nearStart = delta <= WORKDAY_PROXIMITY_DAYS;
        const nearEnd =
          Math.abs(
            DateTime.fromISO(row.date, { zone: TZ }).diff(
              DateTime.fromISO(group.dates[group.dates.length - 1] as string, { zone: TZ }),
              "days",
            ).days,
          ) <= WORKDAY_PROXIMITY_DAYS;
        if (!nearStart && !nearEnd) return false;
        for (const token of nameTokens(row.name)) {
          if (tokens.has(token)) return true;
        }
        return false;
      })
      .map((row) => row.date);
    return {
      name,
      start: group.dates[0] as string,
      end: group.dates[group.dates.length - 1] as string,
      days: group.dates.length,
      workdays,
    };
  });
}

/** 该日期在 cn_holiday_days 里的名称（holiday/workday 均可）；未命中返回 null */
export function holidayDayName(db: DatabaseSync, date: string): string | null {
  const row = db.prepare("SELECT name FROM cn_holiday_days WHERE date = ?").get(date) as
    | { name: string }
    | undefined;
  return row?.name ?? null;
}

/**
 * 下一假期（含名称/起止/天数）；无数据返回 null。
 * 区间口径**就是** holidayPeriods（同一函数产出，不再各自定义一遍）：此前这里按
 * 「同名且相邻」回溯，而提醒与简报里的假期段按「日期相邻」分段，两套定义在
 * 上游给出合并名（如「国庆节、中秋节」）或名称逐年变化的年份会算出不同的天数。
 * 「下一假期」= 第一个 end >= today 的段（today 落在段内时就是它，且 inProgress 为真）。
 */
export function nextHolidayPeriod(
  db: DatabaseSync,
  today: string = todayIso(),
): {
  name: string;
  start: string;
  end: string;
  days: number;
  inProgress: boolean;
} | null {
  const period = holidayPeriods(db).find((candidate) => candidate.end >= today);
  if (period === undefined) return null;
  return {
    name: period.name,
    start: period.start,
    end: period.end,
    days: period.days,
    inProgress: period.start <= today,
  };
}
