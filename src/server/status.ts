import { createRequire } from "node:module";
import { Hono } from "hono";
import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedConfig } from "../config.js";
import { isRequestAuthorized } from "../core/auth.js";
import { TZ, todayIso } from "../time.js";
import { deliveryDetails, expenseDetails, holidayDetails, scheduleDetails } from "./details.js";
import { statusPage } from "./page.js";

const require = createRequire(import.meta.url);
const VERSION = (require("../../package.json") as { version: string }).version;

const WEEKDAY_CN = ["一", "二", "三", "四", "五", "六", "日"];

export function statusPayload(config: ResolvedConfig, db: DatabaseSync): Record<string, unknown> {
  const at = DateTime.now().setZone(TZ);
  const today = todayIso();
  const month = today.slice(0, 7);

  const count = (sql: string, ...params: (string | number)[]): number => {
    const row = db.prepare(sql).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  };

  const expenses = expenseDetails(db, month, "1");
  const deliveries = deliveryDetails(db, "1");
  const schedules = scheduleDetails(db, "50");
  const holidays = holidayDetails(db, undefined);

  return {
    ok: true,
    name: "life-assistant",
    version: VERSION,
    uptime_s: Math.floor(process.uptime()),
    qweather_configured: config.qweatherKey !== undefined && config.qweatherHost !== undefined,
    daily_brief_cron: config.dailyBriefCron,
    profiles: (db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: string }[]).map(
      (r) => r.id,
    ),
    today: {
      date: today,
      weekday: `周${WEEKDAY_CN[at.weekday - 1] ?? ""}`,
      time: at.toFormat("HH:mm"),
      label: `${at.toFormat("yyyy年L月d日")} 周${WEEKDAY_CN[at.weekday - 1] ?? ""}`,
    },
    schedules: {
      active: count("SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'"),
      // 概览只带最近 5 条；完整列表走 /api/schedules
      next: schedules.slice(0, 5),
    },
    notifications: {
      queued: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'queued'"),
      failed: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'failed'"),
      fallback: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'fallback'"),
      sent_24h: count(
        "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent' AND sent_at >= ?",
        new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      ),
      daily: deliveries.daily,
    },
    ledgers: {
      total: count("SELECT COUNT(*) AS n FROM ledgers WHERE archived_at IS NULL"),
      archived: count("SELECT COUNT(*) AS n FROM ledgers WHERE archived_at IS NOT NULL"),
    },
    expenses: {
      month: expenses.month,
      count: expenses.count,
      month_cents: expenses.total_cents,
      prev_month: expenses.prev.month,
      prev_month_cents: expenses.prev.total_cents,
      categories: expenses.categories,
      daily: expenses.daily,
    },
    holidays: {
      years: holidays.years,
      // 长期抓取失败的年份此前只显示「未导入」，看不出原因
      failed: (
        db
          .prepare(
            "SELECT year, last_error FROM cn_holiday_years WHERE status = 'failed' ORDER BY year",
          )
          .all() as { year: number; last_error: string | null }[]
      ).map((r) => ({
        year: r.year,
        error: (r.last_error ?? "").slice(0, 200),
      })),
      next: holidays.upcoming[0] ?? null,
    },
  };
}

export function createStatusApp(config: ResolvedConfig, db: DatabaseSync): Hono {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    if (
      !isRequestAuthorized(config.webApiToken, c.req.header("Authorization"), c.req.query("token"))
    ) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/status", (c) => c.json(statusPayload(config, db)));
  app.get("/api/expenses", (c) =>
    c.json(expenseDetails(db, c.req.query("month"), c.req.query("limit"))),
  );
  app.get("/api/schedules", (c) => c.json({ items: scheduleDetails(db, c.req.query("limit")) }));
  app.get("/api/deliveries", (c) => c.json(deliveryDetails(db, c.req.query("limit"))));
  app.get("/api/holidays", (c) => c.json(holidayDetails(db, c.req.query("year"))));
  app.get("/", (c) => c.html(statusPage(VERSION)));
  return app;
}
