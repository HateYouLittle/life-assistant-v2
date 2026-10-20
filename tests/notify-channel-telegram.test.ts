import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import {
  type ChannelDeliveryInput,
  type ChannelOutcome,
  getChannel,
  type NotificationChannel,
  telegramChannel,
} from "../src/core/channels.js";
import { drainDue, publishProfile, setPushRoute } from "../src/core/notify.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/**
 * Telegram 通道：本地假 HTTP 服务捕获真实请求，断言 method/path/body/headers、
 * URL 校验（缺 chat_id 必须在写入时就被拒）与四态映射。
 */

interface Captured {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

function withServer(
  respond: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  fn: (base: { url: string; port: number }, captured: Captured[]) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const captured: Captured[] = [];
    const server = createServer((req, res) => {
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
      const base = { url: `http://127.0.0.1:${addr.port}`, port: addr.port };
      fn(base, captured)
        .then(() => shutdown(server, resolve))
        .catch((e) => shutdown(server, () => reject(e)));
    });
  });
}

function shutdown(server: Server, done: () => void): void {
  server.closeAllConnections();
  server.close(() => done());
}

function deliveryInput(over: Partial<ChannelDeliveryInput> = {}): ChannelDeliveryInput {
  return {
    profileId: "default",
    notificationId: "n1",
    kind: "test.kind",
    title: "交房租",
    bodyMd: "**今天**记得转账",
    createdAt: "2026-10-20T00:00:00.000Z",
    requestId: "life-assistant:default:n1:life-assistant-default:a0",
    generation: 0,
    route: { name: "life-assistant-default", url: "http://127.0.0.1:1/bot123:abc/sendMessage" },
    ...over,
  };
}

async function deliverTo(
  channel: NotificationChannel,
  respond: (res: ServerResponse) => void,
  over: Partial<ChannelDeliveryInput> = {},
  path = "/bot123:abc/sendMessage?chat_id=42",
): Promise<{ outcome: ChannelOutcome; captured: Captured[] }> {
  let outcome: ChannelOutcome | undefined;
  let captured: Captured[] = [];
  await withServer(
    (_req, res) => respond(res),
    async (base, seen) => {
      captured = seen;
      outcome = await channel.deliver(
        deliveryInput({
          ...over,
          route: { name: "life-assistant-default", url: `${base.url}${path}` },
        }),
      );
    },
  );
  assert.ok(outcome !== undefined);
  return { outcome, captured };
}

function okResponse(res: ServerResponse): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end('{"ok":true,"result":{"message_id":1}}');
}

