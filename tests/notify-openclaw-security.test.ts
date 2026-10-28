import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, it } from "node:test";
import { type ChannelDeliveryInput, openclawChannel } from "../src/core/channels.js";
import { drainDue, getPushRoute, publishProfile } from "../src/core/notify.js";
import { ensureProfile, setSetting } from "../src/core/settings.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * P2-17 / S-01：OpenClaw 通道的凭据边界。
 *
 * 修复前的语义：任何 profile 都能给自己配一条 openclaw 回环路由（任意端口/路径），
 * daemon 投递时把 **全局** OPENCLAW_HOOK_TOKEN 发到那个 URL —— 一个有独立 Profile token
 * 的隔离用户只要改自己的推送路由，就能把 master 的 hooks token 引到自己的本地服务上。
 *
 * 修复后的契约（组合方案：per-profile secret 优先 + master 准入门槛 + /hooks/ 路径收紧）：
 * 1. PROFILE_TOKENS_JSON 里登记了独立 token 的 profile（= 隔离用户）配置 openclaw 路由时
 *    必须提供自己的 route secret；没有就**明确失败**，绝不回退全局 token；
 * 2. 提供了独立 secret 时，投递的 Authorization 必须用该 secret（而不是全局 token）；
 * 3. master（没有独立 Profile token 的部署/profile）仍用全局 OPENCLAW_HOOK_TOKEN，行为不变；
 * 4. openclaw 路由路径只接受 /hooks/<name>。
 *
 * 「有牙齿」：断言的是真实 HTTP 请求收到的 Authorization 头，而不是函数返回值。
 * 把 notify/index.ts 的 master 准入门槛删掉 → 用例 1 会在「配置必须失败」和「不得有请求」
 * 两处同时失败；把 channels.ts 的凭据优先级改成「先全局后 profile」→ 用例 2/5 失败。
 */

const MASTER_TOKEN = "m".repeat(32);
/** alice 的 Profile token：长度 ≥ MIN_TOKEN_LENGTH(32) 且与 master token 不同 */
const ALICE_TOKEN = "a".repeat(32);
/** alice 自己的 route secret（P2-17 后 openclaw 非 master 路由必须提供） */
const ALICE_SECRET = "s".repeat(40);
/** daemon 全局 hooks token（属于 master） */
const GLOBAL_HOOK_TOKEN = "global-openclaw-hook-token";

interface Captured {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/** 起一个本地 http 服务，记录每次请求的 URL/头/正文（用于断言 Authorization 头） */
function withCaptureServer(
  fn: (url: string, captured: Captured[], server: Server) => Promise<void>,
  path = "/hooks/life-default",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const captured: Captured[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        captured.push({
          url: req.url ?? "",
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"ok":true}');
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr !== null && typeof addr === "object");
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fn(url, captured, server)
        .then(() => server.close(() => resolve()))
        .catch((e) => server.close(() => reject(e)));
    });
  });
}

async function withOpenclawToken<T>(token: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENCLAW_HOOK_TOKEN;
  if (token === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
  else process.env.OPENCLAW_HOOK_TOKEN = token;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
    else process.env.OPENCLAW_HOOK_TOKEN = previous;
  }
}

function tool(env: TestEnv, args: Record<string, unknown>, profileId: string) {
  return notifyTool(args, {
    profileId,
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async () => ({ materialized: 0 }),
    },
  });
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function deliveryRows(env: TestEnv): Record<string, unknown>[] {
  return env.db.prepare("SELECT * FROM deliveries").all() as Record<string, unknown>[];
}

/** 隔离用户 alice：有独立 Profile token；master 是 default（不在 PROFILE_TOKENS_JSON 里） */
function isolatedEnv(extra: Record<string, string> = {}): TestEnv {
  return makeTestEnv({
    WEB_API_TOKEN: MASTER_TOKEN,
    PROFILE_TOKENS_JSON: JSON.stringify({ alice: ALICE_TOKEN }),
    ...extra,
  });
}

function openclawDeliveryInput(
  url: string,
  over: Partial<ChannelDeliveryInput> = {},
): ChannelDeliveryInput {
  return {
    profileId: "alice",
    notificationId: "n-openclaw-sec",
    kind: "test.kind",
    title: "OpenClaw 标题",
    bodyMd: "OpenClaw 正文",
    createdAt: "2026-10-24T00:00:00.000Z",
    requestId: "request-openclaw-sec-1",
    generation: 0,
    route: { name: "openclaw-route", url },
    ...over,
  };
}

