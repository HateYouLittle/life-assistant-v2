import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "./logger.js";

/**
 * 数据库结构指纹：`meta.schema_fingerprint`。
 *
 * 为什么需要：`schema_version` 只是「升级阶梯走到了哪一级」，不是表结构的完整指纹 ——
 * 幂等补列/重建索引（`schedules.escalation_json`、分范围唯一索引）不提升版本号，
 * 手工 `ALTER TABLE` 更是完全看不出来。出了问题（写入报 no such column、看板数据错位）时，
 * 第一件事就是判断「这个库的结构和上次启动时是否一致」，指纹把这件事变成一个字符串比较。
 *
 * 口径：`sqlite_master` 全量快照（排除 sqlite_ 内部对象）按 `type,name` 排序后，逐条取
 * `type|name|tbl_name|normalized_sql` 拼起来做 sha256。只归一空白（SQLite 存的是原始 DDL
 * 文本，缩进/换行不同不代表结构不同），**保持条目顺序与内容** —— 排序保证同一结构总是同一
 * 指纹，内容不被丢弃保证任何列/索引/触发器的增删改都会改变结果。
 */

export const SCHEMA_FINGERPRINT_KEY = "schema_fingerprint";

function normalizeSql(sql: string | null): string {
  return (sql ?? "").replace(/\s+/g, " ").trim();
}

/**
 * 计算当前库的结构指纹。空库（没有任何用户对象）也要有稳定结果：
 * 空快照的 sha256 = e3b0c442…，而不是抛错/返回 null。
 */
export function schemaFingerprint(db: DatabaseSync): string {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as { type: string; name: string; tbl_name: string; sql: string | null }[];
  const snapshot = rows
    .map((row) => [row.type, row.name, row.tbl_name, normalizeSql(row.sql)].join("|"))
    .join("\n");
  return createHash("sha256").update(snapshot).digest("hex");
}

/** 读 `meta.schema_fingerprint`；缺失（老库/首次升级）返回 null */
export function storedSchemaFingerprint(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SCHEMA_FINGERPRINT_KEY) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } catch {
    // meta 表还不存在（全新库）时按「缺失」处理，交给 reconcile 首写
    return null;
  }
}

function writeStoredFingerprint(db: DatabaseSync, fingerprint: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
  ).run(SCHEMA_FINGERPRINT_KEY, fingerprint);
}

export interface FingerprintReconcileResult {
  computed: string;
  /** 本次打开前 meta 里记录的值（首次为 null） */
  stored: string | null;
  /** stored 与 computed 是否一致（== 是否改动过 meta） */
  match: boolean;
}

/**
 * 迁移完成后对账：缺失 → 写入；不同 → 先 warn 再更新；相同 → 什么都不做。
 *
 * 为什么不一致时还更新：迁移本身（加表/加列）就会让指纹合法变化，如果一直保留旧值，
 * 之后每次启动都会 warn —— 用户会学会忽略这条日志，真出问题时它就失去意义。
 * 因此只「变化的那一次」告警（warn 里带上旧/新指纹前缀便于对日志），然后以当前结构为准。
 */
export function reconcileSchemaFingerprint(db: DatabaseSync): FingerprintReconcileResult {
  const computed = schemaFingerprint(db);
  const stored = storedSchemaFingerprint(db);
  if (stored === computed) return { computed, stored, match: true };
  if (stored !== null) {
    logger.warn(
      `数据库结构指纹与上次启动不一致（可能手工 ALTER/升级异常）：${stored.slice(0, 12)}… -> ${computed.slice(0, 12)}…`,
    );
  }
  writeStoredFingerprint(db, computed);
  return { computed, stored, match: false };
}
