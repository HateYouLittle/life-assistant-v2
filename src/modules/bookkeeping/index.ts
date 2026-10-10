import { z } from "zod";
import { DATE_RE, todayIso } from "../../time.js";
import {
  errorMessage,
  fail,
  okJson,
  registerModule,
  runtime,
  type ToolContext,
} from "../../core/registry.js";
import { logger } from "../../core/logger.js";
import { ensureProfile } from "../../core/settings.js";
import {
  addExpense,
  budgetAlertsForEntry,
  budgetComparison,
  budgetScopeLabel,
  budgetStatus,
  centsToYuan,
  clearBudget,
  createLedger,
  deleteExpense,
  entryReceiptBlocks,
  findMissingMonthlyReports,
  getBudgets,
  getExpense,
  getLedger,
  getVisibleLedger,
  isLedgerVisible,
  listExpenses,
  listLedgers,
  monthRange,
  previousMonth,
  pushMonthlyReports,
  renameLedger,
  setBudget,
  setLedgerArchived,
  summarizeExpenses,
  transferLedger,
  type BudgetStatus,
  type LedgerRow,
} from "./service.js";

/** 账本的工具视图：家庭账本标注「家庭」，个人账本标注「个人 + 归属人」 */
function ledgerView(row: LedgerRow) {
  return {
    id: row.id,
    名称: row.name,
    归档: row.archived_at !== null,
    类型: row.owner_profile_id === null ? "家庭" : "个人",
    ...(row.owner_profile_id === null ? {} : { 归属人: row.owner_profile_id }),
  };
}

/** 预算对照的可读视图（工具回显用） */
function budgetStatusView(status: BudgetStatus) {
  return {
    总额:
      status.total === null
        ? null
        : budgetComparison(status.total.budget_cents, status.total.spent_cents),
    分类: status.categories.map((c) => ({
      分类: c.category,
      ...budgetComparison(c.budget_cents, c.spent_cents),
    })),
  };
}

export function bookkeepingLedgerTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    const action = args.action as string;
    const db = ctx.db;
    if (action === "create") {
      const name = args.name as string | undefined;
      if (name === undefined) return fail("create 需要 name");
      // personal=true 建个人账本（归属调用方）；缺省建家庭账本（所有 Profile 共享）
      const personal = args.personal === true;
      let ownerProfileId: string | null = null;
      if (personal) {
        ensureProfile(db, ctx.profileId);
        ownerProfileId = ctx.profileId;
      }
      const row = createLedger(db, name, ownerProfileId);
      return okJson({ 已创建: ledgerView(row) });
    }
    if (action === "list") {
      const includeArchived = args.include_archived === true;
      // 只列当前 Profile 可见的账本：家庭账本 + 自己名下个人账本
      const rows = listLedgers(db, includeArchived).filter((r) =>
        isLedgerVisible(r, ctx.profileId),
      );
      return okJson({
        账本: rows.map(ledgerView),
        说明: "家庭账本所有 Profile 可见可记账；个人账本仅归属人可见可写",
      });
    }
    if (action === "rename") {
      const id = args.id as string | undefined;
      const name = args.name as string | undefined;
      if (id === undefined || name === undefined) return fail("rename 需要 id 和 name");
      if (getVisibleLedger(db, id, ctx.profileId) === undefined) return fail(`账本不存在: ${id}`);
      const row = renameLedger(db, id, name);
      return okJson({ 已重命名: ledgerView(row) });
    }
    if (action === "archive") {
      const id = args.id as string | undefined;
      if (id === undefined) return fail("archive 需要 id");
      if (getVisibleLedger(db, id, ctx.profileId) === undefined) return fail(`账本不存在: ${id}`);
      const unarchive = args.unarchive === true;
      const row = setLedgerArchived(db, id, !unarchive);
      return okJson({ 结果: ledgerView(row) });
    }
    if (action === "transfer") {
      const id = args.id as string | undefined;
      if (id === undefined) return fail("transfer 需要 id");
      const ledger = getLedger(db, id);
      if (ledger === undefined) return fail(`账本不存在: ${id}`);
      // 家庭账本 → 个人是单向禁止；非归属人的个人账本按「不存在」处理（不泄露存在性）
      if (ledger.owner_profile_id === null) {
        return fail("家庭账本不支持转移（家庭账本不能转为个人账本）");
      }
      if (ledger.owner_profile_id !== ctx.profileId) return fail(`账本不存在: ${id}`);
      // profile 缺省 = 转回家庭（不可逆）；给出 = 转给该 Profile（须已存在，由 service 校验）
      const profile = args.profile as string | undefined;
      const row = transferLedger(db, id, profile ?? null);
      return okJson({
        已转移: ledgerView(row),
        说明:
          row.owner_profile_id === null
            ? "已转为家庭账本（所有 Profile 共享，不可再转回个人）"
            : `归属已转移给 ${row.owner_profile_id}`,
      });
    }
    if (action === "budget") {
      const ledgerId = args.ledger_id as string | undefined;
      if (ledgerId === undefined) {
        return fail('budget 需要 ledger_id（先调用 ledger {action:"list"} 取账本 id）');
      }
      const ledger = getVisibleLedger(db, ledgerId, ctx.profileId);
      if (ledger === undefined) return fail(`账本不存在: ${ledgerId}`);
      const category = ((args.category as string | undefined) ?? "").trim();
      if (args.clear === true) {
        const removed = clearBudget(db, ledgerId, category);
        return okJson({
          已清除: { 账本: ledger.name, 范围: budgetScopeLabel(category), 删除: removed },
        });
      }
      const amount = args.amount as number | undefined;
      if (amount !== undefined) {
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
          return fail(`金额不合法: ${String(amount)}`);
        }
        const row = setBudget(db, ledgerId, category, Math.round(amount * 100));
        return okJson({
          已设置: {
            账本: ledger.name,
            范围: budgetScopeLabel(row.category),
            预算: `¥${centsToYuan(row.amount_cents)}`,
          },
          本月对照: budgetStatusView(budgetStatus(db, ledgerId, todayIso().slice(0, 7))),
        });
      }
      const ym = todayIso().slice(0, 7);
      return okJson({
        账本: ledger.name,
        月份: ym,
        预算: getBudgets(db, ledgerId).map((b) => ({
          范围: budgetScopeLabel(b.category),
          预算: `¥${centsToYuan(b.amount_cents)}`,
        })),
        本月对照: budgetStatusView(budgetStatus(db, ledgerId, ym)),
      });
    }
    return fail(`未知 action: ${action}`);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
}

