import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DateTime } from "luxon";
import { TZ } from "../src/time.js";
import {
  agendaForDate,
  expireStaleRecurringTodos,
  fireDue,
  tickSchedules,
} from "../src/modules/schedule/service.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 循环待办「回一句就算」的配套语义：
 * - 过了当天自动作废，不进早报/晚报的「逾期未完成」；
 * - 当天 20:00 还没完成就再提醒一次（没设 resend_minutes/escalation 时的默认）。
 */

const D = "2026-10-20";
const T = (s: string): DateTime => DateTime.fromISO(s, { zone: TZ });

function freeze(t: TestContext, at: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
}

function services(env: TestEnv) {
  return {
    publishProfile: async (profileId: string, input: { kind: string }) => {
      env.published.push({ profileId, input: input as never });
      return { id: `n-${env.published.length}`, deduped: false };
    },
    publishGlobal: async () => ({ materialized: 0 }),
  };
}

function add(env: TestEnv, args: Record<string, unknown>): string {
  const result = scheduleTool(
    { action: "add", date: D, ...args },
    { profileId: "default", db: env.db, config: env.config, services: services(env) },
  ) as { content: { text: string }[]; isError?: boolean };
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return (JSON.parse(result.content[0]?.text ?? "") as { 已创建: { id: string } }).已创建.id;
}

function statusOf(env: TestEnv, id: string, key: string): string | undefined {
  return (
    env.db
      .prepare("SELECT status FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
      .get(id, key) as { status: string } | undefined
  )?.status;
}

const DAILY = { freq: "daily", interval: 1 };

describe("循环待办过期作废", () => {
  it("昨天没完成的循环待办隔天作废，不进今天的议程", async (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = add(env, { title: "打下班卡", time: "17:30", recurrence: DAILY });
      await fireDue(env.db, services(env), T(`${D}T17:30:30+08:00`));
      assert.equal(statusOf(env, id, `${D}T17:30#0`), "notified");

      t.mock.timers.setTime(Date.parse("2026-10-21T07:00:00+08:00"));
      const expired = expireStaleRecurringTodos(env.db, T("2026-10-21T07:00:00+08:00"));
      assert.ok(expired >= 1);
      assert.equal(statusOf(env, id, `${D}T17:30#0`), "cancelled");
      const agenda = agendaForDate(env.db, "default", "2026-10-21");
      assert.ok(!agenda.some((item) => item.overdue), "不应再有逾期项");
      assert.ok(agenda.some((item) => item.title === "打下班卡" && !item.overdue));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("一次性待办与截止型（escalation）不作废", async (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const once = add(env, { title: "交材料", time: "10:00" });
      const deadline = add(env, {
        title: "报销",
        time: "11:00",
        recurrence: DAILY,
        escalation: [0, 60],
      });
      await fireDue(env.db, services(env), T(`${D}T11:00:30+08:00`));
      expireStaleRecurringTodos(env.db, T("2026-10-22T07:00:00+08:00"));
      assert.equal(statusOf(env, once, `${D}T10:00#0`), "notified");
      assert.equal(statusOf(env, deadline, `${D}T11:00#0`), "notified");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("tick 自动作废：不需要单独的 job", async (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = add(env, { title: "每日巡检", time: "09:00", recurrence: DAILY });
      await tickSchedules(T(`${D}T09:00:30+08:00`), services(env), env.db);
      t.mock.timers.setTime(Date.parse("2026-10-21T00:00:30+08:00"));
      await tickSchedules(T("2026-10-21T00:00:30+08:00"), services(env), env.db);
      assert.equal(statusOf(env, id, `${D}T09:00#0`), "cancelled");
      assert.equal(statusOf(env, id, `${D}T09:00#0:resend`), "cancelled");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("循环待办晚间追提醒", () => {
  it("当天 20:00 未完成再提醒一次；完成后不再追", async (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const a = add(env, { title: "每日巡检", time: "09:00", recurrence: DAILY });
      const b = add(env, { title: "打下班卡", time: "17:30", recurrence: DAILY });
      await fireDue(env.db, services(env), T(`${D}T09:00:30+08:00`));
      await fireDue(env.db, services(env), T(`${D}T17:30:30+08:00`));
      assert.equal(env.published.length, 2);

      scheduleTool(
        { action: "complete", id: b, occurrence_key: `${D}T17:30#0` },
        { profileId: "default", db: env.db, config: env.config, services: services(env) },
      );
      await fireDue(env.db, services(env), T(`${D}T19:59:00+08:00`));
      assert.equal(env.published.length, 2, "20:00 之前不追");
      await fireDue(env.db, services(env), T(`${D}T20:00:30+08:00`));
      assert.equal(env.published.length, 3, "只追没完成的那条");
      const chased = env.published[2]?.input as unknown as {
        title: string;
        blocks: { notes?: string[] };
      };
      assert.equal(chased.title, "每日巡检");
      assert.match((chased.blocks.notes ?? []).join(" "), /晚间再提醒一次/);
      assert.equal(statusOf(env, a, `${D}T09:00#0:resend`), "notified");
      await fireDue(env.db, services(env), T(`${D}T21:00:00+08:00`));
      assert.equal(env.published.length, 3, "同一事件只追一次");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("19:30 之后的循环待办、一次性待办、生日不追", async (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      add(env, { title: "睡前拉伸", time: "19:45", recurrence: DAILY });
      add(env, { title: "交材料", time: "10:00" });
      await fireDue(env.db, services(env), T(`${D}T19:45:30+08:00`));
      const before = env.published.length;
      await fireDue(env.db, services(env), T(`${D}T20:30:00+08:00`));
      assert.equal(env.published.length, before);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("显式 resend_minutes 优先于晚间追提醒", async (t) => {
    freeze(t, `${D}T08:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = add(env, {
        title: "吃药",
        time: "09:00",
        recurrence: DAILY,
        resend_minutes: 30,
      });
      await fireDue(env.db, services(env), T(`${D}T09:00:30+08:00`));
      const due = (
        env.db
          .prepare("SELECT due_at FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
          .get(id, `${D}T09:00#0:resend`) as { due_at: string }
      ).due_at;
      assert.equal(DateTime.fromISO(due, { zone: TZ }).toFormat("HH:mm"), "09:30");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
