import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveOldDbPath, runImport } from "../src/import-v1.js";
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
  db.prepare(
    "INSERT INTO profile_settings VALUES ('p1', '22:00', '07:00', 'Asia/Shanghai', ?)",
  ).run(ts);
  const insert = db.prepare(
    `INSERT INTO schedules (profile_id, id, type, title, status, calendar, date, lunar_month, lunar_day,
       leap_month_policy, time, all_day, timezone, recurrence_json, reminders_json, reminder_interval_minutes,
       enabled, version, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, 0, 'Asia/Shanghai', ?, ?, ?, 1, 1, ?, ?)`,
  );
  insert.run(
    "p1",
    "s1",
    "todo",
    "每两天提醒",
    "solar",
    "2026-01-01",
    null,
    null,
    null,
    "09:00",
    JSON.stringify({ frequency: "daily", interval: 2 }),
    JSON.stringify([{ minutesBefore: 30 }]),
    null,
    ts,
    ts,
  );
  insert.run(
    "p1",
    "s2",
    "birthday",
    "妈妈生日",
    "lunar",
    null,
    5,
    5,
    "leap",
    "09:00",
    JSON.stringify({ frequency: "yearly", calendar: "lunar", leapMonthPolicy: "leap" }),
    "[]",
    null,
    ts,
    ts,
  );
  insert.run(
    "p1",
    "s3",
    "todo",
    "工作日打卡",
    "solar",
    "2026-02-02",
    null,
    null,
    null,
    "08:30",
    JSON.stringify({ frequency: "workday", interval: 1 }),
    "[]",
    null,
    ts,
    ts,
  );
  insert.run(
    "p1",
    "s4",
    "todo",
    "坏数据",
    "solar",
    "2026-03-01",
    null,
    null,
    null,
    "09:00",
    "{not json",
    "[]",
    null,
    ts,
    ts,
  );
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
  db.prepare(
    "INSERT INTO cn_holiday_days VALUES ('2026-01-01', 2026, 'holiday', '元旦', 'test', ?, ?)",
  ).run(ts, ts);
  db.prepare(
    "INSERT INTO cn_holiday_days VALUES ('2026-01-24', 2026, 'workday', '调休', 'test', ?, ?)",
  ).run(ts, ts);
  db.prepare(
    "INSERT INTO cn_holiday_year_meta VALUES (2026, 'ready', 'test', 'hash', ?, NULL, NULL)",
  ).run(ts);
  db.close();
}

