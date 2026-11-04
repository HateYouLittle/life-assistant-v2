import type { DatabaseSync } from "node:sqlite";
import { getSetting, setSetting } from "./settings.js";

/**
 * 按 kind 的通知偏好：决定「要不要主动推送」，不改变通知本身的入库与去重。
 *
 * 为什么放在 core：publishProfile 是唯一的发布入口，过滤必须发生在**建 delivery 之前** ——
 * 否则关闭推送只是让投递失败，通知仍会被标已读、`notify.pull` 也拿不到。
 * 关闭推送的语义是「不打扰，但记录还在」：通知照常入库，用户 pull 仍能看到。
 */

export interface NotifyKindPref {
  /** false = 不主动推送（通知仍入库，notify.pull 可取）；缺省 true */
  push?: boolean;
  /** 只在这些通道上推送（路由通道不在其中则不发）；缺省不限 */
  channels?: string[];
}

export type NotifyPrefs = Record<string, NotifyKindPref>;

/**
 * 内置默认偏好：
 * - `bookkeeping.entry`（逐笔回执）默认不推 —— 家庭账本下「一笔 × 每人」是最大噪声源，
 *   改由每日摘要（bookkeeping.digest）汇总；用户想恢复逐笔推送可在 prefs 里显式开 true。
 * - 其余 kind 保持推送（与历史行为一致，升级不改变既有用户体感）。
 */
export const DEFAULT_KIND_PREFS: NotifyPrefs = {
  "bookkeeping.entry": { push: false },
};

/** settings 里的键名（按 Profile 存储） */
export const NOTIFY_PREFS_KEY = "notify_prefs";

/** 读取偏好；坏 JSON/非法形状一律按「没有配置」处理（调用方再叠加内置默认） */
export function getNotifyPrefs(db: DatabaseSync, profileId: string): NotifyPrefs {
  const raw = getSetting<unknown>(db, profileId, NOTIFY_PREFS_KEY);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: NotifyPrefs = {};
  for (const [kind, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const entry = value as Record<string, unknown>;
    const pref: NotifyKindPref = {};
    if (typeof entry.push === "boolean") pref.push = entry.push;
    if (Array.isArray(entry.channels)) {
      const channels = entry.channels
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter((item) => item !== "");
      if (channels.length > 0) pref.channels = channels;
    }
    out[kind] = pref;
  }
  return out;
}

/** 覆盖式写入（工具侧传完整对象；读改写由调用方负责） */
export function setNotifyPrefs(db: DatabaseSync, profileId: string, prefs: NotifyPrefs): void {
  setSetting(db, profileId, NOTIFY_PREFS_KEY, prefs);
}

/**
 * 该 kind 在该 Profile 上是否应该主动推送。
 * `routeChannel` 是当前路由的通道名（webhook/log/bark/ntfy），用于 channels 白名单判定。
 */
export function kindPushDecision(
  prefs: NotifyPrefs,
  kind: string,
  routeChannel: string,
): { push: boolean; reason?: string } {
  const merged: NotifyKindPref = { ...DEFAULT_KIND_PREFS[kind], ...prefs[kind] };
  if (merged.push === false) return { push: false, reason: "该类型已关闭主动推送" };
  if (merged.channels !== undefined && !merged.channels.includes(routeChannel)) {
    return { push: false, reason: `该类型只允许通道 ${merged.channels.join("/")}` };
  }
  return { push: true };
}
