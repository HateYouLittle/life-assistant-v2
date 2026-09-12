import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runBackup } from "../src/backup.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

describe("db:backup", () => {
  it("生成 VACUUM INTO 备份并可独立打开", () => {
    const env = makeTestEnv();
    try {
      env.db.prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '日用', '2026-01-01T00:00:00.000Z')").run();
      const target = runBackup(env.config, Date.UTC(2026, 8, 12, 3, 4, 5));
      assert.match(target, /life-assistant-20260912-030405\.db$/);
      const backup = readdirSync(env.config.backupDir).filter((f) => f.endsWith(".db"));
      assert.equal(backup.length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同名备份拒绝覆盖", () => {
    const env = makeTestEnv();
    try {
      const stamp = Date.UTC(2026, 8, 12, 3, 4, 5);
      runBackup(env.config, stamp);
      assert.throws(() => runBackup(env.config, stamp), /拒绝覆盖/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("数据库不存在时拒绝生成空备份", () => {
    const env = makeTestEnv();
    try {
      const missing = { ...env.config, dbPath: join(env.dir, "nope", "life-assistant.db") };
      assert.throws(() => runBackup(missing), /拒绝生成空备份/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("只保留最近 14 份", () => {
    const env = makeTestEnv();
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      for (let day = 1; day <= 16; day++) {
        const name = `life-assistant-202601${String(day).padStart(2, "0")}-000000.db`;
        writeFileSync(join(env.config.backupDir, name), "not-a-real-db");
      }
      runBackup(env.config, Date.UTC(2026, 8, 12));
      const files = readdirSync(env.config.backupDir).filter((f) => f.endsWith(".db"));
      assert.equal(files.length, 14);
      assert.ok(files.includes("life-assistant-20260912-000000.db"));
      assert.ok(!files.includes("life-assistant-20260101-000000.db"));
      assert.ok(!files.includes("life-assistant-20260103-000000.db"));
      assert.ok(files.includes("life-assistant-20260104-000000.db"));
    } finally {
      cleanupTestEnv(env);
    }
  });
});
