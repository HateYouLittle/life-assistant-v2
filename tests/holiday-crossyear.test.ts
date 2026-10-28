import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DateTime } from "luxon";
import { dayType, holidayLookupYears, importYear, inCrossYearWindow } from "../src/core/holiday.js";
import {
  createSchedule,
  getSchedule,
  recheckCrossYearOccurrences,
  resetCrossYearRecheck,
  type ScheduleRow,
  takeYearsNeedingBackfill,
  tickSchedules,
} from "../src/modules/schedule/service.js";
import { TZ } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * P2-5 / C-06：12 月下旬在次年假日数据就绪前按星期兜底分类。
 *
 * 上游 holiday-cn 按**假期**归档，元旦假期（含 12-31 起的调休补班）放在**下一年度**文件里
 * （实测 2019.json 含 2018-12-29「元旦」补班 isOffDay=false）。旧 dayType 只看「该日期所属
 * 年份 ready」就按星期兜底：物化前瞻 62 天，从 10 月下旬起就会把 12-26/12-27 这类日期
 * 按 weekend 物化 —— 「仅工作日」漏提醒 / 「仅节假日」误提醒；次年文件到达后已物化行
 * 不重判，错就一直留着。
 *
 * 新契约：① 跨年区间（12-25~12-31）的所需年度里有一个未 ready → unknown（暂停而非猜），
 * 且登记**下一年度**去补齐（否则会去补一个已 ready 的年份，日程被永久暂停）；
 * ② 数据就绪后按新 dayType 复核 pending 行：误判的作废、漏掉的回退重物化补回。
 *
 * 有牙齿：① 还原 dayType 的跨年判定 → 「未知」与「不物化误判日期」用例变红；
 * ② 登记改成只登记日期所属年份 → takeYearsNeedingBackfill 断言变红；
 * ③ 去掉复核调用 → 「误判行被作废 / 漏掉日期被补回」用例变红。
 * 时钟用 node:test mock timers 冻结；绝不打真实外网（数据一律直接 importYear 入库）。
 */

function freeze(t: TestContext, date: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(`${date}T09:00:00+08:00`) });
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

function envServices(env: TestEnv) {
  return {
    publishProfile: async (profileId: string, input: { kind: string }) => {
      env.published.push({ profileId, input: input as never });
      return { id: `n-${env.published.length}`, deduped: false };
    },
    publishGlobal: async () => ({ materialized: 0 }),
  };
}

