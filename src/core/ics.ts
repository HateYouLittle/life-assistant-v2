import { createHmac, timingSafeEqual } from "node:crypto";
import { PROFILE_ID_RE, type ResolvedConfig } from "../config.js";

/**
 * 日历订阅（ICS）的签名 URL 与文本工具。
 *
 * 为什么用签名 URL 而不是 Authorization 头：iOS/macOS/Android 的「订阅日历」只接受一个
 * URL，客户端**无法**为它附加自定义请求头，因此凭据只能放进 URL 本身。放 master token
 * 等于把全家凭据交给每一台设备，所以这里用 HMAC 派生出一个**只能读某一个 Profile**、
 * 且带有效期的签名：`sig = HMAC-SHA256(WEB_API_TOKEN, "<profile>.<exp>")`。
 *
 * 不新增任何 env：密钥就是既有的 WEB_API_TOKEN（≥32 字符的 master token）。
 */

/** 过期判定留出的时钟偏移容忍（秒）：客户端与服务端时钟不可能严格一致 */
const CLOCK_SKEW_SECONDS = 60;

/** `exp` 的合法形状：Unix 秒（10 位到 2286 年，12 位足够宽松且能挡住小数/科学计数法） */
const EXP_RE = /^\d{1,12}$/;
/** 签名固定是 HMAC-SHA256 的小写 hex */
const SIG_RE = /^[0-9a-f]{64}$/;

/** 签名被篡改（而不是过期/缺参）时的原因文本，路由据此回 403 而不是 401 */
export const CALENDAR_SIGNATURE_MISMATCH = "签名校验失败";

export interface CalendarSignatureInput {
  /** Profile 名（query 的 p） */
  p?: string;
  /** Unix 秒（query 的 exp） */
  exp?: string;
  /** hex(HMAC-SHA256(WEB_API_TOKEN, `${p}.${exp}`))（query 的 sig） */
  sig?: string;
}

export type CalendarVerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * 取签名密钥。没有 WEB_API_TOKEN 时**必须报错**：回环零配置部署下
 * `/calendar.ics` 若静默放行，就等于把全家日程公开在一个无鉴权 URL 上。
 */
function calendarSecret(config: ResolvedConfig): string {
  const token = config.webApiToken;
  if (token === undefined || token === "") {
    throw new Error("未配置 WEB_API_TOKEN，日历订阅签名不可用");
  }
  return token;
}

function hmacHex(secret: string, profileId: string, exp: string): string {
  return createHmac("sha256", secret).update(`${profileId}.${exp}`).digest("hex");
}

/**
 * 生成相对路径的订阅地址：`/calendar.ics?p=<profile>&exp=<unix秒>&sig=<hex>`。
 * 返回相对路径（而不是完整 URL）是因为 daemon 自己不知道公网域名 ——
 * 经 NAS 的 Lucky 反代后，同一个路径对应 `https://<域名>/calendar.ics`。
 *
 * `nowMs` 可注入，便于测试与「用过去时刻签发一张已过期链接」的场景；
 * 传入的过期时刻若不在未来（相对 `nowMs`）则直接报错 —— 签发一张出生即失效的链接是调用方 bug。
 */
export function signCalendarUrl(
  config: ResolvedConfig,
  profileId: string,
  expiresAtMs: number,
  nowMs: number = Date.now(),
): string {
  const secret = calendarSecret(config);
  if (!PROFILE_ID_RE.test(profileId)) throw new Error(`Profile 名不合法: ${profileId}`);
  if (!Number.isFinite(expiresAtMs)) throw new Error(`过期时刻不合法: ${expiresAtMs}`);
  if (expiresAtMs <= nowMs) throw new Error("日历订阅链接的过期时刻必须晚于当前时刻");
  const exp = String(Math.floor(expiresAtMs / 1000));
  return `/calendar.ics?p=${encodeURIComponent(profileId)}&exp=${exp}&sig=${hmacHex(secret, profileId, exp)}`;
}

/**
 * 校验订阅 URL 的签名。任何一步不通过都返回 `{ok:false, reason}` 而不是抛异常：
 * 这是每一条外部请求都会走到的路径，异常会让路由层变成 500。
 */
export function verifyCalendarSignature(
  config: ResolvedConfig,
  input: CalendarSignatureInput,
  nowMs: number = Date.now(),
): CalendarVerifyResult {
  let secret: string;
  try {
    secret = calendarSecret(config);
  } catch (e) {
    // 明确报错而不是静默放行：没有 master token 就没有密钥，订阅功能整体不可用
    return { ok: false, reason: e instanceof Error ? e.message : "日历订阅签名不可用" };
  }

  const { p, exp, sig } = input;
  if (p === undefined || exp === undefined || sig === undefined) {
    return { ok: false, reason: "缺少 p/exp/sig 参数" };
  }
  // Profile 名先按白名单形状校验：它同时是 HMAC 的输入，形状不受控就没有校验的意义
  if (!PROFILE_ID_RE.test(p)) {
    return { ok: false, reason: `Profile 名不合法: ${p}` };
  }
  if (!EXP_RE.test(exp)) {
    return { ok: false, reason: "exp 必须是 Unix 秒时间戳" };
  }
  const expMs = Number(exp) * 1000;
  // 60s 容忍：时钟略慢的客户端不该在链接刚过期时立刻订阅失败
  if (expMs + CLOCK_SKEW_SECONDS * 1000 < nowMs) {
    return { ok: false, reason: "链接已过期，请重新生成日历订阅地址" };
  }
  if (!SIG_RE.test(sig)) {
    // 形状都不对说明链接被改过（或客户端截断了），按签名问题处理
    return { ok: false, reason: CALENDAR_SIGNATURE_MISMATCH };
  }
  // 两边都是定长 hex，长度必然相同；timingSafeEqual 不会因长度不等抛错
  const expected = Buffer.from(hmacHex(secret, p, exp), "hex");
  const actual = Buffer.from(sig, "hex");
  if (!timingSafeEqual(expected, actual)) {
    return { ok: false, reason: CALENDAR_SIGNATURE_MISMATCH };
  }
  return { ok: true };
}

/**
 * RFC 5545 的 TEXT 转义：反斜杠、分号、逗号、换行。
 * 反斜杠必须最先替换，否则后面插入的转义反斜杠会被二次转义。
 */
export function escapeIcsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** UTC 基本格式 `YYYYMMDDTHHMMSSZ`（ICS 的 DTSTAMP/DTSTART 都用它） */
export function formatIcsUtc(date: Date): string {
  if (Number.isNaN(date.getTime())) throw new Error("时间不合法，无法格式化为 ICS");
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}
