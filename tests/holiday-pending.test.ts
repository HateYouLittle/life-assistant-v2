import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HOLIDAY_PENDING_REASON,
  dayType,
  ensureYears,
  holidayYearsReady,
  type HolidayYearPayload,
} from "../src/core/holiday.js";
import { todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * P1-10：次年数据尚未发布应记 `pending` 而不是 `failed`。
 *
 * requiredYears() 自 10 月起要求下一年，而上游按惯例每年 11 月后才发布下一年数据：
 * 旧实现把「404 / days 为空」记成 failed，于是每天 02:00 一条 warn、状态页
 * `holidays.failed` 常驻一条「失败」，真正的抓取故障反而被淹没。
 * 规则：目标年份 > 当前本地年份且不是「年份错配」→ pending（6h 冷却、不计 failed）。
 */

const currentYear = Number(todayIso().slice(0, 4));
const nextYear = currentYear + 1;

/** 合成一份能通过 validateYearPayload 的整年数据（年份可任取，日期相对年份生成） */
function payloadFor(year: number): HolidayYearPayload {
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

interface YearRow {
  status: string;
  last_error: string | null;
  last_attempt_at: string | null;
}

function yearRow(env: TestEnv, year: number): YearRow {
  const row = env.db
    .prepare("SELECT status, last_error, last_attempt_at FROM cn_holiday_years WHERE year = ?")
    .get(year) as YearRow | undefined;
  assert.ok(row !== undefined, `${year} 年应留下状态记录（pending 也算记录，避免每次冷启动重抓）`);
  return row;
}

describe("节假日 pending：未来年份尚未发布不是故障", () => {
  it("未来年份 404：记 pending、不进 failed、不标记 ready", async () => {
    const env = makeTestEnv();
    try {
      const result = await ensureYears(env.db, [nextYear], async () => {
        throw new Error("HTTP 404");
      });
      assert.deepEqual(result.updated, []);
      assert.deepEqual(result.failed, [], "尚未发布不得计入 failed（状态页/doctor 会误报故障）");
      const row = yearRow(env, nextYear);
      assert.equal(row.status, "pending");
      assert.equal(row.last_error, HOLIDAY_PENDING_REASON);
      assert.ok(row.last_attempt_at !== null, "pending 也要保留 last_attempt_at 供 6h 冷却");
      assert.deepEqual(holidayYearsReady(env.db), []);
      assert.equal(dayType(env.db, `${nextYear}-01-01`), "unknown", "pending 年份仍按未知处理");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未来年份 days 为空：同样 pending（校验失败但年份未到）", async () => {
    const env = makeTestEnv();
    try {
      const result = await ensureYears(env.db, [nextYear], async () => ({
        year: nextYear,
        days: [],
      }));
      assert.deepEqual(result.failed, []);
      assert.equal(yearRow(env, nextYear).status, "pending");
      assert.equal(yearRow(env, nextYear).last_error, HOLIDAY_PENDING_REASON);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("pending 在 6 小时内不重复请求上游；冷却过后数据到手升级为 ready", async () => {
    const env = makeTestEnv();
    try {
      let notPublishedCalls = 0;
      const notPublished = async (): Promise<unknown> => {
        notPublishedCalls += 1;
        throw new Error("HTTP 404");
      };
      await ensureYears(env.db, [nextYear], notPublished);
      assert.equal(notPublishedCalls, 2, "两个候选 URL 各失败一次（jsDelivr + GitHub raw）");

      const cooldown = await ensureYears(env.db, [nextYear], notPublished);
      assert.deepEqual(cooldown.skipped, [nextYear], "6 小时内必须直接跳过");
      assert.equal(notPublishedCalls, 2, "冷却内不得再打上游");

      // 模拟冷却已过：直接改 last_attempt_at（避免测试真的等 6 小时）
      env.db
        .prepare("UPDATE cn_holiday_years SET last_attempt_at = ? WHERE year = ?")
        .run(new Date(Date.now() - 7 * 3600 * 1000).toISOString(), nextYear);

      let okCalls = 0;
      const ready = await ensureYears(env.db, [nextYear], async () => {
        okCalls += 1;
        return payloadFor(nextYear);
      });
      assert.deepEqual(ready.updated, [nextYear]);
      assert.deepEqual(ready.failed, []);
      assert.equal(okCalls, 1, "数据到手后首个源成功即导入");
      assert.equal(yearRow(env, nextYear).status, "ready");
      assert.deepEqual(holidayYearsReady(env.db), [nextYear]);
      assert.equal(dayType(env.db, `${nextYear}-01-01`), "holiday");

      // 已 ready 的年份以后都跳过，不再请求上游
      const after = await ensureYears(env.db, [nextYear], notPublished);
      assert.deepEqual(after.skipped, [nextYear]);
      assert.equal(notPublishedCalls, 2);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("当前年份失败仍按 failed 处理（真的坏了）", async () => {
    const env = makeTestEnv();
    try {
      const result = await ensureYears(env.db, [currentYear], async () => {
        throw new Error("HTTP 404");
      });
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0] ?? "", new RegExp(`^${currentYear}:`));
      const row = yearRow(env, currentYear);
      assert.equal(row.status, "failed");
      assert.match(row.last_error ?? "", /HTTP 404/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未来年份但数据错配：仍按 failed（上游/CDN 真故障，不是「还没发布」）", async () => {
    const env = makeTestEnv();
    try {
      const result = await ensureYears(env.db, [nextYear], async () => payloadFor(currentYear));
      assert.equal(result.failed.length, 1);
      assert.match(result.failed[0] ?? "", /错配/);
      assert.equal(yearRow(env, nextYear).status, "failed");
      assert.deepEqual(holidayYearsReady(env.db), [], "错配年份不得标记为 ready");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("当前年份导入成功仍正常 ready（不回归）", async () => {
    const env = makeTestEnv();
    try {
      const result = await ensureYears(env.db, [currentYear], async () => payloadFor(currentYear));
      assert.deepEqual(result.updated, [currentYear]);
      assert.deepEqual(result.failed, []);
      assert.equal(yearRow(env, currentYear).status, "ready");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
