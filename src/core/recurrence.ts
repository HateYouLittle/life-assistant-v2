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
  /** 由调用方按已物化的「事件」数执行（同一事件的多个提醒偏移只算一次；引擎不管历史） */
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

/**
 * 单次 nextDate 调用允许推进的最大迭代次数。所有分支都应在远小于该值的步数内
 * 产出候选日期；一旦超出即视为规则不可满足（例如 weekly 没有任何可用星期），
 * 抛错而不是让调用方的同步循环永久挂起。
 */
const MAX_ITERATIONS = 5000;

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
  // interval 缺省或非法时兜底为 1，避免推进日期死循环
  const interval = typeof rec.interval === "number" && rec.interval >= 1 ? rec.interval : 1;
  let steps = 0;
  const tick = (): void => {
    if (++steps > MAX_ITERATIONS) {
      throw new Error(
        `recurrence 规则无法产生日期（freq=${rec.freq}，已迭代 ${MAX_ITERATIONS} 次）——请检查 byweekday 等参数`,
      );
    }
  };
  switch (rec.freq) {
    case "daily": {
      let d = start;
      while (d <= afterDay) {
        tick();
        d = d.plus({ days: interval });
      }
      yield d;
      for (;;) {
        tick();
        d = d.plus({ days: interval });
        yield d;
      }
    }
    case "weekly": {
      const monday = start.minus({ days: start.weekday - 1 });
      // 关键：候选星期必须非空，否则内层 for 永不产出 → 外层 for(;;) 永不终止
      // → 同步死循环卡死整个 daemon。两道防线：
      //   1) 显式判空长度 —— `??` 只兜底 null/undefined，空数组兜不住；
      //   2) uniqSorted 会把越界值（如 [9,-1]）全部滤掉，因此必须对「过滤后的结果」
      //      再兜底，否则非空但全越界的数组仍会挂起。
      const candidates = uniqSorted(rec.byweekday?.length ? rec.byweekday : [start.weekday - 1]);
      const days = candidates.length > 0 ? candidates : [start.weekday - 1];
      for (let week = 0; ; week++) {
        tick();
        const weekStart = monday.plus({ weeks: week * interval });
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
        tick();
        const d = clampDay(year, month, day);
        if (d >= start && d > afterDay) yield d;
        const nextIndex = year * 12 + (month - 1) + interval;
        year = Math.floor(nextIndex / 12);
        month = (nextIndex % 12) + 1;
      }
    }
    case "yearly": {
      const month = start.month;
      const day = start.day;
      // interval 必须参与推进：漏乘会让「每 2 年」变成每年都触发，
      // 而 describeRecurrence 仍显示「每 2 年」——回显与实际排期互相矛盾。
      for (let year = start.year; ; year += interval) {
        tick();
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
  const candidates = months.filter(
    (m) => Math.abs(m.getMonth()) === month && m.getYear() === lunarYear,
  );
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
  // 必须用 Number.isInteger：`null >= 0 && null <= 6` 为真，会让 null 混进星期集合，
  // 经 luxon.plus({days:null}) 静默变成 no-op，最终把 weekly 落到周一而不是报错/兜底。
  return [...new Set(values)]
    .filter((v) => Number.isInteger(v) && v >= 0 && v <= 6)
    .sort((a, b) => a - b);
}

/** 供通知/列表展示的循环规则人话描述 */
export function describeRecurrence(
  source: Pick<
    OccurrenceSource,
    "calendar" | "recurrence" | "lunarMonth" | "lunarDay" | "leapPolicy"
  >,
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
      const days = uniqSorted(rec.byweekday ?? [])
        .map((d) => names[d] ?? "")
        .join("、");
      const week = n === 1 ? "每周" : `每 ${n} 周 `;
      // 星期列表为空（脏数据兜底路径；工具入口与 validateScheduleInput 都会拦截空数组）
      // 时不留尾随空格，避免描述拼成「每 2 周 」
      return days === "" ? week.trimEnd() : `${week}${days}`;
    }
    case "monthly":
      return n === 1 ? `每月${startDate?.slice(8, 10) ?? ""}日` : `每 ${n} 个月`;
    case "yearly":
      return n === 1
        ? `每年${startDate?.slice(5, 7) ?? ""}月${startDate?.slice(8, 10) ?? ""}日`
        : `每 ${n} 年`;
  }
}
