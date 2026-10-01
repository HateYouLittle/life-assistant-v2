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
  routeSecret,
  setPushRoute,
  setPushRouteEnabled,
  waitForDrain,
} from "../src/core/notify.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { setSetting } from "../src/core/settings.js";
import { nowIso } from "../src/time.js";
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

/**
 * 构造一个**必然覆盖当前时刻**的静默窗口 [当前-2h, 当前+4h)（Asia/Shanghai 小时粒度）。
 *
 * 不用 `{start:"00:00", end:"23:59"}`：它恰好在 23:59 那一分钟不成立，用例会随机变红。
 * 前后各留 2h/4h 余量，用例执行期间跨过窗口边界也不影响结论。
 * 静默时段本身是「相对当前时刻」的语义（inQuietWindow 无注入点），所以这里按本地小时
 * 构造夹具值，而不是把时刻做成参数 —— 日期相关的断言仍一律用固定夹具。
 */
function coveringQuietWindow(): { start: string; end: string } {
  const hhmm = (offsetHours: number): string => {
    const cst = new Date(Date.now() + 8 * 3600_000);
    const h = (cst.getUTCHours() + offsetHours + 24) % 24;
    return `${String(h).padStart(2, "0")}:00`;
  };
  return { start: hhmm(-2), end: hhmm(4) };
}

