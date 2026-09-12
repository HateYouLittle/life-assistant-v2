import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishProfile, setPushRoute } from "../src/core/notify.js";
import { notifyTool } from "../src/modules/notify/index.js";
import { cleanupTestEnv, makeTestEnv, SECRET, type TestEnv } from "./helpers.js";

function tool(env: TestEnv, args: Record<string, unknown>, profileId = "default") {
  return notifyTool(args, {
    profileId,
    db: env.db,
    config: env.config,
    services: { publishProfile: async () => ({ id: "x", deduped: false }), publishGlobal: async () => ({ materialized: 0 }) },
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
      assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'queued'").get() as { n: number }).n, 2);

      const first = tool(env, { action: "pull" });
      assert.match(text(first), /通知一/);
      assert.match(text(first), /通知二/);
      assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM notifications WHERE read = 0").get() as { n: number }).n, 0);
      assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'cancelled'").get() as { n: number }).n, 2);

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

      const set = tool(env, { action: "route", url: "http://127.0.0.1:12345/hook", platform: "wechat" });
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
      const pub = publishProfile(env.db, env.config, "default", { kind: "k", title: "要取消", blocks: {} });
      const result = tool(env, { action: "cancel", id: pub.id });
      assert.match(text(result), /要取消/);
      assert.equal((env.db.prepare("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'cancelled'").get() as { n: number }).n, 1);
      assert.equal((env.db.prepare("SELECT read FROM notifications WHERE id = ?").get(pub.id) as { read: number }).read, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
