import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { now } from "../src/time.js";
import {
  createSchedule,
  getSchedule,
  updateSchedule,
  type ScheduleInput,
} from "../src/modules/schedule/service.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * P2-3 / C-04：一次性日程 start_date ≤ 昨天时，物化游标从「昨天零点」起、而引擎对
 * 一次性只产出严格晚于游标的日期 → 0 occurrence、next_run_at=null、永久 active、
 * 永不提醒，创建/更新却报成功。本文件锁定「不再静默」的新契约：
 * ① 创建/会动物化的更新对「一次性 + 已过期」明确 fail（文案可操作）；
 * ② 今天/明天、以及重复系列完全不回归；
 * ③ 过期一次性 + 已有 pending 行的唯一待发提醒不得被更新静默丢掉。
 *
 * 有牙齿：把 expiredOneOff 的日期比较方向写反（`startDate < today` → `>`）时，
 * 「昨天创建报错」用例失败；删掉 update 里的守卫时，「pending 原样保留」用例失败
 * （更新会把 pending 行删掉而重物化产不出替代行）。
 */

const day = (offset: number): string => now().plus({ days: offset }).toISODate() as string;

function onceInput(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    title: "一次性待办",
    note: null,
    kind: "todo",
    calendar: "solar",
    startDate: day(-1),
    lunarMonth: null,
    lunarDay: null,
    leapPolicy: "follow",
    lunarClamp: true,
    time: "09:00",
    allDay: false,
    recurrence: null,
    remindOffsets: [0],
    resendMinutes: 0,
    escalation: null,
    workdayFilter: "any",
    ...overrides,
  };
}

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

interface OccurrenceShape {
  occurrence_key: string;
  event_at: string;
  due_at: string;
  status: string;
}

function occurrenceRows(env: TestEnv, scheduleId: string): OccurrenceShape[] {
  return env.db
    .prepare(
      "SELECT occurrence_key, event_at, due_at, status FROM occurrences WHERE schedule_id = ? ORDER BY occurrence_key",
    )
    .all(scheduleId) as unknown as OccurrenceShape[];
}

function scheduleCount(env: TestEnv): number {
  return (env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number }).n;
}

/** 直接改库把 start_date 推到昨天：模拟本修复之前写入的存量行（新建已被守卫拦住） */
function makeExpired(env: TestEnv, id: string): void {
  env.db.prepare("UPDATE schedules SET start_date = ? WHERE id = ?").run(day(-1), id);
}

describe("P2-3 一次性日程过期：不再静默零提醒", () => {
  it("start_date=昨天：创建明确报错，文案说明「不会触发」并给出改法，且不落库", () => {
    const env = makeTestEnv();
    try {
      assert.throws(
        () => createSchedule(env.db, "default", onceInput()),
        (e: Error) =>
          /已过期/.test(e.message) &&
          /不会再产生任何提醒/.test(e.message) &&
          /今天或之后/.test(e.message) &&
          /recurrence/.test(e.message),
        "过期一次性日程必须明确 fail，并给出可操作的改法",
      );
      assert.equal(scheduleCount(env), 0, "报错时不得留下半成品日程行");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("工具层 add：昨天的一次性待办返回 isError，而不是「已创建」的静默成功", () => {
    const env = makeTestEnv();
    try {
      const result = tool(env, {
        action: "add",
        title: "过期待办",
        kind: "todo",
        date: day(-1),
        time: "09:00",
      }) as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, true, "过期一次性待办不得回「已创建」");
      assert.match(result.content[0]?.text ?? "", /已过期/);
      assert.equal(scheduleCount(env), 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("start_date=今天 / 明天：正常创建，物化出 occurrence 且 next_run_at 非空（不回归）", () => {
    const env = makeTestEnv();
    try {
      for (const offset of [0, 1]) {
        const created = createSchedule(
          env.db,
          "default",
          onceInput({ title: `一次性${offset}`, startDate: day(offset) }),
        );
        const rows = occurrenceRows(env, created.id);
        assert.ok(rows.length >= 1, `start_date=day(${offset}) 必须物化出提醒行`);
        assert.equal(rows[0]?.status, "pending");
        assert.notEqual(
          getSchedule(env.db, "default", created.id)?.next_run_at,
          null,
          `start_date=day(${offset}) 的 next_run_at 不得为 NULL`,
        );
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("昨天起的重复系列（每天/每周）：不受影响，照常创建并物化", () => {
    const env = makeTestEnv();
    try {
      const daily = createSchedule(
        env.db,
        "default",
        onceInput({ title: "每天", recurrence: { freq: "daily", interval: 1 } }),
      );
      const weekly = createSchedule(
        env.db,
        "default",
        onceInput({ title: "每周", recurrence: { freq: "weekly", interval: 1 } }),
      );
      for (const row of [daily, weekly]) {
        assert.ok(occurrenceRows(env, row.id).length >= 1, `${row.title} 必须照常物化`);
        assert.notEqual(getSchedule(env.db, "default", row.id)?.next_run_at, null);
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update 会动物化：过期一次性 + 已有 pending → 明确报错，pending 行原样保留", () => {
    const env = makeTestEnv();
    try {
      // 先按合法契约建（今天），再改库推到昨天，得到「过期一次性 + 已有 pending」
      const created = createSchedule(env.db, "default", onceInput({ startDate: day(0) }));
      makeExpired(env, created.id);
      const before = occurrenceRows(env, created.id);
      assert.equal(before.length, 1, "前置：应恰好有一条待发提醒");
      assert.equal(before[0]?.status, "pending");

      assert.throws(
        () => updateSchedule(env.db, "default", created.id, { time: "10:00" }),
        /已过期/,
        "会删 pending 行的更新必须明确 fail，不能静默丢掉唯一待发提醒",
      );
      assert.deepEqual(
        occurrenceRows(env, created.id),
        before,
        "报错后唯一待发提醒必须原样保留（未被删、未被改写）",
      );
      assert.equal(getSchedule(env.db, "default", created.id)?.time, "09:00", "报错时不得改库");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update 不动物化（只改标题）：过期一次性 + pending 提醒不阻断、不丢弃", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", onceInput({ startDate: day(0) }));
      makeExpired(env, created.id);
      const before = occurrenceRows(env, created.id);

      const updated = updateSchedule(env.db, "default", created.id, { title: "改个名字" });
      assert.equal(updated.title, "改个名字");
      assert.deepEqual(
        occurrenceRows(env, created.id),
        before,
        "无关 patch 不得删掉既有 pending 提醒",
      );
      assert.equal(updated.next_run_at, before[0]?.due_at, "next_run_at 仍指向该提醒");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update 把过期日期改成明天：修复路径可用（守卫只拦「仍是过期一次性」的写入）", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", onceInput({ startDate: day(0) }));
      makeExpired(env, created.id);
      const updated = updateSchedule(env.db, "default", created.id, { startDate: day(1) });
      assert.equal(updated.start_date, day(1));
      assert.ok(occurrenceRows(env, created.id).length >= 1, "改到明天后必须重新物化出提醒");
      assert.notEqual(updated.next_run_at, null);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update 置终态 done：过期一次性日程仍可收尾（不被守卫误拦）", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", onceInput({ startDate: day(0) }));
      makeExpired(env, created.id);
      const updated = updateSchedule(env.db, "default", created.id, { status: "done" });
      assert.equal(updated.status, "done", "用户显式收尾必须放行，不能只剩 delete 一条路");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
