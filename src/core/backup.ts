import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
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

/**
 * 备份校验旁车（sidecar）：`<name>.db.verified`，内容 `{schemaVersion, verifiedAt, sizeBytes}`。
 *
 * 为什么需要：`backupStatus({verifyLatest:true})` 要打开备份库做 quick_check，状态页/
 * `/metrics` 这类高频调用承受不起；而只看 mtime 又会被「很新的坏备份」骗成健康。
 * 备份成功时把校验结果写在这里，读旁车即可零开库判断 `latestVerified`
 * （大小不一致/内容坏/缺失都按不可信处理）。深度校验仍以 `doctor --live` 开库为准。
 */
const VERIFIED_SUFFIX = ".verified";
/** 旁车的半截临时名：`<name>.db.verified.tmp-<pid>-<随机串>`（写完 rename 成 `<name>.db.verified`） */
const VERIFIED_TMP_SUFFIX = ".tmp-";
const VERIFIED_TMP_RE = /\.db\.verified\.tmp-\d+-[0-9a-f]+$/;

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
   * 是否判定 `latest` 的完整性：**先读旁车**（零开库），旁车缺失/内容坏/大小对不上时
   * 回退到开库现场校验（quick_check + schema 可读）。
   *
   * 为什么优先旁车：打开备份库做 quick_check 的成本随库增大而增加，状态页/`/metrics`
   * 这类高频调用承受不起；而只看 mtime 又会被「很新的坏备份」骗成健康（P1-4）。
   * 旁车只是「备份成功时自校验通过」的声明，**最终事实仍以开库为准** —— 需要真校验
   * 的调用方（`doctor --live`）请同时传 `deep: true`。
   */
  verifyLatest?: boolean;
  /**
   * 只读 `<latest>.verified` 旁车来判定 `latestVerified`（零开库，供状态页/`/metrics`）。
   * 旁车缺失/内容坏/大小对不上都按不可信（false）处理；与 verifyLatest 同时给出时，
   * verifyLatest 的「旁车优先 + 开库回退」语义优先。
   */
  sidecar?: boolean;
  /**
   * 强制打开备份库做现场校验，**不看旁车**。
   * `doctor --live` 用它兜住「旁车说好、实际库坏了」—— 旁车可能来自复制/篡改/磁盘坏块，
   * 只有 quick_check 才是可恢复性的最终事实。
   */
  deep?: boolean;
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
   * `latest` 是否通过完整性校验；未请求校验（默认）为 null，没有备份时也为 null。
   * true 可能来自旁车（备份成功时的自校验声明）或现场开库校验；
   * false 表示「最新备份不可信/打不开」——此时 stale 也置 true，不能再报「备份新鲜健康」。
   */
  latestVerified: boolean | null;
  /**
   * 旁车状态（只在请求了 `sidecar`/`verifyLatest` 时计算；默认 null）：
   * `trusted` 可信 / `untrusted` 存在但内容或大小/mtime/指纹不符 / `missing` 不存在。
   * `/metrics` 用它区分 2/1/0 三态，排障时能分清「没旁车」和「旁车不可信」。
   */
  sidecarState: BackupSidecarState | null;
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

