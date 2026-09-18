import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, it } from "node:test";
import { migrate } from "../src/core/database.js";
import {
  BACKOFF_MAX_EXPONENT,
  BACKOFF_MAX_WAIT_MS,
  CACHE_TTL_MS,
  type LocationInfo,
  QWEATHER_MAX_CONCURRENCY,
  airQuality,
  alerts,
  backoffDelayMs,
  currentWeather,
  dailyForecastTtlMs,
  forecast,
  geoLookup,
  resetQweatherStateForTests,
  setQweatherDepsForTests,
} from "../src/core/qweather.js";
import { todayIso } from "../src/time.js";

/**
 * 阶段 B1：QWeather 客户端加固 —— 短 TTL 缓存 / 并发上限 / 指数退避 / GeoAPI 合规。
 * 全部使用注入的假 fetch、假时钟（node:test mock.timers）、假 sleep，绝不打真实外网。
 */

const HOST = "test.example.com";
const KEY = "test-key";
const LOC: LocationInfo = { city: "上海", cityId: "101020100", lat: 31.23, lon: 121.47 };

const NOW_BODY = {
  code: "200",
  now: { temp: "26", feelsLike: "28", humidity: "70", windSpeed: "12", text: "多云" },
};

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

function countCache(db: DatabaseSync, like = "%"): number {
  const row = db.prepare("SELECT COUNT(*) AS n FROM cache WHERE key LIKE ?").get(like) as {
    n: number;
  };
  return row.n;
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

type Responder = (url: string, call: number) => Response | Promise<Response>;

async function withFetch(
  responder: Responder,
  fn: (calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push(url);
    return responder(url, calls.length);
  }) as unknown as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** 收集退避 sleep 的毫秒数并注入固定随机数，避免真实等待 */
function captureSleeps(): number[] {
  const sleeps: number[] = [];
  setQweatherDepsForTests({
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    maxAttempts: 3,
    maxWaitMs: Number.POSITIVE_INFINITY,
  });
  return sleeps;
}

beforeEach(() => {
  resetQweatherStateForTests();
});

describe("QWeather：缓存 TTL 常量（官方推荐区间的中间值）", () => {
  it("实时天气 20min / 逐天预报 2h / 预警 10min / 空气质量 45min", () => {
    assert.equal(CACHE_TTL_MS.now, 20 * 60_000);
    assert.equal(CACHE_TTL_MS.daily, 2 * 3_600_000);
    assert.equal(CACHE_TTL_MS.alerts, 10 * 60_000);
    assert.equal(CACHE_TTL_MS.air, 45 * 60_000);
  });
});

describe("QWeather：短 TTL 缓存", () => {
  it("命中不请求：同参数两次只打一次上游；TTL 过期后重新请求", async () => {
    const db = makeDb();
    await withFetch(
      () => jsonResponse(NOW_BODY),
      async (calls) => {
        await currentWeather(db, HOST, KEY, LOC);
        await currentWeather(db, HOST, KEY, LOC);
        assert.equal(calls.length, 1, "第二次应命中缓存");
      },
    );
    assert.equal(countCache(db, "qweather:now:101020100"), 1);

    // 直接把过期时间拨到过去，模拟 TTL 到期
    db.prepare("UPDATE cache SET expires_at = ? WHERE key = ?").run(
      new Date(Date.now() - 1000).toISOString(),
      "qweather:now:101020100",
    );
    await withFetch(
      () => jsonResponse(NOW_BODY),
      async (calls) => {
        await currentWeather(db, HOST, KEY, LOC);
        assert.equal(calls.length, 1, "过期后应重新请求");
      },
    );
    db.close();
  });

  it("缓存键区分城市与数据类型", async () => {
    const db = makeDb();
    const daily = () => ({
      code: "200",
      daily: [{ fxDate: todayIso(), tempMax: "30", tempMin: "24", textDay: "晴", precip: "0" }],
    });
    await withFetch(
      (url) => {
        if (url.includes("/v7/weather/now")) return jsonResponse(NOW_BODY);
        if (url.includes("/v7/weather/7d") || url.includes("/v7/weather/3d"))
          return jsonResponse(daily());
        if (url.includes("/weatheralert/")) return jsonResponse({ code: "200", alerts: [] });
        if (url.includes("/airquality/"))
          return jsonResponse({
            indexes: [
              { code: "cn-mee", aqi: 42, category: "优", primaryPollutant: { name: "NA" } },
            ],
            pollutants: [],
          });
        throw new Error(`unexpected url ${url}`);
      },
      async () => {
        await currentWeather(db, HOST, KEY, LOC);
        await forecast(db, HOST, KEY, LOC, 7);
        await forecast(db, HOST, KEY, LOC, 3);
        await alerts(db, HOST, KEY, LOC);
        await airQuality(db, HOST, KEY, LOC);
      },
    );
    const keys = (db.prepare("SELECT key FROM cache ORDER BY key").all() as { key: string }[]).map(
      (r) => r.key,
    );
    assert.deepEqual(keys, [
      "qweather:air:31.23,121.47",
      "qweather:alerts:31.23,121.47",
      "qweather:daily:3:101020100",
      "qweather:daily:7:101020100",
      "qweather:now:101020100",
    ]);
    db.close();
  });

  it("跨日边界：本地 23:59 取预报，次日 00:01 必须重新请求", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    t.mock.timers.setTime(Date.parse("2026-09-18T15:59:00.000Z")); // 2026-09-18 23:59 +08
    const db = makeDb();
    const daily = () => ({
      code: "200",
      daily: [{ fxDate: todayIso(), tempMax: "30", tempMin: "24", textDay: "晴", precip: "0" }],
    });

    await withFetch(
      () => jsonResponse(daily()),
      async (calls) => {
        await forecast(db, HOST, KEY, LOC, 7);
        await forecast(db, HOST, KEY, LOC, 7);
        assert.equal(calls.length, 1, "23:59 内两次调用应命中缓存");
      },
    );

    t.mock.timers.setTime(Date.parse("2026-09-18T16:01:00.000Z")); // 次日 00:01 +08
    await withFetch(
      () => jsonResponse(daily()),
      async (calls) => {
        await forecast(db, HOST, KEY, LOC, 7);
        assert.equal(calls.length, 1, "过 00:00 后旧缓存必须失效");
      },
    );
    db.close();
  });

  it("dailyForecastTtlMs 取 min(2h, 距次日 00:00)", () => {
    assert.equal(dailyForecastTtlMs(Date.parse("2026-09-18T15:59:00.000Z")), 60_000);
    assert.equal(dailyForecastTtlMs(Date.parse("2026-09-18T04:00:00.000Z")), CACHE_TTL_MS.daily);
  });

  it("错误响应不写缓存：业务错误码连打两次请求数为 2", async () => {
    const db = makeDb();
    await withFetch(
      () => jsonResponse({ code: "402" }),
      async (calls) => {
        await assert.rejects(() => currentWeather(db, HOST, KEY, LOC));
        await assert.rejects(() => currentWeather(db, HOST, KEY, LOC));
        assert.equal(calls.length, 2);
      },
    );
    assert.equal(countCache(db), 0, "失败结果不得入库");
    db.close();
  });

  it("错误响应不写缓存：HTTP 500 连打两次请求数为 2", async () => {
    const db = makeDb();
    setQweatherDepsForTests({ maxAttempts: 1 }); // 隔离重试，只看缓存语义
    await withFetch(
      () => jsonResponse({}, 500),
      async (calls) => {
        await assert.rejects(() => currentWeather(db, HOST, KEY, LOC));
        await assert.rejects(() => currentWeather(db, HOST, KEY, LOC));
        assert.equal(calls.length, 2);
      },
    );
    assert.equal(countCache(db), 0, "失败结果不得入库");
    db.close();
  });

  it("结构不完整的成功响应也不写缓存", async () => {
    const db = makeDb();
    await withFetch(
      () => jsonResponse({ code: "200" }), // 缺 daily
      async (calls) => {
        await assert.rejects(() => forecast(db, HOST, KEY, LOC, 7));
        await assert.rejects(() => forecast(db, HOST, KEY, LOC, 7));
        assert.equal(calls.length, 2);
      },
    );
    assert.equal(countCache(db), 0);
    db.close();
  });
});

