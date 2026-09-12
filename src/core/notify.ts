import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedConfig } from "../config.js";
import { inQuietWindow, nowIso } from "../time.js";
import { logger } from "./logger.js";
import { renderBlocks } from "./render.js";
import type { PublishInput, PublishResult, Services } from "./registry.js";
import { ensureProfile, getSetting, newId, setSetting } from "./settings.js";

/**
 * Outbox：通知 + 投递记录在同一事务写入；单写者进程内投递。
 * 投递协议与 v1 完全兼容（对照旧仓库 src/core/notify-delivery.ts 核对）：
 * deliver-only 回环 webhook、HMAC-SHA256 V2、X-Request-ID、10s 超时、有界重试。
 */

const LADDER_SECONDS = [60, 300, 900, 3600];
const MAX_CONFIRMED_FAILURES = 5;
const MAX_TRANSPORT_FAILURES = 3;
const IDEMPOTENCY_WINDOW_MS = 55 * 60 * 1000;
const BATCH_LIMIT = 100;
const CONCURRENCY = 5;
const DRAIN_BUDGET_MS = 45_000;
export const EVENT_TYPE = "life_assistant.reminder";

export interface PushRoute {
  name: string;
  url: string;
  platform: string | null;
  enabled: boolean;
}

interface DeliveryRow {
  id: string;
  notification_id: string;
  route_name: string;
  status: string;
  attempts: number;
  confirmed_failures: number;
  transport_failures: number;
  generation: number;
  request_id: string | null;
  request_started_at: string | null;
  profile_id: string;
  kind: string;
  title: string;
  body_md: string;
  n_created_at: string;
}

export function getPushRoute(db: DatabaseSync, profileId: string): PushRoute | null {
  return getSetting<PushRoute>(db, profileId, "push_route") ?? null;
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** 路由 URL 仅接受回环主机名（与 v1 一致的安全默认） */
export function setPushRoute(
  db: DatabaseSync,
  profileId: string,
  input: { url: string; platform?: string; name?: string; enabled?: boolean },
): PushRoute {
  let parsed: URL;
  try {
    parsed = new URL(input.url);
  } catch {
    throw new Error(`推送 URL 不合法: ${input.url}`);
  }
  const hostname = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) {
    throw new Error(`推送 URL 仅接受 127.0.0.1 / localhost / [::1] 主机名，收到: ${hostname}`);
  }
  const route: PushRoute = {
    name: input.name?.trim() || `life-assistant-${profileId}`,
    url: parsed.toString(),
    platform: input.platform?.trim() || null,
    enabled: input.enabled ?? true,
  };
  setSetting(db, profileId, "push_route", route);
  requeueRoute(db, profileId, route.name);
  return route;
}

export function clearPushRoute(db: DatabaseSync, profileId: string): void {
  setSetting(db, profileId, "push_route", { name: `life-assistant-${profileId}`, url: "", platform: null, enabled: false });
}

export function routeSecret(config: ResolvedConfig, profileId: string): string | undefined {
  return config.profileRouteSecrets[profileId];
}

export function routedProfiles(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT profile_id, value_json FROM settings WHERE key = 'push_route'").all() as {
    profile_id: string;
    value_json: string;
  }[];
  return rows
    .map((r) => {
      try {
        return { profile_id: r.profile_id, route: JSON.parse(r.value_json) as PushRoute };
      } catch {
        return null;
      }
    })
    .filter((r): r is { profile_id: string; route: PushRoute } => r !== null)
    .filter((r) => r.route.enabled && r.route.url !== "")
    .map((r) => r.profile_id)
    .sort();
}

export function createServices(db: DatabaseSync, config: ResolvedConfig): Services {
  return {
    publishProfile: async (profileId, input) => publishProfile(db, config, profileId, input),
    publishGlobal: async (input) => publishGlobal(db, config, input),
  };
}

/** 私有通知：即使无路由也保留，供 notify.pull 兜底 */
export function publishProfile(
  db: DatabaseSync,
  config: ResolvedConfig,
  profileId: string,
  input: PublishInput,
): PublishResult {
  ensureProfile(db, profileId);
  if (input.dedupeKey !== undefined) {
    const existing = db
      .prepare("SELECT id FROM notifications WHERE profile_id = ? AND dedupe_key = ?")
      .get(profileId, input.dedupeKey) as { id: string } | undefined;
    if (existing !== undefined) return { id: existing.id, deduped: true };
  }

  const rendered = renderBlocks(input.blocks, "markdown");
  // 标题只走 title 字段：投递 payload 与 notify.pull 都单独返回标题，
  // 正文若再拼一次，两端各会多渲染一行重复标题。
  const bodyMd = rendered.body;
  const id = newId();
  const createdAt = nowIso();
  db.prepare(
    `INSERT INTO notifications (id, profile_id, kind, title, body_md, blocks_json, dedupe_key, read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    profileId,
    input.kind,
    input.title,
    bodyMd,
    JSON.stringify(input.blocks),
    input.dedupeKey ?? null,
    createdAt,
  );

  const route = getPushRoute(db, profileId);
  const secret = routeSecret(config, profileId);
  if (route?.enabled && route.url !== "") {
    if (secret === undefined) {
      logger.warn(`Profile ${profileId} 已配置推送路由但 PROFILE_ROUTE_SECRETS_JSON 缺少对应 secret，通知仅保留可 pull`);
    } else {
      db.prepare(
        `INSERT INTO deliveries (id, notification_id, route_name, status, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', ?, ?, ?)`,
      ).run(newId(), id, route.name, createdAt, createdAt, createdAt);
      drainSoon(db, config);
    }
  }
  return { id, deduped: false };
}

