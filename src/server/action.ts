// 副作用 import：模块注册入口（写路径经 registry.invokeTool，见 quick.ts 同款说明）
import "../modules/index.js";
import type { DatabaseSync } from "node:sqlite";
import type { Context } from "hono";
import { Hono } from "hono";
import { DateTime } from "luxon";
import type { ResolvedConfig } from "../config.js";
import {
  ACTION_LABEL,
  type ActionLinkClaims,
  actionTokenFingerprint,
  loadActionLinkTarget,
  verifyActionToken,
} from "../core/action-link.js";
import { auditTokenUsed, recordAudit } from "../core/audit.js";
import { logger, sanitizeLogText } from "../core/logger.js";
import { incCounter } from "../core/metrics.js";
import { envClientAddress } from "../core/ratelimit.js";
import { invokeTool, runtime, type ToolResult } from "../core/registry.js";
import { TZ } from "../time.js";

/**
 * 推送里的一键操作链接：`GET /a/<token>` 只渲染确认页，`POST /a/<token>` 才执行。
 *
 * - GET 绝不写库：IM 的链接预览、爬虫、浏览器预取都会发 GET，误触一次「完成」不可接受；
 * - 写路径经 `registry.invokeTool`（P2-24），每次真正执行都落 `audit_log`；
 * - 幂等：同一 token 重复 POST 回「已处理」而不是报错 —— done 看 occurrence 终态，
 *   snooze30 看审计里是否已有同一 token 指纹的成功记录（推迟本身没有终态可看）。
 * 鉴权档位与 `/calendar.ics` 相同：签名 URL（core/action-link.ts），不读任何 header 凭据。
 */

const AUDIT_ACTION: Record<ActionLinkClaims["action"], string> = {
  done: "link.schedule.done",
  snooze30: "link.schedule.snooze30",
};

type PageState =
  | { kind: "confirm"; title: string; when: string; claims: ActionLinkClaims }
  | { kind: "handled"; title: string; detail: string }
  | { kind: "result"; title: string; detail: string }
  | { kind: "error"; heading: string; detail: string };

/** 同一 token 正在执行中：单进程（daemon.lock 保证）内挡住并发双击 */
const inFlight = new Set<string>();

function localText(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: TZ });
  return dt.isValid ? dt.toFormat("yyyy-LL-dd HH:mm") : iso;
}

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 该 token 是否已经成功执行过（只认审计里同一指纹的记录） */
function alreadyExecuted(db: DatabaseSync, claims: ActionLinkClaims, fingerprint: string): boolean {
  return auditTokenUsed(db, {
    profileId: claims.profileId,
    action: AUDIT_ACTION[claims.action],
    targetId: claims.scheduleId,
    tokenFingerprint: fingerprint,
  });
}

/**
 * 不需要执行写操作时的结论（GET 与 POST 共用）：返回 null = 可以执行。
 * 顺序：日程不存在 → 跨 Profile → 本 token 已执行 → 日程/该次发生已结束。
 */
function settledState(
  db: DatabaseSync,
  claims: ActionLinkClaims,
  fingerprint: string,
): { state: PageState; status: 200 | 403 | 410 } | { state: null; title: string; when: string } {
  const { schedule, occurrence } = loadActionLinkTarget(
    db,
    claims.scheduleId,
    claims.occurrenceKey,
  );
  if (schedule === undefined) {
    return {
      state: { kind: "error", heading: "日程已不存在", detail: "该日程已被删除，无需再处理。" },
      status: 410,
    };
  }
  if (schedule.profile_id !== claims.profileId) {
    // 签名有效但目标不属于签发时的 Profile：只可能是数据被改过，按签名问题拒绝
    return {
      state: { kind: "error", heading: "签名无效", detail: "链接与日程归属不一致。" },
      status: 403,
    };
  }
  if (alreadyExecuted(db, claims, fingerprint)) {
    return {
      state: {
        kind: "handled",
        title: schedule.title,
        detail: `这条链接已经处理过（${ACTION_LABEL[claims.action]}），无需重复操作。`,
      },
      status: 200,
    };
  }
  if (schedule.status !== "active") {
    return {
      state: {
        kind: "handled",
        title: schedule.title,
        detail: schedule.status === "done" ? "该日程已完成。" : "该日程已取消。",
      },
      status: 200,
    };
  }
  if (occurrence === undefined) {
    return {
      state: {
        kind: "handled",
        title: schedule.title,
        detail: "这次提醒已不存在（可能已被清理或日程改期），无需处理。",
      },
      status: 200,
    };
  }
  if (occurrence.status === "done" || occurrence.status === "cancelled") {
    return {
      state: {
        kind: "handled",
        title: schedule.title,
        detail: occurrence.status === "done" ? "这次已经完成过了。" : "这次已被跳过/取消。",
      },
      status: 200,
    };
  }
  return { state: null, title: schedule.title, when: localText(occurrence.event_at) };
}

