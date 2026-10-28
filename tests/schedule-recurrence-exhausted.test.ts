import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DateTime } from "luxon";
import type { Recurrence } from "../src/core/recurrence.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import {
  completeSchedule,
  createSchedule,
  getSchedule,
  materializeSchedule,
  type ScheduleRow,
  tickSchedules,
} from "../src/modules/schedule/service.js";
import { TZ } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * P2-6 / C-07：`until` / `count` 耗尽后的**终态收口**（回显部分见 tests/recurrence.test.ts）。
 *
 * 旧行为：until 过后物化返回 null、next_run_at 变空，但 schedules.status 仍是 active ——
 * 「active 但永不提醒」的半终态，用户看不出为什么停了。新契约：循环规则耗尽且**再无 pending
 * 提醒**时把日程置 done（与 P2-1 的 complete all=true、P2-2 的一次性待办 skip 同口径）。
 *
 * 本文件钉死两条硬约束（也是最容易踩的坑）：
 * 1. **有 pending 就绝不收尾**：count 用尽时最后一次发生的提醒可能还没到点，置 done 会让
 *    fireDue 的 `s.status='active'` 过滤把它永久吞掉（少提醒一次）。
 * 2. **空结果 ≠ 耗尽**：年度日程的下一条只是落在物化前瞻之外，nextDate 同样返回 null；
 *    据此置终态会把生日/纪念日误判为 done。
 *
 * 有牙齿：删掉 finalizeExhaustedSchedule 的 pending 守卫 → 「还有 pending 时不收尾」用例变红
 * （且提醒条数变 0）；把耗尽判定换成「物化空结果」→ 年度日程用例变红。
 * 时钟用 node:test mock timers 冻结，触发时刻显式传给 tickSchedules/fireDue。
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

function tool(env: TestEnv, args: Record<string, unknown>) {
  return scheduleTool(args, {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: envServices(env),
  });
}

function payload<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0]?.text ?? "{}") as T;
}

interface InputOverrides {
  title?: string;
  kind?: "todo" | "birthday" | "anniversary";
  startDate?: string;
  time?: string;
  recurrence?: Recurrence | null;
}

function add(env: TestEnv, over: InputOverrides = {}): ScheduleRow {
  return createSchedule(env.db, "default", {
    title: over.title ?? "限次巡检",
    note: null,
    kind: over.kind ?? "todo",
    calendar: "solar",
    startDate: over.startDate ?? D,
    lunarMonth: null,
    lunarDay: null,
    leapPolicy: "follow",
    lunarClamp: true,
    time: over.time ?? "18:00",
    allDay: false,
    recurrence: over.recurrence ?? { freq: "daily", interval: 1 },
    remindOffsets: [0],
    resendMinutes: 0,
    escalation: null,
    workdayFilter: "any",
  });
}

function statusOf(env: TestEnv, id: string): string {
  return getSchedule(env.db, "default", id)?.status ?? "<missing>";
}

function nextRunAt(env: TestEnv, id: string): string | null {
  return getSchedule(env.db, "default", id)?.next_run_at ?? null;
}

function occurrenceKeys(env: TestEnv, id: string): string[] {
  return (
    env.db
      .prepare(
        "SELECT occurrence_key FROM occurrences WHERE schedule_id = ? ORDER BY occurrence_key",
      )
      .all(id) as { occurrence_key: string }[]
  ).map((r) => r.occurrence_key);
}

function reminders(env: TestEnv) {
  return env.published.filter((p) => p.input.kind === "schedule.reminder");
}

