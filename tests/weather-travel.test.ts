import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { DateTime } from "luxon";
import { resetQweatherStateForTests, saveLocation } from "../src/core/qweather.js";
import { allTools, type PublishInput, type ToolContext } from "../src/core/registry.js";
import { setSetting } from "../src/core/settings.js";
import { runAlertWatch, runDailyBrief, weatherTool } from "../src/modules/weather/index.js";
import { TZ, nowIso, todayIso } from "../src/time.js";
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
 * 功能4 回归：出行模式（weather view=travel）。
 * 覆盖：set/show/clear、窗口内生效（命中目的地经纬度且不再调 GeoAPI）、窗口外/窗口结束后
 * 回退家位置、显式 city 覆盖、非法窗口拒绝、简报与预警巡检使用目的地、脏数据安全忽略。
 * 夹具日期一律相对 todayIso() 构造。
 */

const ENV = {
  QWEATHER_API_HOST: "test.example.com",
  QWEATHER_KEY: "test-key",
  DEFAULT_CITY: "北京",
};

/** 家（北京）与目的地（上海）的坐标，用于区分请求实际打到了哪座城市 */
const HOME = { city: "北京", cityId: "101010100", lat: 39.9, lon: 116.41 };
const TRAVEL = { city: "上海", cityId: "101020100", lat: 31.23, lon: 121.47 };

const GEO_BY_CITY: Record<string, { id: string; lat: string; lon: string }> = {
  北京: { id: HOME.cityId, lat: "39.90", lon: "116.41" },
  上海: { id: TRAVEL.cityId, lat: "31.23", lon: "121.47" },
};

interface Call {
  url: string;
}

function geoCalled(url: string): boolean {
  return url.includes("/geo/");
}

function geoCount(calls: Call[]): number {
  return calls.filter((c) => geoCalled(c.url)).length;
}

function handlerFor(url: string, over: { alertCoord?: string } = {}): unknown {
  if (geoCalled(url)) {
    const city = new URL(url).searchParams.get("location") ?? "";
    const hit = GEO_BY_CITY[city];
    if (hit === undefined) throw new Error(`未 mock 的城市: ${city}`);
    return { code: "200", location: [hit] };
  }
  if (url.includes("/weather/v1/current")) return v1Current();
  if (url.includes("/weather/v1/daily")) {
    return v1Daily([v1Day({ start: localDayStart(todayIso()) })]);
  }
  if (url.includes("/weatheralert/v1/current")) {
    if (over.alertCoord !== undefined && url.includes(over.alertCoord)) {
      return {
        code: "200",
        alerts: [
          {
            id: "a1",
            eventType: { name: "暴雨" },
            color: { code: "red" },
            severity: "extreme",
            effectiveTime: `${dayOffset(0)}T10:00:00+08:00`,
            expireTime: `${dayOffset(2)}T23:00:00+08:00`,
            headline: "暴雨红色预警",
            description: "预计累计降雨量 100mm",
          },
        ],
      };
    }
    return { code: "200", alerts: [] };
  }
  if (url.includes("/airquality/v1/current")) {
    return { indexes: [{ code: "cn-mee", aqi: 42, category: "优" }], pollutants: [] };
  }
  throw new Error(`unexpected url ${url}`);
}

async function withMockFetch(
  handler: (url: string) => unknown,
  fn: (calls: Call[]) => Promise<void> | void,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url });
    return {
      ok: true,
      status: 200,
      json: async () => handler(url),
      body: null,
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn(calls);
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

function ctxOf(env: TestEnv): ToolContext {
  return {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async (profileId: string, input: PublishInput) => {
        env.published.push({ profileId, input });
        return { id: "x", deduped: false };
      },
      publishGlobal: async () => ({ materialized: 0 }),
    },
  };
}

function tool(env: TestEnv, args: Record<string, unknown>) {
  return weatherTool(args, ctxOf(env));
}

function contentOf(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function jsonOf<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(contentOf(result)) as T;
}

