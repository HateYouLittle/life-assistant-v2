import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { DATE_RE, TIME_RE, instantToLocalDate } from "../../time.js";
import { findUnknownField, unknownFieldMessage } from "../../core/action-tool.js";
import { describeRecurrence, type Recurrence } from "../../core/recurrence.js";
import {
  errorMessage,
  fail,
  okJson,
  registerModule,
  type ToolContext,
} from "../../core/registry.js";
import { getLedger } from "../bookkeeping/service.js";
import {
  registerCompletionHook,
  registerReminderDecorator,
  type ScheduleRow,
} from "../schedule/service.js";
import {
  billBySchedule,
  createBill,
  dueTitle,
  getBill,
  listBills,
  nextDueDate,
  pauseBill,
  payBill,
  recordBillPayment,
  resumeBill,
  updateBill,
  yuanText,
  type BillPatch,
  type BillRow,
  type RecordOutcome,
} from "./service.js";

/** 每个 action 接受的字段（其它字段显式拒绝，口径与 expense/notify 一致） */
const ALLOWED: Record<string, readonly string[]> = {
  add: [
    "name",
    "amount",
    "category",
    "ledger_id",
    "date",
    "freq",
    "interval",
    "time",
    "remind",
    "note",
    "request_id",
  ],
  list: ["status"],
  update: ["id", "name", "amount", "category", "ledger_id", "note"],
  pause: ["id"],
  resume: ["id"],
  pay: ["id", "match", "date"],
};

function rejectUnknown(args: Record<string, unknown>, action: string): string | null {
  const allowed = ALLOWED[action];
  if (allowed === undefined) return null;
  const unknown = findUnknownField(args, allowed);
  return unknown === null ? null : unknownFieldMessage(unknown, action);
}

function amountCents(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
    throw new Error(`金额不合法: ${String(value)}`);
  }
  return Math.round(amount * 100);
}

function repeatText(bill: BillRow): string {
  try {
    return describeRecurrence(
      {
        calendar: "solar",
        recurrence: JSON.parse(bill.recurrence_json) as Recurrence,
        lunarMonth: null,
        lunarDay: null,
        leapPolicy: "follow",
        lunarClamp: true,
      },
      bill.start_date,
    );
  } catch {
    return "（循环规则损坏，需修复）";
  }
}

function billView(db: DatabaseSync, bill: BillRow): Record<string, unknown> {
  const ledger = getLedger(db, bill.ledger_id);
  return {
    id: bill.id,
    名称: bill.name,
    金额: yuanText(bill.amount_cents),
    分类: bill.category,
    账本: ledger?.name ?? bill.ledger_id,
    重复: repeatText(bill),
    提醒时刻: bill.time,
    自动提醒: bill.auto_remind === 1,
    状态: bill.status === "active" ? "启用" : "已停用",
    下次到期: nextDueDate(db, bill),
    ...(bill.note === null ? {} : { 备注: bill.note }),
  };
}

function recordView(outcome: RecordOutcome): Record<string, unknown> {
  return {
    id: outcome.entry.id,
    账本: outcome.ledger.name,
    金额: yuanText(outcome.entry.amount_cents),
    分类: outcome.entry.category,
    日期: outcome.entry.spent_on,
    期次: outcome.period,
    ...(outcome.reused ? { 已存在: true } : {}),
  };
}

/** pay 的目标：id 优先；否则按名称关键词在启用模板里唯一定位 */
function resolveBill(
  db: DatabaseSync,
  profileId: string,
  args: Record<string, unknown>,
): BillRow | string {
  if (typeof args.id === "string") {
    return getBill(db, profileId, args.id) ?? `周期账不存在: ${args.id}`;
  }
  if (typeof args.match !== "string" || args.match.trim() === "") {
    return "pay 需要 id 或 match（名称关键词，如「话费」）";
  }
  const key = args.match.trim().toLowerCase();
  const hits = listBills(db, profileId, "active").filter((b) => b.name.toLowerCase().includes(key));
  if (hits.length === 1) return hits[0] as BillRow;
  if (hits.length === 0) return `没有名称包含「${args.match}」的启用周期账`;
  return `「${args.match}」匹配到多个周期账：${hits.map((b) => `${b.name}（id=${b.id}）`).join("、")}，请传 id`;
}

