import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { now } from "../src/time.js";
import { importYear } from "../src/core/holiday.js";
import {
  createSchedule,
  getSchedule,
  materializeSchedule,
  takeYearsNeedingBackfill,
  tickSchedules,
  type ScheduleRow,
} from "../src/modules/schedule/service.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/** 与 service.ts 的 NEAR_HORIZON_DAYS 对应；此处复刻以让断言独立于实现细节 */
const NEAR_HORIZON_DAYS = 62;
const HORIZON_TOLERANCE_DAYS = 1;

function envServices(env: TestEnv) {
  return {
    publishProfile: async (profileId: string, input: { kind: string }) => {
      env.published.push({ profileId, input: input as never });
      return { id: `n-${env.published.length}`, deduped: false };
    },
    publishGlobal: async () => ({ materialized: 0 }),
  };
}

/** 只写年份元数据，绝不发起网络请求 */
function setYearStatus(env: TestEnv, year: number, status: "pending" | "ready" | "failed"): void {
  const ts = new Date().toISOString();
  env.db
    .prepare(
      `INSERT INTO cn_holiday_years (year, status, source, fetched_at, last_attempt_at, last_error)
       VALUES (?, ?, 'test', ?, NULL, NULL)
       ON CONFLICT (year) DO UPDATE SET status = excluded.status, source = excluded.source,
         fetched_at = excluded.fetched_at, last_attempt_at = NULL, last_error = NULL`,
    )
    .run(year, status, ts);
}

function reload(env: TestEnv, id: string): ScheduleRow {
  return getSchedule(env.db, "default", id) as ScheduleRow;
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

function addWorkdayDaily(env: TestEnv, startDate: string): ScheduleRow {
  return createSchedule(env.db, "default", {
    title: "每日巡检",
    kind: "todo",
    calendar: "solar",
    startDate,
    time: "09:00",
    allDay: false,
    recurrence: { freq: "daily", interval: 1 },
    remindOffsets: [0],
    resendMinutes: 0,
    workdayFilter: "workday",
  });
}

describe("schedule 物化前瞻（NEAR_HORIZON_DAYS）", () => {
  it("workday daily：反复物化也不越过近端地平线，且不漏掉窗口内的工作日", () => {
    const env = makeTestEnv();
    try {
      // 当年 + 下一年都标为 ready（无具体节假日行 → 按星期兜底），
      // 确保窗口内不会因数据缺失提前暂停，从而真正检验地平线约束本身。
      const year = now().year;
      setYearStatus(env, year, "ready");
      setYearStatus(env, year + 1, "ready");

      const created = addWorkdayDaily(env, now().minus({ days: 3 }).toISODate() as string);
      // 模拟 daemon 每分钟 tick：旧实现每轮都会把游标推得更远，直到撞上未覆盖年份
      for (let i = 0; i < 300; i++) materializeSchedule(env.db, reload(env, created.id));

      const max = env.db
        .prepare("SELECT MAX(event_at) AS m FROM occurrences WHERE schedule_id = ?")
        .get(created.id) as { m: string | null };
      assert.ok(max.m !== null, "应物化出 occurrence");
      const maxIso = max.m as string;
      const horizon = now().plus({ days: NEAR_HORIZON_DAYS + HORIZON_TOLERANCE_DAYS });
      assert.ok(
        DateTime.fromISO(maxIso) <= horizon,
        `最大 event_at ${maxIso} 越过物化前瞻 ${horizon.toUTC().toISO()}`,
      );

      const keys = occurrenceKeys(env, created.id);
      const missing: string[] = [];
      for (let offset = 1; offset <= 40; offset++) {
        const d = now().plus({ days: offset });
        if (d.weekday > 5) continue;
        const key = `${d.toISODate()}T09:00#0`;
        if (!keys.includes(key)) missing.push(key);
      }
      assert.deepEqual(missing, [], "62 天窗口内的工作日事件不得被漏掉");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未就绪年份：不物化该日期、登记待补齐、tick 不抛错，且失败后 6h 冷却内不重试", async () => {
    const env = makeTestEnv();
    try {
      takeYearsNeedingBackfill(); // 清掉同文件内前序用例的残留登记
      const year = now().year;
      const created = addWorkdayDaily(env, now().toISODate() as string);
      assert.equal(occurrenceKeys(env, created.id).length, 0, "数据未就绪应暂停物化");
      assert.deepEqual(takeYearsNeedingBackfill(), [year], "未就绪年份应被登记为待补齐");

      let fetches = 0;
      const offline = async (): Promise<unknown> => {
        fetches += 1;
        throw new Error("offline-in-test");
      };
      await tickSchedules(now(), envServices(env), env.db, offline);
      assert.equal(fetches, 2, "一次 ensureYears 会依次尝试两个上游地址");
      const meta = env.db
        .prepare("SELECT status, last_error FROM cn_holiday_years WHERE year = ?")
        .get(year) as { status: string; last_error: string };
      assert.equal(meta.status, "failed", "抓取失败应记为 failed 以启动冷却");
      assert.match(meta.last_error, /offline-in-test/);
      assert.equal(occurrenceKeys(env, created.id).length, 0, "tick 不应物化未就绪年份");

      await tickSchedules(now(), envServices(env), env.db, offline);
      assert.equal(fetches, 2, "6h 冷却内不得再次请求上游");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("登记年份的数据就绪后，物化继续推进", () => {
    const env = makeTestEnv();
    try {
      takeYearsNeedingBackfill();
      const year = now().year;
      const created = addWorkdayDaily(env, now().toISODate() as string);
      assert.equal(occurrenceKeys(env, created.id).length, 0, "先暂停");

      importYear(
        env.db,
        { year, days: [{ name: "调休", date: now().toISODate() as string, isOffDay: false }] },
        "test",
      );
      materializeSchedule(env.db, reload(env, created.id));
      assert.ok(occurrenceKeys(env, created.id).length > 0, "数据就绪后应继续物化");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
