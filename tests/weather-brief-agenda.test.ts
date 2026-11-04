import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { runDailyBrief } from "../src/modules/weather/index.js";
import { TZ, localToInstant, todayIso } from "../src/time.js";
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
 * 早报（手机精简版）：天气一行 + 今天的待办一行 + 7 天内生日/纪念日一行 + 补班/假期一行，
 * 没有内容的行整行省略。
 *
 * 夹具直接向 schedules / occurrences 写行（与 schedule 服务物化后的形态一致：
 * occurrence_key = `<本地日期>T<时刻>#<偏移下标>`、event_at = 该时刻的 UTC 瞬间），
 * 这样不必依赖服务层的事务时序，也能精确构造逾期与截断场景。
 * 所有日期相对 todayIso() 构造，CI 跑在任何日期都成立。
 */

const ENV = {
  QWEATHER_API_HOST: "test.example.com",
  QWEATHER_KEY: "test-key",
  DEFAULT_CITY: "北京",
};

const GEO = { code: "200", location: [{ id: "101010100", lat: "39.90", lon: "116.41" }] };

function dayOffset(n: number): string {
  return DateTime.fromISO(todayIso(), { zone: TZ }).plus({ days: n }).toISODate() ?? "";
}

function handlerFor(url: string): unknown {
  if (url.includes("/geo/v2/city/lookup")) return GEO;
  if (url.includes("/weather/v1/current")) return v1Current();
  if (url.includes("/weather/v1/daily")) {
    return v1Daily([
      v1Day({ start: localDayStart(todayIso()) }),
      v1Day({ start: localDayStart(dayOffset(1)) }),
    ]);
  }
  if (url.includes("/weatheralert/v1/current")) return { code: "200", alerts: [] };
  if (url.includes("/airquality/v1/current")) {
    return { indexes: [{ code: "cn-mee", aqi: 42, category: "优" }], pollutants: [] };
  }
  throw new Error(`unexpected url ${url}`);
}

