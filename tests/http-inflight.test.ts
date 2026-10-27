import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createHttpHandler } from "../src/daemon.js";
import { createInFlightTracker } from "../src/core/inflight.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";
import "../src/modules/index.js";

/**
 * P2-8 集成：createHttpHandler 的 inFlight 钩子必须把请求登记进追踪器，并在
 * MCP 处理 Promise / 非 MCP 响应结束时**释放**（否则停机每次都会白等满上界并 warn）。
 */
interface Harness {
  port: number;
  tracker: ReturnType<typeof createInFlightTracker>;
  server: Server;
  env: TestEnv;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const env = makeTestEnv();
  const tracker = createInFlightTracker();
  const server = createServer(createHttpHandler(env.config, env.db, { inFlight: tracker }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    tracker,
    server,
    env,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanupTestEnv(env);
    },
  };
}

describe("HTTP 在途追踪（P2-8）", () => {
  it("普通请求（非 MCP）：响应结束后在途数归零", async () => {
    const h = await startHarness();
    try {
      const response = await fetch(`http://127.0.0.1:${h.port}/healthz`);
      await response.text();
      // 'close' 事件在响应流结束后触发，给一个微任务让监听器跑完
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(h.tracker.size, 0, "请求结束后必须释放，否则停机永远等满上界");
    } finally {
      await h.close();
    }
  });

  it("MCP 请求：按处理 Promise 释放（不跟 SSE socket 走）", async () => {
    const h = await startHarness();
    try {
      const response = await fetch(`http://127.0.0.1:${h.port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        }),
      });
      assert.equal(response.status, 200);
      await response.text();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(h.tracker.size, 0, "MCP 处理完成后必须释放追踪（SSE socket 不参与计数）");
    } finally {
      await h.close();
    }
  });
});
