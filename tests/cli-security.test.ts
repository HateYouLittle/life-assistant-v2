import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.js";
import { runBackup } from "../src/core/backup.js";
import { openDatabase } from "../src/core/database.js";
import { daemonLockPath } from "../src/core/lock.js";
import { applyCliSecurityBaseline } from "../src/core/security.js";

/**
 * CLI 安全基线（Round1 审查 C4）：daemon 启动时有 `applySecureUmask` + `hardenDataDir`，
 * 但 `db:backup` / `db:restore` / `import:v1` / `db:cleanup:preview` / `db:fingerprint`
 * 由用户手工执行，此前按默认 umask 把库/备份/迁移前快照落成 0644、目录 0755。
 * 这里钉住：共享 helper 生效，且真实 `db:backup` CLI 的产物是 0600、目录 0700。
 *
 * Round2 R2-2 补充：基线**时机**同样要钉住 ——
 * - `db:restore --dry-run` 承诺不写盘，不得 chmod 现有目录/库/备份；
 * - `db:backup` / `db:cleanup:preview` 在库不存在（DATA_DIR 可能写错）时不得 chmod 无关目录；
 * - `{ harden: false }` 只收紧 umask，不碰已有文件。
 *
 * win32 没有 POSIX 权限语义，跳过权限断言（文件能正常生成仍会被断言）。
 */

const permissionMode = (path: string): number => statSync(path).mode & 0o777;
const POSIX = process.platform !== "win32";
const RESTORE_CLI = fileURLToPath(new URL("../src/restore.ts", import.meta.url));

/** 造一个「有库 + 一份规范备份」的数据目录，并把权限放松成默认 umask 的形态 */
function seedRestoreFixture(root: string): {
  dataDir: string;
  config: ReturnType<typeof loadConfig>;
} {
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const config = loadConfig({ DATA_DIR: dataDir });
  const db = openDatabase(config.dbPath);
  db.close();
  runBackup(config, Date.UTC(2026, 9, 22, 3, 0, 0));
  const backupName = readdirSync(config.backupDir).find((name) =>
    /^life-assistant-\d{8}-\d{6}\.db$/.test(name),
  );
  assert.ok(backupName !== undefined, "夹具应生成一份规范备份");
  if (POSIX) {
    chmodSync(dataDir, 0o755);
    chmodSync(config.backupDir, 0o755);
    chmodSync(config.dbPath, 0o644);
    chmodSync(join(config.backupDir, backupName), 0o644);
  }
  return { dataDir, config };
}

function runRestoreCli(args: string[], dataDir: string) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", RESTORE_CLI, ...args, "--data-dir", dataDir],
    { env: { ...process.env, LOG_LEVEL: "error" }, encoding: "utf8" },
  );
}

/** 失败路径不得改动 fixture 的任何权限元数据 */
function assertRestorePermissionsUnchanged(fixture: {
  dataDir: string;
  config: ReturnType<typeof loadConfig>;
}): void {
  if (!POSIX) return;
  assert.equal(permissionMode(fixture.dataDir), 0o755, "失败路径不得改数据目录权限");
  assert.equal(permissionMode(fixture.config.dbPath), 0o644, "失败路径不得改库权限");
  assert.equal(permissionMode(fixture.config.backupDir), 0o755, "失败路径不得改备份目录权限");
  for (const name of readdirSync(fixture.config.backupDir)) {
    if (!name.endsWith(".db")) continue;
    assert.equal(
      permissionMode(join(fixture.config.backupDir, name)),
      0o644,
      `失败路径不得改备份文件 ${name} 权限`,
    );
  }
}

