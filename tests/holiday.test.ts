import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  dayType,
  ensureYears,
  fetchYearPayload,
  holidayYearsReady,
  importYear,
  nextHolidayPeriod,
  requiredYears,
  validateYearPayload,
  type HolidayYearPayload,
} from "../src/core/holiday.js";
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
  off("春节", ["2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21"]);
  off("清明节", ["2026-04-04", "2026-04-05", "2026-04-06"]);
  off("劳动节", ["2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05"]);
  off("端午节", ["2026-06-19", "2026-06-20", "2026-06-21"]);
  off("中秋节", ["2026-09-25", "2026-09-26", "2026-09-27"]);
  off("国庆节", ["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08"]);
  work(["2026-02-14", "2026-02-28", "2026-04-26", "2026-10-10"]);
  return { year: 2026, days };
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

  it("调休上班日不是周末报错", () => {
    const payload = payload2026();
    payload.days.push({ name: "调休", date: "2026-03-02", isOffDay: false }); // 周一
    const errors = validateYearPayload(payload);
    assert.ok(errors.some((e) => e.includes("2026-03-02")));
  });

  it("放假天数超出合理范围报错", () => {
    const payload = payload2026();
    for (let day = 5; day <= 20; day++) {
      payload.days.push({ name: "元旦", date: `2026-11-${String(day).padStart(2, "0")}`, isOffDay: true });
    }
    const errors = validateYearPayload(payload);
    assert.ok(errors.some((e) => e.includes("超出合理范围")));
  });

  it("重复日期 / 非真实日期 / 跨年日期报错", () => {
    const payload = payload2026();
    payload.days.push({ name: "元旦", date: "2026-01-01", isOffDay: true });
    payload.days.push({ name: "元旦", date: "2026-02-30", isOffDay: true });
    payload.days.push({ name: "元旦", date: "2025-12-31", isOffDay: true });
    const errors = validateYearPayload(payload);
    assert.ok(errors.some((e) => e.includes("重复")));
    assert.ok(errors.some((e) => e.includes("真实日历日")));
    assert.ok(errors.some((e) => e.includes("不属于 2026")));
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
      assert.equal(dayType(env.db, "2026-02-14"), "weekend", "替换后旧数据应消失，按星期兜底为周末");
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
});

describe("节假日抓取", () => {
  it("ensureYears：成功导入、ready 跳过、失败冷却", async () => {
    const env = makeTestEnv();
    try {
      const fetcher = async (url: string): Promise<unknown> => {
        if (url.includes("2026")) return payload2026();
        throw new Error("HTTP 404");
      };
      const first = await ensureYears(env.db, [2026], fetcher);
      assert.deepEqual(first.updated, [2026]);

      const second = await ensureYears(env.db, [2026], fetcher);
      assert.deepEqual(second.updated, []);
      assert.deepEqual(second.skipped, [2026]);

      const missing = await ensureYears(env.db, [2027], fetcher);
      assert.equal(missing.failed.length, 1);

      const cooldown = await ensureYears(env.db, [2027], fetcher);
      assert.deepEqual(cooldown.skipped, [2027], "6 小时冷却内不重试");
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
      const meta = env.db.prepare("SELECT status, last_error FROM cn_holiday_years WHERE year = 2026").get() as {
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

  it("fetchYearPayload 在两个源都失败时抛错", async () => {
    await assert.rejects(
      () => fetchYearPayload(2099, async () => { throw new Error("HTTP 404"); }),
      /抓取失败/,
    );
  });
});
