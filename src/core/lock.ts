import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { logger } from "./logger.js";

/**
 * 单实例锁：`$DATA_DIR/daemon.lock`。
 *
 * 为什么需要：SQLite 是单写者模型，同一 DATA_DIR 起两个 daemon 会让「同一份数据」被两个
 * 进程各持一个连接写 —— WAL 不会阻止这种双写，只会让 cron/outbox 重复执行、提醒重复推送；
 * 端口被占时旧实现甚至可能留下「启动失败但不退出」的僵尸实例（它的 20s drain 会把在跑
 * 实例正处于 sending 的投递复位重投）。锁文件把「同一数据目录只能有一个 daemon」变成
 * 启动期就能拒绝的硬约束，而不是等用户发现推送发了两遍。
 *
 * 锁用 openSync(path, "wx") 原子创建（O_CREAT|O_EXCL）：不存在才创建，天然避免
 * 「读-判断-写」的竞态。崩溃残留的锁文件靠 PID 存活检测判定为 stale 并接管；
 * 只在 pid 仍是自己时才删除，避免误删别人刚接管的锁。
 */

export const DAEMON_LOCK_FILENAME = "daemon.lock";

/** 锁文件内容；hostname 只是排障线索（NFS/容器共享数据目录时能看出是哪个主机占的锁） */
interface LockFileContent {
  pid: number;
  startedAt: string;
  hostname: string;
}

export interface DaemonLock {
  /** 锁文件绝对路径 */
  path: string;
  /** 释放：仅当锁文件里的 pid 仍是当前进程时才删除 */
  release(): void;
}

/** 锁文件路径（doctor / 排障提示需要展示同一个位置，避免各写一份字符串） */
export function daemonLockPath(dataDir: string): string {
  return join(dataDir, DAEMON_LOCK_FILENAME);
}

/**
 * PID 是否存活。`process.kill(pid, 0)` 只做权限/存在性探测、不真的发信号：
 * - 成功 → 进程存在；
 * - ESRCH → 不存在（stale 锁）；
 * - EPERM → 进程存在但属于别的用户（也算存活，绝不能接管正在跑的 daemon 的锁）。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * 读锁文件。内容损坏（被截断/手改/JSON 非法）返回 undefined —— 调用方按 stale 处理，
 * 而不是因为读不懂就永远拒绝启动。
 */
function readLockFile(path: string): LockFileContent | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const pid = record.pid;
  const startedAt = record.startedAt;
  const host = record.hostname;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof startedAt !== "string" || startedAt === "") return undefined;
  if (typeof host !== "string") return undefined;
  return { pid, startedAt, hostname: host };
}

/** 原子创建锁文件；已存在返回 false（调用方据此走「检查现有锁」分支） */
function tryCreateLockFile(path: string, content: LockFileContent): boolean {
  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw e;
  }
  try {
    writeSync(fd, `${JSON.stringify(content)}\n`);
  } finally {
    closeSync(fd);
  }
  return true;
}

function duplicateDaemonError(existing: LockFileContent, path: string): Error {
  return new Error(
    `另一个 daemon 已在运行（pid=${existing.pid}，启动于 ${existing.startedAt}，锁文件 ${path}）`,
  );
}

/**
 * 抢占单实例锁；成功返回可 release 的句柄，失败抛中文错误（包含活着的那只 daemon 的
 * pid/启动时间/锁路径，用户据此能直接 `kill`/`systemctl stop`）。
 *
 * stale 接管：锁里的 pid 已不存在或文件损坏时，告警后 unlink 并重试创建一次。
 * 只重试一次而不是循环：两次之间又被别的进程抢到，说明确实有并发启动，应当报错
 * 而不是无限重试（无限重试会把「两个 daemon 同时启动」变成随机谁赢）。
 */
export function acquireDaemonLock(dataDir: string): DaemonLock {
  // daemon 正常路径会先建 dataDir；这里再兜一次，避免「目录还没建」被表现成锁获取失败
  mkdirSync(dataDir, { recursive: true });
  const path = daemonLockPath(dataDir);
  const self: LockFileContent = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
  };
  if (tryCreateLockFile(path, self)) {
    return { path, release: () => releaseDaemonLock(path) };
  }

  const existing = readLockFile(path);
  if (existing !== undefined && isProcessAlive(existing.pid)) {
    throw duplicateDaemonError(existing, path);
  }
  if (existing !== undefined) {
    logger.warn(
      `接管已失效的 daemon 锁：pid=${existing.pid}（启动于 ${existing.startedAt}）已不存在，锁文件 ${path}`,
    );
  } else {
    logger.warn(`daemon 锁文件内容缺失或损坏，接管并重写: ${path}`);
  }
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (tryCreateLockFile(path, self)) {
    return { path, release: () => releaseDaemonLock(path) };
  }
  // unlink 与创建之间被别的进程抢先：重新读一次，给出「确实有另一只在跑」的明确错误
  const raced = readLockFile(path);
  if (raced !== undefined && isProcessAlive(raced.pid)) {
    throw duplicateDaemonError(raced, path);
  }
  throw new Error(`接管 daemon 锁失败（锁文件被并发占用）: ${path}`);
}

/**
 * 释放锁。只在自己仍持有锁时删除：接管/被接管后旧进程退出时不能把新 daemon 的锁删掉，
 * 否则第二个实例又能起来（这正是双实例的入口）。
 */
function releaseDaemonLock(path: string): void {
  const existing = readLockFile(path);
  if (existing === undefined) return;
  if (existing.pid !== process.pid) {
    logger.debug(`锁文件 pid=${existing.pid} 不是当前进程，跳过释放: ${path}`);
    return;
  }
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(`释放 daemon 锁失败: ${path} ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * 供恢复 CLI / doctor 判断「现在能不能安全动数据库」：只有 pid 仍存活才算 locked。
 * 崩溃残留的锁文件不应该阻止恢复（否则用户必须先手工 rm 才能修库）。
 */
export function isDaemonLocked(dataDir: string): { locked: boolean; pid?: number } {
  const existing = readLockFile(daemonLockPath(dataDir));
  if (existing === undefined) return { locked: false };
  if (isProcessAlive(existing.pid)) return { locked: true, pid: existing.pid };
  return { locked: false, pid: existing.pid };
}
