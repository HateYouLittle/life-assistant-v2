import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { allJobs } from "../src/core/registry.js";
import { cancelPendingDrain, drainDue, setPushRoute } from "../src/core/notify.js";
import {
  resetQweatherStateForTests,
  saveLocation,
  setQweatherDepsForTests,
} from "../src/core/qweather.js";
import { setSetting } from "../src/core/settings.js";
import { runAlertWatch } from "../src/modules/weather/index.js";
import { cleanupTestEnv, makeTestEnv, SECRET, type TestEnv } from "./helpers.js";

/**
 * 阶段 C1：气象预警主动推送（job alert_watch）。
 * 全部注入假 fetch，绝不打真实外网；时间相关的用例使用确定性的边界时刻。
 */

const BASE_ENV = {
  QWEATHER_API_HOST: "test.example.com",
  QWEATHER_KEY: "test-key",
  DEFAULT_CITY: "北京",
};

const FUTURE = "2999-01-01T00:00+08:00";
/** 归一化后 QWeather 时间统一落 UTC ISO（Z 结尾），与 nowIso() 同格式才可比较 */
const FUTURE_UTC = new Date(FUTURE).toISOString();

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: null,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function geoResult(city: string): { id: string; lat: string; lon: string } {
  return city === "上海"
    ? { id: "101020100", lat: "31.23", lon: "121.47" }
    : { id: "101010100", lat: "39.90", lon: "116.41" };
}

function geoBody(url: string): unknown {
  const city = new URL(url).searchParams.get("location") ?? "";
  const loc = geoResult(city);
  return { code: "200", location: [{ id: loc.id, lat: loc.lat, lon: loc.lon }] };
}

/** 由 alerts 结果构造响应；geo 按城市返回不同坐标，便于多 Profile 隔离 */
function responderFor(
  alertsResult: () => { body: unknown; status?: number },
): (url: string) => Response {
  return (url) => {
    if (url.includes("/geo/v2/city/lookup")) return jsonResponse(geoBody(url));
    if (url.includes("/weatheralert/v1/current")) {
      const r = alertsResult();
      return jsonResponse(r.body, r.status ?? 200);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

async function withFetch(
  responder: (url: string) => Response,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return responder(url);
  }) as unknown as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function alert(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "a1",
    eventType: { name: "暴雨" },
    color: { code: "red" },
    severity: "extreme",
    effectiveTime: "2026-09-18T10:00+08:00",
    expireTime: FUTURE,
    headline: "暴雨红色预警",
    description: "预计累计降雨量 100mm",
    ...overrides,
  };
}

function alertBody(...alerts: Record<string, unknown>[]): { code: string; alerts: unknown[] } {
  return { code: "200", alerts };
}

/** 建环境；profiles 里的每个 Profile 都会配上启用路由 */
function makeEnv(extraEnv: Record<string, string> = {}, ...profiles: string[]): TestEnv {
  const env = makeTestEnv({ ...BASE_ENV, ...extraEnv });
  for (const id of profiles) {
    env.db
      .prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)")
      .run(id, new Date().toISOString());
    setPushRoute(env.db, id, { url: "http://127.0.0.1:9/hook" });
  }
  return env;
}

interface NotifRow {
  id: string;
  kind: string;
  dedupe_key: string | null;
  title: string;
  body_md: string;
}

function notifications(env: TestEnv, profileId: string): NotifRow[] {
  return env.db
    .prepare(
      "SELECT id, kind, dedupe_key, title, body_md FROM notifications WHERE profile_id = ? ORDER BY created_at, id",
    )
    .all(profileId) as unknown as NotifRow[];
}

/** 覆盖当前时刻的静默窗口（Asia/Shanghai 小时粒度） */
function currentQuietWindow(): { start: string; end: string } {
  const cst = new Date(Date.now() + 8 * 3600_000);
  const h = cst.getUTCHours();
  const fmt = (x: number): string => `${String((x + 24) % 24).padStart(2, "0")}:00`;
  return { start: fmt(h - 1), end: fmt(h + 2) };
}

beforeEach(() => {
  resetQweatherStateForTests();
});