/** 全局事件：只为配置了启用路由的 Profile 物化（Profile 内去重） */
export async function publishGlobal(
  db: DatabaseSync,
  config: ResolvedConfig,
  input: PublishInput,
): Promise<{ materialized: number }> {
  let materialized = 0;
  for (const profileId of routedProfiles(db)) {
    const result = publishProfile(db, config, profileId, input);
    if (!result.deduped) materialized += 1;
  }
  return { materialized };
}

/** 用户 pull 后，取消这些通知的待处理投递 */
export function cancelPendingDeliveries(db: DatabaseSync, profileId: string, notificationIds: string[]): void {
  if (notificationIds.length === 0) return;
  const placeholders = notificationIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE deliveries SET status = 'cancelled', updated_at = ?
     WHERE status IN ('queued','failed')
       AND notification_id IN (${placeholders})
       AND notification_id IN (SELECT id FROM notifications WHERE profile_id = ?)`,
  ).run(nowIso(), ...notificationIds, profileId);
}

/** 启动/每轮：超过幂等窗口的不确定投递进入 fallback；其余 sending 复位为 queued */
export function recoverStaleSending(db: DatabaseSync): void {
  const cutoff = new Date(Date.now() - IDEMPOTENCY_WINDOW_MS).toISOString();
  db.prepare(
    `UPDATE deliveries SET status = 'fallback', last_error = 'uncertain delivery exceeded webhook idempotency window', updated_at = ?
     WHERE status = 'sending' AND request_started_at IS NOT NULL AND request_started_at < ?`,
  ).run(nowIso(), cutoff);
  db.prepare(
    `UPDATE deliveries SET status = 'queued', request_started_at = NULL, updated_at = ?
     WHERE status = 'sending'`,
  ).run(nowIso());
}

/** 路由恢复：仅从未发出不确定请求的行重新入队（generation 递增） */
function requeueRoute(db: DatabaseSync, profileId: string, routeName: string): void {
  db.prepare(
    `UPDATE deliveries SET status = 'queued', generation = generation + 1, next_attempt_at = ?, updated_at = ?
     WHERE status = 'fallback' AND route_name = ? AND request_started_at IS NULL
       AND notification_id IN (SELECT id FROM notifications WHERE profile_id = ?)`,
  ).run(nowIso(), nowIso(), routeName, profileId);
}

let drainTimer: ReturnType<typeof setTimeout> | null = null;
let draining = false;

/** 发布后即时触发一轮投递（去抖） */
export function drainSoon(db: DatabaseSync, config: ResolvedConfig): void {
  if (drainTimer !== null || draining) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drainDue(db, config).catch((e) => logger.error(`outbox drain 失败: ${e instanceof Error ? e.message : e}`));
  }, 100);
}

/** 投递到期的 outbox 行；返回处理的行数。调度器每 20s 调一次，发布时也会即时触发 */
export async function drainDue(db: DatabaseSync, config: ResolvedConfig): Promise<number> {
  if (draining) return 0;
  draining = true;
  try {
    recoverStaleSending(db);
    const deadline = Date.now() + DRAIN_BUDGET_MS;
    let processed = 0;
    for (;;) {
      const now = nowIso();
      const rows = db
        .prepare(
          `SELECT d.*, n.profile_id, n.kind, n.title, n.body_md, n.created_at AS n_created_at
           FROM deliveries d JOIN notifications n ON n.id = d.notification_id
           WHERE d.status IN ('queued','failed') AND d.next_attempt_at <= ?
           ORDER BY d.next_attempt_at LIMIT ?`,
        )
        .all(now, BATCH_LIMIT) as unknown as DeliveryRow[];
      if (rows.length === 0) break;

      const deliverable: DeliveryRow[] = [];
      for (const row of rows) {
        if (Date.now() > deadline) return processed;
        const skip = skipReason(db, config, row);
        if (skip !== null) {
          if (skip !== "quiet-hours") {
            db.prepare("UPDATE deliveries SET status = 'fallback', last_error = ?, updated_at = ? WHERE id = ?").run(
              skip,
              nowIso(),
              row.id,
            );
          }
          continue;
        }
        deliverable.push(row);
      }

      for (let i = 0; i < deliverable.length; i += CONCURRENCY) {
        const batch = deliverable.slice(i, i + CONCURRENCY);
        await Promise.all(batch.map((row) => deliverOne(db, config, row)));
        processed += batch.length;
      }
      if (deliverable.length === 0) break;
    }
    return processed;
  } finally {
    draining = false;
  }
}

function skipReason(db: DatabaseSync, config: ResolvedConfig, row: DeliveryRow): string | null {
  const quiet = getSetting<{ start: string; end: string }>(db, row.profile_id, "quiet_hours") ?? null;
  if (inQuietWindow(quiet)) return "quiet-hours";
  const route = getPushRoute(db, row.profile_id);
  if (route === null || !route.enabled || route.url === "") return "route removed";
  if (route.name !== row.route_name) return "route drift";
  if (routeSecret(config, row.profile_id) === undefined) return "secret missing";
  return null;
}

async function deliverOne(db: DatabaseSync, config: ResolvedConfig, row: DeliveryRow): Promise<void> {
  const claimId = newId();
  const claimed = db
    .prepare(
      `UPDATE deliveries SET status = 'sending',
         request_id = COALESCE(request_id, ?),
         request_started_at = COALESCE(request_started_at, ?),
         updated_at = ?
       WHERE id = ? AND status IN ('queued','failed')`,
    )
    .run(`life-assistant:${row.profile_id}:${row.notification_id}:${row.route_name}:a${row.generation}`, nowIso(), nowIso(), row.id);
  if (claimed.changes !== 1) return;

  const current = db.prepare("SELECT request_id, generation FROM deliveries WHERE id = ?").get(row.id) as
    | { request_id: string | null; generation: number }
    | undefined;
  const requestId = current?.request_id ?? claimId;

  const payload = JSON.stringify({
    event_type: EVENT_TYPE,
    notification: {
      profileId: row.profile_id,
      source: row.kind,
      title: row.title,
      body: row.body_md,
      createdAt: row.n_created_at,
    },
  });
  const route = getPushRoute(db, row.profile_id);
  const secret = routeSecret(config, row.profile_id);
  if (route === null || secret === undefined) return;

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex");

  try {
    const response = await fetch(route.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Timestamp": timestamp,
        "X-Webhook-Signature-V2": signature,
        "X-Request-ID": requestId,
      },
      body: payload,
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (response.body !== null) response.body.cancel().catch(() => {});
    if (response.ok) {
      markSent(db, row);
      return;
    }
    markConfirmedFailure(db, row, `HTTP ${response.status}`);
  } catch (e) {
    markTransportFailure(db, row, e instanceof Error ? e.message : String(e));
  }
}

function markSent(db: DatabaseSync, row: DeliveryRow): void {
  const tx = db;
  tx.exec("BEGIN IMMEDIATE");
  try {
    tx.prepare(
      `UPDATE deliveries SET status = 'sent', sent_at = ?, attempts = attempts + 1, transport_failures = 0, updated_at = ?
       WHERE id = ?`,
    ).run(nowIso(), nowIso(), row.id);
    tx.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(row.notification_id);
    tx.exec("COMMIT");
  } catch (e) {
    tx.exec("ROLLBACK");
    throw e;
  }
}

function markConfirmedFailure(db: DatabaseSync, row: DeliveryRow, error: string): void {
  const confirmed = row.confirmed_failures + 1;
  const terminal = confirmed >= MAX_CONFIRMED_FAILURES;
  const delay = LADDER_SECONDS[Math.min(confirmed, LADDER_SECONDS.length) - 1] as number;
  const nextAt = new Date(Date.now() + delay * 1000).toISOString();
  db.prepare(
    `UPDATE deliveries SET status = ?, confirmed_failures = ?, attempts = attempts + 1, transport_failures = 0,
       generation = generation + 1, request_id = NULL, request_started_at = NULL, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(terminal ? "fallback" : "failed", confirmed, nextAt, error, nowIso(), row.id);
}

function markTransportFailure(db: DatabaseSync, row: DeliveryRow, error: string): void {
  const transport = row.transport_failures + 1;
  const terminal = transport >= MAX_TRANSPORT_FAILURES;
  const delay = LADDER_SECONDS[transport === 1 ? 0 : 1] as number;
  const nextAt = new Date(Date.now() + delay * 1000).toISOString();
  db.prepare(
    `UPDATE deliveries SET status = ?, transport_failures = ?, attempts = attempts + 1,
       next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(terminal ? "fallback" : "failed", transport, nextAt, `transport: ${error}`, nowIso(), row.id);
}
