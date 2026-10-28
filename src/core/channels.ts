import { createHmac } from "node:crypto";
import { canUseGlobalOpenclawTokenFromEnv } from "../config.js";
import { logger } from "./logger.js";
import { parseSmtpRouteUrl, type SmtpRoute, sendSmtpMail } from "./smtp.js";

/**
 * 投递通道抽象：outbox 只负责「何时投、投几次、失败怎么退避」，通道负责「怎么真正发出去」。
 *
 * 通道只做无状态投递（一条通知一次），所有状态推进（claim / sent / fallback / 退避）
 * 仍由 src/core/notify.ts 统一落库 —— 这样换通道不会改变幂等与重试语义。
 * 路由的 channel 字段缺省（旧数据）等同 webhook，旧 push_route 不需要迁移。
 *
 * 内置通道：webhook（回环 Hermes 网关，HMAC V2）、openclaw（回环 OpenClaw Gateway hook）、
 * log（本地日志）、bark（iOS 推送，URL 即凭据）、ntfy（自建/公共 topic）、
 * telegram（Bot API，token+chat_id 在 URL 里）、smtp（邮件，协议实现在 core/smtp.ts）。
 * webhook 与 openclaw 限制回环地址；log 只写本地日志；其余通道投递到外部服务，
 * 因此**不**做 webhook 那样的回环限制 —— 它们不带 secret，URL 本身就是凭据。
 *
 * 凭据边界：webhook 与 openclaw 都会把凭据发到「用户自己填的回环 URL」，因此都不允许
 * 借用别人的凭据 —— webhook 只认 PROFILE_ROUTE_SECRETS_JSON[profile]（requiresSecret），
 * openclaw 优先用同一个 profile secret，只有**部署自身 profile（HERMES_PROFILE）**配置的路由
 * 才回退 daemon 全局 OPENCLAW_HOOK_TOKEN（回退准入由 config.ts 的
 * canUseGlobalOpenclawToken 三档口径判定），且路径收紧到 Gateway 的 /hooks/ 前缀。
 */

export const EVENT_TYPE = "life_assistant.reminder";

/** 通道投递时用到的路由信息（只读；URL 对 log 通道为空串） */
export interface ChannelRoute {
  name: string;
  url: string;
}

/** 通道专属的路由校验输入：webhook/openclaw/bark/ntfy/telegram/smtp 从 url 取地址，log 不需要 URL */
export interface ChannelRouteInput {
  url?: string;
}

/** 一条待投递通知的完整快照（requestId 由 outbox 统一生成，通道不得自行改写） */
export interface ChannelDeliveryInput {
  profileId: string;
  notificationId: string;
  kind: string;
  title: string;
  bodyMd: string;
  createdAt: string;
  requestId: string;
  generation: number;
  route: ChannelRoute;
  /**
   * webhook 必需（HMAC V2 签名密钥）；openclaw 可选 —— 有值时作为 Bearer token 优先于
   * daemon 全局 OPENCLAW_HOOK_TOKEN 使用（非 master profile 的 openclaw 路由必须走这条）。
   */
  secret?: string;
}

/**
 * 投递结果。四态与 notify.ts 的 mark* 一一对应，语义与阈值保持不变：
 * - sent：2xx，通知标已读；
 * - confirmed_failure：可退避重试的确定性失败（429/5xx/408），走 60s→1h 阶梯；
 * - terminal_failure：4xx/3xx 确定性拒绝，直接终结为 fallback 且不再重投；
 * - transport_failure：网络异常/超时，结果不确定，有限重试且复用同一 request_id。
 */
export type ChannelOutcome =
  | { status: "sent" }
  | { status: "confirmed_failure"; error: string }
  | { status: "terminal_failure"; error: string }
  | { status: "transport_failure"; error: string };