function addFilteredDaily(env: TestEnv, filter: "workday" | "holiday", startDate: string) {
  return createSchedule(env.db, "default", {
    title: filter === "workday" ? "仅工作日巡检" : "仅节假日值班",
    note: null,
    kind: "todo",
    calendar: "solar",
    startDate,
    lunarMonth: null,
    lunarDay: null,
    leapPolicy: "follow",
    lunarClamp: true,
    time: "18:00",
    allDay: false,
    recurrence: { freq: "daily", interval: 1 },
    remindOffsets: [0],
    resendMinutes: 0,
    escalation: null,
    workdayFilter: filter,
  });
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

function occurrenceStatus(env: TestEnv, id: string, key: string): string | undefined {
  return (
    env.db
      .prepare("SELECT status FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
      .get(id, key) as { status: string } | undefined
  )?.status;
}

function reload(env: TestEnv, id: string): ScheduleRow {
  return getSchedule(env.db, "default", id) as ScheduleRow;
}

describe("P2-5 dayType：跨年区间的权威数据在下一年度文件里", () => {
  it("12-25~12-31 需要下一年度 ready；未就绪返回 unknown（不按星期猜）", () => {
    const env = makeTestEnv();
    try {
      setYearStatus(env, 2026, "ready");
      // 2026-12-24（周四）不在跨年区间：只看本年度，照常按星期兜底
      assert.equal(dayType(env.db, "2026-12-24"), "weekday");
      assert.equal(dayType(env.db, "2026-12-19"), "weekend", "12-19 是周六，仍按星期兜底");
      // 2026-12-26（周六）在跨年区间：2027 未就绪 → unknown
      assert.equal(
        dayType(env.db, "2026-12-26"),
        "unknown",
        "元旦调休可能落在这天，未拿到下一年度文件前必须暂停而不是猜成周末",
      );
      assert.equal(dayType(env.db, "2026-12-25"), "unknown", "区间下界 12-25 也算跨年");
      assert.equal(dayType(env.db, "2026-12-31"), "unknown", "区间上界 12-31 也算跨年");

      // 下一年度就绪后恢复按星期兜底（此时没有权威行，说明该年确实没有调休）
      setYearStatus(env, 2027, "ready");
      assert.equal(dayType(env.db, "2026-12-26"), "weekend");
      assert.equal(dayType(env.db, "2026-12-25"), "weekday", "12-25 是周五");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("命中权威行时不受下一年度状态影响（补班行优先）", () => {
    const env = makeTestEnv();
    try {
      setYearStatus(env, 2026, "ready");
      // 2027 未就绪，但 2026-12-26 已有权威补班行（真实数据里由 2027 年度文件带来）
      env.db
        .prepare(
          "INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES (?, 2027, 'workday', '元旦', 'test', ?)",
        )
        .run("2026-12-26", new Date().toISOString());
      assert.equal(dayType(env.db, "2026-12-26"), "workday", "行命中优先于年份状态");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("holidayLookupYears / inCrossYearWindow：所需年度与区间边界", () => {
    assert.deepEqual(holidayLookupYears("2026-12-24"), [2026], "12-24 不在跨年区间");
    assert.deepEqual(holidayLookupYears("2026-12-25"), [2026, 2027]);
    assert.deepEqual(holidayLookupYears("2026-12-31"), [2026, 2027]);
    assert.deepEqual(holidayLookupYears("2027-01-01"), [2027], "元旦当天本身属 2027 年度文件");
    assert.equal(inCrossYearWindow("2026-12-25"), true);
    assert.equal(inCrossYearWindow("2026-12-24"), false);
  });
});

describe("P2-5 物化：跨年区间未就绪时暂停，且登记下一年度补齐", () => {
  it("仅节假日日程：12-26/12-27 不得按周末误物化；待补齐年份是下一年度（否则永久暂停）", (t) => {
    freeze(t, "2026-12-20");
    const env = makeTestEnv();
    try {
      takeYearsNeedingBackfill(); // 清掉同文件前序用例的残留登记
      setYearStatus(env, 2026, "ready");
      const created = addFilteredDaily(env, "holiday", "2026-12-20");
      const keys = occurrenceKeys(env, created.id);

      // 12-20（周日）命中 weekend → 物化；12-25（周五）unknown → 暂停
      assert.deepEqual(keys, ["2026-12-20T18:00#0"], `跨年区间必须暂停：${keys.join(", ")}`);
      assert.ok(
        !keys.some((key) => key.startsWith("2026-12-26") || key.startsWith("2026-12-27")),
        "12-26/12-27 在下一年度数据到达前不得按 weekend 误物化（旧行为会误提醒）",
      );
      assert.deepEqual(
        takeYearsNeedingBackfill(),
        [2027],
        "必须登记下一年度（只登记日期所属的 2026 会去补一个已 ready 的年份 → 永久暂停）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("仅工作日日程：补班日 12-26 在数据到达前保持暂停（宁可晚提醒也不错提醒）", async (t) => {
    freeze(t, "2026-12-20");
    const env = makeTestEnv();
    try {
      takeYearsNeedingBackfill();
      resetCrossYearRecheck();
      setYearStatus(env, 2026, "ready");
      const created = addFilteredDaily(env, "workday", "2026-12-20");
      const keys = occurrenceKeys(env, created.id);
      assert.ok(!keys.some((key) => key.startsWith("2026-12-25")), "12-25 之后一律暂停");
      assert.deepEqual(takeYearsNeedingBackfill(), [2027]);

      // 下一年度数据到达（12-26 是元旦调休补班）→ 暂停解除，物化出 12-26
      importYear(
        env.db,
        { year: 2027, days: [{ name: "元旦", date: "2026-12-26", isOffDay: false }] },
        "test",
      );
      await tickSchedules(
        DateTime.fromISO("2026-12-20T09:00:00", { zone: TZ }),
        envServices(env),
        env.db,
      );
      const after = occurrenceKeys(env, created.id);
      assert.ok(
        after.includes("2026-12-26T18:00#0"),
        `补班日必须补回（仅工作日日程漏提醒正是本缺陷）：${after.join(", ")}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("P2-5 复核：数据就绪后修正已物化的 pending 行", () => {
  it("仅节假日日程：误判为周末的 12-26 在权威补班行到达后作废（不误提醒、不重复）", (t) => {
    freeze(t, "2026-12-24");
    const env = makeTestEnv();
    try {
      setYearStatus(env, 2026, "ready");
      setYearStatus(env, 2027, "ready"); // 数据已就绪但还没有跨年行（旧实现据此按周末兜底）
      const created = addFilteredDaily(env, "holiday", "2026-12-20");
      const before = occurrenceKeys(env, created.id);
      assert.ok(
        before.includes("2026-12-26T18:00#0") && before.includes("2026-12-27T18:00#0"),
        `构造前提：12-26/12-27 已被兜底物化为「休息日」：${before.join(", ")}`,
      );

      // 权威数据到达：12-26 其实是元旦调休补班（isOffDay=false）
      importYear(
        env.db,
        { year: 2027, days: [{ name: "元旦", date: "2026-12-26", isOffDay: false }] },
        "test",
      );
      const touched = recheckCrossYearOccurrences(env.db, [2027]);
      assert.equal(touched, 1, "受影响的日程应被复核");

      assert.equal(
        occurrenceStatus(env, created.id, "2026-12-26T18:00#0"),
        "cancelled",
        "已物化的误判行必须作废，否则「仅节假日」会误提醒",
      );
      assert.equal(
        occurrenceStatus(env, created.id, "2026-12-27T18:00#0"),
        "pending",
        "仍是周末（12-27 是周日）的日期不受影响",
      );
      assert.deepEqual(
        occurrenceKeys(env, created.id),
        before,
        "复核只改状态，不得新增/删除行（不产生重复提醒）",
      );
      // 已作废的误判行不得复活
      assert.ok(
        !occurrenceKeys(env, created.id).some(
          (key) =>
            key.startsWith("2026-12-26") && occurrenceStatus(env, created.id, key) === "pending",
        ),
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("仅工作日日程：旧兜底漏掉的补班日 12-26 在数据到达后被回退重物化补回（tick 路径）", async (t) => {
    freeze(t, "2026-12-24");
    const env = makeTestEnv();
    try {
      resetCrossYearRecheck();
      setYearStatus(env, 2026, "ready");
      setYearStatus(env, 2027, "ready");
      const created = addFilteredDaily(env, "workday", "2026-12-20");
      assert.ok(
        !occurrenceKeys(env, created.id).some((key) => key.startsWith("2026-12-26")),
        "构造前提：旧兜底把 12-26（周六）跳过，游标已推过它",
      );

      importYear(
        env.db,
        { year: 2027, days: [{ name: "元旦", date: "2026-12-26", isOffDay: false }] },
        "test",
      );
      // 走 tickSchedules：普通物化轮次无法补回游标之后的日期，只有跨年复核会回退重物化
      await tickSchedules(
        DateTime.fromISO("2026-12-24T09:00:00", { zone: TZ }),
        envServices(env),
        env.db,
      );
      assert.equal(
        occurrenceStatus(env, created.id, "2026-12-26T18:00#0"),
        "pending",
        "补班日必须补回并保持 pending（仅工作日日程漏提醒是本缺陷的一半）",
      );
      const keys = occurrenceKeys(env, created.id);
      assert.equal(new Set(keys).size, keys.length, "回退重物化不得产生重复行（INSERT OR IGNORE）");
      // 复核后的日程仍可正常触发提醒（next_run_at 已重算）
      assert.notEqual(reload(env, created.id).next_run_at, null);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
