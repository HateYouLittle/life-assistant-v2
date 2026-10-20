import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { DateTime } from "luxon";
import { PROFILE_ID_RE, type ResolvedConfig } from "../config.js";
import { recordAudit } from "../core/audit.js";
import { resolveIdentity } from "../core/auth.js";
import { runtime, type ToolContext, type ToolResult } from "../core/registry.js";
import { ensureProfile } from "../core/settings.js";
import { bookkeepingExpenseTool } from "../modules/bookkeeping/index.js";
import {
  monthRange,
  recentCategories,
  resolveAddLedger,
  summarizeExpenses,
  writableLedgers,
} from "../modules/bookkeeping/service.js";
import { scheduleTool } from "../modules/schedule/index.js";
import { getSchedule, type ScheduleRow } from "../modules/schedule/service.js";
import { TZ, todayIso } from "../time.js";
import { resolveToken } from "./page.js";

/**
 * 手机快捷入口：`/quick`（零构建内联页面）+ `/api/quick/*`（写 API）。
 *
 * 设计要点：
 * - 身份只来自凭据：Profile token → 该 Profile；master → `?profile=` / body.profile（缺省
 *   default）。**绝不读 X-Hermes-Profile** —— 公网入口下自报身份等于没有鉴权。
 * - 写路径直接复用 MCP 工具层（`expense add` / `schedule add`），因此幂等键、通知回执、
 *   预算提醒、occurrence 物化这些副作用只有一份实现；这里只做 HTTP 形状的校验与包装。
 * - 页面与状态页同款 nonce CSP、token 引导（localStorage + 抹地址栏），不引入任何外链。
 */

const WEEKDAY_CN = ["一", "二", "三", "四", "五", "六", "日"];

/**
 * 页面凭据引导：`?token=` 落 localStorage 后抹掉地址栏里的 token，其余查询参数
 * （`type`/`amount`/`category`/`title`/`profile`，供小布指令与 NFC 预填）必须保留 ——
 * 状态页的清理逻辑会整段丢掉 search，直接用会把预填参数一起抹掉。
 *
 * 与 page.ts 的 resolveToken 一样会被 toString 内联进浏览器脚本，必须保持纯 JS 语法。
 */
export function stripTokenParam(search: string): string {
  const params = new URLSearchParams(search);
  params.delete("token");
  const rest = params.toString();
  return rest === "" ? "" : `?${rest}`;
}

/** 统一错误体：`{ok:false, error:"中文说明"}` */
function fail(c: Context, status: 400 | 401, error: string): Response {
  return c.json({ ok: false, error }, status);
}

/** 工具结果里的文本（okJson 是单个 JSON 文本块，fail 是「错误：…」文本块） */
function toolText(result: ToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

function toolErrorText(result: ToolResult): string {
  return toolText(result).replace(/^错误：/, "");
}

/**
 * 工具上下文：services 取自 runtime，与 MCP 工具共用同一套通知/预算副作用实现
 * （测试里 makeTestEnv 注入的是记录桩，能直接断言回执发布）。
 */
function toolContext(db: DatabaseSync, config: ResolvedConfig, profileId: string): ToolContext {
  return { profileId, db, config, services: runtime().services };
}

interface Who {
  profileId: string;
}

/**
 * 解析请求身份并落到目标 Profile。
 * - 无凭据 → 401（未配置任何 token 时 resolveIdentity 返回 master，保持回环零配置可用）；
 * - Profile token → 该 Profile（请求里的 profile 参数一律忽略）；
 * - master → `?profile=` 或 body.profile，缺省 default；名字必须合法，否则 400。
 */
function whoAmI(
  config: ResolvedConfig,
  authorization: string | undefined,
  requestedProfile: unknown,
): Who | { error: string; status: 400 | 401 } {
  const identity = resolveIdentity({
    masterToken: config.webApiToken,
    profileTokens: config.profileTokens,
    authorization,
  });
  if (identity === null) {
    return {
      error: "未授权：请携带 Authorization: Bearer <token>（手机页面用 ?token= 引导一次即可）",
      status: 401,
    };
  }
  if (identity.kind === "profile") return { profileId: identity.profileId };
  const wanted =
    requestedProfile === undefined || requestedProfile === null || requestedProfile === ""
      ? "default"
      : requestedProfile;
  if (typeof wanted !== "string" || !PROFILE_ID_RE.test(wanted)) {
    return { error: `Profile 名不合法: ${String(wanted)}`, status: 400 };
  }
  return { profileId: wanted };
}

/** 请求体：必须是 JSON 对象；解析失败/形状不对都返回中文错误 */
type BodyResult = { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

async function readJsonBody(c: Context): Promise<BodyResult> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, error: "请求体必须是合法 JSON" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "请求体必须是 JSON 对象" };
  }
  return { ok: true, value: raw as Record<string, unknown> };
}

