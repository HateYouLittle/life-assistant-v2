import { createHmac } from "node:crypto";
import {
  canUseGlobalOpenclawTokenFromEnv,
  type OpenclawProfileTarget,
  resolveOpenclawCredentialSource,
} from "../config.js";
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
 * 凭据边界：webhook 与 openclaw 都会把凭据发到「用户自己填的回环 URL」。webhook 只认
 * PROFILE_ROUTE_SECRETS_JSON[profile]（requiresSecret）。openclaw 的隔离优先靠**目标绑定**：
 * 登记 OPENCLAW_PROFILE_TARGETS_JSON 后，token 可以共享，但 URL 必须与登记的
 * agentId/channel/to/accountId 逐项一致，不能改投；只有目标 auth=profile 才用该 Profile 的
 * secret。未登记目标的旧部署保留 P2-17 的 profile secret 优先 / 部署自身 profile 回退全局
 * token 行为（由 config.ts 的 canUseGlobalOpenclawToken 判定）。路径收紧到 /hooks/ 前缀。
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
  /** openclaw 目标绑定（OPENCLAW_PROFILE_TARGETS_JSON；未登记时为 undefined，保留旧行为） */
  openclawTarget?: OpenclawProfileTarget;
  /** openclaw 全局 token（ResolvedConfig.openclawHookToken；未传时回退 process.env） */
  openclawGlobalToken?: string;
  /** openclaw 直连是否等待 completion.delivered（目标/环境变量决定） */
  openclawWaitForCompletion?: boolean;
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
 * 只读前 maxChars 个字符的响应体（失败正文排障、OpenClaw 的 completion 解析共用）。
 * 超长正文既不进库也不留在内存里：逐块读够就断开，不等上游写完。
 */
async function readBodyText(response: Response, maxChars: number): Promise<string> {
  const body = response.body;
  if (body === null) return "";
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    // 读正文失败（对端中途掐断）不影响状态码判定，正文留空即可
  } finally {
    reader.cancel().catch(() => {});
  }
  // 冲掉分块解码残留的半截多字节字符
  return `${text}${decoder.decode()}`.slice(0, maxChars);
}

/**
 * 失败正文只读前 MAX_ERROR_LENGTH 个字符用于排障（Bark/ntfy 都会回 JSON 错误码）。
 * last_error 是单行展示，多行正文会把状态页/日志撑乱，故折叠空白。
 */
async function readErrorDetail(response: Response): Promise<string> {
  const text = await readBodyText(response, MAX_ERROR_LENGTH);
  return text.trim().replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH);
}

/** 状态码 → 四态（webhook 的错误文案是既有契约 "HTTP <n>"，故未与它共用本函数） */
function outcomeFromStatus(
  label: string,
  status: number,
  detail: string,
  extraRetryable?: ReadonlySet<number>,
): ChannelOutcome {
  if (status >= 200 && status <= 299) return { status: "sent" };
  const error = truncateError(`${label} 返回 HTTP ${status}${detail === "" ? "" : `：${detail}`}`);
  // 408/429/5xx 是「服务端此刻不行」，退避后重试有意义；其余 3xx/4xx 重试也改不了结果。
  // OpenClaw 的 409（配置热更新）是例外，由调用方通过 extraRetryable 显式放行。
  const retryable =
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599) ||
    extraRetryable?.has(status) === true;
  return retryable ? { status: "confirmed_failure", error } : { status: "terminal_failure", error };
}