export interface NotificationChannel {
  name: string;
  /** 是否需要 PROFILE_ROUTE_SECRETS_JSON 里的 secret */
  requiresSecret: boolean;
  /** 是否必须有 URL（log 通道不需要） */
  requiresUrl: boolean;
  /** 校验并规范化通道专属路由参数，返回要落库的 URL（不需要 URL 的通道返回空串） */
  validateRoute(input: ChannelRouteInput): string;
  deliver(input: ChannelDeliveryInput): Promise<ChannelOutcome>;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * 已就「隔离用户回退全局 openclaw token」告警过的 profile：投递会随退避阶梯重试，
 * 每轮都告警会把日志刷爆，故每个 profile 只打一次（进程内）。
 */
const warnedGlobalTokenFallback = new Set<string>();

/** 测试用：清空一次性告警去重表（模块级状态，跨用例会互相影响） */
export function resetOpenclawGlobalTokenWarnings(): void {
  warnedGlobalTokenFallback.clear();
}

/**
 * 「隔离用户没有自己的 route secret、只能回退 daemon 全局 OPENCLAW_HOOK_TOKEN」的一次性告警。
 * 投递层（真正投递时）与工具层（notify route 重新启用存量路由时）共用同一份文案与同一张
 * 去重表 —— 两处各写一份，口径迟早漂移，N-2（工具层拒绝启用、投递层却照投）就是这么来的。
 * @returns 是否真的打出了告警（已告警过、或没有全局 token 可回退时为 false）
 */
export function warnOpenclawGlobalTokenFallback(
  profileId: string,
  globalToken: string | undefined,
): boolean {
  if (globalToken === undefined || globalToken === "") return false;
  if (warnedGlobalTokenFallback.has(profileId)) return false;
  warnedGlobalTokenFallback.add(profileId);
  logger.warn(
    `openclaw 投递回退 daemon 全局 OPENCLAW_HOOK_TOKEN：profile "${profileId}" 是隔离用户且没有自己的 route secret` +
      "（该路由多半早于 P2-17 收紧前配置）——建议在 PROFILE_ROUTE_SECRETS_JSON 里为它补 secret，或改用其它通道",
  );
  return true;
}

/** 内置 webhook 通道：投递协议与 v1 完全兼容（对照旧仓库 src/core/notify-delivery.ts 核对） */
export const webhookChannel: NotificationChannel = {
  name: "webhook",
  requiresSecret: true,
  requiresUrl: true,

  validateRoute(input: ChannelRouteInput): string {
    const raw = input.url;
    if (raw === undefined || raw === "") {
      throw new Error("webhook 通道需要 url（127.0.0.1 / localhost / [::1] 回环地址）");
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`推送 URL 不合法: ${raw}`);
    }
    // 只允许 http/https：ftp/file 等协议主机名也能过回环检查，但 fetch 对它们一律失败，
    // 每次都会走满传输重试再进 fallback（用户看到「已配置」却永远收不到推送）。
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`推送 URL 仅支持 http/https: ${raw}`);
    }
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
    if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
      throw new Error(`推送 URL 仅接受 127.0.0.1 / localhost / [::1] 主机名，收到: ${hostname}`);
    }
    return parsed.toString();
  },

  async deliver(input: ChannelDeliveryInput): Promise<ChannelOutcome> {
    const secret = input.secret;
    if (secret === undefined) throw new Error("webhook 通道缺少 secret（不应由本层触发）");

    const payload = JSON.stringify({
      event_type: EVENT_TYPE,
      notification: {
        profileId: input.profileId,
        source: input.kind,
        title: input.title,
        body: input.bodyMd,
        createdAt: input.createdAt,
      },
    });

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");

    try {
      const response = await fetch(input.route.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Timestamp": timestamp,
          "X-Webhook-Signature-V2": signature,
          "X-Request-ID": input.requestId,
        },
        body: payload,
        signal: AbortSignal.timeout(10_000),
        redirect: "manual",
      });
      if (response.body !== null) response.body.cancel().catch(() => {});
      if (response.ok) return { status: "sent" };
      // 确定性拒绝不重试：4xx（408/429 除外）与 3xx 重定向改不了结果，只会在阶梯上耗到
      // 1 小时。3xx 尤其如此：redirect: "manual" 下投递请求根本没有被 webhook 处理，
      // 重试多少次都是同一个重定向。与 QWeather 客户端的「4xx 不重试」保持同一口径。
      const status = response.status;
      const retryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
      const error = `HTTP ${status}`;
      return retryable
        ? { status: "confirmed_failure", error }
        : { status: "terminal_failure", error };
    } catch (e) {
      return { status: "transport_failure", error: e instanceof Error ? e.message : String(e) };
    }
  },
};

