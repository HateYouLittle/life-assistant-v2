import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { logger } from "./logger.js";

export const SCHEMA_VERSION = 2;

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

CREATE TABLE IF NOT EXISTS ledgers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived_at TEXT
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

export function migrate(db: DatabaseSync): void {
  db.exec(DDL);
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) {
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION),
    );
    return;
  }
  const stored = Number(row.value);
  if (!Number.isInteger(stored) || stored < 1) {
    throw new Error(`数据库 schema 版本不合法: ${row.value}，拒绝启动`);
  }
  if (stored > SCHEMA_VERSION) {
    throw new Error(`数据库 schema 版本 ${stored} 高于程序支持的 ${SCHEMA_VERSION}，拒绝启动`);
  }
  // 逐级升级（附加式）：只加列/加表，不动既有数据；中途失败会抛出，由调用方关库拒绝启动
  let version = stored;
  if (version === 1) {
    addColumnIfMissing(db, "deliveries", "expire_at", "TEXT");
    version = 2;
  }
  if (version !== stored) {
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(version));
    logger.info(`数据库 schema 已从 v${stored} 升级到 v${version}`);
  }
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
