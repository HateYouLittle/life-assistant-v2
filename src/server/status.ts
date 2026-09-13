import { Hono } from "hono";
import type { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { DateTime } from "luxon";
import type { ResolvedConfig } from "../config.js";
import { isRequestAuthorized } from "../core/auth.js";
import { TZ, todayIso } from "../time.js";

const require = createRequire(import.meta.url);
const VERSION = (require("../../package.json") as { version: string }).version;

export function statusPayload(config: ResolvedConfig, db: DatabaseSync): Record<string, unknown> {
  const today = todayIso();
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthEnd = `${today.slice(0, 7)}-${String(DateTime.fromISO(today, { zone: TZ }).daysInMonth ?? 31).padStart(2, "0")}`;
  const count = (sql: string, ...params: (string | number)[]): number => {
    const row = db.prepare(sql).get(...params) as { n: number } | undefined;
    return row?.n ?? 0;
  };
  return {
    ok: true,
    name: "life-assistant",
    version: VERSION,
    uptime_s: Math.floor(process.uptime()),
    qweather_configured: config.qweatherKey !== undefined && config.qweatherHost !== undefined,
    daily_brief_cron: config.dailyBriefCron,
    profiles: (db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: string }[]).map((r) => r.id),
    schedules: {
      active: count("SELECT COUNT(*) AS n FROM schedules WHERE status = 'active'"),
    },
    notifications: {
      queued: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'queued'"),
      failed: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'failed'"),
      fallback: count("SELECT COUNT(*) AS n FROM deliveries WHERE status = 'fallback'"),
      sent_24h: count(
        "SELECT COUNT(*) AS n FROM deliveries WHERE status = 'sent' AND sent_at >= ?",
        new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
      ),
    },
    ledgers: {
      total: count("SELECT COUNT(*) AS n FROM ledgers WHERE archived_at IS NULL"),
      archived: count("SELECT COUNT(*) AS n FROM ledgers WHERE archived_at IS NOT NULL"),
    },
    expenses: {
      month_cents: count(
        // 加上月上界：只筛 >= 月初会把未来日期的支出也算进「本月支出」
        "SELECT COALESCE(SUM(amount_cents), 0) AS n FROM expenses WHERE spent_on >= ? AND spent_on <= ?",
        monthStart,
        monthEnd,
      ),
    },
    holidays: {
      years: (db.prepare("SELECT year FROM cn_holiday_years WHERE status = 'ready' ORDER BY year").all() as { year: number }[]).map(
        (r) => r.year,
      ),
      // 长期抓取失败的年份此前只显示「未导入」，看不出原因
      failed: (db
        .prepare("SELECT year, last_error FROM cn_holiday_years WHERE status = 'failed' ORDER BY year")
        .all() as { year: number; last_error: string | null }[]).map((r) => ({
        year: r.year,
        error: (r.last_error ?? "").slice(0, 200),
      })),
    },
  };
}

export function createStatusApp(config: ResolvedConfig, db: DatabaseSync): Hono {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    if (!isRequestAuthorized(config.webApiToken, c.req.header("Authorization"), c.req.query("token"))) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/status", (c) => c.json(statusPayload(config, db)));
  app.get("/", (c) => c.html(statusPage()));
  return app;
}

const PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Life Assistant v2</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; font: 14px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
         background: #0e1116; color: #d7dde6; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { color: #7d8590; margin-bottom: 20px; }
  .grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); max-width: 980px; }
  .card { background: #161b22; border: 1px solid #232a33; border-radius: 10px; padding: 14px 16px; }
  .card b { display: block; font-size: 20px; margin-top: 2px; }
  .card span { color: #7d8590; font-size: 12px; }
  .warn { color: #e3b341; } .bad { color: #f85149; } .good { color: #3fb950; }
</style>
</head>
<body>
<h1>Life Assistant <small>v__VERSION__</small></h1>
<div class="sub" id="sub">加载中…</div>
<div class="grid" id="grid"></div>
<script>
  const q = new URLSearchParams(location.search).get("token");
  if (q) { localStorage.setItem("web_api_token", q); history.replaceState(null, "", location.pathname); }
  const token = localStorage.getItem("web_api_token");
  fetch("/api/status", token ? { headers: { Authorization: "Bearer " + token } } : {})
    .then(r => { if (!r.ok) throw new Error(r.status === 401 ? "未授权：URL 加 ?token=<WEB_API_TOKEN> 重试" : "HTTP " + r.status); return r.json(); })
    .then(s => {
      document.getElementById("sub").textContent =
        "运行 " + Math.floor(s.uptime_s / 60) + " 分钟 · 简报 " + s.daily_brief_cron +
        " · QWeather " + (s.qweather_configured ? "已配置" : "未配置");
      const card = (label, value, cls) =>
        '<div class="card"><span>' + label + '</span><b class="' + (cls || "") + '">' + value + "</b></div>";
      document.getElementById("grid").innerHTML = [
        card("Profile", s.profiles.length ? s.profiles.join("、") : "暂无"),
        card("活跃日程", s.schedules.active),
        card("待投递", s.notifications.queued, s.notifications.queued ? "warn" : "good"),
        card("投递失败/兜底", s.notifications.failed + " / " + s.notifications.fallback,
             (s.notifications.failed + s.notifications.fallback) ? "bad" : "good"),
        card("24h 已投递", s.notifications.sent_24h),
        card("账本", s.ledgers.total + (s.ledgers.archived ? "（含档 " + s.ledgers.archived + "）" : "")),
        card("本月支出", "¥" + (s.expenses.month_cents / 100).toFixed(2)),
        card("节假日数据", s.holidays.years.length ? s.holidays.years.join("、") + " 年" : "未导入", s.holidays.years.length ? "" : "warn"),
      ].join("");
    })
    .catch(e => { document.getElementById("sub").textContent = e.message; document.getElementById("sub").className = "sub bad"; });
</script>
</body>
</html>
`;

function statusPage(): string {
  return PAGE.replaceAll("__VERSION__", VERSION);
}
