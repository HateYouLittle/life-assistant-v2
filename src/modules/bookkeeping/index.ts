import { z } from "zod";
import { DATE_RE, todayIso } from "../../time.js";
import { fail, okJson, registerModule, runtime, type ToolContext } from "../../core/registry.js";
import {
  addExpense,
  centsToYuan,
  createLedger,
  entryReceiptBlocks,
  getLedger,
  listExpenses,
  listLedgers,
  monthRange,
  previousMonth,
  pushMonthlyReports,
  renameLedger,
  setLedgerArchived,
  summarizeExpenses,
} from "./service.js";

export function bookkeepingLedgerTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    const action = args.action as string;
    const db = ctx.db;
    if (action === "create") {
      const name = args.name as string | undefined;
      if (name === undefined) return fail("create 需要 name");
      const row = createLedger(db, name);
      return okJson({ 已创建: row });
    }
    if (action === "list") {
      const includeArchived = args.include_archived === true;
      const rows = listLedgers(db, includeArchived);
      return okJson({
        账本: rows.map((r) => ({ id: r.id, 名称: r.name, 归档: r.archived_at !== null })),
        说明: "账本为所有 Profile 共享，均可记账",
      });
    }
    if (action === "rename") {
      const id = args.id as string | undefined;
      const name = args.name as string | undefined;
      if (id === undefined || name === undefined) return fail("rename 需要 id 和 name");
      const row = renameLedger(db, id, name);
      return okJson({ 已重命名: row });
    }
    if (action === "archive") {
      const id = args.id as string | undefined;
      if (id === undefined) return fail("archive 需要 id");
      const unarchive = args.unarchive === true;
      const row = setLedgerArchived(db, id, !unarchive);
      return okJson({ 结果: row });
    }
    return fail(`未知 action: ${action}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

export function bookkeepingExpenseTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    const action = args.action as string;
    const db = ctx.db;
    if (action === "add") {
      const ledgerId = args.ledger_id as string | undefined;
      const amount = args.amount as number | undefined;
      if (ledgerId === undefined || amount === undefined) {
        return fail('add 需要 ledger_id（先调用 ledger {action:"list"} 取账本 id）和 amount（元）');
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) return fail(`金额不合法: ${String(amount)}`);
      const cents = Math.round(amount * 100);
      const entry = addExpense(db, ctx.profileId, {
        ledgerId,
        amountCents: cents,
        category: args.category as string | undefined,
        note: args.note as string | undefined,
        spentOn: args.date as string | undefined,
      });
      const ledger = getLedger(db, entry.ledger_id);
      if (ledger === undefined) return fail(`账本不存在: ${entry.ledger_id}`);
      void ctx.services
        .publishGlobal({
          kind: "bookkeeping.entry",
          title: `记账：¥${centsToYuan(entry.amount_cents)}（${ledger.name}）`,
          blocks: entryReceiptBlocks(ledger, entry),
          dedupeKey: `entry:${entry.id}`,
        })
        .catch(() => {});
      return okJson({
        已记账: {
          id: entry.id,
          账本: ledger.name,
          金额: `¥${centsToYuan(entry.amount_cents)}`,
          分类: entry.category,
          日期: entry.spent_on,
          记账人: entry.created_by_profile,
        },
      });
    }
    if (action === "list") {
      const ledgerId = args.ledger_id as string | undefined;
      if (ledgerId === undefined) {
        return fail('list 需要 ledger_id（先调用 ledger {action:"list"} 取账本 id）');
      }
      const range: { from?: string; to?: string } =
        args.month === undefined ? {} : monthRange(args.month as string);
      const rows = listExpenses(db, ledgerId, {
        from: (args.from as string | undefined) ?? range.from,
        to: (args.to as string | undefined) ?? range.to,
        by: args.by as string | undefined,
        limit: args.limit as number | undefined,
      });
      return okJson({
        账目: rows.map((r) => ({
          id: r.id,
          金额: `¥${centsToYuan(r.amount_cents)}`,
          分类: r.category,
          日期: r.spent_on,
          记账人: r.created_by_profile,
          备注: r.note,
        })),
        数量: rows.length,
      });
    }
    if (action === "summary") {
      const ledgerId = args.ledger_id as string | undefined;
      if (ledgerId === undefined) {
        return fail('summary 需要 ledger_id（先调用 ledger {action:"list"} 取账本 id）');
      }
      if (getLedger(db, ledgerId) === undefined) return fail(`账本不存在: ${ledgerId}`);
      const range =
        args.month !== undefined
          ? monthRange(args.month as string)
          : {
              from: (args.from as string | undefined) ?? `${todayIso().slice(0, 7)}-01`,
              to: (args.to as string | undefined) ?? todayIso(),
            };
      const summary = summarizeExpenses(db, ledgerId, { ...range, by: args.by as string | undefined });
      return okJson({
        区间: range,
        合计: `¥${centsToYuan(summary.total_cents)}`,
        笔数: summary.count,
        分类明细: summary.categories.map((c) => ({
          分类: c.category,
          金额: `¥${centsToYuan(c.cents)}`,
          占比: `${(c.share * 100).toFixed(1)}%`,
        })),
        按记账人: summary.profiles.map((p) => ({ 记账人: p.profile, 金额: `¥${centsToYuan(p.cents)}` })),
      });
    }
    return fail(`未知 action: ${action}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

registerModule({
  name: "bookkeeping",
  tools: [
    {
      name: "ledger",
      description:
        "账本管理（全局共享，所有 Profile 均可读写）：create 创建、list 列出（含归档需 include_archived）、rename 重命名、archive 归档/恢复（unarchive=true）。",
      inputSchema: {
        action: z.enum(["create", "list", "rename", "archive"]),
        name: z.string().min(1).max(40).optional(),
        id: z.string().optional(),
        include_archived: z.boolean().optional(),
        unarchive: z.boolean().optional(),
      },
      handler: bookkeepingLedgerTool,
    },
    {
      name: "expense",
      description:
        "支出记账：add 记一笔（ledger_id + amount 元，可选 category/note/date，回执全局推送）；list 明细（可按 month/from/to/by 过滤）；summary 汇总（按分类与记账人）。金额只支持支出，单位为元。",
      inputSchema: {
        action: z.enum(["add", "list", "summary"]),
        ledger_id: z
          .string()
          .optional()
          .describe('账本 id；add/list/summary 必填，先调用 ledger {action:"list"} 获取'),
        amount: z.number().min(0.01).max(1_000_000).optional().describe("金额（元）"),
        category: z.string().max(20).optional(),
        note: z.string().max(200).optional(),
        date: z.string().regex(DATE_RE).optional().describe("花费日期，默认今天"),
        month: z.string().regex(/^\d{4}-\d{2}$/).optional().describe("按月过滤/汇总"),
        from: z.string().regex(DATE_RE).optional(),
        to: z.string().regex(DATE_RE).optional(),
        by: z.string().optional().describe("按记账人 Profile 过滤"),
        limit: z.number().int().min(1).max(200).optional(),
      },
      handler: bookkeepingExpenseTool,
    },
  ],
  jobs: [
    {
      name: "monthly_report",
      cron: "0 9 1 * *",
      handler: async () => {
        const rt = runtime();
        await pushMonthlyReports(rt.db, rt.services, previousMonth());
      },
    },
  ],
});
