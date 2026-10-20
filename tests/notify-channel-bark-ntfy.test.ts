import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import {
  barkChannel,
  type ChannelDeliveryInput,
  type ChannelOutcome,
  DEFAULT_CHANNEL,
  getChannel,
  type NotificationChannel,
  ntfyChannel,
  supportedChannels,
} from "../src/core/channels.js";
import { drainDue, publishProfile, setPushRoute } from "../src/core/notify.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/**
 * Bark / ntfy 通道：本地假服务捕获真实请求，断言 method/path/headers/body、
 * URL 校验与归一化、四态映射（含超时与网络失败）、以及走 outbox 的端到端投递。
 */

interface Captured {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Base {
  url: string;
  port: number;
}

/** 起一个本地假服务：respond 决定怎么回；captured 记录每个请求 */
function withServer(
  respond: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  fn: (base: Base, captured: Captured[], server: Server) => Promise<void>,
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
      const base: Base = { url: `http://127.0.0.1:${addr.port}`, port: addr.port };
      fn(base, captured, server)
        .then(() => shutdown(server, resolve))
        .catch((e) => shutdown(server, () => reject(e)));
    });
  });
}

function shutdown(server: Server, done: () => void): void {
  // 超时用例会留下一条挂起的连接：不主动断开，close() 会一直等它
  server.closeAllConnections();
  server.close(() => done());
}

/** 拿到一个当前没人监听的端口（用于制造 ECONNREFUSED） */
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

function deliveryInput(over: Partial<ChannelDeliveryInput> = {}): ChannelDeliveryInput {
  return {
    profileId: "default",
    notificationId: "n1",
    kind: "test.kind",
    title: "标题",
    bodyMd: "**正文**\n第二行",
    createdAt: "2026-10-20T00:00:00.000Z",
    requestId: "life-assistant:default:n1:life-assistant-default:a0",
    generation: 0,
    route: { name: "life-assistant-default", url: "http://127.0.0.1:1/topic" },
    ...over,
  };
}

/** 投一次并回传捕获到的请求（respond 决定服务端行为） */
async function deliverTo(
  channel: NotificationChannel,
  respond: (res: ServerResponse) => void,
  over: Partial<ChannelDeliveryInput> = {},
  path = "",
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
  res.end('{"code":200,"message":"success"}');
}

describe("Bark / ntfy 通道注册", () => {
  it("通道清单包含 bark 与 ntfy，默认通道不变", () => {
    assert.equal(DEFAULT_CHANNEL, "webhook");
    assert.deepEqual(supportedChannels(), ["webhook", "log", "bark", "ntfy"]);
    assert.equal(getChannel("bark").name, "bark");
    assert.equal(getChannel("ntfy").name, "ntfy");
    assert.throws(() => getChannel("telegram"), /不支持的推送通道/);
  });

  it("两个通道都需要 URL、都不需要 secret", () => {
    for (const channel of [barkChannel, ntfyChannel]) {
      assert.equal(channel.requiresUrl, true, `${channel.name} 必须有 URL`);
      assert.equal(channel.requiresSecret, false, `${channel.name} 不应要求 secret`);
    }
  });
});

describe("Bark 通道", () => {
  it("validateRoute：允许公网 http(s)、去尾斜杠、拒绝空串与非 http(s)", () => {
    assert.equal(
      barkChannel.validateRoute({ url: "https://api.day.app/abc123" }),
      "https://api.day.app/abc123",
    );
    assert.equal(
      barkChannel.validateRoute({ url: "https://api.day.app/abc123/" }),
      "https://api.day.app/abc123",
      "尾斜杠必须剥掉，否则部分服务端会先回 301",
    );
    assert.equal(
      barkChannel.validateRoute({ url: "https://api.day.app/abc123///" }),
      "https://api.day.app/abc123",
    );
    assert.equal(
      barkChannel.validateRoute({ url: "http://192.168.1.5:8080/key" }),
      "http://192.168.1.5:8080/key",
      "自建 Bark 走局域网 http 也要允许（这是与 webhook 的关键差别）",
    );
    assert.throws(() => barkChannel.validateRoute({}), /需要 url/);
    assert.throws(() => barkChannel.validateRoute({ url: "" }), /需要 url/);
    assert.throws(
      () => barkChannel.validateRoute({ url: "ftp://api.day.app/key" }),
      /仅支持 http\/https/,
    );
    assert.throws(
      () => barkChannel.validateRoute({ url: "file:///etc/passwd" }),
      /仅支持 http\/https/,
    );
    assert.throws(() => barkChannel.validateRoute({ url: "api.day.app/key" }), /URL 不合法/);
  });

  it("deliver：POST JSON {title, body, group, level}，2xx → sent", async () => {
    const { outcome, captured } = await deliverTo(barkChannel, okResponse, {
      title: "交房租",
      bodyMd: "**今天**记得转账",
    });
    assert.equal(outcome.status, "sent");
    const req = captured[0];
    assert.ok(req !== undefined);
    assert.equal(req.method, "POST");
    assert.equal(req.url, "/");
    assert.equal(req.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(req.body), {
      title: "交房租",
      body: "**今天**记得转账",
      group: "life-assistant",
      level: "active",
    });
  });

  it("deliver：保留路由 URL 的路径（device_key 就在路径里）", async () => {
    const { captured } = await deliverTo(barkChannel, okResponse, {}, "/device/key");
    assert.equal(captured[0]?.url, "/device/key");
  });
});

