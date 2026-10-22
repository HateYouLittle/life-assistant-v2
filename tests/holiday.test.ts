import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  dayType,
  ensureYears,
  fetchYearPayload,
  holidayPeriods,
  holidayYearsReady,
  importYear,
  nextHolidayPeriod,
  requiredYears,
  validateYearPayload,
  type HolidayYearPayload,
} from "../src/core/holiday.js";
import { holidayTool } from "../src/modules/holiday/index.js";
import { TZ, todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/** 2026 年合成数据：7 个节日齐全、32 天放假、4 天周末调休 */
function payload2026(): HolidayYearPayload {
  const days: HolidayYearPayload["days"] = [];
  const off = (name: string, dates: string[]) => {
    dates.forEach((date) => {
      days.push({ name, date, isOffDay: true });
    });
  };
  const work = (dates: string[]) => {
    dates.forEach((date) => {
      days.push({ name: "调休", date, isOffDay: false });
    });
  };
  off("元旦", ["2026-01-01", "2026-01-02", "2026-01-03"]);
  off("春节", [
    "2026-02-15",
    "2026-02-16",
    "2026-02-17",
    "2026-02-18",
    "2026-02-19",
    "2026-02-20",
    "2026-02-21",
  ]);
  off("清明节", ["2026-04-04", "2026-04-05", "2026-04-06"]);
  off("劳动节", ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"]);
  off("端午节", ["2026-06-19", "2026-06-20", "2026-06-21"]);
  off("中秋节", ["2026-09-25", "2026-09-26", "2026-09-27"]);
  off("国庆节", [
    "2026-10-01",
    "2026-10-02",
    "2026-10-03",
    "2026-10-04",
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
  ]);
  work(["2026-02-14", "2026-02-28", "2026-04-26", "2026-10-10"]);
  return { year: 2026, days };
}

/**
 * 与 payload2026 同构、但年份可任取的合成数据：ensureYears 的用例不能写死年份
 * （否则测试在「未来年份」与「当前年份」之间随运行日期翻转结论）。
 */
function payloadForYear(year: number): HolidayYearPayload {
  const md = (month: number, day: number): string =>
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const days: HolidayYearPayload["days"] = [];
  const off = (name: string, dates: string[]): void => {
    for (const date of dates) days.push({ name, date, isOffDay: true });
  };
  const work = (dates: string[]): void => {
    for (const date of dates) days.push({ name: "调休", date, isOffDay: false });
  };
  off("元旦", [md(1, 1), md(1, 2), md(1, 3)]);
  off(
    "春节",
    [1, 2, 3, 4, 5, 6, 7].map((day) => md(2, 14 + day)),
  );
  off("清明节", [md(4, 4), md(4, 5), md(4, 6)]);
  off("劳动节", [md(5, 1), md(5, 2), md(5, 3), md(5, 4), md(5, 5)]);
  off("端午节", [md(6, 19), md(6, 20), md(6, 21)]);
  off("中秋节", [md(9, 25), md(9, 26), md(9, 27)]);
  off("国庆节", [
    md(10, 1),
    md(10, 2),
    md(10, 3),
    md(10, 4),
    md(10, 5),
    md(10, 6),
    md(10, 7),
    md(10, 8),
  ]);
  work([md(2, 28), md(4, 26), md(10, 10)]);
  return { year, days };
}

describe("节假日数据校验", () => {
  it("合成 2026 年数据通过校验", () => {
    assert.deepEqual(validateYearPayload(payload2026()), []);
  });

  it("缺少节日报错", () => {
    const payload = payload2026();
    payload.days = payload.days.filter((d) => d.name !== "春节");
    const errors = validateYearPayload(payload);
    assert.ok(errors.some((e) => e.includes("春节")));
  });

  it("国庆与中秋合并命名（数据源真实格式，2025/2028）不误判为缺少节日", () => {
    const payload = payload2026();
    for (const day of payload.days) {
      if (day.name === "中秋节" || day.name === "国庆节") day.name = "国庆节、中秋节";
    }
    assert.deepEqual(validateYearPayload(payload), []);
  });

  it("调休上班日允许非周末（上游真实格式：2020-02-03 周一为疫情顺延后的复工日）", () => {
    const payload = payload2026();
    payload.days.push({ name: "调休", date: "2026-03-02", isOffDay: false }); // 周一
    assert.deepEqual(
      validateYearPayload(payload),
      [],
      "非周末的上班日不应让整年数据被拒收（否则该年日程整年暂停）",
    );
  });

  it("放假天数超出合理范围报错", () => {
    const payload = payload2026();
    for (let day = 5; day <= 20; day++) {
      payload.days.push({
        name: "元旦",
        date: `2026-11-${String(day).padStart(2, "0")}`,
        isOffDay: true,
      });
    }
    const errors = validateYearPayload(payload);
    assert.ok(errors.some((e) => e.includes("超出合理范围")));
  });

  it("重复日期 / 非真实日期报错", () => {
    const payload = payload2026();
    payload.days.push({ name: "元旦", date: "2026-01-01", isOffDay: true });
    payload.days.push({ name: "元旦", date: "2026-02-30", isOffDay: true });
    const errors = validateYearPayload(payload);
    assert.ok(errors.some((e) => e.includes("重复")));
    assert.ok(errors.some((e) => e.includes("真实日历日")));
  });

  it("接受上一年 12 月的跨年日期（上游按假期归档，2023 年真实格式）", () => {
    // 真实 2023.json 声明 year=2023 却含 2022-12-31（元旦假期跨年）。
    // 此前要求 dt.year === year，导致整年数据被拒、整年零行导入。
    const payload = payload2026();
    payload.days.push({ name: "元旦", date: "2025-12-31", isOffDay: true });
    assert.deepEqual(validateYearPayload(payload), []);
  });

  it("仍拒绝本年度之外且非上一年 12 月的日期", () => {
    const payload = payload2026();
    payload.days.push({ name: "元旦", date: "2025-11-30", isOffDay: true });
    payload.days.push({ name: "元旦", date: "2027-01-02", isOffDay: true });
    const errors = validateYearPayload(payload);
    assert.ok(errors.some((e) => e.includes("2025-11-30")));
    assert.ok(errors.some((e) => e.includes("2027-01-02")));
  });

  it("2023 年真实上游数据现在能通过校验（回归：整年拒收）", () => {
    // 该年份真实数据含跨年元旦 2022-12-31，且 34 天放假 / 2 天调休。
    const payload: HolidayYearPayload = {
      year: 2023,
      days: [
        { name: "元旦", date: "2022-12-31", isOffDay: true },
        { name: "元旦", date: "2023-01-01", isOffDay: true },
        { name: "元旦", date: "2023-01-02", isOffDay: true },
      ],
    };
    // 补齐 7 个节日与足够的放假天数，模拟真实文件规模
    const off = (name: string, dates: string[]) => {
      for (const date of dates) payload.days.push({ name, date, isOffDay: true });
    };
    off("春节", [
      "2023-01-21",
      "2023-01-22",
      "2023-01-23",
      "2023-01-24",
      "2023-01-25",
      "2023-01-26",
      "2023-01-27",
    ]);
    off("清明节", ["2023-04-05"]);
    off("劳动节", ["2023-04-29", "2023-04-30", "2023-05-01", "2023-05-02", "2023-05-03"]);
    off("端午节", ["2023-06-22", "2023-06-23", "2023-06-24"]);
    off("中秋节、国庆节", [
      "2023-09-29",
      "2023-09-30",
      "2023-10-01",
      "2023-10-02",
      "2023-10-03",
      "2023-10-04",
      "2023-10-05",
      "2023-10-06",
    ]);
    for (const date of [
      "2023-01-28",
      "2023-01-29",
      "2023-04-23",
      "2023-05-06",
      "2023-06-25",
      "2023-10-07",
      "2023-10-08",
    ]) {
      payload.days.push({ name: "调休", date, isOffDay: false });
    }
    assert.deepEqual(validateYearPayload(payload), []);
  });
});

describe("节假日跨年条目归属", () => {
  /** 2026 的元旦假期延伸到 2025-12-31；2025 年度文件里同一天也是元旦 */
  const y2026WithCrossYear = (): HolidayYearPayload => {
    const p = payload2026();
    p.days.push({ name: "元旦", date: "2025-12-31", isOffDay: true });
    return p;
  };
  const y2025 = (): HolidayYearPayload => ({
    year: 2025,
    days: [
      { name: "元旦(2025文件)", date: "2025-12-31", isOffDay: true },
      ...Array.from({ length: 22 }, (_, i) => ({
        name: "元旦",
        date: `2025-01-${String(i + 1).padStart(2, "0")}`,
        isOffDay: true,
      })),
    ],
  });

  const crossYearRow = (env: ReturnType<typeof makeTestEnv>) =>
    env.db
      .prepare("SELECT year, day_type, name FROM cn_holiday_days WHERE date = '2025-12-31'")
      .get() as { year: number; day_type: string; name: string } | undefined;

  /** 清空节假日表，便于在同一测试进程内换顺序重放（initRuntime 每进程只能调用一次） */
  const resetHolidayTables = (env: ReturnType<typeof makeTestEnv>) => {
    env.db.prepare("DELETE FROM cn_holiday_days").run();
    env.db.prepare("DELETE FROM cn_holiday_years").run();
  };

  it("同名假期（两年国庆节）的调休日不会互相串台", () => {
    const env = makeTestEnv();
    try {
      const nationalDay = (year: number, workdayDates: string[]): HolidayYearPayload => ({
        year,
        days: [
          ...Array.from({ length: 7 }, (_, i) => ({
            name: "国庆节",
            date: `${year}-10-${String(i + 1).padStart(2, "0")}`,
            isOffDay: true,
          })),
          ...workdayDates.map((date) => ({ name: "国庆节", date, isOffDay: false })),
        ],
      });
      importYear(env.db, nationalDay(2026, ["2026-09-27", "2026-10-10"]), "test");
      importYear(env.db, nationalDay(2027, ["2027-09-26", "2027-10-09"]), "test");

      const periods = holidayPeriods(env.db);
      const p2026 = periods.find((p) => p.start === "2026-10-01");
      const p2027 = periods.find((p) => p.start === "2027-10-01");
      // 只按假期名匹配时，两年的「国庆节」共享 token，2027 的调休日会被算进 2026 的提醒里
      assert.deepEqual(p2026?.workdays, ["2026-09-27", "2026-10-10"]);
      assert.deepEqual(p2027?.workdays, ["2027-09-26", "2027-10-09"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨年条目与导入顺序无关（结果确定）", () => {
    const env = makeTestEnv();
    try {
      importYear(env.db, y2026WithCrossYear(), "test");
      importYear(env.db, y2025(), "test");
      const first = crossYearRow(env);

      resetHolidayTables(env);
      importYear(env.db, y2025(), "test");
      importYear(env.db, y2026WithCrossYear(), "test");
      const second = crossYearRow(env);

      assert.ok(first !== undefined && second !== undefined, "两种顺序都应写入 2025-12-31");
      assert.deepEqual(first, second, "同一日期的归属不能依赖导入顺序");
      assert.equal(first.day_type, "holiday", "2025-12-31 应被识别为休息日");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨年条目仍可查询，且不产生重复行", () => {
    const env = makeTestEnv();
    try {
      importYear(env.db, y2025(), "test");
      importYear(env.db, y2026WithCrossYear(), "test");
      const rows = env.db
        .prepare("SELECT COUNT(*) AS n FROM cn_holiday_days WHERE date = '2025-12-31'")
        .get() as { n: number };
      assert.equal(rows.n, 1, "同一日期在表中只能有一行");
      assert.equal(dayType(env.db, "2025-12-31"), "holiday");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("节假日导入与查询", () => {
  it("导入后可分类，重复导入整年替换", () => {
    const env = makeTestEnv();
    try {
      assert.equal(importYear(env.db, payload2026(), "test"), 36);
      assert.equal(dayType(env.db, "2026-01-01"), "holiday");
      assert.equal(dayType(env.db, "2026-02-14"), "workday");
      assert.equal(dayType(env.db, "2026-03-15"), "weekend", "年份就绪时未命中表按星期兜底");
      assert.deepEqual(holidayYearsReady(env.db), [2026]);

      const smaller = payload2026();
      smaller.days = smaller.days.filter((d) => d.date < "2026-02-01");
      importYear(env.db, smaller, "test");
      assert.equal(
        dayType(env.db, "2026-02-14"),
        "weekend",
        "替换后旧数据应消失，按星期兜底为周末",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("nextHolidayPeriod 找到下一个假期与天数", () => {
    const env = makeTestEnv();
    try {
      importYear(env.db, payload2026(), "test");
      assert.deepEqual(nextHolidayPeriod(env.db, "2026-06-01"), {
        name: "端午节",
        start: "2026-06-19",
        end: "2026-06-21",
        days: 3,
        inProgress: false,
      });
      assert.deepEqual(nextHolidayPeriod(env.db, "2026-09-26"), {
        name: "中秋节",
        start: "2026-09-25",
        end: "2026-09-27",
        days: 3,
        inProgress: true,
      });
      assert.equal(nextHolidayPeriod(env.db, "2026-12-01"), null);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("nextHolidayPeriod 与 holidayPeriods 用同一套区间口径（段内名称不一致时不再各算一套）", () => {
    // 上游在国庆与中秋重叠的年份会给合并名（如「国庆节、中秋节」），且同一段内逐行可能不同。
    // 此前 nextHolidayPeriod 按「同名且相邻」回溯、holidayPeriods 按「日期相邻」分段，
    // 两者会给出不同的起止与天数。
    const env = makeTestEnv();
    try {
      importYear(
        env.db,
        {
          year: 2026,
          days: [
            { name: "国庆节", date: "2026-10-01", isOffDay: true },
            { name: "国庆节", date: "2026-10-02", isOffDay: true },
            { name: "国庆节", date: "2026-10-03", isOffDay: true },
            { name: "国庆节、中秋节", date: "2026-10-04", isOffDay: true },
            { name: "国庆节、中秋节", date: "2026-10-05", isOffDay: true },
          ],
        },
        "test",
      );

      const periods = holidayPeriods(env.db);
      assert.equal(periods.length, 1, "日期相邻即为同一段");
      const next = nextHolidayPeriod(env.db, "2026-09-30");
      assert.deepEqual(
        { start: next?.start, end: next?.end, days: next?.days },
        { start: periods[0]?.start, end: periods[0]?.end, days: periods[0]?.days },
        "两个入口必须给出同一段区间",
      );
      assert.deepEqual(
        { name: next?.name, start: next?.start, end: next?.end, days: next?.days },
        { name: "国庆节", start: "2026-10-01", end: "2026-10-05", days: 5 },
        "段名取众数，天数按整段算",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("节假日抓取", () => {
  it("ensureYears：成功导入、ready 跳过、未来年份 404 记 pending 且 6h 冷却", async () => {
    const env = makeTestEnv();
    try {
      const currentYear = Number(todayIso().slice(0, 4));
      const futureYear = currentYear + 1;
      let futureCalls = 0;
      const fetcher = async (url: string): Promise<unknown> => {
        if (url.includes(String(currentYear))) return payloadForYear(currentYear);
        futureCalls += 1;
        throw new Error("HTTP 404");
      };
      const first = await ensureYears(env.db, [currentYear], fetcher);
      assert.deepEqual(first.updated, [currentYear]);

      const second = await ensureYears(env.db, [currentYear], fetcher);
      assert.deepEqual(second.updated, []);
      assert.deepEqual(second.skipped, [currentYear]);

      // 下一年数据尚未发布（404）：这是 pending，不是失败（旧实现会在这里报 1 条 failed）
      const missing = await ensureYears(env.db, [futureYear], fetcher);
      assert.deepEqual(missing.failed, [], "未来年份尚未发布不算失败");
      const meta = env.db
        .prepare("SELECT status FROM cn_holiday_years WHERE year = ?")
        .get(futureYear) as { status: string };
      assert.equal(meta.status, "pending");

      const cooldown = await ensureYears(env.db, [futureYear], fetcher);
      assert.deepEqual(cooldown.skipped, [futureYear], "6 小时冷却内不重试（含 pending）");
      assert.equal(futureCalls, 2, "两个候选 URL 各尝试一次后进入冷却");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("并发 ensureYears 同一年只抓一次：失败回写不得覆盖已就绪状态", async () => {
    const env = makeTestEnv();
    try {
      let calls = 0;
      const slowOk = async (): Promise<unknown> => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return payload2026();
      };
      const [a, b] = await Promise.all([
        ensureYears(env.db, [2026], slowOk),
        ensureYears(env.db, [2026], slowOk),
      ]);
      assert.equal(calls, 1, "同一年在途时第二次调用必须跳过，不能重复抓取");
      assert.equal(a.updated.length + b.updated.length, 1);
      assert.equal(a.skipped.length + b.skipped.length, 1);

      // 关键：数据其实可用时状态必须停在 ready（过去失败回写会把它改回 failed，
      // 于是 dayType 返回 unknown，所有 workday/holiday 过滤的日程集体暂停）
      const meta = env.db
        .prepare("SELECT status FROM cn_holiday_years WHERE year = 2026")
        .get() as { status: string };
      assert.equal(meta.status, "ready");
      assert.deepEqual(holidayYearsReady(env.db), [2026]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("校验失败的数据不入库并记录错误", async () => {
    const env = makeTestEnv();
    try {
      const bad = payload2026();
      bad.days = bad.days.filter((d) => d.name !== "春节");
      const fetcher = async (): Promise<unknown> => bad;
      const result = await ensureYears(env.db, [2026], fetcher);
      assert.equal(result.failed.length, 1);
      assert.deepEqual(holidayYearsReady(env.db), []);
      const meta = env.db
        .prepare("SELECT status, last_error FROM cn_holiday_years WHERE year = 2026")
        .get() as {
        status: string;
        last_error: string;
      };
      assert.equal(meta.status, "failed");
      assert.match(meta.last_error, /缺少节日/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("10 月起需要下一年数据", () => {
    assert.deepEqual(requiredYears("2026-09-30"), [2026]);
    assert.deepEqual(requiredYears("2026-10-01"), [2026, 2027]);
  });

  it("CDN 返回错配年份时拒绝导入（不写成「请求年成功」）", async () => {
    const env = makeTestEnv();
    try {
      // 请求 2027，上游却给了 2026 的文件
      const fetcher = async (): Promise<unknown> => payload2026();
      const result = await ensureYears(env.db, [2027], fetcher);
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0] ?? "", /错配/);
      assert.deepEqual(holidayYearsReady(env.db), [], "错配年份不得标记为 ready");
      const meta = env.db.prepare("SELECT year FROM cn_holiday_years WHERE year = 2027").get();
      assert.ok(meta !== undefined, "失败也要留下记录，避免静默重试");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("fetchYearPayload 在两个源都失败时抛错", async () => {
    await assert.rejects(
      () =>
        fetchYearPayload(2099, async () => {
          throw new Error("HTTP 404");
        }),
      /抓取失败/,
    );
  });
});

describe("holiday 工具：日期校验", () => {
  it("拒绝不存在的日历日，而不是误报为工作日", async () => {
    const env = makeTestEnv();
    try {
      importYear(
        env.db,
        { year: 2026, days: [{ name: "元旦", date: "2026-01-01", isOffDay: true }] },
        "test",
      );
      const ctx = {
        profileId: "default",
        db: env.db,
        config: env.config,
        services: {
          publishProfile: async () => ({ id: "x", deduped: false }),
          publishGlobal: async () => ({ materialized: 0 }),
        },
      };
      // DATE_RE 只校验格式：此前 2026-02-30 的 weekday 为 NaN，被当成「上班日（工作日）」
      const bad = await holidayTool({ view: "is_workday", date: "2026-02-30" }, ctx);
      assert.equal(bad.isError, true);
      assert.match(bad.content[0]?.text ?? "", /真实存在/);

      const good = await holidayTool({ view: "is_workday", date: "2026-01-01" }, ctx);
      assert.equal(good.isError, undefined);
      assert.match(good.content[0]?.text ?? "", /休息日/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday 工具：view=month 的数据覆盖口径（B5）", () => {
  function toolCtx(env: ReturnType<typeof makeTestEnv>) {
    return {
      profileId: "default",
      db: env.db,
      config: env.config,
      services: {
        publishProfile: async () => ({ id: "x", deduped: false }),
        publishGlobal: async () => ({ materialized: 0 }),
      },
    };
  }

  it("年份数据未就绪：返回「未知」而不是「当月无安排」，且不猜测", async () => {
    const env = makeTestEnv();
    try {
      const ctx = toolCtx(env);
      const result = await holidayTool({ view: "month", month: "2026-10" }, ctx);
      assert.equal(result.isError, undefined);
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
        安排: string;
        数据覆盖年份: number[];
      };
      assert.match(payload.安排, /未知（2026 年节假日数据未就绪/);
      assert.doesNotMatch(
        payload.安排,
        /当月无法定节假日/,
        "数据未就绪时不能给出「当月没有安排」的确定性结论",
      );
      assert.deepEqual(payload.数据覆盖年份, []);

      // 只导入了相邻年份（2025）时，2026 仍是未知
      importYear(
        env.db,
        { year: 2025, days: [{ name: "元旦", date: "2025-01-01", isOffDay: true }] },
        "test",
      );
      const again = JSON.parse(
        (await holidayTool({ view: "month", month: "2026-10" }, ctx)).content[0]?.text ?? "{}",
      ) as { 安排: string };
      assert.match(again.安排, /未知（2026 年节假日数据未就绪/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("年份就绪：有安排时给表格，没有安排的月份才说「当月无法定节假日/调休安排」", async () => {
    const env = makeTestEnv();
    try {
      importYear(env.db, payload2026(), "test");
      const ctx = toolCtx(env);
      const october = JSON.parse(
        (await holidayTool({ view: "month", month: "2026-10" }, ctx)).content[0]?.text ?? "{}",
      ) as { 安排: { rows: string[][] } };
      assert.ok(Array.isArray(october.安排.rows), "10 月有国庆安排，应返回表格");
      assert.ok(october.安排.rows.some((row) => row[0] === "2026-10-01"));

      // 3 月没有任何法定节假日/调休
      const march = JSON.parse(
        (await holidayTool({ view: "month", month: "2026-03" }, ctx)).content[0]?.text ?? "{}",
      ) as { 安排: string };
      assert.equal(march.安排, "当月无法定节假日/调休安排");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("月份越界（2026-13）直接报错，不静默返回「无安排」", async () => {
    const env = makeTestEnv();
    try {
      importYear(env.db, payload2026(), "test");
      const result = await holidayTool({ view: "month", month: "2026-13" }, toolCtx(env));
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /月份不合法/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨年日期：年份元数据未就绪但月内已有行时照常出表（M4，与 dayType 口径一致）", async () => {
    const env = makeTestEnv();
    try {
      // 真实数据同形态：2027 年度文件里带一条跨年行的 2026-12-31（2023.json 含 2022-12-31）。
      // 2026 年元数据没有 ready，但该行已入库 —— is_workday 对 2026-12-31 给出确定答案，
      // month 不能反过来报「未知」。
      importYear(
        env.db,
        {
          year: 2027,
          days: [
            { name: "元旦", date: "2026-12-31", isOffDay: true },
            { name: "元旦", date: "2027-01-01", isOffDay: true },
          ],
        },
        "test",
      );
      const ctx = toolCtx(env);

      const december = JSON.parse(
        (await holidayTool({ view: "month", month: "2026-12" }, ctx)).content[0]?.text ?? "{}",
      ) as { 安排: { rows: string[][] } };
      assert.ok(Array.isArray(december.安排.rows), "有行的月份必须出表，不能因年份未 ready 报未知");
      assert.deepEqual(december.安排.rows[0]?.slice(0, 2), ["2026-12-31", "休息"]);

      // 同一年份里没有任何行的月份：仍按「年份未就绪」返回未知
      const november = JSON.parse(
        (await holidayTool({ view: "month", month: "2026-11" }, ctx)).content[0]?.text ?? "{}",
      ) as { 安排: string };
      assert.match(november.安排, /未知（2026 年节假日数据未就绪/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday 工具：view=next 的进行中标志", () => {
  function toolCtx(env: ReturnType<typeof makeTestEnv>) {
    return {
      profileId: "default",
      db: env.db,
      config: env.config,
      services: {
        publishProfile: async () => ({ id: "x", deduped: false }),
        publishGlobal: async () => ({ materialized: 0 }),
      },
    };
  }

  /** 在今天前后铺一段连续假期；offsets 为相对今天的日期偏移（均为假期日） */
  function seedHoliday(env: ReturnType<typeof makeTestEnv>, offsets: number[]): void {
    const today = todayIso();
    const ts = new Date().toISOString();
    const insert = env.db.prepare(
      "INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES (?, ?, 'holiday', '测试假期', 'test', ?)",
    );
    const years = new Set<number>();
    for (const offset of offsets) {
      // 本地日历日（Asia/Shanghai），与 nextHolidayPeriod 的 today 口径一致
      const date =
        DateTime.fromISO(today, { zone: TZ }).plus({ days: offset }).toISODate() ?? today;
      years.add(Number(date.slice(0, 4)));
      insert.run(date, Number(date.slice(0, 4)), ts);
    }
    const yearMeta = env.db.prepare(
      "INSERT INTO cn_holiday_years (year, status, source, fetched_at) VALUES (?, 'ready', 'test', ?)",
    );
    for (const year of years) yearMeta.run(year, ts);
  }

  it("假期进行中时输出「进行中: true」，不让用户以为假期还没开始", async () => {
    const env = makeTestEnv();
    try {
      seedHoliday(env, [-1, 0, 1]); // 昨天开始放假，今天正处假期中
      const out = await holidayTool({ view: "next" }, toolCtx(env));
      const parsed = JSON.parse(out.content[0]?.text ?? "{}") as {
        下一假期: string;
        进行中?: boolean;
      };
      assert.equal(parsed.下一假期, "测试假期");
      assert.equal(parsed.进行中, true, "今天在假期内，必须带上进行中标志");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("假期尚未开始时「进行中: false」", async () => {
    const env = makeTestEnv();
    try {
      seedHoliday(env, [1, 2]); // 明天才开始
      const out = await holidayTool({ view: "next" }, toolCtx(env));
      const parsed = JSON.parse(out.content[0]?.text ?? "{}") as { 进行中?: boolean };
      assert.equal(parsed.进行中, false);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