async function withMockFetch(fn: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return {
      ok: true,
      status: 200,
      body: null,
      json: async () => handlerFor(url),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

let seq = 0;

/**
 * 向库中种一条日程 + 一条对应的 occurrence。
 * status 用 pending/notified 都能被 agendaForDate 视作「未结束」；这里默认 pending。
 */
function seedItem(
  env: TestEnv,
  opts: {
    title: string;
    date: string;
    time?: string;
    allDay?: boolean;
    occurrenceStatus?: "pending" | "notified" | "done" | "cancelled";
    scheduleStatus?: "active" | "done" | "cancelled";
    kind?: "todo" | "birthday" | "anniversary";
  },
): void {
  const id = `agenda-${++seq}`;
  const time = opts.time ?? "09:00";
  const ts = new Date().toISOString();
  env.db
    .prepare(
      `INSERT INTO schedules (id, profile_id, title, kind, calendar, start_date, time, all_day,
         remind_offsets_json, workday_filter, status, created_at, updated_at)
       VALUES (?, 'default', ?, ?, 'solar', ?, ?, ?, '[0]', 'any', ?, ?, ?)`,
    )
    .run(
      id,
      opts.title,
      opts.kind ?? "todo",
      opts.date,
      time,
      opts.allDay === true ? 1 : 0,
      opts.scheduleStatus ?? "active",
      ts,
      ts,
    );
  const eventAt = localToInstant(opts.date, time);
  env.db
    .prepare(
      `INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, `${opts.date}T${time}#0`, eventAt, eventAt, opts.occurrenceStatus ?? "pending");
}

function briefBody(env: TestEnv): string {
  const row = env.db
    .prepare(
      "SELECT body_md FROM notifications WHERE profile_id = 'default' AND kind = 'weather.brief'",
    )
    .get() as { body_md: string } | undefined;
  assert.ok(row !== undefined, "早报应落一条通知");
  return row.body_md;
}

describe("每日简报：今日日程（手机精简版）", () => {
  it("有条目：一行「📌 今天：…」，时刻/全天两种格式；平常日子不加「适宜出行」之类的废话", async () => {
    const env = makeTestEnv(ENV);
    try {
      seedItem(env, { title: "喝水", date: todayIso(), time: "09:00" });
      seedItem(env, { title: "交房租", date: todayIso(), time: "08:00", allDay: true });
      await withMockFetch(async () => {
        await runDailyBrief();
      });
      const body = briefBody(env);
      assert.match(body, /^📌 今天：交房租、09:00 喝水$/m);
      assert.doesNotMatch(body, /适宜出行|逾期/);
      assert.ok(body.split("\n").length <= 4, `早报最多 4 行：\n${body}`);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("无条目：整行省略，不写「无」", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(async () => {
        await runDailyBrief();
      });
      const body = briefBody(env);
      assert.doesNotMatch(body, /今天：|无/);
      assert.equal(body.split("\n").length, 1, `只剩天气一行：\n${body}`);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("逾期条目不进早报（循环待办已作废，一次性/截止型由各自的提醒追）", async () => {
    const env = makeTestEnv(ENV);
    try {
      seedItem(env, {
        title: "交房租",
        date: dayOffset(-3),
        time: "09:00",
        occurrenceStatus: "notified",
      });
      seedItem(env, { title: "喝水", date: todayIso(), time: "09:00" });
      await withMockFetch(async () => {
        await runDailyBrief();
      });
      const body = briefBody(env);
      assert.match(body, /^📌 今天：09:00 喝水$/m);
      assert.doesNotMatch(body, /交房租|逾期/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("超过 4 条：只列前 4 条并写「等 N 项」", async () => {
    const env = makeTestEnv(ENV);
    try {
      for (let i = 1; i <= 6; i += 1) {
        seedItem(env, {
          title: `事项${i}`,
          date: todayIso(),
          time: `08:0${i - 1}`,
        });
      }
      await withMockFetch(async () => {
        await runDailyBrief();
      });
      const body = briefBody(env);
      assert.match(body, /事项4 等 6 项$/m);
      assert.doesNotMatch(body, /事项5|事项6/, "超出 4 条的条目不应出现在正文里");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("schedule 查询抛错：只跳过日程行，早报仍然发布", async () => {
    const env = makeTestEnv(ENV);
    try {
      // 直接删表模拟 schedule 模块的只读查询故障：agendaForDate 会抛「no such table」
      env.db.exec("DROP TABLE occurrences; DROP TABLE schedules;");
      await withMockFetch(async () => {
        await runDailyBrief();
      });
      const body = briefBody(env);
      assert.match(body, /空气优/, "天气内容应照常送达");
      assert.doesNotMatch(body, /今天：/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("每日简报：近期生日/纪念日", () => {
  it("7 天内有生日：追加「🎂 …」行（含当天、按日期升序），更远的不提", async () => {
    const env = makeTestEnv(ENV);
    try {
      seedItem(env, { title: "妈妈生日", date: dayOffset(5), allDay: true, kind: "birthday" });
      seedItem(env, { title: "妹妹生日", date: todayIso(), allDay: true, kind: "birthday" });
      seedItem(env, { title: "下周末生日", date: dayOffset(10), allDay: true, kind: "birthday" });
      await withMockFetch(async () => {
        await runDailyBrief();
      });
      const body = briefBody(env);
      const line = body.split("\n").find((l) => l.startsWith("🎂"));
      assert.ok(line !== undefined, body);
      assert.match(line, /妹妹生日（今天）.*妈妈生日（还有 5 天）/);
      assert.ok(!line.includes("下周末生日"));
      assert.doesNotMatch(body, /📌/, "生日不算「今天的待办」");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("7 天内没有：整行省略", async () => {
    const env = makeTestEnv(ENV);
    try {
      seedItem(env, { title: "喝水", date: todayIso(), time: "09:00" });
      await withMockFetch(async () => {
        await runDailyBrief();
      });
      assert.ok(!briefBody(env).includes("🎂"));
    } finally {
      cleanupTestEnv(env);
    }
  });
});
