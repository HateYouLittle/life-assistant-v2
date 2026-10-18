import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { nowIso, todayIso, TZ } from "../../time.js";
import { withReadTransaction } from "../../core/database.js";
import type { NotifyBlock } from "../../core/registry.js";
import { newId } from "../../core/settings.js";

/** 账本归属：owner_profile_id = NULL 为家庭账本（所有 Profile 共享）；非空为个人账本（仅归属人可见可写） */
export interface LedgerRow {
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
  owner_profile_id: string | null;
}

export interface ExpenseRow {
  id: string;
  ledger_id: string;
  amount_cents: number;
  category: string;
  note: string | null;
  spent_on: string;
  created_by_profile: string;
  created_at: string;
}

export const DEFAULT_CATEGORY = "其他";

export function centsToYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function getLedger(db: DatabaseSync, id: string): LedgerRow | undefined {
  return db.prepare("SELECT * FROM ledgers WHERE id = ?").get(id) as LedgerRow | undefined;
}

export function listLedgers(db: DatabaseSync, includeArchived = false): LedgerRow[] {
  const where = includeArchived ? "" : "WHERE archived_at IS NULL";
  return db
    .prepare(`SELECT * FROM ledgers ${where} ORDER BY created_at`)
    .all() as unknown as LedgerRow[];
}

/**
 * 同一「范围」内是否已有活动同名账本。范围 = 家庭（owner_profile_id IS NULL）或某个
 * Profile 的个人账本。SQLite 的 `IS` 对 NULL 与具体值都成立（`IS NULL` / `IS 'x'`），
 * 因此一个参数即可同时表达两种范围。excludeId 用于改名/恢复/转移时排除自身。
 */
function activeLedgerWithName(
  db: DatabaseSync,
  name: string,
  ownerProfileId: string | null,
  excludeId?: string,
): boolean {
  const params: (string | null)[] = [name, ownerProfileId];
  let sql =
    "SELECT 1 FROM ledgers WHERE name = ? AND archived_at IS NULL AND (owner_profile_id IS ?)";
  if (excludeId !== undefined) {
    sql += " AND id != ?";
    params.push(excludeId);
  }
  return db.prepare(`${sql} LIMIT 1`).get(...params) !== undefined;
}

export function createLedger(
  db: DatabaseSync,
  name: string,
  ownerProfileId: string | null = null,
): LedgerRow {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 40) throw new Error("账本名需为 1-40 字符");
  if (activeLedgerWithName(db, trimmed, ownerProfileId)) {
    throw new Error(`已存在同名账本: ${trimmed}`);
  }
  const id = newId();
  db.prepare(
    "INSERT INTO ledgers (id, name, created_at, owner_profile_id) VALUES (?, ?, ?, ?)",
  ).run(id, trimmed, nowIso(), ownerProfileId);
  return getLedger(db, id) as LedgerRow;
}

/**
 * 归属可见性：家庭账本（owner_profile_id = NULL）对所有 Profile 可见；
 * 个人账本仅归属人本身可见。不可见一律以「账本不存在」对外（不泄露其存在）。
 */
export function isLedgerVisible(ledger: LedgerRow, profileId: string): boolean {
  return ledger.owner_profile_id === null || ledger.owner_profile_id === profileId;
}

/** 取一个对 profileId 可见的账本；不存在或不可见均返回 undefined，由调用方报「账本不存在」 */
export function getVisibleLedger(
  db: DatabaseSync,
  id: string,
  profileId: string,
): LedgerRow | undefined {
  const ledger = getLedger(db, id);
  if (ledger === undefined || !isLedgerVisible(ledger, profileId)) return undefined;
  return ledger;
}

/**
 * 转移账本归属：仅个人账本可转移（家庭 → 个人永不允许）。
 * targetOwnerId 为 null 表示转回家庭（不可逆）；非 null 时该 Profile 必须已存在。
 * 调用方负责校验调用者是当前归属人。
 */
