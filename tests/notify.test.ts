import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { describe, it } from "node:test";
import {
  cancelPendingDeliveries,
  clearPushRoute,
  drainDue,
  EVENT_TYPE,
  publishGlobal,
  publishProfile,
  recoverStaleSending,
  setPushRoute,
} from "../src/core/notify.js";
import { setSetting } from "../src/core/settings.js";
import { cleanupTestEnv, makeTestEnv, SECRET, type TestEnv } from "./helpers.js";

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

function forceDue(db: TestEnv["db"]): void {
  db.exec("UPDATE deliveries SET next_attempt_at = '2000-01-01T00:00:00.000Z'");
}

function deliveryRows(db: TestEnv["db"]): Record<string, unknown>[] {
  return db.prepare("SELECT * FROM deliveries").all() as Record<string, unknown>[];
}

/** 构造一个确定不包含当前时刻的静默窗口 [当前+1h, 当前+3h)（Asia/Shanghai 小时粒度） */
function futureQuietWindow(): { start: string; end: string } {
  const hhmm = (offsetHours: number): string => {
    const cst = new Date(Date.now() + 8 * 3600_000);
    const h = (cst.getUTCHours() + offsetHours) % 24;
    return `${String(h).padStart(2, "0")}:00`;
  };
  return { start: hhmm(1), end: hhmm(3) };
}

