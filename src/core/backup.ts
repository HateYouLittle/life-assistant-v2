import { randomUUID } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  type Stats,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import type { ResolvedConfig } from "../config.js";
import { TZ } from "../time.js";
import { logger } from "./logger.js";

/** BACKUP_KEEP 的缺省保留份数（与 README/旧 CLI 行为一致） */
export const DEFAULT_BACKUP_KEEP = 14;

/** 规范化备份文件名：`life-assistant-<yyyyMMdd-HHmmss>.db`（Asia/Shanghai 本地时间） */
const FILE_RE = /^life-assistant-\d{8}-\d{6}\.db$/;

/**
 * 半截备份产物：`life-assistant-<yyyyMMdd-HHmmss>.db.partial-<pid>-<随机串>`。
 *
 * 备份不再直接写规范文件名，而是先写这个临时名、自校验通过后再 rename 成规范名
 * （原子发布）。进程在 VACUUM INTO 期间被杀（SIGKILL/断电/磁盘满）只会留下一个
 * `.partial-*` 垃圾，绝不会出现「规范命名的半截库」被 `--latest` 选中、被监控当成
 * 「刚备份成功」。随机串保证并发备份（CLI + daemon）不会共用同一个临时文件。
 */
const PARTIAL_RE = /^life-assistant-\d{8}-\d{6}\.db\.partial-\d+-[0-9a-f]+$/;

/** 残留半截备份的清理年龄：可能还有进程正在写，1 小时内的不动 */
const PARTIAL_STALE_MS = 60 * 60 * 1000;

/** 超过这个时长没有新备份即视为过期（内置 job 每日一次，36h 能容忍一次错过/延迟） */
export const BACKUP_STALE_HOURS = 36;

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

/** 一份备份文件的体检结果（供备份状态展示 / 恢复 CLI 选目标） */
export interface BackupFileInfo {
  name: string;
  path: string;
  mtimeMs: number;
  sizeBytes: number;
  /** 是否符合规范命名（`life-assistant-<时间戳>.db`） */
  canonical: boolean;
}

export interface BackupStatusOptions {
  /**
   * 是否校验 `latest` 的完整性（quick_check + schema 可读）。默认 false：
   * 状态页/`/metrics` 高频调用不做 DB 打开；`doctor --live` 这类手动检查才需要，
   * 否则「最新备份其实是坏文件」会被 mtime 判成新鲜健康（P1-4）。
   */
  verifyLatest?: boolean;
}

export interface BackupStatus {
  dir: string;
  /** 目录下所有 `*.db`（规范与非规范都在，canonical 标记区分） */
  files: BackupFileInfo[];
  /** 最新一份规范备份（按 mtime）；没有则为 null */
  latest: BackupFileInfo | null;
  /** latest 距今小时数；没有备份为 null */
  ageHours: number | null;
  /** 无备份、最新备份超过 BACKUP_STALE_HOURS，或（请求校验时）latest 校验失败 */
  stale: boolean;
  /**
   * `latest` 是否通过完整性校验；未请求校验（默认）为 null。
   * false 表示「最新备份打不开/损坏」——此时 stale 也置 true，不能再报「备份新鲜健康」。
   */
  latestVerified: boolean | null;
  /** 不符合规范命名的 `*.db`（迁移前快照、恢复留底、手工拷贝等） */
  nonCanonical: string[];
}

/**
 * 校验一个 SQLite 文件是不是可用的 Life Assistant 库：`quick_check` 必须 ok，
 * 且能读到 `meta.schema_version`。返回 schema 版本号，失败抛中文错误。
 *
 * 备份生成后、恢复前都走这里 —— 一份「打不开/缺 meta 表」的文件绝不能冒充可用数据。
 * 只读打开：校验动作不修改文件，也不会在旁边留下 -wal/-shm。
 */
