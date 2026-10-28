import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import { Hono } from "hono";
import {
  drainDue,
  recoverStaleSending,
  retryDeliveries,
  setPushRoute,
  UNCERTAIN_EXCEEDED_WINDOW_ERROR,
  UNCERTAIN_NON_IDEMPOTENT_ERROR,
} from "../src/core/notify.js";
import { createOpsApp } from "../src/server/ops.js";
import { cleanupTestEnv, makeTestEnv, SECRET, type TestEnv } from "./helpers.js";
// 副作用 import：/metrics 的 job 行才有内容（与 ops.test.ts / daemon 同一份注册表）
import "../src/modules/index.js";

/**
 * P2-10 回归：重启后「结果不确定」的 sending 行如何收场。
 *
 * 起因：重启发生在「请求已发出、未落库」之间时，旧实现把所有 sending 行复位 queued，
 * 于是非幂等通道（bark/ntfy/telegram/smtp/openclaw）会在下次启动重投 —— 用户收到两条。
 * 现在按通道分叉：幂等通道（webhook，对端按 X-Request-ID 去重）才允许复位重投；
 * 非幂等通道一律判终态 fallback，由用户手工确认后重发。
 *
 * 断言口径：① 非幂等不重投（DB 终态 + 真实假服务零请求 + /metrics 计数）；
 * ② webhook 行为不回归（复位重投且复用 request_id）；③ 未超窗/超窗两个分支都有断言。
 */

interface Captured {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

/** 本地假服务：respond 决定怎么回，captured 记录每个真实请求 */
function withServer(
  respond: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  fn: (base: { url: string }, captured: Captured[]) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const captured: Captured[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        captured.push({ method: req.method, url: req.url, headers: req.headers, body });
        respond(req, res, body);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr !== null && typeof addr === "object");
      const base = { url: `http://127.0.0.1:${addr.port}` };
      fn(base, captured)
        .then(() => server.close(() => resolve()))
        .catch((e) => server.close(() => reject(e)));
    });
  });
}

