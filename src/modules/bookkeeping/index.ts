import { z } from "zod";
import { logger } from "../../core/logger.js";
import {
  errorMessage,
  fail,
  okJson,
  registerModule,
  runtime,
  type ToolContext,
} from "../../core/registry.js";
import { ensureProfile } from "../../core/settings.js";
import { DATE_RE, todayIso } from "../../time.js";
import {
  addExpenseChecked,
  type BudgetStatus,
  budgetAlertsForEntry,
  budgetComparison,
  budgetScopeLabel,
  budgetStatus,
  CLIENT_TOKEN_MAX_LENGTH,
  categorySummary,
  centsToYuan,
  changeCategoryAlias,
  clearBudget,
  createLedger,
  deleteExpense,
  EXPENSE_CSV_MAX_ROWS,
  type ExpensePatch,
  entryReceiptBlocks,
  expenseCsv,
  expenseCsvFilename,
  findMissingMonthlyReports,
  getBudgets,
  getCategoryDictionary,
  getExpense,
  getLedger,
  getVisibleLedger,
  isLedgerVisible,
  type LedgerRow,
  listExpenses,
  listLedgers,
  monthRange,
  previousMonth,
  pushDailyDigests,
  pushMonthlyReports,
  pushWeeklyReports,
  recentCategories,
  renameLedger,
  resolveAddLedger,
  setBudget,
  setDefaultLedger,
  setLedgerArchived,
  summarizeExpenses,
  transferLedger,
  updateExpenseChecked,
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

/**
 * add 的 request_id（写路径幂等键）：缺省 undefined；非字符串/纯空白/超长一律报错。
 * 不静默截断或忽略 —— 让调用方以为「带上了幂等键」，实际每次重试都在重复记账。
 */
function requestIdOf(args: Record<string, unknown>): string | undefined {
  const raw = args.request_id;
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "" || raw.length > CLIENT_TOKEN_MAX_LENGTH) {
    throw new Error(`request_id 不合法（需为 1-${CLIENT_TOKEN_MAX_LENGTH} 个非空白字符）`);
  }
  return raw;
}

/** 未传 ledger_id 且无法确定默认账本时的可操作报错：列出可选账本 + 如何设置默认账本 */
function noDefaultLedgerMessage(candidates: LedgerRow[]): string {
  if (candidates.length === 0) {
    return 'add 需要 ledger_id：当前 Profile 没有可写的活动账本，请先用 ledger {action:"create", name:"…"} 建一个';
  }
  const list = candidates.map((row) => `${row.name}（id=${row.id}）`).join("、");
  return `add 未传 ledger_id，且无法确定默认账本；当前可写账本：${list}。请传 ledger_id，或用 expense {action:"set_default_ledger", ledger_id:"<账本 id>"} 指定默认账本`;
}

