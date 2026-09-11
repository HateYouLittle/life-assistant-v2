import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "../time.js";

export function ensureProfile(db: DatabaseSync, profileId: string): void {
  db.prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)").run(profileId, nowIso());
}

export function listProfiles(db: DatabaseSync): string[] {
  return (db.prepare("SELECT id FROM profiles ORDER BY id").all() as { id: string }[]).map((r) => r.id);
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