describe("outbox 投递", () => {
  it("成功投递：HMAC V2 验签、payload 契约、状态落库", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        },
        async (url, captured) => {
          setPushRoute(env.db, "default", { url });
          const result = publishProfile(env.db, env.config, "default", {
            kind: "test.kind",
            title: "标题",
            blocks: { table: { columns: ["项目", "内容"], rows: [["天气", "晴"]] } },
          });
          assert.equal(result.deduped, false);
          await drainDue(env.db, env.config);

          assert.equal(captured.length, 1);
          const first = captured[0];
          assert.ok(first !== undefined);
          const { headers, body } = first;
          const timestamp = headers["x-webhook-timestamp"] as string;
          const signature = headers["x-webhook-signature-v2"] as string;
          assert.ok(/^\d+$/.test(timestamp));
          assert.equal(
            signature,
            createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex"),
            "HMAC-SHA256 V2 签名应为 hex(timestamp.body)",
          );
          assert.match(headers["x-request-id"] as string, /^life-assistant:default:.+:life-assistant-default:a0$/);

          const payload = JSON.parse(body) as {
            event_type: string;
            notification: { profileId: string; source: string; title: string; body: string };
          };
          assert.equal(payload.event_type, EVENT_TYPE);
          assert.equal(payload.notification.profileId, "default");
          assert.equal(payload.notification.source, "test.kind");
          assert.equal(payload.notification.title, "标题");
          assert.match(payload.notification.body, /\| 项目 \| 内容 \|/);

          const rows = deliveryRows(env.db);
          assert.equal(rows.length, 1);
          assert.equal(rows[0]?.status, "sent");
          const notifId = rows[0]?.notification_id as string;
          const notif = env.db.prepare("SELECT read FROM notifications WHERE id = ?").get(notifId) as {
            read: number;
          };
          assert.equal(notif.read, 1);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("body_md 不含标题：标题只走 title 字段，避免推送与拉取各重复一行", () => {
    const env = makeTestEnv();
    try {
      publishProfile(env.db, env.config, "default", {
        kind: "test.kind",
        title: "唯一标题标记ABC",
        blocks: { table: { columns: ["项目", "内容"], rows: [["天气", "晴"]] } },
      });
      const row = env.db
        .prepare("SELECT title, body_md FROM notifications WHERE profile_id = 'default'")
        .get() as { title: string; body_md: string };
      assert.equal(row.title, "唯一标题标记ABC");
      assert.doesNotMatch(row.body_md, /唯一标题标记ABC/);
      assert.match(row.body_md, /晴/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("Profile 内 dedupe_key 去重", () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      const input = { kind: "k", title: "t", blocks: {}, dedupeKey: "dup-1" };
      const first = publishProfile(env.db, env.config, "default", input);
      const second = publishProfile(env.db, env.config, "default", input);
      assert.equal(first.deduped, false);
      assert.equal(second.deduped, true);
      const n = env.db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number };
      assert.equal(n.n, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("publishGlobal 只物化配置了启用路由的 Profile", () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ p1: SECRET, p2: SECRET }) });
    try {
      ensureP(env.db, "p1");
      ensureP(env.db, "p2");
      setPushRoute(env.db, "p1", { url: "http://127.0.0.1:9/hook" });
      void publishGlobal(env.db, env.config, { kind: "k", title: "t", blocks: {} });
      const ids = (env.db.prepare("SELECT profile_id FROM notifications").all() as { profile_id: string }[]).map(
        (r) => r.profile_id,
      );
      assert.deepEqual(ids, ["p1"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("确认失败（非 2xx）：退避阶梯、换 Request-ID；5 次后 fallback", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(500);
          res.end("boom");
        },
        async (url) => {
          setPushRoute(env.db, "default", { url });
          publishProfile(env.db, env.config, "default", { kind: "k", title: "t", blocks: {} });
          for (let attempt = 1; attempt <= 5; attempt++) {
            forceDue(env.db);
            await drainDue(env.db, env.config);
            const row = deliveryRows(env.db)[0];
            assert.ok(row !== undefined);
            if (attempt < 5) {
              assert.equal(row.status, "failed");
              assert.equal(row.confirmed_failures, attempt);
              assert.equal(row.request_id, null);
              const deltaSec = (new Date(row.next_attempt_at as string).getTime() - Date.now()) / 1000;
              const expected = [60, 300, 900, 3600][attempt - 1] as number;
              assert.ok(
                Math.abs(deltaSec - expected) < 15,
                `第 ${attempt} 次失败后退避应约 ${expected}s，实际 ${deltaSec.toFixed(0)}s`,
              );
            } else {
              assert.equal(row.status, "fallback");
            }
          }
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("传输不确定失败：3 次后 fallback，Request-ID 保持不变", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.socket?.destroy();
        },
        async (url) => {
          setPushRoute(env.db, "default", { url });
          publishProfile(env.db, env.config, "default", { kind: "k", title: "t", blocks: {} });
          const ids: unknown[] = [];
          for (let attempt = 1; attempt <= 3; attempt++) {
            forceDue(env.db);
            await drainDue(env.db, env.config);
            const row = deliveryRows(env.db)[0];
            assert.ok(row !== undefined);
            ids.push(row.request_id);
            if (attempt < 3) assert.equal(row.status, "failed");
            else assert.equal(row.status, "fallback");
          }
          assert.equal(ids[0], ids[1], "传输失败重试应复用同一 X-Request-ID");
          assert.match(ids[2] as string, /^life-assistant:/);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("静默时段只跳过主动投递，窗口结束恢复", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(200);
          res.end("ok");
        },
        async (url) => {
          setPushRoute(env.db, "default", { url });
          publishProfile(env.db, env.config, "default", { kind: "k", title: "t", blocks: {} });
          setSetting(env.db, "default", "quiet_hours", { start: "00:00", end: "23:59" });
          await drainDue(env.db, env.config);
          assert.equal(deliveryRows(env.db)[0]?.status, "queued");

          setSetting(env.db, "default", "quiet_hours", futureQuietWindow());
          await drainDue(env.db, env.config);
          assert.equal(deliveryRows(env.db)[0]?.status, "sent");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("recoverStaleSending：超幂等窗口进 fallback，未超的复位 queued", () => {
    const env = makeTestEnv();
    try {
      const old = new Date(Date.now() - 56 * 60 * 1000).toISOString();
      const recent = new Date(Date.now() - 1000).toISOString();
      const insert = env.db.prepare(
        "INSERT INTO notifications (id, profile_id, kind, title, body_md, created_at) VALUES (?, 'default', 'k', 't', 'b', ?)",
      );
      insert.run("n1", old);
      insert.run("n2", recent);
      env.db
        .prepare(
          "INSERT INTO deliveries (id, notification_id, route_name, status, request_id, request_started_at, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'r', 'sending', ?, ?, ?, ?, ?)",
        )
        .run("d1", "n1", "req-1", old, old, old, old);
      env.db
        .prepare(
          "INSERT INTO deliveries (id, notification_id, route_name, status, request_id, request_started_at, next_attempt_at, created_at, updated_at) VALUES (?, ?, 'r', 'sending', ?, ?, ?, ?, ?)",
        )
        .run("d2", "n2", "req-2", recent, recent, recent, recent);

      recoverStaleSending(env.db);
      const rows = new Map(deliveryRows(env.db).map((r) => [r.id as string, r]));
      assert.equal(rows.get("d1")?.status, "fallback");
      assert.equal(rows.get("d2")?.status, "queued");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("pull 取消待处理投递；路由移除进 fallback，路由恢复重新入队", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook", name: "route-a" });
      const pub = publishProfile(env.db, env.config, "default", { kind: "k", title: "t", blocks: {} });
      cancelPendingDeliveries(env.db, "default", [pub.id]);
      assert.equal(deliveryRows(env.db)[0]?.status, "cancelled");

      const pub2 = publishProfile(env.db, env.config, "default", { kind: "k", title: "t2", blocks: {} });
      const row2 = (): Record<string, unknown> | undefined =>
        deliveryRows(env.db).find((r) => r.notification_id === pub2.id);
      assert.equal(row2()?.status, "queued");

      clearPushRoute(env.db, "default");
      await drainDue(env.db, env.config);
      assert.equal(row2()?.status, "fallback");
      assert.equal(row2()?.last_error, "route removed");

      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook", name: "route-a" });
      const recovered = row2();
      assert.equal(recovered?.status, "queued");
      assert.equal(recovered?.generation, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("setPushRoute 只接受回环 URL", () => {
    const env = makeTestEnv();
    try {
      assert.throws(() => setPushRoute(env.db, "default", { url: "http://example.com/hook" }), /主机名/);
      const route = setPushRoute(env.db, "default", { url: "http://localhost:12345/hook" });
      assert.equal(route.platform, null);
      assert.equal(route.enabled, true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("投递记录写入失败时通知一并回滚（通知与 outbox 同事务）", () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      env.db.exec("CREATE TRIGGER boom BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'boom'); END");
      assert.throws(
        () => publishProfile(env.db, env.config, "default", { kind: "k", title: "t", blocks: {} }),
        /boom/,
      );
      const notifications = env.db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as { n: number };
      const deliveries = env.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number };
      assert.equal(notifications.n, 0, "回滚后不应留下「有通知却没投递记录」的孤儿行");
      assert.equal(deliveries.n, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

function ensureP(db: TestEnv["db"], id: string): void {
  db.prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)").run(id, new Date().toISOString());
}
