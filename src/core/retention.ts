import type { DatabaseSync } from "node:sqlite";
import { logger } from "./logger.js";

/**
 * 保留策略：状态页与 outbox 的三张只增不减的表需要定期收敛。
 *
 * 这里刻意不做"一刀切删老行"：
 * - notifications：只删**已读**且其投递已终结（无 queued/sending/failed）的行；
 *   未读通知是 `notify.pull` 的兜底数据源，删掉就是静默丢通知。
 * - deliveries：随通知级联删除（外键 ON DELETE CASCADE），不必单独处理。
 * - schedules：只删**已取消**且超过保留期的行。使用 `recurrence.count` 的日程永不删 ——
 *   发生次数上限依赖历史 occurrence 行数，删掉会让已达上限的循环复活（与
 *   occurrence 清理同一豁免口径）。
 */

export const NOTIFICATION_RETENTION_DAYS = 180;
export const CANCELLED_SCHEDULE_RETENTION_DAYS = 180;

/** 未终结的投递状态：这些通知不能删（删了推送就永远发不出去） */
const PENDING_DELIVERY_STATUSES = ["queued", "sending", "failed"] as const;

export interface RetentionPreview {
  notifications: number;
  deliveries: number;
  cancelledSchedules: number;
}

function cutoffIso(days: number, now: number = Date.now()): string {
  return new Date(now - days * 24 * 3600 * 1000).toISOString();
}

export function notificationRetentionPlan(
  db: DatabaseSync,
  days: number = NOTIFICATION_RETENTION_DAYS,
  now: number = Date.now(),
): { count: number; cutoff: string } {
  const cutoff = cutoffIso(days, now);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM notifications n
       WHERE n.read = 1 AND n.created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM deliveries d
           WHERE d.notification_id = n.id
             AND d.status IN (${PENDING_DELIVERY_STATUSES.map((s) => `'${s}'`).join(",")})
         )`,
    )
    .get(cutoff) as { n: number };
  return { count: row.n, cutoff };
}

export function cancelledScheduleRetentionPlan(
  db: DatabaseSync,
  days: number = CANCELLED_SCHEDULE_RETENTION_DAYS,
  now: number = Date.now(),
): { count: number; cutoff: string } {
  const cutoff = cutoffIso(days, now);
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM schedules
       WHERE status = 'cancelled' AND updated_at < ?
         AND (recurrence_json IS NULL OR recurrence_json NOT LIKE '%"count"%')`,
    )
    .get(cutoff) as { n: number };
  return { count: row.n, cutoff };
}

export function retentionPreview(db: DatabaseSync, now: number = Date.now()): RetentionPreview {
  const notifications = notificationRetentionPlan(db, NOTIFICATION_RETENTION_DAYS, now).count;
  const cancelledSchedules = cancelledScheduleRetentionPlan(
    db,
    CANCELLED_SCHEDULE_RETENTION_DAYS,
    now,
  ).count;
  // deliveries 随通知级联删除，预览数按通知口径给出（调用方展示用）
  const deliveries = db
    .prepare(
      `SELECT COUNT(*) AS n FROM deliveries d JOIN notifications n ON n.id = d.notification_id
       WHERE n.read = 1 AND n.created_at < ?`,
    )
    .get(cutoffIso(NOTIFICATION_RETENTION_DAYS, now)) as { n: number };
  return { notifications, deliveries: deliveries.n, cancelledSchedules };
}

/** 执行保留策略；返回各表删除行数。与 preview 共用同一份判定，避免预演与实删不一致。 */
export function runRetention(db: DatabaseSync, now: number = Date.now()): RetentionPreview {
  const notifications = notificationRetentionPlan(db, NOTIFICATION_RETENTION_DAYS, now);
  const schedules = cancelledScheduleRetentionPlan(db, CANCELLED_SCHEDULE_RETENTION_DAYS, now);
  const deliveries = retentionPreview(db, now).deliveries;

  const deletedNotifications = db
    .prepare(
      `DELETE FROM notifications
       WHERE read = 1 AND created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM deliveries d
           WHERE d.notification_id = notifications.id
             AND d.status IN (${PENDING_DELIVERY_STATUSES.map((s) => `'${s}'`).join(",")})
         )`,
    )
    .run(notifications.cutoff);

  const deletedSchedules = db
    .prepare(
      `DELETE FROM schedules
       WHERE status = 'cancelled' AND updated_at < ?
         AND (recurrence_json IS NULL OR recurrence_json NOT LIKE '%"count"%')`,
    )
    .run(schedules.cutoff);

  const result: RetentionPreview = {
    notifications: Number(deletedNotifications.changes),
    deliveries,
    cancelledSchedules: Number(deletedSchedules.changes),
  };
  if (result.notifications > 0 || result.cancelledSchedules > 0) {
    logger.info(
      `保留策略清理：通知 ${result.notifications} 条（含投递 ${result.deliveries} 条）、已取消日程 ${result.cancelledSchedules} 条`,
    );
  }
  return result;
}