/**
 * 本地日志通道：不需要 secret 与 URL，直接把「已投递」写进程日志。
 * 用于本地联调与通道抽象落地；它不构成真正的端到端送达（通知会被标 read，pull 不再返回）。
 */
export const logChannel: NotificationChannel = {
  name: "log",
  requiresSecret: false,
  requiresUrl: false,

  validateRoute(): string {
    // log 通道不落 URL；用户仍传了 url 也忽略（本地联调时不必先清掉旧路由）
    return "";
  },

  deliver(input: ChannelDeliveryInput): Promise<ChannelOutcome> {
    logger.info(
      `[log channel] 通知已投递（本地日志）profile=${input.profileId} kind=${input.kind} ` +
        `title=${input.title} notification=${input.notificationId} request_id=${input.requestId}`,
    );
    return Promise.resolve({ status: "sent" });
  },
};

/** 缺省通道：旧 push_route 没有 channel 字段时按它处理（行为与改造前完全一致） */
export const DEFAULT_CHANNEL = "webhook";

/** 单次投递超时：与 webhook 同口径，超时按「结果不确定」的传输失败处理 */
const DELIVERY_TIMEOUT_MS = 10_000;

/**
 * last_error 会写进 deliveries 并在状态页/日志里展示。上游把错误正文塞得很长时
 * 不该把整行/整张卡片撑爆，统一截断到 500 字符以内。
 */
const MAX_ERROR_LENGTH = 500;

function truncateError(text: string): string {
  return text.length <= MAX_ERROR_LENGTH ? text : `${text.slice(0, MAX_ERROR_LENGTH - 1)}…`;
}

/**
 * bark/ntfy 的路由 URL 规范化（两个通道只有提示文案不同）。
 * 与 webhook 的关键差别：这里的地址在公网（Bark 官方/自建、ntfy.sh/自建），
 * **不**做回环限制 —— webhook 限回环是因为它的 HMAC secret 只该投给本机 Hermes，
 * 而 bark/ntfy 的 URL 本身就是凭据，用户就是要投到公网去。
 */
