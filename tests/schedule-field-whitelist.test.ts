import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { now } from "../src/time.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

const day = (offset: number): string => now().plus({ days: offset }).toISODate() as string;

function tool(env: TestEnv, args: Record<string, unknown>) {
  return scheduleTool(args, {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async (profileId, input) => {
        env.published.push({ profileId, input });
        return { id: `n-${env.published.length}`, deduped: false };
      },
      publishGlobal: async () => ({ materialized: 0 }),
    },
  });
}

function text(result: { content: { text: string }[] }): string {
  return result.content.map((c) => c.text).join("");
}

async function withEnv(fn: (env: TestEnv) => void | Promise<void>): Promise<void> {
  const env = await makeTestEnv();
  try {
    await fn(env);
  } finally {
    await cleanupTestEnv(env);
  }
}

describe("schedule 字段白名单", () => {
  it("每个 action 拒绝表外字段，文案逐字一致", async () => {
    await withEnv((env) => {
      const cases: [string, Record<string, unknown>, string][] = [
        ["add", { title: "x", id: "s1" }, "id"],
        ["list", { id: "s1" }, "id"],
        ["update", { id: "s1", title: "y", all: true }, "all"],
        ["complete", { id: "s1", title: "y" }, "title"],
        ["snooze", { id: "s1", all: true }, "all"],
        ["skip", { id: "s1", minutes: 5 }, "minutes"],
        ["delete", { id: "s1", title: "y" }, "title"],
        ["upcoming", { status: "active" }, "status"],
      ];
      for (const [action, extra, bad] of cases) {
        const result = tool(env, { action, ...extra });
        assert.equal(result.isError, true, action);
        assert.equal(text(result), `错误：未知字段: ${bad}（action=${action} 不接受）`, action);
      }
    });
  });

  it("值为 undefined 的表外字段放行", async () => {
    await withEnv((env) => {
      const result = tool(env, { action: "list", id: undefined, title: undefined });
      assert.notEqual(result.isError, true);
    });
  });

  it("合法调用不受影响", async () => {
    await withEnv((env) => {
      const added = tool(env, {
        action: "add",
        title: "交话费",
        date: day(3),
        time: "10:00",
        request_id: "req-whitelist-1",
      });
      assert.notEqual(added.isError, true, text(added));
      const id = (JSON.parse(text(added)) as { 已创建: { id: string } }).已创建.id;

      const updated = tool(env, { action: "update", id, note: "n", status: "active" });
      assert.notEqual(updated.isError, true, text(updated));

      const snoozed = tool(env, { action: "snooze", id, minutes: 30 });
      assert.notEqual(snoozed.isError, true, text(snoozed));

      const completed = tool(env, { action: "complete", match: "交话费", date: day(3) });
      assert.notEqual(completed.isError, true, text(completed));
    });
  });

  it("未知 action 文案不变", async () => {
    await withEnv((env) => {
      const result = tool(env, { action: "bogus" });
      assert.equal(result.isError, true);
      assert.equal(text(result), "错误：未知 action: bogus");
    });
  });
});
