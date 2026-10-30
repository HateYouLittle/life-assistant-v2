import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import {
  assertOpenclawRouteMatchesTarget,
  buildOpenclawRouteUrl,
  type ChannelDeliveryInput,
  openclawChannel,
} from "../src/core/channels.js";
import { drainDue, getPushRoute, publishProfile } from "../src/core/notify.js";
import { setSetting } from "../src/core/settings.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * OpenClaw 目标绑定（shared-trust）：
 * - 共享 OPENCLAW_HOOK_TOKEN 时，每个 Profile 的 agent/channel/to/accountId 必须与
 *   OPENCLAW_PROFILE_TARGETS_JSON 登记值一致，不能通过改 URL 把消息投到别人那里；
 * - 直连参数在配置期校验，409 可重试，401/400 有可照做的提示；
 * - waitForCompletion=true 时只有 completion.delivered=true 才算送达，静默抑制保持未读。
 */

const MASTER_TOKEN = "m".repeat(32);
const OWNER_TOKEN = "o".repeat(32);
const BESTIE_TOKEN = "b".repeat(32);
const GLOBAL_HOOK_TOKEN = "global-openclaw-hook-token";

interface Captured {
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  fn: (baseUrl: string, captured: Captured[], server: Server) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const captured: Captured[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        captured.push({ url: req.url ?? "", headers: req.headers, body });
        handler(req, res, body);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr !== null && typeof addr === "object");
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      fn(baseUrl, captured, server)
        .then(() => server.close(() => resolve()))
        .catch((e) => server.close(() => reject(e)));
    });
  });
}