/** 把 unknown 异常压成一行日志文本（清理失败只 warn，不能让日志变成 `[object Object]`） */
function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
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
  // 先写唯一临时名，校验通过再发布：被打断只留 .partial，不留「规范名坏备份」。
  // 临时名与最终名解耦后，同秒撞名可以换名重试（见下方 publish 循环，P2-13）。
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
    let schemaVersion: number;
    try {
      schemaVersion = verifyDatabaseFile(partial);
    } catch (e) {
      throw new Error(
        `备份自校验失败，已删除半截产物: ${partial}（${e instanceof Error ? e.message : String(e)}）`,
      );
    }
    // 同秒撞名（daemon 内置备份与手动 db:backup 恰好同一秒）不该让当次备份直接失败：
    // 规范名只精确到秒，冲突时顺延 1s 换名重试（最多 5 次）。文件内容仍是同一时刻的快照，
    // 名称差 1s 无害；比「这次没有备份、只留一条报错」好（P2-13）。
    let published: string | null = null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate =
        attempt === 0
          ? target
          : join(
              config.backupDir,
              `life-assistant-${DateTime.fromMillis(nowMs + attempt * 1000, { zone: TZ }).toFormat("yyyyMMdd-HHmmss")}.db`,
            );
      try {
        publishBackupFile(partial, candidate);
        published = candidate;
        break;
      } catch (e) {
        // 只对「目标已存在」重试；其它 IO 错误照常抛出
        if (!(e instanceof Error) || !e.message.includes("备份已存在，拒绝覆盖")) throw e;
      }
    }
    if (published === null) {
      throw new Error(
        `备份发布失败：同一秒及后 4 秒的规范名都已被占用（${config.backupDir}），请检查是否有异常频繁的备份进程`,
      );
    }
    writeVerifiedSidecar(published, schemaVersion, nowMs);
    prune(config.backupDir, keep, nowMs);
    return published;
  } catch (e) {
    // 任何失败都不留半截文件（删不掉也要让原始错误暴露，不能被清理错误掩盖）
    try {
      unlinkSync(partial);
    } catch {
      // 文件可能根本没创建成功
    }
    throw e;
  }
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
    logger.warn(`清理备份临时文件失败: ${partialPath} ${errorText(e)}`);
  }
}

/**
 * 备份文件的轻量指纹：首尾各 4KB 的 sha256。
 *
 * 为什么不是整文件哈希：备份是 MB 级、旁车在状态页/`/metrics` 路径上会被频繁读取；
 * 首尾各 4KB 足以识别「等长覆盖/旧备份拷回/半截写」，成本却是常数级。真正的内容完整性
 * 仍以 quick_check 开库校验为准（`deep` / doctor --live）。
 */
function fileDigest(path: string): string {
  const CHUNK = 4096;
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const headLen = Math.min(CHUNK, size);
    const head = Buffer.alloc(headLen);
    if (headLen > 0) readSync(fd, head, 0, headLen, 0);
    const tailLen = Math.min(CHUNK, size);
    const tail = Buffer.alloc(tailLen);
    if (tailLen > 0) readSync(fd, tail, 0, tailLen, Math.max(0, size - tailLen));
    return createHash("sha256").update(head).update(tail).digest("hex");
  } finally {
    closeSync(fd);
  }
}

/** 旁车判定结果：`trusted` 可信、`untrusted` 存在但不可信、`missing` 不存在 */
export type BackupSidecarState = "trusted" | "untrusted" | "missing";

/** 写校验旁车（原子：先写唯一临时名再 rename）。失败只 warn —— 旁车只是增强信息 */
function writeVerifiedSidecar(targetPath: string, schemaVersion: number, nowMs: number): void {
  const path = `${targetPath}${VERIFIED_SUFFIX}`;
  const tmp = `${path}${VERIFIED_TMP_SUFFIX}${process.pid}-${randomUUID().slice(0, 8)}`;
  try {
    const stat = statSync(targetPath);
    const sizeBytes = stat.size;
    // verifiedAt 取「这次备份对应的逻辑时刻」而不是 wall clock：runBackup 的 nowMs 是
    // 唯一时间口径（测试可钉死），旁车与文件名、stale 判定才对得上。
    // mtimeMs + digest 是「同内容」的证据：size 相同但被等长覆盖/拷回旧文件时，
    // 光看 size 会误判 verified（复审 T-1027-02c 观察 c）。
    const payload = {
      schemaVersion,
      verifiedAt: new Date(nowMs).toISOString(),
      sizeBytes,
      mtimeMs: stat.mtimeMs,
      digest: fileDigest(targetPath),
    };
    writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    // rename 在同一目录内是原子的：读方要么看到完整 JSON，要么看不到旁车（回退开库），
    // 绝不会读到写了一半的 `{` 从而把一份健康备份判成不可信。
    renameSync(tmp, path);
  } catch (e) {
    logger.warn(`写备份校验旁车失败（不影响备份本身）: ${path} ${errorText(e)}`);
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件可能根本没写出来
    }
  }
}

