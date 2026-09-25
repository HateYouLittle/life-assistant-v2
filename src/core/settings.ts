import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../time.js";

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

export function getSetting<T>(db: DatabaseSync, profileId: string, key: string): T | undefined {
  const row = db
    .prepare("SELECT value_json FROM settings WHERE profile_id = ? AND key = ?")
    .get(profileId, key) as { value_json: string } | undefined;
  if (row === undefined) return undefined;
  return JSON.parse(row.value_json) as T;
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
  return JSON.parse(row.value_json) as T;
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
