import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import * as vm from "node:vm";
import { DateTime } from "luxon";
import { resolveToken, statusPage } from "../src/server/page.js";
import { createStatusApp, statusPayload } from "../src/server/status.js";
import { allJobs } from "../src/core/registry.js";
import { TZ, todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";
// 副作用 import：注册全部模块，/api/jobs 才有 job 清单（与 daemon 同一份注册表）
import "../src/modules/index.js";

function app(env: TestEnv) {
  return createStatusApp(env.config, env.db);
}

describe("看板 token 引导", () => {
  interface Store {
    raw: Map<string, string>;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  }

  function memoryStore(): Store {
    const raw = new Map<string, string>();
    return {
      raw,
      getItem: (key) => raw.get(key) ?? null,
      setItem: (key, value) => {
        raw.set(key, value);
      },
    };
  }

  it("?token= 落到 localStorage 并在后续访问复用", () => {
    const store = memoryStore();
    assert.equal(resolveToken("?token=abc123", store), "abc123");
    assert.equal(
      store.getItem("web_api_token"),
      "abc123",
      "token 必须落盘，否则下一次刷新又变 401",
    );
    assert.equal(resolveToken("", store), "abc123", "无 URL 参数时应回落到已存凭据");
    assert.equal(resolveToken("?month=2026-09", store), "abc123");
  });

  it("空 token 不写存储（否则会把可用凭据覆盖成空串）", () => {
    const store = memoryStore();
    store.setItem("web_api_token", "keep");
    assert.equal(resolveToken("?token=", store), "keep");
    assert.equal(store.getItem("web_api_token"), "keep");
  });

  it("页面内联的引导脚本可直接执行（插值写坏会让整屏加载不出来）", () => {
    const html = statusPage("2.0.0");
    const source = /var token = \(([\s\S]*)\)\(location\.search,\s*localStorage\)/.exec(html)?.[1];
    assert.ok(source !== undefined, "页面脚本应内联 token 引导");
    const bootstrap = vm.runInNewContext(`(${source})`, { URLSearchParams }) as (
      search: string,
      store: Store,
    ) => string | null;
    const store = memoryStore();
    assert.equal(bootstrap("?token=xyz", store), "xyz");
    assert.equal(store.getItem("web_api_token"), "xyz");
  });

  it("地址栏里的 token 用完即抹", () => {
    assert.match(statusPage("2.0.0"), /history\.replaceState/);
  });

  it("端到端：开着 token 时 /?token=X 打开页面 → 页面拿到凭据 → 数据接口放行", async () => {
    const secret = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: secret, HOST: "0.0.0.0" });
    try {
      const a = app(env);
      assert.equal((await a.request("/api/status")).status, 401, "无凭据时数据接口必须拒绝");

      const search = `?token=${secret}`;
      const page = await a.request(`/${search}`);
      assert.equal(page.status, 200, "静态页不鉴权，靠页面脚本用凭据换数据");
      const source = /var token = \(([\s\S]*)\)\(location\.search,\s*localStorage\)/.exec(
        await page.text(),
      )?.[1];
      assert.ok(source !== undefined, "页面脚本应内联 token 引导");
      const token = (
        vm.runInNewContext(`(${source})`, { URLSearchParams }) as (
          s: string,
          st: Store,
        ) => string | null
      )(search, memoryStore());
      assert.equal(token, secret);

      const status = await a.request("/api/status", {
        headers: { Authorization: `Bearer ${token ?? ""}` },
      });
      assert.equal(status.status, 200, "页面引导出的凭据必须能取到数据");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("状态接口", () => {
  it("/api/status 输出关键计数", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '日用', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      // spent_on 是 Asia/Shanghai 本地日历日，不能用 toISOString()（UTC）：
      // 本地 00:00-08:00 期间 UTC 仍是昨天，会落到月初之前让计数恒为 0
      env.db
        .prepare(
          "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES ('e1','l1',12345,?, 'default', '2026-01-01T00:00:00.000Z')",
        )
        .run(todayIso());
      const payload = statusPayload(env.config, env.db);
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.profiles, ["default"]);
      const ledgers = payload.ledgers as { total: number };
      assert.equal(ledgers.total, 1);
      const expenses = payload.expenses as { month_cents: number };
      assert.equal(expenses.month_cents, 12345);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("安全响应头：nosniff / no-referrer / 禁内嵌，/api/* 一律不可缓存", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      const a = app(env);
      const api = await a.request("/api/status", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(api.status, 200);
      assert.equal(api.headers.get("cache-control"), "no-store", "个人数据不得进浏览器/代理缓存");
      assert.equal(api.headers.get("x-content-type-options"), "nosniff");
      assert.equal(api.headers.get("referrer-policy"), "no-referrer");
      assert.equal(api.headers.get("x-frame-options"), "DENY");

      const denied = await a.request("/api/status");
      assert.equal(denied.status, 401);
      assert.equal(denied.headers.get("x-content-type-options"), "nosniff", "401 也要带安全头");

      const page = await a.request("/");
      assert.equal(page.status, 200);
      assert.equal(page.headers.get("x-frame-options"), "DENY", "状态页不得被其它站点内嵌");

      // CSP：脚本只认 nonce，注入的 <img onerror=…> 之类内联处理器会被浏览器拒绝
      const csp = page.headers.get("content-security-policy") ?? "";
      const nonce = /'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(nonce !== undefined, `页面必须带 CSP nonce：${csp}`);
      assert.match(csp, /default-src 'none'/);
      assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, "script-src 不得放开 unsafe-inline");
      assert.match(csp, /frame-ancestors 'none'/);
      const html = await page.text();
      assert.ok(
        html.includes(`<script nonce="${nonce}">`),
        "内联脚本必须带上响应头里的同一个 nonce，否则整屏脚本不会执行",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("设置 WEB_API_TOKEN 后需要鉴权", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: "t".repeat(32), HOST: "0.0.0.0" });
    try {
      const a = app(env);
      assert.equal((await a.request("/api/status")).status, 401);
      assert.equal((await a.request(`/api/status?token=${"t".repeat(32)}`)).status, 200);
      const withBearer = await a.request("/api/status", {
        headers: { Authorization: `Bearer ${"t".repeat(32)}` },
      });
      assert.equal(withBearer.status, 200);
      assert.equal((await a.request("/")).status, 200);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未设置 token 时本机零配置可访问", async () => {
    const env = makeTestEnv();
    try {
      const response = await app(env).request("/api/status");
      assert.equal(response.status, 200);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("本月支出 = 自然月全月：月内更晚的已录入日计入，邻月不计入", () => {
    // 口径（见 service.ts 的 monthRange 注释）：状态页/看板/预算对照的「本月」是自然月全月，
    // 含月内尚未到来的日期 —— spent_on 是已录入事实，不能因为日历没到那天就从本月数字里消失。
    // 月内最后一天恒不早于今天：今天恰是月末时它落在今天，合计结论不变。
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '日用', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      const today = todayIso();
      // 月末用日历事实算出，不走 monthRange —— 否则被测函数改错时夹具会跟着一起错，断言恒真
      const monthEnd = DateTime.fromISO(`${today.slice(0, 7)}-01`, { zone: TZ })
        .endOf("month")
        .toISODate() as string;
      const nextMonth = DateTime.fromISO(`${today.slice(0, 7)}-01`, { zone: TZ })
        .plus({ months: 1 })
        .toISODate() as string;
      const insert = env.db.prepare(
        "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES (?, 'l1', ?, ?, 'default', '2026-01-01T00:00:00.000Z')",
      );
      insert.run("e-now", 1000, today);
      insert.run("e-month-end", 9999, monthEnd);
      insert.run("e-next-month", 7777, nextMonth);

      const payload = statusPayload(env.config, env.db);
      const expenses = payload.expenses as { month: string; month_cents: number };
      assert.equal(expenses.month, today.slice(0, 7));
      assert.equal(
        expenses.month_cents,
        10999,
        `同月的 ${monthEnd} 必须计入本月（口径=自然月全月），只有今天那一笔才是 1000`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("暴露抓取失败的节假日年份与原因", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO cn_holiday_years (year, status, source, fetched_at, last_attempt_at, last_error) VALUES (2027, 'failed', '', '2027-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z', 'HTTP 404')",
        )
        .run();
      const payload = statusPayload(env.config, env.db);
      const holidays = payload.holidays as {
        years: number[];
        failed: { year: number; error: string }[];
      };
      assert.deepEqual(holidays.years, []);
      assert.equal(holidays.failed.length, 1);
      assert.equal(holidays.failed[0]?.year, 2027);
      assert.match(holidays.failed[0]?.error ?? "", /404/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("看板明细接口", () => {
  function seedAccounting(env: TestEnv): void {
    env.db
      .prepare(
        "INSERT INTO ledgers (id, name, created_at) VALUES ('l1','家庭账本','2026-01-01T00:00:00.000Z')",
      )
      .run();
    // l2 是个人账本（归属 default）：状态页/接口必须完全看不到它及其支出
    env.db
      .prepare(
        "INSERT INTO ledgers (id, name, created_at, owner_profile_id) VALUES ('l2','个人账本','2026-01-01T00:00:00.000Z','default')",
      )
      .run();
    const today = todayIso();
    const insert = env.db.prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, note, spent_on, created_by_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("e1", "l1", 200000, "人情", "随礼", today, "default", "2026-01-01T00:00:00.000Z");
    insert.run("e2", "l1", 32040, "医疗", "药费", today, "bestie", "2026-01-02T00:00:00.000Z");
    insert.run("e3", "l2", 1500, "餐饮", null, today, "default", "2026-01-02T00:00:00.000Z");
  }

  it("/api/expenses 给出分类、按天与逐笔（个人账本及其支出不出现在看板）", async () => {
    const env = makeTestEnv();
    try {
      seedAccounting(env);
      const body = (await (await app(env).request("/api/expenses")).json()) as {
        total_cents: number;
        count: number;
        categories: { category: string; cents: number; count: number; share: number }[];
        daily: { date: string; cents: number }[];
        ledgers: { ledger_name: string; cents: number }[];
        entries: { id: string; ledger_name: string; created_by_profile: string }[];
        prev: { month: string; total_cents: number };
      };
      // 只统计家庭账本 l1 的两笔（200000 + 32040）；个人账本 l2 的 1500 完全不计
      assert.equal(body.total_cents, 232040);
      assert.equal(body.count, 2);
      assert.equal(body.categories[0]?.category, "人情");
      assert.equal(body.categories[0]?.count, 1);
      assert.ok((body.categories[0]?.share ?? 0) > 0.85);
      assert.equal(body.daily.length, 1, "同一天的家庭账本支出应聚合成一天");
      assert.equal(body.daily[0]?.cents, 232040);
      assert.deepEqual(
        body.ledgers.map((l) => l.ledger_name),
        ["家庭账本"],
        "个人账本不得出现在按账本聚合里",
      );
      assert.equal(body.entries.length, 2);
      assert.equal(body.entries[0]?.ledger_name, "家庭账本");
      assert.equal(body.prev.month.length, 7);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/expenses?month= 钉死挂钟：显式月份只看该月，与「今天在哪天」无关", async () => {
    // 口径：month 是自然月全月（含该月内所有已录入日，不设「今天」上界）。
    // 用固定夹具日期，任何挂钟时刻都应得到同一结果。
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1','家庭账本','2026-01-01T00:00:00.000Z')",
        )
        .run();
      const insert = env.db.prepare(
        `INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at)
         VALUES (?, 'l1', ?, ?, 'default', '2026-01-01T00:00:00.000Z')`,
      );
      insert.run("m1", 1000, "2026-06-01");
      insert.run("m2", 2000, "2026-06-15");
      insert.run("m3", 3000, "2026-06-30");
      insert.run("prev", 4000, "2026-05-31");
      insert.run("next", 5000, "2026-07-01");

      const body = (await (await app(env).request("/api/expenses?month=2026-06")).json()) as {
        range: { from: string; to: string };
        total_cents: number;
        daily: { date: string }[];
      };
      assert.deepEqual(body.range, { from: "2026-06-01", to: "2026-06-30" });
      assert.equal(body.total_cents, 6000, "只取 6 月三笔（含月末），邻月不入账");
      assert.deepEqual(
        body.daily.map((d) => d.date),
        ["2026-06-01", "2026-06-15", "2026-06-30"],
        "月末那一笔必须计入（这是「本月=自然月全月」口径的直接体现）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/expenses 非法月份回退到当月，limit 被夹紧", async () => {
    const env = makeTestEnv();
    try {
      seedAccounting(env);
      const body = (await (
        await app(env).request("/api/expenses?month=2099-13&limit=-1")
      ).json()) as {
        month: string;
        entries: unknown[];
      };
      assert.equal(body.month, todayIso().slice(0, 7), "非法月份不能落到空数据上");
      assert.ok(body.entries.length <= 200);

      // ?limit=（空串）必须走 fallback，而不是被 Number("") === 0 夹成 1 条
      const empty = (await (await app(env).request("/api/expenses?limit=")).json()) as {
        entries: unknown[];
      };
      const omitted = (await (await app(env).request("/api/expenses")).json()) as {
        entries: unknown[];
      };
      assert.equal(
        empty.entries.length,
        omitted.entries.length,
        "空串 limit 应与不传等价（历史上会被夹成 1 条）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/schedules 跨 profile 列出活跃日程并带下次触发时间", async () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          `INSERT INTO schedules (id, profile_id, title, kind, calendar, start_date, time, all_day, created_at, updated_at)
           VALUES ('s1','default','交房租','todo','solar','2026-09-20','09:00',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      env.db
        .prepare(
          `INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
           VALUES ('s1','2026-09-20','2026-09-20T01:00:00.000Z','2026-09-20T01:00:00.000Z','pending')`,
        )
        .run();
      env.db
        .prepare(
          `INSERT INTO schedules (id, profile_id, title, kind, calendar, start_date, time, all_day, status, created_at, updated_at)
           VALUES ('s2','default','已取消的事','todo','solar','2026-09-21','09:00',1,'cancelled','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      const body = (await (await app(env).request("/api/schedules")).json()) as {
        items: {
          id: string;
          title: string;
          kind_label: string;
          next_local: string | null;
          days_until: number | null;
        }[];
      };
      assert.equal(body.items.length, 1, "取消的日程不该出现");
      assert.equal(body.items[0]?.title, "交房租");
      assert.equal(body.items[0]?.kind_label, "待办");
      assert.equal(body.items[0]?.next_local, "2026-09-20");
      assert.equal(typeof body.items[0]?.days_until, "number");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/schedules：带提前提醒时，日期与倒计时同按事件日，提醒时刻单独给出", async () => {
    const env = makeTestEnv();
    try {
      const event = DateTime.now()
        .setZone(TZ)
        .plus({ days: 10 })
        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 });
      env.db
        .prepare(
          `INSERT INTO schedules (id, profile_id, title, kind, calendar, start_date, time, all_day, created_at, updated_at)
           VALUES ('s9','default','生日','birthday','solar',?,'09:00',0,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
        )
        .run(event.toISODate());
      const eventIso = event.toUTC().toISO() as string;
      const remindIso = event.minus({ days: 7 }).toUTC().toISO() as string;
      const insert = env.db.prepare(
        `INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
         VALUES ('s9', ?, ?, ?, 'pending')`,
      );
      insert.run(`${event.toISODate()}T09:00#0`, eventIso, remindIso);
      insert.run(`${event.toISODate()}T09:00#1`, eventIso, eventIso);

      const body = (await (await app(env).request("/api/schedules")).json()) as {
        items: { next_local: string; remind_local: string | null; days_until: number }[];
      };
      assert.equal(body.items.length, 1, "同一事件的多个提醒偏移不该让日程出现两行");
      const item = body.items[0];
      assert.equal(item?.next_local, `${event.toISODate()} 09:00`, "显示的是事件日");
      assert.ok(
        (item?.days_until ?? 0) >= 8,
        `倒计时应按事件日（约 10 天），实际 ${item?.days_until}：按提醒时刻算会变成 3 天`,
      );
      assert.equal(item?.remind_local, `${event.minus({ days: 7 }).toISODate()} 09:00`);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/schedules：倒计时按本地日历日，跨到明天不算 0 天", async () => {
    const env = makeTestEnv();
    try {
      const today = DateTime.now().setZone(TZ);
      // 今天 23:59 与明天 00:01 只差 2 分钟，但分属两个日历日：按瞬时差算会把后者
      // 圆整成 0 天，与卡片上显示的明天日期对不上。
      const late = today.set({ hour: 23, minute: 59, second: 0, millisecond: 0 });
      const early = today.plus({ days: 1 }).set({ hour: 0, minute: 1, second: 0, millisecond: 0 });

      const insertSchedule = env.db.prepare(
        `INSERT INTO schedules (id, profile_id, title, kind, calendar, start_date, time, all_day, created_at, updated_at)
         VALUES (?, 'default', ?, 'todo', 'solar', ?, '09:00', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
      );
      const insertOccurrence = env.db.prepare(
        `INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      );
      for (const [id, title, at, time] of [
        ["t1", "今天 23:59", late, "23:59"],
        ["t2", "明天 00:01", early, "00:01"],
      ] as const) {
        insertSchedule.run(id, title, at.toISODate());
        const eventIso = at.toUTC().toISO() as string;
        insertOccurrence.run(id, `${at.toISODate()}T${time}#0`, eventIso, eventIso);
      }

      const body = (await (await app(env).request("/api/schedules")).json()) as {
        items: { id: string; next_local: string; days_until: number | null }[];
      };
      const byId = new Map(body.items.map((item) => [item.id, item]));
      assert.equal(byId.get("t2")?.next_local, `${early.toISODate()} 00:01`, "显示的是事件日");
      assert.equal(byId.get("t1")?.days_until, 0, "今天的事件应是 0 天");
      assert.equal(
        byId.get("t2")?.days_until,
        1,
        "跨到明天 00:01 应是 1 天：按瞬时差会算成 0 天（不足 24 小时）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/deliveries 给出计数、近 7 天分布与记录", async () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          `INSERT INTO notifications (id, profile_id, kind, title, body_md, created_at)
           VALUES ('n1','default','reminder','吃药提醒','正文','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      const sentAt = new Date().toISOString();
      env.db
        .prepare(
          `INSERT INTO deliveries (id, notification_id, route_name, status, attempts, next_attempt_at, sent_at, created_at, updated_at)
           VALUES ('d1','n1','default','sent',1,?,?,?,'2026-01-01T00:00:00.000Z')`,
        )
        .run(sentAt, sentAt, sentAt);
      env.db
        .prepare(
          `INSERT INTO deliveries (id, notification_id, route_name, status, attempts, next_attempt_at, last_error, created_at, updated_at)
           VALUES ('d2','n1','default','failed',3,'2026-01-01T00:00:00.000Z','HTTP 502','2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000Z')`,
        )
        .run();
      const body = (await (await app(env).request("/api/deliveries")).json()) as {
        counts: { queued: number; failed: number; sent_24h: number };
        daily: { date: string; label: string; sent: number }[];
        items: {
          id: string;
          title: string;
          status: string;
          created_local: string;
          last_error: string | null;
        }[];
      };
      assert.equal(body.counts.failed, 1);
      assert.equal(body.counts.sent_24h, 1);
      assert.equal(body.daily.length, 7, "近 7 天要补齐空日期");
      assert.equal(body.daily[6]?.sent, 1, "今天那一格应为 1");
      assert.equal(body.daily[0]?.sent, 0);
      assert.equal(body.items.length, 2);
      const failed = body.items.find((i) => i.id === "d2");
      assert.equal(failed?.title, "吃药提醒", "投递要带上通知标题");
      assert.equal(failed?.last_error, "HTTP 502");
      assert.match(body.items[0]?.created_local ?? "", /^\d{2}-\d{2} \d{2}:\d{2}$/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/deliveries 对个人账本月报标题脱敏，家庭账本照常展示", async () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at, owner_profile_id) VALUES ('lp', '私房钱', '2026-01-01T00:00:00.000Z', 'default')",
        )
        .run();
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('lf', '家庭账本', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      const insertNotification = env.db.prepare(
        `INSERT INTO notifications (id, profile_id, kind, title, body_md, dedupe_key, read, created_at)
         VALUES (?, 'default', 'bookkeeping.monthly', ?, '', ?, 1, '2026-10-01T00:00:00.000Z')`,
      );
      insertNotification.run("n-personal", "2026-09 月度账单 · 私房钱", "report:lp:2026-09");
      insertNotification.run("n-family", "2026-09 月度账单 · 家庭账本", "report:lf:2026-09");
      const insertDelivery = env.db.prepare(
        `INSERT INTO deliveries (id, notification_id, route_name, status, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, 'r', 'sent', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z')`,
      );
      insertDelivery.run("d-personal", "n-personal");
      insertDelivery.run("d-family", "n-family");

      const body = (await (await app(env).request("/api/deliveries")).json()) as {
        items: { notification_id: string; title: string }[];
      };
      const personal = body.items.find((i) => i.notification_id === "n-personal");
      const family = body.items.find((i) => i.notification_id === "n-family");
      assert.equal(personal?.title, "（个人账本月报）", "个人账本标题不得出现在共享看板");
      assert.equal(family?.title, "2026-09 月度账单 · 家庭账本", "家庭账本标题应保持原样");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨年假期条目按日期年份归属：12-31 的元旦出现在当年视图且天数完整", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2099-12-15T10:00:00+08:00") });
    const env = makeTestEnv();
    try {
      const insertYear = env.db.prepare(
        "INSERT INTO cn_holiday_years (year, status, source, fetched_at) VALUES (?, 'ready', 'test', '2099-01-01T00:00:00.000Z')",
      );
      insertYear.run(2099);
      insertYear.run(2100);
      const insertDay = env.db.prepare(
        "INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES (?, ?, 'holiday', '元旦', 'test', '2099-01-01T00:00:00.000Z')",
      );
      // 2100 年度文件里的跨年元旦：12-31 是 2099 日历日，但行内 year 记 2100
      insertDay.run("2099-12-31", 2100);
      insertDay.run("2100-01-01", 2100);
      insertDay.run("2100-01-02", 2100);

      const body = (await (await app(env).request("/api/holidays?year=2099")).json()) as {
        year: number;
        days: { date: string }[];
        upcoming: {
          date: string;
          end: string;
          name: string;
          days_until: number;
          days: number;
          in_progress: boolean;
        }[];
      };
      assert.equal(body.year, 2099);
      assert.ok(
        body.days.some((d) => d.date === "2099-12-31"),
        "12-31 必须出现在 2099 的年度视图里",
      );
      assert.deepEqual(
        body.upcoming[0],
        {
          date: "2099-12-31",
          end: "2100-01-02",
          name: "元旦",
          days_until: 16,
          days: 3,
          in_progress: false,
        },
        "跨年假期必须按全部日期合并，天数不能被年份边界截断",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("假期进行中：保留完整起始日/总天数并标记 in_progress（不截断为今天起）", async (t: TestContext) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2099-10-03T10:00:00+08:00") });
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO cn_holiday_years (year, status, source, fetched_at) VALUES (2099, 'ready', 'test', '2099-01-01T00:00:00.000Z')",
        )
        .run();
      const insertDay = env.db.prepare(
        "INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES (?, 2099, 'holiday', '国庆节', 'test', '2099-01-01T00:00:00.000Z')",
      );
      for (let day = 1; day <= 7; day += 1) {
        insertDay.run(`2099-10-0${day}`);
      }

      const body = (await (await app(env).request("/api/holidays?year=2099")).json()) as {
        upcoming: {
          date: string;
          end: string;
          name: string;
          days_until: number;
          days: number;
          in_progress: boolean;
        }[];
      };
      assert.deepEqual(
        body.upcoming[0],
        {
          date: "2099-10-01",
          end: "2099-10-07",
          name: "国庆节",
          days_until: 0,
          days: 7,
          in_progress: true,
        },
        "假期第 3 天仍应给出完整区间与总天数，而不是「今天起、剩余 5 天」",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/holidays 合并连续假期为一段", async () => {
    const env = makeTestEnv();
    try {
      const year = Number(todayIso().slice(0, 4));
      env.db
        .prepare(
          "INSERT INTO cn_holiday_years (year, status, source, fetched_at) VALUES (?, 'ready', 'test', '2026-01-01T00:00:00.000Z')",
        )
        .run(year);
      const insertDay = env.db.prepare(
        "INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES (?, ?, ?, ?, 'test', '2026-01-01T00:00:00.000Z')",
      );
      const future = DateTime.now().setZone(TZ).plus({ days: 10 });
      insertDay.run(future.toISODate(), year, "holiday", "测试节");
      insertDay.run(future.plus({ days: 1 }).toISODate(), year, "holiday", "测试节");
      insertDay.run(future.plus({ days: 5 }).toISODate(), year, "workday", "调休上班");
      const body = (await (await app(env).request("/api/holidays")).json()) as {
        year: number;
        years: number[];
        days: { day_type: string; weekday: string }[];
        upcoming: { name: string; days: number; days_until: number; date: string }[];
      };
      assert.equal(body.year, year);
      assert.deepEqual(body.years, [year]);
      assert.equal(body.days.length, 3);
      assert.equal(body.upcoming.length, 1, "调休不是假期，不该单独成段");
      assert.equal(body.upcoming[0]?.name, "测试节");
      assert.equal(body.upcoming[0]?.days, 2);
      assert.equal(body.upcoming[0]?.days_until, 10);
      assert.match(body.days[0]?.weekday ?? "", /^周[一二三四五六日]$/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("明细端点同样受 token 保护", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: "t".repeat(32), HOST: "0.0.0.0" });
    try {
      const a = app(env);
      for (const path of ["/api/expenses", "/api/schedules", "/api/deliveries", "/api/holidays"]) {
        assert.equal((await a.request(path)).status, 401, `${path} 漏了鉴权`);
        assert.equal(
          (await a.request(`${path}?token=${"t".repeat(32)}`)).status,
          200,
          `${path} 带 token 应放行`,
        );
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("状态页带明细入口与抽屉", async () => {
    const env = makeTestEnv();
    try {
      const html = await (await app(env).request("/")).text();
      for (const kind of ["expenses", "schedules", "deliveries", "holidays", "system"]) {
        assert.match(html, new RegExp(`data-drawer="${kind}"`), `缺少 ${kind} 明细入口`);
      }
      assert.match(html, /id="drawer"/);
      assert.match(html, /\/api\/expenses/);
      assert.match(html, /30\d{3}\)/, "应有 30 秒自动刷新");
      assert.match(html, /data-api="\/api\/status"/, "原始状态入口应走带鉴权的 fetch");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/status 的概览字段齐全（首页 JS 直接消费，缺字段会让整屏报错）", async () => {
    const env = makeTestEnv();
    try {
      seedAccounting(env);
      const body = (await (await app(env).request("/api/status")).json()) as {
        today: { date: string; weekday: string; time: string; label: string };
        expenses: {
          month: string;
          count: number;
          month_cents: number;
          prev_month: string;
          prev_month_cents: number;
          categories: unknown[];
          daily: unknown[];
        };
        notifications: { daily: unknown[] };
        schedules: { active: number; next: unknown[] };
        holidays: { years: number[]; failed: unknown[]; next: unknown };
      };
      assert.match(body.today.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(body.today.label, /^\d{4}年\d{1,2}月\d{1,2}日 周[一二三四五六日]$/);
      assert.match(body.today.time, /^\d{2}:\d{2}$/);
      assert.ok(Array.isArray(body.expenses.daily), "支出按天序列缺失会让首页渲染中断");
      assert.ok(Array.isArray(body.expenses.categories));
      assert.equal(body.expenses.count, 2, "个人账本的支出不计入概览");
      assert.equal(typeof body.expenses.prev_month_cents, "number");
      assert.ok(Array.isArray(body.notifications.daily));
      assert.ok(Array.isArray(body.schedules.next));
      assert.ok(Array.isArray(body.holidays.failed));
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("定时任务接口", () => {
  interface JobRunSeed {
    jobName: string;
    module?: string;
    status: "ok" | "failed" | "skipped" | "running";
    startedAt: string;
    finishedAt?: string | null;
    scheduledFor?: string;
    error?: string | null;
  }

  function seedJobRun(env: TestEnv, over: JobRunSeed): void {
    env.db
      .prepare(
        `INSERT INTO job_runs (job_name, module, trigger, scheduled_for, started_at, finished_at, status, error)
         VALUES (?, ?, 'cron', ?, ?, ?, ?, ?)`,
      )
      .run(
        over.jobName,
        over.module ?? "weather",
        over.scheduledFor ?? over.startedAt,
        over.startedAt,
        over.finishedAt === undefined ? over.startedAt : over.finishedAt,
        over.status,
        over.error ?? null,
      );
  }

  it("/api/jobs：每 job 的最近运行/最近成功/24h 失败，按 module+name 排序", async () => {
    const env = makeTestEnv();
    try {
      const now = Date.now();
      const twoHoursAgo = new Date(now - 2 * 3600 * 1000).toISOString();
      const oneHourAgo = new Date(now - 3600 * 1000).toISOString();
      seedJobRun(env, {
        jobName: "daily_brief",
        status: "ok",
        startedAt: twoHoursAgo,
        scheduledFor: new Date(now - 3 * 3600 * 1000).toISOString(),
      });
      seedJobRun(env, {
        jobName: "daily_brief",
        status: "failed",
        startedAt: oneHourAgo,
        error: "上游 503",
      });

      const body = (await (await app(env).request("/api/jobs")).json()) as {
        items: {
          module: string;
          name: string;
          cron: string;
          last_run: { status: string; started_at: string; error: string | null } | null;
          last_ok_at: string | null;
          next_run_hint?: string;
          failed_24h: number;
          recent_failures: { error: string | null }[];
          recent_runs: { status: string }[];
        }[];
      };
      const items = body.items;
      assert.ok(items.length >= 9, `应列出全部已注册 job，实际 ${items.length}`);

      const brief = items.find((item) => item.name === "daily_brief");
      assert.ok(brief !== undefined, "缺少 weather.daily_brief");
      assert.equal(brief.module, "weather");
      assert.equal(brief.cron, "0 7 * * *", "cron 应与 config 一致（函数形式也要能求值）");
      assert.equal(brief.last_run?.status, "failed", "最近一次是失败");
      assert.equal(brief.last_run?.error, "上游 503");
      assert.equal(brief.last_ok_at, twoHoursAgo, "最近成功要单独给出（不被失败行掩盖）");
      assert.equal(brief.failed_24h, 1);
      assert.equal(brief.recent_failures[0]?.error, "上游 503");
      assert.deepEqual(
        brief.recent_runs.map((run) => run.status),
        ["failed", "ok"],
        "抽屉要能看到最近几次运行，新的在前",
      );
      assert.equal(brief.next_run_hint, "每天 07:00");

      // 从未运行过的 job 也要出现（last_run=null 才是「从未运行」的真实表达）
      const cleanupJob = items.find((item) => item.name === "occurrence_cleanup");
      assert.ok(cleanupJob !== undefined);
      assert.equal(cleanupJob.last_run, null);
      assert.equal(cleanupJob.last_ok_at, null);

      const keys = items.map((item) => `${item.module}.${item.name}`);
      assert.deepEqual(keys, [...keys].sort(), "按 module+name 排序（看板顺序必须稳定）");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/jobs 受 token 保护", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      const a = app(env);
      assert.equal((await a.request("/api/jobs")).status, 401, "/api/jobs 漏了鉴权");
      assert.equal((await a.request(`/api/jobs?token=${token}`)).status, 200);
      const withBearer = await a.request("/api/jobs", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(withBearer.status, 200);
      assert.equal(withBearer.headers.get("cache-control"), "no-store", "任务明细不得进缓存");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/status 的 jobs 概览：total / failed_24h / runs", async () => {
    const env = makeTestEnv();
    try {
      const now = Date.now();
      seedJobRun(env, {
        jobName: "daily_brief",
        status: "failed",
        startedAt: new Date(now - 3600 * 1000).toISOString(),
        error: "超时",
      });
      const body = (await (await app(env).request("/api/status")).json()) as {
        jobs: {
          total: number;
          failed_24h: number;
          runs: { module: string; name: string; last_run: { status: string } | null }[];
        };
      };
      assert.equal(body.jobs.total, allJobs().length, "total 应是注册的 job 数");
      assert.equal(body.jobs.failed_24h, 1);
      assert.ok(body.jobs.runs.length <= 20, "概览只带 20 个 job，全量走 /api/jobs");
      const brief = body.jobs.runs.find((run) => run.name === "daily_brief");
      assert.equal(brief?.last_run?.status, "failed");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
