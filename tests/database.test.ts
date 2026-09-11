import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { getSchemaVersion, openDatabase, withTransaction } from "../src/core/database.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

describe("database schema v1", () => {
  it("新库迁移到 v1 并可重复打开", () => {
    const env = makeTestEnv();
    try {
      assert.equal(getSchemaVersion(env.db), 1);
      env.db.close();
      const reopened = openDatabase(env.config.dbPath);
      assert.equal(getSchemaVersion(reopened), 1);
      reopened.close();
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("STRICT 表拒绝错误类型与非法 CHECK", () => {
    const env = makeTestEnv();
    try {
      env.db.prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '日用', '2026-01-01T00:00:00.000Z')").run();
      assert.throws(() =>
        env.db
          .prepare("INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run("e1", "l1", "12.34元", "2026-09-11", "default", "2026-01-01T00:00:00.000Z"),
      );
      assert.throws(() =>
        env.db
          .prepare("INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run("e2", "l1", 0, "2026-09-11", "default", "2026-01-01T00:00:00.000Z"),
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("外键开启：账目必须挂在存在的账本上", () => {
    const env = makeTestEnv();
    try {
      assert.throws(() =>
        env.db
          .prepare("INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run("e3", "missing", 100, "2026-09-11", "default", "2026-01-01T00:00:00.000Z"),
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("通知去重键 Profile 内唯一", () => {
    const env = makeTestEnv();
    try {
      env.db.prepare("INSERT INTO profiles (id, created_at) VALUES ('other', '2026-01-01T00:00:00.000Z')").run();
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
          env.db.prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('lx', 'x', '2026-01-01T00:00:00.000Z')").run();
          throw new Error("boom");
        }),
      );
      const row = env.db.prepare("SELECT COUNT(*) AS n FROM ledgers WHERE id = 'lx'").get() as { n: number };
      assert.equal(row.n, 0);
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