export function verifyDatabaseFile(path: string): number {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    const integrity = db.prepare("PRAGMA quick_check").get() as
      | { quick_check?: string }
      | undefined;
    const result = integrity?.quick_check;
    if (result !== "ok") {
      throw new Error(`完整性检查未通过（quick_check: ${result ?? "无结果"}）`);
    }
    const row = readSchemaVersionRow(db);
    const version = row === undefined ? Number.NaN : Number(row.value);
    if (!Number.isInteger(version) || version < 1) {
      throw new Error(`读不到合法的 meta.schema_version（当前值: ${row?.value ?? "缺失"}）`);
    }
    return version;
  } finally {
    if (db?.isOpen) db.close();
  }
}

/** 读 meta.schema_version；缺表/损坏统一转成中文错误，恢复 CLI 的输出才解释得清 */
function readSchemaVersionRow(db: DatabaseSync): { value: string } | undefined {
  try {
    return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined;
  } catch (e) {
    throw new Error(
      `读不到 meta.schema_version（可能不是 Life Assistant 数据库）: ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/**
 * 生成一份 SQLite 备份（VACUUM INTO）并清理超出保留份数的旧备份，返回备份文件路径。
 * 数据库文件不存在时抛 MissingDatabaseError —— sqlite 打开不存在的路径会顺手建一个
 * 空库，从而「成功」产出一份空备份。
 *
 * 生成后立即自校验：VACUUM INTO 也可能因磁盘满/权限/IO 错误产出半截文件，
 * 而「坏备份冒充可用」比「没有备份」更危险（用户以为有后路，恢复时才发现没有）。
 *
 * 关键：产物先写唯一临时名 `<target>.partial-<pid>-<随机>`，校验通过后 rename 成
 * 规范名（原子发布）。旧实现直接写规范名、失败才删——若进程在 VACUUM INTO 期间被
 * SIGKILL/断电/磁盘满打断，「删」那一步永远不执行，规范名下就留下一个半截库，
 * `--latest` 会一直选中它并拒绝恢复（P1-4）。
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
  // 先写唯一临时名，校验通过再 rename 成规范名：被打断只留 .partial，不留「规范名坏备份」。
  const partial = `${target}.partial-${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    const db = new DatabaseSync(config.dbPath);
    try {
      // daemon 运行中备份时，主连接可能正处于写事务：默认 busy_timeout=0 会让
      // VACUUM INTO 立刻 SQLITE_BUSY，把一次正常备份误报成失败。与主库一致的 5s
      // 等待窗口足够跨过一次短暂写入，又不会在库被长时间占用时无限阻塞。
      db.exec("PRAGMA busy_timeout = 5000");
      db.prepare("VACUUM INTO ?").run(partial);
    } finally {
      db.close();
    }
    try {
      verifyDatabaseFile(partial);
    } catch (e) {
      throw new Error(
        `备份自校验失败，已删除半截产物: ${partial}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
    publishBackupFile(partial, target);
  } catch (e) {
    // 任何失败都不留半截文件（删不掉也要让原始错误暴露，不能被清理错误掩盖）
    try {
      unlinkSync(partial);
    } catch {
      // 文件可能根本没创建成功
    }
    throw e;
  }
  prune(config.backupDir, keep, nowMs);
  return target;
}

/**
 * 把校验通过的临时备份发布成规范文件名。
 *
 * 用 `link` 而不是 `rename`：同一目录内 link 是原子的，且目标已存在时返回 EEXIST
 * （rename 在 POSIX 上会静默覆盖）。这保留了「同名备份拒绝覆盖」的既有契约 ——
 * 两个备份进程撞在同一秒时，后者必须报错，而不是悄悄覆盖前者的快照
 * （复审 T-1027-02b 指出 rename 把契约改没了）。
 *
 * 前提：`partialPath` 与 `targetPath` 必须在**同一个文件系统**上（本函数只用于
 * `runBackup` 的 `<backupDir>/<name>.partial-*` → `<backupDir>/<name>`，天然满足）。
 * 若将来允许临时目录与 BACKUP_DIR 跨挂载点，link 会报 EXDEV，需要退回
 * copy + rename 的发布方式并重新考虑「同名不覆盖」语义（复审 T-1027-02b 观察 1）。
 */
export function publishBackupFile(partialPath: string, targetPath: string): void {
  try {
    linkSync(partialPath, targetPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`备份已存在，拒绝覆盖: ${targetPath}`);
    }
    throw e;
  }
  try {
    unlinkSync(partialPath);
  } catch (e) {
    // 发布已经成功，临时文件删不掉只是多占一点磁盘，交给 prune 的残留清理
    logger.warn(`清理备份临时文件失败: ${partialPath} ${e instanceof Error ? e.message : e}`);
  }
}

function prune(dir: string, keep: number, nowMs: number = Date.now()): void {
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
  // 清理被 kill 打断的备份留下的 .partial-*：1 小时内的可能还有进程在写，不动。
  for (const name of readdirSync(dir)) {
    if (!PARTIAL_RE.test(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path, { throwIfNoEntry: false });
    if (stat === undefined) continue;
    if (nowMs - stat.mtimeMs < PARTIAL_STALE_MS) continue;
    try {
      unlinkSync(path);
      logger.info(`已清理残留的半截备份: ${name}`);
    } catch (e) {
      logger.warn(`清理半截备份失败: ${name} ${e instanceof Error ? e.message : e}`);
    }
  }
}

/**
 * 备份目录状态（只读）：最新规范备份、年龄、是否过期、以及不符合规范命名的文件。
 *
 * 为什么需要「非规范文件」清单：迁移前快照（`life-assistant-pre-v3-*`）、恢复留底
 * （`*-pre-restore-*`）、手工拷贝（`zombie-*.db`）都可能长期堆在 backups 里。
 * 它们占据磁盘、让人误以为备份更多，而恢复 CLI 的 `--latest` 只认规范命名。
 * 这里把口径亮出来，由 doctor/状态页展示（Lead 接线）。
 */
export function backupStatus(
  config: ResolvedConfig,
  nowMs: number = Date.now(),
  opts: BackupStatusOptions = {},
): BackupStatus {
  let names: string[];
  try {
    names = readdirSync(config.backupDir).filter((name) => name.endsWith(".db"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.warn(
        `读取备份目录失败: ${config.backupDir} ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    return {
      dir: config.backupDir,
      files: [],
      latest: null,
      ageHours: null,
      stale: true,
      latestVerified: null,
      nonCanonical: [],
    };
  }

  // 规范文件名里就是时间戳，字典序即新旧；file 列表保持这个顺序便于人读
  const files: BackupFileInfo[] = names.sort().map((name) => {
    const path = join(config.backupDir, name);
    let stat: Stats | undefined;
    try {
      stat = statSync(path);
    } catch {
      // 列目录与 stat 之间被删（或断链）不该让整个状态查询失败
      stat = undefined;
    }
    return {
      name,
      path,
      mtimeMs: stat?.mtimeMs ?? 0,
      sizeBytes: stat?.size ?? 0,
      canonical: FILE_RE.test(name),
    };
  });

  const canonical = files.filter((file) => file.canonical);
  // 用 mtime 而不是文件名挑最新：迁移前快照/恢复留底可能被复制过，mtime 更贴近「实际生成时间」
  let latest: BackupFileInfo | null = null;
  for (const file of canonical) {
    if (latest === null || file.mtimeMs > latest.mtimeMs) latest = file;
  }
  const ageHours = latest === null ? null : Math.max(0, (nowMs - latest.mtimeMs) / 3_600_000);
  // 只在被要求时打开数据库校验：坏备份的 mtime 往往很新，只看 mtime 会得出
  // 「备份新鲜健康」的相反结论（P1-4）。校验失败时 stale 必须为 true。
  let latestVerified: boolean | null = null;
  if (opts.verifyLatest === true && latest !== null) {
    try {
      verifyDatabaseFile(latest.path);
      latestVerified = true;
    } catch (e) {
      latestVerified = false;
      logger.warn(
        `最新备份校验失败（${latest.path}）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return {
    dir: config.backupDir,
    files,
    latest,
    ageHours,
    stale: ageHours === null || ageHours > BACKUP_STALE_HOURS || latestVerified === false,
    latestVerified,
    nonCanonical: files.filter((file) => !file.canonical).map((file) => file.name),
  };
}
