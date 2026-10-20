import {
  copyFileSync,
  constants as fsConstants,
  readdirSync,
  statSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { DateTime } from "luxon";
import { TZ } from "../time.js";
import { logger } from "./logger.js";

/**
 * 日志轮转：launchd 把 daemon 的 stdout/stderr 重定向到
 * `~/Library/Logs/life-assistant/{daemon.log,daemon.err.log}`，这两个文件只会无限增长
 * （单守护进程长期运行，一天几十 MB 的 err 日志并不罕见）。这里用 **copytruncate** 收敛：
 *
 * 1. `copyFileSync` 把当前日志复制成带时间戳的轮转文件；
 * 2. `truncateSync` 把原文件截断为 0。
 *
 * 顺序不能反：先 truncate 再 copy 会把「本轮日志」直接丢掉。先 copy 再 truncate 时，
 * launchd 持有的 fd 仍指向同一个 inode，daemon 后续写日志自然从文件头开始 ——
 * 这是唯一不需要重启进程/重新打开 fd 的轮转方式（进程无法让 launchd 帮它 reopen）。
 *
 * 失败一律降级为 `skipped` 而不是抛错：一个文件坏（权限/被删/是目录）不能连带
 * 另一个文件也不轮转；调用方（维护 job）只负责把 skipped 原因打到日志里。
 */

/** launchd 重定向的两个文件。stderr 在前：daemon 的诊断输出全在这里 */
export const DEFAULT_LOG_FILES = ["daemon.err.log", "daemon.log"] as const;

export interface RotateLogFileOptions {
  /** 日志文件绝对路径 */
  file: string;
  /** 超过该字节数才轮转 */
  maxBytes: number;
  /** 轮转产物保留份数（同一基础文件） */
  keep: number;
  /** 轮转时间戳（测试注入；默认当前时刻，本地 Asia/Shanghai） */
  now?: Date;
}

export interface RotateLogFileResult {
  rotated: boolean;
  /** 轮转产物路径；未轮转时缺省 */
  rotatedTo?: string;
  /** 未轮转时的原因（文件不存在/未超阈值/复制或清空失败） */
  skipped?: string;
}

export interface RotateLogsOptions {
  /** 日志目录（config.logDir） */
  dir: string;
  maxBytes: number;
  keep: number;
  /** 相对 dir 的文件名；默认 DEFAULT_LOG_FILES */
  files?: readonly string[];
  now?: Date;
}

export interface RotateLogsResult {
  /** 本轮真正轮转的文件（绝对路径） */
  rotated: string[];
  /** 跳过原因；文件缺失也算「跳过」而不是失败 */
  skipped: { file: string; reason: string }[];
  /**
   * 被清空的活动日志字节数合计。
   *
   * 注意这**不等于**磁盘释放量：轮转副本仍占盘，只有 keep 保留策略删掉旧副本才真正
   * 腾出空间（那部分不在此处重复计入）。日志里按「活动日志归零 X 字节」表述。
   */
  freedBytes: number;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `<file>.<YYYYMMDD-HHmmss>.log`；同秒重名加 `-1`/`-2` 后缀（手动补跑与 cron 撞点时不能互相覆盖） */
function rotatedPath(file: string, now: Date): string {
  const stamp = DateTime.fromJSDate(now, { zone: TZ }).toFormat("yyyyMMdd-HHmmss");
  let candidate = `${file}.${stamp}.log`;
  // 上限只是防御性兜底（同一秒不可能轮转上千次）；真到上限时返回最后一个候选，
  // 由 copyFileSync 的 COPYFILE_EXCL 拒绝覆盖而不是静默丢日志。
  for (let seq = 1; seq <= 1000; seq += 1) {
    if (statSync(candidate, { throwIfNoEntry: false }) === undefined) return candidate;
    candidate = `${file}.${stamp}-${seq}.log`;
  }
  return candidate;
}

interface RotatedFile {
  path: string;
  /** 可排序的新旧键：时间戳 + 同秒序号（补零保证字典序=时间序） */
  order: string;
}

/** 同一基础文件的轮转产物，新的在前（时间戳已保证字典序，补零后的序号打破同秒并列） */
function rotatedFilesOf(file: string): RotatedFile[] {
  const dir = dirname(file);
  const prefix = `${basename(file)}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // 目录不存在等同于「没有轮转产物」；这里不抛错，轮转失败的 skipped 已在上游给出
    return [];
  }
  const re = new RegExp(`^${escapeRegExp(prefix)}(\\d{8}-\\d{6})(?:-(\\d+))?\\.log$`);
  const found: RotatedFile[] = [];
  for (const name of names) {
    const matched = re.exec(name);
    if (matched === null) continue;
    const stamp = matched[1] ?? "";
    const seq = Number(matched[2] ?? "0");
    found.push({
      path: join(dir, name),
      order: `${stamp}-${String(seq).padStart(6, "0")}`,
    });
  }
  return found.sort((a, b) => b.order.localeCompare(a.order));
}

/** 只保留最近 keep 份轮转产物，删除更旧的；返回删除的旧轮转个数（失败只告警） */
function pruneRotated(file: string, keep: number): number {
  if (!Number.isInteger(keep) || keep < 1) return 0;
  const stale = rotatedFilesOf(file).slice(keep);
  let removed = 0;
  for (const entry of stale) {
    try {
      unlinkSync(entry.path);
      removed += 1;
      logger.debug(`已清理旧轮转日志: ${entry.path}`);
    } catch (e) {
      logger.warn(`清理旧轮转日志失败: ${entry.path} ${errorText(e)}`);
    }
  }
  return removed;
}

/** 单个日志文件轮转（copytruncate；不抛错，失败信息走 skipped） */
export function rotateLogFile(opts: RotateLogFileOptions): RotateLogFileResult {
  const { file, maxBytes, keep } = opts;
  let size: number;
  try {
    const stat = statSync(file);
    if (!stat.isFile()) return { rotated: false, skipped: "不是普通文件" };
    size = stat.size;
  } catch (e) {
    return { rotated: false, skipped: `文件不存在或不可访问：${errorText(e)}` };
  }
  if (size <= maxBytes) {
    return { rotated: false, skipped: `未超过阈值（${size} ≤ ${maxBytes} 字节）` };
  }

  const rotatedTo = rotatedPath(file, opts.now ?? new Date());
  try {
    // 顺序关键：先 copy（保住本轮日志）再 truncate（让 launchd 的 fd 从文件头继续写）；
    // COPYFILE_EXCL 确保同名时失败而不是覆盖掉上一份轮转日志
    copyFileSync(file, rotatedTo, fsConstants.COPYFILE_EXCL);
  } catch (e) {
    return { rotated: false, skipped: `复制失败：${errorText(e)}` };
  }
  try {
    truncateSync(file, 0);
  } catch (e) {
    // 副本完整保留（唯一的一份现场），只是原文件没清空；下次触发会再试，不能删副本
    return {
      rotated: false,
      skipped: `已复制到 ${rotatedTo} 但清空原文件失败：${errorText(e)}`,
    };
  }

  pruneRotated(file, keep);
  return { rotated: true, rotatedTo };
}

/** 轮转一组日志文件（默认 daemon.err.log + daemon.log），任何一个失败都不影响其它 */
export function rotateLogs(opts: RotateLogsOptions): RotateLogsResult {
  const files = opts.files ?? DEFAULT_LOG_FILES;
  const result: RotateLogsResult = { rotated: [], skipped: [], freedBytes: 0 };
  for (const name of files) {
    const file = join(opts.dir, name);
    let sizeBefore = 0;
    try {
      sizeBefore = statSync(file).size;
    } catch {
      sizeBefore = 0;
    }
    const single = rotateLogFile({
      file,
      maxBytes: opts.maxBytes,
      keep: opts.keep,
      now: opts.now,
    });
    if (single.rotated) {
      result.rotated.push(file);
      result.freedBytes += sizeBefore;
    } else if (single.skipped !== undefined) {
      result.skipped.push({ file, reason: single.skipped });
    }
  }
  return result;
}
