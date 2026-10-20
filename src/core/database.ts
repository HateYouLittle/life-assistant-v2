import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { TZ } from "../time.js";
import { reconcileSchemaFingerprint } from "./fingerprint.js";
import { logger } from "./logger.js";

/**
 * v4 新增：job_runs 运行记录表、expenses/schedules.client_token（写路径幂等键）。
 * v5 新增：audit_log 审计日志表（手机写 API 的操作留痕）；同时开始记录
 * `meta.schema_fingerprint`（结构指纹，见 core/fingerprint.ts）。
 * 迁移前必须先备份：openDatabase 传了 backupDir 时会 VACUUM INTO 一份
 * `life-assistant-pre-v<旧版本>-<时间戳>.db`，失败则拒绝启动（宁可停，不带病改库）。
 */
export const SCHEMA_VERSION = 5;

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

-- 定时任务运行记录：每次 job 执行一行（cron / startup / catchup / manual）。
-- 用途：① 启动补发判定「这个 job 自上次成功后是否又该跑了」；② /api/jobs 与状态页
-- 「定时任务」卡片；③ doctor --live 判断推送是否真的在跑。只增不改（除 finish 回填），
-- 由保留策略按天数清理（core/retention.ts）。
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name TEXT NOT NULL,
  module TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('cron','startup','catchup','manual')),
  scheduled_for TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','ok','failed','skipped')),
  error TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_job_runs_name ON job_runs(job_name, started_at DESC);

CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  -- 归属 Profile：NULL = 家庭账本（所有 Profile 共享）；非空 = 个人账本（仅归属人可见可写）。
  -- 与 expenses.created_by_profile 一样用裸 TEXT，不加外键（Profile 是软引用）。
  owner_profile_id TEXT
) STRICT;

-- 列定义里不要写含 ASCII 括号的行注释：Node 22 自带的 SQLite 在 ALTER TABLE
-- DROP COLUMN 时会按 token 重建建表语句，注释里的括号会让重建结果变成非法 SQL
-- （tests/database.test.ts 的 v3 回滚用例在 CI Node 22 上复现过 "incomplete input"）。
-- 列级说明统一放在 CREATE TABLE 之前。
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY,
  ledger_id TEXT NOT NULL REFERENCES ledgers(id) ON DELETE CASCADE,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category TEXT NOT NULL DEFAULT '其他',
  note TEXT,
  spent_on TEXT NOT NULL,
  created_by_profile TEXT NOT NULL,
  created_at TEXT NOT NULL,
  client_token TEXT
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

-- schedules.client_token：写路径幂等键（可选、可空）。唯一性按 (profile_id, client_token)
-- 分范围，见 migrate 的 ensureClientTokenIndexes；同样不要在列定义内写含括号的注释。
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
  updated_at TEXT NOT NULL,
  client_token TEXT
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
-- 保留策略的通知级联删除、状态页按通知 JOIN 都会按 notification_id 过滤；
-- 缺这个索引时每次级联都是全表扫。
CREATE INDEX IF NOT EXISTS idx_deliveries_notification ON deliveries(notification_id);

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

-- 审计日志（v5）：记录谁在何时对什么做了什么。首期只接手机写 API（quick.expense.add /
-- quick.schedule.add）：那是唯一不经 MCP、直接由 HTTP 凭据驱动的写路径。
-- 只增不改；detail_json 只放非隐私摘要，不放 token/备注全文。
-- 注意：本注释区域不要出现半角圆括号，Node 22 的 SQLite 重建表时会按 token 解析建表语句。
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id),
  action TEXT NOT NULL,
  target_kind TEXT,
  target_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_profile ON audit_log(profile_id, created_at);
`;

export interface OpenDatabaseOptions {
  /**
   * 迁移前备份目录（daemon 传 config.backupDir）。不传 = 不备份（测试/一次性工具）。
   * 升级 schema 属于「改既有数据」的动作：先落一份 VACUUM INTO 快照，失败就拒绝启动。
   */
  backupDir?: string;
}

/**
 * schema 需要前滚时先备份。用同一个连接做 VACUUM INTO：拿到的是与主库一致的快照，
 * 且不受并发 writer 影响（VACUUM 会等待写锁，busy_timeout 已设 5s）。
 * 已是最新版本 / 全新库（meta 还没建）直接返回。
 */
function backupBeforeMigration(
  db: DatabaseSync,
  backupDir: string | undefined,
  dbPath: string,
): void {
  let stored: number | undefined;
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
    if (row !== undefined) {
      const parsed = Number(row.value);
      stored = Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
    }
  } catch {
    // 全新库：meta 表还不存在，没有可备份的数据
    return;
  }
  if (stored === undefined || stored >= SCHEMA_VERSION) return;
  if (backupDir === undefined) {
    logger.warn(
      `数据库 schema v${stored} 需要升级到 v${SCHEMA_VERSION}，但未提供备份目录，已跳过迁移前备份`,
    );
    return;
  }
  mkdirSync(backupDir, { recursive: true });
  const stamp = DateTime.fromMillis(Date.now(), { zone: TZ }).toFormat("yyyyMMdd-HHmmss");
  const target = join(backupDir, `life-assistant-pre-v${stored}-${stamp}.db`);
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } catch (e) {
    throw new Error(
      `迁移前备份失败，拒绝升级 schema（数据库未改动）: ${dbPath} -> ${target}: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  logger.info(`迁移前已备份 schema v${stored} 数据库: ${target}`);
}

