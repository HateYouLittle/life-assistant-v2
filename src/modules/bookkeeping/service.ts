import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { withReadTransaction } from "../../core/database.js";
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

/** 「常用分类」统计窗口（天，含今天）：分类总览与 add 回执共用同一口径 */
export const RECENT_CATEGORY_DAYS = 90;
/** 「常用分类」回显条数上限（按出现次数取 top N） */
export const RECENT_CATEGORY_LIMIT = 5;

/** 分类字典的设置键（按 Profile 存储）：{ 标准名: [别名...] } */
export const CATEGORY_DICT_SETTING = "expense_categories";
/** 分类名/别名的长度上限：与 expenses.category 的既有口径一致（normalizedCategory 同值） */
export const CATEGORY_LABEL_MAX_LENGTH = 20;

/** 分类字典：标准名 → 别名列表（保持写入顺序，便于工具回显） */
export type CategoryDictionary = Record<string, string[]>;

/**
 * 分类名/别名的匹配键：trim + 大小写折叠。
 *
 * 只用于「查字典」的比较，不改变落库文本 —— 用户写「Food」还是「food」都应命中同一
 * 标准名，但中文大小写不变，所以折叠对中文没有副作用。
 */
function categoryKey(value: string): string {
  return value.trim().toLowerCase();
}

/** 分类名/别名校验：1-20 字（与 expense 的 category 上限一致） */
function assertCategoryLabel(value: string, what: string): void {
  if (value.trim() === "" || value.trim().length > CATEGORY_LABEL_MAX_LENGTH) {
    throw new Error(`${what}需为 1-${CATEGORY_LABEL_MAX_LENGTH} 字符: ${value}`);
  }
}

/**
 * 读取分类字典。`getSetting` 已防坏 JSON；这里再防形状（手工改库写出
 * `{"餐饮": "吃饭"}` / 非字符串别名时按缺省处理，不能让记账写路径因一条坏设置整体失败）。
 */
export function getCategoryDictionary(db: DatabaseSync, profileId: string): CategoryDictionary {
  const raw = getSetting<unknown>(db, profileId, CATEGORY_DICT_SETTING);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const dict: CategoryDictionary = {};
  for (const [name, aliases] of Object.entries(raw as Record<string, unknown>)) {
    const trimmed = name.trim();
    if (trimmed === "" || !Array.isArray(aliases)) continue;
    dict[trimmed] = aliases.filter(
      (alias): alias is string => typeof alias === "string" && alias.trim() !== "",
    );
  }
  return dict;
}

/**
 * 覆盖写入分类字典。写入前统一校验（标准名/别名 1-20 字、折叠后全局唯一）：
 * 同一串文本既是某标准名又是另一类别名时，normalizeCategory 的匹配结果会变成
 * 「按对象键顺序先到先得」，同一句话在不同 Profile 上归到不同分类，必须在这里拒绝。
 */
export function setCategoryDictionary(
  db: DatabaseSync,
  profileId: string,
  dict: CategoryDictionary,
): void {
  const nameKeys = new Map<string, string>();
  const entries: Array<{ name: string; aliases: string[] }> = [];
  for (const [rawName, rawAliases] of Object.entries(dict)) {
    const name = rawName.trim();
    assertCategoryLabel(name, "分类名");
    const key = categoryKey(name);
    if (nameKeys.has(key)) {
      throw new Error(`分类名重复（忽略大小写/空白）：${nameKeys.get(key) ?? ""} / ${name}`);
    }
    nameKeys.set(key, name);
    entries.push({ name, aliases: rawAliases.map((alias) => alias.trim()) });
  }
  const aliasOwners = new Map<string, string>();
  for (const { name, aliases } of entries) {
    for (const alias of aliases) {
      assertCategoryLabel(alias, "别名");
      const key = categoryKey(alias);
      if (nameKeys.has(key)) {
        throw new Error(`别名与标准名冲突：「${alias}」已是分类名`);
      }
      const owner = aliasOwners.get(key);
      if (owner !== undefined) {
        throw new Error(`别名重复（忽略大小写/空白）：「${alias}」已属于「${owner}」`);
      }
      aliasOwners.set(key, name);
    }
  }
  // 写的是 trim 后的规范形状：读路径虽然也会 trim，但写入时就规整，回显不会带多余空白
  const normalized: CategoryDictionary = {};
  for (const { name, aliases } of entries) normalized[name] = aliases;
  setSetting(db, profileId, CATEGORY_DICT_SETTING, normalized);
}

