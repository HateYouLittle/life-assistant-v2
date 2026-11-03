import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DateTime } from "luxon";
import { TZ } from "../src/time.js";
import { fireDue, getSchedule, REMINDER_REPLY_HINT } from "../src/modules/schedule/service.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { ensureProfile } from "../src/core/settings.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * complete 的「按描述完成」：match（关键词 + 日期）与 recent（最近已推送未处理）。
 * 场景：推送没有进入对话上下文，用户只回一句「巡检过了 / 交了」。
 */

const D = "2026-10-20";

function freeze(t: TestContext, at: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
}

const T = (s: string): DateTime => DateTime.fromISO(s, { zone: TZ });

function envServices(env: TestEnv) {
  return {
    publishProfile: async (profileId: string, input: { kind: string }) => {
      env.published.push({ profileId, input: input as never });
      return { id: `n-${env.published.length}`, deduped: false };
    },
    publishGlobal: async () => ({ materialized: 0 }),
  };
}

type Result = { content: { text: string }[]; isError?: boolean };

function tool(env: TestEnv, args: Record<string, unknown>, profileId = "default"): Result {
  return scheduleTool(args, {
    profileId,
    db: env.db,
    config: env.config,
    services: envServices(env),
  }) as Result;
}

function payload<T>(result: Result): T {
  return JSON.parse(result.content[0]?.text ?? "") as T;
}

function add(env: TestEnv, args: Record<string, unknown>, profileId = "default"): string {
  const result = tool(env, { action: "add", date: D, ...args }, profileId);
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return payload<{ 已创建: { id: string } }>(result).已创建.id;
}

function daily(env: TestEnv, title: string, time: string, profileId = "default"): string {
  return add(env, { title, time, recurrence: { freq: "daily", interval: 1 } }, profileId);
}