/** 网络/超时 → 传输失败（结果不确定，由 outbox 决定重试几次） */
function transportOutcome(
  label: string,
  e: unknown,
  timeoutMs: number = DELIVERY_TIMEOUT_MS,
): ChannelOutcome {
  const message = e instanceof Error ? e.message : String(e);
  // AbortSignal.timeout 抛的是 TimeoutError，裸 message 是英文，换成中文更直观
  const reason =
    e instanceof Error && e.name === "TimeoutError" ? `请求超时（${timeoutMs / 1000}s）` : message;
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

const OPENCLAW_HOOKS_PREFIX = "/hooks";
const OPENCLAW_DIRECT_PATH = `${OPENCLAW_HOOKS_PREFIX}/agent`;
const OPENCLAW_DIRECT_QUERY_KEYS = new Set(["channel", "to", "agentId", "accountId"]);
/** OpenClaw 在配置热更新时回 409 并要求 retry；不要按普通 4xx 终结。 */
const OPENCLAW_RETRYABLE_STATUSES = new Set([409]);
const OPENCLAW_SUCCESS_BODY_LIMIT = 64 * 1024;
/** waitForCompletion=true 时给 agent 一轮执行留的时间（客户端比它多 5s 上界）。 */
const OPENCLAW_WAIT_AGENT_TIMEOUT_SECONDS = 25;
const OPENCLAW_WAIT_TIMEOUT_MS = 30_000;

/**
 * 直连 /hooks/agent 的目标：agent/channel/to/accountId 写在路由 URL 的 query 上。
 * hook 映射（/hooks/<name>）不暴露 accountId，多账号通道（微信/QQ）必须走直连，
 * 否则会从默认账号发出，收件人会话不匹配时静默失败。
 */
interface OpenclawDirectEndpoint {
  agentId?: string;
  channel: string;
  to: string;
  accountId?: string;
}

function openclawPath(rawPath: string): string {
  return rawPath.replace(/\/+$/, "");
}

/** 识别「直连 /hooks/agent」路由；非直连返回 null，继续走映射式投递。 */
function parseOpenclawDirectEndpoint(rawUrl: string): OpenclawDirectEndpoint | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  if (openclawPath(parsed.pathname) !== OPENCLAW_DIRECT_PATH) return null;
  const channel = parsed.searchParams.get("channel")?.trim() ?? "";
  const to = parsed.searchParams.get("to")?.trim() ?? "";
  if (channel === "" || to === "") return null;
  const agentId = parsed.searchParams.get("agentId")?.trim() || undefined;
  const accountId = parsed.searchParams.get("accountId")?.trim() || undefined;
  return { channel, to, ...(agentId ? { agentId } : {}), ...(accountId ? { accountId } : {}) };
}

/**
 * 用登记目标拼出可落库的 openclaw 路由 URL。
 * `notify route {channel:"openclaw"}` 不传 URL 时走这里，避免用户复制错目标。
 */
export function buildOpenclawRouteUrl(
  target: OpenclawProfileTarget,
  defaultBaseUrl: string,
): string {
  const baseUrl = target.baseUrl || defaultBaseUrl;
  if (target.mode === "mapping") return `${baseUrl}${OPENCLAW_HOOKS_PREFIX}/${target.hook}`;
  const url = new URL(`${baseUrl}${OPENCLAW_DIRECT_PATH}`);
  url.searchParams.set("channel", target.channel);
  url.searchParams.set("to", target.to);
  if (target.agentId !== undefined) url.searchParams.set("agentId", target.agentId);
  if (target.accountId !== undefined) url.searchParams.set("accountId", target.accountId);
  return url.toString();
}

/**
 * 目标绑定：URL 必须与 OPENCLAW_PROFILE_TARGETS_JSON 登记的逐项一致。
 * 这是 shared-trust 模式下「消息进入正确地方」的核心 —— token 可以共享，目标不能改。
 */
/** 把回环别名归一成同一个 origin 视图，用于比较 baseUrl 与路由 URL。 */
function loopbackOrigin(raw: string): { protocol: string; host: string; port: string } {
  const parsed = new URL(raw);
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  return {
    protocol: parsed.protocol,
    host: host === "localhost" || host === "::1" ? "127.0.0.1" : host,
    port: parsed.port || (parsed.protocol === "https:" ? "443" : "80"),
  };
}

/** query 参数重复时，不同实现可能取第一个或最后一个；目标绑定不能容忍这种歧义。 */
function assertNoDuplicateQueryKeys(parsed: URL, label: string): void {
  const seen = new Set<string>();
  for (const key of parsed.searchParams.keys()) {
    if (seen.has(key)) throw new Error(`${label} 不允许重复 query 参数: ${key}`);
    seen.add(key);
  }
}