describe("import:v1 旧库路径解析", () => {
  function touch(path: string): void {
    writeFileSync(path, "");
  }

  it("优先命中固定候选名（含 V1 实际的 life-assistant.sqlite）", () => {
    const env = makeTestEnv();
    try {
      const dir = `${env.dir}/data`;
      mkdirSync(dir);
      touch(`${dir}/life-assistant.sqlite`);
      touch(`${dir}/life-assistant.sqlite-wal`);
      touch(`${dir}/life-assistant.sqlite-shm`);
      assert.equal(resolveOldDbPath(dir), join(dir, "life-assistant.sqlite"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("固定名单未命中时，唯一 *.sqlite 自动使用，且排除 -wal/-shm/备份", () => {
    const env = makeTestEnv();
    try {
      const dir = `${env.dir}/data`;
      mkdirSync(dir);
      touch(`${dir}/custom.sqlite`);
      touch(`${dir}/custom.sqlite-wal`);
      touch(`${dir}/custom.sqlite-shm`);
      touch(`${dir}/archive.db.bak-20260101`);
      touch(`${dir}/old.db.backup-2`);
      assert.equal(resolveOldDbPath(dir), join(dir, "custom.sqlite"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("多个候选时报错并列出全部候选", () => {
    const env = makeTestEnv();
    try {
      const dir = `${env.dir}/data`;
      mkdirSync(dir);
      touch(`${dir}/a.db`);
      touch(`${dir}/b.sqlite`);
      assert.throws(() => resolveOldDbPath(dir), /多个候选[\s\S]*a\.db[\s\S]*b\.sqlite/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("无候选时报错并列出尝试过的固定名", () => {
    const env = makeTestEnv();
    try {
      const dir = `${env.dir}/data`;
      mkdirSync(dir);
      assert.throws(() => resolveOldDbPath(dir), /life-assistant\.sqlite/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("import:v1", () => {
  it("profile_settings 里的非法 Profile 名被逐行隔离，不落库（状态页注入入口的回归）", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old-invalid-profile.db`;
      const old = new DatabaseSync(oldPath);
      old.exec(`
        CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
        CREATE TABLE profile_settings (profile_id TEXT PRIMARY KEY, quiet_start TEXT, quiet_end TEXT,
          timezone TEXT, updated_at TEXT NOT NULL);
      `);
      const ts = "2026-01-01T00:00:00.000Z";
      old.prepare("INSERT INTO profiles VALUES ('p1', ?)").run(ts);
      old
        .prepare("INSERT INTO profile_settings VALUES ('p1','22:00','07:00','Asia/Shanghai',?)")
        .run(ts);
      old
        .prepare("INSERT INTO profile_settings VALUES (?,'22:00','07:00','Asia/Shanghai',?)")
        .run("<img src=x onerror=alert(1)>", ts);
      old.close();

      const report = runImport(env.db, oldPath);
      assert.ok(
        report.problems.some(
          (p) => p.table === "profile_settings" && p.reason.includes("Profile 名不合法"),
        ),
        `非法 Profile 名应被隔离并记入报告，实际 ${JSON.stringify(report.problems)}`,
      );
      const ids = (env.db.prepare("SELECT id FROM profiles").all() as { id: string }[]).map(
        (r) => r.id,
      );
      assert.ok(
        !ids.some((id) => id.includes("<")),
        `非法 Profile 名进了库：${JSON.stringify(ids)}`,
      );
      assert.ok(ids.includes("p1"), "合法的 Profile 仍应正常导入");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("星期名命中原型链（constructor）不会产出 null（Object.hasOwn 回归）", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const old = new DatabaseSync(oldPath);
      const ts = "2026-01-01T00:00:00.000Z";
      old
        .prepare(
          `INSERT INTO schedules (profile_id, id, type, title, status, calendar, date, time, all_day, timezone,
             recurrence_json, reminders_json, enabled, version, created_at, updated_at)
           VALUES ('p1', 'w2', 'todo', '原型链星期', 'active', 'solar', '2026-01-05', '09:00', 0, 'Asia/Shanghai', ?, '[]', 1, 1, ?, ?)`,
        )
        .run(
          JSON.stringify({ frequency: "weekly", interval: 1, byWeekday: ["constructor"] }),
          ts,
          ts,
        );
      old.close();

      runImport(env.db, oldPath);
      const row = env.db.prepare("SELECT recurrence_json FROM schedules WHERE id = 'w2'").get() as {
        recurrence_json: string;
      };
      const rec = JSON.parse(row.recurrence_json) as { byweekday: unknown[] };
      assert.ok(
        rec.byweekday.every((d) => Number.isInteger(d)),
        `byweekday 只能装整数（null 会被 luxon 当成 no-op 静默落到周一）：${JSON.stringify(rec.byweekday)}`,
      );
      assert.deepEqual(rec.byweekday, [0], "认不出星期应回退到开始日期的星期（2026-01-05 是周一）");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("节假日行被约束静默拒绝时，该年份不得标记 ready（避免按星期猜工作日）", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old-bad-holiday.db`;
      const old = new DatabaseSync(oldPath);
      old.exec(`
        CREATE TABLE profiles (profile_id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
        CREATE TABLE cn_holiday_days (date TEXT PRIMARY KEY, year INTEGER NOT NULL, day_type TEXT NOT NULL,
          name TEXT NOT NULL, source TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE cn_holiday_year_meta (year INTEGER PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ready',
          source TEXT NOT NULL, payload_hash TEXT NOT NULL, fetched_at TEXT NOT NULL,
          last_attempt_at TEXT, last_error TEXT);
      `);
      const ts = "2026-01-01T00:00:00.000Z";
      // day_type 非法：目标库有 CHECK 约束，而 INSERT OR IGNORE 不会为此抛错（changes=0）
      old
        .prepare(
          "INSERT INTO cn_holiday_days VALUES ('2026-10-01', 2026, 'bogus', '国庆节', 'src', ?, ?)",
        )
        .run(ts, ts);
      old
        .prepare("INSERT INTO cn_holiday_year_meta VALUES (2026,'ready','src','hash',?,NULL,NULL)")
        .run(ts);
      old.close();

      const report = runImport(env.db, oldPath);
      assert.ok(
        report.problems.some((p) => p.table === "cn_holiday_days" && p.id === "2026-10-01"),
        `被约束拒绝的行必须进报告：${JSON.stringify(report.problems)}`,
      );
      assert.equal(
        env.db.prepare("SELECT 1 FROM cn_holiday_years WHERE year = 2026").get(),
        undefined,
        "有坏行的年份标记 ready 会让 dayType 对缺失日期按星期猜（调休日静默错判）",
      );
      assert.ok(
        report.scheduleWarnings.some((w) => w.includes("未标记为 ready")),
        "降级必须留痕",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

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

      const s1 = env.db
        .prepare("SELECT * FROM schedules WHERE id = 's1'")
        .get() as unknown as Record<string, unknown>;
      assert.equal(s1.status, "active");
      assert.equal(s1.workday_filter, "any");
      assert.equal(s1.remind_offsets_json, "[-30]");
      assert.deepEqual(JSON.parse(s1.recurrence_json as string), { freq: "daily", interval: 2 });

      const s2 = env.db
        .prepare("SELECT * FROM schedules WHERE id = 's2'")
        .get() as unknown as Record<string, unknown>;
      assert.equal(s2.kind, "birthday");
      assert.equal(s2.leap_policy, "follow");
      assert.deepEqual(JSON.parse(s2.recurrence_json as string), { freq: "yearly", interval: 1 });

      const s3 = env.db
        .prepare("SELECT * FROM schedules WHERE id = 's3'")
        .get() as unknown as Record<string, unknown>;
      assert.equal(s3.workday_filter, "workday");

      const s4 = env.db.prepare("SELECT recurrence_json FROM schedules WHERE id = 's4'").get() as {
        recurrence_json: string;
      };
      assert.equal(s4.recurrence_json, null);

      const quiet = env.db
        .prepare("SELECT value_json FROM settings WHERE profile_id = 'p1' AND key = 'quiet_hours'")
        .get() as { value_json: string };
      assert.equal(quiet.value_json, '{"start":"22:00","end":"07:00"}');

      const expense = env.db
        .prepare("SELECT * FROM expenses WHERE id = 'e2'")
        .get() as unknown as Record<string, unknown>;
      assert.equal(expense.created_by_profile, "partner");
      assert.equal(expense.spent_on, "2026-01-06");
      const expenseCount = env.db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as {
        n: number;
      };
      assert.equal(expenseCount.n, 2);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("--force 二次导入：节假日只增不改，报告按实际写入计数而非行数", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const first = runImport(env.db, oldPath);
      assert.equal(first.holidayDays, 2, "首次导入应真正写入 2 天节假日");
      assert.equal(first.holidayYears, 1);

      // --force 清理 Profile / 账本数据，但 cn_holiday_days / cn_holiday_years 不参与清理，
      // 始终 INSERT OR IGNORE：第二次导入一行都没写，报告不得再声称「已导入 2 天」。
      const second = runImport(env.db, oldPath, true);
      assert.equal(second.holidayDays, 0, "被 OR IGNORE 忽略的行没有写入，不得计入报告");
      assert.equal(second.holidayYears, 0);

      const days = env.db.prepare("SELECT COUNT(*) AS n FROM cn_holiday_days").get() as {
        n: number;
      };
      assert.equal(days.n, 2, "数据仍在，只是没有被重写");
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
        (env.db.prepare("SELECT status FROM schedules WHERE id = ?").get(id) as { status: string })
          .status;
      assert.equal(statusOf("s5"), "done");
      assert.equal(statusOf("s6"), "done");
      assert.equal(statusOf("s7"), "active");
      assert.ok(
        report.scheduleWarnings.some((w) => w.includes("weird")),
        "无法识别的状态应写 warning",
      );
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
      const e = env.db.prepare("SELECT spent_on FROM expenses WHERE id = 'e9'").get() as {
        spent_on: string;
      };
      assert.equal(e.spent_on, "2026-09-03", "UTC 16:00 应换算为北京次日");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("每周规则含无法识别的星期时不产出空 byweekday（曾导致进程假死）", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const old = new DatabaseSync(oldPath);
      const ts = "2026-01-01T00:00:00.000Z";
      // 2026-01-05 是周一 → 回退应为 byweekday [0]
      old
        .prepare(
          `INSERT INTO schedules (profile_id, id, type, title, status, calendar, date, time, all_day, timezone,
             recurrence_json, reminders_json, enabled, version, created_at, updated_at)
           VALUES ('p1', 'w1', 'todo', '认不出星期', 'active', 'solar', '2026-01-05', '09:00', 0, 'Asia/Shanghai', ?, '[]', 1, 1, ?, ?)`,
        )
        .run(
          JSON.stringify({ frequency: "weekly", interval: 1, byWeekday: ["MON", "TUE"] }),
          ts,
          ts,
        );
      old.close();

      const report = runImport(env.db, oldPath);
      const row = env.db.prepare("SELECT recurrence_json FROM schedules WHERE id = 'w1'").get() as {
        recurrence_json: string;
      };
      const rec = JSON.parse(row.recurrence_json) as { freq: string; byweekday: number[] };
      assert.equal(rec.freq, "weekly");
      assert.deepEqual(rec.byweekday, [0], "认不出星期应回退到开始日期的星期，而不是空数组");
      assert.ok(
        report.scheduleWarnings.some((w) => w.includes("认不出星期")),
        "回退应有 warning 留痕",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("拒绝导入非空目标库（--force 除外）", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('x', '已有账本', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      assert.throws(() => runImport(env.db, oldPath), /非空/);
      const report = runImport(env.db, oldPath, true);
      assert.equal(report.schedules, 4);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("--force 真正覆盖：重复导入不因主键冲突失败", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const first = runImport(env.db, oldPath);
      assert.equal(first.schedules, 4);
      assert.equal(first.ledgers, 2);

      // 此前 --force 只跳过空库检查，普通 INSERT 会撞旧主键并回滚整个事务
      const second = runImport(env.db, oldPath, true);
      assert.equal(second.schedules, 4, "--force 重导应成功而不是 UNIQUE 失败");
      assert.equal(second.ledgers, 2);
      assert.equal(second.expenses, 2);
      // 计数按实际写入（changes）而不是调用次数：重导不会新增 Profile
      assert.equal(second.profiles, 0, "重导时 INSERT OR IGNORE 没有新增行，报告不该虚高");
      const counts = env.db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM schedules) AS s, (SELECT COUNT(*) FROM ledgers) AS l, (SELECT COUNT(*) FROM expenses) AS e",
        )
        .get() as { s: number; l: number; e: number };
      // 逐字段比较：node:sqlite 返回 null 原型对象，deepEqual 会因原型不同而失败
      assert.equal(counts.s, 4, "覆盖后日程不应累积重复行");
      assert.equal(counts.l, 2, "覆盖后账本不应累积重复行");
      assert.equal(counts.e, 2, "覆盖后账目不应累积重复行");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("--force 不清除无关 Profile 的数据", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      runImport(env.db, oldPath);

      const ts = new Date().toISOString();
      env.db.prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES ('other', ?)").run(ts);
      env.db
        .prepare(
          `INSERT INTO schedules (id, profile_id, title, kind, calendar, time, all_day, remind_offsets_json, status, version, created_at, updated_at)
           VALUES ('keep-me', 'other', '保留日程', 'todo', 'solar', '09:00', 1, '[0]', 'active', 1, ?, ?)`,
        )
        .run(ts, ts);

      runImport(env.db, oldPath, true);
      const kept = env.db
        .prepare("SELECT COUNT(*) AS n FROM schedules WHERE id = 'keep-me'")
        .get() as { n: number };
      assert.equal(kept.n, 1, "无关 Profile 的日程必须保留");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("坏数据逐行隔离而不是让整库回滚成 0 行", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const old = new DatabaseSync(oldPath);
      const ts = "2026-01-01T00:00:00.000Z";
      const entry = old.prepare(
        "INSERT INTO ledger_entries (ledger_id, id, profile_id, type, amount_cents, category, occurred_at, created_at, updated_at) VALUES (?, ?, 'p1', 'expense', ?, '餐饮', ?, ?, ?)",
      );
      entry.run("l1", "bad-zero", 0, "2026-01-05T12:00:00.000Z", ts, ts);
      entry.run("l1", "bad-real", 12.5, "2026-01-05T12:00:00.000Z", ts, ts);
      entry.run("l1", "bad-date", 900, "not-a-date", ts, ts);
      entry.run("nope", "bad-fk", 900, "2026-01-05T12:00:00.000Z", ts, ts);
      old.close();

      const report = runImport(env.db, oldPath);
      assert.equal(report.schedules, 4, "日程不应被账目坏行影响");
      assert.equal(report.ledgers, 2);
      assert.equal(report.expenses, 2, "只应导入 e1/e2 两笔合法支出");
      const ids = report.problems.map((p) => p.id);
      for (const id of ["bad-zero", "bad-real", "bad-date", "bad-fk"]) {
        assert.ok(ids.includes(id), `应隔离 ${id}`);
      }
      assert.match(report.problems.find((p) => p.id === "bad-date")?.reason ?? "", /occurred_at/);
      const leaked = env.db
        .prepare(
          "SELECT COUNT(*) AS n FROM expenses WHERE id IN ('bad-zero','bad-real','bad-date','bad-fk')",
        )
        .get() as { n: number };
      assert.equal(leaked.n, 0, "被隔离的行绝不能进库");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非法 Profile 名的旧数据被隔离，不阻断其余导入", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const old = new DatabaseSync(oldPath);
      old.prepare("INSERT INTO profiles VALUES ('BAD NAME', ?)").run("2026-01-01T00:00:00.000Z");
      old.close();

      const report = runImport(env.db, oldPath);
      assert.equal(report.profiles, 2, "合法 Profile 仍应导入");
      assert.ok(report.problems.some((p) => p.table === "profiles" && p.id === "BAD NAME"));
      const bad = env.db
        .prepare("SELECT COUNT(*) AS n FROM profiles WHERE id = 'BAD NAME'")
        .get() as { n: number };
      assert.equal(bad.n, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("节假日用 OR IGNORE：不用旧库快照覆盖目标库已抓取的数据", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      env.db
        .prepare(
          "INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES ('2026-01-01', 2026, 'holiday', '新抓取的元旦', 'holiday-cn', '2026-12-01T00:00:00.000Z')",
        )
        .run();

      runImport(env.db, oldPath);
      const row = env.db
        .prepare("SELECT name FROM cn_holiday_days WHERE date = '2026-01-01'")
        .get() as { name: string };
      assert.equal(row.name, "新抓取的元旦", "旧快照不应覆盖目标库更新数据");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("不把 v2 自身备份当作旧库候选", () => {
    const env = makeTestEnv();
    try {
      const dir = `${env.dir}/backups`;
      mkdirSync(dir);
      // v2 备份命名：应被排除，否则会把陈旧快照当旧库导入
      writeFileSync(join(dir, "life-assistant-20260912-030405.db"), "");
      assert.throws(() => resolveOldDbPath(dir), /未找到旧数据库/);

      // 真正的旧库文件名仍能被识别
      writeFileSync(join(dir, "life-assistant.sqlite"), "");
      assert.equal(resolveOldDbPath(dir), join(dir, "life-assistant.sqlite"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("recurrence_json/reminders_json 形状异常只降级该行，不让整库回滚", () => {
    // 回归：mapRecurrence 曾在逐行 try 之外调用且不做形态校验 —— `recurrence_json = 'null'`
    // 或 byWeekday 是标量时抛 TypeError，异常穿出事务把整次导入回滚成 0 行。
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const old = new DatabaseSync(oldPath);
      const ts = "2026-01-01T00:00:00.000Z";
      const insert = old.prepare(
        `INSERT INTO schedules (profile_id, id, type, title, status, calendar, date, time, all_day, timezone,
           recurrence_json, reminders_json, enabled, version, created_at, updated_at)
         VALUES ('p1', ?, 'todo', ?, 'active', 'solar', '2026-04-01', '09:00', 0, 'Asia/Shanghai', ?, ?, 1, 1, ?, ?)`,
      );
      insert.run("bad-null", "规则是 JSON null", "null", "[]", ts, ts);
      insert.run(
        "bad-scalar",
        "byWeekday 是标量",
        JSON.stringify({ frequency: "weekly", byWeekday: "mo" }),
        "[]",
        ts,
        ts,
      );
      insert.run(
        "bad-reminders",
        "提醒不是数组",
        JSON.stringify({ frequency: "daily" }),
        "{}",
        ts,
        ts,
      );
      old.close();

      const report = runImport(env.db, oldPath);
      assert.equal(report.schedules, 7, "坏形状行应降级导入（4 条正常 + 3 条降级），整库不得回滚");
      assert.equal(report.problems.length, 0, "可降级的形状异常记 warning，不进 problems");
      assert.ok(
        report.scheduleWarnings.some((w) => w.includes("recurrence_json 不是对象")),
        `应有 JSON null 的降级留痕，实际 ${JSON.stringify(report.scheduleWarnings)}`,
      );
      assert.ok(
        report.scheduleWarnings.some((w) => w.includes("reminders_json 不是数组")),
        "应有 reminders 形状的降级留痕",
      );
      const ids = (env.db.prepare("SELECT id FROM schedules").all() as { id: string }[]).map(
        (r) => r.id,
      );
      for (const id of ["bad-null", "bad-scalar", "bad-reminders"]) {
        assert.ok(ids.includes(id), `${id} 应已导入`);
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("读取旧库整表失败不会被伪装成「旧库没有这张表」", () => {
    // 回归：六处 `catch { warnings("旧库没有 X 表") }` 把任何读表错误都当成表不存在，
    // 于是整表静默跳过、problems 为空 → 退出码 0（用户看到「成功」）。
    // 用 node:sqlite 对超出 JS 安全整数范围的 int64 抛 ERR_OUT_OF_RANGE 构造确定性的读表失败。
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const old = new DatabaseSync(oldPath);
      old.prepare("UPDATE schedules SET version = ? WHERE id = 's1'").run(9223372036854775807n);
      old.close();

      const report = runImport(env.db, oldPath);
      assert.ok(
        report.problems.some(
          (p) => p.table === "schedules" && p.reason.includes("无法读取旧库的 schedules 表"),
        ),
        `读表失败必须进 problems（否则退出码 0 会谎报成功），实际 ${JSON.stringify(report.problems)}`,
      );
      assert.ok(
        !report.scheduleWarnings.some((w) => w.includes("旧库没有 schedules 表")),
        "不得把读失败报告成「表不存在」",
      );
      assert.equal(report.schedules, 0, "该表整表未导入");
      assert.equal(report.ledgers, 2, "其余表不受影响，照常导入");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("--force 只覆盖会重写的行：通知/投递/预算/账本里 v2 新增的账目都保住", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      runImport(env.db, oldPath);

      // 模拟「导入之后 v2 又跑了一段时间」产生的数据：这些行导入既不写入，重导也补不回来
      const ts = "2026-06-01T00:00:00.000Z";
      env.db
        .prepare(
          "INSERT INTO notifications (id, profile_id, kind, title, body_md, read, created_at) VALUES ('n1','p1','test','通知','正文',1,?)",
        )
        .run(ts);
      env.db
        .prepare(
          `INSERT INTO deliveries (id, notification_id, route_name, next_attempt_at, created_at, updated_at)
           VALUES ('d1','n1','life-assistant-p1',?,?,?)`,
        )
        .run(ts, ts, ts);
      env.db
        .prepare(
          "INSERT INTO budgets (id, ledger_id, category, amount_cents, created_at, updated_at) VALUES ('b1','l1','',100000,?,?)",
        )
        .run(ts, ts);
      env.db
        .prepare(
          `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
           VALUES ('v2-e1','l1',1234,'餐饮','2026-06-01','p1',?)`,
        )
        .run(ts);
      env.db
        .prepare(
          `INSERT INTO schedules (id, profile_id, title, kind, calendar, start_date, time, all_day, remind_offsets_json, workday_filter, status, version, created_at, updated_at)
           VALUES ('v2-s1','p1','v2 新日程','todo','solar','2026-06-01','09:00',0,'[0]','any','active',1,?,?)`,
        )
        .run(ts, ts);

      const second = runImport(env.db, oldPath, true);
      assert.equal(second.schedules, 4, "旧库的日程照常重写");
      const count = (sql: string): number => (env.db.prepare(sql).get() as { n: number }).n;
      assert.equal(
        count("SELECT COUNT(*) AS n FROM notifications WHERE id = 'n1'"),
        1,
        "通知历史必须保留",
      );
      assert.equal(
        count("SELECT COUNT(*) AS n FROM deliveries WHERE id = 'd1'"),
        1,
        "投递历史必须保留",
      );
      assert.equal(
        count("SELECT COUNT(*) AS n FROM budgets WHERE id = 'b1'"),
        1,
        "预算必须保留（账本改为 upsert）",
      );
      assert.equal(
        count("SELECT COUNT(*) AS n FROM expenses WHERE id = 'v2-e1'"),
        1,
        "v2 期间新增的账目必须保留",
      );
      assert.equal(
        count("SELECT COUNT(*) AS n FROM schedules WHERE id = 'v2-s1'"),
        1,
        "v2 期间新增的日程必须保留",
      );
      // 旧库的行不累积重复
      assert.equal(count("SELECT COUNT(*) AS n FROM schedules"), 5);
      assert.equal(count("SELECT COUNT(*) AS n FROM expenses"), 3);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("--force 重导不把同名账本改成 X (2)（自身 id 与已归档账本不算重名）", () => {
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      runImport(env.db, oldPath);
      // 已归档的同名账本：v2 自身的唯一性规则只约束活跃账本，不该逼着导入改名
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at, archived_at) VALUES ('arch','家庭账本','2026-01-01T00:00:00.000Z','2026-02-01T00:00:00.000Z')",
        )
        .run();

      runImport(env.db, oldPath, true);
      const names = (
        env.db.prepare("SELECT name FROM ledgers ORDER BY id").all() as { name: string }[]
      ).map((r) => r.name);
      assert.ok(names.includes("家庭账本"), `活跃账本应保持原名，实际 ${JSON.stringify(names)}`);
      assert.ok(
        !names.some((n) => n.startsWith("家庭账本 (")),
        `不应因为重导或已归档同名账本而改名，实际 ${JSON.stringify(names)}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("节假日坏行的保护键覆盖「日期所属年份」，跨年行被拒时不会留下 ready 年份", () => {
    // 回归：此前只把行内 year 记进保护集合，而 dayType 的按星期兜底是按日期年份查表。
    // 跨年行（如 2019.json 里的 2018-12-30/31、2023.json 里的 2022-12-31，上游确实存在）
    // 两者不同：只记行内 year 会让真正有缺失的日期年份照样 ready，于是缺失日期退化成
    // 「按星期猜」——调休周六被判成周末、假期里的工作日被判成普通工作日。
    const env = makeTestEnv();
    try {
      const oldPath = `${env.dir}/old.db`;
      buildOldDb(oldPath);
      const old = new DatabaseSync(oldPath);
      const ts = "2026-01-01T00:00:00.000Z";
      // 数据集年份是 2026，日期落在 2025-12-31（元旦假期首日），day_type 非法会被 v2 的 CHECK 拒绝
      old
        .prepare(
          "INSERT INTO cn_holiday_days VALUES ('2025-12-31', 2026, 'bogus', '元旦', 'test', ?, ?)",
        )
        .run(ts, ts);
      old
        .prepare(
          "INSERT INTO cn_holiday_year_meta VALUES (2025, 'ready', 'test', 'hash', ?, NULL, NULL)",
        )
        .run(ts);
      old.close();

      const report = runImport(env.db, oldPath);
      assert.ok(
        report.problems.some((p) => p.table === "cn_holiday_days" && p.id === "2025-12-31"),
        `坏行应被隔离，实际 ${JSON.stringify(report.problems)}`,
      );
      const years = (
        env.db.prepare("SELECT year FROM cn_holiday_years ORDER BY year").all() as {
          year: number;
        }[]
      ).map((r) => r.year);
      assert.ok(
        !years.includes(2025),
        `日期所属年份 2025 有缺失行，绝不能标记 ready（会造成按星期猜），实际 ${JSON.stringify(years)}`,
      );
      assert.ok(
        report.scheduleWarnings.some((w) => w.includes("2025 年有节假日行未导入")),
        `应有 2025 的留痕，实际 ${JSON.stringify(report.scheduleWarnings)}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});
