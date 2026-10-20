import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { withReadTransaction } from "../../core/database.js";
import type { NotifyBlock } from "../../core/registry.js";
import { getSetting, newId, setSetting } from "../../core/settings.js";
import { nowIso, TZ, todayIso } from "../../time.js";

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

/** 默认账本设置键（按 Profile 存储，值是账本 id） */
export const DEFAULT_LEDGER_SETTING = "bookkeeping.default_ledger_id";

/**
 * 当前 Profile 可写的活动账本：家庭账本 + 自己的个人账本，且未归档。
 * 与 `ledger list` 的可见范围一致（listLedgers 默认已排除归档账本）。
 */
export function writableLedgers(db: DatabaseSync, profileId: string): LedgerRow[] {
  return listLedgers(db).filter((row) => isLedgerVisible(row, profileId));
}

/** 已设置的默认账本 id；未设置、类型异常（手工改库）或空串一律视为未设置 */
export function getDefaultLedgerId(db: DatabaseSync, profileId: string): string | undefined {
  const value = getSetting<unknown>(db, profileId, DEFAULT_LEDGER_SETTING);
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function setDefaultLedgerId(db: DatabaseSync, profileId: string, ledgerId: string): void {
  setSetting(db, profileId, DEFAULT_LEDGER_SETTING, ledgerId);
}

export interface DefaultLedgerResolution {
  /** 命中的账本；null = 无法确定，调用方必须报错并列出 candidates */
  ledger: LedgerRow | null;
  /** 当前 Profile 可写的活动账本（错误提示与工具回显共用，复用同一份判定） */
  candidates: LedgerRow[];
  /** 命中来源：settings 里的默认账本，或「恰好只有一个可写账本」的确定结果 */
  source: "setting" | "single" | null;
}

/**
 * `expense add` 未传 ledger_id 时的默认账本解析。解析顺序固定、绝不猜：
 * ① settings 的 `bookkeeping.default_ledger_id` 指向**活动且可写**的账本 → 用它；
 *    已归档/转给他人的旧设置自动失效（回落到 ②/③），不需要用户先清理设置；
 * ② 当前 Profile 恰好只有一个可写活动账本 → 用它（这是确定结果，不写 setting：
 *    把「暂时只有一个」固化下来，之后新建账本时旧值反而会变成错误来源）；
 * ③ 其余情况（0 个或 2+ 个且无有效默认）→ 返回 null，由工具层报错并列出可选账本。
 */
export function resolveAddLedger(db: DatabaseSync, profileId: string): DefaultLedgerResolution {
  const candidates = writableLedgers(db, profileId);
  const configuredId = getDefaultLedgerId(db, profileId);
  if (configuredId !== undefined) {
    const configured = candidates.find((row) => row.id === configuredId);
    if (configured !== undefined) return { ledger: configured, candidates, source: "setting" };
  }
  if (candidates.length === 1) {
    return { ledger: candidates[0] as LedgerRow, candidates, source: "single" };
  }
  return { ledger: null, candidates, source: null };
}

/** 校验并设置默认账本；不存在/不可见/已归档一律报可操作错误（不落任何设置） */
export function setDefaultLedger(db: DatabaseSync, profileId: string, ledgerId: string): LedgerRow {
  const ledger = writableLedgers(db, profileId).find((row) => row.id === ledgerId);
  if (ledger === undefined) {
    throw new Error(
      `账本不存在或不可写: ${ledgerId}（只能选家庭账本或自己的个人账本，已归档账本不可用）`,
    );
  }
  setDefaultLedgerId(db, profileId, ledger.id);
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

export interface AddExpenseInput {
  ledgerId: string;
  amountCents: number;
  category?: string;
  note?: string | null;
  spentOn?: string;
  /** 写路径幂等键（工具参数 request_id）；按 (created_by_profile, clientToken) 唯一 */
  clientToken?: string;
}

export interface AddExpenseResult {
  entry: ExpenseRow;
  /** true = 命中幂等键，返回的是首次写入的那一行（本次没有新增行） */
  reused: boolean;
}

/** request_id 上限：够放 UUID/短哈希，又不至于把整段 prompt 塞进唯一索引 */
export const CLIENT_TOKEN_MAX_LENGTH = 128;

function assertValidClientToken(token: string): void {
  if (token.trim() === "" || token.length > CLIENT_TOKEN_MAX_LENGTH) {
    throw new Error(`request_id 不合法（需为 1-${CLIENT_TOKEN_MAX_LENGTH} 个非空白字符）`);
  }
}

/** 按幂等键查回首次写入的支出（不存在返回 undefined） */
export function findExpenseByClientToken(
  db: DatabaseSync,
  profileId: string,
  clientToken: string,
): ExpenseRow | undefined {
  return db
    .prepare("SELECT * FROM expenses WHERE created_by_profile = ? AND client_token = ?")
    .get(profileId, clientToken) as ExpenseRow | undefined;
}

/**
 * 是否是 client_token 的分范围唯一索引冲突。node:sqlite 抛出的错误带
 * `errcode`（SQLITE_CONSTRAINT_UNIQUE = 2067）；同时校验 message 里出现
 * `client_token`，避免把主键冲突等其它 UNIQUE 错误误当成「重试命中」。
 */
function isClientTokenConflict(e: unknown): boolean {
  if (!(e instanceof Error) || !e.message.includes("client_token")) return false;
  const errcode = (e as { errcode?: number }).errcode;
  return errcode === 2067 || e.message.includes("UNIQUE constraint failed");
}

/**
 * 记一笔支出（带可选幂等键）。
 *
 * 幂等语义：`(created_by_profile, client_token)` 上有部分唯一索引（见
 * core/database.ts 的 ensureClientTokenIndexes）。MCP 超时/网络抖动后调用方带同一个
 * `request_id` 重试时，第二次 INSERT 会撞唯一索引；此时按同一组键查回首次写入的那一行
 * 返回（reused=true），工具层据此**不再发回执、不再推预算提醒**。
 *
 * 刻意不做「先查后写」：并发重试下另一事务可能恰好插在两条语句之间，pre-check 会漏；
 * 冲突兜底才是唯一可靠的口径（幂等键的唯一性最终由数据库索引保证）。
 */
export function addExpenseChecked(
  db: DatabaseSync,
  profileId: string,
  input: AddExpenseInput,
): AddExpenseResult {
  const ledger = getLedger(db, input.ledgerId);
  if (ledger === undefined) throw new Error(`账本不存在: ${input.ledgerId}`);
  if (ledger.archived_at !== null) throw new Error(`账本已归档: ${ledger.name}`);
  assertValidAmountCents(input.amountCents);
  const category = normalizedCategory(input.category);
  const note = normalizedNote(input.note);
  const spentOn = normalizedSpentOn(input.spentOn);
  if (input.clientToken !== undefined) assertValidClientToken(input.clientToken);
  const id = newId();
  try {
    db.prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, note, spent_on, created_by_profile, created_at, client_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.ledgerId,
      input.amountCents,
      category,
      note,
      spentOn,
      profileId,
      nowIso(),
      input.clientToken ?? null,
    );
  } catch (e) {
    if (input.clientToken !== undefined && isClientTokenConflict(e)) {
      const existing = findExpenseByClientToken(db, profileId, input.clientToken);
      if (existing !== undefined) return { entry: existing, reused: true };
    }
    throw e;
  }
  return {
    entry: db.prepare("SELECT * FROM expenses WHERE id = ?").get(id) as unknown as ExpenseRow,
    reused: false,
  };
}

/** 兼容旧调用（不带幂等键）：只返回新建的行，幂等命中场景走 addExpenseChecked */
export function addExpense(
  db: DatabaseSync,
  profileId: string,
  input: AddExpenseInput,
): ExpenseRow {
  return addExpenseChecked(db, profileId, input).entry;
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

/** 「常用分类」统计窗口（天，含今天）：只回显最近记过什么，与预算/报表无关 */
export const RECENT_CATEGORY_DAYS = 90;
/** 「常用分类」回显条数上限（按出现次数取 top N） */
export const RECENT_CATEGORY_LIMIT = 5;

/**
 * 该账本最近 N 天出现次数最多的分类（按笔数降序；同频按分类名升序，结果稳定可测）。
 *
 * 只用于 `expense add` 未显式传 category 时的回执提示：给出「平时都记什么」，
 * 不做任何自动归类/改写。窗口内没有支出时返回空数组（而不是伪造一个分类）。
 * `excludeId` 用来剔除刚刚插入的这笔 —— 否则它自己（默认分类「其他」）会挤进建议里，
 * 形成「记什么就推荐什么」的噪声。
 */
export function recentCategories(
  db: DatabaseSync,
  ledgerId: string,
  opts: { today?: string; excludeId?: string; limit?: number } = {},
): string[] {
  const today = opts.today ?? todayIso();
  const from = DateTime.fromISO(today, { zone: TZ })
    .minus({ days: RECENT_CATEGORY_DAYS - 1 })
    .toISODate();
  if (from === null) return [];
  // 下限也 clamp：LIMIT 传 0 会得到空集，传负数在 SQLite 里等于「不限量」
  const limit = Math.max(1, Math.min(opts.limit ?? RECENT_CATEGORY_LIMIT, 20));
  const params: (string | number)[] = [ledgerId, from, today];
  let sql = `SELECT category, COUNT(*) AS n FROM expenses
    WHERE ledger_id = ? AND spent_on >= ? AND spent_on <= ?`;
  if (opts.excludeId !== undefined) {
    sql += " AND id != ?";
    params.push(opts.excludeId);
  }
  sql += " GROUP BY category ORDER BY n DESC, category ASC LIMIT ?";
  const rows = db.prepare(sql).all(...params, limit) as { category: string; n: number }[];
  return rows.map((row) => row.category);
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

/**
 * 本地日历周（周一 → 周日）区间。`dateISO` 缺省今天。
 *
 * 周一为一周起点用 weekday 显式减出来，**不用** `startOf("week")`：后者按 locale 的
 * 每周首日取值（部分环境是周日），周报的「本周」会在不同机器上错一天。
 * 跨月/跨年由 Luxon 的日历运算处理（如 2026-01-01 属于 2025-12-29~2026-01-04）。
 */
export function weekRange(dateISO: string = todayIso()): { start: string; end: string } {
  const dt = DateTime.fromISO(dateISO, { zone: TZ });
  if (!dt.isValid) throw new Error(`日期不合法（YYYY-MM-DD）: ${dateISO}`);
  const start = dt.minus({ days: dt.weekday - 1 }); // weekday: 1=周一 … 7=周日
  return {
    start: start.toISODate() as string,
    end: start.plus({ days: 6 }).toISODate() as string,
  };
}

/** 标题/备注里的 M/D（不补零）；入参来自 weekRange，一定是本地日历日 */
export function monthDay(dateISO: string): string {
  const dt = DateTime.fromISO(dateISO, { zone: TZ });
  if (!dt.isValid) throw new Error(`日期不合法（YYYY-MM-DD）: ${dateISO}`);
  return `${dt.month}/${dt.day}`;
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
 *
 * **口径是「这笔支出所属月份」而不是「当前月」**：预算按账本每月滚动，补记两个月前的
 * 支出时必须对照**那个月**的预算消耗来判断（ym 取自 entry.spent_on），否则拿今天的累计
 * 去比历史月份，会得出「本月超支」的假结论；标题与 dedupeKey 都带 ym，连续两个月各超支
 * 时是两个独立事件、不会被去重吞掉。
 *
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
    // 键里必须同时带 ym 与范围：只按账本去重会让「8 月已超支」把 9 月的超支静默吞掉。
    const scopeKey = budget.category === "" ? "" : budget.category;
    // 标题必须带月份：补记历史月份的支出时，用户否则看不出这条「超支」说的是哪个月
    // （旧标题只有账本名，8 月与 10 月的提醒长得一模一样）。
    const thresholdLabel = crossed === 80 ? "预算提醒" : "预算超支";
    const title =
      budget.category === ""
        ? `⚠️ ${ledger.name} ${ym} ${thresholdLabel}`
        : `⚠️ 分类「${budget.category}」${ym} ${thresholdLabel}`;
    alerts.push({
      kind: "bookkeeping.budget",
      title,
      // 分类标题里没有账本名，正文补一行「账本 · 月份」，两条提醒并排时也能区分
      blocks: { ...budgetAlertBlocks(status), notes: [`${ledger.name} · ${ym}`] },
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

/** 报表表格里最多列几个分类（其余合并成一行 note，避免表格无限长）；每日摘要与周报共用 */
export const DIGEST_TOP_CATEGORIES = 5;

/**
 * 分类占比表的行（含合计行）。`limit` 缺省不限；截断时把其余分类合并成一条备注，
 * 避免大账本的表格无限长（每日摘要、周报共用同一口径）。
 *
 * 排序在 SQL 之外再按「金额降序 + 分类名升序」稳定一次：summarizeExpenses 只按金额
 * 排序，同额分类的顺序取决于 SQLite 的执行计划，直接拿来做可 diff 的报表不稳定。
 */
function categoryShareRows(
  summary: ExpenseSummary,
  limit = Number.POSITIVE_INFINITY,
): { rows: string[][]; restNote: string | null } {
  const ordered = [...summary.categories].sort(
    (a, b) => b.cents - a.cents || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0),
  );
  const top = ordered.slice(0, limit);
  const rest = ordered.slice(limit);
  const rows = top.map((c) => [
    c.category,
    `¥${centsToYuan(c.cents)}`,
    `${(c.share * 100).toFixed(1)}%`,
  ]);
  rows.push(["合计", `¥${centsToYuan(summary.total_cents)}`, "100%"]);
  const restNote =
    rest.length === 0
      ? null
      : `其余 ${rest.length} 类：¥${centsToYuan(rest.reduce((sum, c) => sum + c.cents, 0))}`;
  return { rows, restNote };
}

export function monthlyReportBlocks(
  summary: ExpenseSummary,
  budget: BudgetStatus | null = null,
): NotifyBlock {
  const { rows } = categoryShareRows(summary);
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

/**
 * 环比上周的句子。上周合计为 0 时**不做除法**（分母为 0 会得到 Infinity/NaN），
 * 直接说明「上周无支出」——否则用户看到的是「环比 +Infinity%」这种坏数据。
 */
function weekOverWeekLine(totalCents: number, previousTotalCents: number): string {
  if (previousTotalCents <= 0) return "环比上周：上周无支出";
  const pct = ((totalCents - previousTotalCents) / previousTotalCents) * 100;
  const sign = pct > 0 ? "+" : "";
  return `环比上周 ${sign}${pct.toFixed(1)}%`;
}

/** 周报备注里的预算行：本月已用 / 剩余 / 本周日均（整周 7 天口径） */
function weeklyBudgetLine(
  label: string,
  budgetCents: number,
  spentCents: number,
  weekTotalCents: number,
): string {
  const c = budgetComparison(budgetCents, spentCents);
  return `预算 · ${label}：已用 ${c.已用} / 剩余 ${c.剩余} / 本周日均 ¥${centsToYuan(Math.round(weekTotalCents / 7))}`;
}

export interface WeeklyReportFacts {
  /** 上周同账本合计（分）；0 = 上周无支出（不除零） */
  previousTotalCents: number;
  /** 本周最大单笔；null = 本周无支出（调用方会跳过该账本，保留 null 便于单测） */
  maxEntry: { amount_cents: number; category: string; spent_on: string } | null;
  /** 周报发送月（周日所在自然月）的预算对照；未设预算为 null */
  budget: BudgetStatus | null;
}

/**
 * 周报的正文：分类占比表（按金额降序，最多 top5，其余合并成备注）+ 备注
 * （笔数、最大单笔、环比、本月预算的剩余与本周日均）。
 * 与月报共用 categoryShareRows，避免两张报表的表格口径分叉。
 */
export function weeklyReportBlocks(summary: ExpenseSummary, facts: WeeklyReportFacts): NotifyBlock {
  const { rows, restNote } = categoryShareRows(summary, DIGEST_TOP_CATEGORIES);
  const notes = [`共 ${summary.count} 笔`];
  if (restNote !== null) notes.push(restNote);
  if (facts.maxEntry !== null) {
    const max = facts.maxEntry;
    notes.push(
      `最大单笔 ¥${centsToYuan(max.amount_cents)}（${max.category}，${monthDay(max.spent_on)}）`,
    );
  }
  notes.push(weekOverWeekLine(summary.total_cents, facts.previousTotalCents));
  if (facts.budget !== null) {
    if (facts.budget.total !== null) {
      notes.push(
        weeklyBudgetLine(
          "总额",
          facts.budget.total.budget_cents,
          facts.budget.total.spent_cents,
          summary.total_cents,
        ),
      );
    }
    for (const cat of facts.budget.categories) {
      notes.push(
        weeklyBudgetLine(
          `分类「${cat.category}」`,
          cat.budget_cents,
          cat.spent_cents,
          summary.total_cents,
        ),
      );
    }
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

/**
 * 报表推送所需的最小 services 形状：家庭账本 publishGlobal（多 Profile 物化），
 * 个人账本 publishProfile（只给归属人）。与 registry.Services 结构兼容，便于测试注入桩。
 */
export interface ReportServices {
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
}

/**
 * 按账本归属发布一份报表，返回「实际物化」条数：家庭账本走 publishGlobal（每个有路由的
 * Profile 各一条，返回 materialized），个人账本只给归属人（被去重吞掉时计 0）。
 * 月报与周报共用：受众判定只写这一处，避免某张报表写反了把个人账本推到全局。
 */
async function publishLedgerReport(
  ledger: LedgerRow,
  input: { kind: string; title: string; blocks: NotifyBlock; dedupeKey?: string },
  services: ReportServices,
): Promise<number> {
  if (ledger.owner_profile_id === null) {
    const result = await services.publishGlobal(input);
    return result.materialized;
  }
  const result = await services.publishProfile(ledger.owner_profile_id, input);
  return result.deduped ? 0 : 1;
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
  services: ReportServices,
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
    pushed += await publishLedgerReport(ledger, input, services);
  }
  return pushed;
}

/**
 * 周报推送：对**每个活跃账本**汇总本周（周一~周日）的支出，家庭账本 publishGlobal、
 * 个人账本 publishProfile(owner)，无支出的账本跳过（不推「本周 0 笔」的噪音）。
 *
 * 幂等：dedupeKey 为 `weekly:<ledgerId>:<weekStart>`，同一周重复触发（cron 与启动补发
 * 撞车、手动补跑）只会物化一条；跨周的键不同，因此每周都会再发。
 *
 * 预算对照用**周日所在自然月**：预算按自然月滚动，跨月的那一周（如 9/29–10/5）若用
 * 周一所在月，会拿 9 月的预算去对照 10 月才发出的周报，结论会误导。
 */
export async function pushWeeklyReports(
  db: DatabaseSync,
  services: ReportServices,
  weekStart: string = weekRange(todayIso()).start,
): Promise<number> {
  // 允许传周内任意一天：先归一到该周周一，避免调用方传周日时把「下周」当成这周的键
  const { start, end } = weekRange(weekStart);
  const previous = weekRange(
    DateTime.fromISO(start, { zone: TZ }).minus({ days: 7 }).toISODate() as string,
  );
  const budgetMonth = end.slice(0, 7);
  let pushed = 0;
  for (const ledger of listLedgers(db)) {
    const summary = summarizeExpenses(db, ledger.id, { from: start, to: end });
    if (summary.count === 0) continue;
    const previousSummary = summarizeExpenses(db, ledger.id, {
      from: previous.start,
      to: previous.end,
    });
    // 最大单笔：金额相同再按日期/id 升序，保证同一周重复生成的正文完全一致
    const maxEntry = db
      .prepare(
        `SELECT amount_cents, category, spent_on FROM expenses
         WHERE ledger_id = ? AND spent_on >= ? AND spent_on <= ?
         ORDER BY amount_cents DESC, spent_on ASC, id ASC LIMIT 1`,
      )
      .get(ledger.id, start, end) as
      | { amount_cents: number; category: string; spent_on: string }
      | undefined;
    const budget =
      getBudgets(db, ledger.id).length > 0 ? budgetStatus(db, ledger.id, budgetMonth) : null;
    const input = {
      kind: "bookkeeping.weekly",
      title: `📅 本周账单 · ${monthDay(start)}–${monthDay(end)}`,
      blocks: weeklyReportBlocks(summary, {
        previousTotalCents: previousSummary.total_cents,
        maxEntry: maxEntry ?? null,
        budget,
      }),
      dedupeKey: `weekly:${ledger.id}:${start}`,
    };
    pushed += await publishLedgerReport(ledger, input, services);
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

/** pushDailyDigests 需要的最小 services 形状（与 pushMonthlyReports 同口径，便于测试注入桩） */
export interface DigestServices {
  publishProfile(
    profileId: string,
    input: { kind: string; title: string; blocks: NotifyBlock; dedupeKey?: string },
  ): Promise<{ deduped: boolean }>;
}

/**
 * 每日记账摘要：按**记账人**汇总当天（spent_on = date）的支出，每人一条。
 *
 * 为什么按记账人而不是按账本：家庭账本里两个人的支出混在一起，逐笔回执曾经是
 * 「一笔 × 每人」的噪声源（真实库 172 条回执 = 86 笔 × 2 人）。改成每人每晚一条
 * 「今天你记了几笔、花在哪」后，同一笔钱只打扰记账的那个人，家庭账本也不再重复推送。
 *
 * 只对当天真有记账的 Profile 发布：没记账的人不该收到一条「今天 0 笔」的提醒。
 * dedupeKey 固定为 `digest:<profile>:<date>`，因此同一天重复触发（手动补跑、启动补发
 * 与 cron 撞车）只会物化一条 —— 幂等由 notifications 的 (profile_id, dedupe_key) 唯一约束保证。
 *
 * 返回「实际物化」的条数（被去重吞掉的不计），供 job 日志与测试断言使用。
 */
export async function pushDailyDigests(
  db: DatabaseSync,
  services: DigestServices,
  date: string = todayIso(),
): Promise<number> {
  const totals = db
    .prepare(
      `SELECT created_by_profile AS profile, COUNT(*) AS n, COALESCE(SUM(amount_cents), 0) AS total
       FROM expenses WHERE spent_on = ? GROUP BY created_by_profile ORDER BY created_by_profile`,
    )
    .all(date) as { profile: string; n: number; total: number }[];
  let pushed = 0;
  for (const row of totals) {
    // 分类按金额降序；同额按分类名升序，保证同一天重复生成的内容完全一致（可测）
    const categories = db
      .prepare(
        `SELECT category, COUNT(*) AS n, SUM(amount_cents) AS cents FROM expenses
         WHERE spent_on = ? AND created_by_profile = ?
         GROUP BY category ORDER BY cents DESC, category ASC`,
      )
      .all(date, row.profile) as { category: string; n: number; cents: number }[];
    const top = categories.slice(0, DIGEST_TOP_CATEGORIES);
    const rest = categories.slice(DIGEST_TOP_CATEGORIES);
    const notes = [`共 ${row.n} 笔`];
    if (rest.length > 0) {
      const restCents = rest.reduce((sum, c) => sum + c.cents, 0);
      notes.push(`其余 ${rest.length} 类：¥${centsToYuan(restCents)}`);
    }
    const result = await services.publishProfile(row.profile, {
      kind: "bookkeeping.digest",
      title: `🧾 今日记账 ${row.n} 笔 · ¥${centsToYuan(row.total)}`,
      blocks: {
        table: {
          columns: ["分类", "金额", "笔数"],
          rows: [
            ...top.map((c) => [c.category, `¥${centsToYuan(c.cents)}`, `${c.n} 笔`]),
            ["合计", `¥${centsToYuan(row.total)}`, `${row.n} 笔`],
          ],
        },
        notes,
      },
      dedupeKey: `digest:${row.profile}:${date}`,
    });
    if (!result.deduped) pushed += 1;
  }
  return pushed;
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