function normalizePushUrl(label: string, hint: string, raw: string | undefined): string {
  if (raw === undefined || raw === "") {
    throw new Error(`${label} 通道需要 url（${hint}）`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} URL 不合法: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} URL 仅支持 http/https: ${raw}`);
  }
  const serialized = parsed.toString();
  // 去尾斜杠：用户常写成 `.../<topic>/`，而我们是直接 POST 这个地址且不跟随重定向，
  // 多一个尾斜杠在部分服务端会先回 301，于是被当成确定性失败、永远收不到推送。
  // 只在无 query/hash 时剥（`?auth=x/` 这类结尾不能被误删）。
  return parsed.search === "" && parsed.hash === "" ? serialized.replace(/\/+$/, "") : serialized;
}

/**
 * 失败正文只读前 MAX_ERROR_LENGTH 个字符用于排障（Bark/ntfy 都会回 JSON 错误码），
 * 超长正文既不进库也不留在内存里：逐块读够就断开，不等上游写完。
 */
async function readErrorDetail(response: Response): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < MAX_ERROR_LENGTH) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // 读正文失败（对端中途掐断）不影响状态码判定，正文留空即可
  } finally {
    reader.cancel().catch(() => {});
  }
  // 冲掉分块解码残留的半截多字节字符，再折叠换行：last_error 是单行展示，
  // 多行正文会把状态页/日志撑乱
  return `${text}${decoder.decode()}`.trim().replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH);
}

/** 状态码 → 四态（webhook 的错误文案是既有契约 "HTTP <n>"，故未与它共用本函数） */
function outcomeFromStatus(label: string, status: number, detail: string): ChannelOutcome {
  if (status >= 200 && status <= 299) return { status: "sent" };
  const error = truncateError(`${label} 返回 HTTP ${status}${detail === "" ? "" : `：${detail}`}`);
  // 408/429/5xx 是「服务端此刻不行」，退避后重试有意义；其余 3xx/4xx 重试也改不了结果
  const retryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
  return retryable ? { status: "confirmed_failure", error } : { status: "terminal_failure", error };
}

/** 网络/超时 → 传输失败（结果不确定，由 outbox 决定重试几次） */
function transportOutcome(label: string, e: unknown): ChannelOutcome {
  const message = e instanceof Error ? e.message : String(e);
  // AbortSignal.timeout 抛的是 TimeoutError，裸 message 是英文，换成中文更直观
  const reason =
    e instanceof Error && e.name === "TimeoutError"
      ? `请求超时（${DELIVERY_TIMEOUT_MS / 1000}s）`
      : message;
  return { status: "transport_failure", error: truncateError(`${label} 投递失败：${reason}`) };
}

/**
 * POST 一次投递并按状态码映射结果。
 * redirect: "manual" 与 webhook 同口径：3xx 说明请求没有被目标服务处理，跟随重定向
 * 会让「投递成功」取决于中间跳转，重试多少次都是同一个重定向。
 */
async function postDelivery(
  label: string,
  url: string,
  headers: Record<string, string>,
  body: string,
): Promise<ChannelOutcome> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      redirect: "manual",
    });
    if (response.ok) {
      // 成功响应体不需要，直接释放连接（与 webhook 一致）
      if (response.body !== null) response.body.cancel().catch(() => {});
      return { status: "sent" };
    }
    return outcomeFromStatus(label, response.status, await readErrorDetail(response));
  } catch (e) {
    return transportOutcome(label, e);
  }
}

/**
 * OpenClaw Gateway hooks 通道：route.url 是本机 Gateway 的 hook 地址，路径限定在
 * `/hooks/<name>`（回环地址上还有大量别的本地服务，允许任意路径等于把 hooks token
 * 交给任意本地服务的配置面）。
 *
 * 凭据优先级（P2-17 的凭据边界）：
 * 1. profile 自己的 `PROFILE_ROUTE_SECRETS_JSON[profile]`（有值时用它）；
 * 2. 缺省才回退 daemon 环境里的全局 `OPENCLAW_HOOK_TOKEN` —— 该 token 属于运维者，
 *    只有部署自身 profile（HERMES_PROFILE）或未登记独立 token 的 profile 能回退；
 *    隔离用户（登记了 Profile token 且非部署自身 profile）的配置入口会要求它先提供
 *    独立 secret，不会把全局 token 投到它自己填的回环地址。
 * token 不进入路由或数据库，每次投递时读取；缺失时只终结本次投递，不影响 daemon 启动，
 * 也不改变 webhook 的 HMAC V2 协议。
 */
/**
 * 直连 /hooks/agent 的目标：agent/channel/to/accountId 写在路由 URL 的 query 上。
 * hook 映射（/hooks/<name>）不暴露 accountId，多账号通道（微信/QQ）必须走直连，
 * 否则会从默认账号发出，收件人会话不匹配时静默失败。
 */
interface OpenclawDirectTarget {
  agentId?: string;
  channel: string;
  to: string;
  accountId?: string;
}

/**
 * 识别「直连 /hooks/agent」路由：路径以 /hooks/agent 结尾且带 channel/to query。
 * 非直连（如 /hooks/life-bestie 映射）返回 null，继续走映射式投递。
 */
function parseOpenclawDirectTarget(rawUrl: string): OpenclawDirectTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!parsed.pathname.replace(/\/+$/, "").endsWith("/hooks/agent")) return null;
  const channel = parsed.searchParams.get("channel")?.trim() ?? "";
  const to = parsed.searchParams.get("to")?.trim() ?? "";
  if (channel === "" || to === "") return null;
  const agentId = parsed.searchParams.get("agentId")?.trim() || undefined;
  const accountId = parsed.searchParams.get("accountId")?.trim() || undefined;
  return { channel, to, ...(agentId ? { agentId } : {}), ...(accountId ? { accountId } : {}) };
}

/** 直连投递时给 agent 的指令：明确要求原样发送，否则模型可能回静默、投递被吞 */
function openclawDirectMessage(input: ChannelDeliveryInput): string {
  return `【life-assistant 主动通知】请把下面这条通知原样发送给用户：保留标题与正文，不要添加任何评论，不要调用工具，不要回复 NO_REPLY。\n\n${input.title}\n\n${input.bodyMd}`;
}

export const openclawChannel: NotificationChannel = {
  name: "openclaw",
  // 凭据可以来自 profile secret，也可以来自 master 的全局 OPENCLAW_HOOK_TOKEN：
  // 后者在核心层（core/notify.ts 只检查 requiresSecret）看不见，所以「缺凭据不入队」
  // 不能交给核心层判定，改由 notify route 的 master 口径在配置时把关（P2-17）。
  requiresSecret: false,
  requiresUrl: true,

  validateRoute(input: ChannelRouteInput): string {
    const raw = input.url;
    if (raw === undefined || raw === "") {
      throw new Error("openclaw 通道需要 url（127.0.0.1 / localhost / [::1] 回环地址）");
    }
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error(`openclaw URL 不合法: ${raw}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`openclaw URL 仅支持 http/https: ${raw}`);
    }
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
    if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
      throw new Error(
        `openclaw URL 仅接受 127.0.0.1 / localhost / [::1] 主机名，收到: ${hostname}`,
      );
    }
    // 路径收紧：只接受 Gateway 的 hook 前缀。去掉尾部斜杠后必须以 /hooks/<name> 开头，
    // 裸 `/hooks` 或 `/hooks/`（没有 hook 名）同样拒绝 —— 它们只会得到 Gateway 的 404，
    // 却会让用户以为「已配置」。
    const path = parsed.pathname.replace(/\/+$/, "");
    if (!path.startsWith("/hooks/")) {
      throw new Error(
        `openclaw URL 路径必须是 /hooks/<name>（如 http://127.0.0.1:18789/hooks/life-default 或 /hooks/agent?channel=&to=），收到: ${parsed.pathname}`,
      );
    }
    const serialized = parsed.toString();
    // 与 bark/ntfy 一样只在无 query/hash 时去尾斜杠，避免改动 query/hash 的内容。
    return parsed.search === "" && parsed.hash === "" ? serialized.replace(/\/+$/, "") : serialized;
  },

  async deliver(input: ChannelDeliveryInput): Promise<ChannelOutcome> {
    // 凭据来源：profile 自己的 secret 优先（非 master 路由必须走这条，绝不回退全局 token），
    // 只有 master 配置的路由（没有 profile secret）才用 daemon 的全局 OPENCLAW_HOOK_TOKEN。
    const profileSecret = input.secret?.trim();
    const hasProfileSecret = profileSecret !== undefined && profileSecret !== "";
    const globalToken = process.env.OPENCLAW_HOOK_TOKEN?.trim();
    const token = hasProfileSecret ? profileSecret : globalToken;
    if (!token) {
      return {
        status: "terminal_failure",
        error:
          `openclaw 通道缺少凭据：PROFILE_ROUTE_SECRETS_JSON 中没有 profile "${input.profileId}" 的 secret，` +
          "daemon 也未配置 OPENCLAW_HOOK_TOKEN（部署自身 profile 的路由在 daemon 的 .env 里配置 OpenClaw hooks.token）",
      };
    }
    // 隔离用户（登记了 Profile token 且非部署自身 profile）没有自己的 secret、实际回退了
    // 全局 token：这通常是收紧前落库的路由。只告警一次（每个 profile），**不**拒绝投递 ——
    // 拒绝会打断既有推送，需人工确认后再补 secret 或改通道。工具层「重新启用」走同一个函数。
    if (
      !hasProfileSecret &&
      globalToken !== undefined &&
      !canUseGlobalOpenclawTokenFromEnv(input.profileId)
    ) {
      warnOpenclawGlobalTokenFallback(input.profileId, globalToken);
    }

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "X-Request-ID": input.requestId,
      "Idempotency-Key": input.requestId,
    };

    // 直连 /hooks/agent：目标写在 URL query 上，可带 accountId（多账号通道必需）。
    const direct = parseOpenclawDirectTarget(input.route.url);
    if (direct !== null) {
      const body = JSON.stringify({
        message: openclawDirectMessage(input),
        name: "life-assistant",
        sessionMode: "isolated",
        deliver: true,
        channel: direct.channel,
        to: direct.to,
        ...(direct.agentId === undefined ? {} : { agentId: direct.agentId }),
        ...(direct.accountId === undefined ? {} : { accountId: direct.accountId }),
        idempotencyKey: input.requestId,
      });
      return postDelivery("openclaw", input.route.url, headers, body);
    }

    const payload = JSON.stringify({
      event_type: EVENT_TYPE,
      notification: {
        profileId: input.profileId,
        source: input.kind,
        title: input.title,
        body: input.bodyMd,
        createdAt: input.createdAt,
      },
    });
    return postDelivery("openclaw", input.route.url, headers, payload);
  },
};