/**
 * 读校验旁车并判定可信度：`trusted` / `untrusted` / `missing`。
 *
 * 可信要求全部吻合：schemaVersion 正整数、verifiedAt 可解析、sizeBytes 与当前文件一致、
 * mtimeMs 与当前文件一致、digest（首尾 4KB sha256）重算一致。任何一项不符都判
 * `untrusted`（不要回退成「大概可信」）—— 复制/覆盖/等长改写都会让 mtime 或 digest 变化。
 */
function readVerifiedSidecar(file: BackupFileInfo): BackupSidecarState {
  const path = `${file.path}${VERIFIED_SUFFIX}`;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "untrusted";
  }
  try {
    const parsed = JSON.parse(raw) as {
      schemaVersion?: unknown;
      verifiedAt?: unknown;
      sizeBytes?: unknown;
      mtimeMs?: unknown;
      digest?: unknown;
    };
    if (
      typeof parsed.schemaVersion !== "number" ||
      !Number.isInteger(parsed.schemaVersion) ||
      parsed.schemaVersion < 1
    ) {
      return "untrusted";
    }
    if (typeof parsed.verifiedAt !== "string" || Number.isNaN(Date.parse(parsed.verifiedAt))) {
      return "untrusted";
    }
    if (typeof parsed.sizeBytes !== "number" || parsed.sizeBytes !== file.sizeBytes)
      return "untrusted";
    if (typeof parsed.mtimeMs !== "number" || parsed.mtimeMs !== file.mtimeMs) return "untrusted";
    if (typeof parsed.digest !== "string" || parsed.digest !== fileDigest(file.path))
      return "untrusted";
    return "trusted";
  } catch {
    return "untrusted";
  }
}

