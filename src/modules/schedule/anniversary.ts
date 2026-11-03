/**
 * 生日 / 纪念日的纯函数：默认提醒节奏、「第 N 天 / N 周年」、倒计时文案。
 * 只做日历日（`YYYY-MM-DD`）算术，不碰时区与数据库，便于单测闰年与跨月。
 */

/** 生日/纪念日新建时的默认提醒偏移：提前 7 天 + 前 1 天 + 当天（分钟） */
export const SPECIAL_DAY_DEFAULT_OFFSETS: readonly number[] = [-7 * 1440, -1440, 0];
/** 待办新建时的默认提醒偏移（到点提醒） */
export const TODO_DEFAULT_OFFSETS: readonly number[] = [0];

/** 新建日程未显式给 remind_offsets 时的默认值（按 kind）；只用于新建，不回写存量日程 */
export function defaultRemindOffsets(kind: "todo" | "birthday" | "anniversary"): number[] {
  return [...(kind === "todo" ? TODO_DEFAULT_OFFSETS : SPECIAL_DAY_DEFAULT_OFFSETS)];
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(date: string): { y: number; m: number; d: number } | null {
  const matched = DATE_RE.exec(date);
  if (matched === null) return null;
  const y = Number(matched[1]);
  const m = Number(matched[2]);
  const d = Number(matched[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

/** 两个日历日之间相差的天数（to - from）；任一日期不合法返回 null */
export function daysBetween(from: string, to: string): number | null {
  const a = parseDate(from);
  const b = parseDate(to);
  if (a === null || b === null) return null;
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000);
}

export interface Milestone {
  /** 第几天：开始当天算第 1 天 */
  dayNumber: number;
  /** 当天恰好是第几个周年；不是周年当天（或不足 1 年）为 null */
  years: number | null;
}

/**
 * 以 `startDate` 为起点，`date` 当天的「第 N 天 / N 周年」。
 *
 * - 第 N 天：开始当天为第 1 天（与常见「在一起第 N 天」口径一致）；
 * - 周年：只有 `date` 的月日与开始日相同才算；开始日是 2 月 29 日时，平年的 2 月 28 日
 *   也算周年 —— 循环引擎在平年把 02-29 夹到 02-28（core/recurrence.ts 的 clampDay），
 *   提醒就落在那天，不能因此漏掉「N 周年」。
 * - `date` 不晚于 `startDate`（首次发生当天没有可说的天数）或任一日期不合法返回 null
 *   （调用方不输出该栏）。
 */
export function milestoneOn(startDate: string, date: string): Milestone | null {
  const start = parseDate(startDate);
  const target = parseDate(date);
  const diff = daysBetween(startDate, date);
  if (start === null || target === null || diff === null || diff <= 0) return null;
  const sameMonthDay = start.m === target.m && start.d === target.d;
  const clampedLeapDay =
    start.m === 2 && start.d === 29 && target.m === 2 && target.d === 28 && !isLeapYear(target.y);
  const years = target.y - start.y;
  return {
    dayNumber: diff + 1,
    years: (sameMonthDay || clampedLeapDay) && years >= 1 ? years : null,
  };
}

/** 「5 周年 · 第 1827 天」/「第 885 天」 */
export function milestoneText(m: Milestone): string {
  return m.years === null ? `第 ${m.dayNumber} 天` : `${m.years} 周年 · 第 ${m.dayNumber} 天`;
}

/** 倒计时：0 →「今天」，n →「还有 n 天」；已过去返回 null */
export function countdownText(today: string, eventDate: string): string | null {
  const diff = daysBetween(today, eventDate);
  if (diff === null || diff < 0) return null;
  return diff === 0 ? "今天" : `还有 ${diff} 天`;
}

/**
 * 某日程在 `eventDate` 那次的纪念文案；只给**公历纪念日**且有开始日期的日程。
 * 生日不算岁数：库里的生日多为农历且没有出生年，公历生日的 start_date 也不一定是出生日，
 * 猜错岁数比不写更糟。
 */
export function anniversaryMilestoneText(
  row: { kind: string; calendar: string; start_date: string | null },
  eventDate: string,
): string | null {
  if (row.kind !== "anniversary" || row.calendar !== "solar" || row.start_date === null) {
    return null;
  }
  const m = milestoneOn(row.start_date, eventDate);
  return m === null ? null : milestoneText(m);
}
