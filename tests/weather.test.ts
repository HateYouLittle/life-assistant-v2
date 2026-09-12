import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { todayIso } from "../src/time.js";
import { setPushRoute } from "../src/core/notify.js";
import { runDailyBrief, weatherTool } from "../src/modules/weather/index.js";
import { cleanupTestEnv, makeTestEnv, SECRET, type TestEnv } from "./helpers.js";

interface Call {
  url: string;
}

type FetchHandler = (url: string) => unknown;

async function withMockFetch(handler: FetchHandler, fn: (calls: Call[]) => Promise<void> | void): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url });
    const body = handler(url);
    return {
      ok: true,
      status: 200,
      json: async () => body,
      body: null,
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const ENV = {
  QWEATHER_API_HOST: "test.example.com",
  QWEATHER_KEY: "test-key",
  PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }),
};

const GEO = { code: "200", location: [{ id: "101020100", lat: "31.23", lon: "121.47" }] };

function handlerFor(url: string): unknown {
  if (url.includes("/geo/v2/city/lookup")) return GEO;
  if (url.includes("/v7/weather/now")) {
    return { code: "200", now: { temp: "26", feelsLike: "28", humidity: "70", windSpeed: "12", text: "多云" } };
  }
  if (url.includes("/v7/weather/7d") || url.includes("/v7/weather/3d")) {
    return {
      code: "200",
      daily: [
        { fxDate: todayIso(), tempMax: "30", tempMin: "24", textDay: "晴", precip: "0.0" },
        { fxDate: "2026-09-13", tempMax: "29", tempMin: "23", textDay: "雷阵雨", precip: "4.5" },
      ],
    };
  }
  if (url.includes("/weatheralert/v1/current")) return { code: "200", alerts: [] };
  if (url.includes("/airquality/v1/current")) {
    return {
      indexes: [{ code: "cn-mee", aqi: 42, category: "优", primaryPollutant: { name: "NA" } }],
      pollutants: [{ code: "pm2p5", concentration: { value: 15, unit: "μg/m³" } }],
    };
  }
  throw new Error(`unexpected url ${url}`);
}

function tool(env: TestEnv, args: Record<string, unknown>) {
  return weatherTool(args, {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async (profileId: string, input: { kind: string }) => {
        env.published.push({ profileId, input: input as never });
        return { id: "x", deduped: false };
      },
      publishGlobal: async () => ({ materialized: 0 }),
    },
  });
}

describe("weather / air_quality", () => {
  it("current：城市解析 + 表格输出", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async (calls) => {
        const result = (await tool(env, { view: "current", city: "上海" })) as { content: { text: string }[] };
        const payload = JSON.parse(result.content[0]?.text ?? "{}") as { 城市: string; 天气: { rows: string[][] } };
        assert.equal(payload.城市, "上海");
        assert.deepEqual(payload.天气.rows[0], ["天气", "多云"]);
        assert.ok(calls.some((c) => c.url.includes("/v7/weather/now?location=101020100&key=test-key")));
        assert.ok(calls.some((c) => c.url.includes("/geo/v2/city/lookup?location=%E4%B8%8A%E6%B5%B7&key=test-key")));
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("locate 保存位置后，后续查询不再请求 GeoAPI", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async (calls) => {
        await tool(env, { view: "locate", city: "上海" });
        const geoCalls = calls.filter((c) => c.url.includes("/geo/")).length;
        await tool(env, { view: "current" });
        assert.equal(calls.filter((c) => c.url.includes("/geo/")).length, geoCalls, "应命中 profile 位置缓存");
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未配置 QWeather 时明确报错", async () => {
    const env = makeTestEnv();
    try {
      const result = (await tool(env, { view: "current", city: "上海" })) as { isError?: boolean; content: { text: string }[] };
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /QWEATHER/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("QWeather 业务错误码透出", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(() => ({ code: "402" }), async () => {
        const result = (await tool(env, { view: "current", city: "上海" })) as {
          isError?: boolean;
          content: { text: string }[];
        };
        assert.equal(result.isError, true);
        assert.match(result.content[0]?.text ?? "", /402/);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("air_quality：国标 AQI 与污染物", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async (calls) => {
        const result = (await tool(env, { view: "air" })) as { content: { text: string }[] };
        const payload = JSON.parse(result.content[0]?.text ?? "{}") as { 空气质量: { rows: string[][] } };
        const aqiRow = payload.空气质量.rows.find((r) => r[0] === "AQI（国标）");
        assert.deepEqual(aqiRow, ["AQI（国标）", "42（优）"]);
        const pm = payload.空气质量.rows.find((r) => r[0] === "PM2.5");
        assert.equal(pm?.[1], "15 μg/m³");
        assert.ok(calls.some((c) => c.url.includes("/airquality/v1/current/31.23/121.47")));
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("每日简报：确定性组装 + Profile 内去重", async () => {
    const env = makeTestEnv(ENV);
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      await withMockFetch(handlerFor, async () => {
        await runDailyBrief();
        const rows = env.db
          .prepare("SELECT kind, dedupe_key, body_md FROM notifications WHERE profile_id = 'default'")
          .all() as unknown as { kind: string; dedupe_key: string; body_md: string }[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.kind, "weather.brief");
        assert.match(rows[0]?.dedupe_key ?? "", /^brief:default:北京:\d{4}-\d{2}-\d{2}$/);
        assert.match(rows[0]?.body_md ?? "", /北京 每日简报/);
        assert.match(rows[0]?.body_md ?? "", /AQI 42（优）/);

        await runDailyBrief();
        const after = env.db
          .prepare("SELECT COUNT(*) AS n FROM notifications WHERE profile_id = 'default'")
          .get() as { n: number };
        assert.equal(after.n, 1, "同日同城市应被去重");
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("每日简报：天气与预报全失败则不发送", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch((url) => {
        if (url.includes("/geo/")) return GEO;
        if (url.includes("/v7/weather/")) throw new Error("HTTP 503");
        return { code: "200", alerts: [] };
      }, async () => {
        await runDailyBrief();
        assert.equal(env.published.length, 0);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });
});
