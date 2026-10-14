import { DateTime } from "luxon";
import { Lunar, LunarYear, Solar } from "lunar-javascript";
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
        `recurrence 规则无法产生日期（freq=${rec.freq}，已迭代 ${MAX_ITERATIONS} 次）——请检查该循环的日期/间隔参数`,
      );
    }
  };
  switch (rec.freq) {
    case "daily": {
      // 直接跳算到 afterDay 附近，而不是从 start 逐日推进：start 早于约 5000 天时
      // 逐日 while 会耗尽迭代预算（曾把「2011 年起的每日提醒」误报为规则无法产生日期，
      // 而规则完全合法；任何 13.7 年以上的 daily 都会中招）。
      // 步数下限为 0：start 在未来时绝不能把游标推到 start 之前（会越过起始边界）。
      const gapDays = Math.floor(afterDay.diff(start, "days").days);
      const skipped = Math.max(0, Math.floor(gapDays / interval));
      let d = start.plus({ days: skipped * interval });
      while (d <= afterDay) d = d.plus({ days: interval });
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

/**
 * 农历循环的 interval 写入侧收口：「农历必须 interval === 1」的**单一收口**。
 *
 * 农历引擎不按间隔跳年（iterateLunar 只做 lunarYear++），所以农历 + interval>1 是
 * 一条「校验认账、引擎忽略」的组合。validateScheduleInput 只拦显式传入的非法值，
 * 而两条写入路径会绕过它：
 * - MCP 的 solar→lunar 转换：patch 不传 recurrence 时校验看到的是归一值（interval=1），
 *   落库却写回继承来的原值；
 * - import:v1 的裸 SQL INSERT：整条路径不经任何校验。
 * 两条都在**落库前**走这里收敛，故脏数据没有第二个产生入口。
 *
 * 只收 interval，不动 freq/until/count：那些是合法的用户配置（农历 freq 必须是
 * yearly，由校验与导入映射分别保证）。describeRecurrence 对**存量**脏数据仍会显式
 * 说明 interval 被忽略（收敛只发生在写入侧，不追溯改历史行）。
 */
export function collapseLunarInterval(
  calendar: "solar" | "lunar",
  recurrence: Recurrence | null,
): Recurrence | null {
  if (calendar === "lunar" && recurrence !== null && recurrence.interval !== 1) {
    return { ...recurrence, interval: 1 };
  }
  return recurrence;
}

/**
 * 该 `recurrence_json` 是否声明了 `count`（发生次数上限）。**count 判定唯一来源**：
 * schedule 的 occurrence 清理与保留策略（core/retention）都经它，避免两处各写一份判定
 * 后悄悄漂移（曾是 `NOT LIKE '%"count"%'` 与按解析结果两套口径）。
 *
 * 解析失败时保守返回 true：无法确认是否用了 count 时宁可不清理 —— 删历史会让已达上限的
 * 循环复活（见 modules/schedule 的 existingDates 与 core/retention）。
 */
export function recurrenceDeclaresCount(json: string | null): boolean {
  if (json === null) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return true;
  }
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    !Array.isArray(parsed) &&
    (parsed as { count?: unknown }).count !== undefined
  );
}

/**
 * 农历（年, 月, 日）→ 公历零点序列。**每年一次**：`recurrence.interval` 不参与推进
 * （农历年与公历年不等长，「每 2 年」在农历上没有自洽的锚点），写入侧由
 * collapseLunarInterval 收敛、validateScheduleInput 拒掉显式非法值，
 * describeRecurrence 对存量脏数据显式说明它被忽略。
 */
