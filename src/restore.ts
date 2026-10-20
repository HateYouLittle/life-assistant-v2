import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { loadConfig, type ResolvedConfig } from "./config.js";
import { backupStatus, verifyDatabaseFile } from "./core/backup.js";
import { SCHEMA_VERSION } from "./core/database.js";
import { daemonLockPath, isDaemonLocked } from "./core/lock.js";
import { logger } from "./core/logger.js";
import { TZ } from "./time.js";

/**
 * `npm run db:restore`：从备份恢复数据库（README 里手工四步的自动化版本）。
 *
 * 比手工 `cp` 多做的四件事，也是它存在的理由：
 * 1. 先校验备份（quick_check + 能读 schema 版本），坏文件直接拒绝 —— 手工恢复最容易
 *    在「备份其实打不开」时把好库覆盖成坏库；
 * 2. schema 版本高于程序支持时拒绝 —— 旧程序打开新库会拒绝启动，恢复过去等于自锁；
 * 3. 检测 daemon 是否在跑（daemon.lock 的 pid 存活）—— 运行中替换数据库文件会丢
 *    WAL 里未合并的写入，也可能让在跑进程继续写旧 inode；
 * 4. 覆盖前把当前库留底成 `backups/life-assistant-pre-restore-<时间戳>.db`，
 *    并把 WAL checkpoint 回主文件，保证留底完整。
 */

export interface RestoreOptions {
  /** 显式备份文件路径（与 latest 互斥） */
  file?: string;
  /** 取 backups 目录里最新的规范命名备份；未给 file 时是默认行为 */
  latest?: boolean;
  /** 只校验并打印计划，不写任何文件 */
  dryRun?: boolean;
  /** 固定时间戳/年龄判定，便于测试 */
  nowMs?: number;
}

export interface RestoreResult {
  /** 实际使用的备份文件 */
  target: string;
  /** 备份文件的 schema 版本（<= 程序支持版本） */
  schemaVersion: number;
  /** 当前库的留底文件；当前库不存在或 dry-run 时为 null */
  preRestoreBackup: string | null;
  dryRun: boolean;
}

/** 选择要恢复的备份文件：显式路径优先，否则取 backups 下最新一份规范命名备份 */
export function resolveRestoreTarget(config: ResolvedConfig, opts: RestoreOptions): string {
  if (opts.file !== undefined && opts.file.trim() !== "") {
    if (opts.latest === true) throw new Error("--file 与 --latest 不能同时使用");
    return resolve(opts.file.trim());
  }
  const status = backupStatus(config, opts.nowMs ?? Date.now());
  if (status.latest === null) {
    throw new Error(
      `没有可用备份：${status.dir} 下没有规范命名的 life-assistant-<时间戳>.db（可先 npm run db:backup 生成，或用 --file 指定文件）`,
    );
  }
  return status.latest.path;
}

