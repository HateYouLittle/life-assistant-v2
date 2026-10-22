import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { importYear } from "../src/core/holiday.js";
import { setPushRoute } from "../src/core/notify.js";
import { runDailyBrief } from "../src/modules/weather/index.js";
import { TZ, todayIso } from "../src/time.js";
import {
  cleanupTestEnv,
  localDayStart,
  makeTestEnv,
  v1Current,
  v1Daily,
  v1Day,
  type TestEnv,
} from "./helpers.js";

/**
 * 功能1 回归：每日简报新增「下个假期」行。
 * 所有夹具日期一律相对 todayIso() 构造（不硬编码未来日期），并由 importYear 种入
 * cn_holiday_days（holidayPeriods 只按连续 holiday 行合段，故夹具必须连续）。
 */

const ENV = {
  QWEATHER_API_HOST: "test.example.com",
  QWEATHER_KEY: "test-key",
  DEFAULT_CITY: "北京",
};

const GEO = { code: "200", location: [{ id: "101010100", lat: "39.90", lon: "116.41" }] };

function handlerFor(url: string): unknown {
  if (url.includes("/geo/v2/city/lookup")) return GEO;
  if (url.includes("/weather/v1/current")) return v1Current();
  if (url.includes("/weather/v1/daily")) {
    return v1Daily([v1Day({ start: localDayStart(todayIso()) })]);
  }
  if (url.includes("/weatheralert/v1/current")) return { code: "200", alerts: [] };
  if (url.includes("/airquality/v1/current")) {
    return { indexes: [{ code: "cn-mee", aqi: 42, category: "优" }], pollutants: [] };
  }
  throw new Error(`unexpected url ${url}`);
}

