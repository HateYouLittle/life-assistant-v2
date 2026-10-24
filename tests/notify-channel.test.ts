import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import {
  type ChannelDeliveryInput,
  DEFAULT_CHANNEL,
  getChannel,
  type NotificationChannel,
  openclawChannel,
  supportedChannels,
} from "../src/core/channels.js";
import {
  drainDue,
  EVENT_TYPE,
  getPushRoute,
  publishGlobal,
  publishProfile,
  setPushRoute,
} from "../src/core/notify.js";
import { setSetting } from "../src/core/settings.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { cleanupTestEnv, makeTestEnv, SECRET, type TestEnv } from "./helpers.js";

/**
 * 投递通道抽象（功能5）：webhook 逐字保留既有协议与重试语义，log 是本地日志通道。
 * 既有 webhook 行为细节已在 tests/notify.test.ts 钉住，这里只补「通道层」新增语义：
 * 旧数据兼容、channel=log 无 secret/URL、未知通道拒绝、publishGlobal 口径、request_id 不变。
 */

interface Captured {
  headers: IncomingMessage["headers"];
  body: string;
}

function withHookServer(
  respond: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  fn: (url: string, captured: Captured[], server: Server) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const captured: Captured[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        captured.push({ headers: req.headers, body });
        respond(req, res, body);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr !== null && typeof addr === "object");
      const url = `http://127.0.0.1:${addr.port}/hook`;
      fn(url, captured, server)
        .then(() => server.close(() => resolve()))
        .catch((e) => server.close(() => reject(e)));
    });
  });
}

function unusedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      assert.ok(addr !== null && typeof addr === "object");
      const port = addr.port;
      server.close(() => resolve(port));
    });
  });
}