describe("P2-6 until/count 耗尽后的终态收口", () => {
  it("until 到期且提醒发完后置 done：不吞掉最后一次提醒，回显带（至 …）", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const created = add(env, {
        title: "每天直到周三",
        recurrence: { freq: "daily", interval: 1, until: "2026-10-21" },
      });
      // 两次发生都还没到点：不得因为「until 之后没有候选」就提前收尾
      assert.equal(statusOf(env, created.id), "active", "还有 pending 提醒时不得收尾");
      assert.deepEqual(occurrenceKeys(env, created.id), [`${D}T18:00#0`, "2026-10-21T18:00#0"]);

      const receipt = payload<{ 日程: { id: string; 重复: string; 状态: string }[] }>(
        tool(env, { action: "list" }),
      );
      const listed = receipt.日程.find((row) => row.id === created.id);
      assert.equal(listed?.重复, "每天（至 2026-10-21）", "回显必须带上 until，否则看不出为什么停");

      advance(t, "2026-10-21T18:00:30+08:00");
      await tickSchedules(T("2026-10-21T18:00:30+08:00"), envServices(env), env.db);

      assert.equal(reminders(env).length, 2, "两次提醒都必须照常发出（收尾不得吞提醒）");
      assert.equal(statusOf(env, created.id), "done", "until 到期且无 pending 应收敛到终态 done");
      assert.equal(nextRunAt(env, created.id), null);

      const active = payload<{ 日程: { id: string }[]; 数量: number }>(
        tool(env, { action: "list", status: "active" }),
      );
      assert.ok(
        !active.日程.some((row) => row.id === created.id),
        "终态日程不得再出现在 active 列表",
      );
      const done = payload<{ 日程: { id: string; 重复: string; 状态: string }[] }>(
        tool(env, { action: "list", status: "done" }),
      );
      const doneRow = done.日程.find((row) => row.id === created.id);
      assert.equal(doneRow?.状态, "done", "终态必须可见（done 列表）");
      assert.equal(doneRow?.重复, "每天（至 2026-10-21）", "终态行的「重复」栏仍要带 until");

      // 收尾后不得复活：再物化/再 tick 都不产生新 occurrence
      await tickSchedules(T("2026-10-22T09:00:00+08:00"), envServices(env), env.db);
      assert.deepEqual(occurrenceKeys(env, created.id), [`${D}T18:00#0`, "2026-10-21T18:00#0"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("until=今天但提醒尚未到点：先保持 active，提醒发出后才收尾（pending 守卫有牙齿）", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const created = add(env, {
        title: "只此一次循环",
        recurrence: { freq: "daily", interval: 1, until: D },
      });
      assert.deepEqual(occurrenceKeys(env, created.id), [`${D}T18:00#0`]);
      assert.notEqual(nextRunAt(env, created.id), null, "待发提醒必须还在 next_run_at 里");

      // 17:00 tick：until 已「到期」（今天之后再无候选），但 18:00 那条还没到点 —— 必须留着
      await tickSchedules(T(`${D}T17:00:00+08:00`), envServices(env), env.db);
      assert.equal(statusOf(env, created.id), "active", "有 pending 时绝不能置 done");
      assert.equal(reminders(env).length, 0);

      advance(t, `${D}T18:00:30+08:00`);
      await tickSchedules(T(`${D}T18:00:30+08:00`), envServices(env), env.db);
      assert.equal(reminders(env).length, 1, "最后一次提醒必须发出（旧实现在此之前就把它吞了）");
      assert.equal(statusOf(env, created.id), "done", "提醒发完且无 pending，才收尾");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("count 用尽且提醒发完：置 done，且不再补出第 N+1 次", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      const created = add(env, {
        title: "最多两次",
        recurrence: { freq: "daily", interval: 1, count: 2 },
      });
      assert.deepEqual(occurrenceKeys(env, created.id), [`${D}T18:00#0`, "2026-10-21T18:00#0"]);
      await tickSchedules(T(`${D}T17:00:00+08:00`), envServices(env), env.db);
      assert.equal(statusOf(env, created.id), "active", "count 用尽但提醒未发完时不得收尾");

      const listed = payload<{ 日程: { id: string; 重复: string }[] }>(
        tool(env, { action: "list" }),
      );
      assert.equal(
        listed.日程.find((row) => row.id === created.id)?.重复,
        "每天（共 2 次）",
        "回显必须带上 count，否则看不出还剩几次",
      );

      advance(t, "2026-10-21T18:00:30+08:00");
      await tickSchedules(T("2026-10-21T18:00:30+08:00"), envServices(env), env.db);
      assert.equal(reminders(env).length, 2, "两次提醒都必须发出");
      assert.equal(statusOf(env, created.id), "done", "count 用尽且无 pending 应收敛到 done");

      await tickSchedules(T("2026-10-23T09:00:00+08:00"), envServices(env), env.db);
      assert.deepEqual(
        occurrenceKeys(env, created.id),
        [`${D}T18:00#0`, "2026-10-21T18:00#0"],
        "count 是硬上限，终态后不得补出第 3 次",
      );
      assert.equal(statusOf(env, created.id), "done");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("每 2 年的生日：下一条落在 400 天物化前瞻之外（空结果）也不得误判终态", async (t) => {
    freeze(t, `${D}T17:00:00+08:00`);
    const env = makeTestEnv();
    try {
      // interval=2：下一条 2028-10-20 超出 FAR_HORIZON（400 天）→ nextDate 返回 null，
      // 物化结果为空，但规则并未耗尽（没有 until、count 也没声明）。
      const created = add(env, {
        title: "妈妈生日",
        kind: "birthday",
        recurrence: { freq: "yearly", interval: 2 },
      });
      const key = occurrenceKeys(env, created.id)[0] as string;
      assert.equal(key, `${D}T18:00#0`);
      // 完成今年这次（单次完成不结束系列）→ 没有任何 pending 了
      completeSchedule(env.db, "default", created.id, key);
      assert.equal(statusOf(env, created.id), "active", "单次完成不结束系列");

      materializeSchedule(env.db, getSchedule(env.db, "default", created.id) as ScheduleRow);
      await tickSchedules(T(`${D}T17:30:00+08:00`), envServices(env), env.db);
      assert.equal(
        statusOf(env, created.id),
        "active",
        "物化空结果只是「下一条还在前瞻之外」，不是「规则耗尽」——不得据此置 done",
      );
      assert.deepEqual(occurrenceKeys(env, created.id), [key]);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