export function billTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    return billToolInner(args, ctx);
  } catch (e) {
    return fail(errorMessage(e));
  }
}

function billToolInner(args: Record<string, unknown>, ctx: ToolContext) {
  const action = String(args.action);
  const db = ctx.db;
  const rejected = rejectUnknown(args, action);
  if (rejected !== null) return fail(rejected);
  switch (action) {
    case "add": {
      if (typeof args.name !== "string") return fail("add 需要 name（如「话费」）");
      if (args.amount === undefined) return fail("add 需要 amount（元）");
      if (typeof args.category !== "string") return fail("add 需要 category（如「通讯」）");
      if (typeof args.ledger_id !== "string")
        return fail("add 需要 ledger_id（从 ledger list 取）");
      if (typeof args.date !== "string") return fail("add 需要 date：下次到期日 YYYY-MM-DD");
      const recurrence: Recurrence = {
        freq: (args.freq as Recurrence["freq"] | undefined) ?? "monthly",
        interval: (args.interval as number | undefined) ?? 1,
      };
      const { bill, existed } = createBill(
        db,
        ctx.profileId,
        {
          name: args.name,
          amountCents: amountCents(args.amount),
          category: args.category,
          ledgerId: args.ledger_id,
          startDate: args.date,
          recurrence,
          time: (args.time as string | undefined) ?? "09:00",
          autoRemind: args.remind !== false,
          note: (args.note as string | undefined) ?? null,
        },
        typeof args.request_id === "string" ? args.request_id : null,
      );
      return okJson({ 已创建: billView(db, bill), ...(existed ? { 已存在: true } : {}) });
    }
    case "list": {
      const status = (args.status as "active" | "paused" | "all" | undefined) ?? "active";
      const rows = listBills(db, ctx.profileId, status);
      return okJson({ 周期账: rows.map((b) => billView(db, b)), 数量: rows.length });
    }
    case "update": {
      if (typeof args.id !== "string") return fail("update 需要 id");
      const patch: BillPatch = {};
      if (args.name !== undefined) patch.name = String(args.name);
      if (args.amount !== undefined) patch.amountCents = amountCents(args.amount);
      if (args.category !== undefined) patch.category = String(args.category);
      if (args.ledger_id !== undefined) patch.ledgerId = String(args.ledger_id);
      if (args.note !== undefined) patch.note = args.note === null ? null : String(args.note);
      if (Object.keys(patch).length === 0) return fail("没有提供要更新的字段");
      return okJson({ 已更新: billView(db, updateBill(db, ctx.profileId, args.id, patch)) });
    }
    case "pause": {
      if (typeof args.id !== "string") return fail("pause 需要 id");
      const bill = pauseBill(db, ctx.profileId, args.id);
      return okJson({
        已停用: billView(db, bill),
        说明: "不会再产生提醒；历史入账记录保留不动",
      });
    }
    case "resume": {
      if (typeof args.id !== "string") return fail("resume 需要 id");
      return okJson({ 已恢复: billView(db, resumeBill(db, ctx.profileId, args.id)) });
    }
    case "pay": {
      const bill = resolveBill(db, ctx.profileId, args);
      if (typeof bill === "string") return okJson({ 结果: "未找到", 说明: bill });
      const outcome = payBill(db, ctx, bill, typeof args.date === "string" ? args.date : null);
      return okJson({
        结果: outcome.reused ? "已处理" : "已入账",
        ...(outcome.reused
          ? { 说明: `「${bill.name}」${outcome.period} 那期之前已入账，未重复记` }
          : {}),
        周期账: bill.name,
        入账: recordView(outcome),
        已完成提醒: outcome.completedOccurrence !== null,
        下次到期: nextDueDate(db, bill),
      });
    }
    default:
      return fail(`未知 action: ${action}`);
  }
}