export function transferLedger(
  db: DatabaseSync,
  id: string,
  targetOwnerId: string | null,
): LedgerRow {
  const ledger = getLedger(db, id);
  if (ledger === undefined) throw new Error(`账本不存在: ${id}`);
  if (ledger.owner_profile_id === null) {
    throw new Error("家庭账本不支持转移（家庭账本不能转为个人账本）");
  }
  if (targetOwnerId !== null) {
    const target = db.prepare("SELECT id FROM profiles WHERE id = ?").get(targetOwnerId);
    if (target === undefined) throw new Error(`目标 Profile 不存在: ${targetOwnerId}`);
  }
  // 转归属=换到另一个「范围」：目标范围已有同名活动账本时会撞唯一索引。
  // 提前给出可操作报错，而不是把 UNIQUE 约束错误原样抛给用户。
  if (activeLedgerWithName(db, ledger.name, targetOwnerId, id)) {
    throw new Error(
      targetOwnerId === null
        ? `家庭账本里已有同名活跃账本「${ledger.name}」，请先改名再转回家庭`
        : `目标 Profile「${targetOwnerId}」已有同名活跃账本「${ledger.name}」，请先改名`,
    );
  }
  db.prepare("UPDATE ledgers SET owner_profile_id = ? WHERE id = ?").run(targetOwnerId, id);
  return getLedger(db, id) as LedgerRow;
}

export function renameLedger(db: DatabaseSync, id: string, name: string): LedgerRow {
  const row = getLedger(db, id);
  if (row === undefined) throw new Error(`账本不存在: ${id}`);
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 40) throw new Error("账本名需为 1-40 字符");
  if (activeLedgerWithName(db, trimmed, row.owner_profile_id, id)) {
    throw new Error(`已存在同名账本: ${trimmed}`);
  }
  db.prepare("UPDATE ledgers SET name = ? WHERE id = ?").run(trimmed, id);
  return getLedger(db, id) as LedgerRow;
}

export function setLedgerArchived(db: DatabaseSync, id: string, archived: boolean): LedgerRow {
  const row = getLedger(db, id);
  if (row === undefined) throw new Error(`账本不存在: ${id}`);
  if (!archived) {
    // 归档→新建同名→恢复，会在同一范围内得到两个同名活跃账本：create/rename 的重名检查
    // 只覆盖「已存在且未归档」的账本，恢复路径此前完全没有检查。
    if (activeLedgerWithName(db, row.name, row.owner_profile_id, id)) {
      throw new Error(`已有同名活跃账本「${row.name}」，请先改名或归档它再恢复`);
    }
  }
  db.prepare("UPDATE ledgers SET archived_at = ? WHERE id = ?").run(archived ? nowIso() : null, id);
  return getLedger(db, id) as LedgerRow;
}

/** 金额校验：内部单位为整数分、必须为正整数（新增与编辑共用同一口径） */
function assertValidAmountCents(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`金额不合法: ${String(amountCents)}（分为单位，需为正整数）`);
  }
}

/** 分类归一：缺省/空白回落到「其他」；上限 20 字符 */
function normalizedCategory(category: string | undefined): string {
  const value = (category ?? DEFAULT_CATEGORY).trim() || DEFAULT_CATEGORY;
  if (value.length > 20) throw new Error("分类过长（≤20 字符）");
  return value;
}

/** 备注归一：缺省/空白 → NULL；上限 200 字符 */
function normalizedNote(note: string | null | undefined): string | null {
  const value = note === undefined || note === null || note.trim() === "" ? null : note.trim();
  if (value !== null && value.length > 200) throw new Error("备注过长（≤200 字符）");
  return value;
}

/** 花费日期：本地日历日 YYYY-MM-DD，缺省今天 */
function normalizedSpentOn(spentOn: string | undefined): string {
  const value = spentOn ?? todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !DateTime.fromISO(value, { zone: TZ }).isValid) {
    throw new Error(`日期不合法: ${value}`);
  }
  return value;
}