/** 直接造一条到期投递行（绕开 publishProfile：批量造 100+ 行时它太慢且会顺带触发 drain） */
function seedDueDelivery(
  db: TestEnv["db"],
  profileId: string,
  routeName: string,
  nextAttemptAt: string,
): string {
  const n = `n-${profileId}-${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    "INSERT INTO notifications (id, profile_id, kind, title, body_md, created_at) VALUES (?, ?, 'k', 't', 'b', '2026-01-01T00:00:00.000Z')",
  ).run(n, profileId);
  db.prepare(
    "INSERT INTO deliveries (id, notification_id, route_name, status, next_attempt_at, created_at, updated_at) VALUES (?, ?, ?, 'queued', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
  ).run(`d-${n}`, n, routeName, nextAttemptAt);
  return `d-${n}`;
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
          assert.match(
            headers["x-request-id"] as string,
            /^life-assistant:default:.+:life-assistant-default:a0$/,
          );

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
          const notif = env.db
            .prepare("SELECT read FROM notifications WHERE id = ?")
            .get(notifId) as {
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
    const env = makeTestEnv({
      PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ p1: SECRET, p2: SECRET }),
    });
    try {
      ensureP(env.db, "p1");
      ensureP(env.db, "p2");
      setPushRoute(env.db, "p1", { url: "http://127.0.0.1:9/hook" });
      void publishGlobal(env.db, env.config, { kind: "k", title: "t", blocks: {} });
      const ids = (
        env.db.prepare("SELECT profile_id FROM notifications").all() as { profile_id: string }[]
      ).map((r) => r.profile_id);
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
              const deltaSec =
                (new Date(row.next_attempt_at as string).getTime() - Date.now()) / 1000;
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

  it("跨 Profile 投递饥饿：某 Profile 的静默行占满批次窗口时，别的 Profile 仍能投出", async () => {
    // 回归（N8）：drainDue 每轮取 `ORDER BY next_attempt_at LIMIT 100`，随后逐行判 skip。
    // quiet-hours 是**唯一**不落库终态的 skip（既不改 status 也不推进 next_attempt_at），
    // 而它又是 per-Profile 的设置。于是 A 用户一条 00:00-23:59 的静默时段就能让
    // 它的 101 条到期行永久占满 LIMIT 窗口：旧判据 `deliverable.length === 0 → break`
    // 让这一轮直接收工，B 用户的到期行（排在第 101 名之后）整轮一次都没被尝试 ——
    // attempts 都没涨、last_error 是 null。B 用户的推送被 A 用户的设置静默压掉。
    const env = makeTestEnv({
      PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET, p2: SECRET }),
    });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(200);
          res.end("ok");
        },
        async (url, captured) => {
          setPushRoute(env.db, "default", { url });
          ensureP(env.db, "p2");
          setPushRoute(env.db, "p2", { url });
          // default 静默中；p2 正常
          setSetting(env.db, "default", "quiet_hours", coveringQuietWindow());

          // default 造 101 条到期行，并把它们排到全库最前（占满 LIMIT 100）
          for (let i = 0; i < 101; i++) {
            seedDueDelivery(
              env.db,
              "default",
              "life-assistant-default",
              "2000-01-01T00:00:00.000Z",
            );
          }
          // p2 的到期行排在窗口之外（next_attempt_at 更晚）
          const p2Row = seedDueDelivery(
            env.db,
            "p2",
            "life-assistant-p2",
            "2000-01-01T00:00:01.000Z",
          );

          await drainDue(env.db, env.config);

          const p2 = deliveryRows(env.db).find((r) => r.id === p2Row);
          assert.ok(p2 !== undefined, "p2 的投递行应在库里");
          assert.equal(
            (p2.attempts as number) >= 1 || p2.status !== "queued",
            true,
            `p2 的到期推送整轮一次都没被尝试（被 default 的静默时段饿死）：${JSON.stringify(p2)}`,
          );
          assert.equal(captured.length, 1, "p2 的推送必须真的发出去一次");
          assert.equal(p2.status, "sent");
          // default 的行仍停在 queued（静默时段内不投递，这是期望行为）
          const stillQueued = deliveryRows(env.db).filter(
            (r) => r.id !== p2Row && r.status === "queued",
          );
          assert.equal(stillQueued.length, 101, "静默时段内 default 的行必须原样留在 queued");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("全部行都因静默时段被跳过时 drainDue 必须收工（零推进不得自旋空转）", async () => {
    // N8 的判据改成「本轮零状态推进才 break」后，必须钉住它不会退化成无限循环：
    // 静默时段是唯一不落库终态的 skip，若 break 判据写成「永远不 break」，
    // 下一轮又会取回同一批 101 行 → 死循环（且 drain 是 async，自旋会挂住进程）。
    // 这里用「整库只有静默行」钉住：drainDue 必须返回（不是超时），且不推进任何行。
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      setSetting(env.db, "default", "quiet_hours", coveringQuietWindow());
      const rows: string[] = [];
      for (let i = 0; i < 5; i++) {
        rows.push(seedDueDelivery(env.db, "default", "life-assistant-default", nowIso()));
      }
      // node:test 默认无超时；显式给 10s race 断言「drainDue 返回了」
      const processed = await Promise.race([
        drainDue(env.db, env.config),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error("drainDue 未收工：静默行导致自旋空转")), 10_000),
        ),
      ]);
      assert.equal(processed, 0, "全是静默行时不应有任何行被投递");
      for (const id of rows) {
        const row = deliveryRows(env.db).find((r) => r.id === id);
        assert.equal(row?.status, "queued", "静默行必须留在 queued");
        assert.equal(row?.attempts, 0, "静默行不得被 claim");
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("过期内容不再补投：静默时段拦下的预警在窗口结束后作废", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(200);
          res.end("ok");
        },
        async (url, captured) => {
          setPushRoute(env.db, "default", { url });
          publishProfile(env.db, env.config, "default", {
            kind: "weather.alert",
            title: "仍有效的预警",
            blocks: { notes: ["a"] },
            expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          });
          publishProfile(env.db, env.config, "default", {
            kind: "weather.alert",
            title: "已失效的预警",
            blocks: { notes: ["b"] },
            expiresAt: new Date(Date.now() - 60_000).toISOString(),
          });

          await drainDue(env.db, env.config);

          assert.equal(captured.length, 1, "只有未过期的那条能上网");
          const rows = deliveryRows(env.db);
          assert.equal(rows.filter((r) => r.status === "sent").length, 1);
          const expired = rows.find((r) => r.status === "cancelled");
          assert.ok(expired !== undefined, "过期投递应落 cancelled，而不是无限排队");
          assert.match(String(expired?.last_error), /expired/);
          const unread = env.db
            .prepare("SELECT COUNT(*) AS n FROM notifications WHERE read = 0")
            .get() as { n: number };
          assert.equal(unread.n, 1, "通知本身要留下，notify.pull 仍可作为兜底");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("截止时间带 +08:00 偏移（历史行）也按时间值判过期，不靠字符串比较", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    // 构造「真实时刻已过期、但 +08:00 字符串排位在 now 之后」的边界：
    // 旧的字符串比较会把它当成未过期而补投，正是本用例要防的回归。
    const offsetIso = (msFromNow: number): string =>
      new Date(Date.now() + msFromNow + 8 * 3600_000).toISOString().replace("Z", "+08:00");
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(200);
          res.end("ok");
        },
        async (url, captured) => {
          setPushRoute(env.db, "default", { url });
          publishProfile(env.db, env.config, "default", {
            kind: "weather.alert",
            title: "仍有效的预警",
            blocks: { notes: ["a"] },
            expiresAt: offsetIso(2 * 3600_000),
          });
          publishProfile(env.db, env.config, "default", {
            kind: "weather.alert",
            title: "已失效的预警",
            blocks: { notes: ["b"] },
            expiresAt: offsetIso(-2 * 3600_000),
          });

          await drainDue(env.db, env.config);

          assert.equal(captured.length, 1, "偏移格式不能让「已过期」的行蒙混过关");
          const expired = deliveryRows(env.db).find((r) => r.status === "cancelled");
          assert.ok(expired !== undefined, "带 +08:00 的已过期投递应落 cancelled");
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
      const pub = publishProfile(env.db, env.config, "default", {
        kind: "k",
        title: "t",
        blocks: {},
      });
      cancelPendingDeliveries(env.db, "default", [pub.id]);
      assert.equal(deliveryRows(env.db)[0]?.status, "cancelled");

      const pub2 = publishProfile(env.db, env.config, "default", {
        kind: "k",
        title: "t2",
        blocks: {},
      });
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

  it("route enabled 切换必须重新入队，不再用裸 setSetting 绕过 requeue", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook", name: "route-a" });
      const pub = publishProfile(env.db, env.config, "default", {
        kind: "k",
        title: "t",
        blocks: {},
      });
      const row = (): Record<string, unknown> | undefined =>
        deliveryRows(env.db).find((r) => r.notification_id === pub.id);
      assert.equal(row()?.status, "queued");

      // 用工具路径停用 → drain 把待投递行打成 fallback
      const ctx = {
        profileId: "default",
        db: env.db,
        config: env.config,
        services: {
          publishProfile: async () => ({ id: "x", deduped: false }),
          publishGlobal: async () => ({ materialized: 0 }),
        },
      };
      notifyTool({ action: "route", enabled: false }, ctx);
      forceDue(env.db);
      await drainDue(env.db, env.config);
      assert.equal(row()?.status, "fallback");

      // 再用工具路径启用：必须重新入队（曾经这里直接 setSetting，行永远停在 fallback）
      notifyTool({ action: "route", enabled: true }, ctx);
      assert.equal(row()?.status, "queued", "重新启用路由后，停用期间未投出的通知必须重新入队");
      assert.equal(row()?.generation, 1, "重新入队应递增 generation（用于区分新的投递尝试）");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("推送路由改名后：旧名的待投递行必须照常投出，不卡死在 route drift", async () => {
    // 回归：route.name 与行的 route_name 不一致时被判 "route drift" 并置 fallback，
    // 而 requeueRoute 只按「新名」找回 fallback 行 → 改个名就永久丢掉待投通知，
    // 且 setPushRouteEnabled / clearPushRoute+同名重建都救不回来。
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
        },
        async (url, captured) => {
          setPushRoute(env.db, "default", { url, name: "route-a" });
          const a = publishProfile(env.db, env.config, "default", {
            kind: "k",
            title: "a",
            blocks: {},
          });
          const b = publishProfile(env.db, env.config, "default", {
            kind: "k",
            title: "b",
            blocks: {},
          });
          const rowOf = (id: string): Record<string, unknown> | undefined =>
            deliveryRows(env.db).find((r) => r.notification_id === id);

          setPushRoute(env.db, "default", { url, name: "route-b" });
          assert.equal(rowOf(a.id)?.route_name, "route-a", "改名不追溯改写历史投递行");

          await drainDue(env.db, env.config);
          assert.equal(captured.length, 2, "改名不该让已排队的通知投不出去");
          for (const id of [a.id, b.id]) {
            assert.equal(rowOf(id)?.status, "sent", "改名后仍应送达");
            assert.equal(rowOf(id)?.route_name, "route-b", "行的路由名应改写为当前名");
          }
          const stuck = deliveryRows(env.db).filter((r) => r.last_error === "route drift");
          assert.deepEqual(stuck, [], "不该留下 route drift 的终结行");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("改名后用 enabled 开关恢复：旧名的 fallback 行也要重新入队", async () => {
    // requeueRoute 曾按 route_name 精确匹配，改过名之后就再也匹配不到那些行。
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook", name: "route-a" });
      const a = publishProfile(env.db, env.config, "default", {
        kind: "k",
        title: "a",
        blocks: {},
      });
      const b = publishProfile(env.db, env.config, "default", {
        kind: "k",
        title: "b",
        blocks: {},
      });
      const rowOf = (id: string): Record<string, unknown> | undefined =>
        deliveryRows(env.db).find((r) => r.notification_id === id);

      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook", name: "route-b" });
      setPushRouteEnabled(env.db, "default", false);
      await drainDue(env.db, env.config);
      assert.equal(rowOf(a.id)?.status, "fallback");
      assert.equal(rowOf(a.id)?.route_name, "route-a", "行上仍是旧名");

      setPushRouteEnabled(env.db, "default", true);
      for (const id of [a.id, b.id]) {
        assert.equal(rowOf(id)?.status, "queued", "重新启用后 route_name 为旧名的行也必须重新入队");
        assert.equal(rowOf(id)?.generation, 1);
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("clearPushRoute 后用新名重建：旧名的 fallback 行重新入队", () => {
    // 与上一条同源：行上的 route_name 是「路由移除」那一刻的名字，
    // 用户重建时换了名，按名匹配就永远漏掉这些行。
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook", name: "route-a" });
      const pub = publishProfile(env.db, env.config, "default", {
        kind: "k",
        title: "a",
        blocks: {},
      });
      const row = (): Record<string, unknown> | undefined =>
        deliveryRows(env.db).find((r) => r.notification_id === pub.id);
      clearPushRoute(env.db, "default");
      env.db
        .prepare("UPDATE deliveries SET status = 'fallback', last_error = 'route removed'")
        .run();

      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook", name: "route-c" });
      assert.equal(row()?.status, "queued", "换名重建后旧名的 fallback 行必须能恢复投递");
      assert.equal(row()?.generation, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("不确定投递（已发出请求）即便改名也不重新入队", () => {
    // requeueRoute 只重新入队「从未发出不确定请求」的行，这是刻意的不盲重发取舍，
    // 路由改名不得破坏它。
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      const insert = env.db.prepare(
        "INSERT INTO notifications (id, profile_id, kind, title, body_md, created_at) VALUES (?, 'default', 'k', 't', 'b', '2026-01-01T00:00:00.000Z')",
      );
      insert.run("n1");
      insert.run("n2");
      const addDelivery = env.db.prepare(
        "INSERT INTO deliveries (id, notification_id, route_name, status, request_started_at, next_attempt_at, last_error, created_at, updated_at) VALUES (?, ?, 'route-a', 'fallback', ?, '2026-01-01T00:00:00.000Z', 'uncertain', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
      );
      addDelivery.run("d1", "n1", null);
      addDelivery.run("d2", "n2", "2026-01-01T00:00:00.000Z");
      const rowOf = (id: string): Record<string, unknown> | undefined =>
        deliveryRows(env.db).find((r) => r.id === id);

      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook", name: "route-b" });
      assert.equal(rowOf("d2")?.status, "fallback", "已发出不确定请求的行不得被重排队");
      assert.equal(rowOf("d2")?.generation, 0, "generation 不变 = 没有重新入队");
      assert.equal(rowOf("d1")?.status, "queued", "从未发出的行仍应重新入队");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("被 4xx 确定性拒绝的终态行不重新入队，从未发出的行仍恢复投递", () => {
    // 回归：markTerminalFallback 用「清空 request_started_at」表达「可以安全重投」，
    // 但那把「被 4xx 确定性拒绝」和「从未发出过」混成同一类 —— 而 requeueRoute 改按 profile
    // 无条件捞 fallback 行，于是改个路由名/重新启用就会把早已被拒绝的 403 行真实再发一次。
    // 用真实 4xx 响应造出那类行（而不是手搓 last_error），确保断言钉的是实现路径。
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      const insert = env.db.prepare(
        "INSERT INTO notifications (id, profile_id, kind, title, body_md, created_at) VALUES (?, 'default', 'k', 't', 'b', '2026-01-01T00:00:00.000Z')",
      );
      insert.run("n1");
      insert.run("n2");
      const stamp = "2026-01-01T00:00:00.000Z";
      const addDelivery = env.db.prepare(
        "INSERT INTO deliveries (id, notification_id, route_name, status, request_started_at, next_attempt_at, last_error, created_at, updated_at, deterministic_reject) VALUES (?, ?, 'route-a', 'fallback', ?, ?, ?, ?, ?, ?)",
      );
      // 与 markTerminalFallback 的终态形状一致：request_started_at 已被清空 + 确定性拒绝标记
      addDelivery.run("d-rejected", "n1", null, stamp, "HTTP 403", stamp, stamp, 1);
      // 从未发出的行（路由停用期间积压）：同样落在 fallback，必须仍能恢复
      addDelivery.run("d-never-sent", "n2", null, stamp, "route removed", stamp, stamp, 0);
      const rowOf = (id: string): Record<string, unknown> | undefined =>
        deliveryRows(env.db).find((r) => r.id === id);

      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook", name: "route-b" });
      assert.equal(
        rowOf("d-rejected")?.status,
        "fallback",
        "被 4xx 确定性拒绝的行不得被重新入队（重发只会再被拒一次）",
      );
      assert.equal(rowOf("d-rejected")?.generation, 0, "generation 不变 = 没有重新入队");
      assert.equal(
        rowOf("d-never-sent")?.status,
        "queued",
        "从未发出的 fallback 行改路由后仍必须恢复投递",
      );
      assert.equal(rowOf("d-never-sent")?.generation, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("真实 4xx 响应造出的终态行：改路由后不会被再发一次", async () => {
    // 上一条是手搓行；这条走完整投递路径（真 403 响应 → markTerminalFallback），
    // 钉住「实现真的写出了不可重投的标记」，而不只是 requeueRoute 的 WHERE 条件变了。
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(403);
          res.end("forbidden");
        },
        async (url, captured) => {
          setPushRoute(env.db, "default", { url, name: "route-a" });
          const pub = publishProfile(env.db, env.config, "default", {
            kind: "k",
            title: "t",
            blocks: {},
          });
          forceDue(env.db);
          await drainDue(env.db, env.config);
          const row = (): Record<string, unknown> | undefined =>
            deliveryRows(env.db).find((r) => r.notification_id === pub.id);
          assert.equal(row()?.status, "fallback");
          assert.equal(row()?.last_error, "HTTP 403");

          // 换名重建路由：这类行不得被真实再发一次
          setPushRoute(env.db, "default", { url, name: "route-b" });
          assert.equal(row()?.status, "fallback", "4xx 终态行不该被改路由重新入队");
          forceDue(env.db);
          await drainDue(env.db, env.config);
          assert.equal(captured.length, 1, "被拒的投递不得被真实再发一次");
          assert.equal(row()?.status, "fallback");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("profile 名为 constructor 时不得命中 Object.prototype（routeSecret 回归）", () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      assert.equal(
        routeSecret(env.config, "constructor"),
        undefined,
        "未配置的 profile 必须是 undefined",
      );
      const pub = publishProfile(env.db, env.config, "constructor", {
        kind: "k",
        title: "t",
        blocks: {},
      });
      // 误判"有 secret"会落一条投递行，随后 createHmac 抛错并让每轮 drain 中断
      const rows = deliveryRows(env.db).filter((r) => r.notification_id === pub.id);
      assert.equal(rows.length, 0, "没有 secret 就不该落投递行（否则 drain 每轮都会抛错）");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("投递遇 4xx：直接终结为 fallback，不做 5 次退避重试", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(404);
          res.end("not found");
        },
        async (url) => {
          setPushRoute(env.db, "default", { url });
          const pub = publishProfile(env.db, env.config, "default", {
            kind: "k",
            title: "t",
            blocks: {},
          });
          forceDue(env.db);
          await drainDue(env.db, env.config);
          const row = deliveryRows(env.db).find((r) => r.notification_id === pub.id);
          assert.equal(row?.status, "fallback", "4xx 是确定性拒绝，必须直接终结");
          assert.equal(row?.attempts, 1, "不该重试");
          assert.equal(row?.confirmed_failures, 0, "4xx 不该计入退避阶梯");
          assert.equal(row?.last_error, "HTTP 404");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("投递遇 429：仍按可重试处理（限流是暂时性的）", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(429);
          res.end("slow down");
        },
        async (url) => {
          setPushRoute(env.db, "default", { url });
          const pub = publishProfile(env.db, env.config, "default", {
            kind: "k",
            title: "t",
            blocks: {},
          });
          forceDue(env.db);
          await drainDue(env.db, env.config);
          const row = deliveryRows(env.db).find((r) => r.notification_id === pub.id);
          assert.equal(row?.status, "failed", "429 应进入退避重试而不是终结");
          assert.equal(row?.confirmed_failures, 1);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("投递遇 3xx：重定向是确定性失败，直接终结为 fallback", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          res.writeHead(302, { Location: "/elsewhere" });
          res.end();
        },
        async (url) => {
          setPushRoute(env.db, "default", { url });
          const pub = publishProfile(env.db, env.config, "default", {
            kind: "k",
            title: "t",
            blocks: {},
          });
          forceDue(env.db);
          await drainDue(env.db, env.config);
          const row = deliveryRows(env.db).find((r) => r.notification_id === pub.id);
          assert.equal(row?.status, "fallback", "3xx 未被处理，重试只会在阶梯上白耗一小时");
          assert.equal(row?.attempts, 1, "不该重试");
          assert.equal(row?.last_error, "HTTP 302");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("setPushRoute 只接受回环 URL", () => {
    const env = makeTestEnv();
    try {
      assert.throws(
        () => setPushRoute(env.db, "default", { url: "http://example.com/hook" }),
        /主机名/,
      );
      // 非 http(s) 协议主机名也能过回环检查，但 fetch 必然失败：必须在入口拒绝
      assert.throws(
        () => setPushRoute(env.db, "default", { url: "ftp://127.0.0.1/hook" }),
        /http\/https/,
      );
      const route = setPushRoute(env.db, "default", { url: "http://localhost:12345/hook" });
      assert.equal(route.platform, null);
      assert.equal(route.enabled, true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("drainDue 在途时重入返回 0，waitForDrain 等到本轮结束（停机依赖此语义）", async () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          setTimeout(() => {
            res.writeHead(200);
            res.end("ok");
          }, 50);
        },
        async (url) => {
          setPushRoute(env.db, "default", { url });
          publishProfile(env.db, env.config, "default", { kind: "k", title: "t", blocks: {} });
          const first = drainDue(env.db, env.config);
          assert.equal(await drainDue(env.db, env.config), 0, "在途时重入不应并发投递");
          await waitForDrain();
          assert.equal(await first, 1, "waitForDrain 之后本轮必须已结算");
          assert.equal(deliveryRows(env.db)[0]?.status, "sent");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("投递段也受 DRAIN_BUDGET_MS 约束：超预算即返回，剩余行留待下一轮", async () => {
    // 回归（N13）：deadline 检查曾**只在行扫描循环**里（逐行判 skip/过期），
    // 而真正花钱的投递批次循环没有检查。行扫描在 DB 上跑完只要几毫秒，
    // 于是 45s 预算对投递段完全失效：BATCH_LIMIT=100 / CONCURRENCY=5 = 20 批，
    // 单请求最长 10s（deliverOne 的 AbortSignal.timeout）→ 最坏 200s = 预算的 4.44×。
    // 后果不是「慢一点」而是投递被单轮卡住：draining 一直 true，调度器每 20s 的
    // drainDue 全部重入返回 0，新通知只能等这一轮结束。
    //
    // 用例不构造 10s 的黑洞（等不起 45s），而是把预算与端点延迟一起缩放：
    // 预算 300ms、端点每请求 120ms → 满窗 20 批 × 120ms = 2.4s，远超预算。
    // 端点是**固定夹具延迟**（每次都 120ms），不依赖当前时刻，故用例可重复。
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      await withHookServer(
        (_req, res) => {
          setTimeout(() => {
            res.writeHead(200);
            res.end("ok");
          }, 120);
        },
        async (url) => {
          setPushRoute(env.db, "default", { url });
          for (let i = 0; i < 100; i++) {
            seedDueDelivery(
              env.db,
              "default",
              "life-assistant-default",
              "2000-01-01T00:00:00.000Z",
            );
          }
          const processed = await drainDue(env.db, env.config, 300);
          // 未 claim 的行状态仍是 queued，下一轮重新取回 —— 不丢也不重
          assert.ok(processed < 100, `超预算必须提前返回，实际投出了 ${processed} 行`);
          const rows = deliveryRows(env.db);
          assert.equal(rows.length, 100, "100 行都必须还在库里");
          assert.equal(
            rows.filter((r) => r.status === "sent").length,
            processed,
            "已投出的行必须是 sent",
          );
          assert.equal(
            rows.filter((r) => r.status === "queued").length,
            100 - processed,
            "未投出的行必须原样留在 queued（不能被标成 sending/fallback 之类）",
          );

          // 剩余行下一轮能继续投出（提前返回不是丢行）
          const second = await drainDue(env.db, env.config, 300);
          assert.ok(second > 0, "提前返回后下一轮必须接着投剩余的行");
          assert.ok(
            second + processed > 0 && second + processed <= 100,
            `两轮累计投出行数应落在 (0,100]，实际 ${processed}+${second}`,
          );
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("投递记录写入失败时通知一并回滚（通知与 outbox 同事务）", () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      env.db.exec(
        "CREATE TRIGGER boom BEFORE INSERT ON deliveries BEGIN SELECT RAISE(ABORT, 'boom'); END",
      );
      assert.throws(
        () => publishProfile(env.db, env.config, "default", { kind: "k", title: "t", blocks: {} }),
        /boom/,
      );
      const notifications = env.db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as {
        n: number;
      };
      const deliveries = env.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as {
        n: number;
      };
      assert.equal(notifications.n, 0, "回滚后不应留下「有通知却没投递记录」的孤儿行");
      assert.equal(deliveries.n, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

function ensureP(db: TestEnv["db"], id: string): void {
  db.prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)").run(
    id,
    new Date().toISOString(),
  );
}