/** 可选字符串字段：缺省/空串视为未提供，非字符串直接报错（不静默丢弃） */
function optionalText(
  value: unknown,
  field: string,
): { ok: true; value?: string } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (typeof value !== "string") return { ok: false, error: `${field} 必须是字符串` };
  const trimmed = value.trim();
  return trimmed === "" ? { ok: true } : { ok: true, value: trimmed };
}

/**
 * 金额（元）：接受数字或数字字符串。与 MCP `expense add` 同口径（0 < x ≤ 100 万），
 * 更细的「分必须为正整数」由 service 层兜底。
 */
function normalizeAmount(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
  return n;
}

/** remind_offsets：可选整数数组（范围/条数由 service 层校验） */
function optionalOffsets(
  value: unknown,
): { ok: true; value?: number[] } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true };
  if (!Array.isArray(value)) return { ok: false, error: "remind_offsets 必须是分钟数组" };
  const offsets: number[] = [];
  for (const item of value) {
    const n = Number(item);
    if (!Number.isInteger(n)) return { ok: false, error: "remind_offsets 必须是整数分钟" };
    offsets.push(n);
  }
  return { ok: true, value: offsets };
}

/** 日程的「事件时间」文本：本地日历日 + 时刻（全天另标） */
function eventTimeText(row: ScheduleRow): string | null {
  if (row.start_date === null) return null;
  return `${row.start_date} ${row.time}${row.all_day === 1 ? "（全天）" : ""}`;
}

/** bootstrap：当前身份可见的账本、默认账本、常用分类与本月概况 */
function bootstrapPayload(db: DatabaseSync, profileId: string): Record<string, unknown> {
  const ledgers = writableLedgers(db, profileId);
  const resolved = resolveAddLedger(db, profileId);
  const today = todayIso();
  const month = monthRange(today.slice(0, 7));
  const at = DateTime.now().setZone(TZ);
  // 常用分类按默认账本取；没有确定默认账本时退到第一个可见账本 —— 这只是 chips 的
  // 展示来源，不替用户选账本（真正落库的账本仍由 add 的默认解析决定）。
  const chipLedger = resolved.ledger ?? ledgers[0];
  const activeSchedules = db
    .prepare("SELECT COUNT(*) AS n FROM schedules WHERE profile_id = ? AND status = 'active'")
    .get(profileId) as { n: number };
  return {
    profile: profileId,
    ledgers: ledgers.map((row) => ({ id: row.id, name: row.name })),
    default_ledger_id: resolved.ledger?.id ?? null,
    recent_categories: chipLedger === undefined ? [] : recentCategories(db, chipLedger.id),
    today: { date: today, weekday: `周${WEEKDAY_CN[at.weekday - 1] ?? ""}` },
    // 本月支出 = 该 Profile 可见账本（家庭 + 自己的个人）的合计，与状态页同一「自然月全月」口径
    month_cents: ledgers.reduce(
      (sum, ledger) => sum + summarizeExpenses(db, ledger.id, month).total_cents,
      0,
    ),
    active_schedules: activeSchedules.n,
  };
}

