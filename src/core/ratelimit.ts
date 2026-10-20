import type { IncomingMessage } from "node:http";
import { tokenFingerprint } from "./auth.js";

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

interface Bucket {
  start: number;
  count: number;
}

export class FixedWindowLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  take(key: string): RateLimitDecision {
    if (this.limit <= 0) return { allowed: true, retryAfterMs: 0 };
    const at = this.now();
    const bucket = this.buckets.get(key);
    if (bucket === undefined || at - bucket.start >= this.windowMs) {
      this.buckets.set(key, { start: at, count: 1 });
      // 惰性清理：只在 key 数量膨胀时做一次，避免每个请求都全表扫
      if (this.buckets.size > 10_000) this.prune(at);
      return { allowed: true, retryAfterMs: 0 };
    }
    bucket.count += 1;
    if (bucket.count <= this.limit) return { allowed: true, retryAfterMs: 0 };
    return { allowed: false, retryAfterMs: this.windowMs - (at - bucket.start) };
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

/** 限流 key：带 Bearer 时按 token 指纹（不同人互不牵连），否则按来源地址 */
export function rateLimitKey(req: IncomingMessage, trustProxy: boolean): string {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string" && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token !== "") return `t:${tokenFingerprint(token)}`;
  }
  return `ip:${clientAddress(req, trustProxy)}`;
}