export function assertOpenclawRouteMatchesTarget(
  url: string,
  target: OpenclawProfileTarget,
  profileId: string,
): void {
  const parsed = new URL(url);
  if (parsed.username !== "" || parsed.password !== "" || parsed.hash !== "") {
    throw new Error(
      `openclaw 路由目标与 OPENCLAW_PROFILE_TARGETS_JSON.${profileId} 不一致：URL 不允许用户名/密码或 # 片段`,
    );
  }
  const rawHost = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (!LOOPBACK_HOSTS.has(rawHost)) {
    throw new Error(
      `openclaw 路由目标与 OPENCLAW_PROFILE_TARGETS_JSON.${profileId} 不一致：只接受回环地址（127.0.0.1 / localhost / [::1]），收到 ${rawHost}`,
    );
  }
  const expectedOrigin = loopbackOrigin(target.baseUrl);
  if (!LOOPBACK_HOSTS.has(expectedOrigin.host)) {
    throw new Error(
      `openclaw 路由目标与 OPENCLAW_PROFILE_TARGETS_JSON.${profileId} 不一致：登记的 baseUrl 必须是回环地址，收到 ${target.baseUrl}`,
    );
  }
  const actualOrigin = loopbackOrigin(url);
  if (
    actualOrigin.protocol !== expectedOrigin.protocol ||
    actualOrigin.host !== expectedOrigin.host ||
    actualOrigin.port !== expectedOrigin.port
  ) {
    throw new Error(
      `openclaw 路由目标与 OPENCLAW_PROFILE_TARGETS_JSON.${profileId} 不一致：origin 必须是 ` +
        `${expectedOrigin.protocol}//${expectedOrigin.host}:${expectedOrigin.port}，收到 ` +
        `${actualOrigin.protocol}//${actualOrigin.host}:${actualOrigin.port}（不能把共享 token 投到别的端口/主机）`,
    );
  }
  assertNoDuplicateQueryKeys(
    parsed,
    `openclaw 路由目标与 OPENCLAW_PROFILE_TARGETS_JSON.${profileId} 不一致：`,
  );
  const path = openclawPath(parsed.pathname);
  if (parsed.searchParams.has("token")) {
    throw new Error(
      `openclaw 路由目标与 OPENCLAW_PROFILE_TARGETS_JSON.${profileId} 不一致：不接受 ?token=，凭据必须走 Authorization 头`,
    );
  }
  if (target.mode === "mapping") {
    const expected = `${OPENCLAW_HOOKS_PREFIX}/${target.hook}`;
    if (path !== expected) {
      throw new Error(
        `openclaw 路由目标与 OPENCLAW_PROFILE_TARGETS_JSON.${profileId} 不一致：路径必须是 ${expected}，收到 ${path}`,
      );
    }
    return;
  }
  if (path !== OPENCLAW_DIRECT_PATH) {
    throw new Error(
      `openclaw 路由目标与 OPENCLAW_PROFILE_TARGETS_JSON.${profileId} 不一致：直连模式路径必须是 ${OPENCLAW_DIRECT_PATH}，收到 ${path}`,
    );
  }
  const actual = {
    channel: parsed.searchParams.get("channel")?.trim() ?? "",
    to: parsed.searchParams.get("to")?.trim() ?? "",
    agentId: parsed.searchParams.get("agentId")?.trim() || undefined,
    accountId: parsed.searchParams.get("accountId")?.trim() || undefined,
  };
  const mismatched: string[] = [];
  if (actual.channel !== target.channel) mismatched.push("channel");
  if (actual.to !== target.to) mismatched.push("to");
  if (actual.agentId !== target.agentId) mismatched.push("agentId");
  if (actual.accountId !== target.accountId) mismatched.push("accountId");
  for (const key of parsed.searchParams.keys()) {
    if (!OPENCLAW_DIRECT_QUERY_KEYS.has(key)) mismatched.push(`未知参数 ${key}`);
  }
  if (mismatched.length > 0) {
    throw new Error(
      `openclaw 路由目标与 OPENCLAW_PROFILE_TARGETS_JSON.${profileId} 不一致：${mismatched.join("、")}` +
        "（目标由服务端登记，不能通过改 URL 改投）",
    );
  }
}

/** 直连投递时给 agent 的指令：明确要求原样发送，否则模型可能回静默、投递被吞 */
function openclawDirectMessage(input: ChannelDeliveryInput): string {
  return `【life-assistant 主动通知】请把下面这条通知原样发送给用户：保留标题与正文，不要添加任何评论，不要调用工具，不要回复 NO_REPLY。\n\n${input.title}\n\n${input.bodyMd}`;
}

