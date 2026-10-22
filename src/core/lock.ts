import { randomUUID } from "node:crypto";
import {
  closeSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
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
 * 创建：先把完整内容写进唯一临时文件，再 `linkSync(tmp, path)` 硬链接到锁文件路径 ——
 * 链接失败（EEXIST）即「已存在」，成功即「原子出现且内容完整」。为什么不能
 * `open(path,"wx")` 后 write：那会留下「文件已存在但内容还没写进去」的窗口，并发的接管者
 * 会把它当成损坏锁 rename 走，随后双方各持一把锁（Round1 审查 C2 实测复现）。
 *
 * 接管：锁文件已存在且 pid 已死/内容损坏时走**原子接管**（见 takeOverStaleLock）。
 * 崩溃残留的锁文件靠 PID 存活检测判定为 stale 并接管；release 只在 pid 仍是自己时才删除，
 * 避免误删别人刚接管的锁。
 */

export const DAEMON_LOCK_FILENAME = "daemon.lock";

/** 锁文件内容；hostname 只是排障线索（NFS/容器共享数据目录时能看出是哪个主机占的锁） */
interface LockFileContent {
  pid: number;
  startedAt: string;
  hostname: string;
}

/**
 * 读锁文件的四种结果：区分「不存在」「存在但读不了」「存在但不合法」很重要 ——
 * 抢锁时三者都按 stale 接管；恢复 CLI 则必须把后两种当成「无法确认 daemon 已停」拒绝执行。
 */
type LockFileSnapshot =
  | { kind: "missing" }
  | { kind: "unreadable" }
  | { kind: "invalid" }
  | { kind: "ok"; value: LockFileContent };

/**
 * daemon 锁的当前状态（供恢复 CLI / doctor 等只读判定用）：
 * - `unlocked`：没有锁文件；
 * - `locked`：锁文件里的 pid 仍存活（同机确实有实例在跑）；
 * - `stale`：锁文件合法但 pid 已退出（崩溃残留，可安全接管/恢复）；
 * - `corrupt`：锁文件存在但读不到或不合法 —— **无法判断**有没有实例在跑。
 */
export type DaemonLockState =
  | { state: "unlocked" }
  | { state: "locked"; pid: number }
  | { state: "stale"; pid?: number }
  | { state: "corrupt" };

export interface DaemonLock {
  /** 锁文件绝对路径 */
  path: string;
  /** 释放：仅当锁文件里的 pid 仍是当前进程时才删除 */
  release(): void;
}

/**
 * 原子接管的最大轮次：每轮都会重新读锁并尝试抢占。
 * 正常并发启动一轮内就会收敛（赢家创建成功后输家读到活 pid 立即报 duplicate），
 * 有界循环只用于兜住「rename 时旧锁恰好被别人接管/释放」的竞态，避免死循环。
 */
const MAX_TAKEOVER_ATTEMPTS = 10;

/** 接管时旧锁的临时名字前缀：`daemon.lock.stale-<pid>-<uuid>` */
const STALE_LOCK_SUFFIX = ".stale-";

/** 创建锁时的内容暂存前缀：`daemon.lock.tmp-<pid>-<uuid>`（写完整内容后再 link 到锁路径） */
const TEMP_LOCK_SUFFIX = ".tmp-";

/**
 * 清理锁目录里的崩溃残留（只删 pid 已死的）：
 * - `.tmp-*`：创建锁时写内容用的暂存文件（link 后 / 崩溃前没删掉）；
 * - `.stale-*`：接管旧锁时 rename 出来的副本（rename 后 / 清理前进程被杀）。
 * 两种临时文件都带创建者 pid，只需判断该 pid 是否还活着；活着的进程的临时文件
 * 可能正被它使用，绝不能删。
 */
function cleanupLockResidues(path: string): void {
  const dir = dirname(path);
  const prefixes = [
    `${basename(path)}${TEMP_LOCK_SUFFIX}`,
    `${basename(path)}${STALE_LOCK_SUFFIX}`,
  ];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const prefix = prefixes.find((candidate) => name.startsWith(candidate));
    if (prefix === undefined) continue;
    const pidText = name.slice(prefix.length).split("-")[0] ?? "";
    const pid = Number(pidText);
    if (Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)) continue;
    removeFileQuietly(join(dir, name), "清理锁残留文件");
  }
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

function parseLockContent(raw: string): LockFileContent | undefined {
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

/**
 * 读锁文件快照。内容损坏（被截断/手改/JSON 非法）与读取失败都单独区分出来 ——
 * 调用方按自己的安全口径处理：抢锁视为 stale 接管，恢复 CLI 视为「无法确认」拒绝。
 */
function readLockFileSnapshot(path: string): LockFileSnapshot {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOENT/ENOTDIR：按「不存在」处理（dataDir 本身不存在时同样不属于损坏）
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "missing" } : { kind: "unreadable" };
  }
  const parsed = parseLockContent(raw);
  return parsed === undefined ? { kind: "invalid" } : { kind: "ok", value: parsed };
}