function* iterateLunar(source: OccurrenceSource, afterDay: DateTime): Generator<DateTime> {
  const month = source.lunarMonth ?? 0;
  const day = source.lunarDay ?? 0;
  if (month < 1 || month > 12 || day < 1 || day > 30) return;
  if (source.recurrence === null) return; // 农历事件必须循环（每年）
  // 起点必须是「包含该公历日的农历年」，不能把公历年直接当农历年：
  // 元旦到春节之间的公历日仍属上一农历年（如 2026-01-10 属农历 2025 年腊月），
  // 直接用 2026 会跳过本农历年内尚未发生的日期，整段（如腊月十八）漏提醒。
  let lunarYear = Solar.fromYmd(afterDay.year, afterDay.month, afterDay.day).getLunar().getYear();
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

/**
 * 日号落在「规则会访问到的某个月」之外时，实际物化会被 clampDay 夹到该月最后一天，
 * 而非该日号在短月里不存在（如「每月31日」在 11 月只得 30 日、「每年2月29日」在平年只得 28 日）。
 * 文案必须体现这个夹取，否则回显与实际排期互相矛盾（yearly 的 interval 曾出过同类问题）。
 */
const CLAMP_NOTE = "（不足则取月末）";
/** 不允许顺延时三十日所在的小月整年没有该日：引擎直接跳过，不是「改到月末」 */
const LUNAR_SKIP_NOTE = "（小月整年跳过）";

/** 该日号在给定月份里是否会被夹到月末；用平年算二月（28 天）即最短月 */
function willClamp(months: number[], day: number): boolean {
  return months.some(
    (month) => day > (DateTime.fromObject({ year: 2026, month }, { zone: TZ }).daysInMonth ?? 30),
  );
}

const ALL_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

/**
 * 农历月/日「缺失或越界」的判定与统一文案；无问题时返回 null。
 *
 * 存量脏数据（import:v1 的裸 INSERT 可静默写入 NULL 月/日；schedules 的 CHECK 写的是
 * `IS NULL OR (1..12)`，即只放行 NULL、拒掉 0/13 这类越界值）会让裸插值回显
 * 「农历null月null日」——用户看到的是模板漏字，而不是「这条日程坏掉了」。
 * 同时 iterateLunar 的范围判断让它产出零 occurrence（N12 的 B 类死行），文案必须如实说。
 *
 * describeRecurrence（循环规则栏）与 schedule 的 rowToPublic（日历栏）必须调同一个函数：
 * 两处各写一份判定时，只要有人只改其中一处，同一份输出里就会出现一半已修、一半漏字（N15）。
 */
export function lunarMonthDayProblem(
  calendar: "solar" | "lunar",
  lunarMonth: number | null,
  lunarDay: number | null,
): string | null {
  if (calendar !== "lunar") return null;
  const m = lunarMonth ?? 0;
  const d = lunarDay ?? 0;
  if (m < 1 || m > 12 || d < 1 || d > 30) {
    return "农历月/日缺失或越界（不会产生任何提醒，请补齐 lunar_month/lunar_day）";
  }
  return null;
}

/** 供通知/列表展示的循环规则人话描述 */
export function describeRecurrence(
  source: Pick<
    OccurrenceSource,
    "calendar" | "recurrence" | "lunarMonth" | "lunarDay" | "leapPolicy" | "lunarClamp"
  >,
  startDate: string | null,
): string {
  const rec = source.recurrence;
  if (source.calendar === "lunar") {
    // 判定与文案集中在 lunarMonthDayProblem，避免与 rowToPublic 的「日历」栏口径漂移（N15）
    const problem = lunarMonthDayProblem(source.calendar, source.lunarMonth, source.lunarDay);
    if (problem !== null) return problem;
    const m = source.lunarMonth ?? 0;
    const d = source.lunarDay ?? 0;
    const name = `农历${m}月${d}日`;
    // recurrence 为 null 的农历行**不是「一次性」**：农历事件没有年份锚点，
    // iterateLunar 对 recurrence===null 直接 return → 零 occurrence。写「一次：」会让
    // 用户以为它会触发一次（而 v1 侧的一次性语义本身也无法在农历上表达）。
    if (rec === null) return `${name}（无循环规则，不会产生任何提醒）`;
    // 农历月只有 29/30 天：三十日只在大月存在，小月里有两种截然不同的后果 ——
    // lunarClamp=true 夹到月末（lunarToSolar 的 clamp），lunarClamp=false 时
    // lunarToSolar 返回 null、iterateLunar 直接 continue，**整年静默跳过**
    // （实测 2027-2029 连续三年都没有腊月三十）。两种口径都必须写进文案，
    // 否则用户按「每年」等提醒会以为服务坏了或提醒丢了。
    // 二十九日在大小月都存在，两种口径都不会跳过，因此绝不加注记。
    const clamp = source.lunarDay === 30 ? (source.lunarClamp ? CLAMP_NOTE : LUNAR_SKIP_NOTE) : "";
    // 历史脏数据：农历的 interval 不参与推进（引擎每年一次），但不能因此谎称「每年」——
    // 那正是「设了 interval 被静默忽略」的回显。validateScheduleInput 已拒掉新的写入，
    // 这里对存量行显式说明 interval 被忽略，不误导使用者。
    if (rec.interval !== 1) {
      return `每年${name}${clamp}（interval=${rec.interval} 不生效：农历只支持按年循环）`;
    }
    return `每年${name}${clamp}`;
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
    case "monthly": {
      if (n !== 1) return `每 ${n} 个月`; // 不带日号，夹取无从体现
      const day = startDate?.slice(8, 10) ?? "";
      const text = `每月${day}日`;
      return day !== "" && willClamp(ALL_MONTHS, Number(day)) ? `${text}${CLAMP_NOTE}` : text;
    }
    case "yearly": {
      if (n !== 1) return `每 ${n} 年`;
      const month = startDate?.slice(5, 7) ?? "";
      const day = startDate?.slice(8, 10) ?? "";
      const text = `每年${month}月${day}日`;
      return month !== "" && day !== "" && willClamp([Number(month)], Number(day))
        ? `${text}${CLAMP_NOTE}`
        : text;
    }
  }
}
