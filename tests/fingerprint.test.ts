import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "../src/core/database.js";
import {
  reconcileSchemaFingerprint,
  SCHEMA_FINGERPRINT_KEY,
  schemaFingerprint,
  storedSchemaFingerprint,
} from "../src/core/fingerprint.js";
import { logger } from "../src/core/logger.js";
import { runDoctor } from "../src/doctor.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/**
 * 结构指纹：稳定（同一结构两次算一样）、漂移（手工 CREATE TABLE 必须变）、
 * openDatabase 首启写入 / 二次启动不告警、CLI 输出 match、doctor 的 warn 级检查。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "la-fingerprint-"));
}

/** 捕获 logger.warn：验证「二次启动相同不警告」而不必解析 stderr */
function captureWarnings<T>(fn: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = logger.warn;
  logger.warn = (message: string) => {
    warnings.push(message);
  };
  try {
    return { result: fn(), warnings };
  } finally {
    logger.warn = original;
  }
}

describe("结构指纹 schemaFingerprint", () => {
  it("空库也有稳定结果（空快照的 sha256，而不是抛错/null）", () => {
    const dir = tempDir();
    try {
      const path = join(dir, "empty.db");
      const db = new DatabaseSync(path);
      try {
        const first = schemaFingerprint(db);
        const second = schemaFingerprint(db);
        assert.equal(first, second);
        assert.equal(first, createHash("sha256").update("").digest("hex"));
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一库两次计算相同；手工 CREATE TABLE 后变化，DROP 后回到原值", () => {
    const env = makeTestEnv();
    try {
      const before = schemaFingerprint(env.db);
      assert.equal(schemaFingerprint(env.db), before, "同一结构必须稳定");

      env.db.exec("CREATE TABLE tmp_x (a TEXT) STRICT");
      const created = schemaFingerprint(env.db);
      assert.notEqual(created, before, "加表必须改变指纹（手工 ALTER 才查得出来）");

      env.db.exec("DROP TABLE tmp_x");
      assert.equal(schemaFingerprint(env.db), before, "删除后应回到原指纹（内容是结构而非历史）");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("索引变化也算结构变化（幂等重建索引不提升版本号，只能靠指纹发现）", () => {
    const env = makeTestEnv();
    try {
      const before = schemaFingerprint(env.db);
      env.db.exec("CREATE INDEX tmp_x_idx ON ledgers(name)");
      assert.notEqual(schemaFingerprint(env.db), before);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("openDatabase 指纹对账", () => {
  it("首启写入 meta.schema_fingerprint；二次启动结构相同 → 值不变且不告警", () => {
    const env = makeTestEnv();
    try {
      const first = storedSchemaFingerprint(env.db);
      assert.notEqual(first, null, "首启必须写入指纹");
      assert.equal(first, schemaFingerprint(env.db));
      env.db.close();

      const { result: reopened, warnings } = captureWarnings(() => openDatabase(env.config.dbPath));
      try {
        assert.equal(storedSchemaFingerprint(reopened), first, "结构没变时指纹必须不变");
        assert.deepEqual(
          warnings.filter((w) => w.includes("结构指纹")),
          [],
          "相同结构不得每次启动都刷 warn",
        );
      } finally {
        reopened.close();
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("手工改结构后再次打开：warn 一次、随后更新为当前结构，再开就不告警", () => {
    const env = makeTestEnv();
    try {
      const original = storedSchemaFingerprint(env.db);
      assert.notEqual(original, null);
      env.db.close();

      // 模拟手工 ALTER（不提升 schema_version，版本对账看不出来）
      const raw = new DatabaseSync(env.config.dbPath);
      raw.exec("CREATE TABLE manual_table (x TEXT) STRICT");
      raw.close();

      const { result: upgraded, warnings } = captureWarnings(() => openDatabase(env.config.dbPath));
      try {
        assert.ok(
          warnings.some((w) => w.includes("结构指纹") && w.includes("不一致")),
          `结构漂移必须在打开时告警，实际：${JSON.stringify(warnings)}`,
        );
        assert.notEqual(storedSchemaFingerprint(upgraded), original, "漂移后应更新为当前指纹");
        assert.equal(storedSchemaFingerprint(upgraded), schemaFingerprint(upgraded));
      } finally {
        upgraded.close();
      }

      const { result: again, warnings: later } = captureWarnings(() =>
        openDatabase(env.config.dbPath),
      );
      try {
        assert.deepEqual(
          later.filter((w) => w.includes("结构指纹")),
          [],
          "更新后下一次打开不得重复告警（否则真故障的告警会被淹没）",
        );
      } finally {
        again.close();
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("对账幂等：重复调用 reconcile 不改值、不告警", () => {
    const env = makeTestEnv();
    try {
      const before = storedSchemaFingerprint(env.db);
      const { result, warnings } = captureWarnings(() => reconcileSchemaFingerprint(env.db));
      assert.equal(result.match, true);
      assert.equal(result.stored, before);
      assert.deepEqual(warnings, []);
      assert.equal(storedSchemaFingerprint(env.db), before);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("doctor 结构指纹检查", () => {
  it("一致 → ok；缺失 → warn；不一致 → warn（且不阻塞退出码）", async () => {
    const env = makeTestEnv();
    try {
      const base = { DATA_DIR: env.dir, LOG_LEVEL: "error" };
      const healthy = await runDoctor(base);
      const check = healthy.checks.find((c) => c.name === "结构指纹");
      assert.equal(check?.level, "ok", JSON.stringify(healthy.checks));

      // 删掉 meta 行：模拟老库/首次升级（doctor 的检查发生在 openDatabase 之前）
      env.db.prepare("DELETE FROM meta WHERE key = ?").run(SCHEMA_FINGERPRINT_KEY);
      const missing = await runDoctor(base);
      const missingCheck = missing.checks.find((c) => c.name === "结构指纹");
      assert.equal(missingCheck?.level, "warn", JSON.stringify(missing.checks));
      assert.match(missingCheck?.detail ?? "", /还没有结构指纹/);

      // 写一个错误指纹：模拟手工 ALTER 后未对账
      // （上一次 runDoctor 的数据库检查已重新写入正确值，这里用 upsert 覆盖）
      env.db
        .prepare(
          "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        )
        .run(SCHEMA_FINGERPRINT_KEY, "deadbeef".repeat(8));
      const drifted = await runDoctor(base);
      const driftCheck = drifted.checks.find((c) => c.name === "结构指纹");
      assert.equal(driftCheck?.level, "warn", JSON.stringify(drifted.checks));
      assert.match(driftCheck?.detail ?? "", /不一致|手工 ALTER/);
      assert.equal(drifted.failed, 0, "指纹漂移只该是 warn，不能改变退出码");
      // 紧接着的数据库检查会打开库并对账：修复后 stored 必须与当前结构一致
      assert.equal(storedSchemaFingerprint(env.db), schemaFingerprint(env.db));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("数据库不存在 → warn（首次启动会创建并写入）", async () => {
    const dir = tempDir();
    try {
      const report = await runDoctor({ DATA_DIR: dir, LOG_LEVEL: "error" });
      const check = report.checks.find((c) => c.name === "结构指纹");
      assert.equal(check?.level, "warn");
      assert.match(check?.detail ?? "", /不存在/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("db:fingerprint CLI", () => {
  const cliPath = fileURLToPath(new URL("../src/fingerprint.ts", import.meta.url));

  function runCli(dir: string) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath], {
      env: { ...process.env, DATA_DIR: dir, LOG_LEVEL: "error" },
      encoding: "utf8",
    });
  }

  it("首次（库不存在）match:false 并写入；第二次 match:true；手工改结构后 match:false 再修复", () => {
    const dir = tempDir();
    try {
      const first = runCli(dir);
      assert.equal(first.status, 0, first.stderr);
      assert.match(first.stdout, /computed: [0-9a-f]{64}/);
      assert.match(first.stdout, /stored:\s+（无/);
      assert.match(first.stdout, /match: false/);
      assert.match(first.stdout, /schema: v5/);

      const second = runCli(dir);
      assert.equal(second.status, 0, second.stderr);
      assert.match(second.stdout, /stored:\s+[0-9a-f]{64}/);
      assert.match(second.stdout, /match: true/);

      // 手工改结构：打开时会先告警再对账，CLI 的 stored（打开前）与 computed 不同 → match false
      const db = new DatabaseSync(join(dir, "life-assistant.db"));
      db.exec("CREATE TABLE manual_cli (x TEXT) STRICT");
      db.close();
      const drifted = runCli(dir);
      assert.equal(drifted.status, 0, drifted.stderr);
      assert.match(drifted.stdout, /match: false/);
      assert.match(drifted.stdout, /已把 meta\.schema_fingerprint 更新/);

      const fixed = runCli(dir);
      assert.match(fixed.stdout, /match: true/, "对账后下一次必须是 match:true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("失败时输出中文并以退出码 1 结束，不抛裸堆栈", () => {
    const dir = tempDir();
    try {
      // DATA_DIR 指向一个文件：openDatabase 的 mkdir 会失败
      const blocker = join(dir, "not-a-dir");
      writeFileSync(blocker, "x");
      const result = spawnSync(process.execPath, ["--import", "tsx", cliPath], {
        env: { ...process.env, DATA_DIR: blocker, LOG_LEVEL: "error" },
        encoding: "utf8",
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /读取结构指纹失败：/);
      assert.doesNotMatch(result.stderr, /\n\s+at /, "不应输出裸堆栈");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
