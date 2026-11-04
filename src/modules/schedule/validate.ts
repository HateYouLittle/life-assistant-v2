import { randomBytes } from "node:crypto";
import { DateTime } from "luxon";
import { todayIso, TZ } from "../../time.js";
import {
  collapseLunarInterval,
  type OccurrenceSource,
  type Recurrence,
} from "../../core/recurrence.js";

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
  /** 逾期升级阶梯（分钟偏移，升序）；null/缺省 = 不启用（此时 resend_minutes 生效） */
  escalation?: number[] | null;
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
  escalation_json: string | null;
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

/** 强提醒（到点重发一次）行的 occurrence_key 后缀 */
export const RESEND_SUFFIX = ":resend";
/** 逾期升级行的 occurrence_key 后缀：`<eventKey>#esc:<N>`（N 从 1 起，第 0 步是截止时刻的 #0） */
export const ESCALATION_SUFFIX = "#esc:";
export const MAX_ESCALATION_STEPS = 5;
export const MAX_ESCALATION_MINUTES = 43200;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
/** add 幂等键（client_token）长度上限：与工具 schema 对齐，服务层再兜一道 */
const REQUEST_ID_MAX = 128;
/** snooze 上限：7 天。再长就不该用「推迟一次」，而应改整个日程 */
export const SNOOZE_MAX_MINUTES = 10080;

export function newShortId(): string {
  return randomBytes(4).toString("hex");
}

export function parseRecurrence(json: string | null): Recurrence | null {
  if (json === null) return null;
  let rec: Recurrence;
  try {
    rec = JSON.parse(json) as Recurrence;
  } catch (e) {
    // 裸 JSON.parse 的报错看不出是哪条数据坏了；这里给出可定位的信息，
    // 由调用方逐行隔离（tickSchedules / rowToPublic），不让一条脏行带走整批。
    throw new Error(`循环规则不是合法 JSON（数据损坏，需修复该行）: ${json.slice(0, 80)}`, {
      cause: e,
    });
  }
  // 缺省 interval 必须兜底为 1，否则 recurrence 引擎会在推进日期时死循环
  const interval = typeof rec.interval === "number" && rec.interval >= 1 ? rec.interval : 1;
  return { ...rec, interval };
}

/**
 * 提醒偏移的安全解析：非法/空/非数组一律退化为 `[0]`（= 事件时刻提醒一次）。
 * 与 recurrence_json 不同，偏移坏掉不该让日程从列表里消失，兜底比抛错更有用。
 */
export function parseOffsets(json: string | null): number[] {
  if (json === null || json === "") return [0];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [0];
  }
  if (!Array.isArray(parsed)) return [0];
  const offsets = parsed.filter((v): v is number => typeof v === "number" && Number.isInteger(v));
  return offsets.length > 0 ? offsets : [0];
}

/**
 * 校验逾期升级阶梯：1-5 个非负整数分钟、首元素固定为 0（截止时刻本身）、严格升序（不重复）、
 * 最大值 ≤ 43200（30 天）。工具层（buildPartial）与服务层（validateScheduleInput）都走这里，规则唯一。
 */
export function validateEscalation(value: number[]): void {
  if (value.length < 1 || value.length > MAX_ESCALATION_STEPS) {
    throw new Error(`escalation 需要 1-${MAX_ESCALATION_STEPS} 个分钟偏移（升序）`);
  }
  if (value[0] !== 0) {
    throw new Error(
      "escalation 首元素必须为 0（0 表示截止时刻本身；后续元素是逾期后的分钟偏移，如 [0,60,360,1440]）",
    );
  }
  for (const minutes of value) {
    if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_ESCALATION_MINUTES) {
      throw new Error(
        `escalation 偏移不合法: ${String(minutes)}（需为 0-${MAX_ESCALATION_MINUTES} 的整数分钟）`,
      );
    }
  }
  for (let i = 1; i < value.length; i++) {
    if ((value[i] as number) <= (value[i - 1] as number)) {
      throw new Error("escalation 必须严格升序且不允许重复值");
    }
  }
}

