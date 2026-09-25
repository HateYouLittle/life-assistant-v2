import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { DateTime } from "luxon";
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedConfig } from "../config.js";
import { isRequestAuthorized } from "../core/auth.js";
import { qweatherUsage } from "../core/qweather.js";
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
    // 当日上游请求数（含重试）：官方自 2027-02-01 起限制 API KEY 日请求量，用量必须可见
    qweather_usage: qweatherUsage(),
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
  // 安全响应头：状态页渲染的是个人数据（行程、账目、通知正文）。
  // - nosniff：避免把 JSON 当脚本执行
  // - no-referrer：凭据可能出现在 /api/*?token= 的 URL 里，Referer 不能外泄
  // - X-Frame-Options：禁止被其它站点内嵌（点击劫持）
  // - /api/* 一律 no-store：明细是实时数据，且不应留在浏览器/代理缓存里
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  });
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
  // 存活探针：不鉴权、不查明细，只回答「进程还在、库还开着」。
  // systemd / uptime 监控用它，而不是用需要 token 的 /api/status。
  app.get("/healthz", (c) => {
    const healthy = db.isOpen;
    return c.json(
      { ok: healthy, version: VERSION, uptime_s: Math.floor(process.uptime()) },
      healthy ? 200 : 503,
    );
  });
  app.get("/", (c) => {
    // 每次请求一个新 nonce：页面脚本与样式都要它才允许执行，
    // 这样即便库里的数据被注入 <img onerror=…>，浏览器也会拒绝其内联处理器。
    const nonce = randomBytes(16).toString("base64");
    c.header(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        // 页面有大量内联 style 属性，style-src 仍需 unsafe-inline；script-src 不放开
        "style-src 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    return c.html(statusPage(VERSION, nonce));
  });
  return app;
}