function openclawDeliveryInput(
  url: string,
  over: Partial<ChannelDeliveryInput> = {},
): ChannelDeliveryInput {
  return {
    profileId: "default",
    notificationId: "n-openclaw",
    kind: "test.kind",
    title: "OpenClaw 标题",
    bodyMd: "OpenClaw 正文",
    createdAt: "2026-10-24T00:00:00.000Z",
    requestId: "request-openclaw-1",
    generation: 0,
    route: { name: "openclaw-route", url },
    ...over,
  };
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

function forceDue(db: TestEnv["db"]): void {
  db.exec("UPDATE deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
}

function deliveryRows(db: TestEnv["db"]): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM deliveries").all() as Record<string, unknown>[];
}

function tool(env: TestEnv, args: Record<string, unknown>, profileId = "default") {
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

describe("投递通道抽象", () => {
  it("通道清单与默认通道稳定（工具 schema 与文档共用这份清单）", () => {
    assert.equal(DEFAULT_CHANNEL, "webhook");
    assert.deepEqual(supportedChannels(), [
      "webhook",
      "log",
      "bark",
      "ntfy",
      "telegram",
      "smtp",
      "openclaw",
    ]);
    const channel: NotificationChannel = getChannel(undefined);
    assert.equal(channel.name, DEFAULT_CHANNEL, "缺省 channel 必须解析为 webhook");
  });

  it("旧路由（无 channel 字段）仍按 webhook 投递：HMAC V2/头部/request_id 口径不变", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        },
        async (url, captured) => {
          // 模拟改造前落库的 push_route：没有 channel 字段（旧数据不迁移）
          setSetting(env.db, "default", "push_route", {
            name: "life-assistant-default",
            url,
            platform: null,
            enabled: true,
          });
          assert.equal(
            getPushRoute(env.db, "default")?.channel,
            undefined,
            "旧数据不得被读取路径改写",
          );

          const result = publishProfile(env.db, env.config, "default", {
            kind: "test.kind",
            title: "旧路由通知",
            blocks: {},
          });
          assert.equal(result.deduped, false);
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 1, "无 channel 的旧路由必须仍走 webhook");
          const first = captured[0];
          assert.ok(first !== undefined);
          const { headers, body } = first;
          const timestamp = headers["x-webhook-timestamp"] as string;
          const signature = headers["x-webhook-signature-v2"] as string;
          assert.ok(/^\d+$/.test(timestamp), "webhook 仍带 X-Webhook-Timestamp");
          assert.equal(
            signature,
            createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex"),
            "HMAC-SHA256 V2 签名应为 hex(timestamp.body)",
          );
          assert.match(
            headers["x-request-id"] as string,
            /^life-assistant:default:.+:life-assistant-default:a0$/,
            "request_id 口径不随通道抽象变化",
          );
          const payload = JSON.parse(body) as {
            event_type: string;
            notification: { profileId: string; source: string; title: string; body: string };
          };
          assert.equal(payload.event_type, EVENT_TYPE);
          assert.equal(payload.notification.profileId, "default");
          assert.equal(payload.notification.source, "test.kind");
          assert.equal(payload.notification.title, "旧路由通知");

          const row = deliveryRows(env.db)[0];
          assert.ok(row !== undefined);
          assert.equal(row.status, "sent");
          const notif = env.db
            .prepare("SELECT read FROM notifications WHERE id = ?")
            .get(row.notification_id as string) as { read: number };
          assert.equal(notif.read, 1);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("channel=log：无 secret、无 URL 也能入队并投递为 sent，通知标已读", async () => {
    // 刻意不配 PROFILE_ROUTE_SECRETS_JSON：log 通道不应要求 secret
    const env = makeTestEnv();
    try {
      const route = setPushRoute(env.db, "default", { channel: "log" });
      assert.equal(route.channel, "log");
      assert.equal(route.url, "", "log 通道不落 URL（空串）");
      assert.equal(route.enabled, true);

      const pub = publishProfile(env.db, env.config, "default", {
        kind: "k",
        title: "本地日志通知",
        blocks: {},
      });
      const queued = deliveryRows(env.db)[0];
      assert.ok(queued !== undefined);
      assert.equal(
        queued.status,
        "queued",
        "log 路由必须能入队（不能被空 URL 判成 route removed）",
      );

      await drainDue(env.db, env.config);
      const row = deliveryRows(env.db)[0];
      assert.ok(row !== undefined);
      assert.equal(row.status, "sent", "log 通道应直接投递成功");
      assert.equal(row.last_error, null);
      assert.match(
        String(row.request_id),
        /^life-assistant:default:.+:life-assistant-default:a0$/,
        "request_id 生成口径不随通道变化",
      );
      const notif = env.db.prepare("SELECT read FROM notifications WHERE id = ?").get(pub.id) as {
        read: number;
      };
      assert.equal(notif.read, 1, "log 成功投递也要把通知标已读（与 webhook 一致）");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("channel=log 的空 URL 不会被 skipReason 判成 route removed", async () => {
    const env = makeTestEnv();
    try {
      setPushRoute(env.db, "default", { channel: "log", name: "log-route" });
      const pub = publishProfile(env.db, env.config, "default", {
        kind: "k",
        title: "t",
        blocks: {},
      });
      await drainDue(env.db, env.config);
      const row = deliveryRows(env.db).find((r) => r.notification_id === pub.id);
      assert.ok(row !== undefined);
      assert.equal(row.status, "sent");
      assert.notEqual(
        row.last_error,
        "route removed",
        "空 URL 只对需要 URL 的通道才是 route removed",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未知通道：setPushRoute 与工具层都报错，且不落任何设置", () => {
    const env = makeTestEnv();
    try {
      assert.throws(
        () => setPushRoute(env.db, "default", { channel: "sms", url: "http://127.0.0.1:9/hook" }),
        /不支持的推送通道/,
      );
      const result = tool(env, {
        action: "route",
        channel: "sms",
        url: "http://127.0.0.1:9/hook",
      });
      assert.equal(result.isError, true);
      assert.match(text(result), /不支持的推送通道/);
      // 只传未知 channel（无 url）也必须拒绝：否则会落一条无法投递的路由
      const noUrl = tool(env, { action: "route", channel: "sms" });
      assert.equal(noUrl.isError, true);
      assert.equal(getPushRoute(env.db, "default"), null, "未知通道不得写入 push_route");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("工具层 channel=log：不要求 env secret，获取路由时展示 channel", () => {
    const env = makeTestEnv();
    try {
      const set = tool(env, { action: "route", channel: "log" });
      assert.ok(!set.isError, "channel=log 不应再要求 PROFILE_ROUTE_SECRETS_JSON");
      const route = getPushRoute(env.db, "default");
      assert.equal(route?.channel, "log");
      assert.equal(route?.url, "");

      const got = JSON.parse(text(tool(env, { action: "route" }))) as {
        推送路由: { channel: string; url: string; secretConfigured: boolean };
      };
      assert.equal(got.推送路由.channel, "log", "获取路由时必须展示 channel");
      assert.equal(got.推送路由.url, "");
      assert.equal(got.推送路由.secretConfigured, false, "log 通道不需要 secret");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("显式 channel=webhook 时重试/终结语义与既有 webhook 一致", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    let calls = 0;
    try {
      await withHookServer(
        (_req, res) => {
          calls += 1;
          if (calls === 1) {
            res.writeHead(500);
            res.end("boom");
          } else {
            res.writeHead(403);
            res.end("forbidden");
          }
        },
        async (url) => {
          setPushRoute(env.db, "default", { url, channel: "webhook" });
          assert.equal(getPushRoute(env.db, "default")?.channel, "webhook");
          publishProfile(env.db, env.config, "default", { kind: "k", title: "t", blocks: {} });

          forceDue(env.db);
          await drainDue(env.db, env.config);
          const first = deliveryRows(env.db)[0];
          assert.ok(first !== undefined);
          assert.equal(first.status, "failed", "5xx 应进入退避重试，不能直接终结");
          assert.equal(first.confirmed_failures, 1);
          assert.equal(first.request_id, null, "确认失败后清空 request_id（既有语义）");
          const deltaSec =
            (new Date(first.next_attempt_at as string).getTime() - Date.now()) / 1000;
          assert.ok(
            Math.abs(deltaSec - 60) < 15,
            `首次确认失败后退避应约 60s，实际 ${deltaSec.toFixed(0)}s`,
          );

          forceDue(env.db);
          await drainDue(env.db, env.config);
          const second = deliveryRows(env.db)[0];
          assert.ok(second !== undefined);
          assert.equal(second.status, "fallback", "4xx 是确定性拒绝，必须直接终结");
          assert.equal(second.last_error, "HTTP 403");
          assert.equal(second.attempts, 2);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("publishGlobal：channel=log 的无 URL 路由也算「已配置路由」", async () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)")
        .run("p2", new Date().toISOString());
      setPushRoute(env.db, "p2", { channel: "log" });

      await publishGlobal(env.db, env.config, { kind: "k", title: "广播", blocks: {} });
      const ids = (
        env.db.prepare("SELECT profile_id FROM notifications").all() as { profile_id: string }[]
      ).map((r) => r.profile_id);
      assert.deepEqual(ids, ["p2"], "log 路由（url 为空）不得被 routedProfiles 漏掉");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("库里出现未知 channel（手工改库/降级回滚）不抛错、也不误投", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setSetting(env.db, "default", "push_route", {
        name: "life-assistant-default",
        url: "http://127.0.0.1:9/hook",
        platform: null,
        enabled: true,
        channel: "sms",
      });
      publishProfile(env.db, env.config, "default", { kind: "k", title: "t", blocks: {} });
      assert.equal(deliveryRows(env.db).length, 0, "未知通道按不可投递处理（通知仍可 pull）");
      // 关键回归：不能让跳过逻辑抛错（每轮 drain 都断在它上面会饿死其它 Profile）
      const processed = await drainDue(env.db, env.config);
      assert.equal(processed, 0);
      const global = await publishGlobal(env.db, env.config, {
        kind: "k",
        title: "g",
        blocks: {},
      });
      assert.equal(global.materialized, 0, "未知通道的路由不得进入 routedProfiles");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("OpenClaw 通道", () => {
  it("注册、回环 URL 校验与路径/query 保留", () => {
    assert.equal(getChannel("openclaw"), openclawChannel);
    assert.equal(openclawChannel.requiresSecret, false);
    assert.equal(openclawChannel.requiresUrl, true);

    for (const url of [
      "http://127.0.0.1:18789/hooks/life-default",
      "http://localhost:18789/hooks/x",
    ]) {
      assert.equal(openclawChannel.validateRoute({ url }), url);
    }
    assert.equal(
      openclawChannel.validateRoute({ url: "http://127.0.0.1:18789/hooks/x/" }),
      "http://127.0.0.1:18789/hooks/x",
    );
    assert.equal(
      openclawChannel.validateRoute({ url: "http://127.0.0.1:18789/hooks/x/?token=a/" }),
      "http://127.0.0.1:18789/hooks/x/?token=a/",
      "有 query 时不能剥掉路径或 query 末尾的斜杠",
    );

    for (const url of [
      "http://192.168.1.5/hook",
      "https://example.com/hook",
      "ftp://127.0.0.1/hook",
    ]) {
      assert.throws(() => openclawChannel.validateRoute({ url }), /openclaw/);
    }
  });

  it("deliver 发送 Bearer token、幂等头与通知 JSON", async () => {
    await withOpenclawToken("  openclaw-test-token  ", async () => {
      await withHookServer(
        (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        },
        async (url, captured) => {
          const input = openclawDeliveryInput(url, {
            title: "交房租",
            bodyMd: "**今天**记得转账",
            requestId: "req-openclaw-123",
          });
          const outcome = await openclawChannel.deliver(input);
          assert.equal(outcome.status, "sent");

          const request = captured[0];
          assert.ok(request !== undefined);
          assert.equal(request.headers.authorization, "Bearer openclaw-test-token");
          assert.equal(request.headers["content-type"], "application/json");
          assert.equal(request.headers["x-request-id"], "req-openclaw-123");
          assert.equal(request.headers["idempotency-key"], "req-openclaw-123");

          const payload = JSON.parse(request.body) as {
            event_type: string;
            notification: {
              profileId: string;
              source: string;
              title: string;
              body: string;
              createdAt: string;
            };
          };
          assert.equal(payload.event_type, EVENT_TYPE);
          assert.deepEqual(payload.notification, {
            profileId: "default",
            source: "test.kind",
            title: "交房租",
            body: "**今天**记得转账",
            createdAt: "2026-10-24T00:00:00.000Z",
          });
        },
      );
    });
  });

  it("状态码映射：2xx sent、429 confirmed、400 terminal；闭端口 transport", async () => {
    await withOpenclawToken("openclaw-test-token", async () => {
      for (const [status, expected] of [
        [200, "sent"],
        [429, "confirmed_failure"],
        [400, "terminal_failure"],
      ] as const) {
        await withHookServer(
          (_req, res) => {
            res.writeHead(status);
            res.end("boom");
          },
          async (url) => {
            const outcome = await openclawChannel.deliver(openclawDeliveryInput(url));
            assert.equal(outcome.status, expected, `HTTP ${status}`);
            if (outcome.status !== "sent") assert.match(outcome.error, /^openclaw 返回 HTTP/);
          },
        );
      }

      const port = await unusedPort();
      const outcome = await openclawChannel.deliver(
        openclawDeliveryInput(`http://127.0.0.1:${port}/hook`),
      );
      assert.equal(outcome.status, "transport_failure");
      if (outcome.status === "transport_failure") {
        assert.match(outcome.error, /^openclaw 投递失败：/);
      }
    });
  });

  it("缺少 OPENCLAW_HOOK_TOKEN 时终结本次投递并给出中文配置提示", async () => {
    await withOpenclawToken(undefined, async () => {
      const outcome = await openclawChannel.deliver(
        openclawDeliveryInput("http://127.0.0.1:1/hook"),
      );
      assert.deepEqual(outcome, {
        status: "terminal_failure",
        error:
          "openclaw 通道缺少 OPENCLAW_HOOK_TOKEN（在 daemon 的 .env 里配置 OpenClaw hooks.token）",
      });
    });
  });

  it("notify route 接受 openclaw，outbox 无 profile secret 也能按 Profile 投递", async () => {
    await withOpenclawToken("openclaw-test-token", async () => {
      const env = makeTestEnv();
      try {
        await withHookServer(
          (_req, res) => {
            res.writeHead(200);
            res.end("ok");
          },
          async (url, captured) => {
            const configured = tool(env, { action: "route", channel: "openclaw", url });
            assert.ok(!configured.isError, "openclaw 不应要求 PROFILE_ROUTE_SECRETS_JSON");
            const pub = publishProfile(env.db, env.config, "default", {
              kind: "test.kind",
              title: "OpenClaw outbox",
              blocks: {},
            });
            await drainDue(env.db, env.config);

            const row = env.db
              .prepare("SELECT status, last_error FROM deliveries WHERE notification_id = ?")
              .get(pub.id) as { status: string; last_error: string | null } | undefined;
            assert.ok(row !== undefined);
            assert.equal(row.status, "sent", row.last_error ?? "");
            assert.equal(captured.length, 1);
          },
        );
      } finally {
        cleanupTestEnv(env);
      }
    });
  });
});