function statusOf(env: TestEnv, id: string, key: string): string | undefined {
  return (
    env.db
      .prepare("SELECT status FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
      .get(id, key) as { status: string } | undefined
  )?.status;
}

interface Reply {
  结果: string;
  说明?: string;
  已完成?: { id: string; occurrence_key: string };
  候选?: { id: string; occurrence_key: string }[];
  "下次提醒(本地)"?: string | null;
}

describe("schedule complete {match}", () => {
  it("唯一匹配：完成今天那次，系列继续，回执带下次提醒（本地）", (t) => {
    freeze(t, `${D}T19:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = daily(env, "每日巡检", "18:00");
      daily(env, "打下班卡", "18:30");
      const reply = payload<Reply>(tool(env, { action: "complete", match: "巡检" }));
      assert.equal(reply.结果, "已完成");
      assert.equal(reply.已完成?.id, id);
      assert.equal(reply.已完成?.occurrence_key, `${D}T18:00#0`);
      assert.equal(statusOf(env, id, `${D}T18:00#0`), "done");
      assert.equal(getSchedule(env.db, "default", id)?.status, "active");
      assert.equal(reply["下次提醒(本地)"], "2026-10-21 18:00");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("重复说一次：返回「已处理」，不报错也不多完成一次", (t) => {
    freeze(t, `${D}T19:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = daily(env, "每日巡检", "18:00");
      tool(env, { action: "complete", match: "巡检" });
      const again = payload<Reply>(tool(env, { action: "complete", match: "巡检" }));
      assert.equal(again.结果, "已处理");
      assert.equal(statusOf(env, id, "2026-10-21T18:00#0"), "pending", "明天那次不受影响");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("date 指定昨天：完成昨天那次", (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = daily(env, "每日巡检", "18:00");
      t.mock.timers.setTime(Date.parse("2026-10-21T09:00:00+08:00"));
      const reply = payload<Reply>(tool(env, { action: "complete", match: "巡检", date: D }));
      assert.equal(reply.结果, "已完成");
      assert.equal(statusOf(env, id, `${D}T18:00#0`), "done");
      assert.equal(statusOf(env, id, "2026-10-21T18:00#0"), "pending");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("多个候选：不完成任何一个，列出候选", (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const a = daily(env, "上班打卡", "08:30");
      const b = daily(env, "下班打卡", "18:30");
      const reply = payload<Reply>(tool(env, { action: "complete", match: "打卡" }));
      assert.equal(reply.结果, "多个候选");
      assert.deepEqual(new Set(reply.候选?.map((c) => c.id)), new Set([a, b]));
      assert.equal(statusOf(env, a, `${D}T08:30#0`), "pending");
      assert.equal(statusOf(env, b, `${D}T18:30#0`), "pending");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("零候选：如实回「未找到」，不新建", (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      daily(env, "每日巡检", "18:00");
      const reply = payload<Reply>(tool(env, { action: "complete", match: "话费" }));
      assert.equal(reply.结果, "未找到");
      const n = env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number };
      assert.equal(n.n, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("一次性待办在未来：不传 date 也能完成并收尾为 done", (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = add(env, { title: "取消酒店订单", date: "2026-10-25", time: "10:00" });
      const reply = payload<Reply>(tool(env, { action: "complete", match: "酒店" }));
      assert.equal(reply.结果, "已完成");
      assert.equal(getSchedule(env.db, "default", id)?.status, "done");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("备注也参与匹配；跨 Profile 隔离", (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      ensureProfile(env.db, "bestie");
      const mine = add(env, {
        title: "每日任务",
        note: "萍乡医院服务器巡检",
        time: "18:00",
        recurrence: { freq: "daily", interval: 1 },
      });
      daily(env, "每日巡检", "18:00", "bestie");
      const reply = payload<Reply>(tool(env, { action: "complete", match: "服务器" }));
      assert.equal(reply.已完成?.id, mine);
      const other = payload<Reply>(tool(env, { action: "complete", match: "每日巡检" }));
      assert.equal(other.结果, "未找到", "不能命中别的 Profile 的日程");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("参数冲突：id 与 match 同时传、match 与 recent 同时传、配 all=true 都拒绝", (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = daily(env, "每日巡检", "18:00");
      for (const args of [
        { id, match: "巡检" },
        { match: "巡检", recent: true },
        { match: "巡检", all: true },
        { match: "巡检", occurrence_key: `${D}T18:00#0` },
      ]) {
        const r = tool(env, { action: "complete", ...args });
        assert.equal(r.isError, true, JSON.stringify(args));
      }
      assert.equal(statusOf(env, id, `${D}T18:00#0`), "pending");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule complete {recent:true}", () => {
  it("最近推送且未处理的唯一提醒：直接完成", async (t) => {
    freeze(t, `${D}T19:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = daily(env, "交话费", "18:00");
      daily(env, "睡前拉伸", "22:00"); // 尚未推送，不算
      await fireDue(env.db, envServices(env), T(`${D}T18:00:30+08:00`));
      const reply = payload<Reply>(tool(env, { action: "complete", recent: true }));
      assert.equal(reply.结果, "已完成");
      assert.equal(reply.已完成?.id, id);
      assert.equal(statusOf(env, id, `${D}T18:00#0`), "done");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("两条都推过：返回候选；超出 12 小时窗口的不算", async (t) => {
    freeze(t, `${D}T19:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const old = add(env, { title: "早晨吃药", date: D, time: "06:00" });
      const a = daily(env, "每日巡检", "17:00");
      const b = daily(env, "打下班卡", "18:00");
      await fireDue(env.db, envServices(env), T(`${D}T06:00:30+08:00`));
      await fireDue(env.db, envServices(env), T(`${D}T18:00:30+08:00`));
      const reply = payload<Reply>(tool(env, { action: "complete", recent: true }));
      assert.equal(reply.结果, "多个候选");
      assert.deepEqual(new Set(reply.候选?.map((c) => c.id)), new Set([a, b]));
      // 把时钟推到窗口外后，早晨那条仍不会被拿来凑数
      t.mock.timers.setTime(Date.parse(`${D}T19:30:00+08:00`));
      tool(env, { action: "complete", id: a, occurrence_key: `${D}T17:00#0` });
      tool(env, { action: "complete", id: b, occurrence_key: `${D}T18:00#0` });
      const none = payload<Reply>(tool(env, { action: "complete", recent: true }));
      assert.equal(none.结果, "未找到");
      assert.equal(getSchedule(env.db, "default", old)?.status, "active");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("没有推送过任何提醒：回「未找到」", (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      daily(env, "每日巡检", "18:00");
      const reply = payload<Reply>(tool(env, { action: "complete", recent: true }));
      assert.equal(reply.结果, "未找到");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("待办提醒的回复提示", () => {
  it("todo 提醒带提示；生日提醒不带", async (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      daily(env, "每日巡检", "09:00");
      add(env, { title: "妈妈生日", kind: "birthday", time: "09:00" });
      await fireDue(env.db, envServices(env), T(`${D}T09:00:30+08:00`));
      const byTitle = new Map(
        env.published.map((p) => [
          (p.input as { title: string }).title,
          (p.input as { blocks: { notes?: string[] } }).blocks.notes ?? [],
        ]),
      );
      assert.ok(byTitle.get("每日巡检")?.includes(REMINDER_REPLY_HINT));
      assert.ok(!byTitle.get("妈妈生日")?.includes(REMINDER_REPLY_HINT));
    } finally {
      cleanupTestEnv(env);
    }
  });
});
