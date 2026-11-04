import { z } from "zod";
import { defineActionTool } from "../../core/action-tool.js";
import { logger } from "../../core/logger.js";
import {
  fail,
  okJson,
  registerModule,
  type ToolContext,
  type ToolResult,
} from "../../core/registry.js";
import { ensureProfile } from "../../core/settings.js";
import { DATE_RE, todayIso } from "../../time.js";
import {
  addExpenseChecked,
  type BudgetStatus,
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
  expenseCsv,
  expenseCsvFilename,
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
  normalizeCategory,
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

function ledgerCreate(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
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

function ledgerList(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
  const includeArchived = args.include_archived === true;
  // 只列当前 Profile 可见的账本：家庭账本 + 自己名下个人账本
  const rows = listLedgers(db, includeArchived).filter((r) => isLedgerVisible(r, ctx.profileId));
  return okJson({
    账本: rows.map(ledgerView),
    说明: "家庭账本所有 Profile 可见可记账；个人账本仅归属人可见可写",
  });
}

function ledgerRename(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
  const id = args.id as string | undefined;
  const name = args.name as string | undefined;
  if (id === undefined || name === undefined) return fail("rename 需要 id 和 name");
  if (getVisibleLedger(db, id, ctx.profileId) === undefined) return fail(`账本不存在: ${id}`);
  const row = renameLedger(db, id, name);
  return okJson({ 已重命名: ledgerView(row) });
}

function ledgerArchive(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
  const id = args.id as string | undefined;
  if (id === undefined) return fail("archive 需要 id");
  if (getVisibleLedger(db, id, ctx.profileId) === undefined) return fail(`账本不存在: ${id}`);
  const unarchive = args.unarchive === true;
  const row = setLedgerArchived(db, id, !unarchive);
  return okJson({ 结果: ledgerView(row) });
}

function ledgerTransfer(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
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

function ledgerBudget(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
  const ledger = readLedger(args, ctx, "budget");
  if (typeof ledger === "string") return fail(ledger);
  const ledgerId = ledger.id;
  // 分类预算与 expense add/update 共用同一份字典归一：否则用户用别名（如「吃饭」）
  // 设的预算会落在别名文本下，而归一后的支出记在标准名（「餐饮」）下 —— 已用恒为 0、
  // 阈值提醒永不触发，且没有任何提示。总额预算（空分类）不参与归一。
  //
  // 存量数据：旧版本只归一写入路径，库里可能已存在 `category='吃饭'` 的旧预算行。
  // 本次写入/清除时，把该账本里**归一后与目标同义**的所有旧分类行一并清掉（两个方向
  // 都要覆盖）：既清「别名→标准名」的原文行，也清「用标准名操作」时残留的别名行，
  // 否则对照表里会同时出现两条同义预算（一条恒 ¥0）。
  const rawCategory = ((args.category as string | undefined) ?? "").trim();
  const category = rawCategory === "" ? "" : normalizeCategory(db, ctx.profileId, rawCategory);
  const normalized = category !== rawCategory;
  const normalizedHint = normalized ? { 分类归一: category } : {};
  // 同义旧分类行：非目标分类、但归一后等于目标分类（总额预算不参与）。
  const sameScopeAliases =
    category === ""
      ? []
      : getBudgets(db, ledgerId)
          .map((row) => row.category)
          .filter(
            (existing) =>
              existing !== category && normalizeCategory(db, ctx.profileId, existing) === category,
          );
  if (args.clear === true) {
    let removed = clearBudget(db, ledgerId, category);
    if (normalized) removed = clearBudget(db, ledgerId, rawCategory) || removed;
    for (const alias of sameScopeAliases) {
      removed = clearBudget(db, ledgerId, alias) || removed;
    }
    return okJson({
      已清除: {
        账本: ledger.name,
        范围: budgetScopeLabel(category),
        删除: removed,
      },
      ...normalizedHint,
    });
  }
  const amount = args.amount as number | undefined;
  if (amount !== undefined) {
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) {
      return fail(`金额不合法: ${String(amount)}`);
    }
    if (normalized) clearBudget(db, ledgerId, rawCategory);
    for (const alias of sameScopeAliases) clearBudget(db, ledgerId, alias);
    const row = setBudget(db, ledgerId, category, Math.round(amount * 100));
    return okJson({
      已设置: {
        账本: ledger.name,
        范围: budgetScopeLabel(row.category),
        预算: `¥${centsToYuan(row.amount_cents)}`,
      },
      ...normalizedHint,
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

/**
 * 按 action 维护「允许字段」白名单（P2-21 / M-05）：工具的 inputSchema 是全 action 共享的，
 * handler 只读其中一部分，未列出的字段此前被**静默忽略** —— `export` 带 by/limit 会被当成
 * 「导出当月全部」、非 budget 的 amount 被直接丢弃，都属于「成功返回但语义错误」，
 * 比报错更难发现（M-05）。这里统一显式拒绝，文案与 notify 侧完全一致。
 *
 * 值为 undefined 的键不算「传了字段」：MCP/invokeTool 调用方可能显式带上未使用的可选键。
 * `from/to`（export）与 `ledger_id`（update）仍由各自分支给出更具体、可操作的报错
 * （既有用例钉住这两条文案），故列入白名单让它走到那条分支，而不是被通用文案抢先。
 */
const ledgerDispatch = defineActionTool({
  actions: {
    create: { fields: ["name", "personal"], handler: ledgerCreate },
    list: { fields: ["include_archived"], handler: ledgerList },
    rename: { fields: ["id", "name"], handler: ledgerRename },
    archive: { fields: ["id", "unarchive"], handler: ledgerArchive },
    transfer: { fields: ["id", "profile"], handler: ledgerTransfer },
    budget: { fields: ["ledger_id", "amount", "category", "clear"], handler: ledgerBudget },
  },
});

export function bookkeepingLedgerTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    return ledgerDispatch.handler(args, ctx);
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
function noDefaultLedgerMessage(action: string, candidates: LedgerRow[]): string {
  if (candidates.length === 0) {
    return `${action} 需要 ledger_id：当前 Profile 没有可写的活动账本，请先用 ledger {action:"create", name:"…"} 建一个`;
  }
  const list = candidates.map((row) => `${row.name}（id=${row.id}）`).join("、");
  return `${action} 未传 ledger_id，且无法确定默认账本；当前可写账本：${list}。请传 ledger_id，或用 expense {action:"set_default_ledger", ledger_id:"<账本 id>"} 指定默认账本`;
}

/**
 * 读类 action（list/summary/export/budget）的账本解析：显式 ledger_id 按可见性校验（已归档
 * 账本也能查）；未传时与 add 同口径（默认账本 → 唯一可写账本），用户问「这个月花了多少」
 * 不必先 ledger list 再带 id。返回 string 表示可直接回给调用方的错误文案。
 */
function readLedger(
  args: Record<string, unknown>,
  ctx: ToolContext,
  action: string,
): LedgerRow | string {
  const raw = args.ledger_id;
  if (raw !== undefined) {
    if (typeof raw !== "string") return `账本不存在: ${String(raw)}`;
    return getVisibleLedger(ctx.db, raw, ctx.profileId) ?? `账本不存在: ${raw}`;
  }
  const resolved = resolveAddLedger(ctx.db, ctx.profileId);
  return resolved.ledger ?? noDefaultLedgerMessage(action, resolved.candidates);
}
function expenseAdd(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
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
    if (resolved.ledger === null) return fail(noDefaultLedgerMessage("add", resolved.candidates));
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
  // 幂等命中（P2-4）：返回的行来自**首次写入**，回显字段必须全部取自原记录。
  // 本次调用解析出的 ledger 可能与之不同（重试时显式换了 ledger_id，或默认账本被改），
  // 用它回显会让「账本」与金额/分类/日期（都来自 entry）自相矛盾，误导人工对账。
  const entryLedger = result.reused ? (getLedger(db, entry.ledger_id) ?? ledger) : ledger;
  if (result.reused) {
    logger.debug(
      `记账幂等命中，返回原记录: profile=${ctx.profileId} request_id=${requestId ?? ""} expense=${entry.id}`,
    );
  }
  return okJson({
    已记账: {
      id: entry.id,
      账本: entryLedger.name,
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

function expenseSetDefaultLedger(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
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

function expenseCategories(_args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
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

function expenseCategoryAlias(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
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

function expenseList(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
  const resolved = readLedger(args, ctx, "list");
  if (typeof resolved === "string") return fail(resolved);
  const ledgerId = resolved.id;
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

function expenseSummary(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
  const resolved = readLedger(args, ctx, "summary");
  if (typeof resolved === "string") return fail(resolved);
  const ledgerId = resolved.id;
  // 未指定区间时默认「本自然月全月」：与看板、预算对照同一口径（含月内已录入的未来日），
  // 用户问「这个月花了多少」只有一个答案
  const range = expenseRange(args, monthRange(todayIso().slice(0, 7)));
  const summary = summarizeExpenses(db, ledgerId, {
    ...range,
    by: args.by as string | undefined,
  });
  return okJson({
    账本: resolved.name,
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

function expenseUpdate(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
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
  if (amount === undefined && category === undefined && note === undefined && date === undefined) {
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
    说明: "仅更正该笔账目（记账人与创建时间不变）",
  });
}

function expenseDelete(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
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

function expenseExport(args: Record<string, unknown>, ctx: ToolContext): ToolResult {
  const db = ctx.db;
  const ledger = readLedger(args, ctx, "export");
  if (typeof ledger === "string") return fail(ledger);
  const ledgerId = ledger.id;
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

const expenseDispatch = defineActionTool({
  actions: {
    add: {
      fields: ["ledger_id", "amount", "category", "note", "date", "request_id"],
      handler: expenseAdd,
    },
    list: {
      fields: ["ledger_id", "month", "from", "to", "by", "limit", "offset"],
      handler: expenseList,
    },
    // summary 也支持 by（按记账人过滤），与 list 同口径
    summary: { fields: ["ledger_id", "month", "from", "to", "by"], handler: expenseSummary },
    update: {
      fields: ["id", "amount", "category", "note", "date", "ledger_id"],
      handler: expenseUpdate,
    },
    delete: { fields: ["id"], handler: expenseDelete },
    export: { fields: ["ledger_id", "month", "from", "to"], handler: expenseExport },
    // ledger 是 set_default_ledger 的既有简写参数（等价 ledger_id），不得误伤
    set_default_ledger: { fields: ["ledger_id", "ledger"], handler: expenseSetDefaultLedger },
    categories: { fields: [], handler: expenseCategories },
    category_alias: { fields: ["category", "alias", "remove"], handler: expenseCategoryAlias },
  },
});

export function bookkeepingExpenseTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    return expenseDispatch.handler(args, ctx);
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
        "账本管理：create 创建（personal=true 建个人账本，仅归属人可见可写；缺省建家庭账本，所有 Profile 共享）、list 列出当前 Profile 可见的账本（家庭账本 + 自己的个人账本；含归档需 include_archived）、rename 重命名、archive 归档/恢复（unarchive=true）、transfer 转移个人账本归属（带 profile 转给该 Profile，缺省转回家庭且不可逆；仅当前归属人可操作）、budget 月度预算（传 ledger_id 查看全部预算与本月对照；带 amount 设置/覆盖，单位元，带 category 为分类预算、缺省为账本总额；clear=true 删除该范围）。记账与预算不发推送通知。各 action 只接受自己的参数：传其它 action 的字段（如 create 传 amount）会明确报错，不静默忽略。",
      inputSchema: {
        action: ledgerDispatch.actionEnum(),
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
        ledger_id: z.string().optional().describe("budget 时的账本 id；可选，缺省走默认账本"),
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
        "支出记账：add 记一笔（amount 元必填；ledger_id 可选，缺省按「默认账本 → 唯一可写账本」解析；可选 category/note/date/request_id；记账不发推送通知；未显式传 category 时回执附「常用分类」）；list 明细（可按 month/from/to/by 过滤）；summary 汇总（按分类与记账人；不传区间默认本自然月全月）；update 更正一笔（id + amount/category/note/date 至少一个，只改显式传入的字段）；delete 删除记错的一笔（id 从 list 获取）；export 导出 CSV（可选 ledger_id 与 month，默认当月；表头「日期,账本,分类,金额(元),备注,记账人」，UTF-8 BOM；单次上限 2000 行，超出时 已截断=true 并给出总行数）；set_default_ledger 设置/查看默认账本（传 ledger_id 设置，不传则返回当前默认账本）；categories 列出分类字典（标准名+别名+近 90 天笔数/金额，字典为空时即近 90 天实际用过的分类）；category_alias 维护别名（category + alias 添加，remove=true 删除；别名命中后 add/update 会自动归一成标准名，未知分类仍按自由文本保存）。list 支持 offset 分页（回执带 已返回/偏移/匹配总数/还有更多）。仅能操作当前 Profile 可见的账本（家庭账本或自己的个人账本）。幂等：add 传 request_id 后，同一人用同一个 request_id 重试不会重复记账，返回原记录并附「已存在: true」。CSV 导出对以 = + - @ 或制表符/回车开头的文本单元格做公式注入中和。month 与 from/to 互斥（同时传会报错）；from/to 只给一边就是半边区间（只给 from = [from, 将来)，只给 to = (过去, to]），两个 action 口径一致；默认区间只在 month/from/to **都不传**时生效（summary 默认「月初→今天」，list 不传时不限区间）。金额只支持支出，单位为元。各 action 只接受自己的参数：传其它 action 的字段（如 export 传 by/limit、add 传 ledger 简写）会明确报错，不静默忽略。",
      inputSchema: {
        action: expenseDispatch.actionEnum(),
        id: z.string().optional().describe("update/delete 时的账目 id（从 list 获取）"),
        ledger_id: z
          .string()
          .optional()
          .describe(
            "账本 id；可选，缺省走默认账本（默认账本 → 唯一可写账本）；set_default_ledger 时传它指定默认账本",
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
});
