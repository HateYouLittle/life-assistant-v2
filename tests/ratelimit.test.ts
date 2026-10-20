import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { clientAddress, FixedWindowLimiter, rateLimitKey } from "../src/core/ratelimit.js";

function fakeRequest(over: {
  authorization?: string;
  remoteAddress?: string;
  forwardedFor?: string;
}): IncomingMessage {
  return {
    headers: {
      ...(over.authorization === undefined ? {} : { authorization: over.authorization }),
      ...(over.forwardedFor === undefined ? {} : { "x-forwarded-for": over.forwardedFor }),
    },
    socket: { remoteAddress: over.remoteAddress ?? "127.0.0.1" },
  } as unknown as IncomingMessage;
}

describe("FixedWindowLimiter：固定窗口限流", () => {
  it("窗口内超过上限才拒绝，并给出 Retry-After 剩余时间", () => {
    let now = 1_000_000;
    const limiter = new FixedWindowLimiter(3, 60_000, () => now);
    assert.equal(limiter.take("k").allowed, true);
    assert.equal(limiter.take("k").allowed, true);
    assert.equal(limiter.take("k").allowed, true);
    const denied = limiter.take("k");
    assert.equal(denied.allowed, false);
    assert.ok(
      denied.retryAfterMs > 0 && denied.retryAfterMs <= 60_000,
      `retry=${denied.retryAfterMs}`,
    );
    now += 60_000;
    assert.equal(limiter.take("k").allowed, true, "窗口结束后应恢复");
  });

  it("不同 key 互不影响；limit<=0 时关闭限流", () => {
    const limiter = new FixedWindowLimiter(1, 60_000, () => 1_000);
    assert.equal(limiter.take("a").allowed, true);
    assert.equal(limiter.take("a").allowed, false);
    assert.equal(limiter.take("b").allowed, true, "另一个身份不该被牵连");

    const off = new FixedWindowLimiter(0, 60_000, () => 1_000);
    for (let i = 0; i < 10; i += 1) assert.equal(off.take("a").allowed, true);
  });

  it("prune 清理过期窗口，内存不会无限增长", () => {
    let now = 1_000;
    const limiter = new FixedWindowLimiter(10, 1_000, () => now);
    limiter.take("a");
    limiter.take("b");
    assert.equal(limiter.size, 2);
    now += 1_001;
    limiter.prune();
    assert.equal(limiter.size, 0);
  });
});

describe("clientAddress / rateLimitKey：反代与身份归并", () => {
  it("默认不信任 X-Forwarded-For；TRUST_PROXY 开启后取第一段", () => {
    const request = fakeRequest({
      remoteAddress: "192.168.31.40",
      forwardedFor: "1.2.3.4, 10.0.0.1",
    });
    assert.equal(clientAddress(request, false), "192.168.31.40");
    assert.equal(clientAddress(request, true), "1.2.3.4");
  });

  it("带 Bearer 时按 token 指纹归并（同一人不同 IP 仍共用一个桶）", () => {
    const token = "t".repeat(64);
    const a = rateLimitKey(
      fakeRequest({ authorization: `Bearer ${token}`, remoteAddress: "1.1.1.1" }),
      false,
    );
    const b = rateLimitKey(
      fakeRequest({ authorization: `Bearer ${token}`, remoteAddress: "2.2.2.2" }),
      false,
    );
    assert.equal(a, b);
    assert.match(a, /^t:[0-9a-f]{16}$/);
    // 无凭据时退回 IP
    assert.equal(rateLimitKey(fakeRequest({ remoteAddress: "1.1.1.1" }), false), "ip:1.1.1.1");
  });
});