/**
 * Bark 通道（iOS 推送）：route.url 是 Bark 基地址 `https://api.day.app/<device_key>`
 * （自建服务器同理，只要形如 `https://<host>/<device_key>`）。
 * 官方协议：POST 该地址，JSON `{title, body, group, level}`。
 * - group 固定成 life-assistant：通知中心里能一眼看出是本服务发的；
 * - level=active 让提醒立即横幅+响铃（passive 会被静默，日程提醒失去意义）。
 */
export const barkChannel: NotificationChannel = {
  name: "bark",
  requiresSecret: false,
  requiresUrl: true,

  validateRoute(input: ChannelRouteInput): string {
    return normalizePushUrl("bark", "如 https://api.day.app/<device_key>", input.url);
  },

  deliver(input: ChannelDeliveryInput): Promise<ChannelOutcome> {
    const payload = JSON.stringify({
      title: input.title,
      body: input.bodyMd,
      group: "life-assistant",
      level: "active",
    });
    return postDelivery("Bark", input.route.url, { "Content-Type": "application/json" }, payload);
  },
};

/** Node 的 fetch（undici）只接受 ByteString（码点 ≤0xFF）的 header 值 */
const ASCII_HEADER_RE = /^[\x20-\x7e]*$/;

/**
 * ntfy 的 Title 头。
 *
 * 实测（Node 26）：header 值含中文时 fetch 直接抛
 * `TypeError: Cannot convert argument to a ByteString because the character at index 0
 * has a value of 20013 which is greater than 255` —— 通知连发都发不出去。
 * ntfy 官方文档明确支持把 header 值写成 RFC 2047 编码（`=?UTF-8?B?<base64>?=`），
 * 因此对非 ASCII 标题做 base64 编码，而不是丢成 ASCII 或只把标题塞进正文：
 * 客户端解码后仍是原文，且正文里本来就带着标题，任何一端都不会丢信息。
 * （含 CR/LF 的标题也会落到这个分支，顺带挡住 header 注入。）
 */
