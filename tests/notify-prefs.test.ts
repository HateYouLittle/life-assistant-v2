import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { setLogLevel } from "../src/core/logger.js";
import {
  cancelPendingDrain,
  publishGlobal,
  publishProfile,
  setPushRoute,
} from "../src/core/notify.js";
import { setNotifyPrefs } from "../src/core/notify-prefs.js";
import { ensureProfile } from "../src/core/settings.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 按 kind 的通知偏好接入 publishProfile。
 *
 * 测试口径：一律用 `log` 通道配路由 —— 它不需要 URL/secret，于是「有没有建 delivery」
 * 只由通知偏好决定，不会被凭据缺失/网络投递干扰。
 */

function configureLogRoute(env: TestEnv, profileId = "default"): void {
  setPushRoute(env.db, profileId, { channel: "log" });
}

interface Counts {
  notifications: number;
  deliveries: number;
}

function counts(env: TestEnv, profileId = "default"): Counts {
  const notifications = (
    env.db
      .prepare("SELECT COUNT(*) AS n FROM notifications WHERE profile_id = ?")
      .get(profileId) as { n: number }
  ).n;
  const deliveries = (
    env.db
      .prepare(
        `SELECT COUNT(*) AS n FROM deliveries d
         JOIN notifications n ON n.id = d.notification_id
         WHERE n.profile_id = ?`,
      )
      .get(profileId) as { n: number }
  ).n;
  return { notifications, deliveries };
}

/**
 * 发布一条通知并立刻取消去抖 drain：publishProfile 在 queued 时会挂 100ms 定时器，
 * 若让它跑完，log 通道会把行改成 sent，断言就会随时序随机变红。这里只关心「建没建 delivery」。
 */
function publish(
  env: TestEnv,
  over: { kind: string; title?: string; dedupeKey?: string; expiresAt?: string },
  profileId = "default",
) {
  const result = publishProfile(env.db, env.config, profileId, {
    kind: over.kind,
    title: over.title ?? "标题",
    blocks: {},
    ...(over.dedupeKey === undefined ? {} : { dedupeKey: over.dedupeKey }),
    ...(over.expiresAt === undefined ? {} : { expiresAt: over.expiresAt }),
  });
  cancelPendingDrain();
  return result;
}

/** 真跑一次 notify.pull（而不是只查 read 列），确认「不推送」的通知确实还能被取到 */
function pull(env: TestEnv, profileId = "default"): string {
  const result = notifyTool(
    { action: "pull" },
    {
      profileId,
      db: env.db,
      config: env.config,
      services: {
        publishProfile: async () => ({ id: "x", deduped: false }),
        publishGlobal: async () => ({ materialized: 0 }),
      },
    },
  );
  return result.content[0]?.text ?? "";
}

