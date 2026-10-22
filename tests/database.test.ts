import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bearerToken, isRequestAuthorized } from "../src/core/auth.js";
import {
  getSchemaVersion,
  openDatabase,
  SCHEMA_VERSION,
  uniqueFilePath,
  withReadTransaction,
  withTransaction,
} from "../src/core/database.js";
import { getCache, getSetting, pruneCache, setCache } from "../src/core/settings.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

describe("database schema v5", () => {
  it("新库迁移到最新版本并可重复打开", () => {
    const env = makeTestEnv();
    try {
      assert.equal(getSchemaVersion(env.db), SCHEMA_VERSION);
      env.db.close();
      const reopened = openDatabase(env.config.dbPath);
      assert.equal(getSchemaVersion(reopened), SCHEMA_VERSION);
      reopened.close();
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("v1 老库打开时补上 deliveries.expire_at 并升级版本号", () => {
    const env = makeTestEnv();
    try {
      env.db.close();
      // 还原成 v1 形状：去掉新列 + 版本号写回 1
      const raw = new DatabaseSync(env.config.dbPath);
      // 先摘掉依赖 owner_profile_id 的分范围唯一索引，否则 SQLite 拒绝 DROP COLUMN
      raw.exec("DROP INDEX IF EXISTS idx_ledgers_scoped_name");
      raw.exec("ALTER TABLE deliveries DROP COLUMN expire_at");
      raw.exec("ALTER TABLE ledgers DROP COLUMN owner_profile_id");
      raw.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
      raw.close();

      const upgraded = openDatabase(env.config.dbPath);
      try {
        assert.equal(getSchemaVersion(upgraded), SCHEMA_VERSION, "老库必须在启动时升级版本号");
        const columns = (
          upgraded.prepare("PRAGMA table_info(deliveries)").all() as { name: string }[]
        ).map((c) => c.name);
        assert.ok(columns.includes("expire_at"), `缺列会让投递写入直接失败：${columns.join(",")}`);
      } finally {
        upgraded.close();
      }

      // 再次打开：已是最新版本，迁移必须幂等（否则每次启动都会炸在重复 ALTER 上）
      const again = openDatabase(env.config.dbPath);
      assert.equal(getSchemaVersion(again), SCHEMA_VERSION);
      again.close();
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("v2 老库升级到 v3 时补 ledgers.owner_profile_id，既有账本视为家庭（NULL）", () => {
    const env = makeTestEnv();
    try {
      // 既有账本（升级前建的）没有 owner 概念
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '旧账本', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      env.db.close();
      // 还原成 v2 形状：去掉 owner 列、版本号写回 2
      const raw = new DatabaseSync(env.config.dbPath);
      // 先摘掉依赖 owner_profile_id 的分范围唯一索引，否则 SQLite 拒绝 DROP COLUMN
      raw.exec("DROP INDEX IF EXISTS idx_ledgers_scoped_name");
      raw.exec("ALTER TABLE ledgers DROP COLUMN owner_profile_id");
      raw.prepare("UPDATE meta SET value = '2' WHERE key = 'schema_version'").run();
      raw.close();

      const upgraded = openDatabase(env.config.dbPath);
      try {
        assert.equal(getSchemaVersion(upgraded), SCHEMA_VERSION);
        const columns = (
          upgraded.prepare("PRAGMA table_info(ledgers)").all() as { name: string }[]
        ).map((c) => c.name);
        assert.ok(
          columns.includes("owner_profile_id"),
          `缺列会让归属判定失败：${columns.join(",")}`,
        );
        const row = upgraded
          .prepare("SELECT owner_profile_id FROM ledgers WHERE id = 'l1'")
          .get() as { owner_profile_id: string | null };
        assert.equal(row.owner_profile_id, null, "既有账本必须视为家庭账本，行为不变");
      } finally {
        upgraded.close();
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("老库补 deliveries.deterministic_reject（幂等补列，且默认 0 不改既有语义）", () => {
    // 该列决定「4xx 确定性拒绝的终态行会不会被重新入队」。老库缺列时 notify.ts 的
    // requeueRoute / markTerminalFallback 会直接抛「no such column」，整个 drain 断掉。
    const env = makeTestEnv();
    try {
      env.db.close();
      // 还原成「没有该列」的旧形状（幂等补列路径）
      const raw = new DatabaseSync(env.config.dbPath);
      raw.exec("ALTER TABLE deliveries DROP COLUMN deterministic_reject");
      raw.close();

      const upgraded = openDatabase(env.config.dbPath);
      try {
        const columns = (
          upgraded.prepare("PRAGMA table_info(deliveries)").all() as {
            name: string;
            dflt_value: string | null;
          }[]
        ).map((c) => c.name);
        assert.ok(
          columns.includes("deterministic_reject"),
          `缺列会让 requeueRoute/markTerminalFallback 直接抛错：${columns.join(",")}`,
        );
        // 默认 0 = 升级前的语义（所有存量 fallback 行仍可重投），不得把老数据静默改语义
        upgraded
          .prepare(
            "INSERT INTO notifications (id, profile_id, kind, title, body_md, created_at) VALUES ('n1', 'default', 'k', 't', 'b', '2026-01-01T00:00:00.000Z')",
          )
          .run();
        upgraded
          .prepare(
            `INSERT INTO deliveries (id, notification_id, route_name, status, next_attempt_at, created_at, updated_at)
             VALUES ('d1', 'n1', 'r', 'fallback', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
          )
          .run();
        const row = upgraded
          .prepare("SELECT deterministic_reject FROM deliveries WHERE id='d1'")
          .get() as {
          deterministic_reject: number;
        };
        assert.equal(row.deterministic_reject, 0, "存量行的默认值必须是 0（=升级前的可重投语义）");
      } finally {
        upgraded.close();
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("STRICT 表拒绝错误类型与非法 CHECK", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '日用', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      assert.throws(() =>
        env.db
          .prepare(
            "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("e1", "l1", "12.34元", "2026-09-11", "default", "2026-01-01T00:00:00.000Z"),
      );
      assert.throws(() =>
        env.db
          .prepare(
            "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("e2", "l1", 0, "2026-09-11", "default", "2026-01-01T00:00:00.000Z"),
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("occurrences 的 (schedule_id, status) 索引由 migrate 建立，而不是在热路径里建", () => {
    const env = makeTestEnv();
    try {
      const index = env.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_occurrences_schedule_status'",
        )
        .get();
      assert.ok(index !== undefined, "缺索引会让按 schedule_id 的物化查询退化成全表扫描");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("活动账本名由数据库唯一约束兜底；归档后同名可复用", () => {
    const env = makeTestEnv();
    try {
      const insert = env.db.prepare(
        "INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
      );
      insert.run("l1", "日用");
      assert.throws(() => insert.run("l2", "日用"), /UNIQUE/, "活动账本重名必须被数据库拒绝");
      env.db
        .prepare("UPDATE ledgers SET archived_at = '2026-02-01T00:00:00.000Z' WHERE id = 'l1'")
        .run();
      insert.run("l3", "日用");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("账本名分范围唯一：家庭之间唯一、每人个人账本各自唯一，跨范围可同名", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO profiles (id, created_at) VALUES ('p1','2026-01-01T00:00:00.000Z'),('p2','2026-01-01T00:00:00.000Z')",
        )
        .run();
      const insert = env.db.prepare(
        "INSERT INTO ledgers (id, name, created_at, owner_profile_id) VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?)",
      );
      insert.run("l-fam", "日常", null);
      insert.run("l-p1", "日常", "p1"); // 家庭 vs 个人：允许同名
      insert.run("l-p2", "日常", "p2"); // 不同人的个人账本：允许同名
      assert.throws(() => insert.run("l-p1b", "日常", "p1"), /UNIQUE/, "同一范围内仍须唯一");
      assert.throws(() => insert.run("l-fam2", "日常", null), /UNIQUE/, "家庭账本之间仍须唯一");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("旧全局唯一索引 idx_ledgers_active_name 打开时被替换为分范围索引", () => {
    const env = makeTestEnv();
    try {
      // 模拟升级前的库：只有旧的全局唯一索引
      env.db.exec("DROP INDEX idx_ledgers_scoped_name");
      env.db.exec(
        "CREATE UNIQUE INDEX idx_ledgers_active_name ON ledgers(name) WHERE archived_at IS NULL",
      );
      env.db.close();

      const reopened = openDatabase(env.config.dbPath);
      try {
        const names = (
          reopened
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_ledgers%'",
            )
            .all() as { name: string }[]
        )
          .map((r) => r.name)
          .sort();
        // 旧索引必须被 DROP（否则仍在暗中强制全局唯一），新索引必须建出
        assert.deepEqual(names, ["idx_ledgers_scoped_name"]);
      } finally {
        reopened.close();
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("历史重名活动账本：拒绝启动并整笔回滚（索引是账本归属的唯一保障）", () => {
    const env = makeTestEnv();
    try {
      // 去掉索引后制造历史重名（模拟旧库脏数据）
      env.db.exec("DROP INDEX idx_ledgers_scoped_name");
      const insert = env.db.prepare(
        "INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
      );
      insert.run("l1", "日用");
      insert.run("l2", "日用");
      env.db.close();

      // 缺分范围索引时同名家庭/个人账本可能串范围，宁可拒绝启动让人工核查
      assert.throws(() => openDatabase(env.config.dbPath), /重名账本/);

      // 失败必须整笔回滚：版本号不前进，也不会留下「旧索引已删、新索引没建」的半升级库
      const raw = new DatabaseSync(env.config.dbPath);
      try {
        assert.equal(getSchemaVersion(raw), SCHEMA_VERSION, "事务回滚后版本号不应变化");
        const names = (
          raw
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_ledgers%'",
            )
            .all() as { name: string }[]
        ).map((r) => r.name);
        assert.deepEqual(names, [], "回滚后不应残留半建的索引");
      } finally {
        raw.close();
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("v3 老库升级到最新：补 client_token 列并建分范围唯一索引", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1','家用','2026-01-01T00:00:00.000Z')",
        )
        .run();
      env.db
        .prepare(
          "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES ('e1','l1',100,'2026-09-01','default','2026-01-01T00:00:00.000Z')",
        )
        .run();
      env.db.close();
      // 还原成 v3 形状：摘索引 → 删列 → 版本号写回 3
      const raw = new DatabaseSync(env.config.dbPath);
      raw.exec("DROP INDEX IF EXISTS idx_expenses_client_token");
      raw.exec("DROP INDEX IF EXISTS idx_schedules_client_token");
      raw.exec("ALTER TABLE expenses DROP COLUMN client_token");
      raw.exec("ALTER TABLE schedules DROP COLUMN client_token");
      raw.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
      raw.close();

      const upgraded = openDatabase(env.config.dbPath);
      try {
        assert.equal(getSchemaVersion(upgraded), SCHEMA_VERSION);
        const columnsOf = (table: string): string[] =>
          (upgraded.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
            (c) => c.name,
          );
        assert.ok(
          columnsOf("expenses").includes("client_token"),
          "缺列会让 expense add 的幂等重试直接报 no such column",
        );
        assert.ok(columnsOf("schedules").includes("client_token"));
        const indexes = (
          upgraded
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE '%client_token'",
            )
            .all() as { name: string }[]
        )
          .map((r) => r.name)
          .sort();
        assert.deepEqual(indexes, ["idx_expenses_client_token", "idx_schedules_client_token"]);
      } finally {
        upgraded.close();
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("client_token 分范围唯一：同人重复被拒、跨人可重名、NULL 不参与约束", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1','家用','2026-01-01T00:00:00.000Z')",
        )
        .run();
      const insertExpense = env.db.prepare(
        "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at, client_token) VALUES (?, 'l1', 100, '2026-09-01', ?, '2026-01-01T00:00:00.000Z', ?)",
      );
      insertExpense.run("e1", "alice", "req-1");
      assert.throws(() => insertExpense.run("e2", "alice", "req-1"), /UNIQUE/);
      insertExpense.run("e3", "bob", "req-1");
      insertExpense.run("e4", "alice", null);
      insertExpense.run("e5", "alice", null);

      const insertSchedule = env.db.prepare(
        "INSERT INTO schedules (id, profile_id, title, created_at, updated_at, client_token) VALUES (?, 'default', '喝水', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)",
      );
      insertSchedule.run("s1", "req-9");
      assert.throws(() => insertSchedule.run("s2", "req-9"), /UNIQUE/);
      insertSchedule.run("s3", null);
      insertSchedule.run("s4", null);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("job_runs 记录表：可写入、status/trigger 非法值被 CHECK 拒绝", () => {
    const env = makeTestEnv();
    try {
      const insert = env.db.prepare(
        "INSERT INTO job_runs (job_name, module, trigger, scheduled_for, started_at, status) VALUES (?, ?, ?, ?, ?, ?)",
      );
      insert.run(
        "daily_brief",
        "weather",
        "cron",
        "2026-10-20T07:30:00.000+08:00",
        "2026-10-20T07:30:01.000+08:00",
        "ok",
      );
      assert.throws(
        () =>
          insert.run(
            "daily_brief",
            "weather",
            "nope",
            "2026-10-20T07:30:00.000+08:00",
            "2026-10-20T07:30:01.000+08:00",
            "ok",
          ),
        /CHECK/,
      );
      assert.throws(
        () =>
          insert.run(
            "daily_brief",
            "weather",
            "cron",
            "2026-10-20T07:30:00.000+08:00",
            "2026-10-20T07:30:01.000+08:00",
            "done",
          ),
        /CHECK/,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("迁移前自动备份：v3 库升级前留一份可打开的 v3 快照，已是最新则不重复备份", () => {
    const env = makeTestEnv();
    try {
      env.db.close();
      const raw = new DatabaseSync(env.config.dbPath);
      raw.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
      raw.close();

      const upgraded = openDatabase(env.config.dbPath, { backupDir: env.config.backupDir });
      upgraded.close();
      const names = readdirSync(env.config.backupDir).filter((f) => f.includes("-pre-v3-"));
      assert.equal(names.length, 1, "升级前必须恰好留一份 pre-v3 快照");
      const snapshot = new DatabaseSync(`${env.config.backupDir}/${names[0] as string}`);
      try {
        assert.equal(getSchemaVersion(snapshot), 3, "快照必须是升级前的版本");
      } finally {
        snapshot.close();
      }

      // 已是最新版本：不再产生新的 pre-v 快照
      const again = openDatabase(env.config.dbPath, { backupDir: env.config.backupDir });
      again.close();
      assert.equal(
        readdirSync(env.config.backupDir).filter((f) => f.includes("-pre-v")).length,
        1,
        "已是最新 version 时不应重复备份",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("uniqueFilePath：已存在则依次加 -1/-2 后缀，不冲突时原样返回且不创建文件", () => {
    const env = makeTestEnv();
    try {
      const base = join(env.dir, "life-assistant-pre-v3-20261022-230000.db");
      assert.equal(uniqueFilePath(base), base, "文件不存在时不应改名");
      assert.equal(existsSync(base), false, "helper 不得创建文件（只负责挑名字）");
      writeFileSync(base, "occupied");
      assert.equal(
        uniqueFilePath(base),
        join(env.dir, "life-assistant-pre-v3-20261022-230000-1.db"),
      );
      writeFileSync(join(env.dir, "life-assistant-pre-v3-20261022-230000-1.db"), "occupied");
      assert.equal(
        uniqueFilePath(base),
        join(env.dir, "life-assistant-pre-v3-20261022-230000-2.db"),
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("迁移前快照同一秒内可重复：连续两次迁移都成功且各留一份快照（不再因重名拒绝启动）", (t) => {
    const env = makeTestEnv();
    try {
      env.db.close();
      // 把库退回 v3 形状（去掉 v4 的 client_token 列/索引）并写回版本号 3，让 openDatabase 每次都前滚
      const downgradeToV3 = (): void => {
        const raw = new DatabaseSync(env.config.dbPath);
        try {
          raw.exec("DROP INDEX IF EXISTS idx_expenses_client_token");
          raw.exec("DROP INDEX IF EXISTS idx_schedules_client_token");
          raw.exec("ALTER TABLE expenses DROP COLUMN client_token");
          raw.exec("ALTER TABLE schedules DROP COLUMN client_token");
          raw.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
        } finally {
          raw.close();
        }
      };
      downgradeToV3();
      // 冻结时钟到整秒：两次迁移前快照一定落在同一秒（修复前第二次会因 VACUUM INTO 目标已存在失败）
      t.mock.timers.enable({ apis: ["Date"], now: Date.UTC(2026, 9, 22, 15, 0, 0) });

      const first = openDatabase(env.config.dbPath, { backupDir: env.config.backupDir });
      assert.equal(getSchemaVersion(first), SCHEMA_VERSION);
      first.close();

      downgradeToV3();
      const second = openDatabase(env.config.dbPath, { backupDir: env.config.backupDir });
      assert.equal(getSchemaVersion(second), SCHEMA_VERSION);
      second.close();

      const snapshots = readdirSync(env.config.backupDir)
        .filter((name) => name.includes("-pre-v3-"))
        .sort();
      assert.deepEqual(
        snapshots,
        ["life-assistant-pre-v3-20261022-230000-1.db", "life-assistant-pre-v3-20261022-230000.db"],
        "同一秒两次迁移必须各留一份快照（第二次自动加 -1 后缀）",
      );
      for (const name of snapshots) {
        const snapshot = new DatabaseSync(join(env.config.backupDir, name));
        try {
          const version = getSchemaVersion(snapshot);
          // 并发下另一进程可能在本进程读完 schema_version、做 VACUUM 之前完成迁移，
          // 于是快照内容是新版本 —— 这仍是一份完整快照；这里只要求「可打开且版本合法」，
          // 以及下面的「快照名不重复、不覆盖」（本次修复要保证的是撞名不再误报失败）。
          assert.ok(
            Number.isInteger(version) && version >= 3 && version <= SCHEMA_VERSION,
            `快照 ${name} 必须是可打开的合法版本（实际 v${version}）`,
          );
        } finally {
          snapshot.close();
        }
      }
    } finally {
      t.mock.timers.reset();
      cleanupTestEnv(env);
    }
  });

  it("并发打开同一无版本库：快照撞名不会被误报为备份失败（VACUUM 换名重试）", async () => {
    const env = makeTestEnv();
    try {
      env.db.close();
      const downgradeToV3 = (): void => {
        const raw = new DatabaseSync(env.config.dbPath);
        try {
          raw.exec("DROP INDEX IF EXISTS idx_expenses_client_token");
          raw.exec("DROP INDEX IF EXISTS idx_schedules_client_token");
          raw.exec("ALTER TABLE expenses DROP COLUMN client_token");
          raw.exec("ALTER TABLE schedules DROP COLUMN client_token");
          raw.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
        } finally {
          raw.close();
        }
      };
      downgradeToV3();

      // 两个进程同时 openDatabase 同一个 v3 库、同一个 backupDir：两个进程可能同时选中
      // 同一个秒级快照名，后到者的 VACUUM INTO 会因目标已存在失败 —— 修复前会抛
      // 「迁移前备份失败」（R2-3）。这里只要求：至少一个成功、没有任何进程因快照撞名失败、
      // 快照不互相覆盖（每个都是可独立打开的 v3 快照）。
      const goFile = join(env.dir, "go");
      const dbSourceHref = pathToFileURL(
        fileURLToPath(new URL("../src/core/database.ts", import.meta.url)),
      ).href;
      const runChild = (): { ready: Promise<void>; result: Promise<{ output: string }> } => {
        const code = `
(async () => {
  const { existsSync } = await import("node:fs");
  const { openDatabase } = await import(${JSON.stringify(dbSourceHref)});
  console.log("READY");
  while (!existsSync(${JSON.stringify(goFile)})) {
    // 自旋等待发令，让两个进程尽量同时进入 openDatabase
  }
  try {
    const db = openDatabase(${JSON.stringify(env.config.dbPath)}, {
      backupDir: ${JSON.stringify(env.config.backupDir)},
    });
    db.close();
    console.log("OK");
  } catch (e) {
    console.log("ERR " + (e instanceof Error ? e.message : String(e)));
  }
})();
`;
        let signalReady: () => void = () => {};
        const ready = new Promise<void>((resolve) => {
          signalReady = resolve;
        });
        const result = new Promise<{ output: string }>((resolve) => {
          const child = spawn(process.execPath, ["--import", "tsx", "-e", code], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let output = "";
          child.stdout.on("data", (chunk: Buffer) => {
            output += chunk.toString();
            if (output.includes("READY")) signalReady();
          });
          child.stderr.on("data", (chunk: Buffer) => {
            output += chunk.toString();
          });
          child.on("exit", () => {
            signalReady();
            resolve({ output });
          });
        });
        return { ready, result };
      };

      const first = runChild();
      const second = runChild();
      await Promise.all([first.ready, second.ready]);
      writeFileSync(goFile, "go");
      const results = await Promise.all([first.result, second.result]);
      const outputs = results.map((result) => result.output);
      assert.ok(
        outputs.some((output) => output.includes("OK")),
        `至少一个进程应成功打开并迁移；实际输出：${outputs.join(" | ")}`,
      );
      for (const output of outputs) {
        assert.doesNotMatch(
          output,
          /迁移前备份失败/,
          `快照撞名不应被误报成备份失败（R2-3）：${output}`,
        );
      }

      // 快照不互相覆盖：每份都是可独立打开的 v3 快照，且文件名唯一
      const snapshots = readdirSync(env.config.backupDir)
        .filter((name) => name.includes("-pre-v3-"))
        .sort();
      assert.ok(snapshots.length >= 1, "并发迁移至少应留下一份 v3 快照");
      assert.equal(new Set(snapshots).size, snapshots.length, "快照名不得重复");
      for (const name of snapshots) {
        const snapshot = new DatabaseSync(join(env.config.backupDir, name));
        try {
          const version = getSchemaVersion(snapshot);
          // 并发下另一进程可能在本进程读完 schema_version、做 VACUUM 之前完成迁移，
          // 于是快照内容是新版本 —— 这仍是一份完整快照；这里只要求「可打开且版本合法」，
          // 以及下面的「快照名不重复、不覆盖」（本次修复要保证的是撞名不再误报失败）。
          assert.ok(
            Number.isInteger(version) && version >= 3 && version <= SCHEMA_VERSION,
            `快照 ${name} 必须是可打开的合法版本（实际 v${version}）`,
          );
        } finally {
          snapshot.close();
        }
      }

      // 事后单独打开必须正常（胜者已完成迁移）
      const reopened = openDatabase(env.config.dbPath, { backupDir: env.config.backupDir });
      try {
        assert.equal(getSchemaVersion(reopened), SCHEMA_VERSION);
      } finally {
        reopened.close();
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("外键开启：账目必须挂在存在的账本上", () => {
    const env = makeTestEnv();
    try {
      assert.throws(() =>
        env.db
          .prepare(
            "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run("e3", "missing", 100, "2026-09-11", "default", "2026-01-01T00:00:00.000Z"),
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("通知去重键 Profile 内唯一", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO profiles (id, created_at) VALUES ('other', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      const plain = env.db.prepare(
        "INSERT INTO notifications (id, profile_id, kind, title, body_md, created_at) VALUES (?, ?, 'k', 't', 'b', ?)",
      );
      plain.run("n1", "default", "2026-01-01T00:00:00.000Z");
      plain.run("n2", "default", "2026-01-01T00:00:00.000Z");
      const keyed = env.db.prepare(
        "INSERT INTO notifications (id, profile_id, kind, title, body_md, dedupe_key, created_at) VALUES (?, ?, 'k', 't', 'b', ?, ?)",
      );
      keyed.run("n3", "default", "dup", "2026-01-01T00:00:00.000Z");
      assert.throws(() => keyed.run("n4", "default", "dup", "2026-01-01T00:00:00.000Z"));
      keyed.run("n5", "default", "dup2", "2026-01-01T00:00:00.000Z");
      keyed.run("n6", "other", "dup", "2026-01-01T00:00:00.000Z");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("withTransaction 异常时回滚", () => {
    const env: TestEnv = makeTestEnv();
    try {
      assert.throws(() =>
        withTransaction(env.db, () => {
          env.db
            .prepare(
              "INSERT INTO ledgers (id, name, created_at) VALUES ('lx', 'x', '2026-01-01T00:00:00.000Z')",
            )
            .run();
          throw new Error("boom");
        }),
      );
      const row = env.db.prepare("SELECT COUNT(*) AS n FROM ledgers WHERE id = 'lx'").get() as {
        n: number;
      };
      assert.equal(row.n, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("withReadTransaction 提供一致快照：事务内其它连接的写入不影响已读到的数据", () => {
    const env = makeTestEnv();
    // 第二个连接扮演「并发写入方」：单写者架构下就是相邻 job/tick 的写入
    const writer = new DatabaseSync(env.config.dbPath);
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '账本', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      const insert = env.db.prepare(
        `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
         VALUES (?, 'l1', 100, '餐饮', '2026-01-05', 'default', '2026-01-05T00:00:00.000Z')`,
      );
      insert.run("e1");

      const count = (): number =>
        (env.db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as { n: number }).n;
      const seen = withReadTransaction(env.db, () => {
        const before = count();
        // 另一个连接在事务进行中写入
        writer
          .prepare(
            `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
             VALUES ('e2', 'l1', 200, '交通', '2026-01-06', 'default', '2026-01-06T00:00:00.000Z')`,
          )
          .run();
        return [before, count()];
      });

      assert.deepEqual(seen, [1, 1], "同一读事务内两次 SELECT 必须读到同一快照");
      assert.equal(count(), 2, "事务结束后应能看到新写入");
      assert.equal(env.db.isTransaction, false, "读事务必须正常提交，不留在事务状态");
    } finally {
      writer.close();
      cleanupTestEnv(env);
    }
  });

  it("withReadTransaction 异常时回滚；已在事务内则复用外层快照", () => {
    const env = makeTestEnv();
    try {
      assert.throws(() =>
        withReadTransaction(env.db, () => {
          throw new Error("boom");
        }),
      );
      assert.equal(env.db.isTransaction, false);

      // 嵌套在写事务里不能再 BEGIN：必须复用外层（SQLite 会拒绝嵌套 BEGIN）
      const value = withTransaction(env.db, () => withReadTransaction(env.db, () => 42));
      assert.equal(value, 42);
      assert.equal(env.db.isTransaction, false);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("高于程序版本的 schema 拒绝打开", () => {
    const env = makeTestEnv();
    try {
      env.db.close();
      const raw = new DatabaseSync(env.config.dbPath);
      raw.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
      raw.close();
      assert.throws(() => openDatabase(env.config.dbPath), /高于/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("settings / cache 坏 JSON 防御", () => {
  it("getSetting 遇到坏 JSON 返回 undefined，而不是让整轮 outbox 停摆", () => {
    const env = makeTestEnv();
    try {
      // notify 的静默时段读取走 getSetting：一条坏行曾会让 drainDue 每轮抛异常，
      // 所有排队的投递永远发不出去（日志里只有重复的 JSON.parse 报错）。
      env.db
        .prepare(
          "INSERT INTO settings (profile_id, key, value_json, updated_at) VALUES ('default','quiet_hours','{\"start\":', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      assert.equal(getSetting(env.db, "default", "quiet_hours"), undefined);
      assert.equal(getSetting(env.db, "default", "not-exist"), undefined);
      // 正常行仍然可读
      env.db
        .prepare(
          'UPDATE settings SET value_json = \'{"start":"22:00","end":"08:00"}\' WHERE key = \'quiet_hours\'',
        )
        .run();
      assert.deepEqual(getSetting(env.db, "default", "quiet_hours"), {
        start: "22:00",
        end: "08:00",
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("getCache 遇到坏 JSON 按缓存未命中处理（调用方会重新抓取）", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO cache (key, value_json, expires_at) VALUES ('qweather:now', 'not-json', '2999-01-01T00:00:00.000Z')",
        )
        .run();
      assert.equal(getCache(env.db, "qweather:now"), undefined);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("cache 过期清理", () => {
  it("pruneCache 只删除过期行，未过期行保留", () => {
    const env = makeTestEnv();
    try {
      setCache(env.db, "geo:alive", { v: 1 }, 60_000);
      setCache(env.db, "geo:dead", { v: 2 }, -1_000);
      assert.deepEqual(getCache(env.db, "geo:alive"), { v: 1 });
      assert.equal(getCache(env.db, "geo:dead"), undefined);

      const pruned = pruneCache(env.db);
      assert.equal(pruned, 1, "只应清理 1 条过期行");
      const keys = (env.db.prepare("SELECT key FROM cache").all() as { key: string }[]).map(
        (r) => r.key,
      );
      assert.deepEqual(keys, ["geo:alive"], "cache 表不会被读取时自动回收，必须显式清理");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("鉴权", () => {
  const TOKEN = "s".repeat(32);

  it("Bearer 与 ?token= 均可通过，错误凭据一律拒绝", () => {
    assert.equal(isRequestAuthorized(TOKEN, `Bearer ${TOKEN}`), true);
    assert.equal(isRequestAuthorized(TOKEN, undefined, TOKEN), true);
    assert.equal(isRequestAuthorized(TOKEN, `Bearer wrong`), false);
    assert.equal(isRequestAuthorized(TOKEN, undefined), false);
    assert.equal(isRequestAuthorized(TOKEN, `Bearer ${TOKEN}x`), false);
  });

  it("长度不同的凭据不会抛错（先哈希再定长比较）", () => {
    // 直接 timingSafeEqual 要求等长，长度不等必须先返回 false 而不是抛异常
    assert.equal(isRequestAuthorized(TOKEN, "Bearer short"), false);
    assert.equal(isRequestAuthorized(TOKEN, `Bearer ${"s".repeat(1000)}`), false);
    assert.equal(isRequestAuthorized(TOKEN, undefined, ""), false);
  });

  it("未配置 token 时不鉴权", () => {
    assert.equal(isRequestAuthorized(undefined, undefined), true);
    assert.equal(isRequestAuthorized(undefined, "Bearer anything"), true);
  });

  it("bearerToken 只接受 Bearer 前缀", () => {
    assert.equal(bearerToken(`Bearer ${TOKEN}`), TOKEN);
    assert.equal(bearerToken(`bearer ${TOKEN}`), undefined);
    assert.equal(bearerToken("Basic abc"), undefined);
    assert.equal(bearerToken("Bearer   "), undefined);
  });
});
