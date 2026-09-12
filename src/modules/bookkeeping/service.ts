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
  return db.prepare(`SELECT * FROM ledgers ${where} ORDER BY created_at`).all() as unknown as LedgerRow[];
}

export function createLedger(db: DatabaseSync, name: string): LedgerRow {
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 40) throw new Error("账本名需为 1-40 字符");
  const dup = db.prepare("SELECT id FROM ledgers WHERE name = ? AND archived_at IS NULL").get(trimmed);
  if (dup !== undefined) throw new Error(`已存在同名账本: ${trimmed}`);
  const id = newId();
  db.prepare("INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, ?)").run(id, trimmed, nowIso());
  return getLedger(db, id) as LedgerRow;
}

export function renameLedger(db: DatabaseSync, id: string, name: string): LedgerRow {
  const row = getLedger(db, id);
  if (row === undefined) throw new Error(`账本不存在: ${id}`);
  const trimmed = name.trim();
  if (trimmed === "" || trimmed.length > 40) throw new Error("账本名需为 1-40 字符");
  const dup = db.prepare("SELECT id FROM ledgers WHERE name = ? AND archived_at IS NULL AND id != ?").get(trimmed, id);
  if (dup !== undefined) throw new Error(`已存在同名账本: ${trimmed}`);
  db.prepare("UPDATE ledgers SET name = ? WHERE id = ?").run(trimmed, id);
  return getLedger(db, id) as LedgerRow;
}

export function setLedgerArchived(db: DatabaseSync, id: string, archived: boolean): LedgerRow {
  const row = getLedger(db, id);
  if (row === undefined) throw new Error(`账本不存在: ${id}`);
  db.prepare("UPDATE ledgers SET archived_at = ? WHERE id = ?").run(archived ? nowIso() : null, id);
  return getLedger(db, id) as LedgerRow;
}

export function addExpense(
  db: DatabaseSync,
  profileId: string,
  input: { ledgerId: string; amountCents: number; category?: string; note?: string | null; spentOn?: string },
): ExpenseRow {
  const ledger = getLedger(db, input.ledgerId);
  if (ledger === undefined) throw new Error(`账本不存在: ${input.ledgerId}`);
  if (ledger.archived_at !== null) throw new Error(`账本已归档: ${ledger.name}`);
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new Error(`金额不合法: ${String(input.amountCents)}（分为单位，需为正整数）`);
  }
  const category = (input.category ?? DEFAULT_CATEGORY).trim() || DEFAULT_CATEGORY;
  if (category.length > 20) throw new Error("分类过长（≤20 字符）");
  const note = input.note === undefined || input.note === null || input.note.trim() === "" ? null : input.note.trim();
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

export function listExpenses(
  db: DatabaseSync,
  ledgerId: string,
  opts: { from?: string; to?: string; by?: string; limit?: number } = {},
): ExpenseRow[] {
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
  params.push(Math.min(opts.limit ?? 20, 200));
  return db
    .prepare(`SELECT * FROM expenses WHERE ${conditions.join(" AND ")} ORDER BY spent_on DESC, created_at DESC LIMIT ?`)
    .all(...params) as unknown as ExpenseRow[];
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
    .prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS total, COUNT(*) AS count FROM expenses WHERE ${where}`)
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

export function previousMonth(now: Date = new Date()): string {
  const ym = now.toISOString().slice(0, 7);
  const year = Number(ym.slice(0, 4));
  const month = Number(ym.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

export function monthlyReportBlocks(summary: ExpenseSummary): NotifyBlock {
  const rows = summary.categories.map((c) => [
    c.category,
    `¥${centsToYuan(c.cents)}`,
    `${(c.share * 100).toFixed(1)}%`,
  ]);
  rows.push(["合计", `¥${centsToYuan(summary.total_cents)}`, "100%"]);
  const notes = [`共 ${summary.count} 笔`];
  if (summary.profiles.length > 1) {
    notes.push(`记账人：${summary.profiles.map((p) => `${p.profile} ¥${centsToYuan(p.cents)}`).join("、")}`);
  }
  return { table: { columns: ["分类", "金额", "占比"], rows }, notes };
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

/** 月报推送：全局事件，物化到每个配置了路由的 Profile（Profile 内去重） */
export async function pushMonthlyReports(
  db: DatabaseSync,
  services: { publishGlobal(input: { kind: string; title: string; blocks: NotifyBlock; dedupeKey?: string }): Promise<{ materialized: number }> },
  ym: string,
): Promise<number> {
  const { from, to } = monthRange(ym);
  let pushed = 0;
  for (const ledger of listLedgers(db)) {
    const summary = summarizeExpenses(db, ledger.id, { from, to });
    if (summary.count === 0) continue;
    const result = await services.publishGlobal({
      kind: "bookkeeping.monthly",
      title: `${ym} 月度账单 · ${ledger.name}`,
      blocks: monthlyReportBlocks(summary),
      dedupeKey: `report:${ledger.id}:${ym}`,
    });
    pushed += result.materialized;
  }
  return pushed;
}
