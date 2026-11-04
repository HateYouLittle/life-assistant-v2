import type { DatabaseSync } from "node:sqlite";
import { DATE_RE, TIME_RE, instantToLocalDate, nowIso, todayIso } from "../../time.js";
import type { Recurrence } from "../../core/recurrence.js";
import { newId } from "../../core/settings.js";
import { errorMessage, type ToolContext } from "../../core/registry.js";
import {
  addExpenseChecked,
  centsToYuan,
  getVisibleLedger,
  normalizeCategory,
  writableLedgers,
  type ExpenseRow,
  type LedgerRow,
} from "../bookkeeping/service.js";
import {
  completeSchedule,
  createSchedule,
  deleteSchedule,
  getSchedule,
  materializeSchedule,
  pendingOccurrences,
  updateSchedule,
  type ScheduleInput,
  type ScheduleRow,
} from "../schedule/service.js";

/**
 * 周期账模板（固定周期支出：话费、订阅、会员……）。
 *
 * 不另起调度器：每个开启提醒的模板挂一条 schedules 循环待办（schedule_id），到期提醒、
 * 通道、notify prefs、一键操作链接全部沿用 schedule.reminder 的既有链路；本模块只负责
 * ① 给这条提醒换上「该交话费了 ¥50（通讯）」的标题与回复提示（见 index.ts 的装饰器），
 * ② 用户说「交了」时按模板入账，幂等键 = 模板 id + 期次日期（同一期只入一笔）。
 */

export interface BillRow {
  id: string;
  profile_id: string;
  name: string;
  amount_cents: number;
  category: string;
  ledger_id: string;
  start_date: string;
  recurrence_json: string;
  time: string;
  auto_remind: number;
  schedule_id: string | null;
  note: string | null;
  status: "active" | "paused";
  created_at: string;
  updated_at: string;
  client_token: string | null;
}

export interface BillInput {
  name: string;
  amountCents: number;
  category: string;
  ledgerId: string;
  /** 下次到期日（本地日历日），也是循环的相位锚点：每月 31 日的模板在小月夹到月末 */
  startDate: string;
  recurrence: Recurrence;
  time: string;
  autoRemind: boolean;
  note: string | null;
}

export interface BillPatch {
  name?: string;
  amountCents?: number;
  category?: string;
  ledgerId?: string;
  note?: string | null;
}

const NAME_MAX = 40;
const CATEGORY_MAX = 20;
const NOTE_MAX = 200;
const CLIENT_TOKEN_MAX = 128;

/** 金额展示：整元不带 .00（「¥50」），否则两位小数 */
export function yuanText(cents: number): string {
  return cents % 100 === 0 ? `¥${cents / 100}` : `¥${centsToYuan(cents)}`;
}

/** 「话费」→「该交话费了」；名称本身以「交」开头时不再重复（「交物业费」→「该交物业费了」） */
export function dueTitle(bill: Pick<BillRow, "name" | "amount_cents" | "category">): string {
  const subject = bill.name.startsWith("交") ? bill.name.slice(1) : bill.name;
  return `该交${subject}了 ${yuanText(bill.amount_cents)}（${bill.category}）`;
}

/** 关联日程的标题：带上名称，schedule complete {match:"话费"} 才能命中 */
function scheduleTitleOf(name: string): string {
  return name.startsWith("交") ? name : `交${name}`;
}

/**
 * 期次的入账幂等键：同一模板同一期（以到期日为准）只能入账一次。
 * 直接落 expenses.client_token，复用 expense add 的分范围唯一索引与「撞键查回」机制。
 */
export function billRequestId(billId: string, period: string): string {
  return `bill:${billId}:${period}`;
}

function assertName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > NAME_MAX) throw new Error(`名称需为 1-${NAME_MAX} 个字符`);
  return trimmed;
}

function assertAmount(cents: number): void {
  if (!Number.isInteger(cents) || cents <= 0 || cents > 100_000_000) {
    throw new Error(`金额不合法: ${String(cents / 100)}`);
  }
}

function assertCategory(db: DatabaseSync, profileId: string, input: string): string {
  const value = normalizeCategory(db, profileId, input);
  if (value === "") throw new Error("周期账必须给 category（如「通讯」），入账时按它记");
  if (value.length > CATEGORY_MAX) throw new Error(`分类过长（≤${CATEGORY_MAX} 字符）`);
  return value;
}