export function createQuickApp(config: ResolvedConfig, db: DatabaseSync): Hono {
  const app = new Hono();
  // 与状态页同一套安全响应头：页面渲染的是个人账目/日程，凭据可能出现在 ?token= 的 URL 里
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    if (c.req.path.startsWith("/api/")) c.header("Cache-Control", "no-store");
  });

  app.get("/api/quick/bootstrap", (c) => {
    const who = whoAmI(config, c.req.header("Authorization"), c.req.query("profile"));
    if ("error" in who) return fail(c, who.status, who.error);
    return c.json({ ok: true, ...bootstrapPayload(db, who.profileId) });
  });

  app.post("/api/quick/expenses", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return fail(c, 400, parsed.error);
    const body = parsed.value;
    // master 的目标 Profile：body.profile 优先，其次 ?profile=（HTTP Shortcuts 常把参数放 URL）
    const who = whoAmI(
      config,
      c.req.header("Authorization"),
      body.profile ?? c.req.query("profile"),
    );
    if ("error" in who) return fail(c, who.status, who.error);

    const amount = normalizeAmount(body.amount);
    if (amount === null) {
      return fail(c, 400, "金额不合法：需要 0.01–1000000 之间的数字（单位：元）");
    }
    const ledgerId = optionalText(body.ledger_id, "ledger_id");
    if (!ledgerId.ok) return fail(c, 400, ledgerId.error);
    const category = optionalText(body.category, "category");
    if (!category.ok) return fail(c, 400, category.error);
    const note = optionalText(body.note, "note");
    if (!note.ok) return fail(c, 400, note.error);
    const spentOn = optionalText(body.spent_on, "spent_on");
    if (!spentOn.ok) return fail(c, 400, spentOn.error);
    const requestId = optionalText(body.request_id, "request_id");
    if (!requestId.ok) return fail(c, 400, requestId.error);

    // 手机入口没有 MCP 会话的 ensureProfile：先登记 Profile，个人账本归属与审计外键都依赖它
    // （审计表 profile_id 有外键，未登记的 Profile 会让审计静默失败）。
    ensureProfile(db, who.profileId);
    // 走工具层：默认账本解析、可见性判定、client_token 幂等、回执与预算提醒都在那里
    const args: Record<string, unknown> = { action: "add", amount };
    if (ledgerId.value !== undefined) args.ledger_id = ledgerId.value;
    if (category.value !== undefined) args.category = category.value;
    if (note.value !== undefined) args.note = note.value;
    if (spentOn.value !== undefined) args.date = spentOn.value;
    if (requestId.value !== undefined) args.request_id = requestId.value;

    const result = bookkeepingExpenseTool(args, toolContext(db, config, who.profileId));
    if (result.isError === true) return fail(c, 400, toolErrorText(result));
    const data = JSON.parse(toolText(result)) as {
      已记账?: { id?: string; 账本?: string; 分类?: string };
      已存在?: boolean;
    };
    const entry = data.已记账 ?? {};
    // 审计：手机写 API 是唯一不经 MCP 的写路径，留痕用于回溯「谁记的、记到哪个账本」。
    // 只放非隐私摘要 —— 备注全文可能含身体/医疗等敏感信息，token 更不能落库。
    recordAudit(db, {
      profileId: who.profileId,
      action: "quick.expense.add",
      targetKind: "expense",
      targetId: entry.id,
      detail: {
        金额: amount,
        分类: entry.分类 ?? null,
        账本: entry.账本 ?? null,
        ...(data.已存在 === true ? { 已存在: true } : {}),
      },
    });
    return c.json(
      {
        ok: true,
        id: entry.id,
        ledger_name: entry.账本,
        category: entry.分类,
        ...(data.已存在 === true ? { 已存在: true } : {}),
      },
      201,
    );
  });

  app.post("/api/quick/schedules", async (c) => {
    const parsed = await readJsonBody(c);
    if (!parsed.ok) return fail(c, 400, parsed.error);
    const body = parsed.value;
    // master 的目标 Profile：body.profile 优先，其次 ?profile=（HTTP Shortcuts 常把参数放 URL）
    const who = whoAmI(
      config,
      c.req.header("Authorization"),
      body.profile ?? c.req.query("profile"),
    );
    if ("error" in who) return fail(c, who.status, who.error);

    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (title === "") return fail(c, 400, "标题不能为空");
    if (title.length > 120) return fail(c, 400, "标题过长（≤120 字符）");
    const date = optionalText(body.date, "date");
    if (!date.ok) return fail(c, 400, date.error);
    const time = optionalText(body.time, "time");
    if (!time.ok) return fail(c, 400, time.error);
    const note = optionalText(body.note, "note");
    if (!note.ok) return fail(c, 400, note.error);
    const requestId = optionalText(body.request_id, "request_id");
    if (!requestId.ok) return fail(c, 400, requestId.error);
    const offsets = optionalOffsets(body.remind_offsets);
    if (!offsets.ok) return fail(c, 400, offsets.error);
    if (body.all_day !== undefined && typeof body.all_day !== "boolean") {
      return fail(c, 400, "all_day 必须是布尔值");
    }

    ensureProfile(db, who.profileId);
    // 缺省「今天 09:00」：手机页面的快捷 chips 一定会给日期，API 直连（HTTP Shortcuts）
    // 只给标题时也要能落地，而不是回一句「公历日程需要提供 date」。
    const args: Record<string, unknown> = {
      action: "add",
      title,
      date: date.value ?? todayIso(),
      time: time.value ?? "09:00",
    };
    if (body.all_day !== undefined) args.all_day = body.all_day;
    if (note.value !== undefined) args.note = note.value;
    if (offsets.value !== undefined) args.remind_offsets = offsets.value;
    if (requestId.value !== undefined) args.request_id = requestId.value;

    const result = scheduleTool(args, toolContext(db, config, who.profileId));
    if (result.isError === true) return fail(c, 400, toolErrorText(result));
    const data = JSON.parse(toolText(result)) as {
      已创建?: { id?: string };
      已存在?: boolean;
    };
    const id = data.已创建?.id ?? "";
    const row = id === "" ? undefined : getSchedule(db, who.profileId, id);
    // 审计：标题是识别「这条记录是什么」的最小必要信息；备注（可能含隐私）不进审计。
    recordAudit(db, {
      profileId: who.profileId,
      action: "quick.schedule.add",
      targetKind: "schedule",
      targetId: id === "" ? null : id,
      detail: {
        标题: title,
        事件时间: row === undefined ? null : eventTimeText(row),
        ...(data.已存在 === true ? { 已存在: true } : {}),
      },
    });
    return c.json(
      {
        ok: true,
        id,
        事件时间: row === undefined ? null : eventTimeText(row),
        ...(data.已存在 === true ? { 已存在: true } : {}),
      },
      201,
    );
  });

  app.get("/quick", (c) => {
    // 与状态页同样的 nonce 方案：即使有人往账本名/备注里塞 <img onerror=…>，
    // 浏览器也会拒绝执行注入的内联处理器。
    const nonce = randomBytes(16).toString("base64");
    c.header(
      "Content-Security-Policy",
      [
        "default-src 'none'",
        `script-src 'nonce-${nonce}'`,
        "style-src 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    return c.html(quickPage(nonce));
  });

  return app;
}

const QUICK_STYLE = `
  :root {
    --bg: #0a0c11;
    --card: rgba(255,255,255,.032);
    --line: rgba(255,255,255,.08);
    --fg: #e9eef6;
    --dim: #8e99a8;
    --mute: #5b6575;
    --teal: #5eead4;
    --green: #4ade80;
    --amber: #fbbf24;
    --red: #f87171;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 18px 16px calc(40px + env(safe-area-inset-bottom, 0px));
    min-height: 100vh; background: var(--bg); color: var(--fg);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    font-variant-numeric: tabular-nums; -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 520px; margin: 0 auto; }
  .head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
  .mark {
    width: 40px; height: 40px; border-radius: 12px; flex: none; display: grid; place-items: center;
    font-size: 15px; font-weight: 700; color: #04231f; background: linear-gradient(140deg, #5eead4, #38bdf8);
  }
  h1 { margin: 0; font-size: 17px; font-weight: 600; }
  .sub { color: var(--dim); font-size: 12.5px; margin-top: 2px; }
  .hint {
    background: rgba(251,191,36,.1); border: 1px solid rgba(251,191,36,.28); color: #fcd34d;
    border-radius: 12px; padding: 12px 14px; font-size: 13px; margin-bottom: 14px;
  }
  .hint code { color: #fde68a; }
  .modes { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px; }
  .big-btn {
    padding: 20px 12px; border-radius: 16px; border: 1px solid var(--line); background: var(--card);
    color: var(--fg); font-size: 17px; font-weight: 600; cursor: pointer;
  }
  .big-btn.on {
    border-color: rgba(94,234,212,.5); color: #04231f;
    background: linear-gradient(140deg, #5eead4, #38bdf8);
  }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 16px; padding: 16px; }
  .lbl { display: block; color: var(--dim); font-size: 12.5px; margin: 12px 0 6px; }
  .lbl:first-child { margin-top: 0; }
  input, select {
    width: 100%; padding: 12px; border-radius: 12px; border: 1px solid var(--line);
    background: rgba(0,0,0,.25); color: var(--fg); font-size: 16px;
  }
  input.amount { font-size: 30px; font-weight: 600; letter-spacing: -.02em; padding: 10px 12px; }
  .chips { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 8px; }
  .chip {
    padding: 7px 13px; border-radius: 999px; border: 1px solid var(--line);
    background: transparent; color: var(--fg); font-size: 14px; cursor: pointer;
  }
  .chip:active { border-color: var(--teal); color: var(--teal); }
  .submit {
    width: 100%; margin-top: 18px; padding: 15px; border-radius: 14px; border: 0;
    background: linear-gradient(140deg, #5eead4, #38bdf8); color: #04231f; font-size: 16px; font-weight: 600;
    cursor: pointer;
  }
  .again {
    width: 100%; margin-top: 10px; padding: 13px; border-radius: 14px;
    border: 1px solid var(--line); background: transparent; color: var(--fg); font-size: 15px; cursor: pointer;
  }
  .toast {
    min-height: 22px; margin-top: 14px; font-size: 13.5px; color: var(--dim);
    white-space: pre-wrap; word-break: break-word;
  }
  .toast.ok { color: var(--green); }
  .toast.bad { color: var(--red); }
  .tip { color: var(--mute); font-size: 12px; margin-top: 18px; line-height: 1.6; }
  .bad { color: var(--red); }
`;

const QUICK_SCRIPT = `
  var token = (${resolveToken.toString()})(location.search, localStorage);
  if (location.search.indexOf('token=') >= 0 && typeof history !== 'undefined' && history.replaceState) {
    // 只抹 token，保留 type/amount/category/title/profile 等预填参数
    history.replaceState(null, '', location.pathname + (${stripTokenParam.toString()})(location.search));
  }
  var qs = new URLSearchParams(location.search);
  var profileParam = qs.get('profile') || '';
  var prefill = {
    type: qs.get('type') || '',
    amount: qs.get('amount') || '',
    category: qs.get('category') || '',
    title: qs.get('title') || ''
  };
  var boot = null;

  function el(id) { return document.getElementById(id); }
  function esc(text) {
    return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function yuan(cents) {
    return '¥' + (Number(cents || 0) / 100).toFixed(2);
  }
  function toast(msg, kind) {
    var box = el('toast');
    box.textContent = msg;
    box.className = 'toast ' + (kind || '');
  }
  /* 幂等键：同一次提交在网络抖动后重试不会重复记账（服务端按 client_token 去重） */
  function newRequestId() {
    return 'quick-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  function api(path, init) {
    var opts = init || {};
    var headers = opts.headers || {};
    if (token) headers.Authorization = 'Bearer ' + token;
    opts.headers = headers;
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + r.status);
        return body;
      });
    });
  }
  function showPanel(mode) {
    el('panel-expense').hidden = mode !== 'expense';
    el('panel-schedule').hidden = mode !== 'schedule';
    el('btn-expense').className = 'big-btn' + (mode === 'expense' ? ' on' : '');
    el('btn-schedule').className = 'big-btn' + (mode === 'schedule' ? ' on' : '');
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function localDateTime(d, hhmm) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + hhmm;
  }
  function fillWhen(kind) {
    var now = new Date();
    var when = new Date(now.getTime());
    var hhmm = kind === 'tomorrow' ? '09:00' : '20:00';
    // 「今晚 20:00」在 20:00 之后点已经没有意义：顺延到明天，而不是设一个已过去的提醒
    if (kind !== 'tomorrow' && now.getHours() * 60 + now.getMinutes() >= 20 * 60) {
      when.setDate(when.getDate() + 1);
    }
    el('when').value = localDateTime(when, hhmm);
  }

  function render(b) {
    boot = b;
    var ledgers = b.ledgers || [];
    el('ledger').innerHTML = ledgers.length
      ? ledgers.map(function (l) {
          return '<option value="' + esc(l.id) + '"' + (l.id === b.default_ledger_id ? ' selected' : '') + '>' +
            esc(l.name) + '</option>';
        }).join('')
      : '<option value="">（没有可用账本，请先在 Hermes 里建一个）</option>';
    el('cat-chips').innerHTML = (b.recent_categories || []).map(function (cat) {
      return '<button type="button" class="chip" data-cat="' + esc(cat) + '">' + esc(cat) + '</button>';
    }).join('');
    var today = b.today ? b.today.date + ' ' + b.today.weekday + ' · ' : '';
    el('summary').textContent = today + '本月已花 ' + yuan(b.month_cents) + ' · ' + b.active_schedules + ' 项提醒进行中';
    el('token-hint').hidden = true;
  }
  function refresh() {
    var path = '/api/quick/bootstrap' + (profileParam ? '?profile=' + encodeURIComponent(profileParam) : '');
    api(path).then(render).catch(function (e) {
      el('token-hint').hidden = false;
      el('summary').textContent = '未连接';
      toast(e.message, 'bad');
    });
  }

  function submitExpense() {
    var raw = el('amount').value;
    var amount = Number(raw);
    if (raw === '' || !isFinite(amount) || amount <= 0) {
      toast('请输入正确的金额', 'bad');
      return;
    }
    var payload = { amount: amount, request_id: newRequestId() };
    var ledger = el('ledger').value;
    if (ledger) payload.ledger_id = ledger;
    else if (boot && boot.default_ledger_id) payload.ledger_id = boot.default_ledger_id;
    if (el('category').value) payload.category = el('category').value;
    if (el('note').value) payload.note = el('note').value;
    if (profileParam) payload.profile = profileParam;
    api('/api/quick/expenses', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (d) {
      var extra = d['已存在'] ? '（重复提交，未重复记账）' : '';
      toast('已记账 ' + yuan(Math.round(amount * 100)) + ' · ' + d.category + ' · ' + d.ledger_name + extra, 'ok');
      el('amount').value = '';
      el('note').value = '';
      el('again').hidden = false;
    }).catch(function (e) {
      toast('记账失败：' + e.message, 'bad');
    });
  }

  function submitSchedule() {
    var title = el('title').value.trim();
    if (title === '') {
      toast('请输入提醒内容', 'bad');
      return;
    }
    var payload = { title: title, request_id: newRequestId() };
    var when = el('when').value;
    // datetime-local 的值是本地时间文本 YYYY-MM-DDTHH:MM，拆成 date + time 传（服务端按时区解释）
    if (when && when.length >= 16) {
      payload.date = when.slice(0, 10);
      payload.time = when.slice(11, 16);
    }
    if (el('note-schedule').value) payload.note = el('note-schedule').value;
    if (profileParam) payload.profile = profileParam;
    api('/api/quick/schedules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (d) {
      var extra = d['已存在'] ? '（重复提交，未重复创建）' : '';
      toast('已设提醒 ' + (d['事件时间'] || '') + extra, 'ok');
      el('title').value = '';
      el('note-schedule').value = '';
    }).catch(function (e) {
      toast('设置失败：' + e.message, 'bad');
    });
  }

  el('btn-expense').addEventListener('click', function () { showPanel('expense'); });
  el('btn-schedule').addEventListener('click', function () { showPanel('schedule'); });
  el('cat-chips').addEventListener('click', function (ev) {
    var target = ev && ev.target;
    var cat = target && target.getAttribute ? target.getAttribute('data-cat') : null;
    if (cat) el('category').value = cat;
  });
  el('when-chips').addEventListener('click', function (ev) {
    var target = ev && ev.target;
    var kind = target && target.getAttribute ? target.getAttribute('data-when') : null;
    if (kind) fillWhen(kind);
  });
  el('submit-expense').addEventListener('click', submitExpense);
  el('submit-schedule').addEventListener('click', submitSchedule);
  el('again').addEventListener('click', function () {
    el('again').hidden = true;
    if (typeof el('amount').focus === 'function') el('amount').focus();
  });

  // 预填（小布指令 / NFC：/quick?type=expense&amount=20&category=餐饮）
  if (prefill.amount) el('amount').value = prefill.amount;
  if (prefill.category) el('category').value = prefill.category;
  if (prefill.title) el('title').value = prefill.title;
  if (!el('when').value) fillWhen('tomorrow');
  if (prefill.type === 'schedule') showPanel('schedule');
  refresh();
`;

export function quickPage(nonce?: string): string {
  // nonce 由 createQuickApp 每次请求生成，配合 CSP 的 script-src 'nonce-…'
  const nonceAttr = nonce === undefined ? "" : ` nonce="${nonce}"`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<meta name="theme-color" content="#0a0c11" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-title" content="生活助理" />
<title>生活助理 · 快捷</title>
<style${nonceAttr}>${QUICK_STYLE}</style>
</head>
<body>
<div class="wrap">

  <header class="head">
    <div class="mark">LA</div>
    <div>
      <h1>生活助理</h1>
      <div class="sub" id="summary">加载中…</div>
    </div>
  </header>

  <div class="hint" id="token-hint" hidden>
    未授权：请在地址栏给本页加上 <code>?token=&lt;你的 token&gt;</code> 刷新一次（本页会记住，之后从主屏幕打开无需再输）。
  </div>

  <div class="modes">
    <button type="button" class="big-btn on" id="btn-expense">记一笔</button>
    <button type="button" class="big-btn" id="btn-schedule">设提醒</button>
  </div>

  <section class="card" id="panel-expense">
    <label class="lbl" for="amount">金额（元）</label>
    <input class="amount" id="amount" type="text" inputmode="decimal" autocomplete="off" placeholder="0.00" />
    <label class="lbl" for="ledger">账本</label>
    <select id="ledger"></select>
    <label class="lbl" for="category">分类</label>
    <div class="chips" id="cat-chips"></div>
    <input id="category" type="text" maxlength="20" placeholder="可手输，如 餐饮" />
    <label class="lbl" for="note">备注（可选）</label>
    <input id="note" type="text" maxlength="200" placeholder="买了什么" />
    <button type="button" class="submit" id="submit-expense">记下这一笔</button>
    <button type="button" class="again" id="again" hidden>再记一笔</button>
  </section>

  <section class="card" id="panel-schedule" hidden>
    <label class="lbl" for="title">提醒内容</label>
    <input id="title" type="text" maxlength="120" placeholder="如 交房租" />
    <label class="lbl" for="when">时间</label>
    <div class="chips" id="when-chips">
      <button type="button" class="chip" data-when="tonight">今晚 20:00</button>
      <button type="button" class="chip" data-when="tomorrow">明早 09:00</button>
    </div>
    <input id="when" type="datetime-local" />
    <label class="lbl" for="note-schedule">备注（可选）</label>
    <input id="note-schedule" type="text" maxlength="500" placeholder="补充说明" />
    <button type="button" class="submit" id="submit-schedule">设好提醒</button>
  </section>

  <div class="toast" id="toast"></div>

  <p class="tip">提示：在浏览器菜单里选「添加到主屏幕」，之后从桌面图标一键进入，不必再输 token。</p>

</div>
<script${nonceAttr}>${QUICK_SCRIPT}</script>
</body>
</html>`;
}