describe("OpenClaw 通道凭据边界（P2-17）", () => {
  it("① 隔离用户没有自己的 secret 时配置 openclaw 路由：明确 fail，且全局 token 不发往该 URL", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = isolatedEnv();
      try {
        await withCaptureServer(async (url, captured) => {
          const result = tool(env, { action: "route", channel: "openclaw", url }, "alice");
          assert.equal(result.isError, true, "隔离用户不得借用全局 hooks token 配置 openclaw");
          assert.match(text(result), /仅 master|独立 secret/);
          assert.equal(getPushRoute(env.db, "alice"), null, "失败时不得落任何路由");

          // 配置被拒后即便发布通知，也不该有任何请求到达该 URL（更不该带上全局 token）
          publishProfile(env.db, env.config, "alice", {
            kind: "test.kind",
            title: "不该被投递",
            blocks: {},
          });
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 0, "被拒的路由不得产生投递请求");
          assert.equal(deliveryRows(env).length, 0, "无路由时不应落投递行");
        }, "/hooks/attacker");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("② 隔离用户配置了自己的 secret：投递的 Authorization 是 profile secret，不是全局 token", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = isolatedEnv({
        PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ alice: ALICE_SECRET }),
      });
      try {
        await withCaptureServer(async (url, captured) => {
          const configured = tool(env, { action: "route", channel: "openclaw", url }, "alice");
          assert.ok(!configured.isError, `带独立 secret 时应允许配置: ${text(configured)}`);

          const pub = publishProfile(env.db, env.config, "alice", {
            kind: "test.kind",
            title: "隔离用户通知",
            blocks: {},
          });
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 1, "应当真的投递到该 URL");
          const request = captured[0];
          assert.ok(request !== undefined);
          assert.equal(request.headers.authorization, `Bearer ${ALICE_SECRET}`);
          assert.notEqual(
            request.headers.authorization,
            `Bearer ${GLOBAL_HOOK_TOKEN}`,
            "隔离用户的投递绝不能带上 master 的全局 token",
          );
          const row = deliveryRows(env).find((r) => r.notification_id === pub.id);
          assert.equal(row?.status, "sent");
        }, "/hooks/alice");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("③ master 路径不回归：未登记 Profile token 的 profile 仍用全局 OPENCLAW_HOOK_TOKEN", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      // alice 有独立 token，default（master 代表）没有：同一部署里两种身份并存
      const env = isolatedEnv();
      try {
        await withCaptureServer(async (url, captured) => {
          const configured = tool(env, { action: "route", channel: "openclaw", url }, "default");
          assert.ok(!configured.isError, `master 配置 openclaw 不应失败: ${text(configured)}`);

          const pub = publishProfile(env.db, env.config, "default", {
            kind: "test.kind",
            title: "master 通知",
            blocks: {},
          });
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 1);
          assert.equal(captured[0]?.headers.authorization, `Bearer ${GLOBAL_HOOK_TOKEN}`);
          const row = deliveryRows(env).find((r) => r.notification_id === pub.id);
          assert.equal(row?.status, "sent");
        }, "/hooks/life-default");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("④ 路由路径收紧：非 /hooks/<name> 一律拒绝（工具层与通道层）", async () => {
    const env = isolatedEnv({
      PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ alice: ALICE_SECRET }),
    });
    try {
      for (const url of [
        "http://127.0.0.1:18789/hook",
        "http://127.0.0.1:18789/",
        "http://127.0.0.1:18789/hooks",
        "http://127.0.0.1:18789/admin?x=1",
      ]) {
        assert.throws(() => openclawChannel.validateRoute({ url }), /\/hooks\//, url);
        // master 身份也一样拒绝：路径收紧与身份无关
        const viaTool = tool(env, { action: "route", channel: "openclaw", url }, "default");
        assert.equal(viaTool.isError, true, `工具层应拒绝 ${url}`);
        assert.match(text(viaTool), /\/hooks\//);
        assert.equal(getPushRoute(env.db, "default"), null);
      }
      assert.equal(
        openclawChannel.validateRoute({ url: "http://127.0.0.1:18789/hooks/life-default" }),
        "http://127.0.0.1:18789/hooks/life-default",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("⑤ 没有全局 token 时，profile secret 单独可用；两者都没有时错误信息点明两个来源", async () => {
    await withOpenclawToken(undefined, async () => {
      await withCaptureServer(async (url, captured) => {
        const outcome = await openclawChannel.deliver(
          openclawDeliveryInput(url, { secret: ALICE_SECRET }),
        );
        assert.equal(outcome.status, "sent");
        assert.equal(captured[0]?.headers.authorization, `Bearer ${ALICE_SECRET}`);
      }, "/hooks/alice");

      const missing = await openclawChannel.deliver(
        openclawDeliveryInput("http://127.0.0.1:1/hooks/alice"),
      );
      assert.equal(missing.status, "terminal_failure");
      if (missing.status === "terminal_failure") {
        assert.match(missing.error, /PROFILE_ROUTE_SECRETS_JSON/);
        assert.match(missing.error, /OPENCLAW_HOOK_TOKEN/);
      }
    });
  });

  it("⑥ 收紧前遗留的隔离用户 openclaw 路由：不允许被重新启用（不 requeue 全局 token）", async () => {
    await withOpenclawToken(GLOBAL_HOOK_TOKEN, async () => {
      const env = isolatedEnv();
      try {
        ensureProfile(env.db, "alice");
        // 模拟 P2-17 之前落库的路由：openclaw + 无 profile secret，当前是停用状态
        setSetting(env.db, "alice", "push_route", {
          name: "life-assistant-alice",
          url: "http://127.0.0.1:9/hooks/legacy",
          platform: null,
          enabled: false,
          channel: "openclaw",
        });
        const enabled = tool(env, { action: "route", enabled: true }, "alice");
        assert.equal(enabled.isError, true, "隔离用户不得重新启用使用全局 token 的路由");
        assert.match(text(enabled), /仅 master|独立 secret/);
        assert.equal(getPushRoute(env.db, "alice")?.enabled, false, "路由必须保持停用");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });
});