function okJson(res: ServerResponse, body: unknown = { ok: true, runId: "run-1" }): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function deliveryInput(
  url: string,
  over: Partial<ChannelDeliveryInput> = {},
): ChannelDeliveryInput {
  return {
    profileId: "bestie",
    notificationId: "n-target",
    kind: "test.kind",
    title: "目标绑定",
    bodyMd: "正文",
    createdAt: "2026-10-24T00:00:00.000Z",
    requestId: "request-target-1",
    generation: 0,
    route: { name: "openclaw-route", url },
    ...over,
  };
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

function deploymentEnv(extra: Record<string, string> = {}): TestEnv {
  return makeTestEnv({
    WEB_API_TOKEN: MASTER_TOKEN,
    HERMES_PROFILE: "default",
    PROFILE_TOKENS_JSON: JSON.stringify({ default: OWNER_TOKEN, bestie: BESTIE_TOKEN }),
    OPENCLAW_HOOK_TOKEN: GLOBAL_HOOK_TOKEN,
    ...extra,
  });
}

describe("OpenClaw 直连参数校验", () => {
  it("缺 channel/to、channel=last、accountId 空、未知 query、token query、userinfo/hash 都拒绝", () => {
    const valid =
      "http://127.0.0.1:18789/hooks/agent?channel=qqbot&to=qqbot%3Ac2c%3Ax&agentId=main&accountId=default";
    assert.equal(openclawChannel.validateRoute({ url: valid }), valid);

    const invalid: Array<[string, RegExp]> = [
      ["http://127.0.0.1:18789/hooks/agent", /需要非空 channel/],
      ["http://127.0.0.1:18789/hooks/agent?channel=qqbot", /需要非空 to/],
      ["http://127.0.0.1:18789/hooks/agent?channel=last&to=x", /不能是 last/],
      ["http://127.0.0.1:18789/hooks/agent?channel=qqbot&to=x&accountId=", /accountId 不能为空/],
      ["http://127.0.0.1:18789/hooks/agent?channel=qqbot&to=x&foo=bar", /不接受 query 参数 foo/],
      ["http://127.0.0.1:18789/hooks/agent?channel=qqbot&to=x&token=abc", /不接受 \?token=/],
      ["http://user:pass@127.0.0.1:18789/hooks/x", /用户名\/密码/],
      ["http://127.0.0.1:18789/hooks/x#frag", /# 片段/],
    ];
    for (const [url, pattern] of invalid) {
      assert.throws(() => openclawChannel.validateRoute({ url }), pattern, url);
    }
  });
});

describe("OpenClaw 目标绑定与投递结果", () => {
  it("buildOpenclawRouteUrl / assertOpenclawRouteMatchesTarget：直连逐项匹配，映射只看 hook", () => {
    const direct = {
      mode: "direct" as const,
      auth: "global" as const,
      baseUrl: "http://127.0.0.1:18789",
      agentId: "main",
      channel: "qqbot",
      to: "qqbot:c2c:default",
      accountId: "default",
      waitForCompletion: false,
    };
    const url = buildOpenclawRouteUrl(direct, "http://127.0.0.1:1");
    assert.equal(
      url,
      "http://127.0.0.1:18789/hooks/agent?channel=qqbot&to=qqbot%3Ac2c%3Adefault&agentId=main&accountId=default",
    );
    assert.doesNotThrow(() => assertOpenclawRouteMatchesTarget(url, direct, "default"));
    const wrong = url.replace("to=qqbot%3Ac2c%3Adefault", "to=qqbot%3Ac2c%3Abestie");
    assert.throws(
      () => assertOpenclawRouteMatchesTarget(wrong, direct, "default"),
      /不一致：to/,
      "改 to 必须被目标绑定拦住",
    );

    const mapping = {
      mode: "mapping" as const,
      auth: "global" as const,
      baseUrl: "http://127.0.0.1:18789",
      hook: "life-bestie",
    };
    const mappingUrl = buildOpenclawRouteUrl(mapping, "http://127.0.0.1:1");
    assert.equal(mappingUrl, "http://127.0.0.1:18789/hooks/life-bestie");
    assert.doesNotThrow(() => assertOpenclawRouteMatchesTarget(mappingUrl, mapping, "bestie"));
    assert.throws(
      () =>
        assertOpenclawRouteMatchesTarget(
          "http://127.0.0.1:18789/hooks/life-default",
          mapping,
          "bestie",
        ),
      /路径必须是 \/hooks\/life-bestie/,
    );
  });

  it("409 按可重试处理；401/400 带可照做的提示", async () => {
    const cases: Array<[number, string, string, RegExp]> = [
      [409, "hook configuration changed; retry request", "confirmed_failure", /HTTP 409/],
      [401, "Unauthorized", "terminal_failure", /hooks\.token/],
      [400, '{"ok":false,"error":"message required"}', "terminal_failure", /channel\/to/],
    ];
    for (const [status, body, expected, hint] of cases) {
      await withServer(
        (_req, res) => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(body);
        },
        async (baseUrl) => {
          const outcome = await openclawChannel.deliver(
            deliveryInput(`${baseUrl}/hooks/life-bestie`, {
              openclawGlobalToken: GLOBAL_HOOK_TOKEN,
            }),
          );
          assert.equal(outcome.status, expected, `HTTP ${status}`);
          if (outcome.status !== "sent") assert.match(outcome.error, hint, `HTTP ${status}`);
        },
      );
    }
  });

  it("waitForCompletion：delivered=false/抑制/agent 失败都不算 sent，通知保持未读", async () => {
    const bodies = [
      {
        name: "delivered true",
        body: { ok: true, runId: "r1", completion: { status: "ok", delivered: true } },
        expected: "sent",
      },
      {
        name: "silent suppression",
        body: {
          ok: true,
          runId: "r2",
          completion: {
            status: "ok",
            delivered: false,
            deliverySuppressionReason: "silent",
          },
        },
        expected: "terminal_failure",
      },
      {
        name: "delivery error",
        body: {
          ok: true,
          runId: "r3",
          completion: { status: "ok", delivered: false, deliveryError: "channel-error" },
        },
        expected: "confirmed_failure",
      },
      {
        name: "agent failed",
        body: { ok: true, runId: "r4", completion: { status: "error", delivered: false } },
        expected: "confirmed_failure",
      },
      {
        name: "missing completion",
        body: { ok: true, runId: "r5" },
        expected: "terminal_failure",
      },
    ];
    for (const testCase of bodies) {
      await withServer(
        (_req, res) => okJson(res, testCase.body),
        async (baseUrl, captured) => {
          const outcome = await openclawChannel.deliver(
            deliveryInput(`${baseUrl}/hooks/agent?channel=qqbot&to=x`, {
              openclawGlobalToken: GLOBAL_HOOK_TOKEN,
              openclawWaitForCompletion: true,
            }),
          );
          assert.equal(outcome.status, testCase.expected, testCase.name);
          const payload = JSON.parse(captured[0]?.body ?? "{}") as Record<string, unknown>;
          assert.equal(payload.waitForCompletion, true, testCase.name);
          assert.equal(payload.timeoutSeconds, 25, testCase.name);
        },
      );
    }
  });

  it("投递前目标不匹配：终结为 fallback，不发请求", async () => {
    await withServer(
      (_req, res) => okJson(res),
      async (baseUrl, captured) => {
        const target = {
          mode: "direct" as const,
          auth: "global" as const,
          baseUrl,
          agentId: "bestie",
          channel: "qqbot",
          to: "qqbot:c2c:bestie",
          waitForCompletion: false,
        };
        const outcome = await openclawChannel.deliver(
          deliveryInput(`${baseUrl}/hooks/agent?channel=qqbot&to=qqbot%3Ac2c%3Adefault`, {
            openclawTarget: target,
            openclawGlobalToken: GLOBAL_HOOK_TOKEN,
          }),
        );
        assert.equal(outcome.status, "terminal_failure");
        if (outcome.status === "terminal_failure") assert.match(outcome.error, /不一致：to/);
        assert.equal(captured.length, 0, "目标不匹配不得发出请求");
      },
    );
  });
});

describe("OpenClaw shared-trust 端到端隔离", () => {
  it("bestie/default 各自配置目标后，通知只进自己的 agent/聊天；不要求 route secret", async () => {
    await withServer(
      (_req, res) => okJson(res),
      async (baseUrl, captured) => {
        const targets = {
          default: {
            mode: "direct",
            baseUrl,
            agentId: "main",
            channel: "qqbot",
            to: "qqbot:c2c:default",
            accountId: "default",
          },
          bestie: {
            mode: "direct",
            baseUrl,
            agentId: "bestie",
            channel: "qqbot",
            to: "qqbot:c2c:bestie",
            accountId: "bestie",
          },
        };
        const env = deploymentEnv({
          OPENCLAW_PROFILE_TARGETS_JSON: JSON.stringify(targets),
        });
        try {
          for (const profileId of ["default", "bestie"]) {
            const configured = tool(env, { action: "route", channel: "openclaw" }, profileId);
            assert.ok(
              !configured.isError,
              `${profileId} 有登记目标时应可直接配置（无需 secret）：${text(configured)}`,
            );
            assert.match(getPushRoute(env.db, profileId)?.url ?? "", /\/hooks\/agent\?/);
          }

          for (const profileId of ["default", "bestie"]) {
            publishProfile(env.db, env.config, profileId, {
              kind: "test.kind",
              title: `${profileId} 的通知`,
              blocks: {},
            });
          }
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 2, "两条通知各发一次");
          const requests = captured.map((c) => {
            const payload = JSON.parse(c.body) as {
              channel: string;
              to: string;
              agentId: string;
              accountId: string;
            };
            return { ...payload, authorization: c.headers.authorization };
          });
          const byAgent = new Map(requests.map((r) => [r.agentId, r]));
          assert.equal(byAgent.get("main")?.to, "qqbot:c2c:default");
          assert.equal(byAgent.get("main")?.accountId, "default");
          assert.equal(byAgent.get("bestie")?.to, "qqbot:c2c:bestie");
          assert.equal(byAgent.get("bestie")?.accountId, "bestie");
          for (const request of requests) {
            assert.equal(
              request.authorization,
              `Bearer ${GLOBAL_HOOK_TOKEN}`,
              "共享 Gateway 用同一个 hooks.token",
            );
          }
        } finally {
          cleanupTestEnv(env);
        }
      },
    );
  });

  it("登记目标后：改 URL 改投会被工具层拒绝，手工改库的错路由投递也会 fallback", async () => {
    await withServer(
      (_req, res) => okJson(res),
      async (baseUrl, captured) => {
        const targets = {
          bestie: {
            mode: "direct",
            baseUrl,
            agentId: "bestie",
            channel: "qqbot",
            to: "qqbot:c2c:bestie",
            accountId: "bestie",
          },
        };
        const env = deploymentEnv({
          OPENCLAW_PROFILE_TARGETS_JSON: JSON.stringify(targets),
        });
        try {
          const wrongUrl = `${baseUrl}/hooks/agent?channel=qqbot&to=qqbot%3Ac2c%3Adefault&agentId=main`;
          const denied = tool(
            env,
            { action: "route", channel: "openclaw", url: wrongUrl },
            "bestie",
          );
          assert.equal(denied.isError, true, "目标不一致必须在配置期拒绝");
          assert.match(text(denied), /不一致/);
          assert.equal(getPushRoute(env.db, "bestie"), null);

          // 模拟旧版本/手工改库落下的错路由：配置期没拦住，投递前仍要拦住。
          setSetting(env.db, "bestie", "push_route", {
            name: "life-assistant-bestie",
            url: wrongUrl,
            platform: null,
            enabled: true,
            channel: "openclaw",
          });
          const pub = publishProfile(env.db, env.config, "bestie", {
            kind: "test.kind",
            title: "错路由通知",
            blocks: {},
          });
          await drainDue(env.db, env.config);
          const row = env.db
            .prepare("SELECT status, last_error FROM deliveries WHERE notification_id = ?")
            .get(pub.id) as { status: string; last_error: string | null } | undefined;
          assert.equal(row?.status, "fallback");
          assert.match(row?.last_error ?? "", /不一致/);
          assert.equal(captured.length, 0, "错路由不得发出请求");
        } finally {
          cleanupTestEnv(env);
        }
      },
    );
  });

  it("waitForCompletion 抑制：delivery=fallback、通知保持未读（可 pull/retry）", async () => {
    await withServer(
      (_req, res) =>
        okJson(res, {
          ok: true,
          runId: "r-silent",
          completion: {
            status: "ok",
            delivered: false,
            deliverySuppressionReason: "silent",
          },
        }),
      async (baseUrl, captured) => {
        const env = deploymentEnv({
          OPENCLAW_PROFILE_TARGETS_JSON: JSON.stringify({
            bestie: {
              mode: "direct",
              baseUrl,
              agentId: "bestie",
              channel: "qqbot",
              to: "qqbot:c2c:bestie",
              accountId: "bestie",
              waitForCompletion: true,
            },
          }),
        });
        try {
          const configured = tool(env, { action: "route", channel: "openclaw" }, "bestie");
          assert.ok(!configured.isError, text(configured));
          const pub = publishProfile(env.db, env.config, "bestie", {
            kind: "test.kind",
            title: "被抑制的通知",
            blocks: {},
          });
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 1, "请求确实发出（agent 也跑了）");
          const row = env.db
            .prepare("SELECT status, last_error FROM deliveries WHERE notification_id = ?")
            .get(pub.id) as { status: string; last_error: string | null } | undefined;
          assert.equal(row?.status, "fallback");
          assert.match(row?.last_error ?? "", /抑制.*silent/);
          const notification = env.db
            .prepare("SELECT read FROM notifications WHERE id = ?")
            .get(pub.id) as { read: number } | undefined;
          assert.equal(notification?.read, 0, "未送达不得标已读，否则 pull 也捞不回来");
        } finally {
          cleanupTestEnv(env);
        }
      },
    );
  });

  it("目标 auth=global 但缺 OPENCLAW_HOOK_TOKEN：配置期拒绝，publish 也不落注定失败的投递行", async () => {
    const env = makeTestEnv({
      WEB_API_TOKEN: MASTER_TOKEN,
      HERMES_PROFILE: "default",
      PROFILE_TOKENS_JSON: JSON.stringify({ default: OWNER_TOKEN, bestie: BESTIE_TOKEN }),
      OPENCLAW_PROFILE_TARGETS_JSON: JSON.stringify({
        bestie: {
          mode: "direct",
          agentId: "bestie",
          channel: "qqbot",
          to: "qqbot:c2c:bestie",
        },
      }),
    });
    try {
      const configured = tool(env, { action: "route", channel: "openclaw" }, "bestie");
      assert.equal(configured.isError, true);
      assert.match(text(configured), /OPENCLAW_HOOK_TOKEN/);

      // 绕过工具层手工落路由：publishProfile 仍应识别「缺凭据」，只留通知不入队。
      setSetting(env.db, "bestie", "push_route", {
        name: "life-assistant-bestie",
        url: "http://127.0.0.1:18789/hooks/agent?channel=qqbot&to=qqbot%3Ac2c%3Abestie&agentId=bestie",
        platform: null,
        enabled: true,
        channel: "openclaw",
      });
      const pub = publishProfile(env.db, env.config, "bestie", {
        kind: "test.kind",
        title: "缺凭据通知",
        blocks: {},
      });
      const deliveries = env.db
        .prepare("SELECT count(*) AS n FROM deliveries WHERE notification_id = ?")
        .get(pub.id) as { n: number };
      assert.equal(deliveries.n, 0, "缺凭据不应落投递行");
      const notification = env.db
        .prepare("SELECT read FROM notifications WHERE id = ?")
        .get(pub.id) as { read: number };
      assert.equal(notification.read, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("映射式目标：不传 url 时按登记 hook 生成路由", async () => {
    await withServer(
      (_req, res) => okJson(res),
      async (baseUrl) => {
        const env = deploymentEnv({
          OPENCLAW_PROFILE_TARGETS_JSON: JSON.stringify({
            bestie: { mode: "mapping", baseUrl, hook: "life-bestie" },
          }),
        });
        try {
          const configured = tool(env, { action: "route", channel: "openclaw" }, "bestie");
          assert.ok(!configured.isError, text(configured));
          assert.equal(getPushRoute(env.db, "bestie")?.url, `${baseUrl}/hooks/life-bestie`);
          const read = tool(env, { action: "route" }, "bestie");
          assert.match(text(read), /openclawTarget/);
          assert.match(text(read), /credentialSource/);
        } finally {
          cleanupTestEnv(env);
        }
      },
    );
  });
});

describe("OpenClaw 目标绑定加固", () => {
  it("assert 校验 origin：换端口、非回环都拒绝", () => {
    const target = {
      mode: "direct" as const,
      auth: "global" as const,
      baseUrl: "http://127.0.0.1:18789",
      channel: "qqbot",
      to: "x",
      accountId: "default",
      waitForCompletion: false,
    };
    assert.throws(
      () =>
        assertOpenclawRouteMatchesTarget(
          "http://127.0.0.1:18790/hooks/agent?channel=qqbot&to=x&accountId=default",
          target,
          "default",
        ),
      /origin/,
      "换端口必须被 origin 校验拦住",
    );
    assert.throws(
      () =>
        assertOpenclawRouteMatchesTarget(
          "http://example.com/hooks/agent?channel=qqbot&to=x",
          target,
          "default",
        ),
      /回环/,
      "非回环地址必须被拒绝",
    );
  });

  it("投递前 origin 不一致：不发请求", async () => {
    await withServer(
      (_req, res) => okJson(res),
      async (baseUrl, captured) => {
        const target = {
          mode: "direct" as const,
          auth: "global" as const,
          baseUrl: "http://127.0.0.1:1",
          channel: "qqbot",
          to: "x",
          waitForCompletion: false,
        };
        const outcome = await openclawChannel.deliver(
          deliveryInput(`${baseUrl}/hooks/agent?channel=qqbot&to=x`, {
            openclawTarget: target,
            openclawGlobalToken: GLOBAL_HOOK_TOKEN,
          }),
        );
        assert.equal(outcome.status, "terminal_failure");
        if (outcome.status === "terminal_failure") assert.match(outcome.error, /origin/);
        assert.equal(captured.length, 0, "origin 不匹配不得发出请求");
      },
    );
  });

  it("deliver 对非回环路由直接终结，不发请求", async () => {
    const outcome = await openclawChannel.deliver(
      deliveryInput("http://example.com/hooks/life-bestie", {
        openclawGlobalToken: GLOBAL_HOOK_TOKEN,
      }),
    );
    assert.equal(outcome.status, "terminal_failure");
    if (outcome.status === "terminal_failure")
      assert.match(outcome.error, /仅接受 127\.0\.0\.1|回环/);
  });

  it("重复 query 参数直接拒绝", () => {
    assert.throws(
      () =>
        openclawChannel.validateRoute({
          url: "http://127.0.0.1:18789/hooks/agent?channel=qqbot&channel=wechat&to=x",
        }),
      /重复 query 参数/,
    );
  });

  it("openclaw 凭据缺失：投递保持 queued 并延后，不落 fallback", async () => {
    const env = deploymentEnv({
      OPENCLAW_PROFILE_TARGETS_JSON: JSON.stringify({
        bestie: {
          mode: "direct",
          agentId: "bestie",
          channel: "qqbot",
          to: "qqbot:c2c:bestie",
        },
      }),
    });
    const prev = process.env.OPENCLAW_HOOK_TOKEN;
    try {
      const configured = tool(env, { action: "route", channel: "openclaw" }, "bestie");
      assert.ok(!configured.isError, text(configured));
      const now = new Date().toISOString();
      env.db
        .prepare(
          `INSERT INTO notifications (id, profile_id, kind, title, body_md, blocks_json, dedupe_key, read, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        )
        .run("n-defer", "bestie", "test.kind", "t", "b", "{}", null, now);
      env.db
        .prepare(
          `INSERT INTO deliveries (id, notification_id, route_name, status, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
        )
        .run("d-defer", "n-defer", "life-assistant-bestie", now, now, now);

      delete process.env.OPENCLAW_HOOK_TOKEN;
      const noToken = { ...env.config, openclawHookToken: undefined };
      await drainDue(env.db, noToken, 5_000);

      const row = env.db
        .prepare("SELECT status, next_attempt_at, last_error FROM deliveries WHERE id = ?")
        .get("d-defer") as
        | { status: string; next_attempt_at: string; last_error: string | null }
        | undefined;
      assert.equal(row?.status, "queued", "凭据缺失不得落 fallback");
      assert.equal(row?.last_error, "openclaw credentials missing");
      assert.ok(
        Date.parse(row?.next_attempt_at ?? "") > Date.now(),
        "应延后到未来重试，而不是每 20s 空转",
      );
    } finally {
      if (prev === undefined) delete process.env.OPENCLAW_HOOK_TOKEN;
      else process.env.OPENCLAW_HOOK_TOKEN = prev;
      cleanupTestEnv(env);
    }
  });
});
