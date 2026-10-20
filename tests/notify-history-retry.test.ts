import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cancelPendingDrain, drainDue, setPushRoute } from "../src/core/notify.js";
import { ensureProfile } from "../src/core/settings.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * notify history / retry。
 *
 * history 是「看」：必须完全不改 read/status（与 pull 相反）；
 * retry 是「修」：只叫醒 failed/fallback，字段重置口径与 core 的自动重试保持可区分。
 * 两个动作都必须按 Profile 分范围 —— 否则 A 用户能看到/重投 B 用户的通知。
 */

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

interface HistoryRecord {
  id: string;
  种类: string;
  标题: string;
  "时间(本地)": string;
  已读: boolean;
  投递: {
    状态: string;
    尝试次数: number;
    最后错误: string | null;
    多路由?: boolean;
  } | null;
}

interface HistoryPayload {
  总数: number;
  偏移: number;
  还有更多: boolean;
  记录: HistoryRecord[];
}

interface JsonPayload {
  重试数?: number;
  跳过数?: number;
  说明?: string;
}

function payload<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0]?.text ?? "{}") as T;
}

function errorText(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

let seq = 0;
/** 相对时间戳：保证 created_at 严格递增，分页/排序断言才稳定 */
function at(offsetSeconds: number): string {
  return new Date(Date.now() - 1_000_000 + offsetSeconds * 1000).toISOString();
}

function seedNotification(
  env: TestEnv,
  over: {
    id?: string;
    profile?: string;
    kind?: string;
    title?: string;
    read?: number;
    createdAt?: string;
  } = {},
): string {
  const id = over.id ?? `n${++seq}`;
  env.db
    .prepare(
      `INSERT INTO notifications (id, profile_id, kind, title, body_md, read, created_at)
       VALUES (?, ?, ?, ?, '', ?, ?)`,
    )
    .run(
      id,
      over.profile ?? "default",
      over.kind ?? "test.kind",
      over.title ?? `通知 ${id}`,
      over.read ?? 0,
      over.createdAt ?? at(++seq),
    );
  return id;
}

function seedDelivery(
  env: TestEnv,
  over: {
    notificationId: string;
    id?: string;
    status: string;
    routeName?: string;
    attempts?: number;
    confirmed?: number;
    transport?: number;
    generation?: number;
    requestStartedAt?: string | null;
    nextAt?: string;
    lastError?: string | null;
    expireAt?: string | null;
    deterministicReject?: number;
    createdAt?: string;
  },
): string {
  const id = over.id ?? `d${++seq}`;
  const now = new Date().toISOString();
  env.db
    .prepare(
      `INSERT INTO deliveries (id, notification_id, route_name, status, attempts, confirmed_failures,
         transport_failures, generation, request_started_at, next_attempt_at, last_error,
         deterministic_reject, expire_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      over.notificationId,
      over.routeName ?? "life-assistant-default",
      over.status,
      over.attempts ?? 2,
      over.confirmed ?? 1,
      over.transport ?? 1,
      over.generation ?? 3,
      over.requestStartedAt ?? now,
      over.nextAt ?? now,
      over.lastError ?? "boom",
      over.deterministicReject ?? 0,
      over.expireAt ?? null,
      over.createdAt ?? at(++seq),
      now,
    );
  return id;
}

interface DeliveryRow {
  id: string;
  status: string;
  attempts: number;
  confirmed_failures: number;
  transport_failures: number;
  generation: number;
  request_started_at: string | null;
  next_attempt_at: string;
  expire_at: string | null;
  last_error: string | null;
  deterministic_reject: number;
}

function deliveryRow(env: TestEnv, id: string): DeliveryRow {
  return env.db.prepare("SELECT * FROM deliveries WHERE id = ?").get(id) as unknown as DeliveryRow;
}

function readFlags(env: TestEnv): number[] {
  return (
    env.db.prepare("SELECT read FROM notifications ORDER BY id").all() as { read: number }[]
  ).map((r) => r.read);
}

describe("notify history", () => {
  it("降序分页：总数 / 偏移 / 还有更多都按真实总数算", () => {
    const env = makeTestEnv();
    try {
      for (let i = 0; i < 5; i++) seedNotification(env, { id: `n${i}`, createdAt: at(i) });
      const first = payload<HistoryPayload>(tool(env, { action: "history", limit: 2 }));
      assert.equal(first.总数, 5);
      assert.equal(first.偏移, 0);
      assert.equal(first.还有更多, true);
      assert.deepEqual(
        first.记录.map((r) => r.id),
        ["n4", "n3"],
        "按 created_at 降序（最新在前）",
      );

      const last = payload<HistoryPayload>(tool(env, { action: "history", limit: 2, offset: 4 }));
      assert.equal(last.总数, 5);
      assert.equal(last.偏移, 4);
      assert.equal(last.还有更多, false);
      assert.deepEqual(
        last.记录.map((r) => r.id),
        ["n0"],
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("kind 精确过滤与 unread 过滤", () => {
    const env = makeTestEnv();
    try {
      seedNotification(env, { id: "a1", kind: "bookkeeping.entry", createdAt: at(1) });
      seedNotification(env, { id: "a2", kind: "bookkeeping.entry", read: 1, createdAt: at(2) });
      seedNotification(env, { id: "b1", kind: "weather.daily_brief", createdAt: at(3) });

      const byKind = payload<HistoryPayload>(
        tool(env, { action: "history", kind: "bookkeeping.entry" }),
      );
      assert.equal(byKind.总数, 2);
      assert.deepEqual(
        byKind.记录.map((r) => r.id),
        ["a2", "a1"],
      );

      const unread = payload<HistoryPayload>(tool(env, { action: "history", unread: true }));
      assert.deepEqual(
        unread.记录.map((r) => r.id),
        ["b1", "a1"],
        "已读的 a2 不在未读结果里",
      );

      const both = payload<HistoryPayload>(
        tool(env, { action: "history", kind: "bookkeeping.entry", unread: true }),
      );
      assert.deepEqual(
        both.记录.map((r) => r.id),
        ["a1"],
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("不改变已读状态（与 pull 的差别）", () => {
    const env = makeTestEnv();
    try {
      seedNotification(env, { id: "n1" });
      seedNotification(env, { id: "n2", read: 1 });
      const before = readFlags(env);
      const data = payload<HistoryPayload>(tool(env, { action: "history" }));
      assert.deepEqual(readFlags(env), before, "history 只能看，不能把未读翻成已读");
      assert.deepEqual(data.记录.map((r) => r.已读).sort(), [false, true]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("Profile 隔离：只看得到自己的通知", () => {
    const env = makeTestEnv();
    try {
      ensureProfile(env.db, "partner");
      seedNotification(env, { id: "mine", createdAt: at(1) });
      seedNotification(env, { id: "theirs", profile: "partner", createdAt: at(2) });
      const mine = payload<HistoryPayload>(tool(env, { action: "history" }));
      assert.equal(mine.总数, 1);
      assert.deepEqual(
        mine.记录.map((r) => r.id),
        ["mine"],
      );

      const theirs = payload<HistoryPayload>(tool(env, { action: "history" }, "partner"));
      assert.deepEqual(
        theirs.记录.map((r) => r.id),
        ["theirs"],
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("带最近一条投递的状态/尝试次数/最后错误；多路由标注", () => {
    const env = makeTestEnv();
    try {
      const withDelivery = seedNotification(env, { id: "n1", createdAt: at(1) });
      const multi = seedNotification(env, { id: "n2", createdAt: at(2) });
      seedNotification(env, { id: "n3", createdAt: at(3) });
      seedDelivery(env, {
        notificationId: withDelivery,
        status: "fallback",
        attempts: 4,
        lastError: "HTTP 404",
        createdAt: at(10),
      });
      // 同一通知两条投递：取最新那条，并标「多路由」
      seedDelivery(env, {
        notificationId: multi,
        status: "sent",
        attempts: 1,
        lastError: null,
        createdAt: at(11),
      });
      seedDelivery(env, {
        notificationId: multi,
        status: "failed",
        attempts: 3,
        lastError: "旧路由失败",
        createdAt: at(12),
      });

      const data = payload<HistoryPayload>(tool(env, { action: "history" }));
      const byId = new Map(data.记录.map((r) => [r.id, r]));
      assert.deepEqual(byId.get("n1")?.投递, {
        状态: "fallback",
        尝试次数: 4,
        最后错误: "HTTP 404",
      });
      assert.equal(byId.get("n3")?.投递, null, "没有投递记录的通知投递为 null");
      const multiDelivery = byId.get("n2")?.投递;
      assert.equal(multiDelivery?.状态, "failed", "多路由时取最近创建的那条");
      assert.equal(multiDelivery?.多路由, true);
      // 时间(本地) 是 Asia/Shanghai 的 YYYY-MM-DD HH:mm
      assert.match(byId.get("n1")?.["时间(本地)"] ?? "", /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("limit/offset 非法值回退到合法区间，不报错", () => {
    const env = makeTestEnv();
    try {
      for (let i = 0; i < 3; i++) seedNotification(env, { id: `n${i}`, createdAt: at(i) });

      const weirdLimit = payload<HistoryPayload>(
        tool(env, { action: "history", limit: "abc", offset: -5 }),
      );
      assert.equal(weirdLimit.偏移, 0, "负数 offset 夹到 0");
      assert.equal(weirdLimit.记录.length, 3, "limit 非数字时回退默认 20");

      const zero = payload<HistoryPayload>(tool(env, { action: "history", limit: 0 }));
      assert.equal(zero.记录.length, 1, "limit 越界夹到下限 1");

      const huge = payload<HistoryPayload>(tool(env, { action: "history", limit: 9999 }));
      assert.equal(huge.记录.length, 3, "limit 越界夹到上限 100（这里只有 3 条）");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("坏参数：kind / unread 类型不对直接 fail", () => {
    const env = makeTestEnv();
    try {
      const badKind = tool(env, { action: "history", kind: 123 });
      assert.equal(badKind.isError, true);
      assert.match(errorText(badKind), /kind 需要非空字符串/);

      const badUnread = tool(env, { action: "history", unread: "yes" });
      assert.equal(badUnread.isError, true);
      assert.match(errorText(badUnread), /unread 需要布尔值/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("notify retry", () => {
  it("只重试 failed/fallback，其它状态计入跳过，字段逐一重置", () => {
    const env = makeTestEnv();
    try {
      const notification = seedNotification(env, { id: "n1" });
      const failed = seedDelivery(env, {
        notificationId: notification,
        id: "d-failed",
        status: "failed",
        attempts: 3,
        confirmed: 2,
        transport: 1,
        generation: 5,
        lastError: "HTTP 500",
        expireAt: at(9_000),
      });
      const fallback = seedDelivery(env, {
        notificationId: notification,
        id: "d-fallback",
        status: "fallback",
        generation: 2,
        deterministicReject: 1,
      });
      const sent = seedDelivery(env, {
        notificationId: notification,
        id: "d-sent",
        status: "sent",
      });
      const queued = seedDelivery(env, {
        notificationId: notification,
        id: "d-queued",
        status: "queued",
      });
      const cancelled = seedDelivery(env, {
        notificationId: notification,
        id: "d-cancelled",
        status: "cancelled",
      });

      const result = tool(env, { action: "retry", notification_id: notification });
      cancelPendingDrain(); // 冻结 drain 计时器，后面的字段断言不受投递影响
      assert.equal(result.isError, undefined, errorText(result));
      const data = payload<JsonPayload>(result);
      assert.equal(data.重试数, 2);
      assert.equal(data.跳过数, 3, "sent/queued/cancelled 都不能重复入队");
      assert.match(String(data.说明), /已重新入队 2 条/);
      assert.match(String(data.说明), /修好路由/);

      for (const id of [failed, fallback]) {
        const row = deliveryRow(env, id);
        assert.equal(row.status, "queued");
        assert.equal(row.attempts, 0);
        assert.equal(row.confirmed_failures, 0);
        assert.equal(row.transport_failures, 0);
        assert.equal(row.request_started_at, null);
        assert.equal(row.expire_at, null);
        assert.equal(row.last_error, null);
        assert.equal(row.deterministic_reject, 0, "手动重试后不再是终态，旧标记必须清掉");
        assert.ok(
          Math.abs(Date.parse(row.next_attempt_at) - Date.now()) < 5_000,
          `next_attempt_at 应约等于现在: ${row.next_attempt_at}`,
        );
      }
      assert.equal(deliveryRow(env, failed).generation, 6);
      assert.equal(deliveryRow(env, fallback).generation, 3);
      // 其它状态原样不动
      assert.equal(deliveryRow(env, sent).status, "sent");
      assert.equal(deliveryRow(env, queued).status, "queued");
      assert.equal(deliveryRow(env, cancelled).status, "cancelled");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("delivery_id 指定单条：只动那一条", () => {
    const env = makeTestEnv();
    try {
      const notification = seedNotification(env, { id: "n1" });
      const one = seedDelivery(env, {
        notificationId: notification,
        id: "d1",
        status: "failed",
        attempts: 4,
      });
      const two = seedDelivery(env, {
        notificationId: notification,
        id: "d2",
        status: "failed",
        attempts: 4,
      });
      const data = payload<JsonPayload>(tool(env, { action: "retry", delivery_id: one }));
      cancelPendingDrain();
      assert.equal(data.重试数, 1);
      assert.equal(data.跳过数, 0);
      assert.equal(deliveryRow(env, one).status, "queued");
      assert.equal(deliveryRow(env, two).status, "failed");
      assert.equal(deliveryRow(env, two).attempts, 4, "未指定的行一个字段都不该变");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("all=true 批量重试，上限 200 条，其余计入跳过", () => {
    const env = makeTestEnv();
    try {
      const notification = seedNotification(env, { id: "n1" });
      for (let i = 0; i < 205; i++) {
        seedDelivery(env, { notificationId: notification, id: `d${i}`, status: "failed" });
      }
      // 非失败态即使 all=true 也不该被叫醒
      seedDelivery(env, { notificationId: notification, id: "sent-1", status: "sent" });

      const data = payload<JsonPayload>(tool(env, { action: "retry", all: true }));
      cancelPendingDrain();
      assert.equal(data.重试数, 200);
      assert.equal(data.跳过数, 5);
      const queuedCount = (
        env.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'queued'").get() as {
          n: number;
        }
      ).n;
      assert.equal(queuedCount, 200);
      assert.equal(deliveryRow(env, "sent-1").status, "sent");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("别人的通知 / 不存在的 id / 缺参数都 fail", () => {
    const env = makeTestEnv();
    try {
      ensureProfile(env.db, "partner");
      const theirs = seedNotification(env, { id: "theirs", profile: "partner" });
      seedDelivery(env, { notificationId: theirs, id: "d-theirs", status: "failed" });

      const foreign = tool(env, { action: "retry", notification_id: theirs });
      assert.equal(foreign.isError, true);
      assert.match(errorText(foreign), /不属于当前 Profile/);
      const foreignDelivery = tool(env, { action: "retry", delivery_id: "d-theirs" });
      assert.equal(foreignDelivery.isError, true);
      assert.match(errorText(foreignDelivery), /不属于当前 Profile/);
      // 归属校验失败时那条行必须原样留在 failed
      assert.equal(deliveryRow(env, "d-theirs").status, "failed");

      const missingNotification = tool(env, { action: "retry", notification_id: "nope" });
      assert.equal(missingNotification.isError, true);
      assert.match(errorText(missingNotification), /通知不存在/);
      const missingDelivery = tool(env, { action: "retry", delivery_id: "nope" });
      assert.equal(missingDelivery.isError, true);
      assert.match(errorText(missingDelivery), /投递不存在/);

      const noArgs = tool(env, { action: "retry" });
      assert.equal(noArgs.isError, true);
      assert.match(errorText(noArgs), /notification_id/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("没有投递记录的通知：不报错，说明「没有命中」", () => {
    const env = makeTestEnv();
    try {
      const notification = seedNotification(env, { id: "n1" });
      const result = tool(env, { action: "retry", notification_id: notification });
      assert.equal(result.isError, undefined);
      const data = payload<JsonPayload>(result);
      assert.equal(data.重试数, 0);
      assert.equal(data.跳过数, 0);
      assert.match(String(data.说明), /history/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("重试后真的能投出去（log 通道：queued → sent）", async () => {
    const env = makeTestEnv();
    try {
      setPushRoute(env.db, "default", { channel: "log" });
      const notification = seedNotification(env, { id: "n1" });
      const delivery = seedDelivery(env, {
        notificationId: notification,
        id: "d1",
        status: "fallback",
        lastError: "HTTP 404",
      });
      const data = payload<JsonPayload>(tool(env, { action: "retry", delivery_id: delivery }));
      assert.equal(data.重试数, 1);
      cancelPendingDrain(); // 用显式 drain 取代 100ms 去抖，测试才确定
      await drainDue(env.db, env.config);
      assert.equal(deliveryRow(env, delivery).status, "sent");
      // 投出去后通知标已读（与 markSent 的既有语义一致）
      const read = env.db
        .prepare("SELECT read FROM notifications WHERE id = ?")
        .get(notification) as {
        read: number;
      };
      assert.equal(read.read, 1);
      // history 立刻能看到最终状态
      const history = payload<HistoryPayload>(tool(env, { action: "history" }));
      assert.equal(history.记录[0]?.投递?.状态, "sent");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