/** 401/400 是 openclaw 最常见的两类配置错误，给一条能直接照做的提示。 */
function annotateOpenclawOutcome(outcome: ChannelOutcome): ChannelOutcome {
  if (outcome.status !== "terminal_failure" && outcome.status !== "confirmed_failure") {
    return outcome;
  }
  let error = outcome.error;
  if (/HTTP 401\b/.test(error)) {
    error +=
      "（OpenClaw 只认该 Gateway 的 hooks.token；per-profile secret 仅适用于每个用户自己的 Gateway）";
  }
  if (/HTTP 400\b/.test(error) && /message required/i.test(error)) {
    error += "（/hooks/agent 直连需要 channel/to；缺少时会退回映射载荷并被拒）";
  }
  return { ...outcome, error: truncateError(error) };
}

interface OpenclawPostResult {
  outcome: ChannelOutcome;
  body: unknown;
}

/** openclaw 投递：成功时读回响应体，供 waitForCompletion 解析 completion。 */
async function postOpenclawDelivery(
  url: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
): Promise<OpenclawPostResult> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "manual",
    });
    if (response.ok) {
      const text = await readBodyText(response, OPENCLAW_SUCCESS_BODY_LIMIT);
      let parsed: unknown;
      if (text.trim() !== "") {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = undefined;
        }
      }
      return { outcome: { status: "sent" }, body: parsed };
    }
    const detail = await readErrorDetail(response);
    return {
      outcome: annotateOpenclawOutcome(
        outcomeFromStatus("openclaw", response.status, detail, OPENCLAW_RETRYABLE_STATUSES),
      ),
      body: undefined,
    };
  } catch (e) {
    return {
      outcome: annotateOpenclawOutcome(transportOutcome("openclaw", e, timeoutMs)),
      body: undefined,
    };
  }
}

interface OpenclawCompletion {
  status?: string;
  delivered?: boolean;
  deliveryAttempted?: boolean;
  deliveryError?: string;
  deliverySuppressionReason?: string;
  replyDisposition?: string;
}

function readOpenclawString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

function readOpenclawCompletion(body: unknown): OpenclawCompletion | null {
  if (typeof body !== "object" || body === null) return null;
  const completion = (body as Record<string, unknown>).completion;
  if (typeof completion !== "object" || completion === null) return null;
  const value = completion as Record<string, unknown>;
  const status = readOpenclawString(value, "status");
  const deliveryError = readOpenclawString(value, "deliveryError");
  const deliverySuppressionReason = readOpenclawString(value, "deliverySuppressionReason");
  const replyDisposition = readOpenclawString(value, "replyDisposition");
  return {
    ...(status === undefined ? {} : { status }),
    ...(typeof value.delivered === "boolean" ? { delivered: value.delivered } : {}),
    ...(typeof value.deliveryAttempted === "boolean"
      ? { deliveryAttempted: value.deliveryAttempted }
      : {}),
    ...(deliveryError === undefined ? {} : { deliveryError }),
    ...(deliverySuppressionReason === undefined ? {} : { deliverySuppressionReason }),
    ...(replyDisposition === undefined ? {} : { replyDisposition }),
  };
}

function openclawRunId(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  return readOpenclawString(body as Record<string, unknown>, "runId");
}

/**
 * waitForCompletion=true 时，200 只代表 agent 跑完；只有 completion.delivered=true
 * 才算真的送达。NO_REPLY / silent 抑制 / 通道投递失败都必须让通知保持未读，
 * 否则用户既收不到、notify.pull 也捞不回来。
 */
function openclawCompletionOutcome(completion: OpenclawCompletion): ChannelOutcome {
  if (completion.delivered === true) return { status: "sent" };
  const reason =
    completion.deliverySuppressionReason ??
    completion.deliveryError ??
    completion.replyDisposition ??
    completion.status;
  if (completion.deliverySuppressionReason !== undefined) {
    return {
      status: "terminal_failure",
      error: truncateError(`openclaw 抑制了本次投递：${completion.deliverySuppressionReason}`),
    };
  }
  if (completion.deliveryError !== undefined) {
    return {
      status: "confirmed_failure",
      error: truncateError(`openclaw 投递失败：${completion.deliveryError}`),
    };
  }
  if (completion.status !== undefined && completion.status !== "ok") {
    return {
      status: "confirmed_failure",
      error: truncateError(`openclaw agent 运行未成功：${completion.status}`),
    };
  }
  return {
    status: "terminal_failure",
    error: truncateError(`openclaw 未确认送达（${reason ?? "completion.delivered 不是 true"}）`),
  };
}