/** 把投递行的 next_attempt_at 拨到过去，让 drain 立刻取回 */
function forceDue(env: TestEnv): void {
  env.db.exec("UPDATE deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
}

/** 造一条「请求已发出、结果未知」的 sending 行（模拟崩溃/重启残留） */
function seedUncertainSending(
  env: TestEnv,
  over: { id: string; routeName: string; startedAt: string; requestId: string },
): void {
  const stamp = "2026-01-01T00:00:00.000Z";
  env.db
    .prepare(
      `INSERT INTO notifications (id, profile_id, kind, title, body_md, created_at)
       VALUES (?, 'default', 'test.kind', ?, '正文', ?)`,
    )
    .run(`n-${over.id}`, `通知 ${over.id}`, stamp);
  env.db
    .prepare(
      `INSERT INTO deliveries (id, notification_id, route_name, status, request_id,
         request_started_at, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, 'sending', ?, ?, ?, ?, ?)`,
    )
    .run(
      over.id,
      `n-${over.id}`,
      over.routeName,
      over.requestId,
      over.startedAt,
      stamp,
      stamp,
      stamp,
    );
}

function deliveryOf(env: TestEnv, id: string): Record<string, unknown> {
  const row = env.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  assert.ok(row !== undefined, `缺少投递行 ${id}`);
  return row;
}

/** 走生产挂载方式读 /metrics（未配置 token 时回环零配置放行） */
async function metricsText(env: TestEnv): Promise<string> {
  const app = new Hono().route("/", createOpsApp(env.config, env.db));
  const response = await app.request("/metrics");
  assert.equal(response.status, 200);
  return response.text();
}

const recentIso = (): string => new Date(Date.now() - 1000).toISOString();
const exceededWindowIso = (): string => new Date(Date.now() - 56 * 60 * 1000).toISOString();

describe("recoverStaleSending：重启后不确定投递的通道级语义", () => {
  it("非幂等通道（bark）未超窗：不重投、判 fallback 终态、指标计数、人工重发仍可用", async () => {
    const env = makeTestEnv();
    try {
      await withServer(
        (_req, res) => {
          res.writeHead(200);
          res.end("ok");
        },
        async (base, captured) => {
          const route = setPushRoute(env.db, "default", {
            channel: "bark",
            url: `${base.url}/key`,
          });
          seedUncertainSending(env, {
            id: "d1",
            routeName: route.name,
            startedAt: recentIso(),
            requestId: "req-bark-1",
          });

          recoverStaleSending(env.db);
          const after = deliveryOf(env, "d1");
          assert.equal(
            after.status,
            "fallback",
            "非幂等通道的不确定投递必须是终态，不能复位 queued",
          );
          assert.equal(after.last_error, UNCERTAIN_NON_IDEMPOTENT_ERROR);
          assert.notEqual(
            after.request_started_at,
            null,
            "保留 request_started_at 才能阻止 requeueRoute 在路由变更时自动重投",
          );

          // 启动后的常规 drain（内含 recoverStaleSending）不得把这条再发一次
          forceDue(env);
          await drainDue(env.db, env.config);
          assert.equal(captured.length, 0, "非幂等通道的不确定投递不得被自动重投");
          assert.equal(deliveryOf(env, "d1").status, "fallback");

          // 指标沿用既有口径：这些行落 fallback，由 life_assistant_deliveries 计数
          const metrics = await metricsText(env);
          assert.match(metrics, /^life_assistant_deliveries\{status="fallback"\} 1$/m);

          // 用户确认后手工重发：retryDeliveries 显式清空在途标记并重新入队
          const retried = retryDeliveries(env.db, { profileId: "default", deliveryId: "d1" });
          assert.equal(retried.retried, 1);
          assert.equal(deliveryOf(env, "d1").status, "queued");
          forceDue(env);
          await drainDue(env.db, env.config);
          assert.equal(captured.length, 1, "人工确认后必须能真正发出去");
          assert.equal(deliveryOf(env, "d1").status, "sent");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非幂等通道超窗：同样是 fallback（窗口分支不影响非幂等通道的结论）", async () => {
    const env = makeTestEnv();
    try {
      await withServer(
        (_req, res) => {
          res.writeHead(200);
          res.end("ok");
        },
        async (base, captured) => {
          const route = setPushRoute(env.db, "default", {
            channel: "bark",
            url: `${base.url}/key`,
          });
          seedUncertainSending(env, {
            id: "d-old",
            routeName: route.name,
            startedAt: exceededWindowIso(),
            requestId: "req-bark-old",
          });

          recoverStaleSending(env.db);
          assert.equal(deliveryOf(env, "d-old").status, "fallback");
          assert.equal(deliveryOf(env, "d-old").last_error, UNCERTAIN_NON_IDEMPOTENT_ERROR);

          forceDue(env);
          await drainDue(env.db, env.config);
          assert.equal(captured.length, 0, "超窗的非幂等不确定投递同样不得自动重投");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非幂等通道路由已被删除（通道未知）：按非幂等保守处理，不自动重投", () => {
    const env = makeTestEnv();
    try {
      // 不配置任何路由：无法反查通道 → 保守判非幂等（漏发等人工确认 < 重复推送）
      seedUncertainSending(env, {
        id: "d-noroute",
        routeName: "life-assistant-default",
        startedAt: recentIso(),
        requestId: "req-noroute",
      });
      recoverStaleSending(env.db);
      const row = deliveryOf(env, "d-noroute");
      assert.equal(row.status, "fallback");
      assert.equal(row.last_error, UNCERTAIN_NON_IDEMPOTENT_ERROR);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("webhook 幂等通道未超窗：复位 queued 且重发复用原 request_id（不回归）", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withServer(
        (_req, res) => {
          res.writeHead(200);
          res.end("ok");
        },
        async (base, captured) => {
          const route = setPushRoute(env.db, "default", { url: `${base.url}/hook` });
          seedUncertainSending(env, {
            id: "d-hook",
            routeName: route.name,
            startedAt: recentIso(),
            requestId: "req-keep",
          });

          recoverStaleSending(env.db);
          const after = deliveryOf(env, "d-hook");
          assert.equal(after.status, "queued", "webhook 未超窗必须复位重投（幂等，对端去重）");
          assert.equal(after.request_started_at, null);
          assert.equal(after.request_id, "req-keep", "必须复用同一 request_id 才能让对端去重");

          forceDue(env);
          await drainDue(env.db, env.config);
          assert.equal(captured.length, 1, "webhook 未超窗应重投一次");
          assert.equal(
            captured[0]?.headers["x-request-id"],
            "req-keep",
            "重投必须带原 X-Request-ID（Hermes 侧据此去重，用户不会收到第二条）",
          );
          assert.equal(deliveryOf(env, "d-hook").status, "sent");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("webhook 幂等通道超窗：判 fallback 且不重投（对端去重记录可能已过期）", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withServer(
        (_req, res) => {
          res.writeHead(200);
          res.end("ok");
        },
        async (base, captured) => {
          const route = setPushRoute(env.db, "default", { url: `${base.url}/hook` });
          seedUncertainSending(env, {
            id: "d-hook-old",
            routeName: route.name,
            startedAt: exceededWindowIso(),
            requestId: "req-old",
          });

          recoverStaleSending(env.db);
          const after = deliveryOf(env, "d-hook-old");
          assert.equal(after.status, "fallback");
          assert.equal(after.last_error, UNCERTAIN_EXCEEDED_WINDOW_ERROR);
          assert.notEqual(after.request_started_at, null, "超窗行不得被 requeueRoute 自动重投");

          forceDue(env);
          await drainDue(env.db, env.config);
          assert.equal(captured.length, 0, "超窗的 webhook 不确定投递不得自动重投");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});