export function addExpense(
  db: DatabaseSync,
  profileId: string,
  input: {
    ledgerId: string;
    amountCents: number;
    category?: string;
    note?: string | null;
    spentOn?: string;
  },
): ExpenseRow {
  const ledger = getLedger(db, input.ledgerId);
  if (ledger === undefined) throw new Error(`账本不存在: ${input.ledgerId}`);
  if (ledger.archived_at !== null) throw new Error(`账本已归档: ${ledger.name}`);
  assertValidAmountCents(input.amountCents);
  const category = normalizedCategory(input.category);
  const note = normalizedNote(input.note);
  const spentOn = normalizedSpentOn(input.spentOn);
  const id = newId();
  db.prepare(
    `INSERT INTO expenses (id, ledger_id, amount_cents, category, note, spent_on, created_by_profile, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.ledgerId, input.amountCents, category, note, spentOn, profileId, nowIso());
  return db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as unknown as ExpenseRow;
}

export function getExpense(db: DatabaseSync, id: string): ExpenseRow | undefined {
  return db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as ExpenseRow | undefined;
}

export interface ExpensePatch {
  amountCents?: number;
  category?: string;
  note?: string | null;
  spentOn?: string;
}

/**
 * 更正一笔已记支出：只更新显式传入的字段，其余保持原值；校验口径与 addExpense 完全一致
 * （共用同一组归一函数）。记账人、创建时间与所属账本不参与编辑。
 *
 * 编辑只做「更正」：不发布回执、不重新判定预算阈值、不保留修改前值
 * （见 README「已知取舍」第 14 条）——回执/预算提醒只由 addExpense 的调用方触发。
 */
export function updateExpense(db: DatabaseSync, id: string, patch: ExpensePatch): ExpenseRow {
  const existing = getExpense(db, id);
  if (existing === undefined) throw new Error(`账目不存在: ${id}`);
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.amountCents !== undefined) {
    assertValidAmountCents(patch.amountCents);
    sets.push("amount_cents = ?");
    params.push(patch.amountCents);
  }
  if (patch.category !== undefined) {
    sets.push("category = ?");
    params.push(normalizedCategory(patch.category));
  }
  if (patch.note !== undefined) {
    sets.push("note = ?");
    params.push(normalizedNote(patch.note));
  }
  if (patch.spentOn !== undefined) {
    sets.push("spent_on = ?");
    params.push(normalizedSpentOn(patch.spentOn));
  }
  // 空 patch 不是「无操作成功」：调用方多半是漏传了参数，静默返回原值会让 agent 误以为改成了
  if (sets.length === 0) {
    throw new Error("没有需要更新的字段（amount_cents/category/note/spent_on 至少一个）");
  }
  db.prepare(`UPDATE expenses SET ${sets.join(", ")} WHERE id = ?`).run(...params, id);
  return getExpense(db, id) as ExpenseRow;
}

export function deleteExpense(db: DatabaseSync, id: string): ExpenseRow {
  const row = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as ExpenseRow | undefined;
  if (row === undefined) throw new Error(`账目不存在: ${id}`);
  db.prepare("DELETE FROM expenses WHERE id = ?").run(id);
  return row;
}

export function listExpenses(
  db: DatabaseSync,
  ledgerId: string,
  opts: { from?: string; to?: string; by?: string; limit?: number } = {},
): { rows: ExpenseRow[]; total: number; hasMore: boolean } {
  const conditions = ["ledger_id = ?"];
  const params: (string | number)[] = [ledgerId];
  if (opts.from !== undefined) {
    conditions.push("spent_on >= ?");
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    conditions.push("spent_on <= ?");
    params.push(opts.to);
  }
  if (opts.by !== undefined) {
    conditions.push("created_by_profile = ?");
    params.push(opts.by);
  }
  const where = conditions.join(" AND ");
  // 下限也要 clamp：SQLite 把负 LIMIT 当作「不限量」，limit:-1 会返回全表
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 200));
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM expenses WHERE ${where}`)
    .get(...params) as { n: number };
  const rows = db
    .prepare(
      `SELECT * FROM expenses WHERE ${where} ORDER BY spent_on DESC, created_at DESC LIMIT ?`,
    )
    .all(...params, limit) as unknown as ExpenseRow[];
  return { rows, total: totalRow.n, hasMore: totalRow.n > rows.length };
}

export interface ExpenseSummary {
  total_cents: number;
  count: number;
  categories: Array<{ category: string; cents: number; share: number }>;
  profiles: Array<{ profile: string; cents: number }>;
}

/**
 * 汇总。`from`/`to` 都可缺省（缺哪边就不加哪边的条件），与 listExpenses 同口径：
 * 调用方只给单边时必须与 list 覆盖同一集合，逐边补默认会让两个 action 结论相反。
 */