/** 把当前库的 WAL 并回主文件，保证随后复制到的主文件包含最近写入 */
function checkpointCurrentDatabase(dbPath: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (e) {
    // 当前库可能本来就损坏/不可写 —— 恢复正是为了处理这种情况，不能因此中止；
    // 但要在输出里说清楚留底可能缺 WAL 里的最新写入。
    logger.warn(
      `当前库 WAL checkpoint 失败，留底可能缺少 WAL 中未合并的写入：${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  } finally {
    if (db?.isOpen) db.close();
  }
}

/** 留底文件名去重：同一秒内执行两次恢复时不覆盖上一份现场 */
function uniquePath(path: string): string {
  if (!existsSync(path)) return path;
  const base = path.endsWith(".db") ? path.slice(0, -3) : path;
  for (let i = 1; i < 100; i += 1) {
    const candidate = `${base}-${i}.db`;
    if (!existsSync(candidate)) return candidate;
  }
  throw new Error(`无法生成不冲突的恢复前备份名: ${path}`);
}

function restoreFileMode(path: string): void {
  try {
    chmodSync(path, 0o600);
  } catch (e) {
    logger.warn(
      `恢复后收紧数据库权限失败: ${path}（${e instanceof Error ? e.message : String(e)}）`,
    );
  }
}

/**
 * 执行恢复。所有「拒绝恢复」都抛中文错误，且保证在此之前没有改动当前库；
 * 覆盖之后若重新校验失败，会尽量用留底文件回滚（回滚失败也如实报出，并保留留底路径）。
 */
export function runRestore(config: ResolvedConfig, opts: RestoreOptions = {}): RestoreResult {
  const dryRun = opts.dryRun === true;
  const nowMs = opts.nowMs ?? Date.now();

  // 1. 解析目标：--latest 只看规范命名，避免把迁移前快照/坏文件当成最新备份
  const target = resolveRestoreTarget(config, opts);
  if (!existsSync(target)) throw new Error(`备份文件不存在: ${target}`);
  if (!statSync(target).isFile()) throw new Error(`备份不是普通文件: ${target}`);

  // 2. 校验备份：quick_check + schema 版本可读 + 不高于程序支持版本
  let schemaVersion: number;
  try {
    schemaVersion = verifyDatabaseFile(target);
  } catch (e) {
    throw new Error(
      `备份校验失败，拒绝恢复（当前库未改动）: ${target}：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `备份的 schema 版本 v${schemaVersion} 高于程序支持的 v${SCHEMA_VERSION}，拒绝恢复：请先升级程序，否则恢复后 daemon 会拒绝启动`,
    );
  }

  // 3. dry-run 只读：只解析 + 校验并打印计划，不碰主库，因此不要求停服
  //    （只读 SQLite 打开备份文件不会影响正在运行的 daemon）。
  if (dryRun) {
    return { target, schemaVersion, preRestoreBackup: null, dryRun: true };
  }

  // 4. 真正恢复时 daemon 必须停服：运行中替换主库会丢 WAL 写入、并让在跑进程写旧 inode
  const lockState = isDaemonLocked(config.dataDir);
  if (lockState.locked) {
    throw new Error(
      `检测到 daemon 正在运行（pid=${lockState.pid ?? "未知"}，锁文件 ${daemonLockPath(config.dataDir)}），拒绝恢复。` +
        "请先停止 daemon（如 systemctl stop life-assistant）再重试",
    );
  }

  // 5. 当前库留底：先 checkpoint 再复制主文件（WAL 里的写入才算完整现场）
  mkdirSync(config.backupDir, { recursive: true });
  const stamp = DateTime.fromMillis(nowMs, { zone: TZ }).toFormat("yyyyMMdd-HHmmss");
  let preRestoreBackup: string | null = null;
  if (existsSync(config.dbPath)) {
    checkpointCurrentDatabase(config.dbPath);
    preRestoreBackup = uniquePath(
      resolve(config.backupDir, `life-assistant-pre-restore-${stamp}.db`),
    );
    copyFileSync(config.dbPath, preRestoreBackup);
    restoreFileMode(preRestoreBackup);
  }

  // 6. 覆盖主库并清掉 WAL/SHM：旧 WAL 属于旧库，留着会让新库读到不属于它的页
  copyFileSync(target, config.dbPath);
  for (const suffix of ["-wal", "-shm"]) {
    rmSync(`${config.dbPath}${suffix}`, { force: true });
  }

  // 7. 重新打开校验（quick_check + schema），失败就用留底回滚
  try {
    const restoredVersion = verifyDatabaseFile(config.dbPath);
    if (restoredVersion !== schemaVersion) {
      throw new Error(
        `恢复后 schema 版本 (${restoredVersion}) 与备份校验结果 (${schemaVersion}) 不一致`,
      );
    }
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    if (preRestoreBackup === null) {
      throw new Error(`恢复后校验失败：${reason}（当前库原本不存在，没有可回滚的留底）`);
    }
    try {
      copyFileSync(preRestoreBackup, config.dbPath);
      for (const suffix of ["-wal", "-shm"]) {
        rmSync(`${config.dbPath}${suffix}`, { force: true });
      }
    } catch (rollbackError) {
      throw new Error(
        `恢复后校验失败（${reason}），且回滚也失败（${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }）：请手工从 ${preRestoreBackup} 恢复`,
      );
    }
    throw new Error(`恢复后校验失败（${reason}），已用留底回滚当前库: ${preRestoreBackup}`);
  }
  restoreFileMode(config.dbPath);

  logger.info(`数据库已从备份恢复: ${target}（schema v${schemaVersion}）`);
  return { target, schemaVersion, preRestoreBackup, dryRun: false };
}

interface CliArgs {
  file?: string;
  latest: boolean;
  dryRun: boolean;
  dataDir?: string;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { latest: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    switch (arg) {
      case "--file": {
        const value = argv[i + 1];
        if (value === undefined || value === "") throw new Error("--file 需要一个备份文件路径");
        args.file = value;
        i += 1;
        break;
      }
      case "--latest":
        args.latest = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--data-dir": {
        const value = argv[i + 1];
        if (value === undefined || value === "") throw new Error("--data-dir 需要一个目录路径");
        args.dataDir = value;
        i += 1;
        break;
      }
      default:
        throw new Error(
          `未知参数: ${arg}（可用：--file <path>、--latest、--dry-run、--data-dir <path>）`,
        );
    }
  }
  if (args.file !== undefined && args.latest) {
    throw new Error("--file 与 --latest 不能同时使用");
  }
  return args;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  // 与 src/backup.ts 同口径：--data-dir 覆盖 env 的 DATA_DIR，其余配置照常从 .env 读
  const env = { ...process.env };
  if (args.dataDir !== undefined) env.DATA_DIR = args.dataDir;
  const config = loadConfig(env);

  const result = runRestore(config, {
    file: args.file,
    latest: args.latest,
    dryRun: args.dryRun,
  });

  console.log("Life Assistant 数据库恢复\n");
  console.log(`数据目录：${config.dataDir}`);
  console.log(`备份文件：${result.target}（schema v${result.schemaVersion}）`);
  console.log("校验通过：quick_check ok，schema 版本不高于程序支持版本");
  if (result.dryRun) {
    console.log("\n（--dry-run：以下操作不会真正执行）");
    console.log(`将把当前库留底到：${config.backupDir}/life-assistant-pre-restore-<时间戳>.db`);
    console.log(`将用备份覆盖：${config.dbPath}`);
    console.log("将删除 -wal/-shm，并重新校验 quick_check + schema，最后把权限收紧到 600。");
    return;
  }
  if (result.preRestoreBackup !== null) {
    console.log(`恢复前当前库已留底：${result.preRestoreBackup}`);
  } else {
    console.log("恢复前当前库不存在，未生成留底文件。");
  }
  console.log("恢复完成。请启动 daemon 并打开状态页确认：systemctl start life-assistant");
}

const isDirectRun = /restore\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) {
  try {
    main();
  } catch (e) {
    console.error(`恢复失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