describe("QWeather：并发上限", () => {
  it("同时发起 4 个请求，任意时刻在飞数 ≤ 3", async () => {
    const db = makeDb();
    let inFlight = 0;
    let maxInFlight = 0;
    let finished = 0;
    const pending: Array<() => void> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => pending.push(resolve));
      inFlight -= 1;
      finished += 1;
      return jsonResponse(NOW_BODY);
    }) as unknown as typeof fetch;

    try {
      const locs = ["C0", "C1", "C2", "C3"].map((id) => ({ ...LOC, cityId: id }));
      const all = locs.map((l) => currentWeather(db, HOST, KEY, l));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(maxInFlight, QWEATHER_MAX_CONCURRENCY, "同时只应有 3 个在飞");

      while (finished < 4) {
        for (const resolve of pending.splice(0)) resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      assert.equal((await Promise.all(all)).length, 4);
      assert.ok(maxInFlight <= QWEATHER_MAX_CONCURRENCY);
    } finally {
      globalThis.fetch = original;
      db.close();
    }
  });
});

describe("QWeather：指数退避", () => {
  it("等待时长落在 [2^c, 2^c + 2^c - 1] 秒区间内", () => {
    for (let c = 1; c <= BACKOFF_MAX_EXPONENT; c += 1) {
      for (const r of [0, 0.25, 0.5, 0.999]) {
        const ms = backoffDelayMs(c, () => r, Number.POSITIVE_INFINITY);
        const lo = 2 ** c * 1000;
        const hi = (2 ** c + 2 ** c - 1) * 1000;
        assert.ok(ms >= lo && ms <= hi, `c=${c} r=${r} 得到 ${ms}ms，应落在 [${lo}, ${hi}]`);
      }
    }
  });

  it("单次等待受 maxWaitMs 上限约束", () => {
    assert.equal(
      backoffDelayMs(10, () => 0, BACKOFF_MAX_WAIT_MS),
      BACKOFF_MAX_WAIT_MS,
    );
    assert.equal(BACKOFF_MAX_WAIT_MS, 15 * 60_000);
    assert.equal(
      backoffDelayMs(99, () => 0.999, BACKOFF_MAX_WAIT_MS),
      BACKOFF_MAX_WAIT_MS,
    );
  });

  it("连续 429：c 递增、成功后重置、到上限不再增长", async () => {
    const db = makeDb();
    const sleeps = captureSleeps();
    const delay = (c: number) => backoffDelayMs(c, () => 0.5, Number.POSITIVE_INFINITY);

    // 第 1 次调用：attempt1→c=1、attempt2→c=2，第 3 次尝试后抛出
    await withFetch(
      () => jsonResponse({}, 429),
      async () => {
        await assert.rejects(() => currentWeather(db, HOST, KEY, LOC));
      },
    );
    assert.deepEqual(sleeps, [delay(1), delay(2)]);

    // 第 2 次调用：c 从 3 继续递增（退避状态跨调用保留），下次等待用 c=4、c=5
    await withFetch(
      () => jsonResponse({}, 429),
      async () => {
        await assert.rejects(() => currentWeather(db, HOST, KEY, LOC));
      },
    );
    assert.deepEqual(sleeps, [delay(1), delay(2), delay(4), delay(5)]);

    // 一次成功即重置 c（用独立 cityId，避免把 LOC 的成功结果缓存住）
    await withFetch(
      () => jsonResponse(NOW_BODY),
      async () => {
        await currentWeather(db, HOST, KEY, { ...LOC, cityId: "OK" });
      },
    );
    sleeps.length = 0;
    const afterLoc = { ...LOC, cityId: "AFTER" };
    await withFetch(
      () => jsonResponse({}, 429),
      async () => {
        await assert.rejects(() => currentWeather(db, HOST, KEY, afterLoc));
      },
    );
    assert.deepEqual(sleeps, [delay(1), delay(2)], "成功后退避应重置");

    // 持续失败直到 c 封顶：末两次等待相等且为 delay(10)
    // 用独立 cityId，避免上面「成功」那步已把 LOC 的结果写入缓存
    const capLoc = { ...LOC, cityId: "CAP" };
    sleeps.length = 0;
    for (let i = 0; i < 5; i += 1) {
      await withFetch(
        () => jsonResponse({}, 429),
        async () => {
          await assert.rejects(() => currentWeather(db, HOST, KEY, capLoc));
        },
      );
    }
    const tail = sleeps.slice(-2);
    assert.deepEqual(tail, [delay(BACKOFF_MAX_EXPONENT), delay(BACKOFF_MAX_EXPONENT)]);
    for (const ms of sleeps) {
      assert.ok(ms <= delay(BACKOFF_MAX_EXPONENT), `等待 ${ms}ms 不应超过 c 封顶值`);
    }
    db.close();
  });

  it("业务错误码：429 重试、402 不重试", async () => {
    const db = makeDb();
    const sleeps = captureSleeps();
    await withFetch(
      () => jsonResponse({ code: "429" }),
      async (calls) => {
        await assert.rejects(() => currentWeather(db, HOST, KEY, { ...LOC, cityId: "R1" }));
        assert.equal(calls.length, 3, "业务 429 应重试满 3 次");
      },
    );
    assert.equal(sleeps.length, 2);
    sleeps.length = 0;
    await withFetch(
      () => jsonResponse({ code: "402" }),
      async (calls) => {
        await assert.rejects(() => currentWeather(db, HOST, KEY, { ...LOC, cityId: "R2" }));
        assert.equal(calls.length, 1, "业务 402 属 4xx，绝不重试");
      },
    );
    assert.deepEqual(sleeps, []);
    db.close();
  });

  it("4xx 不重试：400/403/404 只请求一次即抛错", async () => {
    const db = makeDb();
    const sleeps = captureSleeps();
    for (const [i, status] of [400, 403, 404].entries()) {
      await withFetch(
        () => jsonResponse({}, status),
        async (calls) => {
          await assert.rejects(() => currentWeather(db, HOST, KEY, { ...LOC, cityId: `S${i}` }));
          assert.equal(calls.length, 1, `HTTP ${status} 不得重试`);
        },
      );
    }
    assert.deepEqual(sleeps, [], "4xx 不应触发任何退避等待");
    db.close();
  });
});

