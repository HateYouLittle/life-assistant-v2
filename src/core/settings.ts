import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../time.js";
import { logger } from "./logger.js";

/**
 * 坏 JSON 的防御：settings / cache 的 value_json 可能被手工改库、磁盘位翻转或
 * 旧版本写入的截断行污染。旧实现直接 JSON.parse，异常会沿着调用链炸掉整轮 outbox
 * （notify 的静默时段读取）或整次天气查询 —— 一条坏行不该让推送停摆。
 * 这里降级为「当作没有这个设置/缓存」并告警，调用方走默认值/重新抓取。
 */
function parseJsonOrWarn<T>(valueJson: string, where: string): T | undefined {
  try {
    return JSON.parse(valueJson) as T;
  } catch (e) {
    logger.warn(`${where} 的 JSON 已损坏，按缺省值处理: ${e instanceof Error ? e.message : e}`);
    return undefined;
  }
}

/** 返回是否真的新建了 Profile（false = 已存在）。调用方可用它统计「实际写入」而非调用次数 */
export function ensureProfile(db: DatabaseSync, profileId: string): boolean {
  const result = db
    .prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)")
    .run(profileId, nowIso());
  return Number(result.changes) > 0;
}

export function listProfiles(db: DatabaseSync): string[] {
  return (db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: string }[]).map(
    (r) => r.id,
  );
}

/** 设置读取结果：区分「没有」「有但坏了」「正常」三种，供需要报告损坏的调用方使用 */
export type SettingRead<T> =
  | { kind: "missing" }
  | { kind: "corrupt"; error: string }
  | { kind: "ok"; value: T };

/**
 * 与 getSetting 同源，但把「坏 JSON」显式返回而不是静默降级。
 * 典型用途：出行计划的 show 视图要告诉用户「数据损坏、可重新 set」——
 * 若只看 getSetting 的 undefined，会把损坏误报成「没有设置」。
 */
export function readSetting<T>(db: DatabaseSync, profileId: string, key: string): SettingRead<T> {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE profile_id = ? AND key = ?")
    .get(profileId, key) as { value_json: string } | undefined;
  if (row === undefined) return { kind: "missing" };
  try {
    return { kind: "ok", value: JSON.parse(row.value_json) as T };
  } catch (e) {
    logger.warn(
      `settings(${profileId}, ${key}) 的 JSON 已损坏: ${e instanceof Error ? e.message : e}`,
    );
    return { kind: "corrupt", error: e instanceof Error ? e.message : String(e) };
  }
}

export function getSetting<T>(db: DatabaseSync, profileId: string, key: string): T | undefined {
  const read = readSetting<T>(db, profileId, key);
  return read.kind === "ok" ? read.value : undefined;
}

export function setSetting(db: DatabaseSync, profileId: string, key: string, value: unknown): void {
  ensureProfile(db, profileId);
  db.prepare(
    `INSERT INTO settings (profile_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (profile_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(profileId, key, JSON.stringify(value), nowIso());
}

export function deleteSetting(db: DatabaseSync, profileId: string, key: string): void {
  db.prepare("DELETE FROM settings WHERE profile_id = ? AND key = ?").run(profileId, key);
}

export function newId(): string {
  return randomUUID();
}

export function getCache<T>(db: DatabaseSync, key: string): T | undefined {
  const row = db
    .prepare("SELECT value_json FROM cache WHERE key = ? AND expires_at > ?")
    .get(key, nowIso()) as { value_json: string } | undefined;
  if (row === undefined) return undefined;
  return parseJsonOrWarn<T>(row.value_json, `cache(${key})`);
}

export function setCache(db: DatabaseSync, key: string, value: unknown, ttlMs: number): void {
  setCacheUntil(db, key, value, new Date(Date.now() + ttlMs).toISOString());
}

/**
 * 同 setCache，但由调用方给出绝对过期时刻。
 * 需要「必须在某个本地时刻失效」的缓存（如逐天预报跨零点）必须用这个：
 * 若在调用时把 TTL 换算成毫秒、等响应回来才写入（重试时可达数十秒），
 * 过期时刻会被顺延到目标时刻之后。
 */
export function setCacheUntil(
  db: DatabaseSync,
  key: string,
  value: unknown,
  expiresAt: string,
): void {
  db.prepare(
    `INSERT INTO cache (key, value_json, expires_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json, expires_at = excluded.expires_at`,
  ).run(key, JSON.stringify(value), expiresAt);
}

/**
 * 清理已过期的缓存行。getCache 只是按 expires_at 过滤，不会删除，
 * 而 cache 的 key 由用户输入派生（如 qweather:geo:<城市名>），长期运行会无界增长。
 */
export function pruneCache(db: DatabaseSync): number {
  const result = db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(nowIso());
  return Number(result.changes);
}