function finishOpenclawDelivery(
  input: ChannelDeliveryInput,
  result: OpenclawPostResult,
  waitForCompletion: boolean,
): ChannelOutcome {
  const runId = openclawRunId(result.body);
  if (runId !== undefined) {
    logger.debug(`openclaw 投递 ${input.requestId} 已受理 runId=${runId}`);
  }
  if (!waitForCompletion || result.outcome.status !== "sent") return result.outcome;
  const completion = readOpenclawCompletion(result.body);
  if (completion === null) {
    logger.warn(`openclaw 投递 ${input.requestId} 等待完成但响应缺少 completion`);
    return {
      status: "terminal_failure",
      error: "openclaw 未返回 completion，无法确认送达",
    };
  }
  const outcome = openclawCompletionOutcome(completion);
  if (outcome.status !== "sent") {
    logger.warn(`openclaw 投递 ${input.requestId} 未送达：${outcome.error}`);
  }
  return outcome;
}

/**
 * OpenClaw Gateway hooks 通道：route.url 是本机 Gateway 的 hook 地址，路径限定在
 * `/hooks/<name>`（回环地址上还有大量别的本地服务，允许任意路径等于把 hooks token
 * 交给任意本地服务的配置面）。
 *
 * 凭据与隔离：
 * - 登记了 OPENCLAW_PROFILE_TARGETS_JSON 的 Profile 走「目标绑定」：token 可用共享的
 *   OPENCLAW_HOOK_TOKEN，但 URL 必须与登记目标逐项一致，不能改投到别的 agent/聊天；
 * - 未登记目标的旧部署保留 P2-17 行为：profile secret 优先，只有部署自身 profile /
 *   未登记独立 token 的 profile 才回退全局 token；
 * - 目标登记了 auth=profile 时只认该 Profile 的 secret（用于每个用户自己的 Gateway）。
 * token 不进入路由或数据库，每次投递时读取；缺失时只终结本次投递，不影响 daemon 启动，
 * 也不改变 webhook 的 HMAC V2 协议。
 */
