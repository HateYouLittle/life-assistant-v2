import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { DateTime } from "luxon";
import type { ResolvedConfig } from "../config.js";
import { type Identity, resolveIdentity } from "../core/auth.js";
import { logger } from "../core/logger.js";
import { incCounter } from "../core/metrics.js";
import { qweatherUsage } from "../core/qweather.js";
import { allJobs } from "../core/registry.js";
import { expenseCsv, expenseCsvFilename } from "../modules/bookkeeping/service.js";
import { TZ, todayIso } from "../time.js";
import { budgetPayload } from "./budget.js";
import {
  deliveryDetails,
  expenseDetails,
  holidayDetails,
  jobDetails,
  normalizeMonth,
  scheduleDetails,
} from "./details.js";
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
  const jobs = jobDetails(db);
  // 预算卡片首屏数据源：与支出卡片同一个月（自然月全月），卡片内容因此不必额外拉接口
  const budget = budgetPayload(db, month);

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
      total: count(
        "SELECT COUNT(*) AS n FROM ledgers WHERE archived_at IS NULL AND owner_profile_id IS NULL",
      ),
      archived: count(
        "SELECT COUNT(*) AS n FROM ledgers WHERE archived_at IS NOT NULL AND owner_profile_id IS NULL",
      ),
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
    // 预算卡片首屏数据：每个活跃家庭账本的总额/分类对照 + 建议。
    // 全量明细（分类建议等）同时可从 /api/budget?month= 取；这里只给当月。
    budget,
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
    jobs: {
      // job 数量取注册表（而未运行的 job 也要显示成「未运行」，不能因为没记录就消失）
      total: allJobs().length,
      // 直接按 job_runs 统计：与看板上「24 小时失败」同口径，不受 runs 被截断影响
      failed_24h: count(
        "SELECT COUNT(*) AS n FROM job_runs WHERE status = 'failed' AND started_at >= ?",
        new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      ),
      // 概览只带 20 个 job；完整列表（含每 job 最近几次运行）走 /api/jobs
      runs: jobs.slice(0, 20),
    },
  };
}

/** Hono 上下文变量：请求身份（master / 某个 Profile），由 /api/* 中间件写入 */
export interface StatusEnv {
  Variables: { identity: Identity };
}

export function createStatusApp(config: ResolvedConfig, db: DatabaseSync): Hono<StatusEnv> {
  const app = new Hono<StatusEnv>();
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
    // `/api/quick/*` 是手机快捷入口（记账/提醒），由 Profile token 授权、按身份过滤，
    // 自己在路由里解析 identity；其余只读看板接口仍然只允许 master token ——
    // 单 Profile 的 token 不该看到全家账本/所有日程。
    if (c.req.path.startsWith("/api/quick/")) {
      await next();
      return;
    }
    const identity = resolveIdentity({
      masterToken: config.webApiToken,
      profileTokens: config.profileTokens,
      authorization: c.req.header("Authorization"),
      queryToken: c.req.query("token"),
    });
    if (identity === null) {
      incCounter("auth_failed_total");
      logger.warn(`鉴权失败: ${c.req.path} from ${c.req.header("x-forwarded-for") ?? "unknown"}`);
      return c.json({ error: "unauthorized" }, 401);
    }
    if (identity.kind === "profile") {
      incCounter("auth_forbidden_total");
      return c.json(
        {
          error: "forbidden",
          message: "看板/只读接口仅 master token 可访问；手机请用 /api/quick/*",
        },
        403,
      );
    }
    c.set("identity", identity);
    await next();
  });

  app.get("/api/status", (c) => c.json(statusPayload(config, db)));
  app.get("/api/expenses", (c) =>
    c.json(expenseDetails(db, c.req.query("month"), c.req.query("limit"))),
  );
  // 预算看板：每个活跃家庭账本的总额/分类预算对照 + 可执行建议。
  // 月份缺省/非法回退当月（与 /api/expenses 同一 normalizeMonth 口径）；
  // 鉴权与 no-store 由上面的 /api/* master 中间件统一兜住。
  app.get("/api/budget", (c) => c.json(budgetPayload(db, c.req.query("month"))));
  // 家庭账本支出 CSV：与 /api/expenses 同口径（只家庭账本、同一「自然月全月」区间），
  // 鉴权与 no-store 由上面的 /api/* 中间件统一兜住；月份非法/缺省回退当月。
  app.get("/api/expenses.csv", (c) => {
    const month = normalizeMonth(c.req.query("month"));
    const result = expenseCsv(db, { month });
    return c.body(result.csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${expenseCsvFilename(month)}"`,
    });
  });
  app.get("/api/schedules", (c) => c.json({ items: scheduleDetails(db, c.req.query("limit")) }));
  // 定时任务全量明细：每 job 的最近运行/最近成功/24h 失败。doctor --live 也读它，
  // 鉴权与 no-store 由上面的 /api/* 中间件统一兜住。
  app.get("/api/jobs", (c) => c.json({ items: jobDetails(db) }));
  app.get("/api/deliveries", (c) => c.json(deliveryDetails(db, c.req.query("limit"))));
  app.get("/api/holidays", (c) => c.json(holidayDetails(db, c.req.query("year"))));
  // 存活探针：不鉴权、不查明细，只回答「进程还在、库还开着」。
  // systemd / uptime 监控用它，而不是用需要 token 的 /api/status。
  app.get("/healthz", (c) => {
    // isOpen 只说明连接对象没关；文件被替换/磁盘故障时仍可能为 true。
    // 真正做一次最轻量的查询，才能把「库已经不可用」反馈成 503。
    let healthy = db.isOpen;
    if (healthy) {
      try {
        healthy = db.prepare("SELECT 1 AS ok").get() !== undefined;
      } catch {
        healthy = false;
      }
    }
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
