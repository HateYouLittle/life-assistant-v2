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

/**
 * 日志里必须剔除的字符：`\n`/`\r`/ESC 等 C0 与 DEL 会拆行或触发终端转义；C1 区
 * （U+0080–U+009F，含 NEL U+0085）与 U+2028/U+2029 行/段分隔符在部分工具（如 Python
 * `splitlines()`）里同样被当作换行 —— 不滤掉的话，一个原始 HTTP 头就能把单行日志拆开。
 */
function isUnsafeLogCodePoint(code: number): boolean {
  return (
    code < 0x20 ||
    code === 0x7f ||
    (code >= 0x80 && code <= 0x9f) ||
    code === 0x2028 ||
    code === 0x2029
  );
}

/**
 * 日志字段净化：去掉 C0/DEL/C1 控制字符与 U+2028/U+2029 行分隔符（外部输入里的
 * `\n`/`\r`/ESC/NEL 等会把单行日志拆行或触发终端转义），并截断到 `maxLength`
 * （超长时补省略号）。
 *
 * 用于把请求路径、失败原因等**外部可控文本**拼进日志；内部固定文案不需要调用。
 */
export function sanitizeLogText(value: string, maxLength = 200): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (isUnsafeLogCodePoint(code)) continue;
    out += ch;
    if (out.length >= maxLength) return `${out}…`;
  }
  return out;
}

/** 日志里需要打码的 query 参数名（凭据/签名类；按小写比较） */
const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "sig",
  "key",
  "apikey",
  "api_key",
  "access_token",
  "pass",
  "password",
  "secret",
  "authorization",
]);

/**
 * URL → 可安全落日志的形态：`token`/`sig`/`key`/`pass`/`secret` 等 query 参数值替换为
 * `***`，其余控制字符净化并截断。
 *
 * 为什么必要：状态页支持 `?token=` 引导、日历订阅用 `?sig=`，这些 URL 被限流等日志打印时
 * 会把凭据原文写进日志文件（文件虽 0600，但凭据不该因「写日志」而落盘）。只在日志调用点
 * 使用，不影响正常的请求处理与鉴权（鉴权仍读原始 URL）。
 */
export function maskSensitiveUrl(rawUrl: string, maxLength = 200): string {
  const queryAt = rawUrl.indexOf("?");
  if (queryAt < 0) return sanitizeLogText(rawUrl, maxLength);
  const path = rawUrl.slice(0, queryAt);
  const params = new URLSearchParams(rawUrl.slice(queryAt + 1));
  for (const key of new Set(params.keys())) {
    if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) params.set(key, "***");
  }
  return sanitizeLogText(`${path}?${params.toString()}`, maxLength);
}
