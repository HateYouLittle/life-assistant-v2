import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
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

async function startHarness(extraEnv: Record<string, string> = {}): Promise<Harness> {
  const env = makeTestEnv({ WEB_API_TOKEN: TOKEN, HOST: "0.0.0.0", ...extraEnv });
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

/**
 * 原样把请求行发出去：`fetch`/undici 会先把 `..` 归一化掉，测「探针豁免绕过」必须用
 * 底层 http.request 才能复现 `/healthz/../api/status` 这种原始 URL。
 */
function rawGet(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
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

  it("无 session id 的非 initialize 请求：拒绝，且不留下无人持有的会话", async () => {
    const harness = await startHarness();
    try {
      const orphan = await rpc(harness.port, { jsonrpc: "2.0", id: 9, method: "tools/list" });
      assert.equal(orphan.status, 400, "缺 mcp-session-id 的非 initialize 请求应被拒");
      await orphan.text();

      // 这条路径上 daemon 会先建好一个 transport，但 transport 不会分配 session id，
      // 因此没有任何地方持有它 —— 修复后它就地被关闭。若关闭动作误伤了响应或后续请求，
      // 下面这段会立刻失败。
      const sessionId = await sessionOf(await rpc(harness.port, INIT));
      const listed = await rpc(
        harness.port,
        { jsonrpc: "2.0", id: 10, method: "tools/list" },
        sessionId,
      );
      assert.equal(listed.status, 200);
      assert.match(await readJson(listed), /"schedule"/);
    } finally {
      await harness.close();
    }
  });

  it("建立 MCP 会话时注册 Profile（只读 Profile 也能收到简报/被转移账本）", async () => {
    const harness = await startHarness();
    try {
      const response = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: { ...headers(), "X-Hermes-Profile": "reader" },
        body: JSON.stringify(INIT),
      });
      await sessionOf(response);
      const row = harness.env.db.prepare("SELECT id FROM profiles WHERE id = 'reader'").get();
      assert.ok(row !== undefined, "初始化会话后必须确保 profiles 行存在");
    } finally {
      await harness.close();
    }
  });

  it("Profile token 绑定自己的 Profile：忽略 X-Hermes-Profile，会话与 token 不一致时 403", async () => {
    const bestieToken = "b".repeat(64);
    const defaultToken = "d".repeat(64);
    const harness = await startHarness({
      PROFILE_TOKENS_JSON: JSON.stringify({ bestie: bestieToken, default: defaultToken }),
    });
    try {
      const stamp = "2026-01-01T00:00:00.000Z";
      harness.env.db
        .prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)")
        .run("bestie", stamp);
      const insert = harness.env.db.prepare(
        "INSERT INTO schedules (id, profile_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run("s-default", "default", "仅默认 Profile", stamp, stamp);
      insert.run("s-bestie", "bestie", "仅好友 Profile", stamp, stamp);

      // bestie 的 token + 伪造头 X-Hermes-Profile: default → 必须仍按 bestie 身份执行
      const init = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: {
          ...headers(undefined, false),
          Authorization: `Bearer ${bestieToken}`,
          "X-Hermes-Profile": "default",
        },
        body: JSON.stringify(INIT),
      });
      const sessionId = await sessionOf(init);
      const initialized = await rpc(
        harness.port,
        { jsonrpc: "2.0", method: "notifications/initialized" },
        sessionId,
      );
      await initialized.text();

      const call = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: {
          ...headers(sessionId, false),
          Authorization: `Bearer ${bestieToken}`,
          "X-Hermes-Profile": "default",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: { name: "schedule", arguments: { action: "list" } },
        }),
      });
      const text = await readJson(call);
      assert.match(text, /仅好友 Profile/, `profile token 应读到 bestie 的日程：${text}`);
      assert.doesNotMatch(text, /仅默认 Profile/, "不得越权读到 default 的日程");

      // 换另一个 Profile 的 token 复用同一会话 → 403（会话与身份强绑定）
      const cross = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: {
          ...headers(sessionId, false),
          Authorization: `Bearer ${defaultToken}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 21, method: "tools/list" }),
      });
      assert.equal(cross.status, 403, "会话与 token 所属 Profile 不一致必须拒绝");
      await cross.text();
    } finally {
      await harness.close();
    }
  });

  it("RATE_LIMIT_PER_MINUTE 生效：同一身份超限返回 429 与 Retry-After", async () => {
    const harness = await startHarness({ RATE_LIMIT_PER_MINUTE: "2" });
    try {
      const first = await rpc(harness.port, INIT);
      await first.text();
      assert.equal(first.status, 200);
      const second = await rpc(harness.port, INIT);
      await second.text();
      assert.equal(second.status, 200);
      const third = await rpc(harness.port, INIT);
      await third.text();
      assert.equal(third.status, 429);
      assert.ok(third.headers.get("retry-after"), "429 必须带 Retry-After");
    } finally {
      await harness.close();
    }
  });

  it("探针豁免只认精确路径：/healthz/../api/status 不能绕过限流", async () => {
    // 本轮修复的回归：Hono 会把 `/healthz/../api/status` 归一化到真实路由，但旧实现用
    // `req.url.startsWith("/healthz")` 判断豁免，于是整段跳过限流（公网可无限打业务接口）。
    const harness = await startHarness({ RATE_LIMIT_PER_MINUTE: "2" });
    try {
      const bypass: number[] = [];
      for (let i = 0; i < 4; i += 1) {
        bypass.push(await rawGet(harness.port, "/healthz/../api/status"));
      }
      assert.deepEqual(
        bypass,
        [401, 401, 429, 429],
        `归一化后命中 /api/status，必须受限流：${bypass.join(",")}`,
      );
      // 编码形态（`%2e%2e`）同样不能绕过（此时 IP 桶已耗尽）
      const encoded = await rawGet(harness.port, "/healthz/%2e%2e/api/status");
      assert.equal(encoded, 429, "编码后的 .. 也必须受限流");
      // 精确探针路径仍然豁免（即使桶已耗尽）
      const probes: number[] = [];
      for (let i = 0; i < 5; i += 1) probes.push(await rawGet(harness.port, "/healthz"));
      assert.deepEqual(
        probes,
        [200, 200, 200, 200, 200],
        `系统探针不能被限流：${probes.join(",")}`,
      );
    } finally {
      await harness.close();
    }
  });
});

describe("双层限流与鉴权失败日志", () => {
  it("轮换任意 Bearer 不能换桶：伪 token 也受同一 IP 桶限流", async () => {
    const harness = await startHarness({ RATE_LIMIT_PER_MINUTE: "2" });
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 3; i += 1) {
        const res = await fetch(`http://127.0.0.1:${harness.port}/api/status`, {
          headers: { Authorization: `Bearer fake-${i}-${"x".repeat(40)}` },
        });
        await res.text();
        statuses.push(res.status);
      }
      assert.deepEqual(
        statuses,
        [401, 401, 429],
        `每次换伪 token 也必须落进同一个 IP 桶：${statuses.join(",")}`,
      );
    } finally {
      await harness.close();
    }
  });

  it("鉴权失败日志：TRUST_PROXY=0 不采信 X-Forwarded-For，且过滤控制字符", async () => {
    const harness = await startHarness();
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    try {
      const res = await fetch(`http://127.0.0.1:${harness.port}/api/%1B[2J%1B[31mRED`, {
        headers: { "X-Forwarded-For": "203.0.113.9" },
      });
      assert.equal(res.status, 401);
      await res.text();
    } finally {
      console.error = original;
      await harness.close();
    }
    const line = logs.find((l) => l.includes("鉴权失败: /api/")) ?? "";
    assert.ok(line !== "", `应记录鉴权失败日志：${logs.join("\n")}`);
    assert.match(line, /from 127\.0\.0\.1/, `来源应是 socket 地址：${line}`);
    assert.ok(!line.includes("203.0.113.9"), `TRUST_PROXY=0 时 XFF 不得进入日志：${line}`);
    assert.ok(!line.includes("\x1b"), `控制字符不得原样进日志：${JSON.stringify(line)}`);
  });

  it("限流 429 日志对 query 凭据打码：token / sig 原文不得落盘", async () => {
    const harness = await startHarness({ RATE_LIMIT_PER_MINUTE: "1" });
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const sig = "a".repeat(64);
    try {
      // 状态页支持 ?token= 引导：URL 里带 master token 时，被限流也不能把原文写进日志
      const url = `http://127.0.0.1:${harness.port}/api/status?token=${TOKEN}&view=2`;
      const first = await fetch(url);
      assert.equal(first.status, 200);
      await first.text();
      const second = await fetch(url);
      assert.equal(second.status, 429);
      await second.text();
      // 日历签名同理（IP 桶已耗尽，这一条也必然被限流）
      const calendar = await fetch(
        `http://127.0.0.1:${harness.port}/calendar.ics?p=default&exp=9999999999&sig=${sig}`,
      );
      assert.equal(calendar.status, 429);
      await calendar.text();
    } finally {
      console.error = original;
      await harness.close();
    }
    const line = logs.find((l) => l.includes("已限流") && l.includes("/api/status")) ?? "";
    assert.ok(line !== "", `应记录限流日志：${logs.join("\n")}`);
    assert.ok(line.includes("token=***"), `敏感 query 参数应打码：${line}`);
    assert.ok(!line.includes(TOKEN), `日志不得含 token 原文：${line}`);
    assert.ok(line.includes("view=2"), `非敏感参数应保留：${line}`);
    assert.ok(!line.includes("\x1b") && !line.includes("\n"), "日志必须单行且无控制字符");

    const calendarLine =
      logs.find((l) => l.includes("已限流") && l.includes("/calendar.ics")) ?? "";
    assert.ok(calendarLine.includes("sig=***"), `签名参数应打码：${calendarLine}`);
    assert.ok(!calendarLine.includes(sig), `日志不得含 sig 原文：${calendarLine}`);
  });

  it("请求可控字段净化：X-Forwarded-For 来源被截断，日志单行无控制字符", async () => {
    const harness = await startHarness({ TRUST_PROXY: "1", RATE_LIMIT_PER_MINUTE: "1" });
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const spoof = `203.0.113.9${"5".repeat(300)}`;
    const send = () =>
      fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: {
          ...headers(undefined, false),
          Authorization: "Bearer wrong",
          "X-Forwarded-For": spoof,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
    try {
      const first = await send();
      assert.equal(first.status, 401);
      await first.text();
      const second = await send();
      assert.equal(second.status, 429);
      await second.text();
    } finally {
      console.error = original;
      await harness.close();
    }
    const authLine = logs.find((l) => l.includes("鉴权失败: /mcp")) ?? "";
    const limitLine = logs.find((l) => l.includes("已限流")) ?? "";
    for (const line of [authLine, limitLine]) {
      assert.ok(line !== "", `应写日志：${logs.join("\n")}`);
      assert.ok(
        !line.includes("\x1b") && !line.includes("\n") && !line.includes("\r"),
        `日志必须单行且无控制字符：${JSON.stringify(line)}`,
      );
      assert.ok(line.includes("203.0.113.9"), `可读前缀应保留：${line}`);
      assert.ok(!line.includes("5".repeat(120)), `超长来源必须被截断：${line.length}`);
      assert.ok(line.length < 500, `日志长度受限：${line.length}`);
    }
  });

  it("恶意 mcp-session-id 不进日志；会话不一致日志单行且保留真实会话 id", async () => {
    const bestieToken = "b".repeat(64);
    const defaultToken = "d".repeat(64);
    const harness = await startHarness({
      PROFILE_TOKENS_JSON: JSON.stringify({ bestie: bestieToken, default: defaultToken }),
    });
    const logs: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const evilSession = "E".repeat(1000);
    let sessionId = "";
    try {
      const init = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: { ...headers(undefined, false), Authorization: `Bearer ${bestieToken}` },
        body: JSON.stringify(INIT),
      });
      sessionId = await sessionOf(init);
      // 超长（请求可控）session id：查不到会话 → 404，且不写鉴权日志
      const unknown = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: { ...headers(evilSession, false), Authorization: `Bearer ${bestieToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      });
      assert.equal(unknown.status, 404);
      await unknown.text();
      // 真实会话 + 另一个 Profile 的 token → 403，日志里的会话 id 被净化后仍可读
      const cross = await fetch(`http://127.0.0.1:${harness.port}/mcp`, {
        method: "POST",
        headers: { ...headers(sessionId, false), Authorization: `Bearer ${defaultToken}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
      });
      assert.equal(cross.status, 403);
      await cross.text();
    } finally {
      console.error = original;
      await harness.close();
    }
    assert.ok(
      !logs.some((line) => line.includes(evilSession)),
      `未知/超长 session id 不得进日志：${logs.join("\n")}`,
    );
    const mismatch = logs.find((l) => l.includes("鉴权失败: /mcp 会话")) ?? "";
    assert.ok(mismatch !== "", `会话不一致应写日志：${logs.join("\n")}`);
    assert.ok(
      !mismatch.includes("\x1b") && !mismatch.includes("\n") && !mismatch.includes("\r"),
      `日志必须单行且无控制字符：${JSON.stringify(mismatch)}`,
    );
    assert.ok(mismatch.includes(sessionId), "真实会话 id 应保留可读");
    assert.ok(mismatch.length < 400, `日志长度受限：${mismatch.length}`);
  });
});
