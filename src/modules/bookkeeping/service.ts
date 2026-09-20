import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { nowIso, todayIso, TZ } from "../../time.js";
import type { NotifyBlock } from "../../core/registry.js";
import { newId } from "../../core/settings.js";

/** 账本是全局资源：所有 Profile 均可读写，无角色/成员/授权层 */
export interface LedgerRow {
  id: string;
  name: string;
  created_at: string;
  archived_at: string | null;
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

export function createLedger(db: DatabaseSync, name: string): LedgerRow {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 40) throw new Error("账本名需为 1-40 字符");
  const dup = db
    .prepare("SELECT id FROM ledgers WHERE name = ? AND archived_at IS NULL")
    .get(trimmed);
  if (dup !== undefined) throw new Error(`已存在同名账本: ${trimmed}`);
  const id = newId();
  db.prepare("INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, ?)").run(
    id,
    trimmed,
    nowIso(),
  );
  return getLedger(db, id) as LedgerRow;
}

export function renameLedger(db: DatabaseSync, id: string, name: string): LedgerRow {
  const row = getLedger(db, id);
  if (row === undefined) throw new Error(`账本不存在: ${id}`);
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 40) throw new Error("账本名需为 1-40 字符");
  const dup = db
    .prepare("SELECT id FROM ledgers WHERE name = ? AND archived_at IS NULL AND id != ?")
    .get(trimmed, id);
  if (dup !== undefined) throw new Error(`已存在同名账本: ${trimmed}`);
  db.prepare("UPDATE ledgers SET name = ? WHERE id = ?").run(trimmed, id);
  return getLedger(db, id) as LedgerRow;
}

export function setLedgerArchived(db: DatabaseSync, id: string, archived: boolean): LedgerRow {
  const row = getLedger(db, id);
  if (row === undefined) throw new Error(`账本不存在: ${id}`);
  if (!archived) {
    // 归档→新建同名→恢复，会得到两个同名活跃账本：create/rename 的重名检查
    // 只覆盖「已存在且未归档」的账本，恢复路径此前完全没有检查。
    const dup = db
      .prepare("SELECT id FROM ledgers WHERE name = ? AND archived_at IS NULL AND id != ?")
      .get(row.name, id);
    if (dup !== undefined)
      throw new Error(`已有同名活跃账本「${row.name}」，请先改名或归档它再恢复`);
  }
  db.prepare("UPDATE ledgers SET archived_at = ? WHERE id = ?").run(archived ? nowIso() : null, id);
  return getLedger(db, id) as LedgerRow;
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
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(`金额不合法: ${String(input.amountCents)}（分为单位，需为正整数）`);
  }
  const category = (input.category ?? DEFAULT_CATEGORY).trim() || DEFAULT_CATEGORY;
  if (category.length > 20) throw new Error("分类过长（≤20 字符）");
  const note =
    input.note === undefined || input.note === null || input.note.trim() === ""
      ? null
      : input.note.trim();
  if (note !== null && note.length > 200) throw new Error("备注过长（≤200 字符）");
  const spentOn = input.spentOn ?? todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(spentOn) || !DateTime.fromISO(spentOn, { zone: TZ }).isValid) {
    throw new Error(`日期不合法: ${spentOn}`);
  }
  const id = newId();
  db.prepare(
    `INSERT INTO expenses (id, ledger_id, amount_cents, category, note, spent_on, created_by_profile, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.ledgerId, input.amountCents, category, note, spentOn, profileId, nowIso());
  return db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as unknown as ExpenseRow;
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

export function summarizeExpenses(
  db: DatabaseSync,
  ledgerId: string,
  opts: { from: string; to: string; by?: string },
): ExpenseSummary {
  const conditions = ["ledger_id = ?", "spent_on >= ?", "spent_on <= ?"];
  const params: string[] = [ledgerId, opts.from, opts.to];
  if (opts.by !== undefined) {
    conditions.push("created_by_profile = ?");
    params.push(opts.by);
  }
  const where = conditions.join(" AND ");
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
}

export function monthRange(ym: string): { from: string; to: string } {
  if (!/^\d{4}-\d{2}$/.test(ym)) throw new Error(`月份格式需为 YYYY-MM: ${ym}`);
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));
  if (month < 1 || month > 12) throw new Error(`月份不合法: ${ym}`);
  const from = `${ym}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from, to: `${ym}-${String(lastDay).padStart(2, "0")}` };
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
    const before = after - entry.amount_cents;
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
    alerts.push({
      kind: "bookkeeping.budget",
      title: `${crossed === 80 ? "预算提醒" : "预算超支"} · ${ledger.name}`,
      blocks: budgetAlertBlocks(status),
      dedupeKey: `budget:${ledger.id}:${budget.category === "" ? "-" : budget.category}:${ym}:${crossed}`,
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
 * 月报推送：全局事件，物化到每个配置了路由的 Profile（Profile 内去重）。
 *
 * 覆盖**含已归档**的账本：9 月 15 日归档的账本仍持有 9 月的支出，若只遍历活跃
 * 账本，该账本的当月账单永远不会发出（且没有任何提示）。空账本由 count === 0 跳过。
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
  },
  ym: string,
): Promise<number> {
  const { from, to } = monthRange(ym);
  let pushed = 0;
  for (const ledger of listLedgers(db, true)) {
    const summary = summarizeExpenses(db, ledger.id, { from, to });
    if (summary.count === 0) continue;
    const budget = getBudgets(db, ledger.id).length > 0 ? budgetStatus(db, ledger.id, ym) : null;
    const result = await services.publishGlobal({
      kind: "bookkeeping.monthly",
      title: `${ym} 月度账单 · ${ledger.name}`,
      blocks: monthlyReportBlocks(summary, budget),
      dedupeKey: `report:${ledger.id}:${ym}`,
    });
    pushed += result.materialized;
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
  /** 未推送过年月账单的账本+月份 */
  missing: Array<{ ledger_id: string; ledger_name: string; ym: string }>;
}

/**
 * 找出「有支出但从未推送过」的历史月份账单。
 * node-cron 不会补发错过的触发：1 号 09:00 停机就永久丢失该月账单。
 * 靠 notifications.dedupe_key 判断是否推过，因此重复调用是幂等的。
 */
export function findMissingMonthlyReports(
  db: DatabaseSync,
  lookbackMonths = 6,
  today: string = todayIso(),
): MonthlyCatchup {
  const missing: MonthlyCatchup["missing"] = [];
  const currentYm = today.slice(0, 7);
  const months: string[] = [];
  for (let i = lookbackMonths; i >= 1; i--) {
    months.push(
      DateTime.fromISO(`${currentYm}-01`, { zone: TZ }).minus({ months: i }).toFormat("yyyy-MM"),
    );
  }
  for (const ledger of listLedgers(db, true)) {
    for (const ym of months) {
      if (monthlyReportPublished(db, ledger.id, ym)) continue;
      if (summarizeExpenses(db, ledger.id, monthRange(ym)).count === 0) continue;
      missing.push({ ledger_id: ledger.id, ledger_name: ledger.name, ym });
    }
  }
  return { missing };
}
