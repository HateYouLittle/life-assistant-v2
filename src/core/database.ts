import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "./logger.js";

export const SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settings (
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (profile_id, key)
) STRICT;

CREATE TABLE IF NOT EXISTS cache (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

-- QWeather 每日上游请求计数（按本地日历日）。独立于 cache：计量不是可过期缓存，
-- 混进 cache 会让「缓存体积治理」时误删/误留用量行（旧实现借道 cache 的 400 天 TTL 行）。
CREATE TABLE IF NOT EXISTS qweather_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL CHECK (requests >= 0)
) STRICT;

CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  -- 归属 Profile：NULL = 家庭账本（所有 Profile 共享）；非空 = 个人账本（仅归属人可见可写）。
  -- 与 expenses.created_by_profile 一样用裸 TEXT，不加外键（Profile 是软引用）。
  owner_profile_id TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category TEXT NOT NULL DEFAULT '其他',
  note TEXT,
  spent_on TEXT NOT NULL,
  created_by_profile TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_expenses_ledger_date ON expenses(ledger_id, spent_on);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(ledger_id, category);

-- 账本预算：category = '' 表示账本总额预算，否则为分类预算。每账本每月滚动（对照当月支出）。
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  category TEXT NOT NULL DEFAULT '',
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (ledger_id, category)
) STRICT;

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  note TEXT,
  kind TEXT NOT NULL DEFAULT 'todo' CHECK (kind IN ('todo','birthday','anniversary')),
  calendar TEXT NOT NULL DEFAULT 'solar' CHECK (calendar IN ('solar','lunar')),
  start_date TEXT,
  lunar_month INTEGER CHECK (lunar_month IS NULL OR (lunar_month >= 1 AND lunar_month <= 12)),
  lunar_day INTEGER CHECK (lunar_day IS NULL OR (lunar_day >= 1 AND lunar_day <= 30)),
  leap_policy TEXT CHECK (leap_policy IS NULL OR leap_policy IN ('follow','regular')),
  lunar_clamp INTEGER NOT NULL DEFAULT 1,
  time TEXT NOT NULL DEFAULT '09:00',
  all_day INTEGER NOT NULL DEFAULT 1 CHECK (all_day IN (0,1)),
  recurrence_json TEXT,
  remind_offsets_json TEXT NOT NULL DEFAULT '[0]',
  resend_minutes INTEGER NOT NULL DEFAULT 0,
  /** 逾期升级阶梯（分钟偏移 JSON 数组，升序）；NULL = 不启用，见 modules/schedule */
  escalation_json TEXT,
  workday_filter TEXT NOT NULL DEFAULT 'any' CHECK (workday_filter IN ('any','workday','holiday')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','cancelled')),
  next_run_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_schedules_profile ON schedules(profile_id, status);

CREATE TABLE IF NOT EXISTS occurrences (
  schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  occurrence_key TEXT NOT NULL,
  event_at TEXT NOT NULL,
  due_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','notified','done','cancelled')),
  PRIMARY KEY (schedule_id, occurrence_key)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_occurrences_due ON occurrences(status, due_at);
CREATE INDEX IF NOT EXISTS idx_occurrences_schedule_status ON occurrences(schedule_id, status);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body_md TEXT NOT NULL,
  blocks_json TEXT,
  dedupe_key TEXT,
  read INTEGER NOT NULL DEFAULT 0 CHECK (read IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE (profile_id, dedupe_key)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_notifications_pull ON notifications(profile_id, read, created_at);

CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  route_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','failed','fallback','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  confirmed_failures INTEGER NOT NULL DEFAULT 0,
  transport_failures INTEGER NOT NULL DEFAULT 0,
  generation INTEGER NOT NULL DEFAULT 0,
  request_id TEXT,
  request_started_at TEXT,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  /**
   * 1 = 被对端**确定性拒绝**（4xx/3xx 等，改参数也不会变的拒绝，见 core/notify.ts 的
   * markTerminalFallback）。这类行不该被 requeueRoute 重新入队：重发只会原样再被拒一次。
   * 与「从未发出过」（request_started_at IS NULL）、「已发出但结果不确定」严格区分开 ——
   * 后两者仍要靠路由恢复重新入队，所以不能只靠 last_error 的 "HTTP " 前缀猜。
   */
  deterministic_reject INTEGER NOT NULL DEFAULT 0,
  /** 投递截止时刻（ISO）：到点仍未投出即作废，见 core/notify.ts 的 drainDue */
  expire_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_deliveries_due ON deliveries(status, next_attempt_at);

CREATE TABLE IF NOT EXISTS cn_holiday_days (
  date TEXT PRIMARY KEY,
  year INTEGER NOT NULL,
  day_type TEXT NOT NULL CHECK (day_type IN ('holiday','workday')),
  name TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_holiday_year ON cn_holiday_days(year);

CREATE TABLE IF NOT EXISTS cn_holiday_years (
  year INTEGER PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ready','failed')),
  source TEXT NOT NULL,
  fetched_at TEXT NOT NULL,
  last_attempt_at TEXT,
  last_error TEXT
) STRICT;
`;

export function openDatabase(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

/** 幂等加列：老库补列时用（STRICT 表允许追加可空列） */
function addColumnIfMissing(db: DatabaseSync, table: string, column: string, type: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

/**
 * 活动账本名的**分范围**唯一索引：家庭账本（owner_profile_id IS NULL）之间唯一，
 * 每个 Profile 的个人账本各自唯一 —— 于是不同人可建同名个人账本，也不会因「创建失败」
 * 泄露他人账本名。部分索引仅在 archived_at IS NULL 时约束（归档账本允许重名，与既有语义一致）。
 *
 * 必须在 owner_profile_id 补列之后调用（v1/v2 老库此时才有该列）；旧的全局唯一索引
 * `idx_ledgers_active_name` 必须显式 DROP —— 否则它仍在暗中强制全局唯一，与本语义冲突。
 * best-effort：历史库若已存在同范围重名，建索引会失败；只告警、不拒绝启动。
 */
function ensureLedgerNameIndex(db: DatabaseSync): void {
  try {
    db.exec("DROP INDEX IF EXISTS idx_ledgers_active_name");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_scoped_name ON ledgers(name, COALESCE(owner_profile_id, '')) WHERE archived_at IS NULL",
    );
  } catch (e) {
    logger.warn(
      `未能创建活动账本名唯一索引（可能存在历史同范围重名账本，请人工核查后重试）: ${String(e)}`,
    );
  }
}

/**
 * 旧实现把 QWeather 每日用量寄存在 cache 表的 `qweather:usage:<day>`（400 天 TTL），
 * 与天气缓存混在一起。迁到独立的 qweather_usage 表后清掉残留，避免两处口径并存。
 * 幂等：残留行被删除后下次为空，直接返回。
 */
function migrateLegacyQweatherUsage(db: DatabaseSync): void {
  const rows = db
    .prepare("SELECT key, value_json FROM cache WHERE key LIKE 'qweather:usage:%'")
    .all() as { key: string; value_json: string }[];
  if (rows.length === 0) return;
  const upsert = db.prepare(
    `INSERT INTO qweather_usage (day, requests) VALUES (?, ?)
     ON CONFLICT (day) DO UPDATE SET requests = MAX(requests, excluded.requests)`,
  );
  for (const { key, value_json } of rows) {
    const day = key.slice("qweather:usage:".length);
    const n = Number(value_json);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(n) || n < 0) continue;
    upsert.run(day, Math.trunc(n));
  }
  db.prepare("DELETE FROM cache WHERE key LIKE 'qweather:usage:%'").run();
}

export function migrate(db: DatabaseSync): void {
  db.exec(DDL);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  let stored: number;
  if (row === undefined) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
    stored = SCHEMA_VERSION;
  } else {
    const parsed = Number(row.value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`数据库 schema 版本不合法: ${row.value}，拒绝启动`);
    }
    if (parsed > SCHEMA_VERSION) {
      throw new Error(`数据库 schema 版本 ${parsed} 高于程序支持的 ${SCHEMA_VERSION}，拒绝启动`);
    }
    stored = parsed;
  }
  // 逐级升级（附加式）：只加列/加表，不动既有数据；中途失败会抛出，由调用方关库拒绝启动
  let version = stored;
  if (version === 1) {
    addColumnIfMissing(db, "deliveries", "expire_at", "TEXT");
    version = 2;
  }
  if (version === 2) {
    // 账本归属：老库所有既有账本补 owner_profile_id = NULL，视为家庭账本，行为不变。
    addColumnIfMissing(db, "ledgers", "owner_profile_id", "TEXT");
    version = 3;
  }
  if (version !== stored) {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
    logger.info(`数据库 schema 已从 v${stored} 升级到 v${version}`);
  }
  // 幂等补列：老库（含 v2）补 schedules.escalation_json；新库由 DDL 直接建出。
  // 不提升 SCHEMA_VERSION、不重建 schedules（kind 有 CHECK，重建会牵动 occurrences 外键）。
  addColumnIfMissing(db, "schedules", "escalation_json", "TEXT");
  // 同理补 deliveries.deterministic_reject（纯附加列，默认 0 = 非确定性拒绝，
  // 与升级前「所有 fallback 行都可重投」的既有行为一致，老数据不会被静默改语义）。
  addColumnIfMissing(db, "deliveries", "deterministic_reject", "INTEGER NOT NULL DEFAULT 0");
  // 索引依赖 owner_profile_id：必须放在上面的补列之后
  ensureLedgerNameIndex(db);
  // 用量从 cache 迁到独立表（一次性；幂等）
  migrateLegacyQweatherUsage(db);
}

export function getSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row === undefined ? 0 : Number(row.value);
}

export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * 读事务（BEGIN DEFERRED）：一份报表里的多条 SELECT 需要一个一致的快照。
 * 单条语句在 SQLite 里本身就是原子的，但「合计 + 分类明细 + 按人汇总」这类
 * 三条独立语句之间若有写入落库，就会出现合计与明细对不上的结果。
 * 已是事务状态时直接复用外层快照，不嵌套 BEGIN（SQLite 会报「cannot start a
 * transaction within a transaction」）。
 */
export function withReadTransaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN DEFERRED");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
