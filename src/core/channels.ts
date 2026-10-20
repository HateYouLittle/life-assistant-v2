import { createHmac } from "node:crypto";
import { logger } from "./logger.js";

/**
 * 投递通道抽象：outbox 只负责「何时投、投几次、失败怎么退避」，通道负责「怎么真正发出去」。
 *
 * 通道只做无状态投递（一条通知一次），所有状态推进（claim / sent / fallback / 退避）
 * 仍由 src/core/notify.ts 统一落库 —— 这样换通道不会改变幂等与重试语义。
 * 路由的 channel 字段缺省（旧数据）等同 webhook，旧 push_route 不需要迁移。
 *
 * 内置通道：webhook（回环 Hermes 网关，HMAC V2）、log（本地日志）、
 * bark（iOS 推送，URL 即凭据）、ntfy（自建/公共 topic）。后两者投递到公网，
 * 因此**不**做 webhook 那样的回环限制 —— 它们不带 secret，URL 本身就是凭据。
 */

export const EVENT_TYPE = "life_assistant.reminder";

/** 通道投递时用到的路由信息（只读；URL 对 log 通道为空串） */
export interface ChannelRoute {
  name: string;
  url: string;
}

/** 通道专属的路由校验输入：webhook/bark/ntfy 从 url 取地址，log 不需要 URL */
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
  /** 仅 requiresSecret 的通道会有值 */
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

const CHANNELS: readonly NotificationChannel[] = [
  webhookChannel,
  logChannel,
  barkChannel,
  ntfyChannel,
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