/** 到期提醒装饰：标题「该交话费了 ¥50（通讯）」，表格补金额/分类/账本，回复提示改成「交了」 */
function decorate(db: DatabaseSync, schedule: ScheduleRow) {
  const bill = billBySchedule(db, schedule.id);
  if (bill === undefined || bill.profile_id !== schedule.profile_id) return null;
  const ledger = getLedger(db, bill.ledger_id);
  const ledgerName = ledger?.name ?? bill.ledger_id;
  return {
    title: dueTitle(bill),
    rows: [
      ["金额", yuanText(bill.amount_cents)],
      ["分类", bill.category],
      ["账本", ledgerName],
    ],
    hint: `交完直接回复「交了」，会标记完成并按 ${yuanText(bill.amount_cents)}（${bill.category}）记到「${ledgerName}」；要晚点再提醒就回复「推迟半小时」`,
  };
}

registerReminderDecorator(decorate);

/**
 * schedule complete（单次，含 match/recent 与一键「完成」链接）完成的是周期账提醒时，
 * 顺手按模板入账；期次 = 该次事件的本地日期，与 bill pay 同一幂等键，两条路径谁先谁后都只入一笔。
 * 入账失败不回滚完成（完成已生效），回执里如实给出失败原因与补救调用。
 */
registerCompletionHook(({ db, ctx, schedule, eventAt }) => {
  const bill = billBySchedule(db, schedule.id);
  if (bill === undefined || bill.profile_id !== schedule.profile_id) return null;
  const period = instantToLocalDate(eventAt);
  try {
    return { 周期账入账: recordView(recordBillPayment(db, ctx, bill, period)) };
  } catch (e) {
    return {
      周期账入账失败: `${errorMessage(e)}；修好后用 bill {action:"pay", id:"${bill.id}", date:"${period}"} 补记`,
    };
  }
});

registerModule({
  name: "bills",
  tools: [
    {
      name: "bill",
      description:
        "周期账 / 订阅提醒：固定周期支出模板（话费、会员、物业费……）。到期按模板推「该交话费了 ¥50（通讯）」提醒（复用 schedule 的提醒链路与一键链接）。" +
        "action=add 建模板（name/amount/category/ledger_id/date=下次到期日，freq 默认 monthly；可选 request_id 幂等）；list 查看；update 改名称/金额/分类/账本/备注；" +
        "pause 停用（不再提醒，历史入账不动）；resume 恢复；" +
        "pay 一步完成「交了」：标记该期提醒完成并按模板金额/分类/账本入账，同一期重复调用只入一笔（返回 已处理）。" +
        "用户回「交了」时也可直接用 schedule complete {match|recent}，完成周期账提醒会自动入账。",
      inputSchema: {
        action: z.enum(["add", "list", "update", "pause", "resume", "pay"]),
        id: z.string().optional().describe("update/pause/resume/pay：模板 id"),
        name: z.string().min(1).max(40).optional().describe("名称，如「话费」「视频会员」"),
        amount: z.number().positive().max(1_000_000).optional().describe("每期金额（元）"),
        category: z.string().min(1).max(20).optional().describe("入账分类，如「通讯」"),
        ledger_id: z.string().optional().describe("入账账本 id（ledger list 取）"),
        date: z
          .string()
          .regex(DATE_RE)
          .optional()
          .describe(
            "add：下次到期日（也是每期的日号锚点；31 日的月付模板在小月按当月最后一天到期）；pay：指定入账的那一期，缺省自动取已到期未交的最早一期",
          ),
        freq: z.enum(["weekly", "monthly", "yearly"]).optional().describe("周期，默认 monthly"),
        interval: z
          .number()
          .int()
          .min(1)
          .max(36)
          .optional()
          .describe("间隔，默认 1（如季付=monthly+3）"),
        time: z.string().regex(TIME_RE).optional().describe("提醒时刻 HH:MM，默认 09:00"),
        remind: z.boolean().optional().describe("是否自动生成到期提醒，默认 true"),
        note: z.string().max(200).nullable().optional(),
        status: z.enum(["active", "paused", "all"]).optional().describe("list 过滤，默认 active"),
        match: z.string().min(1).max(40).optional().describe("pay：名称关键词（不传 id 时）"),
        request_id: z.string().min(1).max(128).optional().describe("add 的幂等键"),
      },
      handler: billTool,
    },
  ],
});