async function withMockFetch(
  handler: (url: string) => unknown,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return {
      ok: true,
      status: 200,
      json: async () => handler(url),
      body: null,
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

/** 相对今天（本地日历日）偏移 n 天 */
function dayOffset(n: number): string {
  return DateTime.fromISO(todayIso(), { zone: TZ }).plus({ days: n }).toISODate() ?? "";
}

function mmdd(date: string): string {
  return date.slice(5);
}

/**
 * 种入一段连续假期。year 一律取今天所在年：importYear 只写元数据与日期行，
 * dayType(今天) 由此拿到 ready 年份（跨年夹具也能按行命中，不受影响）。
 */
function seedHoliday(env: TestEnv, name: string, startOffset: number, days: number): void {
  importYear(
    env.db,
    {
      year: Number(todayIso().slice(0, 4)),
      days: Array.from({ length: days }, (_, i) => ({
        name,
        date: dayOffset(startOffset + i),
        isOffDay: true,
      })),
    },
    "test",
  );
}

async function briefBody(env: TestEnv): Promise<string> {
  setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
  await withMockFetch(handlerFor, async () => {
    await runDailyBrief();
  });
  const row = env.db
    .prepare("SELECT body_md FROM notifications WHERE profile_id = 'default'")
    .get() as { body_md: string } | undefined;
  assert.ok(row !== undefined, "每日简报应落一条通知");
  return row.body_md;
}

describe("每日简报：下个假期倒计时", () => {
  it("未开始的假期：名称 + MM-DD 起 + 还有 N 天（明天=1）+ 共 D 天", async () => {
    const env = makeTestEnv(ENV);
    try {
      seedHoliday(env, "中秋节", 2, 4);
      const body = await briefBody(env);
      const start = mmdd(dayOffset(2));
      assert.ok(
        body.includes(`| 下个假期 | 中秋节 ${start} 起，还有 2 天（共 4 天） |`),
        `简报应含下个假期倒计时行，实际正文：\n${body}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("明天开始放假：倒计时 N=1，且既有「明天开始放假」提示行行为不变", async () => {
    const env = makeTestEnv(ENV);
    try {
      seedHoliday(env, "中秋节", 1, 3);
      const body = await briefBody(env);
      const start = mmdd(dayOffset(1));
      const end = mmdd(dayOffset(3));
      assert.ok(
        body.includes(`| 下个假期 | 中秋节 ${start} 起，还有 1 天（共 3 天） |`),
        `明天开始应显示还有 1 天，实际正文：\n${body}`,
      );
      assert.match(body, new RegExp(`🎉 明天开始放假（中秋节，${start}[–-]${end}，共 3 天）`));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("进行中的假期：假期中，第 X/D 天，至 MM-DD", async () => {
    const env = makeTestEnv(ENV);
    try {
      // 今天落在假期第 2 天：昨天开始、共 4 天
      seedHoliday(env, "国庆节", -1, 4);
      const body = await briefBody(env);
      const end = mmdd(dayOffset(2));
      assert.ok(
        body.includes(`| 下个假期 | 国庆节（假期中，第 2/4 天，至 ${end}） |`),
        `假期中应显示第 2/4 天，实际正文：\n${body}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("节假日数据缺失：显示未知（节假日数据未就绪），简报本身照常发送", async () => {
    const env = makeTestEnv(ENV);
    try {
      const body = await briefBody(env);
      assert.ok(
        body.includes("| 下个假期 | 未知（节假日数据未就绪） |"),
        `数据缺失时应明确未知而不是猜，实际正文：\n${body}`,
      );
      // 简报不应因为节假日数据缺失而整体失败：上面的 briefBody 已断言落了通知
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("当年数据已就绪但已无后续假期：下个假期同样显示未知", async () => {
    const env = makeTestEnv(ENV);
    try {
      // 只种一段已结束的假期：nextHolidayPeriod 返回 null（未来无数据）
      seedHoliday(env, "端午节", -10, 1);
      const body = await briefBody(env);
      assert.ok(
        body.includes("| 下个假期 | 未知（节假日数据未就绪） |"),
        `无后续假期时应显示未知，实际正文：\n${body}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("每日简报：启动补发按原定触发日（M2）", () => {
  /** 该 Profile 所有每日简报通知的 dedupeKey（按建库顺序） */
  function briefKeys(env: TestEnv): string[] {
    return (
      env.db
        .prepare(
          "SELECT dedupe_key FROM notifications WHERE kind = 'weather.brief' ORDER BY created_at, id",
        )
        .all() as { dedupe_key: string | null }[]
    ).map((row) => row.dedupe_key ?? "");
  }

  function briefBodies(env: TestEnv): string[] {
    return (
      env.db
        .prepare(
          "SELECT body_md FROM notifications WHERE kind = 'weather.brief' ORDER BY created_at, id",
        )
        .all() as { body_md: string }[]
    ).map((row) => row.body_md);
  }

  it("晚 cron 跨午夜补发：dedupeKey 与内容都锚定原定触发日，不吞当晚正常简报", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T01:00:00+08:00") });
    const env = makeTestEnv(ENV);
    try {
      // 种一个 10-23 开始的假期：用来验证「下个假期」倒计时也是按业务日算的
      importYear(
        env.db,
        { year: 2026, days: [{ name: "测试节", date: "2026-10-23", isOffDay: true }] },
        "test",
      );

      // 模拟「21 日 22:00 的 daily_brief 错过、22 日 01:00 启动补发」：
      // daemon 会把原定触发时刻（本地 10-21 22:00）作为 at 传给 handler。
      const catchupAt = DateTime.fromISO("2026-10-21T22:00:00", { zone: TZ });
      await withMockFetch(handlerFor, () => runDailyBrief(catchupAt));
      assert.deepEqual(
        briefKeys(env),
        ["brief:default:北京:2026-10-21"],
        "补发必须写原定触发日的键",
      );
      assert.match(
        briefBodies(env)[0] ?? "",
        /10-23 起，还有 2 天/,
        "「下个假期」倒计时也按原定触发日（10-21）算，而不是凌晨补跑的 10-22",
      );

      // 当晚 22:00 正常触发：业务日 10-22 → 新键 → 新增一条，不被凌晨那次吞掉
      t.mock.timers.setTime(Date.parse("2026-10-22T22:00:00+08:00"));
      await withMockFetch(handlerFor, () =>
        runDailyBrief(DateTime.fromISO("2026-10-22T22:00:00", { zone: TZ })),
      );
      assert.deepEqual(
        briefKeys(env).sort(),
        ["brief:default:北京:2026-10-21", "brief:default:北京:2026-10-22"],
        "跨午夜补发与当晚正常触发必须是两个不同的 dedupe 键",
      );
      assert.match(briefBodies(env)[1] ?? "", /10-23 起，还有 1 天/, "当晚简报按 10-22 算倒计时");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同一天重复触发仍只发一条（at 与缺省 now() 共用同一业务日）", async () => {
    const env = makeTestEnv(ENV);
    try {
      const at = DateTime.fromISO("2026-10-21T22:00:00", { zone: TZ });
      await withMockFetch(handlerFor, async () => {
        await runDailyBrief(at);
        await runDailyBrief(at);
      });
      assert.equal(briefKeys(env).length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
