import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ResolvedConfig } from "../config.js";
import { inQuietWindow, nowIso } from "../time.js";
import { withTransaction } from "./database.js";
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
  next_attempt_at: string;
  expire_at: string | null;
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
  // 只允许 http/https：ftp/file 等协议主机名也能过回环检查，但 fetch 对它们一律失败，
  // 每次都会走满传输重试再进 fallback（用户看到「已配置」却永远收不到推送）。
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`推送 URL 仅支持 http/https: ${input.url}`);
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
  requeueRoute(db, profileId);
  return route;
}

/**
 * 启用/停用已有路由（不改 URL、不换名）。启用时必须走这里而不是裸 setSetting：
 * 路由停用期间进入 fallback 的投递行只有靠 requeueRoute 才会重新入队，
 * 否则它们会永远停在 fallback（用户看到"通知没发出去"却没有任何补救入口）。
 */
export function setPushRouteEnabled(
  db: DatabaseSync,
  profileId: string,
  enabled: boolean,
): PushRoute {
  const current = getPushRoute(db, profileId);
  if (current === null) throw new Error("尚未配置推送路由，请先提供 url");
  const route: PushRoute = { ...current, enabled };
  setSetting(db, profileId, "push_route", route);
  if (enabled) requeueRoute(db, profileId);
  return route;
}

/** 停用路由：落一条 disabled 的空路由，投递层据此判为 route removed（notify 工具目前用 enabled=false 达到同样效果） */
export function clearPushRoute(db: DatabaseSync, profileId: string): void {
  setSetting(db, profileId, "push_route", {
    name: `life-assistant-${profileId}`,
    url: "",
    platform: null,
    enabled: false,
  });
}

export function routeSecret(config: ResolvedConfig, profileId: string): string | undefined {
  // 必须用 Object.hasOwn：profileRouteSecrets 是普通字面量对象，而 PROFILE_ID_RE 允许
  // "constructor"。直接取值会命中 Object.prototype.constructor（非 undefined），
  // 于是 publishProfile 误判"有 secret"并落投递行，随后 createHmac 抛
  // ERR_INVALID_ARG_TYPE —— 每轮 drain 都断在这一行，排在其后的通知永久投不出去。
  return Object.hasOwn(config.profileRouteSecrets, profileId)
    ? config.profileRouteSecrets[profileId]
    : undefined;
}

