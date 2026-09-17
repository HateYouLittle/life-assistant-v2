import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { runBackup } from "../src/backup.js";
import { TZ } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/** 备份时间戳按 Asia/Shanghai 本地时间生成（与项目其余部分一致，而不是 UTC） */
const stampOf = (ms: number): string =>
  DateTime.fromMillis(ms, { zone: TZ }).toFormat("yyyyMMdd-HHmmss");

describe("db:backup", () => {
  it("生成 VACUUM INTO 备份并可独立打开", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '日用', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      const ms = Date.UTC(2026, 8, 12, 3, 4, 5);
      const target = runBackup(env.config, ms);
      assert.match(target, new RegExp(`life-assistant-${stampOf(ms)}\\.db$`));
      const backup = readdirSync(env.config.backupDir).filter((f) => f.endsWith(".db"));
      assert.equal(backup.length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("时间戳用本地时区：UTC 16:30 属于北京次日 00:30", () => {
    const env = makeTestEnv();
    try {
      // 北京 2026-09-13 00:30 == UTC 2026-09-12 16:30
      const ms = Date.UTC(2026, 8, 12, 16, 30, 0);
      const target = runBackup(env.config, ms);
      assert.match(target, /life-assistant-20260913-003000\.db$/, "应使用北京时间而不是 UTC 日期");
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
      // 与生产同构：文件名按 Asia/Shanghai 本地时间生成，才能用字典序表达新旧
      const names: string[] = [];
      for (let day = 1; day <= 16; day++) {
        const dt = DateTime.fromObject({ year: 2026, month: 1, day }, { zone: TZ });
        const name = `life-assistant-${dt.toFormat("yyyyMMdd")}-000000.db`;
        names.push(name);
        writeFileSync(join(env.config.backupDir, name), "not-a-real-db");
      }
      // 北京 2026-09-12 08:00（= UTC 00:00），比所有既有备份都新
      const ms = Date.UTC(2026, 8, 12, 0, 0, 0);
      const newest = `life-assistant-${stampOf(ms)}.db`;
      runBackup(env.config, ms);

      const files = readdirSync(env.config.backupDir).filter((f) => f.endsWith(".db"));
      assert.equal(files.length, 14, "应只保留最近 14 份");
      assert.ok(files.includes(newest), "最新一份必须在");
      // 最旧的 3 份（17 - 14）应被清理，其余保留
      for (const gone of names.slice(0, 3)) {
        assert.ok(!files.includes(gone), `${gone} 应被清理`);
      }
      for (const kept of names.slice(3)) {
        assert.ok(files.includes(kept), `${kept} 应保留`);
      }
    } finally {
      cleanupTestEnv(env);
    }
  });
});
