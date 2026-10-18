import { createHmac } from "node:crypto";
import { logger } from "./logger.js";

/**
 * 投递通道抽象：outbox 只负责「何时投、投几次、失败怎么退避」，通道负责「怎么真正发出去」。
 *
 * 通道只做无状态投递（一条通知一次），所有状态推进（claim / sent / fallback / 退避）
 * 仍由 src/core/notify.ts 统一落库 —— 这样换通道不会改变幂等与重试语义。
 * 路由的 channel 字段缺省（旧数据）等同 webhook，旧 push_route 不需要迁移。
 */

export const EVENT_TYPE = "life_assistant.reminder";

/** 通道投递时用到的路由信息（只读；URL 对 log 通道为空串） */
export interface ChannelRoute {
  name: string;
  url: string;
}

/** 通道专属的路由校验输入：webhook 从 url 取地址，log 不需要 URL */
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

const CHANNELS: readonly NotificationChannel[] = [webhookChannel, logChannel];
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