describe("Telegram 通道", () => {
  it("注册进通道表：需要 URL、不需要 secret", () => {
    const channel = getChannel("telegram");
    assert.equal(channel.name, "telegram");
    assert.equal(channel.requiresUrl, true);
    assert.equal(channel.requiresSecret, false);
    assert.equal(telegramChannel.requiresUrl, true);
  });

  it("validateRoute：校验 http(s) + host 非空 + chat_id，去路径尾斜杠", () => {
    assert.equal(
      telegramChannel.validateRoute({
        url: "https://api.telegram.org/bot123:abc/sendMessage?chat_id=42",
      }),
      "https://api.telegram.org/bot123:abc/sendMessage?chat_id=42",
    );
    // 尾斜杠会被剥掉（保留 query），否则部分反代回 301 会被判成确定性失败
    assert.equal(
      telegramChannel.validateRoute({
        url: "https://api.telegram.org/bot123:abc/sendMessage/?chat_id=42",
      }),
      "https://api.telegram.org/bot123:abc/sendMessage?chat_id=42",
    );
    // 自建 Bot API 服务器（局域网 http）也允许
    assert.equal(
      telegramChannel.validateRoute({
        url: "http://bot.lan:8081/bot1:x/sendMessage?chat_id=-100123",
      }),
      "http://bot.lan:8081/bot1:x/sendMessage?chat_id=-100123",
    );
  });

  it("validateRoute：缺 chat_id / 非 http(s) / 空串都拒绝", () => {
    assert.throws(
      () =>
        telegramChannel.validateRoute({ url: "https://api.telegram.org/bot123:abc/sendMessage" }),
      /chat_id/,
      "缺 chat_id 必须在写入时拒绝（投递时才发现只剩 fallback）",
    );
    assert.throws(
      () =>
        telegramChannel.validateRoute({
          url: "https://api.telegram.org/bot123:abc/sendMessage?chat_id=",
        }),
      /chat_id/,
    );
    assert.throws(
      () =>
        telegramChannel.validateRoute({
          url: "https://api.telegram.org/bot123:abc/sendMessage?chat_id=bad%20id",
        }),
      /chat_id/,
      "chat_id 里的空格/换行必须挡住（防命令/参数注入）",
    );
    assert.throws(
      () =>
        telegramChannel.validateRoute({ url: "ftp://api.telegram.org/bot1/sendMessage?chat_id=1" }),
      /仅支持 http\/https/,
    );
    assert.throws(() => telegramChannel.validateRoute({}), /需要 url/);
    assert.throws(() => telegramChannel.validateRoute({ url: "" }), /需要 url/);
    assert.throws(() => telegramChannel.validateRoute({ url: "不是URL" }), /URL 不合法/);
  });

  it("deliver：POST JSON {chat_id, text}，2xx → sent", async () => {
    const { outcome, captured } = await deliverTo(telegramChannel, okResponse);
    assert.equal(outcome.status, "sent");
    const req = captured[0];
    assert.ok(req !== undefined);
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/bot123:abc/sendMessage?chat_id=42");
    assert.equal(req.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(req.body), { chat_id: 42, text: "交房租\n\n**今天**记得转账" });
  });

  it("deliver：@频道名保持字符串，负数群组 id 转整数", async () => {
    const channel = await deliverTo(
      telegramChannel,
      okResponse,
      {},
      "/bot1:x/sendMessage?chat_id=@my_channel",
    );
    assert.equal(
      (JSON.parse(channel.captured[0]?.body ?? "{}") as { chat_id: unknown }).chat_id,
      "@my_channel",
    );
    const group = await deliverTo(
      telegramChannel,
      okResponse,
      {},
      "/bot1:x/sendMessage?chat_id=-1001234567890",
    );
    assert.equal(
      (JSON.parse(group.captured[0]?.body ?? "{}") as { chat_id: unknown }).chat_id,
      -1001234567890,
    );
  });

  it("状态码映射：429/5xx/408 → confirmed，其它 3xx/4xx → terminal", async () => {
    const cases: [number, ChannelOutcome["status"]][] = [
      [301, "terminal_failure"],
      [400, "terminal_failure"],
      [403, "terminal_failure"],
      [404, "terminal_failure"],
      [408, "confirmed_failure"],
      [429, "confirmed_failure"],
      [500, "confirmed_failure"],
    ];
    for (const [status, expected] of cases) {
      const { outcome } = await deliverTo(telegramChannel, (res) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end('{"ok":false,"description":"nope"}');
      });
      assert.equal(outcome.status, expected, `HTTP ${status} 应映射为 ${expected}`);
      if (outcome.status === "sent") continue;
      assert.match(outcome.error, /^Telegram 返回 HTTP \d+/);
      assert.ok(outcome.error.length <= 500, "错误文案必须截断到 500 字符内");
    }
  });

  it("连接被拒 → transport_failure（中文说明）", async () => {
    const outcome = await telegramChannel.deliver(
      deliveryInput({
        route: { name: "r", url: "http://127.0.0.1:1/bot1:x/sendMessage?chat_id=1" },
      }),
    );
    assert.equal(outcome.status, "transport_failure");
    assert.match(outcome.error, /^Telegram 投递失败：/);
  });

  it("库里路由被改坏（缺 chat_id）→ terminal_failure，不抛异常打断投递批次", async () => {
    const outcome = await telegramChannel.deliver(
      deliveryInput({ route: { name: "r", url: "https://api.telegram.org/bot1:x/sendMessage" } }),
    );
    assert.equal(outcome.status, "terminal_failure");
    assert.match(outcome.error, /chat_id/);
  });

  it("超过 4096 字符上限时截断并标注，而不是整条被 Telegram 拒收", async () => {
    const long = "长".repeat(5000);
    const { captured } = await deliverTo(telegramChannel, okResponse, { bodyMd: long });
    const payload = JSON.parse(captured[0]?.body ?? "{}") as { text: string };
    assert.ok(payload.text.length <= 4096, `实际 ${payload.text.length} 字符`);
    assert.ok(payload.text.endsWith("…（已截断）"), "截断必须有可见标记");
  });

  it("走 outbox 端到端：channel=telegram 无 secret 也能入队并投递", async () => {
    const env = makeTestEnv();
    try {
      await withServer(
        (_req, res) => okResponse(res),
        async (base, captured) => {
          const route = setPushRoute(env.db, "default", {
            channel: "telegram",
            url: `${base.url}/bot1:x/sendMessage?chat_id=7`,
          });
          assert.equal(route.channel, "telegram");
          const pub = publishProfile(env.db, env.config, "default", {
            kind: "test.kind",
            title: "端到端 Telegram",
            blocks: {},
          });
          await drainDue(env.db, env.config);
          const row = env.db
            .prepare("SELECT status, last_error FROM deliveries WHERE notification_id = ?")
            .get(pub.id) as { status: string; last_error: string | null } | undefined;
          assert.ok(row !== undefined);
          assert.equal(row.status, "sent", `投递失败: ${row.last_error ?? ""}`);
          assert.equal(captured.length, 1);
          assert.equal(captured[0]?.url, "/bot1:x/sendMessage?chat_id=7");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});
