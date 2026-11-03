import { createHash, createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { PROFILE_ID_RE, type ResolvedConfig, resolvePublicBaseUrl } from "../config.js";
import { constantTimeEqual, signingSecret } from "./ics.js";
import { reminderLinksEnabled } from "./notify-prefs.js";

/**
 * 推送里的一键操作链接：`<基址>/a/<token>`。
 *
 * 为什么是签名 URL：QQ 等 IM 里点开的链接不能带 Authorization 头，凭据只能在 URL 里；
 * 放 Profile token 等于把整份个人视图交给每一条消息（会被转发、截图、进聊天记录），
 * 所以与日历订阅同一思路（core/ics.ts）：用 master token 派生 HMAC，**一条链接只能对
 * 一次发生做一种动作**，且带过期时刻。
 *
 * token = base64url(载荷) + "." + base64url(HMAC-SHA256(WEB_API_TOKEN, "action:" + 载荷) 前 16 字节)
 * 载荷 = `1|<profile>|<schedule_id>|<occurrence_key>|<action>|<exp 秒>`（字段形状逐个白名单校验，
 * 都不含 `|`）。HMAC 截到 128 位：只防伪造、不防碰撞攻击之外的场景，链接因此短一半。
 */

export const ACTION_LINK_ACTIONS = ["done", "snooze30"] as const;
export type ActionLinkAction = (typeof ACTION_LINK_ACTIONS)[number];

/** 链接有效期：提醒常在当天处理，7 天足够覆盖「周末回来再点」，又不至于长期有效 */
export const ACTION_LINK_TTL_MS = 7 * 24 * 3600 * 1000;
/** 与日历订阅同一时钟偏移容忍 */
const CLOCK_SKEW_SECONDS = 60;
/** 截断后的签名字节数（base64url 22 字符） */
const SIG_BYTES = 16;

const VERSION = "1";
const SCHEDULE_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/** occurrence_key 形如 `2026-11-04T18:00#1` / `...#1:resend` / `...#0#esc:2` */
const OCCURRENCE_KEY_RE = /^[0-9A-Za-z:#._-]{1,96}$/;
const EXP_RE = /^\d{1,12}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
/** token 总长上限：超出必然不是本服务签发的，直接拒绝，不做任何解码 */
const TOKEN_MAX_LENGTH = 400;

export interface ActionLinkClaims {
  profileId: string;
  scheduleId: string;
  occurrenceKey: string;
  action: ActionLinkAction;
  /** Unix 秒 */
  exp: number;
}

export type ActionLinkVerdict =
  | { ok: true; claims: ActionLinkClaims }
  | { ok: false; reason: "expired" | "invalid" | "unavailable"; message: string };

export const ACTION_LINK_EXPIRED_MESSAGE = "链接已过期：请等下一次提醒，或直接在对话里回复「完成」";
export const ACTION_LINK_INVALID_MESSAGE = "签名无效：链接被修改过或不完整，请从原消息重新打开";

function hmac(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret).update(`action:${payload}`).digest().subarray(0, SIG_BYTES);
}

function isAction(value: string): value is ActionLinkAction {
  return (ACTION_LINK_ACTIONS as readonly string[]).includes(value);
}

/** 签发一条操作 token（不含基址）。字段形状不合法直接抛错 —— 那是调用方 bug */
export function signActionToken(
  config: ResolvedConfig,
  claims: Omit<ActionLinkClaims, "exp">,
  expiresAtMs: number,
): string {
  const secret = signingSecret(config, "操作链接");
  if (!PROFILE_ID_RE.test(claims.profileId)) {
    throw new Error(`Profile 名不合法: ${claims.profileId}`);
  }
  if (!SCHEDULE_ID_RE.test(claims.scheduleId)) {
    throw new Error(`日程 id 不合法: ${claims.scheduleId}`);
  }
  if (!OCCURRENCE_KEY_RE.test(claims.occurrenceKey)) {
    throw new Error(`occurrence_key 不合法: ${claims.occurrenceKey}`);
  }
  if (!isAction(claims.action)) throw new Error(`不支持的操作: ${String(claims.action)}`);
  if (!Number.isFinite(expiresAtMs)) throw new Error(`过期时刻不合法: ${expiresAtMs}`);
  const exp = String(Math.floor(expiresAtMs / 1000));
  const payload = [
    VERSION,
    claims.profileId,
    claims.scheduleId,
    claims.occurrenceKey,
    claims.action,
    exp,
  ].join("|");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${hmac(secret, payload).toString("base64url")}`;
}

/**
 * 校验 token。顺序是**先验签、再看过期**：exp 本身在签名里，签名不对时它的值不可信，
 * 若先判过期，伪造者能借「已过期」文案探测载荷形状。任何失败都返回结果而不抛异常。
 */
export function verifyActionToken(
  config: ResolvedConfig,
  token: string,
  nowMs: number = Date.now(),
): ActionLinkVerdict {
  let secret: string;
  try {
    secret = signingSecret(config, "操作链接");
  } catch (e) {
    return {
      ok: false,
      reason: "unavailable",
      message: e instanceof Error ? e.message : "操作链接不可用",
    };
  }
  const invalid: ActionLinkVerdict = {
    ok: false,
    reason: "invalid",
    message: ACTION_LINK_INVALID_MESSAGE,
  };
  if (token.length === 0 || token.length > TOKEN_MAX_LENGTH) return invalid;
  const parts = token.split(".");
  if (parts.length !== 2) return invalid;
  const [payloadB64, sigB64] = parts as [string, string];
  if (!B64URL_RE.test(payloadB64) || !B64URL_RE.test(sigB64)) return invalid;
  const payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  // 规范化：重新编码必须逐字一致，否则同一载荷会有多种合法写法（幂等指纹会被绕开）
  if (Buffer.from(payload, "utf8").toString("base64url") !== payloadB64) return invalid;
  const sig = Buffer.from(sigB64, "base64url");
  // 签名同样要求规范编码：base64url 末位的填充比特可以有多种写法
  if (sig.toString("base64url") !== sigB64) return invalid;
  if (!constantTimeEqual(hmac(secret, payload), sig)) return invalid;
  const fields = payload.split("|");
  if (fields.length !== 6) return invalid;
  const [version, profileId, scheduleId, occurrenceKey, action, exp] = fields as [
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (
    version !== VERSION ||
    !PROFILE_ID_RE.test(profileId) ||
    !SCHEDULE_ID_RE.test(scheduleId) ||
    !OCCURRENCE_KEY_RE.test(occurrenceKey) ||
    !isAction(action) ||
    !EXP_RE.test(exp)
  ) {
    return invalid;
  }
  const expSeconds = Number(exp);
  if (expSeconds * 1000 + CLOCK_SKEW_SECONDS * 1000 < nowMs) {
    return { ok: false, reason: "expired", message: ACTION_LINK_EXPIRED_MESSAGE };
  }
  return { ok: true, claims: { profileId, scheduleId, occurrenceKey, action, exp: expSeconds } };
}

/** token 指纹：审计里只存它，不存 token 原文（原文就是凭据） */
export function actionTokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32);
}

export const ACTION_LABEL: Record<ActionLinkAction, string> = {
  done: "完成",
  snooze30: "推迟 30 分钟",
};

export interface ReminderLinkInput {
  profileId: string;
  scheduleId: string;
  occurrenceKey: string;
  /** 派生提醒行（重发/升级）不能 snooze，只给「完成」 */
  snoozable: boolean;
}

/**
 * 提醒正文末尾的链接行。任一前提不满足就返回空数组（= 不追加，提醒照常发）：
 * - 该 Profile 关了 `notify prefs {kind:"schedule.reminder", links:false}`；
 * - 没有可用基址（PUBLIC_BASE_URL / WEB_ALLOWED_HOSTS 非回环条目都没有）——
 *   绝不生成 127.0.0.1/localhost 链接，手机点不开；
 * - 没有 WEB_API_TOKEN（没有签名密钥）。
 */
export function reminderActionLinks(
  config: ResolvedConfig,
  db: DatabaseSync,
  input: ReminderLinkInput,
  nowMs: number = Date.now(),
): string[] {
  if (config.webApiToken === undefined || config.webApiToken === "") return [];
  const base = resolvePublicBaseUrl(config);
  if (base === null) return [];
  if (!reminderLinksEnabled(db, input.profileId)) return [];
  const actions: ActionLinkAction[] = input.snoozable ? ["done", "snooze30"] : ["done"];
  const expiresAt = nowMs + ACTION_LINK_TTL_MS;
  return actions.map((action) => {
    const token = signActionToken(
      config,
      {
        profileId: input.profileId,
        scheduleId: input.scheduleId,
        occurrenceKey: input.occurrenceKey,
        action,
      },
      expiresAt,
    );
    return `${ACTION_LABEL[action]}：${base}/a/${token}`;
  });
}
