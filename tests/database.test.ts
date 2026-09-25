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

describe("database schema v2", () => {
  it("新库迁移到最新版本并可重复打开", () => {
    const env = makeTestEnv();
    try {
      assert.equal(getSchemaVersion(env.db), 2);
      env.db.close();
      const reopened = openDatabase(env.config.dbPath);
      assert.equal(getSchemaVersion(reopened), 2);
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
      raw.exec("ALTER TABLE deliveries DROP COLUMN expire_at");
      raw.prepare("UPDATE meta SET value = '1' WHERE key = 'schema_version'").run();
      raw.close();

      const upgraded = openDatabase(env.config.dbPath);
      try {
        assert.equal(getSchemaVersion(upgraded), 2, "老库必须在启动时升级版本号");
        const columns = (
          upgraded.prepare("PRAGMA table_info(deliveries)").all() as { name: string }[]
        ).map((c) => c.name);
        assert.ok(columns.includes("expire_at"), `缺列会让投递写入直接失败：${columns.join(",")}`);
      } finally {
        upgraded.close();
      }

      // 再次打开：已是 v2，迁移必须幂等（否则每次启动都会炸在重复 ALTER 上）
      const again = openDatabase(env.config.dbPath);
      assert.equal(getSchemaVersion(again), 2);
      again.close();
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