export function summarizeExpenses(
  db: DatabaseSync,
  ledgerId: string,
  opts: { from?: string; to?: string; by?: string },
): ExpenseSummary {
  const conditions = ["ledger_id = ?"];
  const params: (string | number)[] = [ledgerId];
  if (opts.from !== undefined) {
    conditions.push("spent_on >= ?");
    params.push(opts.from);
  }
  if (opts.to !== undefined) {
    conditions.push("spent_on <= ?");
    params.push(opts.to);
  }
  if (opts.by !== undefined) {
    conditions.push("created_by_profile = ?");
    params.push(opts.by);
  }
  const where = conditions.join(" AND ");
  // 三条独立语句必须读同一快照：否则并发的记账写入落在两者之间时，
  // 「合计」会与「分类明细」对不上（share 也随之失真）。
  return withReadTransaction(db, () => {
    const range = db
      .prepare(
        `SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS count FROM expenses WHERE ${where}`,
      )
      .get(...params) as { total: number; count: number };
    const categories = db
      .prepare(
        `SELECT category, SUM(amount_cents) AS cents FROM expenses WHERE ${where} GROUP BY category ORDER BY cents DESC`,
      )
      .all(...params) as { category: string; cents: number }[];
    const profiles = db
      .prepare(
        `SELECT created_by_profile AS profile, SUM(amount_cents) AS cents FROM expenses WHERE ${where} GROUP BY created_by_profile ORDER BY cents DESC`,
      )
      .all(...params) as { profile: string; cents: number }[];
    return {
      total_cents: range.total,
      count: range.count,
      categories: categories.map((c) => ({
        category: c.category,
        cents: c.cents,
        share: range.total > 0 ? c.cents / range.total : 0,
      })),
      profiles: profiles.map((p) => ({ profile: p.profile, cents: p.cents })),
    };
  });
}

/**
 * 「本月」区间 = 自然月全月（月初 → 月末），**含月内尚未到来的日期**。
 *
 * 口径依据：spent_on 是已录入的记账事实，指定了未来日期就是「这笔钱记在那天」，
 * 状态页本月支出、预算对照、月报三处都按同一区间算 —— 若这里再加一道「≤今天」上界，
 * 同一个「本月」数字会随日历推移忽增忽减（月初看不全、月中突然跳变），对不上账。
 *
 * 工具侧 `expense summary` 不传 month/from/to 时的默认区间是「月初 → 今天」，
 * 那是「本月至今」的查询默认，与本函数（状态页/月报/预算）有意不同，见 modules/bookkeeping/index.ts。
 */
export function monthRange(ym: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`月份格式需为 YYYY-MM: ${ym}`);
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));
  if (month < 1 || month > 12) throw new Error(`月份不合法: ${ym}`);
  const from = `${ym}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${ym}-${String(lastDay).padStart(2, "0")}` };
}

/** CSV 表头（固定顺序，工具与 HTTP 导出共用） */
export const EXPENSE_CSV_HEADER = ["日期", "账本", "分类", "金额(元)", "备注", "记账人"] as const;
/** MCP 单次导出上限：超过时截断并置 已截断=true，提示调用方缩小范围 */
export const EXPENSE_CSV_MAX_ROWS = 2000;
/** UTF-8 BOM：Excel 打开中文 CSV 必须靠它识别编码，否则整列乱码 */
const CSV_BOM = "\uFEFF";

/**
 * CSV 单元格转义（RFC 4180）：含逗号、双引号、CR 或 LF 的字段整体加双引号，
 * 字段内部的双引号写成两个。其他字段原样输出（不加不必要的引号）。
 */
export function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export interface ExpenseCsvOptions {
  /** 指定账本；缺省 = 全部家庭账本（看板口径，个人账本不出现） */
  ledgerId?: string;
  /** 自然月 YYYY-MM（与看板「本月」同口径：整月，含月内未来日） */
  month: string;
  /** 行数上限；缺省不限（HTTP 按月导出不截断，MCP 导出传 EXPENSE_CSV_MAX_ROWS） */
  limit?: number;
}

export interface ExpenseCsvResult {
  /** 带 UTF-8 BOM、CRLF 换行的完整 CSV 文本（每行含末尾 CRLF） */
  csv: string;
  /** 实际导出的数据行数（不含表头） */
  rows: number;
  /** 匹配的总行数；rows < total 表示已截断 */
  total: number;
  truncated: boolean;
}

/** 下载文件名（只含 ASCII，可直接放进 Content-Disposition 的 filename=） */
export function expenseCsvFilename(month: string): string {
  return `expenses-${month}.csv`;
}

/**
 * 按月导出支出 CSV。排序固定为 `spent_on ASC, created_at ASC`，同一毫秒写入的多笔
 * 再按 id 升序，保证同一份数据的导出结果稳定可 diff。
 *
 * `ledgerId` 缺省时只导家庭账本（`owner_profile_id IS NULL`），与 `/api/expenses`
 * 看板口径一致；个人账本必须显式指定 ledgerId（MCP export 走可见性校验）。
 */