function assertNote(note: string | null): string | null {
  if (note === null || note.trim() === "") return null;
  if (note.trim().length > NOTE_MAX) throw new Error(`备注过长（≤${NOTE_MAX} 字符）`);
  return note.trim();
}

/** 模板账本必须是当前 Profile 可写的活动账本（家庭 + 自己的个人账本，未归档） */
function assertWritableLedger(db: DatabaseSync, profileId: string, ledgerId: string): LedgerRow {
  const ledger = writableLedgers(db, profileId).find((row) => row.id === ledgerId);
  if (ledger === undefined) throw new Error(`账本不存在或不可写: ${ledgerId}`);
  return ledger;
}

export function getBill(db: DatabaseSync, profileId: string, id: string): BillRow | undefined {
  return db
    .prepare("SELECT * FROM recurring_bills WHERE id = ? AND profile_id = ?")
    .get(id, profileId) as BillRow | undefined;
}

export function billBySchedule(db: DatabaseSync, scheduleId: string): BillRow | undefined {
  return db
    .prepare("SELECT * FROM recurring_bills WHERE schedule_id = ? AND status = 'active'")
    .get(scheduleId) as BillRow | undefined;
}

export function listBills(
  db: DatabaseSync,
  profileId: string,
  status: "active" | "paused" | "all" = "active",
): BillRow[] {
  return (status === "all"
    ? db
        .prepare("SELECT * FROM recurring_bills WHERE profile_id = ? ORDER BY created_at")
        .all(profileId)
    : db
        .prepare(
          "SELECT * FROM recurring_bills WHERE profile_id = ? AND status = ? ORDER BY created_at",
        )
        .all(profileId, status)) as unknown as BillRow[];
}

function getBillByToken(db: DatabaseSync, profileId: string, token: string): BillRow | undefined {
  return db
    .prepare("SELECT * FROM recurring_bills WHERE profile_id = ? AND client_token = ?")
    .get(profileId, token) as BillRow | undefined;
}

function scheduleInputOf(bill: {
  name: string;
  startDate: string;
  recurrence: Recurrence;
  time: string;
}): ScheduleInput {
  return {
    title: scheduleTitleOf(bill.name),
    note: null,
    kind: "todo",
    calendar: "solar",
    startDate: bill.startDate,
    lunarMonth: null,
    lunarDay: null,
    leapPolicy: "follow",
    lunarClamp: true,
    time: bill.time,
    allDay: false,
    recurrence: bill.recurrence,
    remindOffsets: [0],
    resendMinutes: 0,
    escalation: null,
    workdayFilter: "any",
  };
}

export interface CreateBillOutcome {
  bill: BillRow;
  existed: boolean;
}

/**
 * 新建模板。顺序：先校验 → 建关联日程（日程自己的事务，含首次物化）→ 单条 INSERT 模板。
 * 日程层的 withTransaction 不支持嵌套，所以没法把两步包进同一个事务；第二步失败时把刚建的
 * 日程取消掉（补偿），不留「有提醒、没模板」的孤儿。幂等键撞车同样走补偿后查回原模板。
 */