export function bookkeepingExpenseTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    const action = args.action as string;
    const db = ctx.db;
    if (action === "add") {
      const ledgerIdArg = args.ledger_id;
      const amount = args.amount as number | undefined;
      if (amount === undefined) {
        return fail("add 需要 amount（元）；ledger_id 可选，缺省走默认账本");
      }
      const requestId = requestIdOf(args);
      // 账本解析：显式 ledger_id 优先；未传时按 设置里的默认账本 → 唯一可写账本 的顺序确定，
      // 都不成立就报错列出候选（绝不随手挑一个账本记进去）。
      let ledger: LedgerRow;
      if (ledgerIdArg !== undefined) {
        if (typeof ledgerIdArg !== "string") return fail(`账本不存在: ${String(ledgerIdArg)}`);
        const found = getVisibleLedger(db, ledgerIdArg, ctx.profileId);
        if (found === undefined) return fail(`账本不存在: ${ledgerIdArg}`);
        ledger = found;
      } else {
        const resolved = resolveAddLedger(db, ctx.profileId);
        if (resolved.ledger === null) return fail(noDefaultLedgerMessage(resolved.candidates));
        ledger = resolved.ledger;
      }
      if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000)
        return fail(`金额不合法: ${String(amount)}`);
      const cents = Math.round(amount * 100);
      const result = addExpenseChecked(db, ctx.profileId, {
        ledgerId: ledger.id,
        amountCents: cents,
        category: args.category as string | undefined,
        note: args.note as string | undefined,
        spentOn: args.date as string | undefined,
        clientToken: requestId,
      });
      const entry = result.entry;
      // 幂等命中：行是首次写入的那一条，本次不再发回执/预算提醒（否则重试会重复打扰用户）
      if (result.reused) {
        logger.debug(
          `记账幂等命中，返回原记录: profile=${ctx.profileId} request_id=${requestId ?? ""} expense=${entry.id}`,
        );
      } else if (ledger.owner_profile_id === null) {
        // 家庭账本逐笔回执**只发记账人**（publishProfile，不再 publishGlobal）：
        // 真实库里 172 条回执 = 86 笔 × 2 人，同一笔钱把不相关的人也打扰了一遍。
        // 逐笔回执本身已由每晚 21:30 的 bookkeeping.digest 摘要取代；想恢复逐笔推送的人
        // 可以用 notify prefs 把 bookkeeping.entry 的 push 打开。
        // 个人账本依旧不回执、不推预算提醒（连归属人也不推，保持记账私密）。
        // 回执的 dedupeKey 用 request_id 派生（同一次请求重试得到同一个键，不含随机 id）；
        // 未带 request_id 时只能退回 entry:<id> —— 那个 id 是首次写入时生成的，重试返回的也是它。
        const receiptDedupeKey =
          requestId === undefined ? `entry:${entry.id}` : `entry:req:${ctx.profileId}:${requestId}`;
        void ctx.services
          .publishProfile(ctx.profileId, {
            kind: "bookkeeping.entry",
            title: `记账：¥${centsToYuan(entry.amount_cents)}（${ledger.name}）`,
            blocks: entryReceiptBlocks(ledger, entry),
            dedupeKey: receiptDedupeKey,
          })
          .catch((e) => logger.error(`记账回执发布失败（记账已成功）: ${errorMessage(e)}`));
        // 预算阈值提醒：只在本笔「跨越」80%/100% 时推；失败绝不影响记账成功。
        try {
          for (const alert of budgetAlertsForEntry(db, ledger, entry)) {
            void ctx.services
              .publishGlobal(alert)
              .catch((e) => logger.error(`预算提醒发布失败（记账已成功）: ${errorMessage(e)}`));
          }
        } catch (e) {
          logger.error(`预算提醒判定失败（记账已成功）: ${errorMessage(e)}`);
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
        ...(result.reused ? { 已存在: true } : {}),
        // 只在调用方没指定分类时给「常用分类」：已显式给分类的人不需要被推荐，
        // 多出来的字段只会是噪声（也会让固定的 分类 回显看起来像被改写）。
        ...(args.category === undefined
          ? { 常用分类: recentCategories(db, entry.ledger_id, { excludeId: entry.id }) }
          : {}),
      });
    }
    if (action === "set_default_ledger") {
      // 参数兼容 ledger_id 与简写 ledger（文档里把这一视图描述为「参数 ledger」）
      const raw = args.ledger_id ?? args.ledger;
      if (raw === undefined) {
        // 不传账本 = 查询当前默认账本（以及 add 实际会用的那个），便于设置后回读确认
        const resolved = resolveAddLedger(db, ctx.profileId);
        return okJson({
          默认账本: resolved.ledger === null ? null : ledgerView(resolved.ledger),
          ...(resolved.source === null
            ? {}
            : { 来源: resolved.source === "setting" ? "默认设置" : "唯一可写账本" }),
          可写账本: resolved.candidates.map(ledgerView),
          ...(resolved.ledger === null && resolved.candidates.length > 1
            ? {
                提示: "存在多个可写账本：请传 ledger_id 指定，或用 set_default_ledger 设置默认账本",
              }
            : {}),
        });
      }
      if (typeof raw !== "string") return fail(`账本不存在或不可写: ${String(raw)}`);
      const ledger = setDefaultLedger(db, ctx.profileId, raw);
      return okJson({
        已设置: { 默认账本: ledgerView(ledger) },
        说明: "之后 expense add 未传 ledger_id 时默认使用该账本；账本归档、转归属他人后该设置自动失效",
      });
    }
    if (action === "categories") {
      // 分类治理视图：字典（标准名+别名）+ 近 90 天用量；字典为空时它同时是「常用分类」
      // 清单，用户可以照着建别名。统计只覆盖当前 Profile 可见的活动账本。
      const dict = getCategoryDictionary(db, ctx.profileId);
      const rows = categorySummary(db, ctx.profileId);
      const hasDict = Object.keys(dict).length > 0;
      return okJson({
        分类: rows.map((row) => ({
          名称: row.name,
          别名: row.aliases,
          近90天笔数: row.count,
          近90天金额: `¥${centsToYuan(row.cents)}`,
        })),
        说明: hasDict
          ? "别名为按 Profile 保存的字典：add/update 时命中别名会自动归一到标准名；统计为近 90 天、当前 Profile 可见账本"
          : '尚未建立分类别名：以上是近 90 天实际用过的分类（当前 Profile 可见账本），可用 expense {action:"category_alias", category:"餐饮", alias:"吃饭"} 建立别名',
      });
    }
    if (action === "category_alias") {
      const category = args.category as string | undefined;
      const alias = args.alias as string | undefined;
      if (category === undefined || alias === undefined) {
        return fail("category_alias 需要 category（标准名）和 alias（别名）");
      }
      if (typeof category !== "string" || typeof alias !== "string") {
        return fail("category 与 alias 都必须是字符串");
      }
      const remove = args.remove === true;
      // 校验与冲突判定在 service（同一套口径也服务于 setCategoryDictionary 的写入校验）
      const state = changeCategoryAlias(db, ctx.profileId, { category, alias, remove });
      return okJson({
        分类: { 名称: state.name, 别名: state.aliases },
        说明: remove
          ? `已删除别名「${alias}」；之后以该文本记账不再归一到「${state.name}」`
          : `已把「${alias}」记为「${state.name}」的别名；之后记账命中它会自动归一为标准名`,
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
      // offset 非法（负数/NaN/非数字）一律回退 0：分页参数写错不该让整次查询报错，
      // 但也绝不能静默返回第一页却让调用方以为是别的页（所以把生效值回显成「偏移」）。
      const rawOffset = args.offset;
      const offset =
        typeof rawOffset === "number" && Number.isFinite(rawOffset)
          ? Math.max(0, Math.trunc(rawOffset))
          : 0;
      const page = listExpenses(db, ledgerId, {
        ...expenseRange(args),
        by: args.by as string | undefined,
        limit: args.limit as number | undefined,
        offset,
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
        偏移: offset,
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
    if (action === "update") {
      const id = args.id as string | undefined;
      if (id === undefined) return fail("update 需要 id（可从 expense {action:'list'} 获取）");
      // 编辑只更正字段，不支持把账目挪到另一个账本；显式传 ledger_id 时给出可操作提示
      if (args.ledger_id !== undefined) {
        return fail("update 不支持更换账本（要换账本请删除后重新记账）");
      }
      // 与 delete 同口径：先取账目，再按所属账本判可见性；不可见一律报「账本不存在」
      const existing = getExpense(db, id);
      if (existing === undefined) return fail(`账目不存在: ${id}`);
      const ledger = getVisibleLedger(db, existing.ledger_id, ctx.profileId);
      if (ledger === undefined) return fail(`账本不存在: ${existing.ledger_id}`);
      const amount = args.amount as number | undefined;
      const category = args.category as string | undefined;
      const note = args.note as string | undefined;
      const date = args.date as string | undefined;
      if (
        amount === undefined &&
        category === undefined &&
        note === undefined &&
        date === undefined
      ) {
        return fail("update 需要至少一个待改字段：amount / category / note / date");
      }
      const patch: ExpensePatch = {};
      if (amount !== undefined) {
        // 元 → 分：与 add 同口径（0.01 元起、上限 100 万元），非法值在进入 service 前拦下
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
          return fail(`金额不合法: ${String(amount)}`);
        }
        patch.amountCents = Math.round(amount * 100);
      }
      if (category !== undefined) patch.category = category;
      if (note !== undefined) patch.note = note;
      if (date !== undefined) patch.spentOn = date;
      // 与 add 同一套分类字典：update 显式传 category 时也要把别名归一成标准名
      const entry = updateExpenseChecked(db, ctx.profileId, id, patch);
      return okJson({
        已更新: {
          id: entry.id,
          账本: ledger.name,
          金额: `¥${centsToYuan(entry.amount_cents)}`,
          分类: entry.category,
          日期: entry.spent_on,
          备注: entry.note,
          记账人: entry.created_by_profile,
        },
        说明: "仅更正该笔账目，不会重发记账回执、也不会重新判定预算提醒（记账人与创建时间不变）",
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
    if (action === "export") {
      const ledgerId = args.ledger_id as string | undefined;
      if (ledgerId === undefined) {
        return fail('export 需要 ledger_id（先调用 ledger {action:"list"} 取账本 id）');
      }
      const ledger = getVisibleLedger(db, ledgerId, ctx.profileId);
      if (ledger === undefined) return fail(`账本不存在: ${ledgerId}`);
      // 工具 schema 是各 action 共用的，from/to 只属于 list/summary：静默忽略会让
      // 「导出这个区间」变成「导出当月」，宁可明确拒绝。
      if (args.from !== undefined || args.to !== undefined) {
        return fail("export 只支持按自然月（month）导出，不支持 from/to");
      }
      const month = (args.month as string | undefined) ?? todayIso().slice(0, 7);
      const result = expenseCsv(db, {
        ledgerId,
        month,
        limit: EXPENSE_CSV_MAX_ROWS,
      });
      return okJson({
        账本: ledger.name,
        月份: month,
        行数: result.rows,
        // 截断时补总行数：只给「已截断」布尔，agent 无从判断还剩多少没导
        ...(result.truncated ? { 总行数: result.total } : {}),
        文件名: expenseCsvFilename(month),
        已截断: result.truncated,
        ...(result.truncated
          ? {
              说明: `行数超过 ${EXPENSE_CSV_MAX_ROWS} 上限，已截断；请缩小查询范围（如分月/分账本导出）`,
            }
          : {}),
        CSV: result.csv,
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
        "账本管理：create 创建（personal=true 建个人账本，仅归属人可见可写；缺省建家庭账本，所有 Profile 共享）、list 列出当前 Profile 可见的账本（家庭账本 + 自己的个人账本；含归档需 include_archived）、rename 重命名、archive 归档/恢复（unarchive=true）、transfer 转移个人账本归属（带 profile 转给该 Profile，缺省转回家庭且不可逆；仅当前归属人可操作）、budget 月度预算（传 ledger_id 查看全部预算与本月对照；带 amount 设置/覆盖，单位元，带 category 为分类预算、缺省为账本总额；clear=true 删除该范围）。家庭账本逐笔回执只发记账人（不再全局推送，其他人改由每晚 21:30 的每日摘要汇总），预算提醒仍全局推送（跨越 80%/100% 时，同一预算一笔只推跨过的最高阈值那一条）；个人账本不回执、不推送预算提醒，月报只发给归属人。",
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
        "支出记账：add 记一笔（amount 元必填；ledger_id 可选，缺省按「默认账本 → 唯一可写账本」解析；可选 category/note/date/request_id；家庭账本逐笔回执只发记账人（想恢复逐笔推送可用 notify prefs 打开 bookkeeping.entry），个人账本不回执不提醒；未显式传 category 时回执附「常用分类」）；list 明细（可按 month/from/to/by 过滤）；summary 汇总（按分类与记账人）；update 更正一笔（id + amount/category/note/date 至少一个，只改显式传入的字段，不触发回执与预算提醒）；delete 删除记错的一笔（id 从 list 获取）；export 导出 CSV（ledger_id + 可选 month，默认当月；表头「日期,账本,分类,金额(元),备注,记账人」，UTF-8 BOM；单次上限 2000 行，超出时 已截断=true 并给出总行数）；set_default_ledger 设置/查看默认账本（传 ledger_id 设置，不传则返回当前默认账本）；categories 列出分类字典（标准名+别名+近 90 天笔数/金额，字典为空时即近 90 天实际用过的分类）；category_alias 维护别名（category + alias 添加，remove=true 删除；别名命中后 add/update 会自动归一成标准名，未知分类仍按自由文本保存）。list 支持 offset 分页（回执带 已返回/偏移/匹配总数/还有更多）。仅能操作当前 Profile 可见的账本（家庭账本或自己的个人账本）。幂等：add 传 request_id 后，同一人用同一个 request_id 重试不会重复记账，返回原记录并附「已存在: true」（不重复发通知）。CSV 导出对以 = + - @ 或制表符/回车开头的文本单元格做公式注入中和。month 与 from/to 互斥（同时传会报错）；from/to 只给一边就是半边区间（只给 from = [from, 将来)，只给 to = (过去, to]），两个 action 口径一致；默认区间只在 month/from/to **都不传**时生效（summary 默认「月初→今天」，list 不传时不限区间）。金额只支持支出，单位为元。",
      inputSchema: {
        action: z.enum([
          "add",
          "list",
          "summary",
          "update",
          "delete",
          "export",
          "set_default_ledger",
          "categories",
          "category_alias",
        ]),
        id: z.string().optional().describe("update/delete 时的账目 id（从 list 获取）"),
        ledger_id: z
          .string()
          .optional()
          .describe(
            "账本 id；list/summary/export 必填，add 可选（缺省走默认账本），set_default_ledger 时传它指定默认账本",
          ),
        ledger: z.string().optional().describe("set_default_ledger 的简写参数，等价于 ledger_id"),
        request_id: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe(
            "add 的幂等键（1-128 字符）：超时重试时带同一个值不会重复记账，返回原记录并附「已存在: true」",
          ),
        amount: z
          .number()
          .min(0.01)
          .max(1_000_000)
          .optional()
          .describe("金额（元）；add 必填，update 时不传则不改"),
        category: z.string().max(20).optional().describe("分类；update 时不传则不改"),
        note: z.string().max(200).optional().describe("备注；update 传空串可清空，不传则不改"),
        date: z
          .string()
          .regex(DATE_RE)
          .optional()
          .describe("花费日期，默认今天；update 时不传则不改"),
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe("按自然月过滤/汇总/导出（整月，含月内未来日）；与 from/to 互斥"),
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
        offset: z
          .number()
          .optional()
          .describe("list 分页偏移（默认 0，负数/非法按 0）；配合 limit 翻页"),
        alias: z
          .string()
          .max(20)
          .optional()
          .describe("category_alias 的别名，1-20 字符；与任何标准名/别名冲突会被拒绝"),
        remove: z
          .boolean()
          .optional()
          .describe("category_alias remove=true 删除别名（不存在时幂等成功）"),
      },
      handler: bookkeepingExpenseTool,
    },
  ],
  jobs: [
    {
      name: "ledger_digest",
      // cron 从 config 惰性读取（LEDGER_DIGEST_CRON，默认 21:30）：与月报不同，
      // 摘要必须每晚都跑，错过一天的「今天记了什么」补发也没有意义。
      cron: () => runtime().config.ledgerDigestCron,
      handler: async () => {
        const rt = runtime();
        try {
          const pushed = await pushDailyDigests(rt.db, rt.services);
          logger.info(`每日记账摘要：发布 ${pushed} 条`);
        } catch (e) {
          // 摘要失败不影响记账本身（账已落库），但必须让运维看得见：rethrow 交给 job_runs
          // 记 failed（状态页/doctor --live 可见），否则「摘要静默不推」会被当成一切正常。
          logger.error(`每日记账摘要发布失败: ${errorMessage(e)}`);
          throw e;
        }
      },
    },
    {
      name: "weekly_report",
      // cron 从 config 惰性读取（WEEKLY_REPORT_CRON，默认 "0 20 * * 0" 即周日 20:00）。
      // 与其他报表 job 一样，失败必须 rethrow 让 job_runs 记 failed：静默不推的报表
      // 比推错更糟（用户会以为这周没有记账）。
      cron: () => runtime().config.weeklyReportCron,
      handler: async () => {
        const rt = runtime();
        try {
          // 不传 weekStart：默认取「今天所在周的周一」，cron 在周日触发时就是刚结束的这一周
          const pushed = await pushWeeklyReports(rt.db, rt.services);
          logger.info(`周报：发布 ${pushed} 条`);
        } catch (e) {
          logger.error(`周报发布失败: ${errorMessage(e)}`);
          throw e;
        }
      },
    },
    {
      name: "monthly_report",
      cron: "0 9 1 * *",
      handler: async () => {
        const rt = runtime();
        // 上月账单必须按时发，但 node-cron 不补发错过的触发（1 号 09:00 停机即永久丢失）。
        // 每次触发时先补齐最近几个月缺失的账单；dedupeKey 保证幂等（每月只物化一次）。
        const catchup = findMissingMonthlyReports(rt.db);
        if (catchup.tooOld.length > 0) {
          // 回看窗口外的月报不会自动补发：停机超窗口时这些账单永久丢失，必须留痕
          const detail = catchup.tooOld.map((m) => `${m.ledger_name}/${m.ym}`).join("、");
          logger.warn(
            `有早于回看窗口、从未推送过的月报，不会自动补发（如需补发请人工处理）：${detail}`,
          );
        }
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