describe("ntfy 通道", () => {
  it("validateRoute：允许公网 http(s)、去尾斜杠、拒绝空串与非 http(s)", () => {
    assert.equal(
      ntfyChannel.validateRoute({ url: "https://ntfy.sh/mytopic" }),
      "https://ntfy.sh/mytopic",
    );
    assert.equal(
      ntfyChannel.validateRoute({ url: "https://ntfy.sh/mytopic/" }),
      "https://ntfy.sh/mytopic",
    );
    assert.equal(
      ntfyChannel.validateRoute({ url: "http://ntfy.lan:8080/topic" }),
      "http://ntfy.lan:8080/topic",
    );
    // 带 query 时不能把结尾的斜杠当成路径尾斜杠误删
    assert.equal(
      ntfyChannel.validateRoute({ url: "https://ntfy.sh/topic?auth=abc/" }),
      "https://ntfy.sh/topic?auth=abc/",
    );
    assert.throws(() => ntfyChannel.validateRoute({}), /需要 url/);
    assert.throws(() => ntfyChannel.validateRoute({ url: " " }), /URL 不合法/);
    assert.throws(
      () => ntfyChannel.validateRoute({ url: "ws://ntfy.sh/topic" }),
      /仅支持 http\/https/,
    );
  });

  it("deliver：POST 纯文本 + Title/Priority/Tags 头，2xx → sent", async () => {
    const { outcome, captured } = await deliverTo(ntfyChannel, okResponse, {
      title: "Reminder",
      bodyMd: "line1\nline2",
    });
    assert.equal(outcome.status, "sent");
    const req = captured[0];
    assert.ok(req !== undefined);
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "text/plain; charset=utf-8");
    assert.equal(req.headers.title, "Reminder");
    assert.equal(req.headers.priority, "default");
    assert.equal(req.headers.tags, "life-assistant");
    assert.equal(req.body, "Reminder\n\nline1\nline2");
  });

  it("中文标题：Title 头走 RFC 2047（Node 的 fetch 不能直接发非 ASCII header）", async () => {
    const title = "交房租提醒 🏠";
    const { outcome, captured } = await deliverTo(ntfyChannel, okResponse, { title });
    assert.equal(outcome.status, "sent", "中文标题不得让投递抛错");
    const encoded = captured[0]?.headers.title as string;
    assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
    const base64 = /^=\?UTF-8\?B\?(.+)\?=$/.exec(encoded)?.[1] ?? "";
    assert.equal(Buffer.from(base64, "base64").toString("utf8"), title, "解码后必须还是原文");
    // 正文里也带着原文标题：不认 Title 头的客户端也不会丢标题
    assert.equal(captured[0]?.body, `${title}\n\n**正文**\n第二行`);
  });

  it("含换行的标题不会造成 header 注入", async () => {
    const { captured } = await deliverTo(ntfyChannel, okResponse, { title: "第一行\nX-Evil: 1" });
    const encoded = captured[0]?.headers.title as string;
    assert.match(encoded, /^=\?UTF-8\?B\?.+\?=$/);
    assert.equal(captured[0]?.headers["x-evil"], undefined, "标题里的换行不得变成新 header");
  });
});

describe("状态码与失败映射（两个通道同一口径）", () => {
  const cases: [number, ChannelOutcome["status"]][] = [
    [200, "sent"],
    [204, "sent"],
    [301, "terminal_failure"],
    [400, "terminal_failure"],
    [403, "terminal_failure"],
    [404, "terminal_failure"],
    [408, "confirmed_failure"],
    [429, "confirmed_failure"],
    [500, "confirmed_failure"],
    [503, "confirmed_failure"],
  ];

  for (const channel of [barkChannel, ntfyChannel]) {
    it(`${channel.name}：2xx→sent / 429·5xx·408→confirmed / 其它 3xx·4xx→terminal`, async () => {
      for (const [status, expected] of cases) {
        const { outcome } = await deliverTo(channel, (res) => {
          res.writeHead(status);
          res.end("boom");
        });
        assert.equal(
          outcome.status,
          expected,
          `${channel.name} HTTP ${status} 应映射为 ${expected}`,
        );
        if (outcome.status === "sent") continue;
        assert.match(outcome.error, /返回 HTTP \d+/, "错误文案应说明上游状态码");
        assert.ok(outcome.error.includes("boom"), "错误文案应带一小段上游正文便于排障");
      }
    });
  }

  it("超长错误正文被截断到 500 字符以内", async () => {
    const { outcome } = await deliverTo(barkChannel, (res) => {
      res.writeHead(500);
      res.end("x".repeat(3000));
    });
    assert.equal(outcome.status, "confirmed_failure");
    assert.ok(
      outcome.error.length <= 500,
      `last_error 不能超过 500 字符，实际 ${outcome.error.length}`,
    );
    assert.ok(outcome.error.endsWith("…"), "截断后应有省略号");
  });

  it("错误正文里的换行被折叠成单行（last_error 是单行展示）", async () => {
    const { outcome } = await deliverTo(ntfyChannel, (res) => {
      res.writeHead(400);
      res.end("bad\nrequest\n");
    });
    assert.ok(outcome.status !== "sent");
    assert.ok(
      !outcome.error.includes("\n"),
      `错误文案不得含换行: ${JSON.stringify(outcome.error)}`,
    );
  });
});