/**
 * list / summary 共用的查询区间解析，两个 action 口径必须一致：
 * - `month` 与 `from`/`to` 互斥。`month` 已给出整月区间，并列时 list 曾逐边合并成
 *   「月内且不早于 from」的越界区间（month + to 更会得到反向区间、静默 0 笔），
 *   而 summary 整体走 monthRange、静默忽略 from/to —— 同一工具两个 action 结论相反。
 * - `from > to` 显式报错，不当成「查不到」。
 * - `defaults` 只用于 summary **完全没指定** from/to 时的默认（月初 → 今天）；list 不传任何
 *   参数时仍是不限区间的全量查询，不能给默认区间（那会把历史账目藏掉）。
 * - defaults 必须**整体**套用，不能逐边兜底（`from ?? defaults.from` / `to ?? defaults.to`）：
 *   逐边兜底会让只给 from 的 summary 被补上 to=今天，只给 to 的被补上 from=月初，于是同一句
 *   查询 list（半边语义）与 summary（被补全的区间）给出相反的笔数/金额；「未来起点」还会被
 *   补出来的 to 判成「区间写反了」而报错，而 list 同一输入静默返回 0 条。
 */
function expenseRange(
  args: Record<string, unknown>,
  defaults?: { from: string; to: string },
): { from?: string; to?: string } {
  const month = args.month as string | undefined;
  const from = args.from as string | undefined;
  const to = args.to as string | undefined;
  if (month !== undefined) {
    if (from !== undefined || to !== undefined) {
      throw new Error("month 与 from/to 不能同时指定（month 已给出整月区间，二选一）");
    }
    return monthRange(month);
  }
  // defaults 整体套用：半边给参就保持半边语义，与 list 完全一致。
  const range =
    from === undefined && to === undefined && defaults !== undefined
      ? { ...defaults }
      : { from, to };
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    throw new Error(`区间非法: from(${range.from}) 晚于 to(${range.to})`);
  }
  return range;
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
      const ledger = getVisibleLedger(db, ledgerId, ctx.profileId);
      if (ledger === undefined) return fail(`账本不存在: ${ledgerId}`);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)
        return fail(`金额不合法: ${String(amount)}`);
      const cents = Math.round(amount * 100);
      const entry = addExpense(db, ctx.profileId, {
        ledgerId,
        amountCents: cents,
        category: args.category as string | undefined,
        note: args.note as string | undefined,
        spentOn: args.date as string | undefined,
      });
      // 个人账本：不回执、不推预算提醒（连归属人也不推，保持记账私密）；家庭账本维持全局推送
      if (ledger.owner_profile_id === null) {
        void ctx.services
          .publishGlobal({
            kind: "bookkeeping.entry",
            title: `记账：¥${centsToYuan(entry.amount_cents)}（${ledger.name}）`,
            blocks: entryReceiptBlocks(ledger, entry),
            dedupeKey: `entry:${entry.id}`,
          })
          .catch((e) => logger.warn(`记账回执发布失败（记账已成功）: ${errorMessage(e)}`));
        // 预算阈值提醒：只在本笔「跨越」80%/100% 时推；失败绝不影响记账成功。
        try {
          for (const alert of budgetAlertsForEntry(db, ledger, entry)) {
            void ctx.services
              .publishGlobal(alert)
              .catch((e) => logger.warn(`预算提醒发布失败（记账已成功）: ${errorMessage(e)}`));
          }
        } catch (e) {
          logger.warn(`预算提醒判定失败（记账已成功）: ${errorMessage(e)}`);
        }
      }
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
      if (getVisibleLedger(db, ledgerId, ctx.profileId) === undefined) {
        return fail(`账本不存在: ${ledgerId}`);
      }
      const page = listExpenses(db, ledgerId, {
        ...expenseRange(args),
        by: args.by as string | undefined,
        limit: args.limit as number | undefined,
      });
      return okJson({
        账目: page.rows.map((r) => ({
          id: r.id,
          金额: `¥${centsToYuan(r.amount_cents)}`,
          分类: r.category,
          日期: r.spent_on,
          记账人: r.created_by_profile,
          备注: r.note,
        })),
        // 区分「返回条数」与「匹配总数」：此前 数量 只报返回行数，默认 LIMIT 20
        // 会让调用方以为这就是全部，从而少报笔数/金额。
        已返回: page.rows.length,
        匹配总数: page.total,
        还有更多: page.hasMore,
      });
    }
    if (action === "summary") {
      const ledgerId = args.ledger_id as string | undefined;
      if (ledgerId === undefined) {
        return fail('summary 需要 ledger_id（先调用 ledger {action:"list"} 取账本 id）');
      }
      if (getVisibleLedger(db, ledgerId, ctx.profileId) === undefined)
        return fail(`账本不存在: ${ledgerId}`);
      // 未指定区间时默认「月初 → 今天」（本月至今）；看板/月报的「本月」是自然月全月，
      // 口径差异见 service.ts 的 monthRange 注释
      const range = expenseRange(args, {
        from: `${todayIso().slice(0, 7)}-01`,
        to: todayIso(),
      });
      const summary = summarizeExpenses(db, ledgerId, {
        ...range,
        by: args.by as string | undefined,
      });
      return okJson({
        区间: range,
        合计: `¥${centsToYuan(summary.total_cents)}`,
        笔数: summary.count,
        分类明细: summary.categories.map((c) => ({
          分类: c.category,
          金额: `¥${centsToYuan(c.cents)}`,
          占比: `${(c.share * 100).toFixed(1)}%`,
        })),
        按记账人: summary.profiles.map((p) => ({
          记账人: p.profile,
          金额: `¥${centsToYuan(p.cents)}`,
        })),
      });
    }
    if (action === "delete") {
      const id = args.id as string | undefined;
      if (id === undefined) return fail("delete 需要 id（可从 expense {action:'list'} 获取）");
      const existing = getExpense(db, id);
      if (existing === undefined) return fail(`账目不存在: ${id}`);
      // 先按该笔所属账本判断可见性：不可见账本下的账目一并以「账本不存在」处理
      if (getVisibleLedger(db, existing.ledger_id, ctx.profileId) === undefined) {
        return fail(`账本不存在: ${existing.ledger_id}`);
      }
      const entry = deleteExpense(db, id);
      return okJson({
        已删除: {
          id: entry.id,
          金额: `¥${centsToYuan(entry.amount_cents)}`,
          分类: entry.category,
          日期: entry.spent_on,
          记账人: entry.created_by_profile,
        },
        说明: "该笔支出已直接删除，无法恢复",
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
        "账本管理：create 创建（personal=true 建个人账本，仅归属人可见可写；缺省建家庭账本，所有 Profile 共享）、list 列出当前 Profile 可见的账本（家庭账本 + 自己的个人账本；含归档需 include_archived）、rename 重命名、archive 归档/恢复（unarchive=true）、transfer 转移个人账本归属（带 profile 转给该 Profile，缺省转回家庭且不可逆；仅当前归属人可操作）、budget 月度预算（传 ledger_id 查看全部预算与本月对照；带 amount 设置/覆盖，单位元，带 category 为分类预算、缺省为账本总额；clear=true 删除该范围）。家庭账本的回执与预算提醒全局推送（跨越 80%/100% 时，同一预算一笔只推跨过的最高阈值那一条）；个人账本不回执、不推送预算提醒，月报只发给归属人。",
      inputSchema: {
        action: z.enum(["create", "list", "rename", "archive", "transfer", "budget"]),
        name: z.string().min(1).max(40).optional(),
        id: z.string().optional(),
        personal: z
          .boolean()
          .optional()
          .describe("create 时 personal=true 建个人账本（归属当前 Profile）；缺省建家庭账本"),
        profile: z
          .string()
          .optional()
          .describe("transfer 时的目标 Profile；缺省则转回家庭账本（不可逆）"),
        include_archived: z.boolean().optional(),
        unarchive: z.boolean().optional(),
        ledger_id: z
          .string()
          .optional()
          .describe('budget 时的账本 id，先调用 ledger {action:"list"} 获取'),
        amount: z
          .number()
          .min(0.01)
          .max(1_000_000)
          .optional()
          .describe("budget 时的预算金额（元）"),
        category: z.string().max(20).optional().describe("budget 时的分类；不传为账本总额预算"),
        clear: z.boolean().optional().describe("budget clear=true 删除该范围预算"),
      },
      handler: bookkeepingLedgerTool,
    },
    {
      name: "expense",
      description:
        "支出记账：add 记一笔（ledger_id + amount 元，可选 category/note/date；家庭账本回执全局推送，个人账本不回执不提醒）；list 明细（可按 month/from/to/by 过滤）；summary 汇总（按分类与记账人）；delete 删除记错的一笔（id 从 list 获取）。仅能操作当前 Profile 可见的账本（家庭账本或自己的个人账本）。month 与 from/to 互斥（同时传会报错）；from/to 只给一边就是半边区间（只给 from = [from, 将来)，只给 to = (过去, to]），两个 action 口径一致；默认区间只在 month/from/to **都不传**时生效（summary 默认「月初→今天」，list 不传时不限区间）。金额只支持支出，单位为元。",
      inputSchema: {
        action: z.enum(["add", "list", "summary", "delete"]),
        id: z.string().optional().describe("delete 时的账目 id"),
        ledger_id: z
          .string()
          .optional()
          .describe('账本 id；add/list/summary 必填，先调用 ledger {action:"list"} 获取'),
        amount: z.number().min(0.01).max(1_000_000).optional().describe("金额（元）"),
        category: z.string().max(20).optional(),
        note: z.string().max(200).optional(),
        date: z.string().regex(DATE_RE).optional().describe("花费日期，默认今天"),
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe("按自然月过滤/汇总（整月，含月内未来日）；与 from/to 互斥"),
        from: z
          .string()
          .regex(DATE_RE)
          .optional()
          .describe(
            "起始日（含）；与 month 互斥；只给 from 不给 to 时区间是 [from, 将来)（不限上界）",
          ),
        to: z
          .string()
          .regex(DATE_RE)
          .optional()
          .describe(
            "截止日（含）；与 month 互斥；只给 to 不给 from 时区间是 (过去, to]（不限下界）",
          ),
        by: z.string().optional().describe("按记账人 Profile 过滤"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("list 返回条数，默认 20，上限 200"),
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
        // 上月账单必须按时发，但 node-cron 不补发错过的触发（1 号 09:00 停机即永久丢失）。
        // 每次触发时先补齐最近几个月缺失的账单；dedupeKey 保证幂等（每月只物化一次）。
        const catchup = findMissingMonthlyReports(rt.db);
        const months = [...new Set(catchup.missing.map((m) => m.ym))].sort();
        for (const ym of months) {
          logger.warn(`补发缺失的月报：${ym}`);
          await pushMonthlyReports(rt.db, rt.services, ym);
        }
        await pushMonthlyReports(rt.db, rt.services, previousMonth());
      },
    },
  ],
});
