import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { runBackup } from "../src/backup.js";
import { BACKUP_STALE_HOURS, backupStatus, verifyDatabaseFile } from "../src/core/backup.js";
import { SCHEMA_VERSION } from "../src/core/database.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/**
 * 备份自校验与备份状态：
 * - runBackup 产物必须能被独立打开（quick_check + meta.schema_version）；
 * - 坏文件/缺 meta 表的文件必须被 verifyDatabaseFile 拒绝（恢复 CLI 依赖同一判定）；
 * - backupStatus 要能区分规范命名与非规范文件，并按 36h 阈值判定过期。
 */

describe("备份自校验", () => {
  it("verifyDatabaseFile 接受真实备份并返回 schema 版本", () => {
    const env = makeTestEnv();
    try {
      const target = runBackup(env.config);
      assert.equal(verifyDatabaseFile(target), SCHEMA_VERSION);
      // 硬性要求：备份产物就是「用户以为有的后路」，必须能独立打开
      assert.equal(existsSync(target), true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("verifyDatabaseFile 拒绝非数据库文件（坏备份绝不能冒充可用）", () => {
    const env = makeTestEnv();
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      const garbage = join(env.config.backupDir, "life-assistant-20200101-000000.db");
      writeFileSync(garbage, "this is not a sqlite database");
      assert.throws(() => verifyDatabaseFile(garbage), /database|file is not/i);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("verifyDatabaseFile 拒绝缺 meta.schema_version 的 SQLite 库", () => {
    const env = makeTestEnv();
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      const notLifeAssistant = join(env.config.backupDir, "other.db");
      const db = new DatabaseSync(notLifeAssistant);
      try {
        db.exec("CREATE TABLE unrelated (x INTEGER)");
      } finally {
        db.close();
      }
      assert.throws(() => verifyDatabaseFile(notLifeAssistant), /schema_version/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("verifyDatabaseFile 文件不存在时抛错（不会被当成空库放行）", () => {
    const env = makeTestEnv();
    try {
      assert.throws(() => verifyDatabaseFile(join(env.dir, "nope.db")));
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("备份状态 backupStatus", () => {
  it("备份目录不存在：无文件、无最新、视为过期", () => {
    const env = makeTestEnv();
    try {
      const status = backupStatus(env.config);
      assert.equal(status.dir, env.config.backupDir);
      assert.deepEqual(status.files, []);
      assert.equal(status.latest, null);
      assert.equal(status.ageHours, null);
      assert.equal(status.stale, true);
      assert.deepEqual(status.nonCanonical, []);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("生成备份后：latest 指向规范文件，新鲜（不 stale）", () => {
    const env = makeTestEnv();
    try {
      const target = runBackup(env.config);
      const status = backupStatus(env.config);
      assert.equal(status.files.length, 1);
      assert.equal(status.latest?.path, target);
      assert.equal(status.latest?.canonical, true);
      assert.ok((status.ageHours ?? Number.POSITIVE_INFINITY) < 1);
      assert.equal(status.stale, false);
      assert.deepEqual(status.nonCanonical, []);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("超过 36 小时没有新备份判为 stale", () => {
    const env = makeTestEnv();
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      const old = join(env.config.backupDir, "life-assistant-20200101-000000.db");
      writeFileSync(old, "old");
      // 48 小时前：用 mtime 表达真实年龄（文件名不参与 stale 判定）
      const oldSeconds = Date.now() / 1000 - 48 * 3600;
      utimesSync(old, oldSeconds, oldSeconds);

      const status = backupStatus(env.config);
      assert.equal(status.stale, true);
      assert.ok(
        (status.ageHours ?? 0) >= BACKUP_STALE_HOURS,
        `ageHours=${status.ageHours} 应超过 ${BACKUP_STALE_HOURS}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非规范命名的 *.db 被单列，且不会被 --latest 选中", () => {
    const env = makeTestEnv();
    try {
      const canonical = runBackup(env.config);
      mkdirSync(env.config.backupDir, { recursive: true });
      const strays = [
        "life-assistant-pre-v3-20260101-000000.db",
        "life-assistant-pre-restore-20260101-000000.db",
        "zombie-copy.db",
      ];
      for (const name of strays) writeFileSync(join(env.config.backupDir, name), "x");
      // 让非规范文件的 mtime 比规范备份更新：latest 仍必须只认规范命名
      const newer = Date.now() / 1000 + 60;
      for (const name of strays) utimesSync(join(env.config.backupDir, name), newer, newer);

      const status = backupStatus(env.config);
      assert.deepEqual(status.nonCanonical.sort(), [...strays].sort());
      assert.equal(status.latest?.path, canonical, "latest 只看 life-assistant-<时间戳>.db");
      assert.equal(status.files.length, 4);
      assert.equal(status.files.filter((file) => file.canonical).length, 1);
      assert.equal(
        readdirSync(env.config.backupDir).filter((name) => name.endsWith(".db")).length,
        4,
        "目录里还应有 <name>.db.verified 旁车，按 *.db 计仍是 4 份",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("verifyLatest：健康备份判 true；损坏的规范备份判 false 且 stale（P1-4）", () => {
    const env = makeTestEnv();
    try {
      const target = runBackup(env.config);
      const healthy = backupStatus(env.config, Date.now(), { verifyLatest: true });
      assert.equal(healthy.latest?.path, target);
      assert.equal(healthy.latestVerified, true);
      assert.equal(healthy.stale, false);

      // 默认不校验：省掉状态页/`/metrics` 高频调用的 DB 打开开销
      assert.equal(backupStatus(env.config).latestVerified, null);

      // 用坏字节覆盖成「规范名但打不开」：mtime 依旧很新，旧口径会报健康
      const broken = join(env.config.backupDir, "life-assistant-20990101-000000.db");
      writeFileSync(broken, "not-a-sqlite-db");
      const status = backupStatus(env.config, Date.now(), { verifyLatest: true });
      assert.equal(status.latest?.path, broken, "latest 仍按 mtime 选");
      assert.equal(status.latestVerified, false);
      assert.equal(status.stale, true, "最新备份不可用时必须报 stale，而不是「新鲜健康」");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("sidecar：备份成功写校验旁车，零开库口径给出 latestVerified（P1-4 复审 e）", () => {
    const env = makeTestEnv();
    try {
      const target = runBackup(env.config);
      const sidecar = `${target}.verified`;
      assert.equal(existsSync(sidecar), true, "备份成功应写 <name>.db.verified 旁车");
      const payload = JSON.parse(readFileSync(sidecar, "utf8")) as {
        schemaVersion: number;
        verifiedAt: string;
        sizeBytes: number;
      };
      assert.equal(payload.schemaVersion, 5);
      assert.equal(payload.sizeBytes, statSync(target).size);
      assert.ok(!Number.isNaN(Date.parse(payload.verifiedAt)));

      assert.equal(backupStatus(env.config).latestVerified, null, "默认不读旁车也不开库");
      assert.equal(
        backupStatus(env.config, Date.now(), { sidecar: true }).latestVerified,
        true,
        "零开库口径应信任与大小匹配的旁车",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("sidecar：缺失时零开库口径不可信，但现场校验仍能证明备份可用", () => {
    const env = makeTestEnv();
    try {
      const target = runBackup(env.config);
      unlinkSync(`${target}.verified`);

      const bySidecar = backupStatus(env.config, Date.now(), { sidecar: true });
      assert.equal(bySidecar.latestVerified, false);
      assert.equal(bySidecar.stale, true, "没有可信旁车时不能再报「新鲜健康」");

      const byDb = backupStatus(env.config, Date.now(), { verifyLatest: true });
      assert.equal(byDb.latestVerified, true, "doctor --live 的开库校验仍是最终事实");
      assert.equal(byDb.stale, false);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("sidecar：大小对不上（复制/覆盖过的旧旁车）按不可信处理", () => {
    const env = makeTestEnv();
    try {
      const target = runBackup(env.config);
      const sidecar = `${target}.verified`;
      const payload = JSON.parse(readFileSync(sidecar, "utf8")) as Record<string, unknown>;
      writeFileSync(
        sidecar,
        JSON.stringify({ ...payload, sizeBytes: (payload.sizeBytes as number) + 1 }),
      );
      assert.equal(backupStatus(env.config, Date.now(), { sidecar: true }).latestVerified, false);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