function isErrorOf(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

/** 设置一段出行计划（fixture 日期相对 today） */
async function setTravel(
  env: TestEnv,
  city: string,
  startOffset: number,
  endOffset: number,
): Promise<{ 已设置出行: { 城市: string }; 生效: boolean }> {
  const result = await tool(env, {
    view: "travel",
    action: "set",
    city,
    start: dayOffset(startOffset),
    end: dayOffset(endOffset),
  });
  assert.equal(isErrorOf(result), false, `设置出行计划失败：${contentOf(result)}`);
  return jsonOf(result);
}

function travelPlanOf(env: TestEnv): unknown {
  const row = env.db
    .prepare("SELECT value_json FROM settings WHERE profile_id = 'default' AND key = 'travel_plan'")
    .get() as { value_json: string } | undefined;
  return row === undefined ? undefined : JSON.parse(row.value_json);
}

function briefRow(env: TestEnv): { title: string; body_md: string } {
  const row = env.db
    .prepare(
      "SELECT title, body_md FROM notifications WHERE profile_id = 'default' AND kind = 'weather.brief'",
    )
    .get() as { title: string; body_md: string } | undefined;
  assert.ok(row !== undefined, "每日简报应落一条通知");
  return row;
}

// Geo memo 是进程内的（不落盘），用例之间必须清掉，否则「不再请求 GeoAPI」的断言会因为
// 上一个用例的 memo 命中而失真。
beforeEach(() => {
  resetQweatherStateForTests();
});

describe("weather 出行模式：set / show / clear", () => {
  it("set 解析并保存计划（城市/城市ID/经纬度/起止），show 返回计划与生效状态，clear 后 show 为 null", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async (calls) => {
        const start = dayOffset(1);
        const end = dayOffset(3);
        const set = await tool(env, {
          view: "travel",
          action: "set",
          city: "上海",
          start,
          end,
        });
        assert.equal(isErrorOf(set), false);
        const setPayload = jsonOf<{ 生效: boolean; 已设置出行: { 城市: string } }>(set);
        assert.equal(setPayload.生效, false, "明天才开始，今天不应生效");
        assert.equal(setPayload.已设置出行.城市, "上海");
        assert.deepEqual(travelPlanOf(env), {
          city: "上海",
          cityId: TRAVEL.cityId,
          lat: TRAVEL.lat,
          lon: TRAVEL.lon,
          start,
          end,
        });
        assert.equal(geoCount(calls), 1, "set 应只调用一次 GeoAPI");

        const show = await tool(env, { view: "travel", action: "show" });
        const showPayload = jsonOf<{
          出行模式: { 城市: string; 开始: string; 结束: string };
          生效: boolean;
        }>(show);
        assert.equal(showPayload.出行模式.城市, "上海");
        assert.equal(showPayload.出行模式.开始, start);
        assert.equal(showPayload.出行模式.结束, end);
        assert.equal(showPayload.生效, false);

        const clear = await tool(env, { view: "travel", action: "clear" });
        assert.match(contentOf(clear), /已清除出行模式/);
        assert.equal(travelPlanOf(env), undefined, "clear 应删除 settings.travel_plan");
        assert.equal(jsonOf(await tool(env, { view: "travel", action: "show" })), null);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("重复 set 覆盖旧计划（一个 Profile 同时只保留一份）", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async () => {
        await setTravel(env, "上海", 1, 3);
        const second = await setTravel(env, "北京", 2, 5);
        assert.equal(second.已设置出行.城市, "北京");
        const plan = travelPlanOf(env) as { city: string; start: string; end: string };
        assert.equal(plan.city, "北京");
        assert.equal(plan.start, dayOffset(2));
        const rows = env.db
          .prepare(
            "SELECT COUNT(*) AS n FROM settings WHERE profile_id = 'default' AND key = 'travel_plan'",
          )
          .get() as { n: number };
        assert.equal(rows.n, 1, "覆盖式保存只应有一行 settings");
      });
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather 出行模式：位置解析", () => {
  it("窗口内生效：current/forecast/alert/air/air_quality 全用目的地且不再请求 GeoAPI", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async (calls) => {
        await setTravel(env, "上海", -1, 1);
        const geoCallsAfterSet = geoCount(calls);
        assert.equal(geoCallsAfterSet, 1);

        const current = jsonOf<{
          城市: string;
          出行模式: { 城市: string; 起止: string };
        }>(await tool(env, { view: "current" }));
        assert.equal(current.城市, "上海");
        assert.deepEqual(current.出行模式, {
          城市: "上海",
          起止: `${dayOffset(-1)} ~ ${dayOffset(1)}`,
        });

        const forecast = jsonOf<{ 城市: string; 出行模式: { 城市: string } }>(
          await tool(env, { view: "forecast" }),
        );
        assert.equal(forecast.城市, "上海");
        assert.equal(forecast.出行模式.城市, "上海");

        const alert = await tool(env, { view: "alert" });
        assert.match(contentOf(alert), /上海：当前无生效气象预警/);
        assert.match(contentOf(alert), /出行模式：上海/);

        const air = jsonOf<{ 城市: string; 出行模式: { 城市: string } }>(
          await tool(env, { view: "air" }),
        );
        assert.equal(air.城市, "上海");
        assert.equal(air.出行模式.城市, "上海");

        const airTool = allTools().find((t) => t.def.name === "air_quality")?.def;
        assert.ok(airTool !== undefined, "应注册 air_quality 工具");
        const airToolResult = await airTool.handler({}, ctxOf(env));
        assert.equal(jsonOf<{ 城市: string }>(airToolResult).城市, "上海");
        assert.match(contentOf(airToolResult), /出行模式/);

        for (const endpoint of [
          "/weather/v1/current/31.23/121.47",
          "/weather/v1/daily/31.23/121.47",
          "/weatheralert/v1/current/31.23/121.47",
          "/airquality/v1/current/31.23/121.47",
        ]) {
          assert.ok(
            calls.some((c) => c.url.includes(endpoint)),
            `应请求目的地坐标 ${endpoint}；实际 ${calls.map((c) => c.url).join(" | ")}`,
          );
        }
        assert.equal(
          geoCount(calls),
          geoCallsAfterSet,
          "出行计划必须直接复用保存的经纬度，不得再调 GeoAPI",
        );
        assert.ok(
          calls.every((c) => !c.url.includes("39.90")),
          "出行生效期间不应请求家（北京）坐标",
        );
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("窗口外回退已保存的家位置，且输出不标注出行模式", async () => {
    const env = makeTestEnv(ENV);
    try {
      saveLocation(env.db, "default", HOME);
      await withMockFetch(handlerFor, async (calls) => {
        const setPayload = await setTravel(env, "上海", 5, 10);
        assert.equal(setPayload.生效, false);
        assert.equal(geoCount(calls), 1, "set 时需要 GeoAPI 解析目的地");

        const current = jsonOf<{ 城市: string; 出行模式?: unknown }>(
          await tool(env, { view: "current" }),
        );
        assert.equal(current.城市, "北京");
        assert.equal(current.出行模式, undefined);
        assert.ok(calls.some((c) => c.url.includes("/weather/v1/current/39.90/116.41")));

        await runDailyBrief();
        const brief = briefRow(env);
        assert.equal(brief.title, "北京 每日简报");
        assert.doesNotMatch(brief.body_md, /出行模式/);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("窗口结束后自动恢复家位置（不需要手动 clear）", async (t) => {
    const env = makeTestEnv(ENV);
    try {
      saveLocation(env.db, "default", HOME);
      await withMockFetch(handlerFor, async (calls) => {
        // 今天生效的短行程：昨天开始、今天结束
        await setTravel(env, "上海", -1, 0);
        t.mock.timers.enable({
          apis: ["Date"],
          now: Date.parse(`${dayOffset(2)}T10:00:00+08:00`),
        });
        const current = jsonOf<{ 城市: string; 出行模式?: unknown }>(
          await tool(env, { view: "current" }),
        );
        assert.equal(current.城市, "北京", "窗口结束后应自动回退家位置");
        assert.equal(current.出行模式, undefined);
        assert.ok(calls.some((c) => c.url.includes("/weather/v1/current/39.90/116.41")));
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("显式 city 覆盖出行计划（优先于目的地）", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async (calls) => {
        await setTravel(env, "上海", -1, 1);
        const current = jsonOf<{ 城市: string; 出行模式?: unknown }>(
          await tool(env, { view: "current", city: "北京" }),
        );
        assert.equal(current.城市, "北京");
        assert.equal(current.出行模式, undefined);
        assert.ok(calls.some((c) => c.url.includes("/weather/v1/current/39.90/116.41")));
        assert.equal(geoCount(calls), 2, "显式 city 仍需解析一次 Geo");
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("locate 设置的始终是家位置；出行生效期间回执提示查询仍走目的地", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async (calls) => {
        await setTravel(env, "上海", -1, 1);
        const locate = jsonOf<{
          已设置位置: { city: string };
          出行模式提示?: string;
        }>(await tool(env, { view: "locate", city: "北京" }));
        assert.equal(locate.已设置位置.city, "北京");
        assert.match(
          locate.出行模式提示 ?? "",
          /出行模式生效中，天气查询仍使用目的地，结束后自动恢复/,
        );

        const current = jsonOf<{ 城市: string }>(await tool(env, { view: "current" }));
        assert.equal(current.城市, "上海", "locate 之后查询仍应使用目的地");
        assert.ok(calls.some((c) => c.url.includes("/weather/v1/current/31.23/121.47")));
      });
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather 出行模式：参数校验", () => {
  it("缺少参数、日期非法、start>end、end 早于今天、窗口超过 366 天都拒绝且不落库", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(handlerFor, async (calls) => {
        const cases: Array<[string, Record<string, unknown>]> = [
          ["缺少 action", { view: "travel" }],
          [
            "set 缺少 city",
            { view: "travel", action: "set", start: dayOffset(0), end: dayOffset(1) },
          ],
          ["set 缺少 start", { view: "travel", action: "set", city: "上海", end: dayOffset(1) }],
          ["set 缺少 end", { view: "travel", action: "set", city: "上海", start: dayOffset(0) }],
          [
            "start 晚于 end",
            {
              view: "travel",
              action: "set",
              city: "上海",
              start: dayOffset(3),
              end: dayOffset(1),
            },
          ],
          [
            "end 早于今天",
            {
              view: "travel",
              action: "set",
              city: "上海",
              start: dayOffset(-3),
              end: dayOffset(-1),
            },
          ],
          [
            "窗口超过 366 天",
            {
              view: "travel",
              action: "set",
              city: "上海",
              start: dayOffset(0),
              end: dayOffset(366),
            },
          ],
          [
            "日期格式非法",
            {
              view: "travel",
              action: "set",
              city: "上海",
              start: "2026/01/01",
              end: dayOffset(1),
            },
          ],
        ];
        for (const [why, args] of cases) {
          const result = await tool(env, args);
          assert.equal(isErrorOf(result), true, `${why} 应被拒绝`);
        }
        assert.equal(travelPlanOf(env), undefined, "非法参数不得写入出行计划");
        assert.equal(calls.length, 0, "非法参数不应发起任何网络请求");

        // 上界：恰好 366 天（含首尾）是合法的
        const okResult = await tool(env, {
          view: "travel",
          action: "set",
          city: "上海",
          start: dayOffset(0),
          end: dayOffset(365),
        });
        assert.equal(isErrorOf(okResult), false, contentOf(okResult));
        assert.notEqual(travelPlanOf(env), undefined);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather 出行模式：简报与预警巡检", () => {
  it("每日简报改用目的地城市并显式标注出行模式（标题仍是目的地）", async () => {
    const env = makeTestEnv(ENV);
    try {
      saveLocation(env.db, "default", HOME);
      await withMockFetch(handlerFor, async (calls) => {
        await setTravel(env, "上海", -1, 2);
        await runDailyBrief();
        const brief = briefRow(env);
        assert.equal(brief.title, "上海 每日简报", "简报标题应使用目的地城市");
        assert.ok(
          brief.body_md.includes(
            `| 出行模式 | 上海（${mmdd(dayOffset(-1))}–${mmdd(dayOffset(2))}） |`,
          ),
          `简报应显式标注出行模式，实际正文：\n${brief.body_md}`,
        );
        // 功能1 联动：无节假日数据时也要有「下个假期」行且不崩
        assert.ok(brief.body_md.includes("| 下个假期 |"), "简报应含下个假期行");
        assert.ok(calls.some((c) => c.url.includes("/weather/v1/current/31.23/121.47")));
        assert.ok(
          calls.every((c) => !c.url.includes("39.90")),
          "出行生效期间简报不应请求家坐标",
        );
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("预警巡检使用目的地坐标，并在通知里标注出行模式", async () => {
    const env = makeTestEnv(ENV);
    try {
      saveLocation(env.db, "default", HOME);
      await withMockFetch(
        (url) => handlerFor(url, { alertCoord: "31.23" }),
        async (calls) => {
          await setTravel(env, "上海", -1, 2);
          await runAlertWatch();
          const row = env.db
            .prepare(
              "SELECT title, body_md FROM notifications WHERE profile_id = 'default' AND kind = 'weather.alert'",
            )
            .get() as { title: string; body_md: string } | undefined;
          assert.ok(row !== undefined, "目的地的预警应推送一条通知");
          assert.match(row.title, /暴雨/);
          assert.match(row.body_md, /100mm/);
          assert.match(row.body_md, /出行模式：上海/);
          const alertCalls = calls.filter((c) => c.url.includes("/weatheralert/v1/current"));
          assert.ok(alertCalls.length > 0);
          assert.ok(
            alertCalls.every((c) => c.url.includes("31.23")),
            `预警巡检应只查目的地坐标，实际 ${alertCalls.map((c) => c.url).join(" | ")}`,
          );
        },
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather 出行模式：脏数据", () => {
  it("settings 里非法 JSON：工具/简报/巡检不崩，show 报告损坏，clear 后可重设", async () => {
    const env = makeTestEnv(ENV);
    try {
      saveLocation(env.db, "default", HOME);
      env.db
        .prepare(
          "INSERT INTO settings (profile_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)",
        )
        .run("default", "travel_plan", "{不是合法 JSON", nowIso());
      await withMockFetch(handlerFor, async (calls) => {
        const current = jsonOf<{ 城市: string; 出行模式?: unknown }>(
          await tool(env, { view: "current" }),
        );
        assert.equal(current.城市, "北京", "损坏的出行计划应被忽略并回退家位置");
        assert.equal(current.出行模式, undefined);

        const show = await tool(env, { view: "travel", action: "show" });
        assert.match(contentOf(show), /出行计划数据损坏/);

        await runDailyBrief();
        const brief = briefRow(env);
        assert.equal(brief.title, "北京 每日简报");
        assert.doesNotMatch(brief.body_md, /出行模式/);

        await runAlertWatch(); // 不应抛错
        assert.ok(calls.length > 0);

        await tool(env, { view: "travel", action: "clear" });
        assert.equal(jsonOf(await tool(env, { view: "travel", action: "show" })), null);

        const reset = await setTravel(env, "上海", -1, 1);
        assert.equal(reset.生效, true, "清除损坏数据后应可重新设置");
        assert.notEqual(travelPlanOf(env), undefined);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("字段缺失/类型不对的计划同样安全忽略，且可被新的 set 覆盖", async () => {
    const env = makeTestEnv(ENV);
    try {
      saveLocation(env.db, "default", HOME);
      setSetting(env.db, "default", "travel_plan", {
        city: "上海",
        start: dayOffset(-1),
        end: dayOffset(1),
      });
      await withMockFetch(handlerFor, async () => {
        const current = jsonOf<{ 城市: string; 出行模式?: unknown }>(
          await tool(env, { view: "current" }),
        );
        assert.equal(current.城市, "北京");
        assert.equal(current.出行模式, undefined);
        assert.match(contentOf(await tool(env, { view: "travel", action: "show" })), /损坏/);

        const reset = await setTravel(env, "上海", -1, 1);
        assert.equal(reset.生效, true);
        const plan = travelPlanOf(env) as { city: string; cityId: string };
        assert.equal(plan.city, "上海");
        assert.equal(plan.cityId, TRAVEL.cityId);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });
});
