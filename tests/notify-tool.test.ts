import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { supportedChannels } from "../src/core/channels.js";
import { publishProfile, setPushRoute } from "../src/core/notify.js";
import { allTools } from "../src/core/registry.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { cleanupTestEnv, makeTestEnv, SECRET, type TestEnv } from "./helpers.js";

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

describe("notify 工具", () => {
  it("pull：未读转已读并取消待投递", () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      publishProfile(env.db, env.config, "default", { kind: "k", title: "通知一", blocks: {} });
      publishProfile(env.db, env.config, "default", { kind: "k", title: "通知二", blocks: {} });
      assert.equal(
        (
          env.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'queued'").get() as {
            n: number;
          }
        ).n,
        2,
      );

      const first = tool(env, { action: "pull" });
      assert.match(text(first), /通知一/);
      assert.match(text(first), /通知二/);
      const pulled = JSON.parse(text(first)) as {
        未读通知: { id: string; 时间: string; "时间(本地)": string }[];
      };
      assert.ok(
        pulled.未读通知.every((n) => typeof n.id === "string" && n.id.length > 0),
        "pull 必须回传 id，否则 cancel 无法从工具输出取得通知 id",
      );
      assert.ok(
        pulled.未读通知.every((n) => /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(n["时间(本地)"])),
        "pull 必须补本地时间，避免 agent 把 UTC 直接报给用户",
      );
      assert.equal(
        (
          env.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read = 0").get() as {
            n: number;
          }
        ).n,
        0,
      );
      assert.equal(
        (
          env.db
            .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'cancelled'")
            .get() as { n: number }
        ).n,
        2,
      );

      const second = tool(env, { action: "pull" });
      assert.match(text(second), /没有未读/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("quiet_hours：设置/查看/清除与校验", () => {
    const env = makeTestEnv();
    try {
      const bad = tool(env, { action: "quiet_hours", start: "25:00", end: "07:00" });
      assert.equal(bad.isError, true);
      const same = tool(env, { action: "quiet_hours", start: "22:00", end: "22:00" });
      assert.equal(same.isError, true);

      const set = tool(env, { action: "quiet_hours", start: "22:00", end: "07:00" });
      assert.ok(!set.isError);
      const get = tool(env, { action: "quiet_hours" });
      assert.match(text(get), /22:00/);
      assert.match(text(get), /07:00/);

      tool(env, { action: "quiet_hours", clear: true });
      assert.match(text(tool(env, { action: "quiet_hours" })), /未设置/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("route：需要 env secret；配置后可查看", () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      const noSecret = tool(env, { action: "route", url: "http://127.0.0.1:12345/hook" }, "p2");
      assert.equal(noSecret.isError, true);

      const set = tool(env, {
        action: "route",
        url: "http://127.0.0.1:12345/hook",
        platform: "wechat",
      });
      assert.ok(!set.isError);
      const get = tool(env, { action: "route" });
      assert.match(text(get), /secretConfigured/);
      assert.match(text(get), /wechat/);

      const disable = tool(env, { action: "route", enabled: false });
      assert.match(text(disable), /"enabled": false/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("cancel：取消单条通知的待投递", () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      const pub = publishProfile(env.db, env.config, "default", {
        kind: "k",
        title: "要取消",
        blocks: {},
      });
      const result = tool(env, { action: "cancel", id: pub.id });
      assert.match(text(result), /要取消/);
      assert.equal(
        (
          env.db
            .prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'cancelled'")
            .get() as { n: number }
        ).n,
        1,
      );
      assert.equal(
        (
          env.db.prepare("SELECT read FROM notifications WHERE id = ?").get(pub.id) as {
            read: number;
          }
        ).read,
        1,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("cancel：回执按实际投递状态分档，不把「已发出/在途/无投递」说成已取消（P2-26）", () => {
    const env = makeTestEnv({ PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) });
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      /** 造一条通知，并把它的投递行改成指定状态（null = 删掉投递行，模拟无路由） */
      const seed = (title: string, status: string | null): string => {
        const pub = publishProfile(env.db, env.config, "default", {
          kind: "k",
          title,
          blocks: {},
        });
        if (status === null) {
          env.db.prepare("DELETE FROM deliveries WHERE notification_id = ?").run(pub.id);
        } else {
          env.db
            .prepare("UPDATE deliveries SET status = ? WHERE notification_id = ?")
            .run(status, pub.id);
        }
        return pub.id;
      };

      // ① 投递已发出：回执必须点明「没有待投递可取消」，绝不能再说「已取消…待投递」
      const sentReceipt = text(tool(env, { action: "cancel", id: seed("已发出", "sent") }));
      assert.match(sentReceipt, /没有待投递可取消/);
      assert.match(sentReceipt, /已发出 1 条/);
      assert.doesNotMatch(sentReceipt, /已取消投递/);

      // ② 投递处于 sending：拦不住，回执必须报条数并说明（与「pull 拦不住在途」同口径）
      const sendingId = seed("在途", "sending");
      const sendingReceipt = text(tool(env, { action: "cancel", id: sendingId }));
      assert.match(sendingReceipt, /仍有 1 条正在发送中/);
      assert.match(sendingReceipt, /撤回不了/);
      assert.equal(
        (
          env.db
            .prepare("SELECT status FROM deliveries WHERE notification_id = ?")
            .get(sendingId) as {
            status: string;
          }
        ).status,
        "sending",
        "sending 行不能被 cancel 改写",
      );

      // ③ 压根没有投递记录（未配置路由 / 该类型关闭推送）
      assert.match(text(tool(env, { action: "cancel", id: seed("无投递", null) })), /没有投递记录/);

      // ④ 真的取消了：回执报条数；重复 cancel 不得再回「已取消投递 1 条」
      const queuedId = seed("待投递", "queued");
      assert.match(text(tool(env, { action: "cancel", id: queuedId })), /已取消投递 1 条/);
      const again = text(tool(env, { action: "cancel", id: queuedId }));
      assert.match(again, /没有待投递可取消/);
      assert.doesNotMatch(again, /已取消投递/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("route 的 channel 描述由 supportedChannels() 生成，含全部通道（P2-22）", () => {
    const def = allTools().find((t) => t.def.name === "notify")?.def;
    assert.ok(def !== undefined, "notify 工具应已注册");
    const channels = supportedChannels();
    assert.ok(channels.length > 3, `通道数应多于 3，否则这条回归无意义: ${channels.join(",")}`);
    const shape = def.inputSchema as Record<string, { description?: string } | undefined>;
    const fieldDescription = shape.channel?.description ?? "";
    assert.notEqual(fieldDescription, "", "channel 字段必须有 describe（agent 只看得见 schema）");
    for (const name of channels) {
      assert.ok(
        fieldDescription.includes(name),
        `channel 字段描述缺少通道 ${name}：${fieldDescription}`,
      );
      assert.ok(def.description.includes(name), `工具总描述缺少通道 ${name}`);
    }
  });
});