/** 读锁文件，内容损坏/不存在统一返回 undefined（抢锁/释放路径用） */
function readLockFile(path: string): LockFileContent | undefined {
  const snapshot = readLockFileSnapshot(path);
  return snapshot.kind === "ok" ? snapshot.value : undefined;
}

/**
 * 原子创建锁文件；已存在返回 false（调用方据此走「检查现有锁」分支）。
 *
 * 先写唯一临时文件再 `linkSync` 到锁路径：`link` 是原子的「不存在才出现」操作，
 * 且出现的那一刻内容已经完整 —— 不会给并发接管者看到「空锁文件」并把它当成损坏锁
 * rename 走（那会导致双方都认为自己持锁）。临时文件无论成败都删除。
 */
function tryCreateLockFile(path: string, content: LockFileContent): boolean {
  const tmpPath = `${path}${TEMP_LOCK_SUFFIX}${process.pid}-${randomUUID()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(content)}\n`, { mode: 0o600, flag: "wx" });
    try {
      linkSync(tmpPath, path);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") return false;
      // 极少数文件系统不支持硬链接：退回 O_EXCL 创建（失去「内容完整才出现」的保证，
      // 但 DATA_DIR 正常在本地文件系统上，硬链接可用；这里只保证不会因 link 失败而启动不了）
      if (code === "EPERM" || code === "EXDEV" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
        return fallbackCreateLockFile(path, content);
      }
      throw e;
    }
  } finally {
    removeFileQuietly(tmpPath, "清理锁暂存文件");
  }
}

