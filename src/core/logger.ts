import { DateTime } from "luxon";
import type { LogLevel } from "../config.js";
import { TZ } from "../time.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

/**
 * 日志时间戳：本地时区（Asia/Shanghai）带偏移的 ISO 8601。
 *
 * 为什么不用 `toISOString()`：它输出 UTC（`...Z`），凌晨的日志在排查时既要心算 +8，
 * 又容易把「21:20 的预警巡检」看成 13:20 —— 这是给人看的日志，时间就该是操作者
 * 所在时区的时间。项目全部调度固定 Asia/Shanghai、无 DST，带 `+08:00` 的绝对时刻
 * 依旧可被 `Date.parse` 解析，机器处理不受影响。
 *
 * 单独导出是为了让格式可以被单测钉住（日志一行都写不出时没有别的断言入口）。
 */
export function formatLogTimestamp(date: Date = new Date()): string {
  const local = DateTime.fromJSDate(date, { zone: TZ });
  // 理论上 fromJSDate 对合法 Date 永远有效；万一 Luxon 返回 null 也不能让日志抛错
  return local.isValid ? (local.toISO() ?? date.toISOString()) : date.toISOString();
}

function write(level: LogLevel, message: string): void {
  if (LEVELS[level] < threshold) return;
  console.error(`${formatLogTimestamp()} [${level}] ${message}`);
}

/** 所有日志走 stderr：stdout 保留给 stdio 协议 */
export const logger = {
  debug: (msg: string) => write("debug", msg),
  info: (msg: string) => write("info", msg),
  warn: (msg: string) => write("warn", msg),
  error: (msg: string) => write("error", msg),
};
