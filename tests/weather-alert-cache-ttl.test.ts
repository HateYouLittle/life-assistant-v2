import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { resetQweatherStateForTests } from "../src/core/qweather.js";
import type { LocationInfo } from "../src/core/qweather.js";
import { alerts } from "../src/core/qweather.js";
import { alertCacheTtlMs, runAlertWatch } from "../src/modules/weather/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * P1-9 回归：预警缓存 TTL 与预警巡检间隔对齐。
 *
 * 事故模型：ALERT_WATCH_CRON 默认每 20 分钟一轮，而 qweather.alerts 缓存固定 10 分钟，
 * 于是每轮巡检的缓存必然刚好过期，各地每轮都重新出网，上游请求量被放大约 3 倍
 * （真实用量采样 76–84 次/日）。
 *
 * 这里全部 stub fetch，绝不连真实外网；时间相关断言用「缓存 expires_at 与当前时刻之差」
 * 表达，不依赖真的等待。
 */

const ENV = {
  QWEATHER_API_HOST: "test.example.com",
  QWEATHER_KEY: "test-key",
  DEFAULT_CITY: "北京",
};

const LOC: LocationInfo = { city: "北京", cityId: "101010100", lat: 39.9, lon: 116.41 };

const GEO = { code: "200", location: [{ id: "101010100", lat: "39.90", lon: "116.41" }] };

const HOST = "test.example.com";
const KEY = "test-key";

function handlerFor(url: string): unknown {
  if (url.includes("/geo/v2/city/lookup")) return GEO;
  if (url.includes("/weatheralert/v1/current")) return { code: "200", alerts: [] };
  throw new Error(`unexpected url ${url}`);
}

/** stub 全局 fetch 并把请求 URL 收集起来；handler 抛错即用例预期之外的上游请求 */
async function withCountingFetch(fn: (calls: string[]) => Promise<void>): Promise<void> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return {
      ok: true,
      status: 200,
      body: null,
      json: async () => handlerFor(url),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function alertRequestCount(calls: string[]): number {
  return calls.filter((url) => url.includes("/weatheralert/v1/current")).length;
}

/** 已写入的预警缓存还剩余多少毫秒过期 */
function alertCacheRemainingMs(env: TestEnv): number {
  const row = env.db
    .prepare("SELECT expires_at FROM cache WHERE key LIKE 'qweather:alerts:%'")
    .get() as { expires_at: string } | undefined;
  assert.ok(row !== undefined, "预警查询应写入 cache 行");
  return Date.parse(row.expires_at) - Date.now();
}

/** 断言缓存剩余时长约等于期望 TTL（真实耗时下留 5s 容差） */
function assertCacheTtl(env: TestEnv, expectedMs: number, label: string): void {
  const remaining = alertCacheRemainingMs(env);
  assert.ok(
    Math.abs(remaining - expectedMs) < 5_000,
    `${label}：期望 TTL 约 ${expectedMs}ms，实际剩余 ${remaining}ms`,
  );
}

beforeEach(() => {
  resetQweatherStateForTests();
});

describe("alertCacheTtlMs：预警缓存 TTL 与巡检间隔对齐", () => {
  it("默认 */20 → 20.5 分钟（巡检间隔 + 30s 余量）", () => {
    const env = makeTestEnv(ENV);
    try {
      assert.equal(env.config.alertWatchCron, "*/20 * * * *");
      assert.equal(alertCacheTtlMs(env.config), 20 * 60_000 + 30_000);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("*/10 → 10.5 分钟；*/1 与「每分钟」→ 90s", () => {
    assert.equal(alertCacheTtlMs({ alertWatchCron: "*/10 * * * *" }), 10 * 60_000 + 30_000);
    assert.equal(alertCacheTtlMs({ alertWatchCron: "*/1 * * * *" }), 90_000);
    assert.equal(alertCacheTtlMs({ alertWatchCron: "* * * * *" }), 90_000);
  });

  it("非常规/非法表达式回退 15 分钟，绝不把 TTL 算短", () => {
    // 固定时刻、小时段、带混合字段的表达式都无法静态推出「上一轮巡检时刻」，
    // 宁可保守回退，也不能给出比真实间隔更短的 TTL（那才是放大请求）。
    assert.equal(alertCacheTtlMs({ alertWatchCron: "0 * * * *" }), 15 * 60_000);
    assert.equal(alertCacheTtlMs({ alertWatchCron: "30 7 * * *" }), 15 * 60_000);
    assert.equal(alertCacheTtlMs({ alertWatchCron: "*/20 8-20 * * *" }), 15 * 60_000);
    assert.equal(alertCacheTtlMs({ alertWatchCron: "*/0 * * * *" }), 15 * 60_000);
    assert.equal(alertCacheTtlMs({ alertWatchCron: "*/60 * * * *" }), 15 * 60_000);
  });

  it("容忍配置值首尾空白", () => {
    assert.equal(alertCacheTtlMs({ alertWatchCron: "  */20 * * * *  " }), 20 * 60_000 + 30_000);
  });
});

describe("alerts()：缓存 TTL 参数", () => {
  it("默认仍是 10 分钟（工具查询口径保持不变）", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withCountingFetch(async () => {
        await alerts(env.db, HOST, KEY, LOC);
      });
      assertCacheTtl(env, 10 * 60_000, "默认 TTL");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("TTL 内重复查询命中缓存，过期后才重新出网", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withCountingFetch(async (calls) => {
        await alerts(env.db, HOST, KEY, LOC, 90_000);
        await alerts(env.db, HOST, KEY, LOC, 90_000);
        assert.equal(alertRequestCount(calls), 1, "TTL 内第二次查询应命中缓存、不再出网");
        // 把缓存改成已过期，模拟「过了 TTL」：不真的等 90 秒
        env.db
          .prepare("UPDATE cache SET expires_at = ? WHERE key LIKE 'qweather:alerts:%'")
          .run(new Date(Date.now() - 1_000).toISOString());
        await alerts(env.db, HOST, KEY, LOC, 90_000);
        assert.equal(alertRequestCount(calls), 2, "缓存过期后应重新出网");
      });
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("runAlertWatch：缓存 TTL 跟随巡检间隔（不再每轮穿透）", () => {
  it("*/20：缓存 20.5 分钟，紧接着再巡检一轮不重复出网", async () => {
    const env = makeTestEnv({ ...ENV, ALERT_WATCH_CRON: "*/20 * * * *" });
    try {
      await withCountingFetch(async (calls) => {
        await runAlertWatch();
        await runAlertWatch();
        assert.equal(
          alertRequestCount(calls),
          1,
          "TTL 必须覆盖到下一轮巡检：两轮连跑不应各打一次上游",
        );
      });
      assertCacheTtl(env, 20 * 60_000 + 30_000, "*/20 巡检 TTL");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("*/10：缓存 10.5 分钟（可配置的巡检间隔同样生效）", async () => {
    const env = makeTestEnv({ ...ENV, ALERT_WATCH_CRON: "*/10 * * * *" });
    try {
      await withCountingFetch(async () => {
        await runAlertWatch();
      });
      assertCacheTtl(env, 10 * 60_000 + 30_000, "*/10 巡检 TTL");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
