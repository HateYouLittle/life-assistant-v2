import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allTools, type ToolContext } from "../src/core/registry.js";
import { weatherTool } from "../src/modules/weather/index.js";
import { todayIso } from "../src/time.js";
import {
  cleanupTestEnv,
  localDayStart,
  makeTestEnv,
  SECRET,
  v1Current,
  v1Daily,
  v1Day,
  type TestEnv,
} from "./helpers.js";

/**
 * 功能 P2-20 回归：参数化统一（action 为规范名，view 为兼容别名）+ 空气质量单一实现。
 * 覆盖：① air_quality / view=air / action=air 三路输出逐字一致；② action 与 view 等价；
 * ③ 同时传且冲突 → 明确报错；④ 未知取值统一 `未知 action: …` 前缀；
 * ⑤ 既有 travel（view=travel + action=set/show/clear）语义不变。
 */

const ENV = {
  QWEATHER_API_HOST: "test.example.com",
  QWEATHER_KEY: "test-key",
  DEFAULT_CITY: "北京",
  PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }),
};

const GEO = { code: "200", location: [{ id: "101020100", lat: "31.23", lon: "121.47" }] };

function handlerFor(url: string): unknown {
  if (url.includes("/geo/v2/city/lookup")) return GEO;
  if (url.includes("/weather/v1/current")) return v1Current();
  if (url.includes("/weather/v1/daily")) {
    return v1Daily([v1Day({ start: localDayStart(todayIso()) })]);
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

async function withMockFetch<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return {
      ok: true,
      status: 200,
      json: async () => handlerFor(url),
      body: null,
    } as unknown as Response;
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function ctxOf(env: TestEnv): ToolContext {
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

function tool(env: TestEnv, args: Record<string, unknown>) {
  return weatherTool(args, ctxOf(env));
}

function textOf(result: unknown): string {
  return ((result as { content: { text: string }[] }).content[0]?.text ?? "").trim();
}

function isErrorOf(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function airQualityTool() {
  const def = allTools().find((t) => t.def.name === "air_quality")?.def;
  assert.ok(def !== undefined, "应注册 air_quality 工具");
  return def;
}

describe("P2-20 空气质量单一实现", () => {
  it("air_quality / view=air / action=air 三路输出逐字一致", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(async () => {
        const viaView = textOf(await tool(env, { view: "air", city: "上海" }));
        const viaAction = textOf(await tool(env, { action: "air", city: "上海" }));
        const viaTool = textOf(await airQualityTool().handler({ city: "上海" }, ctxOf(env)));
        // 逐字一致：三路必须走同一份实现，任何一路单独改口径都会在这里变红
        assert.equal(viaAction, viaView, "action=air 与 view=air 输出应逐字一致");
        assert.equal(viaTool, viaView, "air_quality 与 weather view=air 输出应逐字一致");
        const payload = JSON.parse(viaView) as { 城市: string; 空气质量: { rows: string[][] } };
        assert.equal(payload.城市, "上海");
        assert.deepEqual(
          payload.空气质量.rows.find((r) => r[0] === "AQI（国标）"),
          ["AQI（国标）", "42（优）"],
        );
      });
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("P2-20 action/view 兼容", () => {
  it("action 与 view 等价（current / forecast / alert / air）", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(async () => {
        for (const view of ["current", "forecast", "alert", "air"]) {
          const viaView = textOf(await tool(env, { view, city: "上海" }));
          const viaAction = textOf(await tool(env, { action: view, city: "上海" }));
          assert.equal(viaAction, viaView, `${view}: action 与 view 应等价`);
        }
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("action 与 view 同时传且一致时正常工作", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(async () => {
        const both = textOf(await tool(env, { action: "current", view: "current", city: "上海" }));
        const single = textOf(await tool(env, { view: "current", city: "上海" }));
        assert.equal(both, single);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("action 与 view 冲突 → 明确报错，不静默取其一", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(async () => {
        const cases: Array<[string, Record<string, unknown>]> = [
          ["两个视图名不同", { action: "air", view: "current", city: "上海" }],
          ["子操作隐含 travel 与 view 冲突", { action: "set", view: "air", city: "上海" }],
          ["view=travel 但 action 指向别的视图", { view: "travel", action: "current" }],
        ];
        for (const [why, args] of cases) {
          const result = await tool(env, args);
          assert.equal(isErrorOf(result), true, `${why} 应被拒绝`);
          assert.match(textOf(result), /冲突/, `${why} 应报「冲突」`);
        }
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未知取值统一 `未知 action: …`；两者都不给明确报缺", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(async () => {
        for (const args of [
          { view: "bogus" },
          { action: "bogus" },
          { action: "bogus", view: "bogus" },
        ]) {
          const result = await tool(env, args);
          assert.equal(isErrorOf(result), true, `${JSON.stringify(args)} 应被拒绝`);
          assert.match(
            textOf(result),
            /^错误：未知 action: bogus$/,
            "未知分支前缀应与其它工具一致",
          );
        }
        const empty = await tool(env, {});
        assert.equal(isErrorOf(empty), true);
        assert.match(textOf(empty), /缺少 action/);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("既有 travel 写法不变：view=travel+action=set/show/clear 与 action 规范名等价", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(async () => {
        const start = todayIso();
        const end = todayIso();
        const viaLegacy = await tool(env, {
          view: "travel",
          action: "set",
          city: "上海",
          start,
          end,
        });
        assert.equal(isErrorOf(viaLegacy), false, textOf(viaLegacy));
        const legacyShow = textOf(await tool(env, { view: "travel", action: "show" }));
        // action 规范名形式：action=show 隐含 view=travel
        assert.equal(textOf(await tool(env, { action: "show" })), legacyShow);
        assert.equal(
          textOf(await tool(env, { action: "clear" })),
          textOf(await tool(env, { view: "travel", action: "clear" })),
        );
        // 清掉后再 show 应回到 null（证明 clear 真的生效）
        assert.equal(textOf(await tool(env, { action: "show" })), "null");
        // 只给 view=travel 不给子操作：仍按既有文案报错
        const missingOp = await tool(env, { view: "travel" });
        assert.equal(isErrorOf(missingOp), true);
        assert.match(textOf(missingOp), /set\/clear\/show/);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("必填参数表集中校验：locate 缺 city、travel set 缺 start/end", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(async () => {
        const noCity = await tool(env, { action: "locate" });
        assert.equal(isErrorOf(noCity), true);
        assert.match(textOf(noCity), /locate 需要 city 参数/);

        const noDates = await tool(env, { action: "set", city: "上海" });
        assert.equal(isErrorOf(noDates), true);
        assert.match(textOf(noDates), /start\/end/);

        const blankCity = await tool(env, { action: "locate", city: "   " });
        assert.equal(isErrorOf(blankCity), true);
        assert.match(textOf(blankCity), /locate 需要 city 参数/);
      });
    } finally {
      cleanupTestEnv(env);
    }
  });
});
