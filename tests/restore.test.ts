import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { runBackup } from "../src/backup.js";
import { openDatabase, SCHEMA_VERSION } from "../src/core/database.js";
import { daemonLockPath } from "../src/core/lock.js";
import { resolveRestoreTarget, runRestore } from "../src/restore.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 恢复 CLI / 库函数：成功恢复、坏备份拒绝、高版本备份拒绝、daemon 运行中拒绝、
 * --dry-run 不写盘。全部在临时目录构造 v4 库与备份，绝不碰真实 DATA_DIR。
 */

function seedLedger(env: TestEnv, id: string): void {
  env.db
    .prepare("INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, ?)")
    .run(id, id, "2026-01-01T00:00:00.000Z");
}

function ledgerIds(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("SELECT id FROM ledgers ORDER BY id").all() as { id: string }[];
    return rows.map((row) => row.id);
  } finally {
    db.close();
  }
}

function preRestoreFiles(env: TestEnv): string[] {
  if (!existsSync(env.config.backupDir)) return [];
  return readdirSync(env.config.backupDir).filter((name) => name.includes("-pre-restore-"));
}

describe("db:restore", () => {
  it("成功恢复：覆盖主库、恢复旧数据、删掉 -wal/-shm、留底现场并收紧权限", () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "keep-me");
      env.db.close();
      const backupPath = runBackup(env.config, Date.UTC(2026, 8, 12, 1, 0, 0));

      // 模拟备份之后发生的「坏改动」：既有行被删、又多了只在新库里的行
      const current = openDatabase(env.config.dbPath);
      current.prepare("DELETE FROM ledgers WHERE id = 'keep-me'").run();
      current
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('new-only', 'new-only', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      current.close();

      const result = runRestore(env.config, {
        latest: true,
        nowMs: Date.UTC(2026, 8, 12, 2, 0, 0),
      });
      assert.equal(result.target, backupPath);
      assert.equal(result.schemaVersion, SCHEMA_VERSION);
      assert.equal(result.dryRun, false);
      assert.deepEqual(ledgerIds(env.config.dbPath), ["keep-me"], "应回到备份时的数据");

      assert.ok(result.preRestoreBackup !== null);
      assert.equal(existsSync(result.preRestoreBackup), true);
      assert.ok(
        ledgerIds(result.preRestoreBackup).includes("new-only"),
        "留底必须是覆盖前的现场（含备份之后的新数据）",
      );
      assert.deepEqual(preRestoreFiles(env), [
        result.preRestoreBackup.slice(result.preRestoreBackup.lastIndexOf("/") + 1),
      ]);

      // 旧 WAL/SHM 属于旧库，恢复后必须清掉（否则新库可能读到不属于它的页）
      assert.equal(existsSync(`${env.config.dbPath}-wal`), false);
      assert.equal(existsSync(`${env.config.dbPath}-shm`), false);

      if (process.platform !== "win32") {
        assert.equal(statSync(env.config.dbPath).mode & 0o777, 0o600, "恢复后数据库应为 0600");
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("坏备份拒绝恢复：quick_check 不通过时当前库原样保留", () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "keep-me");
      env.db.close();
      mkdirSync(env.config.backupDir, { recursive: true });
      const bad = join(env.config.backupDir, "life-assistant-20260101-000000.db");
      writeFileSync(bad, "not a sqlite database at all");

      assert.throws(() => runRestore(env.config, { file: bad }), /备份校验失败/);
      assert.deepEqual(ledgerIds(env.config.dbPath), ["keep-me"], "拒绝恢复时当前库不得改动");
      assert.deepEqual(preRestoreFiles(env), [], "拒绝恢复时不该生成留底");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("高版本备份拒绝恢复：schema 高于程序支持版本", () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "keep-me");
      env.db.close();
      mkdirSync(env.config.backupDir, { recursive: true });
      const future = join(env.config.backupDir, "life-assistant-20260101-000000.db");
      const db = new DatabaseSync(future);
      try {
        db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
        db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
          String(SCHEMA_VERSION + 1),
        );
      } finally {
        db.close();
      }

      assert.throws(
        () => runRestore(env.config, { file: future }),
        /高于程序支持的/,
        "旧程序打开新库会拒绝启动，恢复过去等于自锁",
      );
      assert.deepEqual(ledgerIds(env.config.dbPath), ["keep-me"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("旧版本备份允许恢复（daemon 启动时会自动附加式升级）", () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "keep-me");
      env.db.close();
      const backupPath = runBackup(env.config);
      // 把备份的 schema 版本改成 v3：恢复只要求「不高于程序支持版本」，升级交给 daemon 启动
      const backupDb = new DatabaseSync(backupPath);
      try {
        backupDb.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
      } finally {
        backupDb.close();
      }

      const result = runRestore(env.config, { file: backupPath });
      assert.equal(result.schemaVersion, 3);
      assert.deepEqual(ledgerIds(env.config.dbPath), ["keep-me"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("daemon 正在运行时拒绝恢复（提示先停服）", () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "keep-me");
      env.db.close();
      runBackup(env.config);
      writeFileSync(
        daemonLockPath(env.dir),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "test-host",
        }),
      );

      assert.throws(
        () => runRestore(env.config, { latest: true }),
        /daemon 正在运行/,
        "运行中替换数据库会丢 WAL 写入，必须拒绝",
      );
      assert.deepEqual(ledgerIds(env.config.dbPath), ["keep-me"]);
      assert.deepEqual(preRestoreFiles(env), []);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("daemon 运行中仍允许 --dry-run：只读预演不碰主库，不该逼用户先停服", () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "keep-me");
      env.db.close();
      const backupPath = runBackup(env.config);
      writeFileSync(
        daemonLockPath(env.dir),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "test-host",
        }),
      );

      const result = runRestore(env.config, { latest: true, dryRun: true });
      assert.equal(result.dryRun, true);
      assert.equal(result.target, backupPath);
      assert.deepEqual(preRestoreFiles(env), [], "dry-run 不写留底");
      assert.deepEqual(ledgerIds(env.config.dbPath), ["keep-me"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("--dry-run 只校验并返回计划，不写任何文件", () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "keep-me");
      env.db.close();
      const backupPath = runBackup(env.config);
      const before = readdirSync(env.config.backupDir).sort();

      const result = runRestore(env.config, { latest: true, dryRun: true });
      assert.equal(result.dryRun, true);
      assert.equal(result.target, backupPath);
      assert.equal(result.preRestoreBackup, null);
      assert.deepEqual(readdirSync(env.config.backupDir).sort(), before, "dry-run 不得写盘");
      assert.deepEqual(preRestoreFiles(env), []);
      assert.deepEqual(ledgerIds(env.config.dbPath), ["keep-me"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("目标解析：没有备份报错；--file 与 --latest 互斥；指定文件不存在报错", () => {
    const env = makeTestEnv();
    try {
      assert.throws(() => resolveRestoreTarget(env.config, {}), /没有可用备份/);
      const backupPath = runBackup(env.config);
      assert.throws(
        () => resolveRestoreTarget(env.config, { file: backupPath, latest: true }),
        /不能同时使用/,
      );
      assert.throws(
        () => runRestore(env.config, { file: join(env.dir, "nope.db") }),
        /备份文件不存在/,
      );
      assert.equal(resolveRestoreTarget(env.config, {}), backupPath, "缺省取最新规范备份");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("db:restore CLI", () => {
  const restorePath = fileURLToPath(new URL("../src/restore.ts", import.meta.url));

  it("--dry-run 打印计划并以退出码 0 结束", () => {
    const env = makeTestEnv();
    try {
      env.db.close();
      runBackup(env.config);
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", restorePath, "--latest", "--dry-run", "--data-dir", env.dir],
        { env: { ...process.env, LOG_LEVEL: "error" }, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /数据库恢复/);
      assert.match(result.stdout, /不会真正执行/);
      assert.match(result.stdout, /不会真正执行[\s\S]*-wal/, "应说明会删除 -wal/-shm");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("失败时输出「恢复失败：…」并以退出码 1 结束，不抛裸堆栈", () => {
    const env = makeTestEnv();
    try {
      env.db.close();
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          restorePath,
          "--file",
          join(env.dir, "missing.db"),
          "--data-dir",
          env.dir,
        ],
        { env: { ...process.env, LOG_LEVEL: "error" }, encoding: "utf8" },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /恢复失败：/);
      assert.doesNotMatch(result.stderr, /\n\s+at /, "不应输出裸堆栈");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
