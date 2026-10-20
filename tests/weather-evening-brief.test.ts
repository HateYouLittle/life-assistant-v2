import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { importYear } from "../src/core/holiday.js";
import { setPushRoute } from "../src/core/notify.js";
import { allJobs } from "../src/core/registry.js";
import { ensureProfile, setSetting } from "../src/core/settings.js";
import { runEveningBrief } from "../src/modules/weather/index.js";
import { TZ, localToInstant, todayIso } from "../src/time.js";
import {
  cleanupTestEnv,
  localDayStart,
  makeTestEnv,
  v1Daily,
  v1Day,
  type TestEnv,
} from "./helpers.js";

/**
 * A2 回归：21:00 晚报。
 * 全部 stub fetch，不连真实外网；日期一律相对 todayIso() 构造。
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

/** 默认数据源：今天 + 明天两行预报；明天小雨，并带 3.2mm 降水 */
function eveningHandler(url: string): unknown {
  if (url.includes("/geo/v2/city/lookup")) return GEO;
  if (url.includes("/weather/v1/daily")) {
    return v1Daily([
      v1Day({ start: localDayStart(todayIso()) }),
      v1Day({
        start: localDayStart(dayOffset(1)),
        text: "小雨",
        tMax: 28,
        tMin: 20,
        precipDay: 3.2,
      }),
    ]);
  }
  throw new Error(`unexpected url ${url}`);
}

async function withMockFetch(
  handler: (url: string) => unknown,
  fn: () => Promise<void>,
): Promise<{ calls: string[] }> {
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
      json: async () => handler(url),
    } as unknown as Response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
  return { calls };
}

let seq = 0;