export const openclawChannel: NotificationChannel = {
  name: "openclaw",
  // 凭据来源由 openclawTarget / secret / 全局 token 共同决定，见 resolveOpenclawCredentialSource。
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
    if (parsed.username !== "" || parsed.password !== "") {
      throw new Error("openclaw URL 不允许包含用户名/密码（凭据走 Authorization: Bearer）");
    }
    if (parsed.hash !== "") {
      throw new Error("openclaw URL 不允许包含 # 片段");
    }
    if (parsed.searchParams.has("token")) {
      throw new Error("openclaw 不接受 ?token=：凭据必须走 Authorization: Bearer 头");
    }
    assertNoDuplicateQueryKeys(parsed, "openclaw URL");
    const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
    if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
      throw new Error(
        `openclaw URL 仅接受 127.0.0.1 / localhost / [::1] 主机名，收到: ${hostname}`,
      );
    }
    // 路径收紧：只接受 Gateway 的 hook 前缀。去掉尾部斜杠后必须以 /hooks/<name> 开头，
    // 裸 `/hooks` 或 `/hooks/`（没有 hook 名）同样拒绝 —— 它们只会得到 Gateway 的 404，
    // 却会让用户以为「已配置」。
    //
    // N-3：前缀检查只看字符串，`/hooks/..%2fadmin`、`/hooks//evil` 这类畸形路径能骗过去 ——
    // 反代/Gateway 按**规范化后**的路径路由，实际可能落到 /hooks/ 之外。这里显式拒绝：
    // 含 `.`/`..` 段、空段（`//`）、或任何百分号编码的 %2e/%2f（大小写不敏感）。
    const rawPath = parsed.pathname;
    if (
      /%2e|%2f/i.test(rawPath) ||
      rawPath.split("/").some((segment) => segment === "." || segment === "..") ||
      rawPath.includes("//")
    ) {
      throw new Error(
        `openclaw URL 路径不允许 .. 段、空段或百分号编码的 %2e/%2f（会被归一化成 /hooks/ 之外的路径），收到: ${rawPath}`,
      );
    }
    const path = openclawPath(rawPath);
    if (!path.startsWith(`${OPENCLAW_HOOKS_PREFIX}/`)) {
      throw new Error(
        `openclaw URL 路径必须是 /hooks/<name>（如 http://127.0.0.1:18789/hooks/life-default 或 /hooks/agent?channel=&to=），收到: ${rawPath}`,
      );
    }
    if (path === OPENCLAW_DIRECT_PATH) {
      for (const key of parsed.searchParams.keys()) {
        if (!OPENCLAW_DIRECT_QUERY_KEYS.has(key)) {
          throw new Error(
            `openclaw /hooks/agent 直连不接受 query 参数 ${key}（可用: channel / to / agentId / accountId）`,
          );
        }
      }
      const channel = parsed.searchParams.get("channel")?.trim() ?? "";
      const to = parsed.searchParams.get("to")?.trim() ?? "";
      if (channel === "") {
        throw new Error("openclaw /hooks/agent 直连需要非空 channel（如 qqbot）");
      }
      if (channel === "last") {
        throw new Error("openclaw /hooks/agent 直连的 channel 不能是 last，必须是具体通道");
      }
      if (to === "") {
        throw new Error("openclaw /hooks/agent 直连需要非空 to（收件人目标）");
      }
      for (const key of ["agentId", "accountId"]) {
        if (parsed.searchParams.has(key) && (parsed.searchParams.get(key)?.trim() ?? "") === "") {
          throw new Error(`openclaw /hooks/agent 直连的 ${key} 不能为空`);
        }
      }
    }
    const serialized = parsed.toString();
    // 与 bark/ntfy 一样只在无 query/hash 时去尾斜杠，避免改动 query/hash 的内容。
    return parsed.search === "" && parsed.hash === "" ? serialized.replace(/\/+$/, "") : serialized;
  },

  async deliver(input: ChannelDeliveryInput): Promise<ChannelOutcome> {
    // 每次投递都重新校验路由形态：手工改库/旧路由不能把 token 带到别的端口或路径。
    try {
      openclawChannel.validateRoute({ url: input.route.url });
    } catch (e) {
      return {
        status: "terminal_failure",
        error: e instanceof Error ? e.message : String(e),
      };
    }
    const target = input.openclawTarget;
    if (target !== undefined) {
      // 投递前再校验一次：防手工改库/升级前落库的路由绕过配置期检查。
      // 这里不抛错（会让 drain 整轮中断），而是把这条投递终结为 fallback。
      try {
        assertOpenclawRouteMatchesTarget(input.route.url, target, input.profileId);
      } catch (e) {
        return {
          status: "terminal_failure",
          error: e instanceof Error ? e.message : String(e),
        };
      }
    }
    const profileSecret = input.secret?.trim();
    const globalToken =
      input.openclawGlobalToken?.trim() ?? process.env.OPENCLAW_HOOK_TOKEN?.trim();
    const source = resolveOpenclawCredentialSource({ profileSecret, globalToken, target });
    const token = source === "profile" ? profileSecret : globalToken;
    if (source === "missing" || token === undefined || token === "") {
      const auth = target?.auth;
      const hint =
        auth === "profile"
          ? `OPENCLAW_PROFILE_TARGETS_JSON.${input.profileId} 指定 auth=profile，但 PROFILE_ROUTE_SECRETS_JSON 没有对应 secret`
          : auth === "global"
            ? "OPENCLAW_PROFILE_TARGETS_JSON 指定 auth=global，但 daemon 未配置 OPENCLAW_HOOK_TOKEN（必须与 Gateway 的 hooks.token 一致）"
            : `PROFILE_ROUTE_SECRETS_JSON 中没有 profile "${input.profileId}" 的 secret，daemon 也未配置 OPENCLAW_HOOK_TOKEN（部署自身 profile 的路由在 daemon 的 .env 里配置 OpenClaw hooks.token）`;
      return { status: "terminal_failure", error: `openclaw 通道缺少凭据：${hint}` };
    }
    // 未登记目标的旧部署：隔离用户回退全局 token 时只告警一次（每个 profile），不拒绝投递。
    // 登记了目标（target 非空）说明运维者已显式授权，不再告警。
    if (
      target === undefined &&
      source === "global" &&
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
    const direct = parseOpenclawDirectEndpoint(input.route.url);
    if (direct !== null) {
      const waitForCompletion = input.openclawWaitForCompletion === true;
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
