import type { IncomingMessage } from "node:http";

/**
 * 单进程内存限流：公网（经反代）暴露后，最基本的「不让一个来源把服务打满」的防线。
 * 固定窗口而非令牌桶：实现简单、内存有界，个人规模足够；窗口/上限都可配。
 *
 * 真正的爆破防护仍靠强 token + 失败日志/Metrics，限流只是兜底（避免日志/CPU 被打满）。
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** 被拒时建议的 Retry-After（毫秒） */
  retryAfterMs: number;
}

export interface FixedWindowLimiterOptions {
  /**
   * 桶数量硬上限（默认 10_000）。key 来自请求（来源 IP / 鉴权后的 token 指纹），
   * 不设上限时可用大量不同 key 把 Map 撑大：达到上限先清过期桶，仍满则淘汰最旧的
   * 一批，保证内存有界。
   */
  maxBuckets?: number;
}

interface Bucket {
  start: number;
  count: number;
}

export const DEFAULT_MAX_BUCKETS = 10_000;

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxBuckets: number;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
    options: FixedWindowLimiterOptions = {},
  ) {
    const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
    if (!Number.isInteger(maxBuckets) || maxBuckets < 1) {
      throw new Error(`maxBuckets 必须是正整数: ${String(maxBuckets)}`);
    }
    this.maxBuckets = maxBuckets;
  }

  take(key: string): RateLimitDecision {
    if (this.limit <= 0) return { allowed: true, retryAfterMs: 0 };
    const at = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || at - bucket.start >= this.windowMs) {
      this.buckets.set(key, { start: at, count: 1 });
      // 惰性清理 + 硬上限：只在 key 数量膨胀时动一次，避免每个请求都全表扫
      if (this.buckets.size > this.maxBuckets) {
        this.prune(at);
        if (this.buckets.size > this.maxBuckets) {
          this.evictOldest(this.buckets.size - this.maxBuckets);
        }
      }
      return { allowed: true, retryAfterMs: 0 };
    }
    bucket.count += 1;
    if (bucket.count <= this.limit) return { allowed: true, retryAfterMs: 0 };
    return { allowed: false, retryAfterMs: this.windowMs - (at - bucket.start) };
  }

  /** 按窗口起点升序淘汰最旧的一批（同起点按插入顺序，刚插入的桶不会被误伤） */
  private evictOldest(count: number): void {
    if (count <= 0) return;
    const victims = [...this.buckets.entries()]
      .sort(([, a], [, b]) => a.start - b.start)
      .slice(0, count);
    for (const [key] of victims) this.buckets.delete(key);
  }

  prune(at: number = this.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (at - bucket.start >= this.windowMs) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * 请求的来源地址。反代（Lucky/nginx）后面 socket 地址永远是代理机，
 * 只有显式 TRUST_PROXY=1 才采信 X-Forwarded-For 的第一段（部署文档里要求只由反代写入该头）。
 */
export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = req.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const first = raw?.split(",")[0]?.trim();
    if (first !== undefined && first !== "") return first;
  }
  return req.socket.remoteAddress ?? "unknown";
}

/**
 * Hono 的 `c.env` → 来源地址。`@hono/node-server` 会把 Node 的 `incoming`/`outgoing`
 * 放进 env（见 getRequestListener），服务端路由据此拿到与 `createHttpHandler` 同一口径的
 * 客户端地址（同样遵守 TRUST_PROXY）。直接 `app.request()`（单元测试/非 node-server
 * 适配器）时拿不到 Node 请求，返回 "unknown"。
 */
export function envClientAddress(env: unknown, trustProxy: boolean): string {
  const incoming = (env as { incoming?: IncomingMessage } | null | undefined)?.incoming;
  return incoming === undefined ? "unknown" : clientAddress(incoming, trustProxy);
}