function ntfyTitleHeader(title: string): string {
  return ASCII_HEADER_RE.test(title)
    ? title
    : `=?UTF-8?B?${Buffer.from(title, "utf8").toString("base64")}?=`;
}

/**
 * ntfy 通道：route.url 是 topic 地址（`https://ntfy.sh/<topic>` 或自建服务器的
 * `https://<host>/<topic>`）。官方协议：POST 纯文本正文，标题/优先级/标签走 header。
 * 正文用 `${title}\n\n${bodyMd}`：即使某些客户端不认 Title 头，标题也不会丢。
 */
export const ntfyChannel: NotificationChannel = {
  name: "ntfy",
  requiresSecret: false,
  requiresUrl: true,

  validateRoute(input: ChannelRouteInput): string {
    return normalizePushUrl("ntfy", "如 https://ntfy.sh/<topic>", input.url);
  },

  deliver(input: ChannelDeliveryInput): Promise<ChannelOutcome> {
    return postDelivery(
      "ntfy",
      input.route.url,
      {
        "Content-Type": "text/plain; charset=utf-8",
        Title: ntfyTitleHeader(input.title),
        Priority: "default",
        Tags: "life-assistant",
      },
      `${input.title}\n\n${input.bodyMd}`,
    );
  },
};

/**
 * Telegram 通道：route.url 形如
 * `https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>`（自建 Bot API 服务器也允许，
 * 只要是 http(s)）。token 与 chat_id 都在 URL 里 —— 与 bark/ntfy 同理，URL 即凭据。
 *
 * 为什么 chat_id 必须在 validateRoute 就校验：投递时才发现的坏路由只剩 fallback，
 * 用户在状态页只看到「投递失败」，看不出是配置漏了。chat_id 允许数字（含负数群组 id）
 * 或 `@频道名`。
 */