describe("传输失败", () => {
  it("连接被拒 → transport_failure（中文说明）", async () => {
    const port = await unusedPort();
    const outcome = await barkChannel.deliver(
      deliveryInput({ route: { name: "life-assistant-default", url: `http://127.0.0.1:${port}` } }),
    );
    assert.equal(outcome.status, "transport_failure");
    assert.match(outcome.error, /^Bark 投递失败：/);
  });

  it("服务端挂起不响应 → 10s 超时后 transport_failure", { timeout: 30_000 }, async () => {
    const started = Date.now();
    let captured: Captured[] = [];
    await withServer(
      () => {
        // 故意不响应：必须由 AbortSignal.timeout 兜住，否则投递行会永远卡在 sending
      },
      async (base, seen) => {
        captured = seen;
        const outcome = await ntfyChannel.deliver(
          deliveryInput({ route: { name: "life-assistant-default", url: base.url } }),
        );
        assert.equal(outcome.status, "transport_failure");
        assert.match(outcome.error, /超时/);
      },
    );
    assert.equal(captured.length, 1, "超时前请求已经发出");
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 9_000, `应等满超时窗口（约 10s），实际 ${elapsed}ms`);
  });
});

describe("走 outbox 的端到端投递", () => {
  it("channel=bark 无 secret 也能入队并投递，URL 归一化后落库", async () => {
    // 刻意不配 PROFILE_ROUTE_SECRETS_JSON：bark 不应要求 secret
    const env = makeTestEnv();
    try {
      await withServer(
        (_req, res) => okResponse(res),
        async (base, captured) => {
          const route = setPushRoute(env.db, "default", {
            channel: "bark",
            url: `${base.url}/key/`,
          });
          assert.equal(route.channel, "bark");
          assert.equal(route.url, `${base.url}/key`, "落库的 URL 必须是归一化后的");
          assert.equal(route.enabled, true);

          const pub = publishProfile(env.db, env.config, "default", {
            kind: "test.kind",
            title: "端到端 Bark",
            blocks: {},
          });
          await drainDue(env.db, env.config);

          const row = env.db
            .prepare("SELECT status, last_error FROM deliveries WHERE notification_id = ?")
            .get(pub.id) as { status: string; last_error: string | null } | undefined;
          assert.ok(row !== undefined);
          assert.equal(row.status, "sent");
          assert.equal(row.last_error, null);
          assert.equal(captured.length, 1);
          assert.equal(captured[0]?.url, "/key");
          const payload = JSON.parse(captured[0]?.body ?? "{}") as Record<string, unknown>;
          assert.equal(payload.title, "端到端 Bark");
          assert.equal(payload.group, "life-assistant");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("channel=ntfy 中文标题端到端投递成功（不再被 ByteString 卡住）", async () => {
    const env = makeTestEnv();
    try {
      await withServer(
        (_req, res) => okResponse(res),
        async (base, captured) => {
          setPushRoute(env.db, "default", { channel: "ntfy", url: `${base.url}/mytopic` });
          const title = "日程提醒：交房租";
          const pub = publishProfile(env.db, env.config, "default", {
            kind: "test.kind",
            title,
            blocks: {},
          });
          await drainDue(env.db, env.config);

          const row = env.db
            .prepare("SELECT status, last_error FROM deliveries WHERE notification_id = ?")
            .get(pub.id) as { status: string; last_error: string | null } | undefined;
          assert.ok(row !== undefined);
          assert.equal(row.status, "sent", `中文标题不该让投递失败: ${row.last_error ?? ""}`);
          const req = captured[0];
          assert.ok(req !== undefined);
          assert.equal(req.url, "/mytopic");
          assert.equal(req.headers.priority, "default");
          const base64 = /^=\?UTF-8\?B\?(.+)\?=$/.exec(String(req.headers.title))?.[1] ?? "";
          assert.equal(Buffer.from(base64, "base64").toString("utf8"), title);
          assert.ok(req.body.startsWith(`${title}\n\n`), "正文第一行仍是标题");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});