/**
 * 把分类文本归一成字典里的标准名：trim + 大小写折叠后
 * ① 命中某个标准名 → 返回该标准名（保留字典里的写法）；
 * ② 命中某个别名 → 返回对应标准名；
 * ③ 都没命中 → 返回 trim 后的原值（自由文本仍允许，字典只是可选的「路由表」）。
 *
 * 空/纯空白返回空串，交给 normalizedCategory 回落默认分类「其他」。
 * 只作用于**新写入/显式更新**的分类，不改动已存在账目的分类文本。
 */
export function normalizeCategory(db: DatabaseSync, profileId: string, input: string): string {
  const trimmed = input.trim();
  if (trimmed === "") return "";
  const key = categoryKey(trimmed);
  const dict = getCategoryDictionary(db, profileId);
  for (const name of Object.keys(dict)) {
    if (categoryKey(name) === key) return name;
  }
  for (const [name, aliases] of Object.entries(dict)) {
    if (aliases.some((alias) => categoryKey(alias) === key)) return name;
  }
  return trimmed;
}

/** 分类别名的当前状态（工具回显用） */
export interface CategoryAliasState {
  name: string;
  aliases: string[];
}

/**
 * 新增 / 删除分类别名，返回更新后的标准名与别名列表。
 *
 * - category 折叠后命中已有标准名时沿用原写法（不会因为大小写不同建出第二个分类）；
 * - 新增时 alias 不能与**任何**标准名或其它分类的别名冲突（本分类内重复添加幂等）；
 * - remove=true 删除别名：不存在时幂等返回、不报错，也不会凭空建出一个空分类；
 * - 删除后该文本不再被归一（字典里已经没有它了）。
 */
export function changeCategoryAlias(
  db: DatabaseSync,
  profileId: string,
  input: { category: string; alias: string; remove?: boolean },
): CategoryAliasState {
  const category = input.category.trim();
  const alias = input.alias.trim();
  assertCategoryLabel(category, "分类名");
  assertCategoryLabel(alias, "别名");
  const categoryFold = categoryKey(category);
  const aliasFold = categoryKey(alias);
  if (categoryFold === aliasFold)
    throw new Error(`别名与标准名冲突：别名不能与分类名相同（${category}）`);

  const dict = getCategoryDictionary(db, profileId);
  const existingName = Object.keys(dict).find((name) => categoryKey(name) === categoryFold);
  const name = existingName ?? category;

  if (input.remove === true) {
    if (existingName === undefined) return { name, aliases: [] };
    const next = (dict[name] ?? []).filter((item) => categoryKey(item) !== aliasFold);
    dict[name] = next;
    setCategoryDictionary(db, profileId, dict);
    return { name, aliases: next };
  }

  if (existingName === undefined) {
    // 新标准名不能与已有别名撞车（否则同一文本既是标准名又是别名，归一结果不确定）
    for (const [otherName, aliases] of Object.entries(dict)) {
      const clash = aliases.find((item) => categoryKey(item) === categoryFold);
      if (clash !== undefined) {
        throw new Error(`分类名与已有别名冲突：「${clash}」是「${otherName}」的别名`);
      }
    }
  }
  const nameClash = Object.keys(dict).find((item) => categoryKey(item) === aliasFold);
  if (nameClash !== undefined) throw new Error(`别名与标准名冲突：「${alias}」已是分类名`);
  for (const [otherName, aliases] of Object.entries(dict)) {
    if (categoryKey(otherName) === categoryFold) continue;
    const clash = aliases.find((item) => categoryKey(item) === aliasFold);
    if (clash !== undefined) {
      throw new Error(`别名与「${otherName}」的别名冲突：「${clash}」`);
    }
  }
  const current = dict[name] ?? [];
  if (current.some((item) => categoryKey(item) === aliasFold)) {
    return { name, aliases: [...current] }; // 已存在（同一分类）：幂等
  }
  dict[name] = [...current, alias];
  setCategoryDictionary(db, profileId, dict);
  return { name, aliases: [...(dict[name] ?? [])] };
}