const TELEGRAM_CHAT_ID_RE = /^@?[A-Za-z0-9_-]{1,64}$/;
/** Telegram 单条消息上限 4096 个 UTF-16 码元；超限会被 400 拒收（整条通知丢失） */
const TELEGRAM_MAX_TEXT = 4096;

/** 解析并规范化 Telegram 路由 URL（校验失败抛中文错误，由 setPushRoute 在使用前拦住） */
function telegramUrl(raw: string | undefined): URL {
  if (raw === undefined || raw === "") {
    throw new Error(
      "telegram 通道需要 url（如 https://api.telegram.org/bot<token>/sendMessage?chat_id=<id>）",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`telegram URL 不合法: ${raw}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`telegram URL 仅支持 http/https: ${raw}`);
  }
  if (parsed.hostname === "") throw new Error(`telegram URL 缺少 host: ${raw}`);
  const chatId = (parsed.searchParams.get("chat_id") ?? "").trim();
  if (!TELEGRAM_CHAT_ID_RE.test(chatId)) {
    throw new Error("telegram URL 缺少合法的 chat_id（?chat_id=<数字或 @频道名>）");
  }
  // 去路径尾斜杠、保留 query：用户照抄文档常多打一个 `/`，部分反代/自建 Bot API 对
  // `/sendMessage/` 会回 301，而我们不跟随重定向 → 会被判成确定性失败。
  const path = parsed.pathname.replace(/\/+$/, "");
  if (path !== "") parsed.pathname = path;
  return parsed;
}

/** 超过 Telegram 上限就截断：整条被拒等于什么都收不到，截断后至少前半段能送达 */
function truncateTelegramText(text: string): string {
  if (text.length <= TELEGRAM_MAX_TEXT) return text;
  const suffix = "\n\n…（已截断）";
  const cut = text.slice(0, TELEGRAM_MAX_TEXT - suffix.length);
  // 不要切在代理对中间（尾部留半个 emoji 会变成非法 UTF-16 / 显示成问号）
  return `${cut.replace(/[\uD800-\uDBFF]$/, "")}${suffix}`;
}

export const telegramChannel: NotificationChannel = {
  name: "telegram",
  requiresSecret: false,
  requiresUrl: true,

  validateRoute(input: ChannelRouteInput): string {
    return telegramUrl(input.url).toString();
  },

  deliver(input: ChannelDeliveryInput): Promise<ChannelOutcome> {
    let parsed: URL;
    try {
      parsed = telegramUrl(input.route.url);
    } catch (e) {
      // 入库后路由被手工改坏：按确定性失败处理，不让 drain 抛错卡住其它 Profile
      return Promise.resolve({
        status: "terminal_failure",
        error: truncateError(`telegram 路由不合法：${e instanceof Error ? e.message : String(e)}`),
      });
    }
    const chatId = (parsed.searchParams.get("chat_id") ?? "").trim();
    // 纯数字（含负数的群组 id）发整数：Bot API 两种都收，但整数形式在日志/回执里更直观
    const chatIdValue = /^-?\d+$/.test(chatId) ? Number(chatId) : chatId;
    return postDelivery(
      "Telegram",
      parsed.toString(),
      { "Content-Type": "application/json" },
      JSON.stringify({
        chat_id: chatIdValue,
        text: truncateTelegramText(`${input.title}\n\n${input.bodyMd}`),
      }),
    );
  },
};

/**
 * SMTP 邮件通道：route.url 形如
 * `smtp://user:pass@host:587?from=me@example.com&to=you@example.com`（`to` 可重复）。
 * 协议实现（EHLO/STARTTLS/AUTH/MAIL FROM/RCPT TO/DATA）在 core/smtp.ts，本通道只做映射：
 * 通知标题 → Subject（RFC 2047 编码中文），通知正文 → text/plain 正文。
 *
 * 注意：密码在 URL 里，会随 push_route 一起落库并出现在 `notify route` 的回显里 ——
 * 与 bark/ntfy 的「URL 即凭据」同一取舍；文档里提醒用户不要把带密码的 URL 贴给别人。
 */
export const smtpChannel: NotificationChannel = {
  name: "smtp",
  requiresSecret: false,
  requiresUrl: true,

  validateRoute(input: ChannelRouteInput): string {
    return parseSmtpRouteUrl(input.url).url;
  },

  async deliver(input: ChannelDeliveryInput): Promise<ChannelOutcome> {
    let route: SmtpRoute;
    try {
      route = parseSmtpRouteUrl(input.route.url);
    } catch (e) {
      return {
        status: "terminal_failure",
        error: truncateError(`smtp 路由不合法：${e instanceof Error ? e.message : String(e)}`),
      };
    }
    const result = await sendSmtpMail(route, { subject: input.title, body: input.bodyMd });
    return result.ok ? { status: "sent" } : { status: result.status, error: result.error };
  },
};

const CHANNELS: readonly NotificationChannel[] = [
  webhookChannel,
  logChannel,
  barkChannel,
  ntfyChannel,
  telegramChannel,
  smtpChannel,
  openclawChannel,
];
const BY_NAME = new Map(CHANNELS.map((channel) => [channel.name, channel]));

/** 支持的内置通道名（工具 schema / 报错文案共用，避免两处清单漂移） */
export function supportedChannels(): string[] {
  return CHANNELS.map((channel) => channel.name);
}

/** 严格取通道：用户输入用这个，未知通道名直接报错 */
export function getChannel(name: string | undefined): NotificationChannel {
  const channelName = name?.trim() || DEFAULT_CHANNEL;
  const channel = BY_NAME.get(channelName);
  if (channel === undefined) {
    throw new Error(`不支持的推送通道: ${channelName}（可选: ${supportedChannels().join(" / ")}）`);
  }
  return channel;
}

/**
 * 宽松取通道：库里的 channel 可能来自手工改库或降级回滚。未知通道按「路由不可用」处理，
 * 让该 Profile 的投递行停在队列里，而不是让每轮 drain 在 getChannel 上抛错、
 * 卡住排在它后面的所有 Profile。
 */
export function findChannel(name: string | undefined): NotificationChannel | null {
  return BY_NAME.get(name?.trim() || DEFAULT_CHANNEL) ?? null;
}