export function expenseCsv(db: DatabaseSync, opts: ExpenseCsvOptions): ExpenseCsvResult {
  const { from, to } = monthRange(opts.month);
  // 下限也要 clamp：SQLite 把负 LIMIT 当作「不限量」，limit:-1 会返回全表
  const limit = opts.limit === undefined ? undefined : Math.max(1, Math.trunc(opts.limit));
  const conditions = ["e.spent_on >= ?", "e.spent_on <= ?"];
  const params: (string | number)[] = [from, to];
  if (opts.ledgerId === undefined) {
    conditions.push("l.owner_profile_id IS NULL");
  } else {
    conditions.push("e.ledger_id = ?");
    params.push(opts.ledgerId);
  }
  const where = conditions.join(" AND ");
  // 计数与取数必须读同一快照：否则并发记账落在两条语句之间时，行数/截断标记与 CSV 对不上
  return withReadTransaction(db, () => {
    const total = (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM expenses e JOIN ledgers l ON l.id = e.ledger_id WHERE ${where}`,
        )
        .get(...params) as { n: number }
    ).n;
    const select = db.prepare(
      `SELECT e.spent_on, l.name AS ledger_name, e.category, e.amount_cents, e.note,
              e.created_by_profile
       FROM expenses e JOIN ledgers l ON l.id = e.ledger_id
       WHERE ${where}
       ORDER BY e.spent_on ASC, e.created_at ASC, e.id ASC
       ${limit === undefined ? "" : "LIMIT ?"}`,
    );
    const rows = (limit === undefined
      ? select.all(...params)
      : select.all(...params, limit)) as unknown as Array<{
      spent_on: string;
      ledger_name: string;
      category: string;
      amount_cents: number;
      note: string | null;
      created_by_profile: string;
    }>;
    const lines = [EXPENSE_CSV_HEADER.map(csvField).join(",")];
    for (const row of rows) {
      lines.push(
        [
          csvField(row.spent_on),
          csvField(row.ledger_name),
          csvField(row.category),
          centsToYuan(row.amount_cents),
          csvField(row.note ?? ""),
          csvField(row.created_by_profile),
        ].join(","),
      );
    }
    return {
      csv: `${CSV_BOM}${lines.join("\r\n")}\r\n`,
      rows: rows.length,
      total,
      truncated: total > rows.length,
    };
  });
}

export interface BudgetRow {
  id: string;
  ledger_id: string;
  category: string;
  amount_cents: number;
  created_at: string;
  updated_at: string;
}

export interface BudgetStatus {
  total: { budget_cents: number; spent_cents: number; ratio: number } | null;
  categories: Array<{
    category: string;
    budget_cents: number;
    spent_cents: number;
    ratio: number;
  }>;
}

/** 触达阈值（百分比）；跨越（而非达到）才推送，见 budgetAlertsForEntry */
export const BUDGET_THRESHOLDS = [80, 100] as const;

export interface BudgetAlert {
  kind: string;
  title: string;
  blocks: NotifyBlock;
  dedupeKey: string;
}

/** 预算范围标签：'' 是账本总额预算，其余为分类预算 */
export function budgetScopeLabel(category: string): string {
  return category === "" ? "总额" : category;
}

/** 预算对照的四个字段（工具回显与月报/提醒复用） */
export function budgetComparison(
  budgetCents: number,
  spentCents: number,
): { 预算: string; 已用: string; 剩余: string; 占比: string } {
  const remaining = budgetCents - spentCents;
  return {
    预算: `¥${centsToYuan(budgetCents)}`,
    已用: `¥${centsToYuan(spentCents)}`,
    剩余: remaining < 0 ? `-¥${centsToYuan(-remaining)}` : `¥${centsToYuan(remaining)}`,
    占比: `${((spentCents / budgetCents) * 100).toFixed(1)}%`,
  };
}

/** upsert 预算；账本不存在抛错 */
export function setBudget(
  db: DatabaseSync,
  ledgerId: string,
  category: string,
  amountCents: number,
): BudgetRow {
  const ledger = getLedger(db, ledgerId);
  if (ledger === undefined) throw new Error(`账本不存在: ${ledgerId}`);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error(`预算金额不合法: ${String(amountCents)}（分为单位，需为正整数）`);
  }
  const scope = category.trim();
  if (scope.length > 20) throw new Error("分类过长（≤20 字符）");
  const now = nowIso();
  db.prepare(
    `INSERT INTO budgets (id, ledger_id, category, amount_cents, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(ledger_id, category)
     DO UPDATE SET amount_cents = excluded.amount_cents, updated_at = excluded.updated_at`,
  ).run(newId(), ledgerId, scope, amountCents, now, now);
  return db
    .prepare("SELECT * FROM budgets WHERE ledger_id = ? AND category = ?")
    .get(ledgerId, scope) as unknown as BudgetRow;
}

export function getBudgets(db: DatabaseSync, ledgerId: string): BudgetRow[] {
  return db
    .prepare("SELECT * FROM budgets WHERE ledger_id = ? ORDER BY category")
    .all(ledgerId) as unknown as BudgetRow[];
}

export function clearBudget(db: DatabaseSync, ledgerId: string, category: string): boolean {
  const result = db
    .prepare("DELETE FROM budgets WHERE ledger_id = ? AND category = ?")
    .run(ledgerId, category.trim());
  return result.changes > 0;
}

/** 该账本在 ym 当月的预算对照；复用 summarizeExpenses，不另写聚合 SQL */
export function budgetStatus(db: DatabaseSync, ledgerId: string, ym: string): BudgetStatus {
  const { from, to } = monthRange(ym);
  const summary = summarizeExpenses(db, ledgerId, { from, to });
  const spentByCategory = new Map(summary.categories.map((c) => [c.category, c.cents]));
  let total: BudgetStatus["total"] = null;
  const categories: BudgetStatus["categories"] = [];
  for (const budget of getBudgets(db, ledgerId)) {
    if (budget.category === "") {
      total = {
        budget_cents: budget.amount_cents,
        spent_cents: summary.total_cents,
        ratio: summary.total_cents / budget.amount_cents,
      };
    } else {
      const spent = spentByCategory.get(budget.category) ?? 0;
      categories.push({
        category: budget.category,
        budget_cents: budget.amount_cents,
        spent_cents: spent,
        ratio: spent / budget.amount_cents,
      });
    }
  }
  return { total, categories };
}

export function budgetAlertBlocks(status: BudgetStatus): NotifyBlock {
  const rows: string[][] = [];
  const add = (label: string, budgetCents: number, spentCents: number): void => {
    const c = budgetComparison(budgetCents, spentCents);
    rows.push([label, c.预算, c.已用, c.剩余, c.占比]);
  };
  if (status.total !== null) add("总额", status.total.budget_cents, status.total.spent_cents);
  for (const cat of status.categories) add(cat.category, cat.budget_cents, cat.spent_cents);
  return { table: { columns: ["项目", "预算", "已用", "剩余", "占比"], rows } };
}

/**
 * 判定该笔支出「跨越」了哪个预算阈值（只推跨过的那一刻，达到即推会每笔都发）。
 * 本笔金额已知：before = after - entry.amount_cents，不重复查库。整数比较避免浮点误差。
 * 同一个预算（总额或某个分类）在一笔支出里只推「跨过的最高阈值」那一条：
 * 一笔从 0% 到 150% 只推 100%，从 70% 到 90% 只推 80%。
 * 总额与分类预算各自独立判定，都命中就各返回一条。
 */
export function budgetAlertsForEntry(
  db: DatabaseSync,
  ledger: LedgerRow,
  entry: ExpenseRow,
): BudgetAlert[] {
  const budgets = getBudgets(db, ledger.id);
  if (budgets.length === 0) return [];
  const ym = entry.spent_on.slice(0, 7);
  const summary = summarizeExpenses(db, ledger.id, monthRange(ym));
  const spentByCategory = new Map(summary.categories.map((c) => [c.category, c.cents]));
  const alerts: BudgetAlert[] = [];
  for (const budget of budgets) {
    const after =
      budget.category === "" ? summary.total_cents : (spentByCategory.get(budget.category) ?? 0);
    // 只有本笔确实计入该预算范围时，才能用它反推「记账前」：总额预算总是计入；
    // 分类预算仅当本笔分类与预算分类一致时计入。否则一笔无关分类的支出会把
    // before 人为压低，制造一次并不存在的「跨越阈值」提醒（如记交通却推餐饮超支）。
    const countsThisEntry = budget.category === "" || budget.category === entry.category;
    const before = countsThisEntry ? after - entry.amount_cents : after;
    const crossed = [...BUDGET_THRESHOLDS]
      .reverse()
      .find(
        (threshold) =>
          before * 100 < budget.amount_cents * threshold &&
          after * 100 >= budget.amount_cents * threshold,
      );
    if (crossed === undefined) continue;
    const item = {
      budget_cents: budget.amount_cents,
      spent_cents: after,
      ratio: after / budget.amount_cents,
    };
    const status: BudgetStatus =
      budget.category === ""
        ? { total: item, categories: [] }
        : { total: null, categories: [{ category: budget.category, ...item }] };
    // dedupeKey 的范围编码：总额用空串、分类用原分类名（setBudget 把空分类归一成总额，
    // 因此二者不歧义）。刻意不改分类的编码：既有分类提醒的键保持连续、升级后不会重推；
    // 总额键从旧编码的 `-` 变为空串，升级当月同一总额阈值最多多推一次。
    const scopeKey = budget.category === "" ? "" : budget.category;
    alerts.push({
      kind: "bookkeeping.budget",
      title: `${crossed === 80 ? "预算提醒" : "预算超支"} · ${ledger.name}`,
      blocks: budgetAlertBlocks(status),
      dedupeKey: `budget:${ledger.id}:${scopeKey}:${ym}:${crossed}`,
    });
  }
  return alerts;
}

/** 上一个月（按 Asia/Shanghai 本地月份，避免 UTC 月初/月末错位） */
export function previousMonth(now: Date = new Date()): string {
  const local = DateTime.fromJSDate(now, { zone: TZ });
  return local.month === 1
    ? `${local.year - 1}-12`
    : `${local.year}-${String(local.month - 1).padStart(2, "0")}`;
}

export function monthlyReportBlocks(
  summary: ExpenseSummary,
  budget: BudgetStatus | null = null,
): NotifyBlock {
  const rows = summary.categories.map((c) => [
    c.category,
    `¥${centsToYuan(c.cents)}`,
    `${(c.share * 100).toFixed(1)}%`,
  ]);
  rows.push(["合计", `¥${centsToYuan(summary.total_cents)}`, "100%"]);
  const notes = [`共 ${summary.count} 笔`];
  if (summary.profiles.length > 1) {
    notes.push(
      `记账人：${summary.profiles.map((p) => `${p.profile} ¥${centsToYuan(p.cents)}`).join("、")}`,
    );
  }
  // 只有设了预算的账本才追加预算对照，未设预算的月报保持原样（不出现空行/「未设预算」噪音）
  if (budget !== null) {
    if (budget.total !== null) {
      notes.push(budgetComparisonLine("总额", budget.total.budget_cents, budget.total.spent_cents));
    }
    for (const cat of budget.categories) {
      notes.push(budgetComparisonLine(cat.category, cat.budget_cents, cat.spent_cents));
    }
  }
  return { table: { columns: ["分类", "金额", "占比"], rows }, notes };
}

function budgetComparisonLine(label: string, budgetCents: number, spentCents: number): string {
  const c = budgetComparison(budgetCents, spentCents);
  return `预算对照 · ${label}：预算 ${c.预算} / 已用 ${c.已用} / 剩余 ${c.剩余} / 占比 ${c.占比}`;
}

export function entryReceiptBlocks(ledger: LedgerRow, entry: ExpenseRow): NotifyBlock {
  const rows: string[][] = [
    ["账本", ledger.name],
    ["金额", `¥${centsToYuan(entry.amount_cents)}`],
    ["分类", entry.category],
    ["日期", entry.spent_on],
    ["记账人", entry.created_by_profile],
  ];
  if (entry.note !== null) rows.push(["备注", entry.note]);
  return { table: { columns: ["项目", "内容"], rows } };
}

/**
 * 月报推送：家庭账本物化到每个配置了路由的 Profile（publishGlobal，Profile 内去重）；
 * 个人账本只推给归属人（publishProfile），其他 Profile 不收到任何内容。
 *
 * 覆盖**含已归档**的账本：9 月 15 日归档的账本仍持有 9 月的支出，若只遍历活跃
 * 账本，该账本的当月账单永远不会发出（且没有任何提示）。空账本由 count === 0 跳过。
 *
 * 归属变更与重复：月报 dedupeKey 为 `report:<ledgerId>:<ym>`，对家庭账本而言同一份
 * 账单物化到多个 Profile，对个人账本只物化到归属人。findMissingMonthlyReports 按
 * dedupe_key **全局**判断「该月是否已发过」，因此账本在当月中转归属后不会被补发成
 * 两份；即便本函数在转归属后被再次调用，publishProfile/publishGlobal 的 Profile 内
 * 去重也会吞掉重复（归属人此前已收到该月账单时不会再来一份）。
 */
export async function pushMonthlyReports(
  db: DatabaseSync,
  services: {
    publishGlobal(input: {
      kind: string;
      title: string;
      blocks: NotifyBlock;
      dedupeKey?: string;
    }): Promise<{ materialized: number }>;
    publishProfile(
      profileId: string,
      input: {
        kind: string;
        title: string;
        blocks: NotifyBlock;
        dedupeKey?: string;
      },
    ): Promise<{ deduped: boolean }>;
  },
  ym: string,
): Promise<number> {
  const { from, to } = monthRange(ym);
  let pushed = 0;
  for (const ledger of listLedgers(db, true)) {
    const summary = summarizeExpenses(db, ledger.id, { from, to });
    if (summary.count === 0) continue;
    const budget = getBudgets(db, ledger.id).length > 0 ? budgetStatus(db, ledger.id, ym) : null;
    const input = {
      kind: "bookkeeping.monthly",
      title: `${ym} 月度账单 · ${ledger.name}`,
      blocks: monthlyReportBlocks(summary, budget),
      dedupeKey: `report:${ledger.id}:${ym}`,
    };
    if (ledger.owner_profile_id === null) {
      const result = await services.publishGlobal(input);
      pushed += result.materialized;
    } else {
      const result = await services.publishProfile(ledger.owner_profile_id, input);
      if (!result.deduped) pushed += 1;
    }
  }
  return pushed;
}

/** 该月的月报是否已推送过（用 dedupeKey 判断，便于补发时保持幂等） */
export function monthlyReportPublished(db: DatabaseSync, ledgerId: string, ym: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM notifications WHERE dedupe_key = ? LIMIT 1")
    .get(`report:${ledgerId}:${ym}`);
  return row !== undefined;
}

export interface MonthlyCatchup {
  /** 未推送过年月账单的账本+月份（会由 job 补发） */
  missing: Array<{ ledger_id: string; ledger_name: string; ym: string }>;
  /**
   * 有支出、从未推送过、但**早于回看窗口**的月份：不会自动补发（窗口外），
   * 仅用于日志告警 —— 停机超过窗口时这些月报会永久丢失，先让运维看得见。
   */
  tooOld: Array<{ ledger_id: string; ledger_name: string; ym: string }>;
}

/**
 * 找出「有支出但从未推送过」的历史月份账单。
 * node-cron 不会补发错过的触发：1 号 09:00 停机就永久丢失该月账单。
 * 靠 notifications.dedupe_key 判断是否推过，因此重复调用是幂等的。
 *
 * 回看窗口默认 6 个月；窗口外（再多查一个等长窗口，避免全历史扫描）有支出却从未
 * 推送过的月份记入 `tooOld`，由调用方告警 —— 否则「补发只覆盖最近 6 个月」会毫无提示。
 */
export function findMissingMonthlyReports(
  db: DatabaseSync,
  lookbackMonths = 6,
  today: string = todayIso(),
): MonthlyCatchup {
  const missing: MonthlyCatchup["missing"] = [];
  const tooOld: MonthlyCatchup["tooOld"] = [];
  const currentYm = today.slice(0, 7);
  const firstOfMonth = DateTime.fromISO(`${currentYm}-01`, { zone: TZ });
  const monthOf = (i: number): string => firstOfMonth.minus({ months: i }).toFormat("yyyy-MM");
  // 窗口内：i = lookbackMonths..1；窗口外只多查一个等长窗口（i = 2*lookbackMonths..lookbackMonths+1）
  const inWindow = Array.from({ length: lookbackMonths }, (_, k) => monthOf(lookbackMonths - k));
  const outOfWindow = Array.from({ length: lookbackMonths }, (_, k) =>
    monthOf(lookbackMonths * 2 - k),
  );
  for (const ledger of listLedgers(db, true)) {
    for (const ym of inWindow) {
      if (monthlyReportPublished(db, ledger.id, ym)) continue;
      if (summarizeExpenses(db, ledger.id, monthRange(ym)).count === 0) continue;
      missing.push({ ledger_id: ledger.id, ledger_name: ledger.name, ym });
    }
    for (const ym of outOfWindow) {
      if (monthlyReportPublished(db, ledger.id, ym)) continue;
      if (summarizeExpenses(db, ledger.id, monthRange(ym)).count === 0) continue;
      tooOld.push({ ledger_id: ledger.id, ledger_name: ledger.name, ym });
    }
  }
  return { missing, tooOld };
}
