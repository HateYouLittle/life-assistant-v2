import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { bearerToken, isRequestAuthorized } from "../src/core/auth.js";
import {
  getSchemaVersion,
  openDatabase,
  withReadTransaction,
  withTransaction,
} from "../src/core/database.js";
import { getCache, pruneCache, setCache } from "../src/core/settings.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

describe("database schema v3", () => {
  it("新库迁移到最新版本并可重复打开", () => {
    const env = makeTestEnv();
    try {
      assert.equal(getSchemaVersion(env.db), 3);
      env.db.close();
      const reopened = openDatabase(env.config.dbPath);
      assert.equal(getSchemaVersion(reopened), 3);
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
        assert.equal(getSchemaVersion(upgraded), 3, "老库必须在启动时升级版本号");
        const columns = (
          upgraded.prepare("PRAGMA table_info(deliveries)").all() as { name: string }[]
        ).map((c) => c.name);
        assert.ok(columns.includes("expire_at"), `缺列会让投递写入直接失败：${columns.join(",")}`);
      } finally {
        upgraded.close();
      }

      // 再次打开：已是 v3，迁移必须幂等（否则每次启动都会炸在重复 ALTER 上）
      const again = openDatabase(env.config.dbPath);
      assert.equal(getSchemaVersion(again), 3);
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
        assert.equal(getSchemaVersion(upgraded), 3);
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

  it("历史重名活动账本：唯一索引创建失败只告警，不拒绝启动", () => {
    const env = makeTestEnv();
    let reopened: DatabaseSync | undefined;
    try {
      // 去掉索引后制造历史重名（模拟旧库脏数据）
      env.db.exec("DROP INDEX idx_ledgers_scoped_name");
      const insert = env.db.prepare(
        "INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')",
      );
      insert.run("l1", "日用");
      insert.run("l2", "日用");
      env.db.close();

      // 打不开就说明 best-effort 失效：历史脏数据不该让进程起不来
      reopened = openDatabase(env.config.dbPath);
      assert.equal(getSchemaVersion(reopened), 3);
    } finally {
      reopened?.close();
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