export function createBill(
  db: DatabaseSync,
  profileId: string,
  input: BillInput,
  clientToken: string | null = null,
): CreateBillOutcome {
  if (clientToken !== null) {
    if (clientToken.trim() === "" || clientToken.length > CLIENT_TOKEN_MAX) {
      throw new Error(`request_id 不合法（需为 1-${CLIENT_TOKEN_MAX} 个非空白字符）`);
    }
    const existing = getBillByToken(db, profileId, clientToken);
    if (existing !== undefined) return { bill: existing, existed: true };
  }
  const name = assertName(input.name);
  assertAmount(input.amountCents);
  const category = assertCategory(db, profileId, input.category);
  assertWritableLedger(db, profileId, input.ledgerId);
  const note = assertNote(input.note);
  if (!DATE_RE.test(input.startDate)) throw new Error(`日期不合法: ${input.startDate}`);
  if (!TIME_RE.test(input.time)) throw new Error(`时刻不合法: ${input.time}`);

  const schedule = input.autoRemind
    ? createSchedule(db, profileId, scheduleInputOf({ ...input, name }))
    : null;
  const id = newId();
  const ts = nowIso();
  try {
    db.prepare(
      `INSERT INTO recurring_bills (id, profile_id, name, amount_cents, category, ledger_id, start_date,
         recurrence_json, time, auto_remind, schedule_id, note, status, created_at, updated_at, client_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).run(
      id,
      profileId,
      name,
      input.amountCents,
      category,
      input.ledgerId,
      input.startDate,
      JSON.stringify(input.recurrence),
      input.time,
      input.autoRemind ? 1 : 0,
      schedule?.id ?? null,
      note,
      ts,
      ts,
      clientToken,
    );
  } catch (e) {
    if (schedule !== null) deleteSchedule(db, profileId, schedule.id);
    if (clientToken !== null && errorMessage(e).includes("client_token")) {
      const existing = getBillByToken(db, profileId, clientToken);
      if (existing !== undefined) return { bill: existing, existed: true };
    }
    throw e;
  }
  return { bill: getBill(db, profileId, id) as BillRow, existed: false };
}

/** 改金额/分类/账本/名称/备注；周期与到期日不在此改（停用后重建，避免期次幂等键漂移） */
export function updateBill(
  db: DatabaseSync,
  profileId: string,
  id: string,
  patch: BillPatch,
): BillRow {
  const bill = getBill(db, profileId, id);
  if (bill === undefined) throw new Error(`周期账不存在: ${id}`);
  const name = patch.name === undefined ? bill.name : assertName(patch.name);
  if (patch.amountCents !== undefined) assertAmount(patch.amountCents);
  const category =
    patch.category === undefined ? bill.category : assertCategory(db, profileId, patch.category);
  if (patch.ledgerId !== undefined) assertWritableLedger(db, profileId, patch.ledgerId);
  const note = patch.note === undefined ? bill.note : assertNote(patch.note);
  db.prepare(
    `UPDATE recurring_bills SET name = ?, amount_cents = ?, category = ?, ledger_id = ?, note = ?,
       updated_at = ? WHERE id = ?`,
  ).run(
    name,
    patch.amountCents ?? bill.amount_cents,
    category,
    patch.ledgerId ?? bill.ledger_id,
    note,
    nowIso(),
    id,
  );
  if (name !== bill.name && bill.schedule_id !== null) {
    const schedule = getSchedule(db, profileId, bill.schedule_id);
    if (schedule !== undefined && schedule.status === "active") {
      updateSchedule(db, profileId, schedule.id, { title: scheduleTitleOf(name) });
    }
  }
  return getBill(db, profileId, id) as BillRow;
}

/**
 * 停用：模板置 paused，关联日程取消（deleteSchedule：status=cancelled，未发的 occurrence 清掉），
 * 之后不再产生提醒。历史 expenses 一行不动。已停用再停用幂等。
 */
export function pauseBill(db: DatabaseSync, profileId: string, id: string): BillRow {
  const bill = getBill(db, profileId, id);
  if (bill === undefined) throw new Error(`周期账不存在: ${id}`);
  if (bill.status === "paused") return bill;
  if (bill.schedule_id !== null) {
    const schedule = getSchedule(db, profileId, bill.schedule_id);
    if (schedule !== undefined && schedule.status === "active") {
      deleteSchedule(db, profileId, schedule.id);
    }
  }
  db.prepare("UPDATE recurring_bills SET status = 'paused', updated_at = ? WHERE id = ?").run(
    nowIso(),
    id,
  );
  return getBill(db, profileId, id) as BillRow;
}

/** 恢复：按原到期日相位与周期重建一条关联日程（物化从今天起，过去的期次不补提醒） */
export function resumeBill(db: DatabaseSync, profileId: string, id: string): BillRow {
  const bill = getBill(db, profileId, id);
  if (bill === undefined) throw new Error(`周期账不存在: ${id}`);
  if (bill.status === "active") return bill;
  let scheduleId: string | null = null;
  if (bill.auto_remind === 1) {
    const schedule = createSchedule(
      db,
      profileId,
      scheduleInputOf({
        name: bill.name,
        startDate: bill.start_date,
        recurrence: JSON.parse(bill.recurrence_json) as Recurrence,
        time: bill.time,
      }),
    );
    scheduleId = schedule.id;
  }
  db.prepare(
    "UPDATE recurring_bills SET status = 'active', schedule_id = ?, updated_at = ? WHERE id = ?",
  ).run(scheduleId, nowIso(), id);
  return getBill(db, profileId, id) as BillRow;
}

/** 下次到期（本地日期）：关联日程最早一个未完成发生；无提醒的模板返回 null */
export function nextDueDate(db: DatabaseSync, bill: BillRow): string | null {
  if (bill.schedule_id === null || bill.status !== "active") return null;
  const first = pendingOccurrences(db, bill.schedule_id, 1)[0];
  return first === undefined ? null : instantToLocalDate(first.event_at);
}

export interface RecordOutcome {
  entry: ExpenseRow;
  reused: boolean;
  ledger: LedgerRow;
  period: string;
}

/**
 * 按模板为某一期入账（幂等）：request_id = bill:<id>:<期次日期>，spent_on = 期次日期。
 *
 * spent_on 取期次而不是「今天」：迟交（11-30 那期 12-01 才交）也记在 11 月，保证每期
 * 落在自己的月份、月度统计不出现「一个月两笔话费」；期次日期本身就是幂等键的一部分。
 * 入账不发推送通知（与 expense add 同口径）。
 */
export function recordBillPayment(
  db: DatabaseSync,
  _ctx: ToolContext,
  bill: BillRow,
  period: string,
): RecordOutcome {
  const ledger = getVisibleLedger(db, bill.ledger_id, bill.profile_id);
  if (ledger === undefined)
    throw new Error("模板账本已不可见（可能已转给他人），请 bill update 改账本");
  const result = addExpenseChecked(db, bill.profile_id, {
    ledgerId: ledger.id,
    amountCents: bill.amount_cents,
    category: bill.category,
    note: `周期账：${bill.name}（${period} 期）`,
    spentOn: period,
    clientToken: billRequestId(bill.id, period),
  });
  return { entry: result.entry, reused: result.reused, ledger, period };
}

export interface PayOutcome extends RecordOutcome {
  /** 本次是否把一条未完成的提醒标成了 done（false = 无提醒 / 之前已完成） */
  completedOccurrence: string | null;
  schedule: ScheduleRow | null;
}

/**
 * 「交了」的单次调用：定位期次 → 完成该期提醒（若还开着）→ 按模板入账（幂等）。
 *
 * 期次选择（未显式给 date 时）：
 * 1. 关联日程里**事件日 ≤ 今天**的最早未完成发生（最常见：提醒已到、用户回「交了」）；
 * 2. 没有则取下一个未完成发生（提前交）；
 * 3. 都没有（已完成过 / 无提醒模板）则按今天。
 * 显式 date 时期次 = date，并完成该日那次未完成的提醒（若有）。
 */
export function payBill(
  db: DatabaseSync,
  ctx: ToolContext,
  bill: BillRow,
  date: string | null,
): PayOutcome {
  if (bill.status !== "active") throw new Error(`周期账「${bill.name}」已停用，不能入账`);
  const today = todayIso();
  const schedule =
    bill.schedule_id === null ? null : (getSchedule(db, bill.profile_id, bill.schedule_id) ?? null);
  const open =
    schedule === null || schedule.status !== "active"
      ? []
      : pendingOccurrences(db, schedule.id, 50).map((o) => ({
          key: o.occurrence_key,
          date: instantToLocalDate(o.event_at),
        }));
  let target: { key: string; date: string } | undefined;
  let period: string;
  if (date !== null) {
    period = date;
    target = open.find((o) => o.date === date);
  } else {
    target = open.find((o) => o.date <= today) ?? open[0];
    period = target?.date ?? today;
  }
  // 先入账再完成：入账失败（账本被归档/转走）时提醒保持未完成，用户修好后还能再说一次「交了」
  const recorded = recordBillPayment(db, ctx, bill, period);
  let completedOccurrence: string | null = null;
  if (target !== undefined && schedule !== null) {
    const after = completeSchedule(db, bill.profile_id, schedule.id, target.key);
    completedOccurrence = target.key;
    // 补物化下一期：回执里的「下次到期」要立刻可见，不必等下一分钟的 tick
    materializeSchedule(db, after);
  }
  return {
    ...recorded,
    completedOccurrence,
    schedule: schedule === null ? null : (getSchedule(db, bill.profile_id, schedule.id) ?? null),
  };
}