describe("CLI 安全基线", () => {
  it("applyCliSecurityBaseline：收紧已有目录/库，并让之后新建的文件默认 0600", () => {
    const root = mkdtempSync(join(tmpdir(), "la-cli-sec-"));
    const originalUmask = process.umask();
    try {
      const dataDir = join(root, "data");
      const backupDir = join(dataDir, "backups");
      mkdirSync(backupDir, { recursive: true });
      const dbPath = join(dataDir, "life-assistant.db");
      writeFileSync(dbPath, "x");
      // 先把权限"放松"成默认 umask 的效果，避免断言依赖运行者/CI 的 umask（典型 022 → 644/755）
      if (POSIX) {
        chmodSync(dataDir, 0o755);
        chmodSync(backupDir, 0o755);
        chmodSync(dbPath, 0o644);
      }

      applyCliSecurityBaseline({ dataDir, dbPath, backupDir });

      if (POSIX) {
        assert.equal(permissionMode(dataDir), 0o700, "数据目录应收紧到 0700");
        assert.equal(permissionMode(backupDir), 0o700, "备份目录应收紧到 0700");
        assert.equal(permissionMode(dbPath), 0o600, "已有库应收紧到 0600");
        // umask 生效：之后新建的文件（WAL/备份/快照等）默认 0600，不靠逐文件 chmod
        const fresh = join(dataDir, "fresh.txt");
        writeFileSync(fresh, "x");
        assert.equal(permissionMode(fresh), 0o600, "基线生效后新建文件必须是 0600");
      }
    } finally {
      process.umask(originalUmask);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("applyCliSecurityBaseline({ harden: false })：只收紧 umask，不改已有目录/库权限", () => {
    const root = mkdtempSync(join(tmpdir(), "la-cli-sec-nohard-"));
    const originalUmask = process.umask();
    try {
      const dataDir = join(root, "data");
      const backupDir = join(dataDir, "backups");
      mkdirSync(backupDir, { recursive: true });
      const dbPath = join(dataDir, "life-assistant.db");
      writeFileSync(dbPath, "x");
      const oldBackup = join(backupDir, "life-assistant-20260101-000000.db");
      writeFileSync(oldBackup, "x");
      if (POSIX) {
        chmodSync(dataDir, 0o755);
        chmodSync(backupDir, 0o755);
        chmodSync(dbPath, 0o644);
        chmodSync(oldBackup, 0o644);
      }

      applyCliSecurityBaseline({ dataDir, dbPath, backupDir }, { harden: false });

      if (POSIX) {
        assert.equal(permissionMode(dataDir), 0o755, "harden:false 不应改目录权限");
        assert.equal(permissionMode(dbPath), 0o644, "harden:false 不应改库权限");
        assert.equal(permissionMode(backupDir), 0o755);
        assert.equal(permissionMode(oldBackup), 0o644);
        // 但 umask 仍要生效：之后新建的文件默认 0600
        const fresh = join(dataDir, "fresh.txt");
        writeFileSync(fresh, "x");
        assert.equal(permissionMode(fresh), 0o600, "harden:false 不等于关闭 umask");
      }
    } finally {
      process.umask(originalUmask);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("db:restore --dry-run 不写盘：不得 chmod 数据目录/库/备份（R2-2）", () => {
    const root = mkdtempSync(join(tmpdir(), "la-cli-restore-dry-"));
    try {
      const dataDir = join(root, "data");
      mkdirSync(dataDir, { recursive: true });
      const config = loadConfig({ DATA_DIR: dataDir });
      const db = openDatabase(config.dbPath);
      db.close();
      runBackup(config, Date.UTC(2026, 9, 22, 3, 0, 0));
      const backupName = readdirSync(config.backupDir).find((name) => name.endsWith(".db"));
      assert.ok(backupName !== undefined, "夹具应生成一份备份");
      const backupFile = join(config.backupDir, backupName);
      // 模拟用户/历史部署的默认权限（dry-run 前后必须完全一致）
      if (POSIX) {
        chmodSync(dataDir, 0o755);
        chmodSync(config.backupDir, 0o755);
        chmodSync(config.dbPath, 0o644);
        chmodSync(backupFile, 0o644);
      }

      const restoreCli = fileURLToPath(new URL("../src/restore.ts", import.meta.url));
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", restoreCli, "--latest", "--dry-run", "--data-dir", dataDir],
        { env: { ...process.env, LOG_LEVEL: "error" }, encoding: "utf8" },
      );
      assert.equal(result.status, 0, result.stderr);
      if (POSIX) {
        assert.equal(permissionMode(dataDir), 0o755, "dry-run 不得改数据目录权限");
        assert.equal(permissionMode(config.dbPath), 0o644, "dry-run 不得改库权限");
        assert.equal(permissionMode(config.backupDir), 0o755, "dry-run 不得改备份目录权限");
        assert.equal(permissionMode(backupFile), 0o644, "dry-run 不得改备份文件权限");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("db:restore 失败路径不改权限：--file 不存在 / daemon 在跑 / 锁损坏（R3-2）", () => {
    const scenarios = [
      { name: "missing-file", args: null as string[] | null, expected: /备份文件不存在/ },
      { name: "locked", args: ["--latest"], expected: /daemon 正在运行/ },
      { name: "corrupt-lock", args: ["--latest"], expected: /内容损坏|无法确认/ },
    ] as const;
    for (const scenario of scenarios) {
      const root = mkdtempSync(join(tmpdir(), `la-cli-restore-fail-${scenario.name}-`));
      try {
        const fixture = seedRestoreFixture(root);
        let args: string[];
        if (scenario.name === "missing-file") {
          args = ["--file", join(root, "definitely-not-exist.db")];
        } else {
          args = ["--latest"];
          writeFileSync(
            daemonLockPath(fixture.dataDir),
            scenario.name === "locked"
              ? JSON.stringify({
                  pid: process.pid,
                  startedAt: "2026-01-01T00:00:00.000Z",
                  hostname: "h",
                })
              : "{not-json",
          );
        }

        const result = runRestoreCli(args, fixture.dataDir);
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, scenario.expected);
        assertRestorePermissionsUnchanged(fixture);
        assert.deepEqual(
          readdirSync(fixture.config.backupDir).filter((name) => name.includes("-pre-restore-")),
          [],
          "失败路径不得生成恢复留底",
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("db:restore DATA_DIR 指向无关目录：只报错，不改该目录权限、不建库/备份（R3-2）", () => {
    const root = mkdtempSync(join(tmpdir(), "la-cli-restore-bad-data-"));
    try {
      const wrongDir = join(root, "wrong-data-dir");
      mkdirSync(wrongDir, { recursive: true });
      const keep = join(wrongDir, "keep.txt");
      writeFileSync(keep, "keep");
      if (POSIX) {
        chmodSync(wrongDir, 0o755);
        chmodSync(keep, 0o644);
      }

      const result = runRestoreCli(["--latest"], wrongDir);
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /没有可用备份/);
      if (POSIX) {
        assert.equal(permissionMode(wrongDir), 0o755, "DATA_DIR 写错时不得 chmod 该目录");
        assert.equal(permissionMode(keep), 0o644, "目录内无关文件权限不得改动");
      }
      assert.equal(existsSync(join(wrongDir, "life-assistant.db")), false, "不得创建空库");
      assert.equal(existsSync(join(wrongDir, "backups")), false, "不得创建备份目录");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("db:restore 正常恢复：写盘前收紧数据目录/库/备份到 0700/0600（R3-2 不得漏收紧）", () => {
    const root = mkdtempSync(join(tmpdir(), "la-cli-restore-ok-"));
    try {
      const fixture = seedRestoreFixture(root);
      const result = runRestoreCli(["--latest"], fixture.dataDir);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /恢复完成/);
      if (POSIX) {
        assert.equal(permissionMode(fixture.dataDir), 0o700, "恢复后数据目录应为 0700");
        assert.equal(permissionMode(fixture.config.dbPath), 0o600, "恢复后主库应为 0600");
        assert.equal(permissionMode(fixture.config.backupDir), 0o700, "备份目录应为 0700");
        const dbFiles = readdirSync(fixture.config.backupDir).filter((name) =>
          name.endsWith(".db"),
        );
        const preRestore = dbFiles.filter((name) => name.includes("-pre-restore-"));
        assert.equal(preRestore.length, 1, "正常恢复应生成一份留底");
        for (const name of dbFiles) {
          assert.equal(
            permissionMode(join(fixture.config.backupDir, name)),
            0o600,
            `备份/留底 ${name} 应为 0600`,
          );
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("db:backup / db:cleanup:preview 在库不存在时只报错，不 chmod 写错的 DATA_DIR（R2-2）", () => {
    const root = mkdtempSync(join(tmpdir(), "la-cli-bad-datadir-"));
    try {
      const dataDir = join(root, "wrong-data-dir");
      mkdirSync(dataDir, { recursive: true });
      if (POSIX) chmodSync(dataDir, 0o755);

      const backupCli = fileURLToPath(new URL("../src/backup.ts", import.meta.url));
      const previewCli = fileURLToPath(new URL("../src/cleanup-preview.ts", import.meta.url));
      const env = { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: "error" };

      const backup = spawnSync(process.execPath, ["--import", "tsx", backupCli], {
        env,
        encoding: "utf8",
      });
      assert.equal(backup.status, 1, backup.stderr);
      assert.match(backup.stderr, /备份失败：数据库不存在/, "错误信息应正常给出");
      if (POSIX) {
        assert.equal(permissionMode(dataDir), 0o755, "DATA_DIR 写错时不得先 chmod 该目录");
      }
      assert.equal(existsSync(join(dataDir, "backups")), false, "库不存在时不得创建备份目录");

      const preview = spawnSync(process.execPath, ["--import", "tsx", previewCli], {
        env,
        encoding: "utf8",
      });
      assert.equal(preview.status, 1, preview.stderr);
      assert.match(preview.stderr, /预演失败：数据库不存在/, "错误信息应正常给出");
      if (POSIX) {
        assert.equal(permissionMode(dataDir), 0o755, "DATA_DIR 写错时不得先 chmod 该目录");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("db:backup CLI 应用同一基线：备份产物 0600、数据/备份目录 0700", () => {
    const root = mkdtempSync(join(tmpdir(), "la-cli-backup-"));
    try {
      const dataDir = join(root, "data");
      mkdirSync(dataDir, { recursive: true });
      // 按「CLI 首次建库」的方式造一个可用的空库（不经过 daemon，因此没有 daemon 的 umask 收紧）
      const db = openDatabase(join(dataDir, "life-assistant.db"));
      db.close();

      const backupCli = fileURLToPath(new URL("../src/backup.ts", import.meta.url));
      const result = spawnSync(process.execPath, ["--import", "tsx", backupCli], {
        env: { ...process.env, DATA_DIR: dataDir, LOG_LEVEL: "error" },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);

      const backupDir = join(dataDir, "backups");
      const backups = readdirSync(backupDir).filter((name) =>
        /^life-assistant-\d{8}-\d{6}\.db$/.test(name),
      );
      assert.equal(backups.length, 1, `应有 1 份规范备份，实际：${backups.join("、")}`);
      if (POSIX) {
        assert.equal(permissionMode(dataDir), 0o700, "CLI 应把数据目录收紧到 0700");
        assert.equal(permissionMode(backupDir), 0o700, "CLI 应把备份目录收紧到 0700");
        assert.equal(
          permissionMode(join(backupDir, backups[0] as string)),
          0o600,
          "CLI 备份产物必须是 0600（与 daemon job 同口径）",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
