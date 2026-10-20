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

/**
 * 当前请求可见的 Profile：master = undefined（家庭看板，全部 Profile）；
 * profile token = 只允许自己的数据（过滤下推到每条 SQL，响应里不出现别人的记录）。
 */
function visibleProfileId(identity: Identity): string | undefined {
  return identity.kind === "profile" ? identity.profileId : undefined;
}

export function statusPayload(
  config: ResolvedConfig,
  db: DatabaseSync,
  identity: Identity = { kind: "master" },
): Record<string, unknown> {
  const at = DateTime.now().setZone(TZ);
  const today = todayIso();
  const month = today.slice(0, 7);
  const profileId = visibleProfileId(identity);

  const count = (sql: string, ...params: (string | number)[]): number => {
    const row = db.prepare(sql).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  };

  const expenses = expenseDetails(db, month, "1", undefined, { profileId });
  const deliveries = deliveryDetails(db, "1", undefined, profileId);
  const schedules = scheduleDetails(db, "50", profileId);
  const holidays = holidayDetails(db, undefined);
  const jobs = jobDetails(db);
  // 预算卡片首屏数据源：与支出卡片同一个月（自然月全月），卡片内容因此不必额外拉接口。
  // 预算仍只统计家庭账本（见 budget.ts 的口径），Profile 视图不额外暴露个人账本预算。
  const budget = budgetPayload(db, month);

  return {
    ok: true,
    name: "life-assistant",
    version: VERSION,
    // 当前请求身份：页面据此渲染「家庭看板 / 个人视图 · <profile>」。
    // 只出现在受鉴权保护的 /api/status 里；静态页 `/` 依旧是没有任何身份信息的壳。
    identity:
      profileId === undefined ? { kind: "master" } : { kind: "profile", profile_id: profileId },
    uptime_s: Math.floor(process.uptime()),
    qweather_configured: config.qweatherKey !== undefined && config.qweatherHost !== undefined,
    // 当日上游请求数（含重试）：官方自 2027-02-01 起限制 API KEY 日请求量，用量必须可见
    qweather_usage: qweatherUsage(),
    daily_brief_cron: config.dailyBriefCron,
    // 个人视图只列自己：Profile 列表本身也是「其他用户存在」的元数据
    profiles:
      profileId === undefined
        ? (db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: string }[]).map(
            (r) => r.id,
          )
        : [profileId],
    today: {
      date: today,
      weekday: `周${WEEKDAY_CN[at.weekday - 1] ?? ""}`,
      time: at.toFormat("HH:mm"),
      label: `${at.toFormat("yyyy年L月d日")} 周${WEEKDAY_CN[at.weekday - 1] ?? ""}`,
    },
    schedules: {
      active:
        profileId === undefined
          ? count("SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'")
          : count(
              "SELECT COUNT(*) AS n FROM schedules WHERE status = 'active' AND profile_id = ?",
              profileId,
            ),
      // 概览只带最近 5 条；完整列表走 /api/schedules
      next: schedules.slice(0, 5),
    },
    notifications: {
      // 计数与 deliveries 明细同口径：Profile 视图只数自己的投递，
      // 否则「别人的待投递/失败数」会作为元数据泄漏出来
      ...deliveries.counts,
      daily: deliveries.daily,
    },
    ledgers: {
      // Profile 视图把自己可见的账本都算上（家庭 + 自己的个人账本），与支出卡片口径一致
      total:
        profileId === undefined
          ? count(
              "SELECT COUNT(*) AS n FROM ledgers WHERE archived_at IS NULL AND owner_profile_id IS NULL",
            )
          : count(
              `SELECT COUNT(*) AS n FROM ledgers
               WHERE archived_at IS NULL AND (owner_profile_id IS NULL OR owner_profile_id = ?)`,
              profileId,
            ),
      archived:
        profileId === undefined
          ? count(
              "SELECT COUNT(*) AS n FROM ledgers WHERE archived_at IS NOT NULL AND owner_profile_id IS NULL",
            )
          : count(
              `SELECT COUNT(*) AS n FROM ledgers
               WHERE archived_at IS NOT NULL AND (owner_profile_id IS NULL OR owner_profile_id = ?)`,
              profileId,
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
    // 自己在路由里解析 identity。
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
    // Profile token 也放行看板：数据范围由各路由按 identity 下推到 SQL 过滤
    // （家庭账本 + 自己个人账本 / 自己的日程 / 自己的通知），不是 403 后前端隐藏。
    c.set("identity", identity);
    await next();
  });

  app.get("/api/status", (c) => c.json(statusPayload(config, db, c.get("identity"))));
  // offset/limit 都透传给详情查询：看板明细「加载更多」按 next_offset 续页。
  // 参数解析与夹紧统一在 details.ts（clampLimit/clampOffset），路由不做业务判断；
  // profile token 时用 scope 把账本范围限定为「家庭 + 本人个人」。
  app.get("/api/expenses", (c) =>
    c.json(
      expenseDetails(db, c.req.query("month"), c.req.query("limit"), c.req.query("offset"), {
        profileId: visibleProfileId(c.get("identity")),
      }),
    ),
  );
  // 预算看板：每个活跃家庭账本的总额/分类预算对照 + 可执行建议。
  // 月份缺省/非法回退当月（与 /api/expenses 同一 normalizeMonth 口径）；
  // 鉴权与 no-store 由上面的 /api/* master 中间件统一兜住。
  app.get("/api/budget", (c) => c.json(budgetPayload(db, c.req.query("month"))));
  // 家庭账本支出 CSV：固定只导出家庭账本（不随 Profile 视图扩大到个人账本 —— 导出是
  // 共享看板能力，个人账本导出走 MCP expense {action:"export"}），区间与 /api/expenses
  // 同为「自然月全月」；鉴权与 no-store 由上面的 /api/* 中间件统一兜住。
  app.get("/api/expenses.csv", (c) => {
    const month = normalizeMonth(c.req.query("month"));
    const result = expenseCsv(db, { month });
    return c.body(result.csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${expenseCsvFilename(month)}"`,
    });
  });
  app.get("/api/schedules", (c) =>
    c.json({
      items: scheduleDetails(db, c.req.query("limit"), visibleProfileId(c.get("identity"))),
    }),
  );
  // 定时任务全量明细：每 job 的最近运行/最近成功/24h 失败。doctor --live 也读它，
  // 鉴权与 no-store 由上面的 /api/* 中间件统一兜住（运维数据不含 Profile 隐私）。
  app.get("/api/jobs", (c) => c.json({ items: jobDetails(db) }));
  app.get("/api/deliveries", (c) =>
    c.json(
      deliveryDetails(
        db,
        c.req.query("limit"),
        c.req.query("offset"),
        visibleProfileId(c.get("identity")),
      ),
    ),
  );
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