describe("按 kind 的通知偏好", () => {
  it("bookkeeping.entry 默认不建 delivery，但通知仍入库、仍可 pull", () => {
    const env = makeTestEnv();
    try {
      configureLogRoute(env);
      const result = publish(env, { kind: "bookkeeping.entry", title: "记了一笔" });
      assert.equal(result.deduped, false);

      const after = counts(env);
      assert.equal(after.notifications, 1, "关闭推送不等于不记录：通知必须照常入库");
      assert.equal(after.deliveries, 0, "DEFAULT_KIND_PREFS 里 bookkeeping.entry 默认 push:false");

      const row = env.db
        .prepare("SELECT kind, read FROM notifications WHERE id = ?")
        .get(result.id) as { kind: string; read: number } | undefined;
      assert.equal(row?.kind, "bookkeeping.entry");
      assert.equal(row?.read, 0, "未读才可能被 pull 取到（不能被误标已读）");

      // 端到端：pull 走的是真实工具，能取到标题才算「记录还在」
      const pulled = pull(env);
      assert.match(pulled, /记了一笔/);
      assert.match(pulled, /bookkeeping\.entry/);
      assert.equal(counts(env).deliveries, 0, "pull 不该凭空造出投递行");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("显式 push:true 恢复建 delivery（默认值可被覆盖）", () => {
    const env = makeTestEnv();
    try {
      configureLogRoute(env);
      setNotifyPrefs(env.db, "default", { "bookkeeping.entry": { push: true } });
      const result = publish(env, { kind: "bookkeeping.entry" });
      const after = counts(env);
      assert.equal(after.notifications, 1);
      assert.equal(after.deliveries, 1, "显式开启后必须回到历史行为（建 delivery）");
      const delivery = env.db
        .prepare("SELECT status FROM deliveries WHERE notification_id = ?")
        .get(result.id) as { status: string } | undefined;
      assert.equal(delivery?.status, "queued", "drain 已取消，行应停在待投状态");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("channels 白名单不匹配当前路由通道时不发，匹配后恢复", () => {
    const env = makeTestEnv();
    try {
      configureLogRoute(env); // 当前路由通道 = log
      setNotifyPrefs(env.db, "default", { "weather.brief": { channels: ["bark"] } });
      publish(env, { kind: "weather.brief", title: "早报" });
      assert.equal(counts(env).deliveries, 0, "路由通道 log 不在白名单 [bark] 内");

      setNotifyPrefs(env.db, "default", { "weather.brief": { channels: ["log"] } });
      publish(env, { kind: "weather.brief", title: "早报2" });
      const after = counts(env);
      assert.equal(after.notifications, 2, "两次都入库（偏好只影响推送）");
      assert.equal(after.deliveries, 1, "白名单命中当前通道后恢复推送");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("settings 里的 notify_prefs 是坏 JSON 时按内置默认执行且不抛错", () => {
    const env = makeTestEnv();
    try {
      configureLogRoute(env);
      // 手工写坏 JSON（模拟降级回滚/手工改库）：getSetting 解析失败 → getNotifyPrefs 返回 {} → 叠加内置默认
      env.db
        .prepare(
          `INSERT INTO settings (profile_id, key, value_json, updated_at)
           VALUES ('default', 'notify_prefs', '{ not json', '2026-01-01T00:00:00.000Z')`,
        )
        .run();

      publish(env, { kind: "bookkeeping.entry" });
      assert.equal(counts(env).deliveries, 0, "坏配置不能让默认 push:false 变成推送");
      publish(env, { kind: "weather.brief" });
      const after = counts(env);
      assert.equal(after.notifications, 2);
      assert.equal(after.deliveries, 1, "未配置偏好的 kind 仍按默认推送");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("publishGlobal 逐 Profile 生效：A 关闭、B 保持推送", async () => {
    const env = makeTestEnv();
    try {
      for (const profileId of ["a", "b"]) {
        ensureProfile(env.db, profileId);
        configureLogRoute(env, profileId);
      }
      setNotifyPrefs(env.db, "a", { "weather.brief": { push: false } });

      const result = await publishGlobal(env.db, env.config, {
        kind: "weather.brief",
        title: "全局早报",
        blocks: {},
      });
      cancelPendingDrain();

      assert.equal(result.materialized, 2, "两个 Profile 都配置了启用路由，都应物化通知");
      const a = counts(env, "a");
      const b = counts(env, "b");
      assert.equal(a.notifications, 1, "A 的通知仍要入库（只是不推）");
      assert.equal(a.deliveries, 0, "A 的偏好必须生效");
      assert.equal(b.notifications, 1);
      assert.equal(b.deliveries, 1, "B 没配偏好，行为不变");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("回归：未配置偏好的 kind 行为与接入前一致（去重键/expiresAt 语义不变）", () => {
    const env = makeTestEnv();
    try {
      configureLogRoute(env);
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const first = publish(env, { kind: "weather.alert", dedupeKey: "alert-1", expiresAt });
      assert.equal(first.deduped, false);
      const second = publish(env, { kind: "weather.alert", dedupeKey: "alert-1", expiresAt });
      assert.equal(second.deduped, true, "去重键语义不变");
      const after = counts(env);
      assert.equal(after.notifications, 1);
      assert.equal(after.deliveries, 1);
      const delivery = env.db
        .prepare("SELECT expire_at FROM deliveries WHERE notification_id = ?")
        .get(first.id) as { expire_at: string | null } | undefined;
      assert.equal(delivery?.expire_at, expiresAt, "expiresAt 仍要落到 delivery 行上");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("关闭推送时去重与 expiresAt 语义不变：第二次同键仍判重、不建投递", () => {
    const env = makeTestEnv();
    try {
      configureLogRoute(env);
      const expiresAt = new Date(Date.now() + 3600_000).toISOString();
      const first = publish(env, { kind: "bookkeeping.entry", dedupeKey: "k1", expiresAt });
      const second = publish(env, { kind: "bookkeeping.entry", dedupeKey: "k1", expiresAt });
      assert.equal(first.deduped, false);
      assert.equal(second.deduped, true);
      assert.equal(second.id, first.id, "命中去重键时返回原通知 id");
      const after = counts(env);
      assert.equal(after.notifications, 1);
      assert.equal(after.deliveries, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("关闭推送时写 debug 日志（kind + 原因），便于回答「为什么没发」", (t: TestContext) => {
    const env = makeTestEnv();
    const spy = t.mock.method(console, "error", () => {});
    // logger.debug 默认被 info 阈值挡掉：显式开到 debug 才能断言这条线索真的写了
    setLogLevel("debug");
    try {
      configureLogRoute(env);
      publish(env, { kind: "bookkeeping.entry" });
      const lines = spy.mock.calls.map((call) => String(call.arguments[0]));
      assert.ok(
        lines.some((line) => line.includes("bookkeeping.entry") && line.includes("不主动推送")),
        `应有包含 kind 与原因的 debug 行，实际：\n${lines.join("\n")}`,
      );
    } finally {
      setLogLevel("info");
      cleanupTestEnv(env);
    }
  });

  it("路由需要 secret 而 secret 缺失时行为不变（仍不建 delivery，也不因偏好改动而崩溃）", () => {
    const env = makeTestEnv();
    try {
      // webhook 通道需要 secret，但环境里没有配 PROFILE_ROUTE_SECRETS_JSON
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      const result = publish(env, { kind: "weather.brief" });
      assert.equal(result.deduped, false);
      const after = counts(env);
      assert.equal(after.notifications, 1, "通知仍入库，可 pull 兜底");
      assert.equal(after.deliveries, 0, "缺 secret 不建投递（接入前既有行为）");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