export function openDatabase(dbPath: string, opts: OpenDatabaseOptions = {}): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    backupBeforeMigration(db, opts.backupDir, dbPath);
    migrate(db);
    // 结构指纹必须在迁移之后对账：迁移本身会加表/加列，先算再迁移会把合法变化误报成漂移。
    // 缺失则写入；不同则 warn 一次后以当前结构为准（见 core/fingerprint.ts）。
    reconcileSchemaFingerprint(db);
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
 *
 * 失败不再只是告警：本索引是「不同人可建同名个人账本」语义的唯一保障，缺了它
 * 应用层仍会按名字查找账本，可能出现跨范围重名导致的串账。历史库若真有同范围重名，
 * 拒绝启动并让用户人工核查（由 migrate 的调用方关库抛错）。
 */
function ensureLedgerNameIndex(db: DatabaseSync): void {
  try {
    db.exec("DROP INDEX IF EXISTS idx_ledgers_active_name");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_ledgers_scoped_name ON ledgers(name, COALESCE(owner_profile_id, '')) WHERE archived_at IS NULL",
    );
  } catch (e) {
    throw new Error(
      `活动账本名唯一索引创建失败（可能存在同范围重名账本，请核查 ledgers 表后重试）: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * 写路径幂等键的分范围唯一索引：同一 Profile（日程）/同一创建人（支出）内 token 唯一，
 * 不同人可重复（各自的请求 id 撞车不该互相抑制）。NULL 不参与约束 —— 历史行没有 token。
 * 依赖 client_token 补列，必须在 v3→v4 之后调用；与 ensureLedgerNameIndex 同理不提升版本号。
 */
function ensureClientTokenIndexes(db: DatabaseSync): void {
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_expenses_client_token ON expenses(created_by_profile, client_token) WHERE client_token IS NOT NULL",
  );
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_schedules_client_token ON schedules(profile_id, client_token) WHERE client_token IS NOT NULL",
  );
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
  let from = 0;
  // DDL + 逐级升级 + 幂等补列/索引在同一个事务里：要么整库升到目标版本，要么完全不动。
  // 旧实现分步执行，中途失败（磁盘满/并发写/CHECK 冲突）会留下「版本号已前滚、列还没补」
  // 的半升级状态，只能人工修库。SQLite 的 DDL 本身是事务性的，没有理由不包起来。
  withTransaction(db, () => {
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
    from = stored;
    // 逐级升级（附加式）：只加列/加表，不动既有数据；中途失败回滚整笔事务并拒绝启动
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
    if (version === 3) {
      // 写路径幂等键（P1-12c）：同一 Profile / 同一创建人内唯一，NULL 不参与约束
      addColumnIfMissing(db, "expenses", "client_token", "TEXT");
      addColumnIfMissing(db, "schedules", "client_token", "TEXT");
      version = 4;
    }
    if (version === 4) {
      // v5：audit_log 已由上面的 DDL 建出（CREATE TABLE IF NOT EXISTS），没有数据变换；
      // 这一步只前滚版本号。老库数据原样保留，重复打开幂等。
      version = 5;
    }
    if (version !== stored) {
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
    }
    // 幂等补列：老库（含 v2）补 schedules.escalation_json；新库由 DDL 直接建出。
    // 不提升 SCHEMA_VERSION、不重建 schedules（kind 有 CHECK，重建会牵动 occurrences 外键）。
    addColumnIfMissing(db, "schedules", "escalation_json", "TEXT");
    // 同理补 deliveries.deterministic_reject（纯附加列，默认 0 = 非确定性拒绝，
    // 与升级前「所有 fallback 行都可重投」的既有行为一致，老数据不会被静默改语义）。
    addColumnIfMissing(db, "deliveries", "deterministic_reject", "INTEGER NOT NULL DEFAULT 0");
    // 索引依赖上面补的列：必须放在补列之后
    ensureLedgerNameIndex(db);
    ensureClientTokenIndexes(db);
    // 用量从 cache 迁到独立表（一次性；幂等）
    migrateLegacyQweatherUsage(db);
  });
  const to = getSchemaVersion(db);
  if (to !== from) logger.info(`数据库 schema 已从 v${from} 升级到 v${to}`);
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
