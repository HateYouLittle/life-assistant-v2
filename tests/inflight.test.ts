import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createInFlightTracker } from "../src/core/inflight.js";

/**
 * P2-8 回归：停机必须先拒绝新请求、再等在途 HTTP/MCP 请求收敛，最后才关库。
 * tracker 本身是可单测的核心：begin/settle 幂等、waitForIdle 有界、close 后 daemon 拒绝新请求。
 */
describe("core/inflight（P2-8）", () => {
  it("没有在途请求时立即返回 0", async () => {
    const tracker = createInFlightTracker();
    assert.equal(tracker.size, 0);
    assert.equal(await tracker.waitForIdle(1_000), 0);
  });

  it("begin/settle 维护在途计数，结束回调可重复调用", async () => {
    const tracker = createInFlightTracker();
    const done = tracker.begin();
    assert.equal(tracker.size, 1);
    const other = tracker.begin();
    assert.equal(tracker.size, 2);
    done();
    done(); // 幂等：响应 end 与连接 close 可能各触发一次
    other();
    assert.equal(tracker.size, 0);
    assert.equal(await tracker.waitForIdle(1_000), 0);
  });

  it("waitForIdle 等最后一个在途请求结束才返回", async () => {
    const tracker = createInFlightTracker();
    const finish = tracker.begin();
    assert.equal(tracker.size, 1);
    let resolved = false;
    const waiting = tracker.waitForIdle(2_000).then((left) => {
      resolved = true;
      return left;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(resolved, false, "还有在途请求时不能提前返回");
    finish();
    assert.equal(await waiting, 0);
  });

  it("在途请求永不结束：waitForIdle 按上界返回剩余数（停机不能被长连接拖死）", async () => {
    const tracker = createInFlightTracker();
    tracker.begin();
    tracker.begin();
    const started = Date.now();
    const left = await tracker.waitForIdle(50);
    assert.equal(left, 2, "超时后返回仍未收敛的数量");
    assert.ok(Date.now() - started >= 40, "必须至少等到上界附近");
  });

  it("close 标记停机：daemon 据此对新请求回 503", () => {
    const tracker = createInFlightTracker();
    assert.equal(tracker.closed, false);
    tracker.close();
    assert.equal(tracker.closed, true);
    tracker.close(); // 幂等
    assert.equal(tracker.closed, true);
  });
});
