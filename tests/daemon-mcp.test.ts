import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { createHttpHandler, sweepSessions } from "../src/daemon.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * /mcp 鉴权与会话生命周期：daemon 只在回环地址上默认开放；
 * 一旦配置 WEB_API_TOKEN（绑定非回环地址时强制），/mcp 与 /api 必须同样受保护。
 * 这里直接驱动 createHttpHandler，不启动 cron/调度，避免测试挂在常驻定时器上。
 */

const TOKEN = "t".repeat(32);

interface Harness {
  port: number;
  server: Server;
  env: TestEnv;
  close(): Promise<void>;
}

async function startHarness(): Promise<Harness> {
  const env = makeTestEnv({ WEB_API_TOKEN: TOKEN, HOST: "0.0.0.0" });
  const server = createServer(createHttpHandler(env.config, env.db));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    server,
    env,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanupTestEnv(env);
    },
  };
}

function headers(sessionId?: string, withToken = true): Record<string, string> {
  const out: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (withToken) out.Authorization = `Bearer ${TOKEN}`;
  if (sessionId !== undefined) out["mcp-session-id"] = sessionId;
  return out;
}

function rpc(port: number, body: unknown, sessionId?: string, withToken = true): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: headers(sessionId, withToken),
    body: JSON.stringify(body),
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

async function sessionOf(response: Response): Promise<string> {
  await response.text();
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId, "initialize 应返回 mcp-session-id");
  return sessionId;
}

async function readJson(response: Response): Promise<string> {
  const text = await response.text();
  const payload = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .join("");
  return payload === "" ? text : payload;
}

describe("/mcp 鉴权", () => {
  it("未配置 token 时回环零配置可用；配置后无凭据一律 401", async () => {
    const open = await startHarness();
    try {
      const response = await rpc(open.port, INIT, undefined, false);
      assert.equal(response.status, 401, "配置了 WEB_API_TOKEN 时 /mcp 必须拒绝匿名请求");
      await response.text();
      const withToken = await rpc(open.port, INIT);
      assert.equal(withToken.status, 200);
      await withToken.text();
    } finally {
      await open.close();
    }

    const anonymous = makeTestEnv();
    try {
      const server = createServer(createHttpHandler(anonymous.config, anonymous.db));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as AddressInfo).port;
      const response = await rpc(port, INIT, undefined, false);
      assert.equal(response.status, 200, "未配置 token 时本机零配置仍可用");
      await response.text();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    } finally {
      cleanupTestEnv(anonymous);
    }
  });

  it("携带 token 可 initialize 并调用工具", async () => {
    const harness = await startHarness();
    try {
      const init = await rpc(harness.port, INIT);
      const sessionId = await sessionOf(init);
      const initialized = await rpc(
        harness.port,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId,
      );
      await initialized.text();

      const call = await rpc(
        harness.port,
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "holiday", arguments: { view: "is_workday", date: "2026-09-12" } },
        },
        sessionId,
      );
      assert.equal(call.status, 200);
      assert.match(await readJson(call), /2026-09-12/);
    } finally {
      await harness.close();
    }
  });

  it("DELETE 会话后旧 session id 返回 404（stdio 壳据此自动重新 initialize）", async () => {
    const harness = await startHarness();
    try {
      const sessionId = await sessionOf(await rpc(harness.port, INIT));
      const closed = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "DELETE",
        headers: headers(sessionId),
      });
      await closed.text();
      assert.ok(
        closed.status === 200 || closed.status === 204,
        `DELETE 应成功，收到 ${closed.status}`,
      );

      const stale = await rpc(
        harness.port,
        { jsonrpc: "2.0", id: 3, method: "tools/list" },
        sessionId,
      );
      assert.equal(stale.status, 404);
      await stale.text();
    } finally {
      await harness.close();
    }
  });

  it("非法 X-Hermes-Profile 返回 400 而不是 500", async () => {
    const harness = await startHarness();
    try {
      const response = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: { ...headers(), "X-Hermes-Profile": "Bad Profile" },
        body: JSON.stringify(INIT),
      });
      assert.equal(response.status, 400, "客户端头非法属于请求错误，不该被当成服务端故障");
      assert.match(await readJson(response), /invalid params/);
    } finally {
      await harness.close();
    }
  });

  it("空闲会话按 TTL 回收，避免 daemon 常驻时无限堆积", async () => {
    const harness = await startHarness();
    try {
      const sessionId = await sessionOf(await rpc(harness.port, INIT));
      const removed = sweepSessions(Date.now() + 3 * 3600 * 1000);
      assert.ok(removed >= 1, "超过空闲阈值的会话应被回收");
      const after = await rpc(
        harness.port,
        { jsonrpc: "2.0", id: 4, method: "tools/list" },
        sessionId,
      );
      assert.equal(after.status, 404);
      await after.text();
    } finally {
      await harness.close();
    }
  });
});
