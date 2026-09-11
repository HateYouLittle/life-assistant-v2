import type { LogLevel } from "../config.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold = LEVELS.info;

export function setLogLevel(level: LogLevel): void {
  threshold = LEVELS[level];
}

function write(level: LogLevel, message: string): void {
  if (LEVELS[level] < threshold) return;
  console.error(`${new Date().toISOString()} [${level}] ${message}`);
}

/** 所有日志走 stderr：stdout 保留给 stdio 协议 */
export const logger = {
  debug: (msg: string) => write("debug", msg),
  info: (msg: string) => write("info", msg),
  warn: (msg: string) => write("warn", msg),
  error: (msg: string) => write("error", msg),
};