function prune(dir: string, keep: number, nowMs: number = Date.now()): void {
  const files = readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .reverse();
  for (const stale of files.slice(keep)) {
    // 先删旁车再删备份：万一进程在两步之间被杀，留下的是「没有旁车的备份」（读方会
    // 回退开库校验），而不是「旁车指向已不存在的库」这种误导排障的孤儿。
    try {
      unlinkSync(join(dir, `${stale}${VERIFIED_SUFFIX}`));
    } catch (e) {
      // 没有旁车（旁车功能上线前的老备份/写旁车失败）是正常情况，不算错误
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.warn(`清理备份旁车失败: ${stale}${VERIFIED_SUFFIX} ${errorText(e)}`);
      }
    }
    try {
      unlinkSync(join(dir, stale));
      logger.info(`已清理旧备份: ${stale}`);
    } catch (e) {
      logger.warn(`清理旧备份失败: ${stale} ${errorText(e)}`);
    }
  }

  // 孤儿旁车（对应 `<name>.db` 已不存在）与写到一半的旁车临时文件：保留它们只会误导排障。
  // 判孤儿必须看完整的 `.db.verified` 后缀，且不能被 `.verified.tmp-*` 误判（后者也能
  // 通过 endsWith 检查的前提是它的名字恰好以 `.verified` 结尾，实际以随机串结尾）。
  const present = new Set(readdirSync(dir));
  for (const name of present) {
    const isTmp = VERIFIED_TMP_RE.test(name);
    const isOrphan =
      !isTmp &&
      name.endsWith(VERIFIED_SUFFIX) &&
      !present.has(name.slice(0, -VERIFIED_SUFFIX.length));
    if (!isOrphan && !isTmp) continue;
    const path = join(dir, name);
    if (isTmp) {
      // 与 .partial 同一口径：1 小时内的可能还有进程正在写（写旁车是毫秒级，
      // 但时钟回拨/慢盘下不能赌），不动。
      const stat = statSync(path, { throwIfNoEntry: false });
      if (stat !== undefined && nowMs - stat.mtimeMs < PARTIAL_STALE_MS) continue;
    }
    try {
      unlinkSync(path);
      logger.info(isTmp ? `已清理残留的旁车临时文件: ${name}` : `已清理孤儿备份旁车: ${name}`);
    } catch (e) {
      logger.warn(`清理备份旁车失败: ${name} ${errorText(e)}`);
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
      logger.warn(`清理半截备份失败: ${name} ${errorText(e)}`);
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
      sidecarState: opts.sidecar === true || opts.verifyLatest === true ? "missing" : null,
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
  // 只在被要求时判定 latest：坏备份的 mtime 往往很新，只看 mtime 会得出
  // 「备份新鲜健康」的相反结论（P1-4）。校验失败时 stale 必须为 true。
  // 三档口径（成本从低到高）：
  // - sidecar：只读旁车，零开库（状态页/metrics）；
  // - verifyLatest：先信旁车，旁车不可信才开库（默认的「尽量省、但要给出结论」）；
  // - deep：无条件开库现场校验（doctor --live，能发现「旁车说好、实际库坏了」）。
  const requested = opts.sidecar === true || opts.verifyLatest === true;
  const sidecarState: BackupSidecarState | null = !requested
    ? null
    : latest === null
      ? "missing"
      : readVerifiedSidecar(latest);
  const latestVerified =
    latest === null ? null : verifyLatestBackup(latest, opts, sidecarState ?? "missing");
  return {
    dir: config.backupDir,
    files,
    latest,
    ageHours,
    stale: ageHours === null || ageHours > BACKUP_STALE_HOURS || latestVerified === false,
    latestVerified,
    sidecarState,
    nonCanonical: files.filter((file) => !file.canonical).map((file) => file.name),
  };
}

/**
 * 判定一份备份是否可信：
 * - 默认（未请求校验）返回 null，连旁车都不读 —— 状态页/`/metrics` 的默认调用零 IO；
 * - `deep` 无条件开库（doctor --live 的最终事实，旁车说谎也会被抓出来）；
 * - `sidecar` 只读旁车、永不开库，不可信即 false；
 * - `verifyLatest` 先读旁车，旁车缺失/内容坏/大小对不上再回退开库，保持旧行为兼容。
 */
function verifyLatestBackup(
  file: BackupFileInfo,
  opts: BackupStatusOptions,
  sidecarState: BackupSidecarState,
): boolean | null {
  if (opts.deep === true) return verifyByOpening(file, "现场校验");
  if (opts.verifyLatest === true) {
    // 旁车只是「备份成功时已经校验过」的声明：size/mtime/首尾指纹都对上才采信，
    // 不可信时回退到开库 —— 旁车缺失的老部署也照旧能得到真实结论。
    if (sidecarState === "trusted") return true;
    return verifyByOpening(file, "最新备份校验");
  }
  if (opts.sidecar === true) {
    if (sidecarState === "trusted") return true;
    logger.debug(
      `最新备份旁车不可信（${file.path}${VERIFIED_SUFFIX}）：${
        sidecarState === "missing" ? "旁车不存在" : "内容坏或大小/mtime/指纹与备份不一致"
      }`,
    );
    return false;
  }
  return null;
}

/** 开库校验（quick_check + schema 可读）；失败只 warn 并把结论降级为 false，绝不抛错 */
function verifyByOpening(file: BackupFileInfo, label: string): boolean {
  try {
    verifyDatabaseFile(file.path);
    return true;
  } catch (e) {
    logger.warn(`${label}失败（${file.path}）：${errorText(e)}`);
    return false;
  }
}
