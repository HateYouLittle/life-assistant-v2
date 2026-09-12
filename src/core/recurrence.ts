import { DateTime } from "luxon";
import { Lunar, LunarYear } from "lunar-javascript";
import { TZ } from "../time.js";

/**
 * 自研 recurrence 引擎（替代 rrule）：只覆盖 v2 实际支持的形状。
 * 纯函数、无 IO；工作日/节假日过滤由调用方基于 holiday 数据完成（缺数据时暂停）。
 * 语义：nextDate 返回严格晚于 after 的下一个本地日历日（Asia/Shanghai 零点）。
 */

export type Freq = "daily" | "weekly" | "monthly" | "yearly";

export interface Recurrence {
  freq: Freq;
  interval: number;
  /** weekly 专用：0=周一 .. 6=周日 */
  byweekday?: number[];
  /** 本地日期（含当天）为最后一次发生 */
  until?: string;
  /** 由调用方按已物化的 occurrence 数执行（引擎不管历史） */
  count?: number;
}

export interface OccurrenceSource {
  calendar: "solar" | "lunar";
  startDate: string | null;
  lunarMonth: number | null;
  lunarDay: number | null;
  /** follow：当年有对应闰月则用闰月；regular：从不用闰月 */
  leapPolicy: "follow" | "regular";
  /** true：农历日越界（如腊月三十缺失）取当月最后一天；false：当年跳过 */
  lunarClamp: boolean;
  recurrence: Recurrence | null;
}

/** 返回下一个本地日历日（> after 的日期，含时刻 00:00）；无更多发生返回 null */
export function nextDate(
  source: OccurrenceSource,
  after: DateTime,
  horizon: DateTime,
): DateTime | null {
  for (const candidate of iterate(source, after.startOf("day"))) {
    if (candidate > horizon) return null;
    const until = source.recurrence?.until;
    if (until !== undefined && (candidate.toISODate() ?? "") > until) return null;
    return candidate;
  }
  return null;
}

function* iterate(source: OccurrenceSource, afterDay: DateTime): Generator<DateTime> {
  if (source.calendar === "lunar") {
    yield* iterateLunar(source, afterDay);
    return;
  }
  if (source.startDate === null) return;
  const start = DateTime.fromISO(source.startDate, { zone: TZ }).startOf("day");
  if (!start.isValid) return;
  const rec = source.recurrence;
  if (rec === null) {
    if (start > afterDay) yield start;
    return;
  }
  switch (rec.freq) {
    case "daily": {
      let d = start;
      while (d <= afterDay) d = d.plus({ days: rec.interval });
      yield d;
      for (;;) {
        d = d.plus({ days: rec.interval });
        yield d;
      }
    }
    case "weekly": {
      const monday = start.minus({ days: start.weekday - 1 });
      const days = uniqSorted(rec.byweekday ?? [start.weekday - 1]);
      for (let week = 0; ; week++) {
        const weekStart = monday.plus({ weeks: week * rec.interval });
        for (const dy of days) {
          const d = weekStart.plus({ days: dy });
          if (d < start) continue;
          if (d > afterDay) yield d;
        }
      }
    }
    case "monthly": {
      const day = start.day;
      let year = start.year;
      let month = start.month;
      for (;;) {
        const d = clampDay(year, month, day);
        if (d >= start && d > afterDay) yield d;
        const nextIndex = (year * 12 + (month - 1)) + rec.interval;
        year = Math.floor(nextIndex / 12);
        month = (nextIndex % 12) + 1;
      }
    }
    case "yearly": {
      const month = start.month;
      const day = start.day;
      for (let year = start.year; ; year++) {
        const d = clampDay(year, month, day);
        if (d >= start && d > afterDay) yield d;
      }
    }
  }
}

function* iterateLunar(source: OccurrenceSource, afterDay: DateTime): Generator<DateTime> {
  const month = source.lunarMonth ?? 0;
  const day = source.lunarDay ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > 30) return;
  if (source.recurrence === null) return; // 农历事件必须循环（每年）
  let lunarYear = Lunar.fromYmd(afterDay.year, afterDay.month, afterDay.day).getYear();
  for (let i = 0; i < 200; i++, lunarYear++) {
    const d = lunarToSolar(lunarYear, month, day, source.leapPolicy, source.lunarClamp);
    if (d === null) continue;
    if (d > afterDay) yield d;
  }
}

/** 农历 (年, 月, 日) → 公历本地零点；无效组合返回 null（clamp 控制腊月三十类越界） */
export function lunarToSolar(
  lunarYear: number,
  month: number,
  day: number,
  leapPolicy: "follow" | "regular",
  clamp: boolean,
): DateTime | null {
  const months = LunarYear.fromYear(lunarYear).getMonths();
  const candidates = months.filter((m) => Math.abs(m.getMonth()) === month && m.getYear() === lunarYear);
  if (candidates.length === 0) return null;
  let target = candidates.find((m) => (leapPolicy === "follow" ? m.isLeap() : !m.isLeap()));
  if (target === undefined) target = candidates[0];
  if (target === undefined) return null;
  const daysInMonth = target.getDayCount();
  const effectiveDay = day > daysInMonth ? (clamp ? daysInMonth : null) : day;
  if (effectiveDay === null) return null;
  try {
    const solar = Lunar.fromYmd(lunarYear, target.getMonth(), effectiveDay).getSolar();
    const dt = DateTime.fromObject(
      { year: solar.getYear(), month: solar.getMonth(), day: solar.getDay() },
      { zone: TZ },
    ).startOf("day");
    return dt.isValid ? dt : null;
  } catch {
    return null;
  }
}

function clampDay(year: number, month: number, day: number): DateTime {
  const daysInMonth = DateTime.fromObject({ year, month }, { zone: TZ }).daysInMonth ?? 30;
  const d = Math.min(day, daysInMonth);
  return DateTime.fromObject({ year, month, day: d }, { zone: TZ }).startOf("day");
}

function uniqSorted(values: number[]): number[] {
  return [...new Set(values)].filter((v) => v >= 0 && v <= 6).sort((a, b) => a - b);
}

/** 供通知/列表展示的循环规则人话描述 */
export function describeRecurrence(
  source: Pick<OccurrenceSource, "calendar" | "recurrence" | "lunarMonth" | "lunarDay" | "leapPolicy">,
  startDate: string | null,
): string {
  const rec = source.recurrence;
  if (source.calendar === "lunar") {
    const name = `农历${source.lunarMonth}月${source.lunarDay}日`;
    return rec === null ? `一次：${name}` : `每年${name}`;
  }
  if (rec === null) return `一次：${startDate ?? ""}`;
  const n = rec.interval;
  switch (rec.freq) {
    case "daily":
      return n === 1 ? "每天" : `每 ${n} 天`;
    case "weekly": {
      const names = ["一", "二", "三", "四", "五", "六", "日"];
      const days = uniqSorted(rec.byweekday ?? []).map((d) => names[d] ?? "").join("、");
      const body = `每周${n === 1 ? "" : n}${days === "" ? "" : days}`;
      return body;
    }
    case "monthly":
      return n === 1 ? `每月${startDate?.slice(8, 10) ?? ""}日` : `每 ${n} 个月`;
    case "yearly":
      return n === 1 ? `每年${startDate?.slice(5, 7) ?? ""}月${startDate?.slice(8, 10) ?? ""}日` : `每 ${n} 年`;
  }
}
