import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { createStatusApp, statusPayload } from "../src/server/status.js";
import { TZ, todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

function app(env: TestEnv) {
  return createStatusApp(env.config, env.db);
}

describe("状态接口", () => {
  it("/api/status 输出关键计数", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '日用', '2026-01-01T00:00:00.000Z')")
        .run();
      env.db
        .prepare(
          "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES ('e1','l1',12345,?, 'default', '2026-01-01T00:00:00.000Z')",
        )
        .run(new Date().toISOString().slice(0, 10));
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

  it("设置 WEB_API_TOKEN 后需要鉴权", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: "t".repeat(16), HOST: "0.0.0.0" });
    try {
      const a = app(env);
      assert.equal((await a.request("/api/status")).status, 401);
      assert.equal((await a.request(`/api/status?token=${"t".repeat(16)}`)).status, 200);
      const withBearer = await a.request("/api/status", {
        headers: { Authorization: `Bearer ${"t".repeat(16)}` },
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

  it("未来日期的支出不计入本月支出", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '日用', '2026-01-01T00:00:00.000Z')")
        .run();
      const today = todayIso();
      const insert = env.db.prepare(
        "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES (?, 'l1', ?, ?, 'default', '2026-01-01T00:00:00.000Z')",
      );
      insert.run("e-now", 1000, today);
      insert.run("e-future", 9999, "2099-01-15");
      const payload = statusPayload(env.config, env.db);
      const expenses = payload.expenses as { month_cents: number };
      assert.equal(expenses.month_cents, 1000, "只筛 >= 月初会把未来支出也算进本月");
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
      const holidays = payload.holidays as { years: number[]; failed: { year: number; error: string }[] };
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
    env.db.prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('l1','家庭账本','2026-01-01T00:00:00.000Z')").run();
    env.db.prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('l2','个人账本','2026-01-01T00:00:00.000Z')").run();
    const today = todayIso();
    const insert = env.db.prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, note, spent_on, created_by_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run("e1", "l1", 200000, "人情", "随礼", today, "default", "2026-01-01T00:00:00.000Z");
    insert.run("e2", "l1", 32040, "医疗", "药费", today, "bestie", "2026-01-02T00:00:00.000Z");
    insert.run("e3", "l2", 1500, "餐饮", null, today, "default", "2026-01-02T00:00:00.000Z");
  }

  it("/api/expenses 给出分类、按天与逐笔", async () => {
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
      assert.equal(body.total_cents, 233540);
      assert.equal(body.count, 3);
      assert.equal(body.categories[0]?.category, "人情");
      assert.equal(body.categories[0]?.count, 1);
      assert.ok((body.categories[0]?.share ?? 0) > 0.85);
      assert.equal(body.daily.length, 1, "同一天的三笔应聚合成一天");
      assert.equal(body.daily[0]?.cents, 233540);
      assert.deepEqual(
        body.ledgers.map((l) => l.ledger_name),
        ["家庭账本", "个人账本"],
      );
      assert.equal(body.entries.length, 3);
      assert.equal(body.entries[0]?.ledger_name, "家庭账本");
      assert.equal(body.prev.month.length, 7);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/expenses 非法月份回退到当月，limit 被夹紧", async () => {
    const env = makeTestEnv();
    try {
      seedAccounting(env);
      const body = (await (await app(env).request("/api/expenses?month=2099-13&limit=-1")).json()) as {
        month: string;
        entries: unknown[];
      };
      assert.equal(body.month, todayIso().slice(0, 7), "非法月份不能落到空数据上");
      assert.ok(body.entries.length <= 200);
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
        items: { id: string; title: string; kind_label: string; next_local: string | null; days_until: number | null }[];
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
        items: { id: string; title: string; status: string; created_local: string; last_error: string | null }[];
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

  it("/api/holidays 合并连续假期为一段", async () => {
    const env = makeTestEnv();
    try {
      const year = Number(todayIso().slice(0, 4));
      env.db
        .prepare("INSERT INTO cn_holiday_years (year, status, source, fetched_at) VALUES (?, 'ready', 'test', '2026-01-01T00:00:00.000Z')")
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
    const env = makeTestEnv({ WEB_API_TOKEN: "t".repeat(16), HOST: "0.0.0.0" });
    try {
      const a = app(env);
      for (const path of ["/api/expenses", "/api/schedules", "/api/deliveries", "/api/holidays"]) {
        assert.equal((await a.request(path)).status, 401, `${path} 漏了鉴权`);
        assert.equal((await a.request(`${path}?token=${"t".repeat(16)}`)).status, 200, `${path} 带 token 应放行`);
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
        expenses: { month: string; count: number; month_cents: number; prev_month: string; prev_month_cents: number; categories: unknown[]; daily: unknown[] };
        notifications: { daily: unknown[] };
        schedules: { active: number; next: unknown[] };
        holidays: { years: number[]; failed: unknown[]; next: unknown };
      };
      assert.match(body.today.date, /^\d{4}-\d{2}-\d{2}$/);
      assert.match(body.today.label, /^\d{4}年\d{1,2}月\d{1,2}日 周[一二三四五六日]$/);
      assert.match(body.today.time, /^\d{2}:\d{2}$/);
      assert.ok(Array.isArray(body.expenses.daily), "支出按天序列缺失会让首页渲染中断");
      assert.ok(Array.isArray(body.expenses.categories));
      assert.equal(body.expenses.count, 3);
      assert.equal(typeof body.expenses.prev_month_cents, "number");
      assert.ok(Array.isArray(body.notifications.daily));
      assert.ok(Array.isArray(body.schedules.next));
      assert.ok(Array.isArray(body.holidays.failed));
    } finally {
      cleanupTestEnv(env);
    }
  });
});
