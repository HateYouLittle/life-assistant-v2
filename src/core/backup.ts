import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import type { ResolvedConfig } from "../config.js";
import { TZ } from "../time.js";
import { logger } from "./logger.js";

/** BACKUP_KEEP 的缺省保留份数（与 README/旧 CLI 行为一致） */
export const DEFAULT_BACKUP_KEEP = 14;

const FILE_RE = /^life-assistant-\d{8}-\d{6}\.db$/;

/**
 * 数据库文件缺失时抛出的专用错误：daemon 的每日备份 job 据此把「DATA_DIR 指错/还没建库」
 * 降级成 warn 跳过，而不是当成备份故障报 error。CLI 仍按普通错误打印。
 */
export class MissingDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingDatabaseError";
  }
}

export interface BackupOptions {
  /** 保留最近多少份；缺省取 config.backupKeep，再缺省 14（兼容旧配置对象） */
  keep?: number;
}

/**
 * 生成一份 SQLite 备份（VACUUM INTO）并清理超出保留份数的旧备份，返回备份文件路径。
 * 数据库文件不存在时抛 MissingDatabaseError —— sqlite 打开不存在的路径会顺手建一个
 * 空库，从而「成功」产出一份空备份。
 */
export function runBackup(
  config: ResolvedConfig,
  nowMs: number = Date.now(),
  opts: BackupOptions = {},
): string {
  if (!existsSync(config.dbPath)) {
    throw new MissingDatabaseError(
      `数据库不存在，拒绝生成空备份: ${config.dbPath}（检查 DATA_DIR 是否指向真实数据目录）`,
    );
  }
  const keep = opts.keep ?? config.backupKeep ?? DEFAULT_BACKUP_KEEP;
  if (!Number.isInteger(keep) || keep < 1) {
    throw new Error(`备份保留份数必须是正整数: ${keep}`);
  }
  mkdirSync(config.backupDir, { recursive: true });
  // 用 Asia/Shanghai 本地时间打戳：项目其余部分统一本地时区，用 UTC 会让
  // 00:00–08:00 生成的备份被标成前一天，且与「保留最近 N 份」的字典序语义不一致。
  const stamp = DateTime.fromMillis(nowMs, { zone: TZ }).toFormat("yyyyMMdd-HHmmss");
  const target = join(config.backupDir, `life-assistant-${stamp}.db`);
  if (statSync(target, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`备份已存在，拒绝覆盖: ${target}`);
  }
  const db = new DatabaseSync(config.dbPath);
  try {
    // daemon 运行中备份时，主连接可能正处于写事务：默认 busy_timeout=0 会让
    // VACUUM INTO 立刻 SQLITE_BUSY，把一次正常备份误报成失败。与主库一致的 5s
    // 等待窗口足够跨过一次短暂写入，又不会在库被长时间占用时无限阻塞。
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  prune(config.backupDir, keep);
  return target;
}

function prune(dir: string, keep: number): void {
  const files = readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .reverse();
  for (const stale of files.slice(keep)) {
    try {
      unlinkSync(join(dir, stale));
      logger.info(`已清理旧备份: ${stale}`);
    } catch (e) {
      logger.warn(`清理旧备份失败: ${stale} ${e instanceof Error ? e.message : e}`);
    }
  }
}
