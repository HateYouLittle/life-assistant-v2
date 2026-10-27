import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { runBackup } from "../src/backup.js";
import { publishBackupFile } from "../src/core/backup.js";
import { MissingDatabaseError, runBackup as runCoreBackup } from "../src/core/backup.js";
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

  it("同秒撞名自动顺延 1s 换名，不覆盖已有备份（P2-13 回归）", () => {
    const env = makeTestEnv();
    try {
      const stamp = Date.UTC(2026, 8, 12, 3, 4, 5);
      const first = runBackup(env.config, stamp);
      // 同一秒再跑一次（模拟 daemon 备份与手动 db:backup 撞车）：旧实现直接抛
      // 「备份已存在，拒绝覆盖」，当次备份就没了；现在应顺延 1s 换名成功。
      const second = runBackup(env.config, stamp);
      assert.notEqual(second, first, "不得覆盖第一份备份");
      assert.match(first, new RegExp(`life-assistant-${stampOf(stamp)}\\.db$`));
      assert.match(
        second,
        new RegExp(`life-assistant-${stampOf(stamp + 1000)}\\.db$`),
        "撞名时顺延 1 秒换名",
      );
      assert.equal(existsSync(first), true);
      assert.equal(existsSync(`${first}.verified`), true);
      assert.equal(existsSync(`${second}.verified`), true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("连续 5 个规范名都被占用时报错（不再无限重试）", () => {
    const env = makeTestEnv();
    try {
      const stamp = Date.UTC(2026, 8, 12, 3, 4, 5);
      mkdirSync(env.config.backupDir, { recursive: true });
      for (let i = 0; i < 5; i += 1) {
        writeFileSync(
          join(env.config.backupDir, `life-assistant-${stampOf(stamp + i * 1000)}.db`),
          "occupied",
        );
      }
      assert.throws(() => runBackup(env.config, stamp), /同一秒及后 4 秒/);
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

  it("BACKUP_KEEP 生效：保留份数取配置而不是写死 14", () => {
    const env = makeTestEnv({ BACKUP_KEEP: "3" });
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      // 旧备份文件名按 Asia/Shanghai 本地日期生成，字典序即新旧顺序
      const names: string[] = [];
      for (let day = 1; day <= 5; day++) {
        const name = `life-assistant-2026010${day}-000000.db`;
        names.push(name);
        writeFileSync(join(env.config.backupDir, name), "not-a-real-db");
      }
      const ms = Date.UTC(2026, 8, 12, 0, 0, 0);
      const newest = `life-assistant-${stampOf(ms)}.db`;
      runBackup(env.config, ms);

      const files = readdirSync(env.config.backupDir).filter((f) => f.endsWith(".db"));
      assert.equal(files.length, 3, "BACKUP_KEEP=3 时应只保留最近 3 份");
      assert.deepEqual(files.sort(), [...names.slice(3), newest].sort());
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("core/backup 可被模块复用：opts.keep 覆盖配置，非法 keep 直接拒绝", () => {
    const env = makeTestEnv({ BACKUP_KEEP: "1" });
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      const old = "life-assistant-20260101-000000.db";
      writeFileSync(join(env.config.backupDir, old), "not-a-real-db");
      const ms = Date.UTC(2026, 8, 12, 0, 0, 0);
      // 配置只留 1 份；显式 keep=2 时旧备份应保留 —— 每日备份 job 走的就是这条核心路径
      runCoreBackup(env.config, ms, { keep: 2 });
      const files = readdirSync(env.config.backupDir).filter((f) => f.endsWith(".db"));
      assert.deepEqual(files.sort(), [old, `life-assistant-${stampOf(ms)}.db`].sort());

      // 保留份数非法时不得静默按 0 处理（那会把所有旧备份删光）
      assert.throws(() => runCoreBackup(env.config, ms, { keep: 0 }), /保留份数/);

      const missing = { ...env.config, dbPath: join(env.dir, "nope", "life-assistant.db") };
      assert.throws(
        () => runCoreBackup(missing),
        (e: unknown) => e instanceof MissingDatabaseError,
        "缺库必须是专用错误：每日备份 job 据此降级为 warn 跳过",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("db:backup CLI", () => {
  it("失败时输出「备份失败：…」并以退出码 1 结束，不抛裸堆栈", () => {
    // 不给 DATA_DIR：loadConfig 直接报错。此前 main() 没有 try/catch，
    // 失败会以未捕获异常 + 堆栈形式抛出，SQLite 的原始信息里也没有库/目标路径。
    const backupPath = fileURLToPath(new URL("../src/backup.ts", import.meta.url));
    const result = spawnSync(process.execPath, ["--import", "tsx", backupPath], {
      env: { ...process.env, DATA_DIR: "" },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /备份失败：/);
    assert.doesNotMatch(result.stderr, /\n\s+at /, "不应输出裸堆栈");
  });

  it("原子发布：成功后备份以规范名出现，目录里不留 .partial 临时产物", () => {
    const env = makeTestEnv();
    try {
      const target = runBackup(env.config);
      const files = readdirSync(env.config.backupDir);
      const dbName = target.slice(target.lastIndexOf("/") + 1);
      assert.deepEqual(files.sort(), [dbName, `${dbName}.verified`].sort());
      assert.equal(
        files.filter((name) => name.includes(".partial-")).length,
        0,
        "校验通过的临时文件必须 rename 掉，不能留在目录里",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("清理被打断的半截备份：超过 1 小时的 .partial 删除，刚写的保留（可能还有进程在写）", () => {
    const env = makeTestEnv();
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      const stalePartial = join(
        env.config.backupDir,
        "life-assistant-20200101-000000.db.partial-12345678-abcd1234",
      );
      writeFileSync(stalePartial, "half-written");
      const twoHoursAgo = Date.now() / 1000 - 2 * 3600;
      utimesSync(stalePartial, twoHoursAgo, twoHoursAgo);
      const livePartial = join(
        env.config.backupDir,
        `life-assistant-20200102-000000.db.partial-${process.pid}-deadbeef`,
      );
      writeFileSync(livePartial, "in-progress");

      runBackup(env.config);

      assert.equal(existsSync(stalePartial), false, "残留半截备份应在 prune 时清掉");
      assert.equal(existsSync(livePartial), true, "1 小时内的 .partial 可能还在写，不能删");
      assert.equal(
        readdirSync(env.config.backupDir).filter((name) => name.endsWith(".db")).length,
        1,
        ".partial 不能被 backupStatus/恢复当成规范备份",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("发布用 link 保持「同名备份拒绝覆盖」契约（复审 T-1027-02b）", () => {
    const env = makeTestEnv();
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      const partial = join(env.config.backupDir, "life-assistant-20260101-000000.db.partial-1-aa");
      const target = join(env.config.backupDir, "life-assistant-20260101-000000.db");
      writeFileSync(partial, "new-snapshot");
      writeFileSync(target, "existing-snapshot");

      assert.throws(() => publishBackupFile(partial, target), /拒绝覆盖/);
      assert.equal(readFileSync(target, "utf8"), "existing-snapshot", "不得静默覆盖已有备份");
      assert.equal(existsSync(partial), true, "发布失败时临时文件应留给调用方清理/排障");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("发布成功：目标出现且临时文件被清掉", () => {
    const env = makeTestEnv();
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      const partial = join(env.config.backupDir, "life-assistant-20260101-000000.db.partial-1-bb");
      const target = join(env.config.backupDir, "life-assistant-20260101-000000.db");
      writeFileSync(partial, "snapshot");
      publishBackupFile(partial, target);
      assert.equal(readFileSync(target, "utf8"), "snapshot");
      assert.equal(existsSync(partial), false);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("清理旧备份时连带删除校验旁车，孤儿旁车也会被清掉（P1-4 复审 e）", () => {
    const env = makeTestEnv();
    try {
      // keep=1：第二份备份发布后，第一份（含其旁车）应被 prune 掉
      const first = runBackup(env.config, Date.UTC(2026, 8, 12, 1, 0, 0), { keep: 1 });
      assert.equal(existsSync(`${first}.verified`), true);
      // 孤儿旁车：对应 .db 不存在（模拟手工删库/复制残留）
      const orphan = join(env.config.backupDir, "life-assistant-20200101-000000.db.verified");
      writeFileSync(orphan, "{}");

      const second = runBackup(env.config, Date.UTC(2026, 8, 12, 2, 0, 0), { keep: 1 });

      assert.equal(existsSync(first), false, "超出保留份数的旧备份应被清掉");
      assert.equal(existsSync(`${first}.verified`), false, "旁车要跟着备份一起删");
      assert.equal(existsSync(orphan), false, "孤儿旁车也会在 prune 时清理");
      assert.equal(existsSync(second), true);
      assert.equal(existsSync(`${second}.verified`), true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("旁车临时文件：超过 1 小时的 .verified.tmp-* 清掉，刚写的留着（可能还在写）", () => {
    const env = makeTestEnv();
    try {
      mkdirSync(env.config.backupDir, { recursive: true });
      const staleTmp = join(
        env.config.backupDir,
        "life-assistant-20200101-000000.db.verified.tmp-12345678-abcd1234",
      );
      writeFileSync(staleTmp, "{半截");
      const twoHoursAgo = Date.now() / 1000 - 2 * 3600;
      utimesSync(staleTmp, twoHoursAgo, twoHoursAgo);
      const liveTmp = join(
        env.config.backupDir,
        `life-assistant-20200102-000000.db.verified.tmp-${process.pid}-deadbeef`,
      );
      writeFileSync(liveTmp, "{半截");

      runBackup(env.config);

      assert.equal(existsSync(staleTmp), false, "残留的旁车临时文件应在 prune 时清掉");
      assert.equal(existsSync(liveTmp), true, "1 小时内的旁车临时文件不能删（可能正在写）");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
