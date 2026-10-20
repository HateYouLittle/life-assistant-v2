import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { logger } from "./logger.js";

/**
 * 审计日志（schema v5）：记录「谁、何时、对什么、做了什么」。
 *
 * 首期只覆盖手机快捷入口（`/api/quick/*`）的写操作 —— 那是唯一不经 MCP、直接由 HTTP
 * 凭据驱动的写路径，出了问题（多记一笔、给错人建提醒）需要能回溯到具体请求；
 * MCP 侧的调用本身已由 Hermes 的会话记录覆盖，不重复落库。
 *
 * 纪律：
 * - 只增不改，且**永不抛出**：审计是旁路，写失败只记 error，绝不能让一次已经成功的
 *   记账/提醒因为审计写不进去而变成 500（重试会重复写业务数据）。
 * - `detail_json` 只放非隐私摘要（金额/分类/账本名/是否幂等命中），不放 token、
 *   不放备注全文 —— 审计表会被 master 全量查看，也可能被导出排障。
 */

export const AUDIT_DEFAULT_LIMIT = 50;
export const AUDIT_MAX_LIMIT = 200;
/** 深分页上限：与看板明细同一取舍（SQLite OFFSET 要扫过前 N 行） */
const AUDIT_MAX_OFFSET = 100_000;

export interface RecordAuditInput {
  /** 操作者（Profile token 绑定的人；master 代操作时是目标 Profile） */
  profileId: string;
  /** 稳定的动作名，如 quick.expense.add / quick.schedule.add */
  action: string;
  /** 目标对象类型，如 expense / schedule */
  targetKind?: string | null;
  /** 目标对象 id（业务主键） */
  targetId?: string | null;
  /** 非隐私摘要；值必须是可 JSON 序列化的对象 */
  detail?: Record<string, unknown> | null;
}

export interface AuditRow {
  id: string;
  profile_id: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  detail_json: string | null;
  created_at: string;
}

export interface ListAuditOptions {
  limit?: number;
  offset?: number;
  /** master 不传 = 全量；Profile token 传自己的 id = 只回自己的记录 */
  profileId?: string;
}

export interface ListAuditResult {
  items: AuditRow[];
  total: number;
}

function serializeDetail(detail: Record<string, unknown> | null | undefined): string | null {
  if (detail === undefined || detail === null) return null;
  try {
    return JSON.stringify(detail);
  } catch {
    // 循环引用等无法序列化：宁可不记 detail，也不能让审计拖垮业务
    return null;
  }
}

/**
 * 写一条审计。内部吞掉所有异常（含库已关闭、外键失败、磁盘满），只落 error 日志。
 * 返回是否写入成功仅供测试/调用方观测，业务路径不需要判断。
 */
export function recordAudit(db: DatabaseSync, input: RecordAuditInput): boolean {
  try {
    db.prepare(
      `INSERT INTO audit_log (id, profile_id, action, target_kind, target_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.profileId,
      input.action,
      input.targetKind ?? null,
      input.targetId ?? null,
      serializeDetail(input.detail),
      new Date().toISOString(),
    );
    return true;
  } catch (e) {
    logger.error(
      `审计日志写入失败（不影响业务）: ${input.action} profile=${input.profileId} ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return false;
  }
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return AUDIT_DEFAULT_LIMIT;
  return Math.max(1, Math.min(Math.trunc(raw), AUDIT_MAX_LIMIT));
}

function clampOffset(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(Math.trunc(raw), AUDIT_MAX_OFFSET));
}

/**
 * 分页读取审计（时间倒序，id 兜底保证同一毫秒内顺序稳定）。
 * `profileId` 给了就只数/只取该 Profile —— 调用方负责把它限定为「请求者自己的身份」。
 */
export function listAudit(db: DatabaseSync, opts: ListAuditOptions = {}): ListAuditResult {
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  const scoped = opts.profileId !== undefined;
  const where = scoped ? " WHERE profile_id = ?" : "";
  const params = scoped ? [opts.profileId as string] : [];
  const totalRow = db.prepare(`SELECT COUNT(*) AS n FROM audit_log${where}`).get(...params) as {
    n: number;
  };
  const items = db
    .prepare(
      `SELECT id, profile_id, action, target_kind, target_id, detail_json, created_at
       FROM audit_log${where}
       ORDER BY created_at DESC, id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as {
    id: string;
    profile_id: string;
    action: string;
    target_kind: string | null;
    target_id: string | null;
    detail_json: string | null;
    created_at: string;
  }[];
  return { items, total: totalRow.n };
}
