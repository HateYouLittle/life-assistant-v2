import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { runImport } from "../src/import-v1.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

const OLD_DDL = `
CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE profile_settings (profile_id TEXT PRIMARY KEY, quiet_start TEXT, quiet_end TEXT, timezone TEXT, updated_at TEXT NOT NULL);
CREATE TABLE schedules (
  profile_id TEXT NOT NULL, id TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'todo', title TEXT NOT NULL, note TEXT,
  priority TEXT NOT NULL DEFAULT 'normal', status TEXT NOT NULL DEFAULT 'active', calendar TEXT NOT NULL,
  date TEXT, lunar_month INTEGER, lunar_day INTEGER, leap_month_policy TEXT, time TEXT NOT NULL DEFAULT '09:00',
  all_day INTEGER NOT NULL DEFAULT 1, timezone TEXT NOT NULL, recurrence_json TEXT NOT NULL, reminders_json TEXT NOT NULL,
  deadline_at TEXT, deadline_offset_minutes INTEGER, reminder_interval_minutes INTEGER, reminder_max_attempts INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT, version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (profile_id, id)
);
CREATE TABLE schedule_occurrences (
  profile_id TEXT NOT NULL, schedule_id TEXT NOT NULL, occurrence_key TEXT NOT NULL, occurrence_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', PRIMARY KEY (profile_id, schedule_id, occurrence_key)
);
CREATE TABLE ledgers (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL, owner_profile_id TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE ledger_entries (
  ledger_id TEXT NOT NULL, id TEXT NOT NULL, profile_id TEXT NOT NULL, type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL, category TEXT, account_id TEXT, to_account_id TEXT, occurred_at TEXT NOT NULL,
  note TEXT, version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (ledger_id, id)
);
CREATE TABLE cn_holiday_days (
  date TEXT PRIMARY KEY, year INTEGER NOT NULL, day_type TEXT NOT NULL, name TEXT NOT NULL,
  source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE cn_holiday_year_meta (
  year INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ready', source TEXT NOT NULL,
  payload_hash TEXT NOT NULL, fetched_at TEXT NOT NULL, last_attempt_at TEXT, last_error TEXT
);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function buildOldDb(path: string): void {
  const db = new DatabaseSync(path);
  db.exec(OLD_DDL);
  const ts = "2026-01-01T00:00:00.000Z";
  db.prepare("INSERT INTO profiles VALUES ('p1', ?)").run(ts);
  db.prepare("INSERT INTO profiles VALUES ('partner', ?)").run(ts);
  db.prepare("INSERT INTO profile_settings VALUES ('p1', '22:00', '07:00', 'Asia/Shanghai', ?)").run(ts);
  const insert = db.prepare(
    `INSERT INTO schedules (profile_id, id, type, title, status, calendar, date, lunar_month, lunar_day,
       leap_month_policy, time, all_day, timezone, recurrence_json, reminders_json, reminder_interval_minutes,
       enabled, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 0, 'Asia/Shanghai', ?, ?, ?, 1, 1, ?, ?)`,
  );
  insert.run("p1", "s1", "todo", "每两天提醒", "solar", "2026-01-01", null, null, null, "09:00",
    JSON.stringify({ frequency: "daily", interval: 2 }), JSON.stringify([{ minutesBefore: 30 }]), null, ts, ts);
  insert.run("p1", "s2", "birthday", "妈妈生日", "lunar", null, 5, 5, "leap", "09:00",
    JSON.stringify({ frequency: "yearly", calendar: "lunar", leapMonthPolicy: "leap" }), "[]", null, ts, ts);
  insert.run("p1", "s3", "todo", "工作日打卡", "solar", "2026-02-02", null, null, null, "08:30",
    JSON.stringify({ frequency: "workday", interval: 1 }), "[]", null, ts, ts);
  insert.run("p1", "s4", "todo", "坏数据", "solar", "2026-03-01", null, null, null, "09:00",
    "{not json", "[]", null, ts, ts);
  db.prepare(
    "INSERT INTO schedule_occurrences VALUES ('p1', 's1', '2026-01-01T09:00', '2026-01-01T09:00', 'pending')",
  ).run();
  db.prepare("INSERT INTO ledgers VALUES ('l1', 'shared', '家庭账本', 'p1', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO ledgers VALUES ('l2', 'personal', '个人账本', 'p1', ?, ?)").run(ts, ts);
  const entry = db.prepare(
    "INSERT INTO ledger_entries (ledger_id, id, profile_id, type, amount_cents, category, occurred_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  entry.run("l1", "e1", "p1", "expense", 2500, "餐饮", "2026-01-05T12:00:00.000Z", ts, ts);
  entry.run("l1", "e2", "partner", "expense", 1000, "交通", "2026-01-06T12:00:00.000Z", ts, ts);
  entry.run("l1", "e3", "p1", "income", 500000, "工资", "2026-01-10T12:00:00.000Z", ts, ts);
  db.prepare("INSERT INTO cn_holiday_days VALUES ('2026-01-01', 2026, 'holiday', '元旦', 'test', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO cn_holiday_days VALUES ('2026-01-24', 2026, 'workday', '调休', 'test', ?, ?)").run(ts, ts);
  db.prepare("INSERT INTO cn_holiday_year_meta VALUES (2026, 'ready', 'test', 'hash', ?, NULL, NULL)").run(ts);
  db.close();
}

describe("import:v1", () => {
  it("完整映射旧库并输出报告", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const report = runImport(env.db, oldPath);
      assert.equal(report.profiles, 2);
      assert.equal(report.schedules, 4);
      assert.equal(report.ledgers, 2);
      assert.equal(report.expenses, 2);
      assert.equal(report.entriesSkipped, 1);
      assert.equal(report.holidayDays, 2);
      assert.equal(report.holidayYears, 1);
      assert.equal(report.occurrencesDropped, 1);
      assert.ok(report.scheduleWarnings.some((w) => w.includes("坏数据")));
      assert.ok(report.scheduleWarnings.some((w) => w.includes("全局可编辑")));

      const s1 = env.db.prepare("SELECT * FROM schedules WHERE id = 's1'").get() as unknown as Record<string, unknown>;
      assert.equal(s1.status, "active");
      assert.equal(s1.workday_filter, "any");
      assert.equal(s1.remind_offsets_json, "[-30]");
      assert.deepEqual(JSON.parse(s1.recurrence_json as string), { freq: "daily", interval: 2 });

      const s2 = env.db.prepare("SELECT * FROM schedules WHERE id = 's2'").get() as unknown as Record<string, unknown>;
      assert.equal(s2.kind, "birthday");
      assert.equal(s2.leap_policy, "follow");
      assert.deepEqual(JSON.parse(s2.recurrence_json as string), { freq: "yearly", interval: 1 });

      const s3 = env.db.prepare("SELECT * FROM schedules WHERE id = 's3'").get() as unknown as Record<string, unknown>;
      assert.equal(s3.workday_filter, "workday");

      const s4 = env.db.prepare("SELECT recurrence_json FROM schedules WHERE id = 's4'").get() as { recurrence_json: string };
      assert.equal(s4.recurrence_json, null);

      const quiet = env.db
        .prepare("SELECT value_json FROM settings WHERE profile_id = 'p1' AND key = 'quiet_hours'")
        .get() as { value_json: string };
      assert.equal(quiet.value_json, '{"start":"22:00","end":"07:00"}');

      const expense = env.db.prepare("SELECT * FROM expenses WHERE id = 'e2'").get() as unknown as Record<string, unknown>;
      assert.equal(expense.created_by_profile, "partner");
      assert.equal(expense.spent_on, "2026-01-06");
      const expenseCount = env.db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as { n: number };
      assert.equal(expenseCount.n, 2);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("completed 映射为 done，且不以 enabled=0 推导取消", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const old = new DatabaseSync(oldPath);
      const ts = "2026-01-01T00:00:00.000Z";
      const insert = old.prepare(
        `INSERT INTO schedules (profile_id, id, type, title, status, calendar, date, time, all_day, timezone,
           recurrence_json, reminders_json, enabled, version, created_at, updated_at)
         VALUES (?, ?, 'todo', ?, ?, 'solar', ?, '09:00', 0, 'Asia/Shanghai', '{}', '[]', ?, 1, ?, ?)`,
      );
      insert.run("p1", "s5", "已完成且enabled0", "completed", "2026-04-01", 0, ts, ts);
      insert.run("p1", "s6", "已完成且enabled1", "completed", "2026-04-02", 1, ts, ts);
      insert.run("p1", "s7", "奇怪状态", "weird", "2026-04-03", 1, ts, ts);
      old.close();

      const report = runImport(env.db, oldPath);
      const statusOf = (id: string): string =>
        (env.db.prepare("SELECT status FROM schedules WHERE id = ?").get(id) as { status: string }).status;
      assert.equal(statusOf("s5"), "done");
      assert.equal(statusOf("s6"), "done");
      assert.equal(statusOf("s7"), "active");
      assert.ok(report.scheduleWarnings.some((w) => w.includes("weird")), "无法识别的状态应写 warning");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("支出日期按本地时区换算，不取 UTC 截断", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const old = new DatabaseSync(oldPath);
      const ts = "2026-01-01T00:00:00.000Z";
      old
        .prepare(
          `INSERT INTO ledger_entries (ledger_id, id, profile_id, type, amount_cents, category, occurred_at, created_at, updated_at)
           VALUES (?, ?, ?, 'expense', ?, ?, ?, ?, ?)`,
        )
        .run("l1", "e9", "p1", 8800, "餐饮", "2026-09-02T16:00:00.000Z", ts, ts);
      old.close();

      runImport(env.db, oldPath);
      const e = env.db.prepare("SELECT spent_on FROM expenses WHERE id = 'e9'").get() as { spent_on: string };
      assert.equal(e.spent_on, "2026-09-03", "UTC 16:00 应换算为北京次日");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("拒绝导入非空目标库（--force 除外）", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      env.db.prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('x', '已有账本', '2026-01-01T00:00:00.000Z')").run();
      assert.throws(() => runImport(env.db, oldPath), /非空/);
      const report = runImport(env.db, oldPath, true);
      assert.equal(report.schedules, 4);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