/** 读库里的阶梯；NULL/空/非法一律当作「未启用」，避免脏数据把调度带偏 */
export function parseEscalation(json: string | null): number[] | null {
  if (json === null || json === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return null;
  if (!parsed.every((v) => typeof v === "number" && Number.isInteger(v) && v >= 0)) return null;
  const steps = parsed as number[];
  // 与写入路径（validateEscalation）同口径：必须首元素为 0 且严格升序。
  // 脏库里乱序/非零首元素的阶梯会让「第 N 步」的语义错位，直接当作未启用。
  if (steps[0] !== 0) return null;
  for (let i = 1; i < steps.length; i++) {
    if ((steps[i] as number) <= (steps[i - 1] as number)) return null;
  }
  return steps;
}

/** 从 occurrence_key 解析升级步骤号；非升级行返回 null */
export function escalationStepOf(occurrenceKey: string): number | null {
  const idx = occurrenceKey.lastIndexOf(ESCALATION_SUFFIX);
  if (idx < 0) return null;
  const raw = occurrenceKey.slice(idx + ESCALATION_SUFFIX.length);
  if (!/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/**
 * 反解任意提醒行 key 所属的「事件前缀」`<本地日期>T<时刻>`：
 * 依次剥掉派生后缀（`#esc:N` / `:resend`）与偏移序号（`#N`）。
 * 这样 `…T09:00#0`、`…T09:00#1`、`…T09:00#0#esc:1`、`…T09:00#1:resend`
 * 都归到同一个事件。形态不符（脏 key）返回 null，由调用方退化处理。
 */
export function eventPrefixOf(occurrenceKey: string): string | null {
  let key = occurrenceKey;
  if (escalationStepOf(key) !== null) {
    key = key.slice(0, key.lastIndexOf(ESCALATION_SUFFIX));
  } else if (key.endsWith(RESEND_SUFFIX)) {
    key = key.slice(0, -RESEND_SUFFIX.length);
  }
  const matched = /^(.*)#\d+$/.exec(key);
  return matched === null ? null : (matched[1] as string);
}

/**
 * 逾期时长文案：区分分 / 小时 / 天，且不输出「0 天 0 小时」这类空单位。
 * 例：3 分 / 1 小时 3 分 / 1 天 2 小时。
 */
export function formatElapsed(fromIso: string, at: DateTime): string {
  const total = Math.max(0, Math.round(at.diff(DateTime.fromISO(fromIso), "minutes").minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days > 0) parts.push(`${days} 天`);
  if (hours > 0) parts.push(`${hours} 小时`);
  if (minutes > 0) parts.push(`${minutes} 分`);
  return parts.length > 0 ? parts.join(" ") : "不到 1 分";
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

/**
 * update 继承既有 recurrence_json 时的**校验用**归一。与 N5（interval）同构，
 * 这里再收窄 freq 与「农历 recurrence 为 null」两种存量畸形：
 *
 * - **freq ≠ yearly**：农历引擎对 once/daily/weekly/monthly/yearly 一视同仁按农历年触发
 *   （core/recurrence.ts 的 iterate 对 calendar==="lunar" 直接 yield* iterateLunar，freq
 *   被完全丢弃）。这类行多来自已移除的 v1 导入器写入的旧数据。校验若按原值拒，用户会被**完全锁死**：
 *   连「只改标题」都不行，唯一出路是显式传 `recurrence: {freq:"yearly", interval:1}` ——
 *   而对原本 v1 `once` 的一行，那等于把一次性事件改成每年重复。存量行只能改标题/删除才合理。
 * - **recurrence 为 null**：v1 的 `once` / `{}` / 缺字段经 v1 导入器落库后是零 occurrence
 *   的死行（iterateLunar 首行 `if recurrence===null return`），同样不该把用户锁死。
 *
 * - **interval ≠ 1**（N5）：农历引擎只做 lunarYear++，与 interval=1 完全等价。
 *
 * 三条归一都**只喂 validateScheduleInput，绝不落库**：patch 显式传了 recurrence 的走正常
 * 校验（非法即报错）。落库始终用 parseRecurrence(row.recurrence_json) 的原值，否则「只改标题」
 * 会把用户的 interval/freq 静默改掉并提交，describeRecurrence 专门为存量脏数据写的
 * 「interval=N 不生效」提示也就此失去证据（提示只在纯读路径还成立）。
 * **显式传 recurrence 的 patch 不走这里**，仍按显式值严格校验（传 yearly 才放行）。
 */
export function normalizeInheritedRecurrence(
  calendar: "solar" | "lunar",
  recurrence: Recurrence | null,
): Recurrence | null {
  const collapsed = collapseLunarInterval(calendar, recurrence);
  if (calendar !== "lunar") return collapsed;
  // 与引擎等价：农历下不管原 freq 是什么，实际都按农历年触发，所以校验看到 {yearly,1}
  const freqNormalized =
    collapsed === null || collapsed.freq === "yearly"
      ? collapsed
      : { ...collapsed, freq: "yearly" as const, interval: 1 };
  // recurrence=null 的农历行是死行（不是「一次性」）：给引擎等价的 yearly 让无关 patch 通过
  return freqNormalized ?? { freq: "yearly", interval: 1 };
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
    // interval 在农历路径上不参与推进（iterateLunar 只做 lunarYear++），引擎每年触发一次。
    // 曾照单全收 interval 又在回显里写「每年」，于是设 2/3 与设 1 完全等价且无任何提示 ——
    // 与「农历只支持按年循环」的既有口径一致，这里直接拒掉，不改引擎。
    if (input.recurrence.interval !== 1) {
      throw new Error(
        `农历日程只支持按年循环（recurrence.interval 必须为 1，收到 ${String(input.recurrence.interval)}；农历循环不按 interval 跳年）`,
      );
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
  if (input.escalation !== null && input.escalation !== undefined) {
    if (input.kind !== "todo") throw new Error('escalation（截止型日程）只支持 kind="todo"');
    validateEscalation(input.escalation);
  }
}

/**
 * 一次性（recurrence 为空）公历日程的「过期」判定。
 *
 * 根因：引擎对一次性日程只在 `start > afterDay` 时产出候选日期（core/recurrence.ts 的
 * iterate：`if (rec === null) { if (start > afterDay) yield start; return; }`），而
 * materializeSchedule 的游标起点是 `now().minus({ days: 1 }).startOf("day")`。
 * start_date ≤ 昨天时，起点与之后的所有物化都严格晚于它 → 永远产不出日期 → 0 occurrence、
 * next_run_at=null、日程永久停在 active、永不提醒，而创建/更新却报成功 —— 纯静默失败。
 *
 * 判定集中在这里（create 与 update 共用），避免两处各写一份后口径漂移。
 * 返回 null 表示不适用（非公历 / 有循环规则 / 缺日期：缺日期已由 validateScheduleInput 拒掉）。
 */
export function expiredOneOff(input: {
  calendar: "solar" | "lunar";
  recurrence: Recurrence | null;
  startDate?: string | null;
}): { startDate: string; today: string } | null {
  if (input.calendar !== "solar") return null;
  if (input.recurrence !== null) return null;
  const startDate = input.startDate ?? null;
  if (startDate === null) return null;
  const today = todayIso();
  return startDate < today ? { startDate, today } : null;
}

/** 一次性日程过期的可操作报错文案：必须说清「不会触发」以及怎么改，不能只说「日期不合法」 */
export function expiredOneOffError(expired: { startDate: string; today: string }): Error {
  return new Error(
    `一次性日程的开始日期 ${expired.startDate} 已过期（早于今天 ${expired.today}）：该日期不会再产生任何提醒，` +
      `日程会一直停在 active 且下次提醒为空。请把日期改为今天或之后，或改为循环日程（recurrence）后重试。`,
  );
}

/** 提醒偏移的项数上限（与 MCP schema 一致） */
export const MAX_REMIND_OFFSETS = 5;
/** 单个提醒偏移的绝对值上限（分钟，30 天；与 MCP schema 一致） */
export const MAX_REMIND_OFFSET_MINUTES = 43200;

/**
 * 提醒偏移的写入边界校验。
 *
 * MCP 入口由 zod schema 校验（1-5 项、整数、±43200），但服务层可能被非 MCP 调用方
 * 直接调用，绕不过这一层：不在这里收口，就能写入
 * `[999999]` 这类超出契约的值（提醒时刻算到 2 年后）或空数组（物化出零提醒的死日程）。
 *
 * 只校验**本次写入的值**：update 未显式传 `remindOffsets` 时沿用库里的历史值，
 * 老数据（如导入的长数组/越界值）不能被「只改标题」这类无关 patch 卡死 —— 与
 * `normalizeInheritedRecurrence` 对存量脏数据的宽容口径一致。
 */
export function validateRemindOffsets(offsets: number[]): void {
  // 直接调用服务层的入口可能传 null / 非数组（MCP 有 zod；update 的 null 已在调用方
  // 按「未提供」处理）。先给中文报错，不要让 `.length` 抛内部 TypeError。
  if (!Array.isArray(offsets)) {
    throw new Error("remind_offsets 需要是分钟偏移数组（例如 [0] 或 [-30, 0]）");
  }
  if (offsets.length < 1 || offsets.length > MAX_REMIND_OFFSETS) {
    throw new Error(`remind_offsets 需要 1-${MAX_REMIND_OFFSETS} 项`);
  }
  for (const minutes of offsets) {
    if (
      !Number.isInteger(minutes) ||
      minutes < -MAX_REMIND_OFFSET_MINUTES ||
      minutes > MAX_REMIND_OFFSET_MINUTES
    ) {
      throw new Error(
        `remind_offsets 不合法: ${String(minutes)}（需为 -${MAX_REMIND_OFFSET_MINUTES} 到 ${MAX_REMIND_OFFSET_MINUTES} 的整数分钟）`,
      );
    }
  }
}

/** 校验 add 幂等键：1-128 字符（工具 schema 之外的第二道，直接调服务层也拦得住） */
export function validateRequestId(value: string): string {
  if (value.length < 1 || value.length > REQUEST_ID_MAX) {
    throw new Error(`request_id 不合法：需 1-${REQUEST_ID_MAX} 个字符`);
  }
  return value;
}
