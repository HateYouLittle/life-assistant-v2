import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setPushRoute } from "../src/core/notify.js";
import { getNotifyPrefs } from "../src/core/notify-prefs.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * notify 工具新增的 action=prefs / action=test。
 *
 * 与 tests/notify-prefs.test.ts 的分工：那里测 core 的 publishProfile 是否真的按偏好
 * 不建 delivery；这里测**工具层**的读写语义（默认值、回显生效值、通道校验、坏 JSON 兜底）
 * 与 test 动作（入库 / 是否建投递 / 通道）。
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

/** prefs/test 两个 action 的 JSON 回显形状（只声明断言用得到的键） */
interface NotifyPayload {
  已保存?: Record<string, unknown>;
  内置默认?: Record<string, unknown>;
  生效?: Record<string, { push: boolean; channels: string[] | null }>;
  说明?: string;
  已发送测试通知?: Record<string, unknown>;
}

function json(result: { content: { text: string }[] }): NotifyPayload {
  return JSON.parse(result.content[0]?.text ?? "{}") as NotifyPayload;
}

function errorText(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function notifications(env: TestEnv, kind: string): { id: string; dedupe_key: string | null }[] {
  return env.db
    .prepare("SELECT id, dedupe_key FROM notifications WHERE kind = ? ORDER BY created_at")
    .all(kind) as { id: string; dedupe_key: string | null }[];
}

describe("notify prefs：读", () => {
  it("不带 kind：返回已保存 / 内置默认 / 最终生效三份", () => {
    const env = makeTestEnv();
    try {
      const data = json(tool(env, { action: "prefs" }));
      assert.deepEqual(data.已保存, {}, "还没配置过");
      assert.deepEqual(data.内置默认, { "bookkeeping.entry": { push: false } });
      assert.deepEqual(data.生效?.["bookkeeping.entry"], { push: false, channels: null });
      assert.match(String(data.说明), /不主动推送/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("坏 JSON 的偏好按「没配置」处理，不抛错", () => {
    const env = makeTestEnv();
    try {
      // 手工改库（模拟旧版本/误编辑）：getSetting 的坏 JSON 防御必须兜住
      env.db
        .prepare(
          "INSERT INTO settings (profile_id, key, value_json, updated_at) VALUES ('default', 'notify_prefs', '{{{', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      const result = tool(env, { action: "prefs" });
      assert.equal(result.isError, undefined);
      const data = json(result);
      assert.deepEqual(data.已保存, {});
      assert.deepEqual(data.生效?.["bookkeeping.entry"], { push: false, channels: null });
      assert.deepEqual(getNotifyPrefs(env.db, "default"), {});
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("notify prefs：写", () => {
  it("kind + push：写入后回显最终生效值，并能在下一次读里看到", () => {
    const env = makeTestEnv();
    try {
      const written = json(tool(env, { action: "prefs", kind: "bookkeeping.entry", push: true }));
      assert.deepEqual(written.已保存, { "bookkeeping.entry": { push: true } });
      assert.deepEqual(written.生效, { push: true, channels: null }, "覆盖默认的 push=false");
      assert.deepEqual(written.内置默认, { push: false });

      const reread = json(tool(env, { action: "prefs" }));
      assert.deepEqual(reread.已保存, { "bookkeeping.entry": { push: true } });
      assert.deepEqual(reread.生效?.["bookkeeping.entry"], { push: true, channels: null });

      // 关掉推送（默认已关，显式写 false 也应落库）
      const off = json(tool(env, { action: "prefs", kind: "schedule.reminder", push: false }));
      assert.deepEqual(off.生效, { push: false, channels: null });
      assert.deepEqual(getNotifyPrefs(env.db, "default")["schedule.reminder"], { push: false });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("kind + channels：限定通道、未知通道报错、空数组清除限制", () => {
    const env = makeTestEnv();
    try {
      const limited = json(
        tool(env, { action: "prefs", kind: "schedule.reminder", channels: ["log"] }),
      );
      assert.deepEqual(limited.生效, { push: true, channels: ["log"] });

      const unknown = tool(env, {
        action: "prefs",
        kind: "schedule.reminder",
        channels: ["pager"],
      });
      assert.equal(unknown.isError, true);
      assert.match(errorText(unknown), /不支持的通道/);
      assert.deepEqual(
        getNotifyPrefs(env.db, "default")["schedule.reminder"],
        { channels: ["log"] },
        "失败的写入不得改动已有偏好",
      );

      const cleared = json(tool(env, { action: "prefs", kind: "schedule.reminder", channels: [] }));
      assert.deepEqual(cleared.生效, { push: true, channels: null }, "空数组 = 清除通道限制");
      assert.deepEqual(getNotifyPrefs(env.db, "default")["schedule.reminder"], {});
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("参数校验：kind 不带 push/channels、非法 kind、非布尔 push 都拒绝", () => {
    const env = makeTestEnv();
    try {
      const noTarget = tool(env, { action: "prefs", kind: "bookkeeping.entry" });
      assert.equal(noTarget.isError, true);
      assert.match(errorText(noTarget), /push/);

      const badKind = tool(env, { action: "prefs", kind: "Not A Kind", push: true });
      assert.equal(badKind.isError, true);
      assert.match(errorText(badKind), /kind 不合法/);

      const badPush = tool(env, { action: "prefs", kind: "bookkeeping.entry", push: "yes" });
      assert.equal(badPush.isError, true);
      assert.match(errorText(badPush), /push 需要布尔值/);

      const badChannels = tool(env, {
        action: "prefs",
        kind: "bookkeeping.entry",
        channels: "log",
      });
      assert.equal(badChannels.isError, true);
      assert.match(errorText(badChannels), /channels 需要通道名数组/);
      assert.deepEqual(getNotifyPrefs(env.db, "default"), {}, "被拒的请求不得留下任何设置");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("notify test：通道自检", () => {
  it("没有路由：通知仍入库，如实说「仅入库，可 pull」", () => {
    const env = makeTestEnv();
    try {
      const result = tool(env, { action: "test" });
      assert.equal(result.isError, undefined);
      const data = json(result);
      const sent = data.已发送测试通知 ?? {};
      assert.equal(sent.标题, "🔔 通知通道测试");
      assert.equal(sent.种类, "notify.test");
      assert.equal(sent.已建投递, false, "没有路由时不得谎报已投递");
      assert.equal(sent.通道, undefined);
      assert.match(String(data.说明), /仅入库/);
      assert.match(String(data.说明), /notify\.pull/);

      const rows = notifications(env, "notify.test");
      assert.equal(rows.length, 1, "测试通知必须真的入库（可 pull）");
      assert.match(String(rows[0]?.dedupe_key), /^test:\d+-/);
      assert.equal(
        (env.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as { n: number }).n,
        0,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("有 log 路由：建立投递并回显通道", () => {
    const env = makeTestEnv();
    try {
      setPushRoute(env.db, "default", { channel: "log" });
      const data = json(tool(env, { action: "test" }));
      const sent = data.已发送测试通知 ?? {};
      assert.equal(sent.已建投递, true);
      assert.equal(sent.通道, "log");
      assert.equal(sent.路由, "life-assistant-default");
      assert.match(String(data.说明), /已建立投递/);

      const delivery = env.db.prepare("SELECT route_name, status FROM deliveries").get() as {
        route_name: string;
        status: string;
      };
      assert.equal(delivery.route_name, "life-assistant-default");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("连点两次：dedupeKey 带时间戳+随机后缀，两条都真的发出", () => {
    const env = makeTestEnv();
    try {
      tool(env, { action: "test" });
      tool(env, { action: "test" });
      const rows = notifications(env, "notify.test");
      assert.equal(rows.length, 2, "测试通知不能被去重吞掉");
      assert.notEqual(rows[0]?.dedupe_key, rows[1]?.dedupe_key);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
