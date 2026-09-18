import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { now } from "../src/time.js";
import {
  createSchedule,
  getSchedule,
  materializeSchedule,
  type ScheduleInput,
  type ScheduleRow,
} from "../src/modules/schedule/service.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/** 与 service.ts 的 NEAR_HORIZON_DAYS 一致；此处复刻以让断言独立于实现细节 */
const NEAR_HORIZON_DAYS = 62;
/** 与 service.ts 的 FAR_HORIZON_DAYS 一致：nextDate 的搜索上限 */
const FAR_HORIZON_DAYS = 400;

interface OccurrenceRow {
  occurrence_key: string;
  event_at: string;
  status: string;
}

function reload(env: TestEnv, id: string): ScheduleRow {
  return getSchedule(env.db, "default", id) as ScheduleRow;
}

function occurrences(env: TestEnv, id: string): OccurrenceRow[] {
  return env.db
    .prepare(
      "SELECT occurrence_key, event_at, status FROM occurrences WHERE schedule_id = ? ORDER BY event_at, occurrence_key",
    )
    .all(id) as unknown as OccurrenceRow[];
}

/** 与实现一致的事件计数口径：同一 event_at 的多个偏移只算一次，cancelled 不计 */
function eventCount(env: TestEnv, id: string): number {
  return (
    env.db
      .prepare(
        "SELECT COUNT(DISTINCT event_at) AS n FROM occurrences WHERE schedule_id = ? AND status != 'cancelled'",
      )
      .get(id) as { n: number }
  ).n;
}

function addSchedule(env: TestEnv, overrides: Partial<ScheduleInput>): ScheduleRow {
  return createSchedule(env.db, "default", {
    title: "首条豁免用例",
    kind: "birthday",
    calendar: "solar",
    startDate: now().plus({ days: 200 }).toISODate() as string,
    time: "09:00",
    allDay: true,
    recurrence: { freq: "yearly", interval: 1 },
    remindOffsets: [0],
    resendMinutes: 0,
    workdayFilter: "any",
    ...overrides,
  });
}

/** 模拟 daemon 每分钟 tick：每次都重新读取日程行 */
function tick(env: TestEnv, id: string, times: number): void {
  for (let i = 0; i < times; i++) materializeSchedule(env.db, reload(env, id));
}

describe("schedule 首条豁免：远期日程仍有下一条可见", () => {
  it("远期年度生日：物化出恰好 1 条越过近端地平线的 occurrence", () => {
    const env = makeTestEnv();
    try {
      const created = addSchedule(env, {});
      const rows = occurrences(env, created.id);
      assert.equal(eventCount(env, created.id), 1, "首条豁免应物化恰好 1 条事件");
      assert.equal(rows.length, 1);
      const only = rows[0] as OccurrenceRow;
      assert.ok(
        DateTime.fromISO(only.event_at) > now().plus({ days: NEAR_HORIZON_DAYS }),
        `豁免出的 occurrence 必须越过近端地平线，实际 ${only.event_at}`,
      );
      assert.notEqual(reload(env, created.id).next_run_at, null, "next_run_at 不得为 NULL");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("反向断言：紧接着连续物化 5 次仍只有 1 条（不 creep）", () => {
    const env = makeTestEnv();
    try {
      const created = addSchedule(env, {});
      assert.equal(eventCount(env, created.id), 1);
      tick(env, created.id, 5);
      assert.equal(eventCount(env, created.id), 1, "豁免不得每轮重新生效");
      assert.equal(occurrences(env, created.id).length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("远期一次性待办：物化出 1 条，且重复物化不再增长", () => {
    const env = makeTestEnv();
    try {
      const created = addSchedule(env, {
        title: "远期待办",
        kind: "todo",
        allDay: false,
        recurrence: null,
      });
      assert.equal(occurrences(env, created.id).length, 1);
      tick(env, created.id, 5);
      assert.equal(occurrences(env, created.id).length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("远期 daily 日程：单轮物化不得灌入多条，后续 tick 也不增长（拦「豁免每轮复活」）", () => {
    // 这条用例专门堵「资格判定被写成恒真」的错误实现：
    // 若豁免每轮都重新生效，单轮 i<10 的循环会把 now+200d 起的 10 个 daily 候选全部灌进来，
    // 之后每次 tick 又从最大 event_at 继续前推 —— 这里既卡单轮条数上界，也卡后续 tick 与基线严格相等。
    // 必须用 daily：yearly/一次性的下一个候选会越过 FAR_HORIZON_DAYS(=400)，
    // nextDate 直接返回 null，根本走不到 creep 分支，拦不住这类错误实现。
    const env = makeTestEnv();
    try {
      const created = addSchedule(env, {
        title: "远期每日",
        kind: "todo",
        allDay: false,
        startDate: now().plus({ days: 200 }).toISODate() as string,
        recurrence: { freq: "daily", interval: 1 },
        workdayFilter: "any",
      });

      tick(env, created.id, 1);
      const afterOne = occurrences(env, created.id).length;
      assert.ok(
        afterOne <= 2,
        `单轮物化最多补 1 条（豁免恒真会灌入多条并逼近 FAR_HORIZON），实际 ${afterOne}`,
      );

      tick(env, created.id, 5);
      const afterFive = occurrences(env, created.id).length;
      assert.equal(
        afterFive,
        afterOne,
        `后续 tick 必须与基线完全相等（堵缓慢增长），基线 ${afterOne}，实际 ${afterFive}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("豁免可重复生效但每次仍只有 1 条（标记已提醒后再物化）", () => {
    const env = makeTestEnv();
    try {
      // 用 monthly 而非 yearly：yearly 从 +200d 起的次年约 +565d，
      // 已越过 nextDate 的 FAR_HORIZON_DAYS(=400) 搜索上限而返回 null。
      const created = addSchedule(env, {
        title: "远期月度",
        kind: "anniversary",
        recurrence: { freq: "monthly", interval: 1 },
      });
      const first = occurrences(env, created.id);
      assert.equal(first.length, 1, "首条豁免先补出 1 条");

      env.db
        .prepare("UPDATE occurrences SET status = 'notified' WHERE schedule_id = ?")
        .run(created.id);
      materializeSchedule(env.db, reload(env, created.id));

      const after = occurrences(env, created.id);
      assert.equal(after.length, 2, "已提醒后豁免应再次生效，补出 1 条新的");
      const pending = after.filter((r) => r.status === "pending");
      assert.equal(pending.length, 1, "恰好 1 条新的 pending");
      const firstRow = first[0] as OccurrenceRow;
      const fresh = pending[0] as OccurrenceRow;
      assert.ok(DateTime.fromISO(fresh.event_at) > DateTime.fromISO(firstRow.event_at));
      assert.ok(DateTime.fromISO(fresh.event_at) > now().plus({ days: NEAR_HORIZON_DAYS }));
      assert.ok(DateTime.fromISO(fresh.event_at) <= now().plus({ days: FAR_HORIZON_DAYS }));

      tick(env, created.id, 5);
      assert.equal(occurrences(env, created.id).length, 2, "不得继续增长");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