describe("QWeather：GeoAPI 合规（不落盘）", () => {
  const GEO = { code: "200", location: [{ id: "101020100", lat: "31.23", lon: "121.47" }] };

  it("同城两次只打一次上游，且 cache 表无 qweather:geo: 行", async () => {
    const db = makeDb();
    await withFetch(
      () => jsonResponse(GEO),
      async (calls) => {
        await geoLookup(db, HOST, KEY, "上海");
        await geoLookup(db, HOST, KEY, "上海");
        assert.equal(calls.length, 1, "进程内 memo 应命中断第二次");
      },
    );
    assert.equal(countCache(db, "qweather:geo:%"), 0);
    assert.equal(countCache(db), 0);
    db.close();
  });

  it("清理老库残留的 qweather:geo: 键", async () => {
    const db = makeDb();
    db.prepare("INSERT INTO cache (key, value_json, expires_at) VALUES (?, ?, ?)").run(
      "qweather:geo:上海",
      JSON.stringify({ id: "101020100", lat: 31.23, lon: 121.47 }),
      new Date(Date.now() + 3600_000).toISOString(),
    );
    assert.equal(countCache(db, "qweather:geo:%"), 1);
    await withFetch(
      () => jsonResponse(GEO),
      async () => {
        await geoLookup(db, HOST, KEY, "上海");
      },
    );
    assert.equal(countCache(db, "qweather:geo:%"), 0, "历史 geo 缓存行应被清理");
    db.close();
  });
});
