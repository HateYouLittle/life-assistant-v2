import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DateTime } from "luxon";
import { TZ } from "../src/time.js";
import {
  fireDue,
  getSchedule,
  materializeSchedule,
  tickSchedules,
  type ScheduleRow,
} from "../src/modules/schedule/service.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { ensureProfile } from "../src/core/settings.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 日程写路径的三组新能力：
 * 1. add 的 request_id 幂等键（schedules.client_token）；
 * 2. complete 的循环语义（裸调拒绝，必须 occurrence_key 或 all=true）；
 * 3. snooze / skip 的单次处置（不改系列状态）。
 * 时钟用 node:test mock timers（apis:["Date"]）冻结；触发时刻显式传给 fireDue。
 */

const D = "2026-10-20";

function freeze(t: TestContext, at: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
}

function advance(t: TestContext, at: string): void {
  t.mock.timers.setTime(Date.parse(at));
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

function tool(env: TestEnv, args: Record<string, unknown>, profileId = "default") {
  return scheduleTool(args, {
    profileId,
    db: env.db,
    config: env.config,
    services: envServices(env),
  });
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function payload<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(text(result)) as T;
}

/** 未完成的 occurrence 数量（不按状态细分） */
function occurrenceCount(env: TestEnv, id: string): number {
  const row = env.db
    .prepare("SELECT COUNT(*) AS n FROM occurrences WHERE schedule_id = ?")
    .get(id) as { n: number };
  return row.n;
}

function occurrenceKeys(env: TestEnv, id: string): string[] {
  return (
    env.db
      .prepare(
        "SELECT occurrence_key FROM occurrences WHERE schedule_id = ? ORDER BY event_at, occurrence_key",
      )
      .all(id) as { occurrence_key: string }[]
  ).map((r) => r.occurrence_key);
}

/** 普通提醒行的 key（排除 :resend / #esc:N 派生行） */
function normalKeys(env: TestEnv, id: string): string[] {
  return occurrenceKeys(env, id).filter((key) => /#\d+$/.test(key));
}

function occurrenceStatus(env: TestEnv, id: string, key: string): string | undefined {
  const row = env.db
    .prepare("SELECT status FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
    .get(id, key) as { status: string } | undefined;
  return row?.status;
}

function dueOf(env: TestEnv, id: string, key: string): string | undefined {
  const row = env.db
    .prepare("SELECT due_at FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
    .get(id, key) as { due_at: string } | undefined;
  return row?.due_at;
}

function scheduleStatus(env: TestEnv, id: string): ScheduleRow["status"] | undefined {
  return getSchedule(env.db, "default", id)?.status;
}

function reminders(env: TestEnv) {
  return env.published.filter((p) => p.input.kind === "schedule.reminder");
}

function addOnce(
  env: TestEnv,
  over: {
    title?: string;
    date?: string;
    time?: string;
    remind_offsets?: number[];
    all_day?: boolean;
    request_id?: string;
    kind?: string;
    profileId?: string;
  } = {},
): string {
  const result = tool(
    env,
    {
      action: "add",
      title: over.title ?? "一次性待办",
      date: over.date ?? D,
      time: over.time ?? "18:00",
      ...(over.remind_offsets === undefined ? {} : { remind_offsets: over.remind_offsets }),
      ...(over.all_day === undefined ? {} : { all_day: over.all_day }),
      ...(over.request_id === undefined ? {} : { request_id: over.request_id }),
      ...(over.kind === undefined ? {} : { kind: over.kind }),
    },
    over.profileId ?? "default",
  ) as { content: { text: string }[]; isError?: boolean };
  assert.notEqual(result.isError, true, text(result));
  return payload<{ 已创建: { id: string } }>(result).已创建.id;
}

function addDaily(env: TestEnv, time = "18:00"): string {
  const result = tool(env, {
    action: "add",
    title: "每日巡检",
    date: D,
    time,
    recurrence: { freq: "daily", interval: 1 },
  }) as { content: { text: string }[]; isError?: boolean };
  assert.notEqual(result.isError, true, text(result));
  return payload<{ 已创建: { id: string } }>(result).已创建.id;
}

describe("schedule add：request_id 幂等键（client_token）", () => {
  it("同一 request_id 重试只建一条：返回原 id、occurrence 数量不变、无重复提醒", (t) => {
    freeze(t, `${D}T10:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const args = {
        action: "add",
        title: "幂等待办",
        date: "2026-10-21",
        time: "09:00",
        request_id: "req-20261020-1",
      };
      const first = payload<{ 已创建: { id: string }; 已存在?: boolean }>(tool(env, args));
      assert.equal(first.已存在, undefined, "首次创建不应带 已存在");
      const firstOccurrences = occurrenceCount(env, first.已创建.id);
      assert.ok(firstOccurrences > 0);

      const second = payload<{ 已创建: { id: string }; 已存在?: boolean }>(tool(env, args));
      assert.equal(second.已创建.id, first.已创建.id, "重试必须返回首次创建的原日程 id");
      assert.equal(second.已存在, true);
      assert.equal(occurrenceCount(env, first.已创建.id), firstOccurrences, "不得重建 occurrence");
      const rows = env.db
        .prepare("SELECT COUNT(*) AS n FROM schedules WHERE profile_id = ? AND client_token = ?")
        .get("default", "req-20261020-1") as { n: number };
      assert.equal(rows.n, 1, "同一 (profile_id, request_id) 只允许一条日程");
      assert.equal(reminders(env).length, 0, "创建阶段不应触发提醒");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("重试沿用首次回执：同一个 request_id 换内容也不会改原日程", (t) => {
    freeze(t, `${D}T10:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const first = payload<{ 已创建: { id: string; 标题: string } }>(
        tool(env, {
          action: "add",
          title: "首次标题",
          date: D,
          time: "09:00",
          request_id: "req-dup",
        }),
      );
      const second = payload<{ 已创建: { id: string; 标题: string }; 已存在?: boolean }>(
        tool(env, {
          action: "add",
          title: "重试时的另一个标题",
          date: D,
          time: "10:00",
          request_id: "req-dup",
        }),
      );
      assert.equal(second.已创建.id, first.已创建.id);
      assert.equal(second.已创建.标题, "首次标题", "幂等命中返回原日程，不能按新参数改写");
      assert.equal(second.已存在, true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨 Profile 隔离：同名 request_id 各自独立创建", (t) => {
    freeze(t, `${D}T10:00:00+08:00`);
    const env = makeTestEnv();
    try {
      ensureProfile(env.db, "other");
      const args = {
        action: "add",
        title: "跨 Profile 幂等",
        date: D,
        time: "09:00",
        request_id: "shared-token",
      };
      const mine = payload<{ 已创建: { id: string } }>(tool(env, args));
      const other = payload<{ 已创建: { id: string }; 已存在?: boolean }>(tool(env, args, "other"));
      assert.notEqual(other.已创建.id, mine.已创建.id, "唯一索引按 profile 分范围");
      assert.equal(other.已存在, undefined);
      const count = env.db
        .prepare("SELECT COUNT(*) AS n FROM schedules WHERE client_token = ?")
        .get("shared-token") as { n: number };
      assert.equal(count.n, 2);
      // 各自重试仍命中自己的那条
      const mineAgain = payload<{ 已创建: { id: string } }>(tool(env, args));
      assert.equal(mineAgain.已创建.id, mine.已创建.id);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非法 request_id（空串 / 超 128 字符）失败且不落库", (t) => {
    freeze(t, `${D}T10:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const empty = tool(env, {
        action: "add",
        title: "空幂等键",
        date: D,
        time: "09:00",
        request_id: "",
      }) as { isError?: boolean; content: { text: string }[] };
      assert.equal(empty.isError, true);
      assert.match(text(empty), /request_id/);

      const tooLong = tool(env, {
        action: "add",
        title: "超长幂等键",
        date: D,
        time: "09:00",
        request_id: "x".repeat(129),
      }) as { isError?: boolean; content: { text: string }[] };
      assert.equal(tooLong.isError, true);
      assert.match(text(tooLong), /request_id/);

      const count = env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number };
      assert.equal(count.n, 0, "校验失败不得留下半成品日程");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule complete：循环日程必须显式指定单次或结束系列", () => {
  it("循环日程裸调 complete 失败：提示 occurrence_key / all=true，系列与 occurrence 原样保留", (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addDaily(env);
      const before = occurrenceCount(env, id);
      const result = tool(env, { action: "complete", id }) as {
        isError?: boolean;
        content: { text: string }[];
      };
      assert.equal(result.isError, true);
      assert.match(text(result), /循环日程需带 occurrence_key/);
      assert.match(text(result), /all=true/);
      assert.match(text(result), /schedule list/, "错误信息应指向 list 取 occurrence 列表");
      assert.equal(scheduleStatus(env, id), "active");
      assert.equal(occurrenceCount(env, id), before, "拒绝时不得改动 occurrence");
      assert.ok(
        occurrenceKeys(env, id).every((key) => occurrenceStatus(env, id, key) === "pending"),
        "拒绝时不得把任何 occurrence 置 done",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("循环日程带 occurrence_key：只完成该次，系列继续，下一天仍提醒", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addDaily(env);
      const [firstKey] = normalKeys(env, id);
      assert.equal(firstKey, `${D}T18:00#0`);
      const done = tool(env, { action: "complete", id, occurrence_key: firstKey }) as {
        isError?: boolean;
      };
      assert.notEqual(done.isError, true);
      assert.equal(occurrenceStatus(env, id, firstKey as string), "done");
      assert.equal(scheduleStatus(env, id), "active", "单次完成不结束系列");
      assert.ok(
        normalKeys(env, id).some((key) => occurrenceStatus(env, id, key) === "pending"),
        "后续发生仍应保持 pending",
      );

      await fireDue(env.db, envServices(env), T(`${D}T18:00:30+08:00`));
      assert.equal(reminders(env).length, 0, "已完成的那次不得再提醒");
      await fireDue(env.db, envServices(env), T("2026-10-21T18:00:30+08:00"));
      assert.equal(reminders(env).length, 1, "系列继续，下一天照常提醒");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("循环日程传 all=true：结束整个系列（既有语义）", (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addDaily(env);
      const result = tool(env, { action: "complete", id, all: true }) as { isError?: boolean };
      assert.notEqual(result.isError, true);
      assert.equal(scheduleStatus(env, id), "done");
      assert.ok(
        occurrenceKeys(env, id).every((key) => occurrenceStatus(env, id, key) === "done"),
        "整系列完成后所有 occurrence 应为 done",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("一次性日程裸调 complete 语义不变（回归）", (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addOnce(env, { date: "2026-10-21" });
      const result = tool(env, { action: "complete", id }) as { isError?: boolean };
      assert.notEqual(result.isError, true);
      assert.equal(scheduleStatus(env, id), "done");
      assert.ok(normalKeys(env, id).every((key) => occurrenceStatus(env, id, key) === "done"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("一次性待办带 occurrence_key complete：日程也转 done，不再留在 active 列表（B3）", (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addOnce(env, { date: "2026-10-21" });
      const key = normalKeys(env, id)[0] as string;
      const done = payload<{ 已完成: { 状态: string } }>(
        tool(env, { action: "complete", id, occurrence_key: key }),
      );
      assert.equal(done.已完成.状态, "done", "回执状态必须与「已完成」一致");
      assert.equal(scheduleStatus(env, id), "done", "一次性待办只有这一次发生，完成后应终态");
      assert.equal(occurrenceStatus(env, id, key), "done");

      const listed = payload<{ 日程: { id: string }[] }>(tool(env, { action: "list" }));
      assert.ok(
        listed.日程.every((row) => row.id !== id),
        "完成后不得再出现在默认（active）列表里",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("list 的「待办发生」给出可直接用于 complete 的 occurrence_key", (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addDaily(env);
      const listed = payload<{
        日程: {
          id: string;
          待办发生?: { occurrence_key: string }[];
        }[];
      }>(tool(env, { action: "list" }));
      const row = listed.日程.find((item) => item.id === id);
      assert.ok(row !== undefined);
      assert.equal(row?.待办发生?.[0]?.occurrence_key, `${D}T18:00#0`);
      const key = row?.待办发生?.[0]?.occurrence_key as string;
      const done = tool(env, { action: "complete", id, occurrence_key: key }) as {
        isError?: boolean;
      };
      assert.notEqual(done.isError, true);
      assert.equal(occurrenceStatus(env, id, key), "done");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule snooze：推迟单次提醒", () => {
  it("提醒过的行 snooze 后按新 due_at 重新提醒，通知时间取 due_at，物化不覆盖", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addOnce(env, { time: "18:00" });
      const key = `${D}T18:00#0`;
      await fireDue(env.db, envServices(env), T(`${D}T18:00:10+08:00`));
      assert.equal(reminders(env).length, 1);
      assert.equal(occurrenceStatus(env, id, key), "notified");
      const firstDedupe = reminders(env)[0]?.input.dedupeKey;

      const snoozed = payload<{
        已推迟: {
          id: string;
          occurrence_key: string;
          提醒时间: string;
          "提醒时间(本地)": string;
          版本: number;
        };
      }>(
        tool(env, {
          action: "snooze",
          id,
          occurrence_key: key,
          minutes: 10,
        }),
      );
      assert.equal(snoozed.已推迟.occurrence_key, key);
      assert.equal(snoozed.已推迟["提醒时间(本地)"], `${D} 18:10`);
      assert.equal(snoozed.已推迟.版本, 2, "snooze 必须让 version 自增");
      assert.equal(occurrenceStatus(env, id, key), "pending");
      assert.equal(dueOf(env, id, key), snoozed.已推迟.提醒时间);

      // tick 的物化只做 INSERT OR IGNORE，不得把手工改过的 due_at 覆盖回 18:00
      materializeSchedule(env.db, getSchedule(env.db, "default", id) as ScheduleRow);
      assert.equal(dueOf(env, id, key), snoozed.已推迟.提醒时间);

      // tick = catchupSweep + fireDue + 物化：原时间不推、新时间推，且物化不覆盖 due_at
      await tickSchedules(T(`${D}T18:00:30+08:00`), envServices(env), env.db);
      assert.equal(reminders(env).length, 1, "原时间不得再推");
      assert.equal(dueOf(env, id, key), snoozed.已推迟.提醒时间, "tick 不得覆盖手工改过的 due_at");
      await tickSchedules(T(`${D}T18:10:05+08:00`), envServices(env), env.db);
      assert.equal(reminders(env).length, 2, "新 due_at 到点必须重新提醒");
      const second = reminders(env)[1];
      const timeRow = (second?.input.blocks?.table?.rows ?? []).find((r) => r[0] === "时间");
      assert.equal(timeRow?.[1], `${D} 18:10`, "通知里的时间必须来自 due_at，而不是旧的快照");
      assert.notEqual(
        second?.input.dedupeKey,
        firstDedupe,
        "snooze 后的提醒不能被 outbox 去重吞掉",
      );
      assert.equal(occurrenceStatus(env, id, key), "notified");

      await fireDue(env.db, envServices(env), T(`${D}T18:10:40+08:00`));
      assert.equal(reminders(env).length, 2, "同一行只推一次");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("已到点的行从此刻起算顺延（不是从过期的 due_at 起算）", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addOnce(env, { time: "18:00" });
      await fireDue(env.db, envServices(env), T(`${D}T18:00:05+08:00`));
      advance(t, `${D}T18:30:00+08:00`);
      const snoozed = payload<{ 已推迟: { "提醒时间(本地)": string } }>(
        tool(env, { action: "snooze", id, minutes: 10 }),
      );
      assert.equal(snoozed.已推迟["提醒时间(本地)"], `${D} 18:40`);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("缺省目标 = 该日程最早未完成的一次；循环日程仍保持 active", (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addDaily(env);
      const snoozed = payload<{
        已推迟: { occurrence_key: string; "提醒时间(本地)": string };
      }>(tool(env, { action: "snooze", id, minutes: 10 }));
      assert.equal(snoozed.已推迟.occurrence_key, `${D}T18:00#0`);
      assert.equal(snoozed.已推迟["提醒时间(本地)"], `${D} 18:10`);
      assert.equal(scheduleStatus(env, id), "active");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("until=HH:mm 解析为下一个该本地时刻（已过则落明天）", (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addOnce(env, { time: "18:00" });
      const today = payload<{ 已推迟: { "提醒时间(本地)": string } }>(
        tool(env, { action: "snooze", id, until: "20:00" }),
      );
      assert.equal(today.已推迟["提醒时间(本地)"], `${D} 20:00`);
      const tomorrow = payload<{ 已推迟: { "提醒时间(本地)": string } }>(
        tool(env, { action: "snooze", id, until: "08:00" }),
      );
      assert.equal(tomorrow.已推迟["提醒时间(本地)"], "2026-10-21 08:00");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("已完成的 occurrence 不能 snooze；参数缺失/越界/非法 until 均失败", (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      // 用循环日程：一次性待办带 key 完成后整条日程会转 done（B3），这里要验的是
      // 「已完成的 occurrence 不能 snooze」，因此需要一个完成后仍 active 的系列。
      const id = addDaily(env);
      const key = `${D}T18:00#0`;
      tool(env, { action: "complete", id, occurrence_key: key });
      const done = tool(env, { action: "snooze", id, occurrence_key: key, minutes: 10 }) as {
        isError?: boolean;
        content: { text: string }[];
      };
      assert.equal(done.isError, true);
      assert.match(text(done), /不能 snooze/);

      const neither = tool(env, { action: "snooze", id }) as { isError?: boolean };
      assert.equal(neither.isError, true);
      const both = tool(env, { action: "snooze", id, minutes: 10, until: "20:00" }) as {
        isError?: boolean;
      };
      assert.equal(both.isError, true);
      const zero = tool(env, { action: "snooze", id, minutes: 0 }) as { isError?: boolean };
      assert.equal(zero.isError, true);
      const tooLong = tool(env, { action: "snooze", id, minutes: 10081 }) as {
        isError?: boolean;
      };
      assert.equal(tooLong.isError, true);
      const badUntil = tool(env, { action: "snooze", id, until: "8:00" }) as {
        isError?: boolean;
      };
      assert.equal(badUntil.isError, true);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule skip：跳过单次发生，系列继续", () => {
  it("skip 后原时间不提醒、下一次照常；series 仍 active 且不复活 cancelled 行", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addDaily(env);
      const key = `${D}T18:00#0`;
      const skipped = payload<{
        已跳过: { occurrence_key: string; 剩余未完成: number; 版本: number };
      }>(tool(env, { action: "skip", id, occurrence_key: key }));
      assert.equal(skipped.已跳过.occurrence_key, key);
      assert.equal(occurrenceStatus(env, id, key), "cancelled");
      assert.ok(skipped.已跳过.剩余未完成 > 0, "循环日程跳过一次后仍有后续发生");
      assert.equal(skipped.已跳过.版本, 2);
      assert.equal(scheduleStatus(env, id), "active", "skip 不得结束系列");

      // tick（物化 + 提醒）不得把 cancelled 行复活，也不得在原时刻打扰
      await tickSchedules(T(`${D}T17:30:00+08:00`), envServices(env), env.db);
      assert.equal(occurrenceStatus(env, id, key), "cancelled");
      await fireDue(env.db, envServices(env), T(`${D}T18:00:05+08:00`));
      assert.equal(reminders(env).length, 0, "跳过的这次不得再提醒");

      await fireDue(env.db, envServices(env), T("2026-10-21T18:00:05+08:00"));
      assert.equal(reminders(env).length, 1, "系列后续必须正常提醒");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同一事件的兄弟偏移一并跳过（不会漏推正点那条）", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addOnce(env, { time: "18:00", remind_offsets: [-30, 0] });
      assert.equal(occurrenceStatus(env, id, `${D}T18:00#0`), "pending");
      assert.equal(occurrenceStatus(env, id, `${D}T18:00#1`), "pending");
      tool(env, { action: "skip", id, occurrence_key: `${D}T18:00#0` });
      assert.equal(occurrenceStatus(env, id, `${D}T18:00#0`), "cancelled");
      assert.equal(occurrenceStatus(env, id, `${D}T18:00#1`), "cancelled");
      await fireDue(env.db, envServices(env), T(`${D}T17:30:05+08:00`));
      await fireDue(env.db, envServices(env), T(`${D}T18:00:05+08:00`));
      assert.equal(reminders(env).length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("一次性待办 skip 后即收尾（done）；回执与真实状态一致，tick/物化不复活该次", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addOnce(env, { time: "18:00" });
      const key = `${D}T18:00#0`;
      const skipped = payload<{
        已跳过: { 剩余未完成: number; 状态: string; 已结束该待办: boolean };
      }>(tool(env, { action: "skip", id, occurrence_key: key }));
      assert.equal(skipped.已跳过.剩余未完成, 0);
      // P2-2 新契约：一次性待办没有「下一次」，skip 跳过这一次即整条待办结束（与 complete 的
      // 终态一致：都是 done，不存在「active 但永不提醒」的半终态）。
      assert.equal(
        scheduleStatus(env, id),
        "done",
        "一次性待办 skip 后必须收尾，不能永留 active 且不再提醒",
      );
      assert.equal(skipped.已跳过.状态, "done", "回执必须如实反映终态");
      assert.equal(skipped.已跳过.已结束该待办, true);

      await tickSchedules(T(`${D}T18:00:05+08:00`), envServices(env), env.db);
      assert.equal(occurrenceStatus(env, id, key), "cancelled", "物化不得复活已跳过的一次");
      assert.equal(reminders(env).length, 0);
      // 已收尾后 complete 必须明确拒绝，而不是又报一次「已完成」（避免二次收尾的混淆回执）
      const again = tool(env, { action: "complete", id, occurrence_key: key }) as {
        isError?: boolean;
      };
      assert.equal(again.isError, true, "已收尾的待办再次 complete 必须明确报错");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("已提醒过的 occurrence 也可 skip；已完成的不能 skip", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addOnce(env, { time: "18:00" });
      const key = `${D}T18:00#0`;
      await fireDue(env.db, envServices(env), T(`${D}T18:00:05+08:00`));
      assert.equal(occurrenceStatus(env, id, key), "notified");
      tool(env, { action: "skip", id });
      assert.equal(occurrenceStatus(env, id, key), "cancelled");

      const doneId = addOnce(env, { time: "19:00" });
      const doneKey = `${D}T19:00#0`;
      tool(env, { action: "complete", id: doneId, occurrence_key: doneKey });
      const failed = tool(env, { action: "skip", id: doneId, occurrence_key: doneKey }) as {
        isError?: boolean;
      };
      assert.equal(failed.isError, true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("循环日程全部提醒都 skip 掉后不会误判为系列结束", (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const id = addDaily(env);
      // 只跳过最近一次；schedule 仍 active，且还有大量后续发生
      const remaining = payload<{ 已跳过: { 剩余未完成: number } }>(
        tool(env, { action: "skip", id }),
      ).已跳过.剩余未完成;
      assert.ok(remaining > 1);
      assert.equal(scheduleStatus(env, id), "active");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule upcoming：同一事件只出现一条（B7）", () => {
  it("多偏移日程只列一条，且返回的 occurrence_key 可直接 snooze", (t) => {
    freeze(t, `${D}T10:00:00+08:00`);
    const env = makeTestEnv();
    try {
      // 未来事件 + 两个偏移（提前 60 分钟、正点）：两条 pending 行属于同一个事件
      const id = addOnce(env, {
        date: "2026-10-21",
        time: "09:00",
        remind_offsets: [-60, 0],
      });
      const up = payload<{
        即将到来: { id: string; occurrence_key: string }[];
      }>(tool(env, { action: "upcoming", limit: 10 }));
      const mine = up.即将到来.filter((item) => item.id === id);
      assert.equal(mine.length, 1, "同一事件的两个提醒偏移只能出现一条");
      assert.equal(
        mine[0]?.occurrence_key,
        "2026-10-21T09:00#0",
        "优先普通提醒行（最早那次的偏移）",
      );

      // 该 key 对 complete/snooze/skip 三个动作都可用（派生 key 会被 snooze 拒绝）
      const snoozed = tool(env, {
        action: "snooze",
        id,
        occurrence_key: mine[0]?.occurrence_key,
        minutes: 10,
      }) as { isError?: boolean; content: { text: string }[] };
      assert.notEqual(snoozed.isError, true, text(snoozed));
      assert.equal(
        occurrenceStatus(env, id, mine[0]?.occurrence_key as string),
        "pending",
        "snooze 后该普通提醒行仍在 pending，等新的 due_at 触发",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});