describe("weather alert_watch：job 注册", () => {
  it("已注册，且 cron 走 config（默认每 20 分钟）", () => {
    const env = makeEnv();
    try {
      const job = allJobs().find((j) => j.def.name === "alert_watch");
      assert.ok(job !== undefined, "应注册 alert_watch job");
      const cron = typeof job.def.cron === "function" ? job.def.cron() : job.def.cron;
      assert.equal(cron, "*/20 * * * *");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather alert_watch：命中与去重", () => {
  it("命中就推：红色预警生成 1 条 weather.alert 通知，标题含类型与级别", async () => {
    const env = makeEnv({}, "default");
    try {
      await withFetch(
        responderFor(() => ({ body: alertBody(alert()) })),
        async () => {
          await runAlertWatch();
        },
      );
      const rows = notifications(env, "default");
      assert.equal(rows.length, 1);
      const row = rows[0] as NotifRow;
      assert.equal(row.kind, "weather.alert");
      assert.equal(row.title, "⚠️ 气象预警：暴雨 红色");
      assert.equal(row.dedupe_key, "weather.alert:a1:红色");
      // 标题只在 title 字段：body_md 不得再出现整条标题
      assert.doesNotMatch(row.body_md, /⚠️ 气象预警：暴雨 红色/);
      assert.match(row.body_md, /\| 级别 \| 类型 \| 生效 \| 失效 \| 说明 \|/);
      assert.match(row.body_md, /100mm/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同预警重复检查不重复推：清掉缓存重跑仍是 1 条（dedupe 生效）", async () => {
    const env = makeEnv({}, "default");
    try {
      await withFetch(
        responderFor(() => ({ body: alertBody(alert()) })),
        async () => {
          await runAlertWatch();
          env.db.exec("DELETE FROM cache"); // 强制第二次重新请求上游
          await runAlertWatch();
        },
      );
      assert.equal(notifications(env, "default").length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("反向断言：同 id 级别升级（黄→橙）必须再推一条", async () => {
    const env = makeEnv({}, "default");
    try {
      let body = alertBody(alert({ color: { code: "yellow" } }));
      await withFetch(
        responderFor(() => ({ body })),
        async () => {
          await runAlertWatch();
          env.db.exec("DELETE FROM cache");
          body = alertBody(alert({ color: { code: "orange" } }));
          await runAlertWatch();
        },
      );
      const rows = notifications(env, "default");
      assert.equal(rows.length, 2, "级别升级应产生第 2 条通知");
      assert.deepEqual(rows.map((r) => r.title).sort(), [
        "⚠️ 气象预警：暴雨 橙色",
        "⚠️ 气象预警：暴雨 黄色",
      ]);
      assert.deepEqual(rows.map((r) => r.dedupe_key).sort(), [
        "weather.alert:a1:橙色",
        "weather.alert:a1:黄色",
      ]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("无 id 的预警用标题构造去重键，不同预警不互相覆盖", async () => {
    const env = makeEnv({}, "default");
    try {
      await withFetch(
        responderFor(() => ({
          body: alertBody(
            alert({ id: "", headline: "预警甲", color: { code: "blue" } }),
            alert({ id: "", headline: "预警乙", color: { code: "yellow" } }),
          ),
        })),
        async () => {
          await runAlertWatch();
        },
      );
      const rows = notifications(env, "default");
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.dedupe_key).sort(), [
        "weather.alert:title:预警乙:黄色",
        "weather.alert:title:预警甲:蓝色",
      ]);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather alert_watch：级别与时效过滤", () => {
  it("低于阈值跳过：ALERT_MIN_LEVEL=orange 时蓝/黄不推、橙推", async () => {
    const env = makeEnv({ ALERT_MIN_LEVEL: "orange" }, "default");
    try {
      await withFetch(
        responderFor(() => ({
          body: alertBody(
            alert({ id: "b", color: { code: "blue" } }),
            alert({ id: "y", color: { code: "yellow" } }),
            alert({ id: "o", color: { code: "orange" } }),
          ),
        })),
        async () => {
          await runAlertWatch();
        },
      );
      const rows = notifications(env, "default");
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.dedupe_key, "weather.alert:o:橙色");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("无法识别或为空的级别按最高优先级处理（阈值 red 也推，且不留空括号）", async () => {
    const env = makeEnv({ ALERT_MIN_LEVEL: "red" }, "default");
    try {
      await withFetch(
        responderFor(() => ({
          body: alertBody(
            alert({ id: "u", color: { code: "紫色" } }),
            alert({ id: "e", color: undefined, severity: "unknown", eventType: { name: "高温" } }),
          ),
        })),
        async () => {
          await runAlertWatch();
        },
      );
      const rows = notifications(env, "default");
      assert.equal(rows.length, 2);
      const byKey = new Map(rows.map((r) => [r.dedupe_key, r.title]));
      assert.equal(byKey.get("weather.alert:u:紫色"), "⚠️ 气象预警：暴雨 紫色");
      assert.equal(byKey.get("weather.alert:e:"), "⚠️ 气象预警：高温");
      for (const title of byKey.values()) assert.doesNotMatch(title, /（）|\s$/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("过期预警跳过：endsAt 早于当前时刻不推，无 endsAt 保留", async (t) => {
    t.mock.timers.enable({ apis: ["Date"] });
    t.mock.timers.setTime(Date.parse("2026-09-18T12:00:00+08:00"));
    const env = makeEnv({}, "default");
    try {
      await withFetch(
        responderFor(() => ({
          body: alertBody(
            alert({ id: "old", expireTime: "2026-09-18T11:00+08:00" }),
            alert({ id: "active", expireTime: "2026-09-18T13:00+08:00" }),
            alert({ id: "noend", expireTime: undefined }),
          ),
        })),
        async () => {
          await runAlertWatch();
        },
      );
      assert.deepEqual(
        notifications(env, "default")
          .map((r) => r.dedupe_key)
          .sort(),
        ["weather.alert:active:红色", "weather.alert:noend:红色"],
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather alert_watch：投递截止时刻", () => {
  function expireAtOf(env: TestEnv): string | null {
    const row = env.db.prepare("SELECT expire_at FROM deliveries").get() as
      | { expire_at: string | null }
      | undefined;
    assert.ok(row !== undefined, "配了路由 + secret 就该落投递记录");
    return row.expire_at;
  }

  it("预警的失效时刻写入投递截止（静默时段结束后不再补投）", async () => {
    const env = makeEnv(
      { PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) },
      "default",
    );
    try {
      await withFetch(
        responderFor(() => ({ body: alertBody(alert()) })),
        async () => {
          await runAlertWatch();
        },
      );
      assert.equal(
        expireAtOf(env),
        FUTURE_UTC,
        "endsAt 必须归一化为 UTC 后落到 deliveries.expire_at 上",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("没有失效时间的预警不设截止（不误杀）", async () => {
    const env = makeEnv(
      { PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) },
      "default",
    );
    try {
      await withFetch(
        responderFor(() => ({ body: alertBody(alert({ expireTime: undefined })) })),
        async () => {
          await runAlertWatch();
        },
      );
      assert.equal(expireAtOf(env), null);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather alert_watch：静默与失败路径", () => {
  it("无预警：静默跳过，不产生任何通知", async () => {
    const env = makeEnv({}, "default");
    try {
      await withFetch(
        responderFor(() => ({ body: alertBody() })),
        async () => {
          await runAlertWatch();
        },
      );
      assert.equal(notifications(env, "default").length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("上游 HTTP 500：不产生通知，job 不抛错", async () => {
    setQweatherDepsForTests({ maxAttempts: 1 });
    const env = makeEnv({}, "default");
    try {
      await withFetch(
        responderFor(() => ({ body: {}, status: 500 })),
        async () => {
          await runAlertWatch();
        },
      );
      assert.equal(notifications(env, "default").length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("QWeather 业务错误码：不产生通知，job 不抛错", async () => {
    setQweatherDepsForTests({ maxAttempts: 1 });
    const env = makeEnv({}, "default");
    try {
      await withFetch(
        responderFor(() => ({ body: { code: "500" } })),
        async () => {
          await runAlertWatch();
        },
      );
      assert.equal(notifications(env, "default").length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("单个 Profile 失败不影响其它 Profile", async () => {
    setQweatherDepsForTests({ maxAttempts: 1 });
    const env = makeEnv({}, "p1", "p2");
    try {
      saveLocation(env.db, "p1", {
        city: "上海",
        cityId: "101020100",
        lat: 31.23,
        lon: 121.47,
      });
      saveLocation(env.db, "p2", { city: "北京", cityId: "101010100", lat: 39.9, lon: 116.41 });
      await withFetch(
        (url) => {
          if (url.includes("/geo/v2/city/lookup")) return jsonResponse(geoBody(url));
          // 北京坐标（p2）失败；上海坐标（p1）成功
          if (url.includes("39.90")) return jsonResponse({ code: "500" });
          return jsonResponse(alertBody(alert()));
        },
        async () => {
          await runAlertWatch();
        },
      );
      assert.equal(notifications(env, "p1").length, 1);
      assert.equal(notifications(env, "p2").length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("静默时段不被绕过：通知照常入队，投递层拦截且零 webhook 调用", async () => {
    const env = makeEnv(
      { PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ default: SECRET }) },
      "default",
    );
    try {
      setSetting(env.db, "default", "quiet_hours", currentQuietWindow());
      await withFetch(
        responderFor(() => ({ body: alertBody(alert()) })),
        async () => {
          await runAlertWatch();
        },
      );
      cancelPendingDrain();

      // 通知与投递行都照常落库（实现里没有「预警跳过静默」的分支）
      const notif = env.db
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'weather.alert'")
        .get() as { n: number };
      assert.equal(notif.n, 1);

      // 手动触发投递：静默时段应拦截，绝不发出任何 webhook
      let calls = 0;
      const original = globalThis.fetch;
      globalThis.fetch = (async () => {
        calls += 1;
        throw new Error("静默时段不应发起投递");
      }) as unknown as typeof fetch;
      try {
        await drainDue(env.db, env.config);
      } finally {
        globalThis.fetch = original;
      }
      assert.equal(calls, 0, "静默时段不得被绕过");
      const delivery = env.db.prepare("SELECT status FROM deliveries").get() as { status: string };
      assert.equal(delivery.status, "queued", "静默时段投递应停在 queued，而不是 sent");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather alert_watch：多 Profile 与位置", () => {
  it("多 Profile 隔离：各推各的，互不串台", async () => {
    const env = makeEnv({}, "p1", "p2");
    try {
      saveLocation(env.db, "p1", {
        city: "上海",
        cityId: "101020100",
        lat: 31.23,
        lon: 121.47,
      });
      saveLocation(env.db, "p2", { city: "北京", cityId: "101010100", lat: 39.9, lon: 116.41 });
      await withFetch(
        responderFor(() => ({ body: alertBody(alert()) })),
        async () => {
          await runAlertWatch();
        },
      );
      assert.equal(notifications(env, "p1").length, 1);
      assert.equal(notifications(env, "p2").length, 1);
      assert.equal(notifications(env, "p1")[0]?.dedupe_key, "weather.alert:a1:红色");
      assert.equal(notifications(env, "p2")[0]?.dedupe_key, "weather.alert:a1:红色");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("多 Profile 隔离：一个 Profile 命中、另一个不命中时不串台", async () => {
    const env = makeEnv({}, "p1", "p2");
    try {
      saveLocation(env.db, "p1", {
        city: "上海",
        cityId: "101020100",
        lat: 31.23,
        lon: 121.47,
      });
      saveLocation(env.db, "p2", { city: "北京", cityId: "101010100", lat: 39.9, lon: 116.41 });
      await withFetch(
        (url) => {
          if (url.includes("/geo/v2/city/lookup")) return jsonResponse(geoBody(url));
          // 上海坐标 → 有预警；北京坐标 → 无预警
          return jsonResponse(url.includes("31.23") ? alertBody(alert()) : alertBody());
        },
        async () => {
          await runAlertWatch();
        },
      );
      assert.equal(notifications(env, "p1").length, 1);
      assert.equal(notifications(env, "p2").length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("位置缺省：Profile 未设位置时用 DEFAULT_CITY，不崩", async () => {
    const env = makeEnv({}, "default");
    try {
      const geoCities: string[] = [];
      await withFetch(
        (url) => {
          if (url.includes("/geo/v2/city/lookup")) {
            geoCities.push(new URL(url).searchParams.get("location") ?? "");
            return jsonResponse(geoBody(url));
          }
          return jsonResponse(alertBody(alert()));
        },
        async () => {
          await runAlertWatch();
        },
      );
      assert.deepEqual(geoCities, ["北京"], "未设位置时应回落到 DEFAULT_CITY");
      assert.equal(notifications(env, "default").length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("无路由 Profile 也会落一条通知（供 pull 兜底），但不产生可投递记录", async () => {
    const env = makeTestEnv({
      ...BASE_ENV,
      PROFILE_ROUTE_SECRETS_JSON: JSON.stringify({ routed: SECRET }),
    });
    try {
      env.db
        .prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)")
        .run("routed", new Date().toISOString());
      env.db
        .prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)")
        .run("plain", new Date().toISOString());
      setPushRoute(env.db, "routed", { url: "http://127.0.0.1:9/hook" });
      await withFetch(
        responderFor(() => ({ body: alertBody(alert()) })),
        async () => {
          await runAlertWatch();
        },
      );
      cancelPendingDrain();

      const deliveries = (profileId: string): number =>
        (
          env.db
            .prepare(
              "SELECT COUNT(*) AS n FROM deliveries d JOIN notifications n ON n.id = d.notification_id WHERE n.profile_id = ?",
            )
            .get(profileId) as { n: number }
        ).n;

      // 遍历口径与每日简报一致（listProfiles）：无路由的 Profile 也保留通知，供 notify.pull 兜底
      assert.equal(notifications(env, "routed").length, 1);
      assert.equal(notifications(env, "plain").length, 1);
      assert.equal(notifications(env, "default").length, 1);

      // 只有配置了启用路由（且有 secret）的 Profile 才产生可投递记录
      assert.ok(deliveries("routed") >= 1);
      assert.equal(deliveries("plain"), 0);
      assert.equal(deliveries("default"), 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
