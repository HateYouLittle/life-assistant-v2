import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { DateTime } from "luxon";
import type { ResolvedConfig } from "../config.js";
import {
  CALENDAR_SIGNATURE_MISMATCH,
  escapeIcsText,
  formatIcsUtc,
  verifyCalendarSignature,
} from "../core/ics.js";
import { logger, sanitizeLogText } from "../core/logger.js";
import { incCounter } from "../core/metrics.js";
import { envClientAddress } from "../core/ratelimit.js";
import { TZ } from "../time.js";

/**
 * 日历订阅入口：`GET /calendar.ics?p=&exp=&sig=`（签名 URL，见 core/ics.ts）。
 *
 * 为什么要有这个入口：iOS/macOS/Android 的日历客户端订阅 URL 时**不能加请求头**，
 * 只能靠 URL 自带的签名换取一个 Profile 的只读日程流；公网入口由 NAS 的 Lucky 反代
 * 提供 HTTPS。这里只读 occurrences，不写任何东西，也不碰模块内部实现。
 */

/** 与 occurrence 物化窗口一致（modules/schedule 的 NEAR_HORIZON_DAYS = 62） */
const WINDOW_FUTURE_DAYS = 62;
/** 往前 1 天：刚过去、尚未结束的 occurrence 仍应留在订阅里 */
const WINDOW_PAST_DAYS = 1;
/** 定时事件的默认时长：occurrence 只有起始时刻（event_at），没有结束时刻 */
const TIMED_EVENT_MINUTES = 60;

interface CalendarRow {
  schedule_id: string;
  occurrence_key: string;
  event_at: string;
  title: string;
  note: string | null;
  all_day: number;
}

/** 校验失败 → HTTP 状态：503 是服务端没密钥；403 只给「签名被改过」；其余按 401 */
function errorStatus(config: ResolvedConfig, reason: string): 401 | 403 | 503 {
  if (config.webApiToken === undefined || config.webApiToken === "") return 503;
  return reason === CALENDAR_SIGNATURE_MISMATCH ? 403 : 401;
}

/**
 * 失败原因 → 可安全落日志的文本。
 *
 * `verdict.reason` 大多来自 core/ics.ts 的固定文案，但「Profile 名不合法: <p>」会把
 * query 里**解码后**的任意 p（ESC/换行/超长文本）带进来 —— 直接拼日志等于给未鉴权请求
 * 一个伪造/拆分审计日志、终端转义的入口。含用户输入的原因只记固定文案，其余仍统一净化
 * 并截断（防御性兜底）。
 */
function safeAuthFailureReason(reason: string): string {
  if (reason.startsWith("Profile 名不合法")) return "Profile 名不合法";
  return sanitizeLogText(reason, 200);
}

/** 组装 VCALENDAR 文本；行结束统一 CRLF，末尾留一个空行 */
function buildIcs(rows: CalendarRow[], now: Date): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//life-assistant//v2//CN",
    "CALSCALE:GREGORIAN",
    "X-WR-TIMEZONE:Asia/Shanghai",
    // 客户端最快 30 分钟拉一次：再密对个人日程没有意义，只会给反代和服务端加无谓压力
    "REFRESH-INTERVAL;VALUE=DURATION:PT30M",
    "X-PUBLISHED-TTL:PT30M",
  ];
  const stamp = formatIcsUtc(now);
  for (const row of rows) {
    const start = new Date(row.event_at);
    // 脏数据（event_at 不可解析）只跳过这一条：整份日历因一行坏数据 500，
    // 会让客户端直接放弃订阅，比少一条事件严重得多
    if (Number.isNaN(start.getTime())) continue;
    lines.push("BEGIN:VEVENT");
    // UID 是客户端去重的键：日程 id + occurrence_key 保证「同一日程的不同次发生」各自独立，
    // 改时间/改标题也不会让客户端把它当成新事件而重复提醒
    lines.push(`UID:${escapeIcsText(`${row.schedule_id}-${row.occurrence_key}@life-assistant`)}`);
    lines.push(`DTSTAMP:${stamp}`);
    if (row.all_day === 1) {
      // 全天事件用 DATE 值类型；DTEND 是**非含**的次日 —— 写成当天会让客户端显示成 0 天
      const day = DateTime.fromJSDate(start).setZone(TZ);
      lines.push(`DTSTART;VALUE=DATE:${day.toFormat("yyyyMMdd")}`);
      lines.push(`DTEND;VALUE=DATE:${day.plus({ days: 1 }).toFormat("yyyyMMdd")}`);
    } else {
      lines.push(`DTSTART:${formatIcsUtc(start)}`);
      lines.push(`DTEND:${formatIcsUtc(new Date(start.getTime() + TIMED_EVENT_MINUTES * 60_000))}`);
    }
    lines.push(`SUMMARY:${escapeIcsText(row.title)}`);
    if (row.note !== null && row.note !== "") {
      lines.push(`DESCRIPTION:${escapeIcsText(row.note)}`);
    }
    lines.push("STATUS:CONFIRMED");
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  // 每行都以 CRLF 终止（RFC 5545 不接受裸 LF），末尾再补一个空行
  return `${lines.join("\r\n")}\r\n\r\n`;
}