function toolPayload(result: ToolResult): Record<string, unknown> | null {
  try {
    return JSON.parse(result.content.map((p) => p.text).join("\n")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toolError(result: ToolResult): string {
  return result.content
    .map((p) => p.text)
    .join("\n")
    .replace(/^错误：/, "");
}

const STYLE = `
  *{box-sizing:border-box}
  body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;
    background:#f4f5f7;color:#1d1f23;padding:24px 16px}
  main{max-width:420px;margin:0 auto;background:#fff;border-radius:14px;padding:24px 20px;
    box-shadow:0 2px 12px rgba(0,0,0,.06)}
  h1{font-size:20px;margin:0 0 12px}
  p{margin:8px 0;word-break:break-word}
  .muted{color:#6b7280;font-size:14px}
  .tag{display:inline-block;padding:2px 10px;border-radius:999px;background:#eef2ff;color:#3730a3;font-size:14px}
  button{display:block;width:100%;margin-top:20px;padding:14px;font-size:17px;border:0;border-radius:10px;
    background:#2563eb;color:#fff;-webkit-appearance:none}
  .ok h1{color:#15803d}
  .err h1{color:#b91c1c}
  @media (prefers-color-scheme:dark){body{background:#0f1115;color:#e5e7eb}main{background:#1a1d23}
    .tag{background:#1e2a5a;color:#c7d2fe}.muted{color:#9ca3af}}
`;

function renderPage(state: PageState): string {
  let body: string;
  let cls = "";
  switch (state.kind) {
    case "confirm":
      body =
        `<h1>${esc(state.title)}</h1>` +
        `<p class="muted">时间：${esc(state.when)}</p>` +
        `<p>确认要 <span class="tag">${esc(ACTION_LABEL[state.claims.action])}</span> 吗？</p>` +
        // action 留空 = 提交到当前 URL（含路径前缀，反代挂子路径时也成立）
        `<form method="post"><button type="submit">确认${esc(ACTION_LABEL[state.claims.action])}</button></form>`;
      break;
    case "handled":
      cls = "ok";
      body = `<h1>已处理</h1><p>${esc(state.title)}</p><p class="muted">${esc(state.detail)}</p>`;
      break;
    case "result":
      cls = "ok";
      body = `<h1>${esc(state.title)}</h1><p>${esc(state.detail)}</p>`;
      break;
    case "error":
      cls = "err";
      body = `<h1>${esc(state.heading)}</h1><p class="muted">${esc(state.detail)}</p>`;
      break;
  }
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>生活助理</title><style>${STYLE}</style></head>
<body><main class="${cls}">${body}</main></body></html>`;
}

function html(c: Context, state: PageState, status: 200 | 403 | 409 | 410 | 503): Response {
  // 页面完全静态：不允许脚本；表单只能提交回本站
  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("X-Robots-Tag", "noindex, nofollow");
  // 不能用 no-referrer：表单 POST 会因此带 `Origin: null`，被 Host/Origin 守卫 403。
  // same-origin 只把 Referer（含 token）发给本站，跨站仍不泄露。
  c.header("Referrer-Policy", "same-origin");
  return c.html(renderPage(state), status);
}

export function createActionApp(config: ResolvedConfig, db: DatabaseSync): Hono {
  const app = new Hono();

  /** 验签；失败直接给出错误页（403/503），并与其它签名入口同口径计数留痕 */
  function verify(c: Context): { claims: ActionLinkClaims; fingerprint: string } | Response {
    const token = c.req.param("token") ?? "";
    const verdict = verifyActionToken(config, token);
    if (verdict.ok) return { claims: verdict.claims, fingerprint: actionTokenFingerprint(token) };
    if (verdict.reason === "unavailable") {
      return html(c, { kind: "error", heading: "操作链接不可用", detail: verdict.message }, 503);
    }
    incCounter("auth_failed_total");
    // 不记录 token 原文（它就是凭据），只记来源与固定原因
    logger.warn(
      `鉴权失败: /a/*** from ${sanitizeLogText(envClientAddress(c.env, config.trustProxy), 100)}（${verdict.reason === "expired" ? "已过期" : "签名无效"}）`,
    );
    return html(
      c,
      {
        kind: "error",
        heading: verdict.reason === "expired" ? "链接已过期" : "签名无效",
        detail: verdict.message,
      },
      403,
    );
  }

  app.get("/a/:token", (c) => {
    const verified = verify(c);
    if (verified instanceof Response) return verified;
    const settled = settledState(db, verified.claims, verified.fingerprint);
    if (settled.state !== null) return html(c, settled.state, settled.status);
    return html(
      c,
      { kind: "confirm", title: settled.title, when: settled.when, claims: verified.claims },
      200,
    );
  });

  app.post("/a/:token", async (c) => {
    const verified = verify(c);
    if (verified instanceof Response) return verified;
    const { claims, fingerprint } = verified;
    if (inFlight.has(fingerprint)) {
      return html(
        c,
        {
          kind: "handled",
          title: "正在处理",
          detail: "同一链接的上一次点击还在处理中，请稍候刷新。",
        },
        409,
      );
    }
    inFlight.add(fingerprint);
    try {
      const settled = settledState(db, claims, fingerprint);
      if (settled.state !== null) return html(c, settled.state, settled.status);

      const args: Record<string, unknown> =
        claims.action === "done"
          ? { action: "complete", id: claims.scheduleId, occurrence_key: claims.occurrenceKey }
          : {
              action: "snooze",
              id: claims.scheduleId,
              occurrence_key: claims.occurrenceKey,
              minutes: 30,
            };
      const result = await invokeTool("schedule", args, {
        profileId: claims.profileId,
        db,
        config,
        services: runtime().services,
      });
      if (result.isError === true) {
        return html(c, { kind: "error", heading: "操作失败", detail: toolError(result) }, 409);
      }
      const data = toolPayload(result) ?? {};
      let detail: string;
      let outcome: Record<string, unknown>;
      if (claims.action === "done") {
        const done = (data.已完成 ?? {}) as Record<string, unknown>;
        const next = done["下次提醒(本地)"];
        const ended = done.状态 === "done";
        detail = ended
          ? "已完成，该待办已结束。"
          : `已完成这一次。${typeof next === "string" ? `下次提醒：${next}` : "暂无下一次提醒。"}`;
        outcome = { 状态: done.状态 ?? null, "下次提醒(本地)": next ?? null };
      } else {
        const snoozed = (data.已推迟 ?? {}) as Record<string, unknown>;
        const at = snoozed["提醒时间(本地)"];
        detail = `已推迟，${typeof at === "string" ? `将在 ${at} 再次提醒。` : "稍后会再次提醒。"}`;
        outcome = { "提醒时间(本地)": at ?? null };
      }
      recordAudit(db, {
        profileId: claims.profileId,
        action: AUDIT_ACTION[claims.action],
        targetKind: "schedule",
        targetId: claims.scheduleId,
        detail: {
          标题: settled.title,
          occurrence_key: claims.occurrenceKey,
          token: fingerprint,
          ...outcome,
        },
      });
      return html(c, { kind: "result", title: settled.title, detail }, 200);
    } finally {
      inFlight.delete(fingerprint);
    }
  });

  return app;
}
