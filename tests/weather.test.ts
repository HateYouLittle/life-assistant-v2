import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { todayIso } from "../src/time.js";
import { setPushRoute } from "../src/core/notify.js";
import { importYear } from "../src/core/holiday.js";
import { runDailyBrief, weatherTool } from "../src/modules/weather/index.js";
import { cleanupTestEnv, makeTestEnv, SECRET, type TestEnv } from "./helpers.js";

interface Call {
  url: string;
}

type FetchHandler = (url: string) => unknown;

async function withMockFetch(
  handler: FetchHandler,
  fn: (calls: Call[]) => Promise<void> | void,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
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
    return {
      code: "200",
      now: { temp: "26", feelsLike: "28", humidity: "70", windSpeed: "12", text: "多云" },
    };
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
        const result = (await tool(env, { view: "current", city: "上海" })) as {
          content: { text: string }[];
        };
        const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
          城市: string;
          天气: { rows: string[][] };
        };
        assert.equal(payload.城市, "上海");
        assert.deepEqual(payload.天气.rows[0], ["天气", "多云"]);
        assert.ok(
          calls.some((c) => c.url.includes("/v7/weather/now?location=101020100&key=test-key")),
        );
        assert.ok(
          calls.some((c) =>
            c.url.includes("/geo/v2/city/lookup?location=%E4%B8%8A%E6%B5%B7&key=test-key"),
          ),
        );
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
        assert.equal(
          calls.filter((c) => c.url.includes("/geo/")).length,
          geoCalls,
          "应命中 profile 位置缓存",
        );
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未配置 QWeather 时明确报错", async () => {
    const env = makeTestEnv();
    try {
      const result = (await tool(env, { view: "current", city: "上海" })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /QWEATHER/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("QWeather 业务错误码透出", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(
        () => ({ code: "402" }),
        async () => {
          const result = (await tool(env, { view: "current", city: "上海" })) as {
            isError?: boolean;
            content: { text: string }[];
          };
          assert.equal(result.isError, true);
          assert.match(result.content[0]?.text ?? "", /402/);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("air_quality：国标 AQI 与污染物", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async (calls) => {
        const result = (await tool(env, { view: "air" })) as { content: { text: string }[] };
        const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
          空气质量: { rows: string[][] };
        };
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
          .prepare(
            "SELECT kind, dedupe_key, title, body_md FROM notifications WHERE profile_id = 'default'",
          )
          .all() as unknown as {
          kind: string;
          dedupe_key: string;
          title: string;
          body_md: string;
        }[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0]?.kind, "weather.brief");
        assert.match(rows[0]?.dedupe_key ?? "", /^brief:default:北京:\d{4}-\d{2}-\d{2}$/);
        // 标题只在 title 字段：body_md 里不得再出现，否则推送与拉取都会重复一行
        assert.equal(rows[0]?.title, "北京 每日简报");
        assert.doesNotMatch(rows[0]?.body_md ?? "", /北京 每日简报/);
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
      await withMockFetch(
        (url) => {
          if (url.includes("/geo/")) return GEO;
          if (url.includes("/v7/weather/")) throw new Error("HTTP 503");
          return { code: "200", alerts: [] };
        },
        async () => {
          await runDailyBrief();
          assert.equal(env.published.length, 0);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather：v1 预警字段映射", () => {
  const ALERT_BODY = {
    code: "200",
    alerts: [
      {
        id: "a1",
        eventType: { name: "大风", code: "1006" },
        color: { code: "red" },
        severity: "extreme",
        effectiveTime: "2026-09-13T10:00+08:00",
        expireTime: "2026-09-14T10:00+08:00",
        headline: "大风红色预警",
        description: "预计阵风 12 级",
      },
    ],
  };

  function alertHandler(url: string): unknown {
    if (url.includes("/geo/")) return GEO;
    if (url.includes("/weatheralert/v1/current")) return ALERT_BODY;
    if (url.includes("/v7/weather/now")) {
      return {
        code: "200",
        now: { temp: "26", feelsLike: "28", humidity: "70", windSpeed: "12", text: "多云" },
      };
    }
    if (url.includes("/v7/weather/")) {
      return {
        code: "200",
        daily: [{ fxDate: todayIso(), tempMax: "30", tempMin: "24", textDay: "晴", precip: "0.0" }],
      };
    }
    if (url.includes("/airquality/")) {
      return { indexes: [{ code: "cn-mee", aqi: 42, category: "优" }], pollutants: [] };
    }
    throw new Error(`unexpected url ${url}`);
  }

  it("view=alert 读 color.code 得到级别（此前按 v7 读 level 恒为空）", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(alertHandler, async () => {
        const result = (await tool(env, { view: "alert" })) as { content: { text: string }[] };
        const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
          预警: { rows: string[][] };
        };
        assert.deepEqual(payload.预警.rows[0], ["红色", "大风", "预计阵风 12 级"]);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("每日简报带上预警级别，而不是只有事件名", async () => {
    const env = makeTestEnv(ENV);
    try {
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      await withMockFetch(alertHandler, async () => {
        await runDailyBrief();
        const row = env.db
          .prepare("SELECT body_md FROM notifications WHERE profile_id = 'default'")
          .get() as { body_md: string };
        assert.match(row.body_md, /红色大风/);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("英文色名转为中文，未知取值原样保留", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(
        (url) => {
          if (url.includes("/geo/")) return GEO;
          if (url.includes("/weatheralert/v1/current")) {
            return {
              code: "200",
              alerts: [
                { id: "1", eventType: { name: "高温" }, color: { code: "yellow" }, headline: "h1" },
                { id: "2", eventType: { name: "暴雨" }, color: { code: "紫色" }, headline: "h2" },
              ],
            };
          }
          throw new Error(`unexpected url ${url}`);
        },
        async () => {
          const result = (await tool(env, { view: "alert" })) as { content: { text: string }[] };
          const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
            预警: { rows: string[][] };
          };
          assert.equal(payload.预警.rows[0]?.[0], "黄色");
          assert.equal(payload.预警.rows[1]?.[0], "紫色");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("无预警时不报错", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(
        (url) => {
          if (url.includes("/geo/")) return GEO;
          if (url.includes("/weatheralert/v1/current")) return { code: "200", alerts: [] };
          throw new Error(`unexpected url ${url}`);
        },
        async () => {
          const result = (await tool(env, { view: "alert" })) as {
            isError?: boolean;
            content: { text: string }[];
          };
          assert.equal(result.isError, undefined);
          assert.match(result.content[0]?.text ?? "", /无生效气象预警/);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather：数值与预报健壮性", () => {
  it('precip "0.0" 视为无降水（此前只判 === "0"，会显示 0mm）', async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(
        (url) => {
          if (url.includes("/geo/")) return GEO;
          if (url.includes("/v7/weather/7d") || url.includes("/v7/weather/3d")) {
            return {
              code: "200",
              daily: [
                { fxDate: todayIso(), tempMax: "30", tempMin: "24", textDay: "晴", precip: "0.0" },
                {
                  fxDate: todayIso(),
                  tempMax: "29",
                  tempMin: "23",
                  textDay: "雷阵雨",
                  precip: "4.5",
                },
              ],
            };
          }
          throw new Error(`unexpected url ${url}`);
        },
        async () => {
          const result = (await tool(env, { view: "forecast" })) as { content: { text: string }[] };
          const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
            预报: { rows: string[][] };
          };
          assert.equal(payload.预报.rows[0]?.[3], "—", "0.0 应显示为无降水");
          assert.equal(payload.预报.rows[1]?.[3], "4.5mm");
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("字段为 null 时报错而不是伪装成 0（aqi:null 不得变成「优」）", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(
        (url) => {
          if (url.includes("/geo/")) return GEO;
          if (url.includes("/airquality/")) {
            return { indexes: [{ code: "cn-mee", aqi: null, category: "优" }], pollutants: [] };
          }
          throw new Error(`unexpected url ${url}`);
        },
        async () => {
          const result = (await tool(env, { view: "air" })) as {
            isError?: boolean;
            content: { text: string }[];
          };
          assert.equal(result.isError, true);
          assert.match(result.content[0]?.text ?? "", /aqi/);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("缺少 daily 数组时报错，而不是输出空预报", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(
        (url) => {
          if (url.includes("/geo/")) return GEO;
          if (url.includes("/v7/weather/")) return { code: "200" };
          throw new Error(`unexpected url ${url}`);
        },
        async () => {
          const result = (await tool(env, { view: "forecast" })) as {
            isError?: boolean;
            content: { text: string }[];
          };
          assert.equal(result.isError, true);
          assert.match(result.content[0]?.text ?? "", /daily/);
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非 2xx 时保留上游 problem+json 的错误详情（此前只剩状态码）", async () => {
    const env = makeTestEnv(ENV);
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 403,
        body: {},
        text: async () =>
          JSON.stringify({
            error: { status: 403, title: "NO CREDIT", detail: "余额不足，请充值" },
          }),
        json: async () => ({}),
      }) as unknown as Response) as typeof fetch;
    try {
      const result = (await tool(env, { view: "current", city: "上海" })) as {
        isError?: boolean;
        content: { text: string }[];
      };
      assert.equal(result.isError, true);
      const text = result.content[0]?.text ?? "";
      assert.match(text, /403/);
      assert.match(text, /NO CREDIT/);
      assert.match(text, /余额不足/);
    } finally {
      globalThis.fetch = original;
      cleanupTestEnv(env);
    }
  });
});

describe("weather 每日简报：补班/放假提示行", () => {
  function seedHoliday(env: TestEnv): void {
    const days = [
      ...[
        "2026-10-01",
        "2026-10-02",
        "2026-10-03",
        "2026-10-04",
        "2026-10-05",
        "2026-10-06",
        "2026-10-07",
      ].map((date) => ({ name: "国庆节", date, isOffDay: true })),
      ...["2026-09-20", "2026-10-10"].map((date) => ({
        name: "国庆节",
        date,
        isOffDay: false,
      })),
    ];
    importYear(env.db, { year: 2026, days }, "test");
  }

  async function briefBodyAt(t: TestContext, date: string, env: TestEnv): Promise<string> {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse(`${date}T03:00:00+08:00`) });
    setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
    await withMockFetch(handlerFor, async () => {
      await runDailyBrief();
    });
    const row = env.db
      .prepare("SELECT body_md FROM notifications WHERE profile_id = 'default'")
      .get() as { body_md: string };
    return row.body_md;
  }

  it("今天要补班 → 提示行", async (t) => {
    const env = makeTestEnv(ENV);
    try {
      seedHoliday(env);
      const body = await briefBodyAt(t, "2026-09-20", env);
      assert.match(body, /⚠️ 今天要补班（国庆节调休）/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("明天要补班 → 提示行", async (t) => {
    const env = makeTestEnv(ENV);
    try {
      seedHoliday(env);
      const body = await briefBodyAt(t, "2026-09-19", env);
      assert.match(body, /⚠️ 明天要补班（国庆节调休）/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("明天开始放假 → 提示行（含起止与天数）", async (t) => {
    const env = makeTestEnv(ENV);
    try {
      seedHoliday(env);
      const body = await briefBodyAt(t, "2026-09-30", env);
      assert.match(body, /🎉 明天开始放假（国庆节，10-01–10-07，共 7 天）/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("都不命中 → 不加行", async (t) => {
    const env = makeTestEnv(ENV);
    try {
      seedHoliday(env);
      const body = await briefBodyAt(t, "2026-10-20", env);
      assert.doesNotMatch(body, /补班|开始放假/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("节假日数据未就绪 → 不加行、不猜", async (t) => {
    const env = makeTestEnv(ENV);
    try {
      const body = await briefBodyAt(t, "2026-09-20", env);
      assert.doesNotMatch(body, /补班|开始放假/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