/** 该 Profile 在订阅窗口内的 occurrence（按 event_at 升序） */
function calendarRows(db: DatabaseSync, profileId: string, now: Date): CalendarRow[] {
  const from = new Date(now.getTime() - WINDOW_PAST_DAYS * 24 * 3600 * 1000).toISOString();
  const to = new Date(now.getTime() + WINDOW_FUTURE_DAYS * 24 * 3600 * 1000).toISOString();
  return db
    .prepare(
      `SELECT o.schedule_id, o.occurrence_key, o.event_at, s.title, s.note, s.all_day
       FROM occurrences o JOIN schedules s ON s.id = o.schedule_id
       WHERE s.profile_id = ? AND s.status = 'active'
         AND o.status IN ('pending','notified')
         AND o.event_at >= ? AND o.event_at <= ?
       ORDER BY o.event_at ASC, o.occurrence_key ASC`,
    )
    .all(profileId, from, to) as unknown as CalendarRow[];
}

export function createCalendarApp(config: ResolvedConfig, db: DatabaseSync): Hono {
  const app = new Hono();

  app.get("/calendar.ics", (c) => {
    const profileId = c.req.query("p");
    const verdict = verifyCalendarSignature(config, {
      p: profileId,
      exp: c.req.query("exp"),
      sig: c.req.query("sig"),
    });
    if (!verdict.ok) {
      const status = errorStatus(config, verdict.reason);
      // 401/403 是鉴权失败（缺参/过期/篡改）：与 /api/*、/mcp 同口径留痕，公网暴露后
      // 能看到签名探测；503 是「没配 WEB_API_TOKEN，订阅不可用」的配置问题，不算鉴权失败。
      if (status !== 503) {
        incCounter("auth_failed_total");
        // 不记录原始 p（见 safeAuthFailureReason）：原因与来源都只保留净化后的文本。
        logger.warn(
          `鉴权失败: /calendar.ics from ${sanitizeLogText(envClientAddress(c.env, config.trustProxy), 100)}（${safeAuthFailureReason(verdict.reason)}）`,
        );
      }
      // 中文说明 + 明确状态码：客户端/用户能区分「链接过期该重取」与「链接被改过」
      return c.json({ ok: false, error: verdict.reason }, status);
    }
    if (profileId === undefined) {
      // 不可达（verify 已确认 p 存在且合法），仅为类型收窄保留
      return c.json({ ok: false, error: "缺少 p 参数" }, 401);
    }
    const now = new Date();
    // 空库也返回合法的空 VCALENDAR：客户端会因非法/空响应体直接报错，
    // 「没有任何日程」必须是 200 + 一个合法日历
    const body = buildIcs(calendarRows(db, profileId, now), now);
    return c.body(body, 200, {
      "Content-Type": "text/calendar; charset=utf-8",
      // 订阅内容随时会变（新增/完成/顺延日程），不允许任何中间层缓存
      "Cache-Control": "no-store",
    });
  });

  return app;
}
