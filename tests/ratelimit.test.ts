import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { describe, it } from "node:test";
import { clientAddress, envClientAddress, FixedWindowLimiter } from "../src/core/ratelimit.js";

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

  it("桶数量硬上限：超限淘汰最旧的桶，内存有界（伪 key 轮换不能撑爆 Map）", () => {
    let now = 1_000;
    const limiter = new FixedWindowLimiter(1, 60_000, () => now, { maxBuckets: 1 });
    assert.equal(limiter.take("a").allowed, true);
    now += 1;
    assert.equal(limiter.take("b").allowed, true);
    assert.equal(limiter.size, 1, "插入新 key 后必须淘汰到上限内");
    now += 1;
    assert.equal(
      limiter.take("a").allowed,
      true,
      "a 已被淘汰：重新计数而不是沿用旧窗口（limit=1 的第二次才会拒绝）",
    );
    assert.equal(limiter.size, 1, "上限始终成立");
  });

  it("硬上限先清过期：过期桶被清掉后不必淘汰仍有效的桶", () => {
    let now = 1_000;
    const limiter = new FixedWindowLimiter(10, 1_000, () => now, { maxBuckets: 3 });
    for (const key of ["a", "b", "c"]) limiter.take(key);
    assert.equal(limiter.size, 3);
    now += 1_001;
    for (const key of ["d", "e"]) limiter.take(key);
    assert.equal(limiter.size, 2, "过期的 a/b/c 应在写入时被清掉，只留新桶");
  });

  it("maxBuckets 必须是正整数", () => {
    assert.throws(() => new FixedWindowLimiter(1, 1_000, () => 0, { maxBuckets: 0 }), /maxBuckets/);
    assert.throws(
      () => new FixedWindowLimiter(1, 1_000, () => 0, { maxBuckets: 1.5 }),
      /maxBuckets/,
    );
  });
});

describe("clientAddress / envClientAddress：反代与地址口径", () => {
  it("默认不信任 X-Forwarded-For；TRUST_PROXY 开启后取第一段", () => {
    const request = fakeRequest({
      remoteAddress: "192.168.31.40",
      forwardedFor: "1.2.3.4, 10.0.0.1",
    });
    assert.equal(clientAddress(request, false), "192.168.31.40");
    assert.equal(clientAddress(request, true), "1.2.3.4");
  });

  it("envClientAddress：从 Hono 的 c.env.incoming 取地址，口径与 clientAddress 一致", () => {
    const incoming = fakeRequest({
      remoteAddress: "192.168.31.40",
      forwardedFor: "1.2.3.4, 10.0.0.1",
    });
    assert.equal(envClientAddress({ incoming }, false), "192.168.31.40");
    assert.equal(envClientAddress({ incoming }, true), "1.2.3.4", "TRUST_PROXY=1 才采信 XFF");
    // 直接 app.request()/非 node-server 适配器拿不到 Node 请求：如实返回 unknown
    assert.equal(envClientAddress(undefined, false), "unknown");
    assert.equal(envClientAddress({}, false), "unknown");
  });
});