export function routedProfiles(db: DatabaseSync): string[] {
  const rows = db
    .prepare("SELECT profile_id, value_json FROM settings WHERE key = 'push_route'")
    .all() as {
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
  const rendered = renderBlocks(input.blocks, "markdown");
  // 标题只走 title 字段：投递 payload 与 notify.pull 都单独返回标题，
  // 正文若再拼一次，两端各会多渲染一行重复标题。
  const bodyMd = rendered.body;
  const id = newId();
  const createdAt = nowIso();
  const route = getPushRoute(db, profileId);
  const secret = routeSecret(config, profileId);
  const routable = route?.enabled === true && route.url !== "";
  const secretMissing = routable && secret === undefined;

  // notification 与 delivery 必须同事务落库：只写进一半会让「有通知却没投递记录」永久卡住
  const { result, queued } = withTransaction(db, () => {
    ensureProfile(db, profileId);
    if (input.dedupeKey !== undefined) {
      const existing = db
        .prepare("SELECT id FROM notifications WHERE profile_id = ? AND dedupe_key = ?")
        .get(profileId, input.dedupeKey) as { id: string } | undefined;
      if (existing !== undefined)
        return { result: { id: existing.id, deduped: true }, queued: false };
    }

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

    if (!routable || secret === undefined) return { result: { id, deduped: false }, queued: false };
    db.prepare(
      `INSERT INTO deliveries (id, notification_id, route_name, status, next_attempt_at, expire_at, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
    ).run(newId(), id, route.name, createdAt, input.expiresAt ?? null, createdAt, createdAt);
    return { result: { id, deduped: false }, queued: true };
  });

  if (secretMissing) {
    logger.warn(
      `Profile ${profileId} 已配置推送路由但 PROFILE_ROUTE_SECRETS_JSON 缺少对应 secret，通知仅保留可 pull`,
    );
  }
  if (queued) drainSoon(db, config);
  return result;
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
export function cancelPendingDeliveries(
  db: DatabaseSync,
  profileId: string,
  notificationIds: string[],
): void {
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

/**
 * 路由恢复：仅「从未发出不确定请求」且「未被确定性拒绝」的行重新入队（generation 递增）。
 *
 * 按 profile 而不是 route_name 匹配：每个 Profile 只有一条生效路由，行的 route_name
 * 只是「入队时用的名字」。一旦用户改过名（setPushRoute）或清空后换名重建，按名匹配就再也
 * 匹配不到那些行 —— 它们会永远停在 fallback，而用户侧没有任何补救入口。
 *
 * 三个条件缺一不可：
 * - `request_started_at IS NULL`：已发出过请求的行（无论结果确定与否）不盲重发。
 * - `deterministic_reject = 0`：被 4xx/3xx 确定性拒绝的行不重投 —— 换路由也还是同一个
 *   webhook 在拒，重发只会再被拒一次，还会在用户侧凭空多出一条「本不该有的」推送。
 *   走到 markTerminalFallback 的都是这类，与「从未发出过」曾共用 request_started_at 这一位，
 *   按 profile 捞行后就再也无法区分了。
 */
function requeueRoute(db: DatabaseSync, profileId: string): void {
  db.prepare(
    `UPDATE deliveries SET status = 'queued', generation = generation + 1, next_attempt_at = ?, updated_at = ?
     WHERE status = 'fallback' AND request_started_at IS NULL AND deterministic_reject = 0
       AND notification_id IN (SELECT id FROM notifications WHERE profile_id = ?)`,
  ).run(nowIso(), nowIso(), profileId);
}

let drainTimer: ReturnType<typeof setTimeout> | null = null;
let draining = false;
/** 当前在途的一轮投递，供停机时等待收敛（见 waitForDrain） */
let currentDrain: Promise<number> | null = null;

/** 发布后即时触发一轮投递（去抖） */
export function drainSoon(db: DatabaseSync, config: ResolvedConfig): void {
  if (drainTimer !== null || draining) return;
  drainTimer = setTimeout(() => {
    drainTimer = null;
    void drainDue(db, config).catch((e) =>
      logger.error(`outbox drain 失败: ${e instanceof Error ? e.message : e}`),
    );
  }, 100);
}

/** 取消尚未触发的去抖 drain（关闭数据库/进程退出前调用，避免对已关闭的库报错） */
export function cancelPendingDrain(): void {
  if (drainTimer === null) return;
  clearTimeout(drainTimer);
  drainTimer = null;
}

/**
 * 投递到期的 outbox 行；返回处理的行数。调度器每 20s 调一次，发布时也会即时触发。
 *
 * `budgetMs` 只为测试存在（45s 的默认预算无法在用例里等出来）；生产调用一律走默认值。
 */
export function drainDue(
  db: DatabaseSync,
  config: ResolvedConfig,
  budgetMs = DRAIN_BUDGET_MS,
): Promise<number> {
  if (draining) return Promise.resolve(0);
  draining = true;
  const run = (async (): Promise<number> => {
    recoverStaleSending(db);
    const deadline = Date.now() + budgetMs;
    let processed = 0;
    // 扫描游标（keyset 分页）：窗口按 (next_attempt_at, id) **只向前**推进。
    // 静止的 `ORDER BY d.next_attempt_at LIMIT 100` 每轮都取回同一批最靠前的行 ——
    // 静默时段（唯一不落库终态的 skip）让某个 Profile 的行原地不动时，它们会永久
    // 占满窗口，排在后面的**其它 Profile** 的到期行整轮一次都轮不到。游标把「已考察
    // 过的行」让出窗口，窗口于是能扫到整批到期行，而不是只扫前 100 条。
    // 必须带上 `d.id` 作次序键：next_attempt_at 大量重复（forceDue 与同批发布都会
    // 刷成同一值），只按它排序时并列行的次序不确定，游标会漏行。
    let cursorAt = "";
    let cursorId = "";
    for (;;) {
      const now = nowIso();
      const rows = db
        .prepare(
          `SELECT d.*, n.profile_id, n.kind, n.title, n.body_md, n.created_at AS n_created_at
           FROM deliveries d JOIN notifications n ON n.id = d.notification_id
           WHERE d.status IN ('queued','failed') AND d.next_attempt_at <= ?
             AND (d.next_attempt_at > ? OR (d.next_attempt_at = ? AND d.id > ?))
           ORDER BY d.next_attempt_at, d.id LIMIT ?`,
        )
        .all(now, cursorAt, cursorAt, cursorId, BATCH_LIMIT) as unknown as DeliveryRow[];
      if (rows.length === 0) break;
      const last = rows[rows.length - 1] as DeliveryRow;
      cursorAt = last.next_attempt_at;
      cursorId = last.id;

      const deliverable: DeliveryRow[] = [];
      // 本轮是否有任何状态推进。**不能**用 `deliverable.length === 0` 当退出判据：
      // quiet-hours 是唯一不落库终态的 skip（既不改 status 也不推进 next_attempt_at），
      // 而它是 per-Profile 的设置。某个 Profile 的 100+ 条静默行占满 LIMIT 窗口时，
      // 排在窗口之外的**其它 Profile** 的到期行会被整批跳过 —— A 用户的静默时段
      // 静默压掉 B 用户的推送。改判据 + 游标（见上）后，窗口能扫过整批到期行。
      let advanced = false;
      for (const row of rows) {
        if (Date.now() > deadline) return processed;
        // 过期内容直接作废：静默时段拦下的预警如果等到窗口结束再补投，用户收到的
        // 是已经失效的告警。通知本身保留（pull 兜底），这里只终结投递。
        if (isExpiredAt(row.expire_at, now)) {
          db.prepare(
            "UPDATE deliveries SET status = 'cancelled', last_error = 'expired before delivery', updated_at = ? WHERE id = ?",
          ).run(nowIso(), row.id);
          advanced = true;
          continue;
        }
        const skip = skipReason(db, config, row);
        if (skip !== null) {
          if (skip === "route drift") {
            // 路由改名只是「同一个 Profile 换了条路由」，不是投递失败：把行上的旧名改写为
            // 当前名并留在队列，本轮就投出去。置 fallback 会让这些行永久卡住（改个名丢掉
            // 待投通知，而用户侧没有任何补救入口），routeName 也只用于生成幂等请求 id。
            const current = getPushRoute(db, row.profile_id);
            if (current !== null) {
              db.prepare("UPDATE deliveries SET route_name = ?, updated_at = ? WHERE id = ?").run(
                current.name,
                nowIso(),
                row.id,
              );
              advanced = true;
              deliverable.push({ ...row, route_name: current.name });
            }
            continue;
          }
          if (skip !== "quiet-hours") {
            db.prepare(
              "UPDATE deliveries SET status = 'fallback', last_error = ?, updated_at = ? WHERE id = ?",
            ).run(skip, nowIso(), row.id);
            advanced = true;
          }
          // quiet-hours：行原样留在待投集合里，等窗口结束后的下一轮 drain。
          continue;
        }
        deliverable.push(row);
      }

      for (let i = 0; i < deliverable.length; i += CONCURRENCY) {
        // 投递段也必须看预算（曾只查行扫描循环）：单个请求最长 10s
        // （deliverOne 的 AbortSignal.timeout），满窗口 100 行 / 并发 5 = 20 批，
        // 最坏 200s —— 是 45s 预算的 4.4 倍，而那 200s 全花在下面这个 await 里，
        // 行扫描循环的 deadline 检查（:346）对它完全无感知。后果不是「慢一点」而是
        // 单进程投递被卡住：`draining` 一直为 true，调度器每 20s 的 drainDue 全部
        // 重入返回 0（:307），新通知只能等这一轮结束才有机会投出。
        // 超预算即返回：未 claim 的行状态仍是 queued，下一轮重新取回，不丢不重。
        if (Date.now() > deadline) return processed;
        const batch = deliverable.slice(i, i + CONCURRENCY);
        const claimed = await Promise.all(batch.map((row) => deliverOne(db, config, row)));
        processed += batch.length;
        // 只有真正 claim（status → sending，再落终态或退避）才算推进：
        // deliverOne 在 claim 前因路由/secret 缺失 return 时行仍留在待投集合里，
        // 那种行下一轮会被重新取回，不推进就会自旋。
        for (const did of claimed) if (did) advanced = true;
      }
      // 零推进 = 本轮窗口里的行全部原地未动（只有静默时段能做到）。游标已经前移到本批
      // 末尾，所以继续循环是有界的：下一轮只会看到**本批之后**的行，而库里没有新行时
      // `rows.length === 0` 会收工。若把 break 判据写成「永远不 break」，
      // 静默时段会让每一轮都零推进、游标扫完全库才停（O(库大小) 次空转查询）。
      // 故零推进且已无新窗口时收工；游标本身保证不会自旋。
      if (!advanced && rows.length < BATCH_LIMIT) break;
    }
    return processed;
  })();
  // 同步登记在途轮次，再由 finally 在微任务里清空；停机时 waitForDrain 等它收敛。
  // 若在 IIFE 内部登记，draining 仍在 true 时不会有新一轮进入，顺序安全。
  currentDrain = run.finally(() => {
    draining = false;
    currentDrain = null;
  });
  return currentDrain;
}

/** 等待在途的一轮投递结束（停机前调用，避免关库后仍在写） */
export async function waitForDrain(): Promise<void> {
  if (currentDrain !== null) await currentDrain.catch(() => undefined);
}

/**
 * 投递截止是否已到。按时间值比较，而不是字符串比较：历史行可能存着带偏移的时间
 * （QWeather 早期原样落库的 `...+08:00`），与 nowIso()（Z 结尾）做字典序比较会错判过期。
 * 无法解析的截止时间视为未过期（不误杀）。
 */
function isExpiredAt(expireAt: string | null, nowIsoValue: string): boolean {
  if (expireAt === null) return false;
  const expire = Date.parse(expireAt);
  const current = Date.parse(nowIsoValue);
  if (!Number.isFinite(expire) || !Number.isFinite(current)) return false;
  return expire <= current;
}

function skipReason(db: DatabaseSync, config: ResolvedConfig, row: DeliveryRow): string | null {
  const quiet =
    getSetting<{ start: string; end: string }>(db, row.profile_id, "quiet_hours") ?? null;
  if (inQuietWindow(quiet)) return "quiet-hours";
  const route = getPushRoute(db, row.profile_id);
  if (route === null || !route.enabled || route.url === "") return "route removed";
  if (route.name !== row.route_name) return "route drift";
  if (routeSecret(config, row.profile_id) === undefined) return "secret missing";
  return null;
}

/** 投递单行；返回是否真的 claim 了这行（false = 行原样留在待投集合里） */
async function deliverOne(
  db: DatabaseSync,
  config: ResolvedConfig,
  row: DeliveryRow,
): Promise<boolean> {
  // 路由/secret 必须在 claim 之前判定：claim 之后才发现缺失会留下一条持久为
  // 'sending' 的行（下一轮 recoverStaleSending 虽会复位，但先写后弃本身就是脏状态）。
  const route = getPushRoute(db, row.profile_id);
  const secret = routeSecret(config, row.profile_id);
  if (route === null || secret === undefined) return false;

  const claimId = newId();
  const claimed = db
    .prepare(
      `UPDATE deliveries SET status = 'sending',
         request_id = COALESCE(request_id, ?),
         request_started_at = COALESCE(request_started_at, ?),
         updated_at = ?
       WHERE id = ? AND status IN ('queued','failed')`,
    )
    .run(
      `life-assistant:${row.profile_id}:${row.notification_id}:${row.route_name}:a${row.generation}`,
      nowIso(),
      nowIso(),
      row.id,
    );
  if (claimed.changes !== 1) return false;

  const current = db
    .prepare("SELECT request_id, generation FROM deliveries WHERE id = ?")
    .get(row.id) as { request_id: string | null; generation: number } | undefined;
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
      return true;
    }
    // 确定性拒绝不重试：4xx（408/429 除外）与 3xx 重定向改不了结果，只会在阶梯上耗到
    // 1 小时。3xx 尤其如此：redirect: "manual" 下投递请求根本没有被 webhook 处理，
    // 重试多少次都是同一个重定向。与 QWeather 客户端的「4xx 不重试」保持同一口径。
    const status = response.status;
    const retryable = status === 408 || status === 429 || (status >= 500 && status <= 599);
    if (!retryable) {
      markTerminalFallback(db, row, `HTTP ${status}`);
      return true;
    }
    markConfirmedFailure(db, row, `HTTP ${status}`);
  } catch (e) {
    markTransportFailure(db, row, e instanceof Error ? e.message : String(e));
  }
  // claim 已成功：行无论落到 sent / fallback / 退避重试，都已离开待投集合
  return true;
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

/**
 * 终态失败：不再重试。`request_started_at` 必须清空 —— requeueRoute 只重新入队
 * 「从未发出不确定请求」的行，清空它才能让路由恢复后重新投递。
 *
 * 但清空 request_started_at 只说明「这个投递世代没在飞」，不说明「换条路由还值得再发」：
 * 走到这里的都是确定性拒绝（4xx/3xx，重试只会原样再被拒），所以另立
 * `deterministic_reject` 标记，让 requeueRoute 能把它与「从未发出过」区分开。
 */
function markTerminalFallback(db: DatabaseSync, row: DeliveryRow, error: string): void {
  db.prepare(
    `UPDATE deliveries SET status = 'fallback', attempts = attempts + 1,
       request_started_at = NULL, deterministic_reject = 1, last_error = ?, updated_at = ?
     WHERE id = ?`,
  ).run(error, nowIso(), row.id);
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
  ).run(
    terminal ? "fallback" : "failed",
    transport,
    nextAt,
    `transport: ${error}`,
    nowIso(),
    row.id,
  );
}