/** 与 weather-brief-agenda.test.ts 同款夹具：直接写 schedules + 一条 occurrence */
function seedItem(
  env: TestEnv,
  opts: {
    title: string;
    date: string;
    time?: string;
    profileId?: string;
    occurrenceStatus?: "pending" | "notified";
  },
): void {
  const id = `evening-${++seq}`;
  const time = opts.time ?? "09:00";
  const profileId = opts.profileId ?? "default";
  const ts = new Date().toISOString();
  env.db
    .prepare(
      `INSERT INTO schedules (id, profile_id, title, kind, calendar, start_date, time, all_day,
         remind_offsets_json, workday_filter, status, created_at, updated_at)
       VALUES (?, ?, ?, 'todo', 'solar', ?, ?, 0, '[0]', 'any', 'active', ?, ?)`,
    )
    .run(id, profileId, opts.title, opts.date, time, ts, ts);
  const eventAt = localToInstant(opts.date, time);
  env.db
    .prepare(
      `INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, `${opts.date}T${time}#0`, eventAt, eventAt, opts.occurrenceStatus ?? "pending");
}

interface EveningRow {
  kind: string;
  title: string;
  body_md: string;
  dedupe_key: string | null;
}

function eveningRows(env: TestEnv): EveningRow[] {
  return env.db
    .prepare(
      `SELECT kind, title, body_md, dedupe_key FROM notifications
       WHERE kind = 'weather.evening' ORDER BY created_at, id`,
    )
    .all() as unknown as EveningRow[];
}

describe("weather evening_brief：job 注册", () => {
  it("已注册，cron 走 config（默认 0 21 * * *）", () => {
    const env = makeTestEnv(ENV);
    try {
      const job = allJobs().find((candidate) => candidate.def.name === "evening_brief");
      assert.ok(job !== undefined, "应注册 evening_brief job");
      const cron = typeof job.def.cron === "function" ? job.def.cron() : job.def.cron;
      assert.equal(cron, "0 21 * * *");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("EVENING_BRIEF_CRON 可配置", () => {
    const env = makeTestEnv({ ...ENV, EVENING_BRIEF_CRON: "30 21 * * *" });
    try {
      const job = allJobs().find((candidate) => candidate.def.name === "evening_brief");
      assert.ok(job !== undefined);
      const cron = typeof job.def.cron === "function" ? job.def.cron() : job.def.cron;
      assert.equal(cron, "30 21 * * *");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather evening_brief：内容", () => {
  it("含明日天气/明日日程/今日未完成/补班提示，标题只在 title 字段", async () => {
    const env = makeTestEnv(ENV);
    try {
      const tomorrow = dayOffset(1);
      // 明天 09:00 交房租；昨天 18:00 买菜没做完
      seedItem(env, { title: "交房租", date: tomorrow, time: "09:00" });
      seedItem(env, {
        title: "买菜",
        date: dayOffset(-1),
        time: "18:00",
        occurrenceStatus: "notified",
      });
      // 把明天标成「国庆节的调休上班日」：该年份 metadata 置 ready，dayType 才可信
      importYear(
        env.db,
        {
          year: Number(tomorrow.slice(0, 4)),
          days: [{ name: "国庆节", date: tomorrow, isOffDay: false }],
        },
        "test",
      );
      await withMockFetch(eveningHandler, async () => {
        await runEveningBrief();
      });
      const rows = eveningRows(env);
      assert.equal(rows.length, 1, "晚报应落一条通知");
      const row = rows[0] as EveningRow;
      assert.equal(row.title, "🌙 明日安排");
      assert.equal(row.dedupe_key, `evening:default:${tomorrow}`);
      // 标题只走 title 字段：正文再出现一次会让推送与 pull 各多一行
      assert.doesNotMatch(row.body_md, /🌙 明日安排/);
      assert.match(row.body_md, /\| 明日天气 \| 小雨 20~28°C \|/, `实际正文：\n${row.body_md}`);
      assert.match(row.body_md, /\| 明日日程 \| 09:00 交房租 \|/);
      assert.match(row.body_md, /\| 今日未完成 \| 18:00 买菜（逾期 1 天） \|/);
      assert.match(row.body_md, /⚠️ 明天要补班（国庆节调休）/);
      assert.match(row.body_md, /明天有降水，出门带伞/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("明天是法定假日：措辞「明天休息（国庆节）」，数据未就绪时不猜", async () => {
    const env = makeTestEnv(ENV);
    try {
      const tomorrow = dayOffset(1);
      importYear(
        env.db,
        {
          year: Number(tomorrow.slice(0, 4)),
          days: [{ name: "国庆节", date: tomorrow, isOffDay: true }],
        },
        "test",
      );
      await withMockFetch(eveningHandler, async () => {
        await runEveningBrief();
      });
      assert.match((eveningRows(env)[0] as EveningRow).body_md, /🎉 明天休息（国庆节）/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("节假日数据未就绪：不猜补班/放假，也不因此失败", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(eveningHandler, async () => {
        await runEveningBrief();
      });
      const rows = eveningRows(env);
      assert.equal(rows.length, 1);
      assert.doesNotMatch(rows[0]?.body_md ?? "", /补班|明天休息/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("出行模式生效时标注目的地（与早报同一解析口径）", async () => {
    const env = makeTestEnv(ENV);
    try {
      const today = todayIso();
      const tomorrow = dayOffset(1);
      setSetting(env.db, "default", "travel_plan", {
        city: "上海",
        cityId: "101020100",
        lat: 31.23,
        lon: 121.47,
        start: today,
        end: tomorrow,
      });
      await withMockFetch(eveningHandler, async () => {
        await runEveningBrief();
      });
      const body = (eveningRows(env)[0] as EveningRow).body_md;
      assert.match(body, /\| 出行模式 \| 上海（\d{2}-\d{2}[–-]\d{2}-\d{2}） \|/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("weather evening_brief：去重、过期与降级", () => {
  it("同一天重复触发只发布一次（dedupeKey：evening:<profile>:<明天>）", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(eveningHandler, async () => {
        await runEveningBrief();
        await runEveningBrief();
      });
      assert.equal(eveningRows(env).length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("expiresAt = 明天 12:00（过期不再补投）", async () => {
    const env = makeTestEnv(ENV);
    try {
      setPushRoute(env.db, "default", { channel: "log" });
      await withMockFetch(eveningHandler, async () => {
        await runEveningBrief();
      });
      const row = env.db
        .prepare(
          `SELECT d.expire_at AS expire_at FROM deliveries d
           JOIN notifications n ON n.id = d.notification_id
           WHERE n.kind = 'weather.evening'`,
        )
        .get() as { expire_at: string | null } | undefined;
      assert.ok(row !== undefined, "配了路由应产生投递记录");
      assert.equal(row.expire_at, localToInstant(dayOffset(1), "12:00"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未配置 QWeather：logger.warn 跳过，零发布、零请求", async () => {
    const env = makeTestEnv({});
    try {
      const { calls } = await withMockFetch(
        () => {
          throw new Error("未配置 QWeather 时不应发起任何请求");
        },
        async () => {
          await runEveningBrief();
        },
      );
      assert.equal(calls.length, 0);
      const count = env.db
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'weather.evening'")
        .get() as { n: number };
      assert.equal(count.n, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("明日预报失败：天气写「未知」，日程照常发布", async () => {
    const env = makeTestEnv(ENV);
    try {
      const tomorrow = dayOffset(1);
      seedItem(env, { title: "交房租", date: tomorrow, time: "09:00" });
      await withMockFetch(
        (url) => {
          if (url.includes("/geo/v2/city/lookup")) return GEO;
          // 普通 Error 不会被 qweather 重试（只有 429/5xx 与网络故障才退避）
          if (url.includes("/weather/v1/daily")) throw new Error("HTTP 503");
          throw new Error(`unexpected url ${url}`);
        },
        async () => {
          await runEveningBrief();
        },
      );
      const rows = eveningRows(env);
      assert.equal(rows.length, 1, "预报失败也必须发布年报");
      assert.match(rows[0]?.body_md ?? "", /\| 明日天气 \| 未知 \|/);
      assert.match(rows[0]?.body_md ?? "", /\| 明日日程 \| 09:00 交房租 \|/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("无日程：明日日程/今日未完成写「无」，不崩", async () => {
    const env = makeTestEnv(ENV);
    try {
      await withMockFetch(eveningHandler, async () => {
        await runEveningBrief();
      });
      const body = (eveningRows(env)[0] as EveningRow).body_md;
      assert.match(body, /\| 明日日程 \| 无 \|/);
      assert.match(body, /\| 今日未完成 \| 无 \|/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("没有推送路由的 Profile 仍然 publish（靠 notify.pull 兜底）", async () => {
    const env = makeTestEnv(ENV);
    try {
      ensureProfile(env.db, "pull-only");
      await withMockFetch(eveningHandler, async () => {
        await runEveningBrief();
      });
      const rows = env.db
        .prepare(
          `SELECT profile_id FROM notifications WHERE kind = 'weather.evening' ORDER BY profile_id`,
        )
        .all() as { profile_id: string }[];
      assert.deepEqual(
        rows.map((row) => row.profile_id),
        ["default", "pull-only"],
        "所有 Profile 都应落通知（无路由也要能 pull 到）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});