/** 兼容不支持 link 的文件系统：O_EXCL 直接创建（与旧实现等价） */
function fallbackCreateLockFile(path: string, content: LockFileContent): boolean {
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

/** 尽力删除文件（清理 `.stale-*` 副本 / 恢复失败后的残留），绝不抛错 */
function removeFileQuietly(path: string, context: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        `${context}：删除临时文件失败 ${path}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
  }
}

/**
 * 把「被误 rename 走的锁文件」尽量放回原位。
 *
 * 用 `linkSync` 而不是 `renameSync`：link 在目标已存在时返回 EEXIST、**不会覆盖**
 * 另一个进程刚建好的活锁；`renameSync` 会直接覆盖，等于又制造一次锁丢失。
 * 放不回去（原位已被新锁占用）时只清理副本：副本里的进程仍会按 pid 校验 release，
 * 不会误删新锁。
 */
function restoreMovedLockFile(stalePath: string, path: string): void {
  try {
    linkSync(stalePath, path);
    unlinkSync(stalePath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // 原位已被第三者创建的新锁占用：不能覆盖（否则又抢一次），只能丢弃误移副本。
      // 这时被误移的进程虽然还活着，但它的锁文件已被新锁取代 —— 必须留一条 warn 便于排查。
      logger.warn(
        `daemon 锁原位已被新锁占用，丢弃被误移动的锁副本（该副本对应进程仍可能存活）: ${stalePath}`,
      );
    } else {
      logger.warn(
        `恢复被误移动的 daemon 锁失败: ${stalePath} -> ${path}（${
          e instanceof Error ? e.message : String(e)
        }）`,
      );
    }
    removeFileQuietly(stalePath, "清理接管残留");
  }
}

function duplicateDaemonError(existing: LockFileContent, path: string): Error {
  return new Error(
    `另一个 daemon 已在运行（pid=${existing.pid}，启动于 ${existing.startedAt}，锁文件 ${path}）`,
  );
}

/**
 * 原子接管失效/损坏的锁文件。
 *
 * 返回 `{ acquired: false }`：本轮没拿到接管权（旧锁已被别的进程接管/释放，或我们误拿了一把
 * 活锁并已放回），调用方应重试整个获取循环；返回 `{ acquired: true }` 表示旧锁已被移走，
 * 由调用方创建新锁（可能被第三者抢先）。
 *
 * 实现要点：`renameSync(path, stalePath)` 同一时刻只能有一个成功者（旧锁文件被移走），
 * 之后的竞争者 rename 会得到 ENOENT；但 rename 本身不校验「移走的是不是我刚检查过的那把锁」，
 * 所以必须再校验两步：
 * 1. inode 身份：`before`（rename 前 stat）与 `after`（rename 后 stat stalePath）的 dev/ino
 *    必须一致 —— 否则说明 read 与 rename 之间锁被别的进程换掉了；
 * 2. 内容身份：移走的锁若仍指向**存活**进程，说明我们误拿了别人刚建好的活锁，必须放回原位，
 *    绝不能当成 stale 继续抢。
 */
function takeOverStaleLock(path: string): { acquired: boolean; moved?: LockFileContent } {
  const stalePath = `${path}${STALE_LOCK_SUFFIX}${process.pid}-${randomUUID()}`;
  const before = statSync(path, { throwIfNoEntry: false });
  try {
    renameSync(path, stalePath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      // 旧锁在 read → rename 之间已被别的进程接管/释放：重试整个获取循环
      return { acquired: false };
    }
    throw e;
  }
  const after = statSync(stalePath, { throwIfNoEntry: false });
  const sameFile =
    before !== undefined &&
    after !== undefined &&
    before.ino === after.ino &&
    before.dev === after.dev;
  const movedSnapshot = readLockFileSnapshot(stalePath);
  const moved = movedSnapshot.kind === "ok" ? movedSnapshot.value : undefined;
  if (!sameFile || (moved !== undefined && isProcessAlive(moved.pid))) {
    // 拿到的不是刚才判断为 stale 的那把锁（可能是别的进程刚建好的活锁）：放回原位并重试/报错
    restoreMovedLockFile(stalePath, path);
    return { acquired: false, moved };
  }
  // 确认接管的就是失效锁：清理旧副本，把创建新锁的机会留给调用方（可能被第三者抢先）
  removeFileQuietly(stalePath, "清理旧锁副本");
  return { acquired: true, moved };
}

/**
 * 抢占单实例锁；成功返回可 release 的句柄，失败抛中文错误（包含活着的那只 daemon 的
 * pid/启动时间/锁路径，用户据此能直接 `kill`/`systemctl stop`）。
 *
 * 快速路径 O_CREAT|O_EXCL 原子创建；已存在时：
 * - 活 pid → 明确 duplicate 错误；
 * - 死 pid / 内容损坏 / 读取失败 → 原子接管（rename 抢占 + 身份/内容校验），抢到后创建新锁；
 *   创建失败的窗口（旧锁刚移走、别人抢先创建）重读后再决定 duplicate 或继续重试。
 */
export function acquireDaemonLock(dataDir: string): DaemonLock {
  // daemon 正常路径会先建 dataDir；这里再兜一次，避免「目录还没建」被表现成锁获取失败
  mkdirSync(dataDir, { recursive: true });
  const path = daemonLockPath(dataDir);
  // 上次进程在「写完暂存文件/link 之前」或「rename 接管后清理之前」崩溃留下的垃圾：
  // 顺手清理（只删已死 pid 的）。
  cleanupLockResidues(path);
  const self: LockFileContent = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: hostname(),
  };
  /** 已接管的失效锁信息，仅用于成功后的 warn 文案 */
  let takeoverFrom: LockFileContent | undefined;
  let takeoverFromCorrupt = false;

  const logTakeover = (): void => {
    if (takeoverFrom !== undefined) {
      logger.warn(
        `接管已失效的 daemon 锁：pid=${takeoverFrom.pid}（启动于 ${takeoverFrom.startedAt}）已不存在，锁文件 ${path}`,
      );
    } else if (takeoverFromCorrupt) {
      logger.warn(`daemon 锁文件内容缺失或损坏，接管并重写: ${path}`);
    }
  };

  for (let attempt = 0; attempt < MAX_TAKEOVER_ATTEMPTS; attempt += 1) {
    if (tryCreateLockFile(path, self)) {
      logTakeover();
      return { path, release: () => releaseDaemonLock(path) };
    }

    const snapshot = readLockFileSnapshot(path);
    if (snapshot.kind === "ok" && isProcessAlive(snapshot.value.pid)) {
      throw duplicateDaemonError(snapshot.value, path);
    }

    // 死 pid / 损坏 / 读不了：尝试原子接管
    const takeover = takeOverStaleLock(path);
    if (takeover.moved !== undefined && isProcessAlive(takeover.moved.pid)) {
      // 误拿了别的进程刚建好的活锁：已尽力放回原位，按「已有实例」报错
      throw duplicateDaemonError(takeover.moved, path);
    }
    if (!takeover.acquired) continue;
    if (takeover.moved !== undefined) takeoverFrom = takeover.moved;
    else takeoverFromCorrupt = true;

    if (tryCreateLockFile(path, self)) {
      logTakeover();
      return { path, release: () => releaseDaemonLock(path) };
    }
    // 旧锁移走与创建之间有别的进程抢先创建了新锁：读它决定 duplicate / 继续
    const raced = readLockFileSnapshot(path);
    if (raced.kind === "ok" && isProcessAlive(raced.value.pid)) {
      throw duplicateDaemonError(raced.value, path);
    }
    // raced 也是失效/损坏（极端并发）：继续下一轮，有界循环兜底
  }
  throw new Error(
    `接管 daemon 锁失败（并发竞争在 ${MAX_TAKEOVER_ATTEMPTS} 轮内未收敛，锁文件 ${path}）`,
  );
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
 * 锁文件状态（只读、不修改任何文件）。区分 `stale`（pid 已退出，可安全接管/恢复）与
 * `corrupt`（存在但读不懂，无法判断是否有实例在跑）—— 需要安全默认值相反的调用方
 * （如 `db:restore` 覆盖数据库前）必须用这个，而不是只看 `locked`。
 */
export function inspectDaemonLock(dataDir: string): DaemonLockState {
  const snapshot = readLockFileSnapshot(daemonLockPath(dataDir));
  switch (snapshot.kind) {
    case "missing":
      return { state: "unlocked" };
    case "unreadable":
    case "invalid":
      return { state: "corrupt" };
    case "ok":
      return isProcessAlive(snapshot.value.pid)
        ? { state: "locked", pid: snapshot.value.pid }
        : { state: "stale", pid: snapshot.value.pid };
  }
}