/** 分类总览行（工具层再翻译成中文键） */
export interface CategorySummaryRow {
  name: string;
  aliases: string[];
  count: number;
  cents: number;
}

/**
 * 分类总览：分类字典里的标准名（含从未使用过的）+ 近 N 天实际用过、但不在字典里的分类。
 *
 * 统计口径：**当前 Profile 可见的活动账本**（家庭 + 自己的个人），与 ledger list 一致 ——
 * 别人的个人账本里的分类不能出现在我的分类治理视图里。历史数据若以别名形式记账，
 * 会按折叠值计入对应标准名（否则「吃饭」记了 20 笔、标准名却显示 0 笔，用户会以为丢账）。
 * 字典为空时结果就是「近 90 天实际用过的分类」，供一键建别名。
 */
export function categorySummary(
  db: DatabaseSync,
  profileId: string,
  opts: { today?: string; days?: number } = {},
): CategorySummaryRow[] {
  const today = opts.today ?? todayIso();
  const days = Math.max(1, opts.days ?? RECENT_CATEGORY_DAYS);
  const from = DateTime.fromISO(today, { zone: TZ })
    .minus({ days: days - 1 })
    .toISODate();
  const usage = new Map<string, { raw: string; count: number; cents: number }>();
  if (from !== null) {
    const rows = db
      .prepare(
        `SELECT e.category AS category, COUNT(*) AS n, SUM(e.amount_cents) AS cents
         FROM expenses e JOIN ledgers l ON l.id = e.ledger_id
         WHERE (l.owner_profile_id IS NULL OR l.owner_profile_id = ?)
           AND l.archived_at IS NULL
           AND e.spent_on >= ? AND e.spent_on <= ?
         GROUP BY e.category`,
      )
      .all(profileId, from, today) as { category: string; n: number; cents: number }[];
    for (const row of rows) {
      const key = categoryKey(row.category);
      const hit = usage.get(key);
      if (hit === undefined) {
        usage.set(key, { raw: row.category.trim(), count: row.n, cents: row.cents });
      } else {
        hit.count += row.n;
        hit.cents += row.cents;
      }
    }
  }
  const dict = getCategoryDictionary(db, profileId);
  const matchedKeys = new Set<string>();
  const items: CategorySummaryRow[] = [];
  for (const [name, aliases] of Object.entries(dict)) {
    let count = 0;
    let cents = 0;
    for (const key of [categoryKey(name), ...aliases.map(categoryKey)]) {
      const hit = usage.get(key);
      if (hit === undefined) continue;
      count += hit.count;
      cents += hit.cents;
      matchedKeys.add(key);
    }
    items.push({ name, aliases: [...aliases], count, cents });
  }
  for (const [key, hit] of usage) {
    if (matchedKeys.has(key)) continue;
    items.push({ name: hit.raw, aliases: [], count: hit.count, cents: hit.cents });
  }
  // 金额降序 + 名称升序：同一份数据两次调用的顺序一致（可 diff、可断言）
  return items.sort(
    (a, b) => b.cents - a.cents || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
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
 * 返回（reused=true），工具层据此标记「已存在」。
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
  // 先过分类字典（别名 → 标准名），再走既有归一（空白 → 「其他」、≤20 字）：
  // 字典是「可选路由表」，未命中的自由文本原样保留。
  const category = normalizedCategory(
    input.category === undefined ? undefined : normalizeCategory(db, profileId, input.category),
  );
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
 * 编辑只做「更正」：不保留修改前值（见 README「已知取舍」第 14 条）。
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

/**
 * 更正一笔支出（带分类字典归一）。`updateExpense` 不知道 Profile（导入/测试直接调用），
 * 因此把「别名 → 标准名」放在这一层：MCP 工具与 /api/quick 等写路径都走它。
 *
 * 只归一**本次显式传入**的 category；不传 category 时原值不动（不改已存在数据的分类）。
 */
export function updateExpenseChecked(
  db: DatabaseSync,
  profileId: string,
  id: string,
  patch: ExpensePatch,
): ExpenseRow {
  if (patch.category === undefined) return updateExpense(db, id, patch);
  return updateExpense(db, id, {
    ...patch,
    category: normalizeCategory(db, profileId, patch.category),
  });
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
  opts: { from?: string; to?: string; by?: string; limit?: number; offset?: number } = {},
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
  // offset 同样兜底：NaN/负数会让 SQLite 绑定失败或行为怪异（负 OFFSET 被当成 0，
  // 但 NaN 不是合法绑定值），非法输入一律回退 0，分页翻页不能因此报错。
  const rawOffset = opts.offset ?? 0;
  const offset = Number.isFinite(rawOffset) ? Math.max(0, Math.trunc(rawOffset)) : 0;
  const totalRow = db
    .prepare(`SELECT COUNT(*) AS n FROM expenses WHERE ${where}`)
    .get(...params) as { n: number };
  const rows = db
    .prepare(
      // `id` 兜底：spent_on + created_at（毫秒）都可能并列（导入/快速连续记账），
      // 排序键不唯一时 OFFSET 分页不能保证「页间不重复不跳行」。与 /api/expenses 同口径。
      `SELECT * FROM expenses WHERE ${where}
       ORDER BY spent_on DESC, created_at DESC, id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as unknown as ExpenseRow[];
  // 还有更多必须按「本次窗口末尾」判断：offset>0 时 total > rows.length 恒成立，
  // 只看这两个数会把最后一页也标成还有更多，调用方会一直空翻。
  return { rows, total: totalRow.n, hasMore: offset + rows.length < totalRow.n };
}

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
 * 状态页本月支出与预算对照都按同一区间算 —— 若这里再加一道「≤今天」上界，
 * 同一个「本月」数字会随日历推移忽增忽减（月初看不全、月中突然跳变），对不上账。
 *
 * 工具侧 `expense summary` 不传 month/from/to 时的默认区间是「月初 → 今天」，
 * 那是「本月至今」的查询默认，与本函数（状态页/预算）有意不同，见 modules/bookkeeping/index.ts。
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

/** 会被 Excel/Sheets 当公式起始的字符：= + - @，以及制表符/回车（前导空白绕过） */
const CSV_FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;

/**
 * CSV 公式注入中和（CSV injection）：Excel / Google Sheets 会把以 `= + - @` 或制表符/
 * 回车开头的单元格当**公式**执行 —— `=HYPERLINK("http://evil","点我")` 打开即触发，
 * `+1`/`-1` 也会被改写。做法是在**原值**前加一个单引号（视为纯文本），不需要转义的
 * 普通文本原样返回（不影响既有 CSV 断言）。
 *
 * 判断前先 `trimStart`：前导空格/制表符绕过是这类过滤最常见的绕过手法
 * （` =1` 在 Excel 里仍会按公式解析）。金额/日期等数字列不以这些字符开头，行为不变。
 */
export function sanitizeCsvCell(value: string): string {
  return CSV_FORMULA_PREFIX_RE.test(value.trimStart()) ? `'${value}` : value;
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
          // 日期/金额是数字列，不做公式中和（它们不以 = + - @ 开头）；
          // 文本列统一 sanitize 后再做 RFC 转义，防注入不能靠调用方自觉。
          csvField(row.spent_on),
          csvField(sanitizeCsvCell(row.ledger_name)),
          csvField(sanitizeCsvCell(row.category)),
          centsToYuan(row.amount_cents),
          csvField(sanitizeCsvCell(row.note ?? "")),
          csvField(sanitizeCsvCell(row.created_by_profile)),
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

/** 预算范围标签：'' 是账本总额预算，其余为分类预算 */
export function budgetScopeLabel(category: string): string {
  return category === "" ? "总额" : category;
}

/** 预算对照的四个字段（工具回显与预算看板复用） */
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

/** 看板「支出明细」的逐笔行（含账本名）。 */
export interface ExpenseEntry {
  id: string;
  ledger_id: string;
  ledger_name: string;
  amount_cents: number;
  category: string;
  note: string | null;
  spent_on: string;
  created_by_profile: string;
}

/** {@link expenseMonthAggregates} 的返回：各条查询的原始行，不做占比等派生计算。 */
export interface ExpenseMonthAggregates {
  /** 本月合计（分）与笔数 */
  totals: { cents: number; count: number };
  /** 按分类汇总，金额降序 */
  categories: { category: string; cents: number; count: number }[];
  /** 按天汇总，日期升序 */
  daily: { date: string; cents: number }[];
  /** 按账本汇总，金额降序 */
  ledgers: { ledger_id: string; ledger_name: string; cents: number; count: number }[];
  /** 本页逐笔（已按 limit/offset 分页） */
  entries: ExpenseEntry[];
  /** 上一个区间（prevFrom~prevTo）的合计（分） */
  prevCents: number;
}

/**
 * 看板用的某月支出聚合：合计、分类、按天、按账本、分页逐笔、上月合计，共 6 条 SELECT。
 *
 * `profileId` 给了时：可见账本 = 家庭账本（owner_profile_id IS NULL）+ 该 Profile 的个人账本；
 * 缺省 = 只家庭账本（master 的「家庭看板」口径，保持历史行为）。
 *
 * 为什么账本过滤要下推到每一条 SQL：合计/分类/按天/按账本/逐笔/上月对照共用同一口径，
 * 只在 entries 上过滤会让卡片合计与明细对不上（且会把别人的个人账本金额算进总额）。
 *
 * 6 条独立 SELECT 包在 `withReadTransaction` 里取一致快照：并发写入时否则「合计」与
 * 「分类/明细」会对不上（与 summarizeExpenses 同口径）。
 *
 * @param db 数据库连接
 * @param opts.from 本期起始日（含，YYYY-MM-DD）
 * @param opts.to 本期结束日（含）
 * @param opts.prevFrom 对照期起始日（含）
 * @param opts.prevTo 对照期结束日（含）
 * @param opts.profileId 可选，带上则额外包含该 Profile 的个人账本
 * @param opts.limit 逐笔分页大小
 * @param opts.offset 逐笔分页起点
 */
export function expenseMonthAggregates(
  db: DatabaseSync,
  opts: {
    from: string;
    to: string;
    prevFrom: string;
    prevTo: string;
    profileId?: string;
    limit: number;
    offset: number;
  },
): ExpenseMonthAggregates {
  const { from, to, prevFrom, prevTo, profileId, limit, offset } = opts;
  // SQL 片段只由本文件拼出（不含用户输入），Profile id 始终走参数绑定
  const ledgerFilter =
    profileId === undefined
      ? { sql: "l.owner_profile_id IS NULL", params: [] as string[] }
      : {
          sql: "(l.owner_profile_id IS NULL OR l.owner_profile_id = ?)",
          params: [profileId],
        };

  return withReadTransaction(db, () => {
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(e.amount_cents), 0) AS cents, COUNT(*) AS count
       FROM expenses e JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}`,
      )
      .get(from, to, ...ledgerFilter.params) as { cents: number; count: number };

    const categories = db
      .prepare(
        `SELECT e.category, SUM(e.amount_cents) AS cents, COUNT(*) AS count FROM expenses e
       JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}
       GROUP BY e.category ORDER BY cents DESC`,
      )
      .all(from, to, ...ledgerFilter.params) as {
      category: string;
      cents: number;
      count: number;
    }[];

    const daily = db
      .prepare(
        `SELECT e.spent_on AS date, SUM(e.amount_cents) AS cents FROM expenses e
       JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}
       GROUP BY e.spent_on ORDER BY e.spent_on`,
      )
      .all(from, to, ...ledgerFilter.params) as { date: string; cents: number }[];

    const ledgers = db
      .prepare(
        `SELECT e.ledger_id AS ledger_id, l.name AS ledger_name, SUM(e.amount_cents) AS cents, COUNT(*) AS count
       FROM expenses e JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}
       GROUP BY e.ledger_id ORDER BY cents DESC`,
      )
      .all(from, to, ...ledgerFilter.params) as {
      ledger_id: string;
      ledger_name: string;
      cents: number;
      count: number;
    }[];

    // 家庭看板只展示家庭账本；带 Profile 作用域时额外含**本人**个人账本（他人个人账本永不出现）。
    // 排序补上 e.id 兜底：spent_on + created_at 完全相同的两条在分页时有稳定顺序，
    // 否则 SQLite 的返回顺序不确定，翻页可能出现重复或漏行。
    const entries = db
      .prepare(
        `SELECT e.id, e.ledger_id, l.name AS ledger_name, e.amount_cents, e.category,
              e.note, e.spent_on, e.created_by_profile
       FROM expenses e JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}
       ORDER BY e.spent_on DESC, e.created_at DESC, e.id DESC LIMIT ? OFFSET ?`,
      )
      .all(from, to, ...ledgerFilter.params, limit, offset) as unknown as ExpenseEntry[];

    const prev = db
      .prepare(
        `SELECT COALESCE(SUM(e.amount_cents), 0) AS cents FROM expenses e
       JOIN ledgers l ON l.id = e.ledger_id
       WHERE e.spent_on >= ? AND e.spent_on <= ? AND ${ledgerFilter.sql}`,
      )
      .get(prevFrom, prevTo, ...ledgerFilter.params) as { cents: number };

    return { totals, categories, daily, ledgers, entries, prevCents: prev.cents };
  });
}

/**
 * 账本计数（状态页用）：profileId 缺省 = 只数家庭账本；给定 = 家庭 + 该 Profile 的个人账本。
 * archived=true 数已归档的，否则数活动的。
 */
export function countLedgers(
  db: DatabaseSync,
  opts: { archived: boolean; profileId?: string },
): number {
  const archivedCond = opts.archived ? "archived_at IS NOT NULL" : "archived_at IS NULL";
  const row =
    opts.profileId === undefined
      ? (db
          .prepare(
            `SELECT COUNT(*) AS n FROM ledgers WHERE ${archivedCond} AND owner_profile_id IS NULL`,
          )
          .get() as { n: number } | undefined)
      : (db
          .prepare(
            `SELECT COUNT(*) AS n FROM ledgers
               WHERE ${archivedCond} AND (owner_profile_id IS NULL OR owner_profile_id = ?)`,
          )
          .get(opts.profileId) as { n: number } | undefined);
  return row?.n ?? 0;
}

/** 活动的家庭账本（预算看板用），按名称、id 排序 */
export function listActiveFamilyLedgers(db: DatabaseSync): { id: string; name: string }[] {
  return db
    .prepare(
      `SELECT id, name FROM ledgers
       WHERE owner_profile_id IS NULL AND archived_at IS NULL
       ORDER BY name, id`,
    )
    .all() as { id: string; name: string }[];
}
