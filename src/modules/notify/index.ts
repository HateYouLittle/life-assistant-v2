import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { z } from "zod";
import { canUseGlobalOpenclawToken } from "../../config.js";
import {
  DEFAULT_CHANNEL,
  findChannel,
  getChannel,
  supportedChannels,
  warnOpenclawGlobalTokenFallback,
} from "../../core/channels.js";
import { pruneJobRuns } from "../../core/jobs.js";
import { logger } from "../../core/logger.js";
import {
  cancelPendingDeliveries,
  drainSoon,
  getPushRoute,
  publishProfile,
  retryDeliveries,
  routeSecret,
  setPushRoute,
  setPushRouteEnabled,
} from "../../core/notify.js";
import {
  DEFAULT_KIND_PREFS,
  getNotifyPrefs,
  type NotifyKindPref,
  type NotifyPrefs,
  setNotifyPrefs,
} from "../../core/notify-prefs.js";
import {
  errorMessage,
  fail,
  type NotifyBlock,
  ok,
  okJson,
  registerModule,
  runtime,
  type ToolContext,
} from "../../core/registry.js";
import { runRetention } from "../../core/retention.js";
import { deleteSetting, getSetting, setSetting } from "../../core/settings.js";
import { nowIso, TIME_RE, TZ } from "../../time.js";

/** UTC ISO → 本地（Asia/Shanghai）文本；解析失败原样返回，不编造 */
function localTimeText(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: TZ });
  return dt.isValid ? dt.toFormat("yyyy-LL-dd HH:mm") : iso;
}

/** 通知 kind 的合法形状（如 bookkeeping.entry / notify.test）；拒绝乱写的键，避免偏好表变垃圾场 */
const KIND_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * 偏好视图：把「内置默认 + 已保存」合并成**最终生效值**。
 * push=false 表示不主动推送（通知仍入库，可 pull）；channels=null 表示不限通道。
 */
function prefsView(
  prefs: NotifyPrefs,
): Record<string, { push: boolean; channels: string[] | null }> {
  const kinds = [...new Set([...Object.keys(DEFAULT_KIND_PREFS), ...Object.keys(prefs)])].sort();
  const out: Record<string, { push: boolean; channels: string[] | null }> = {};
  for (const kind of kinds) {
    const merged: NotifyKindPref = { ...DEFAULT_KIND_PREFS[kind], ...prefs[kind] };
    out[kind] = { push: merged.push !== false, channels: merged.channels ?? null };
  }
  return out;
}

/**
 * 分页参数的宽松归一：limit/offset 是「翻页」参数，传错（字符串、负数、越界）时
 * 回退到最近的合法值比直接报错更有用 —— 用户想看的是通知列表，不该被一个参数挡住。
 * kind/unread 这类**过滤语义**参数则相反：静默忽略会让结果看起来是对的、其实是错的，
 * 所以它们由调用方严格校验并 fail。
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * openclaw 通道的准入口径（P2-17 凭据边界）走 config.ts 的 canUseGlobalOpenclawToken 三档判定：
 * 1. 部署自身 profile（HERMES_PROFILE）→ 可用全局 token（运维者本人，即使也登记了 Profile token）；
 * 2. 其它登记在 PROFILE_TOKENS_JSON 的 profile（隔离用户）→ 必须提供自己的 route secret，
 *    投递时作为 Bearer token，不再回退全局 token；
 * 3. 未登记独立 token 的 profile → 按 master 代表处理（回环零配置/仅 master 部署的既有行为）。
 * 判定只有 config.ts 一份，工具层与投递层不得各写一套。
 */

/** retry 的人话说明：区分「没命中」「都不可重试」「已入队」三种情况 */
function retryNote(retried: number, skipped: number): string {
  if (retried === 0) {
    return skipped > 0
      ? "没有可重试的投递：命中的行都在排队/发送中/已发出/已取消，不能重复入队"
      : "没有命中的投递：该通知可能没有投递记录（未配置路由，或该类型已关闭主动推送），可用 history 查看";
  }
  return (
    `已重新入队 ${retried} 条，并触发了一轮投递（去抖 100ms，最迟 20 秒内）` +
    (skipped > 0 ? `；另有 ${skipped} 条不可重试或超出批量上限` : "") +
    "。fallback 行若是对端确定性拒绝（4xx/3xx），重试前建议先修好路由或通道配置，否则会被原样再拒一次"
  );
}

/**
 * P2-21：inputSchema 由所有 action 共享，agent 看得见全部字段 —— 与当前 action 无关的字段
 * 过去被静默忽略（如 pull 传 offset），agent 会以为「传了就生效」。这里按 action 列白名单，
 * 表外字段显式失败。白名单必须与各分支真正读取的字段一一对应，不得顺手扩大既有契约。
 * 文案与 bookkeeping 侧统一：`未知字段: <名>（action=<action> 不接受）`。
 */
const ACTION_FIELDS: Record<string, readonly string[]> = {
  pull: ["limit"],
  history: ["limit", "offset", "unread", "kind"],
  retry: ["notification_id", "delivery_id", "all"],
  quiet_hours: ["start", "end", "clear"],
  route: ["url", "channel", "enabled", "platform", "name"],
  prefs: ["kind", "push", "channels"],
  test: [],
  cancel: ["id"],
};

export function notifyTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    return notifyToolInner(args, ctx);
  } catch (e) {
    return fail(errorMessage(e));
  }
}

function notifyToolInner(args: Record<string, unknown>, ctx: ToolContext) {
  const action = args.action as string;
  const db = ctx.db;
  const profileId = ctx.profileId;

  // 未知 action 交给文件末尾统一报错；已知 action 才做字段白名单校验。
  const allowedFields = ACTION_FIELDS[action];
  if (allowedFields !== undefined) {
    for (const key of Object.keys(args)) {
      if (key === "action" || args[key] === undefined) continue;
      if (!allowedFields.includes(key)) {
        return fail(`未知字段: ${key}（action=${action} 不接受）`);
      }
    }
  }

  if (action === "pull") {
    const limit = Math.min((args.limit as number) ?? 20, 100);
    const rows = db
      .prepare(
        "SELECT id, kind, title, body_md, created_at FROM notifications WHERE profile_id = ? AND read = 0 ORDER BY created_at DESC LIMIT ?",
      )
      .all(profileId, limit) as {
      id: string;
      kind: string;
      title: string;
      body_md: string;
      created_at: string;
    }[];
    if (rows.length === 0) return ok("没有未读通知");
    cancelPendingDeliveries(
      db,
      profileId,
      rows.map((r) => r.id),
    );
    db.prepare(
      `UPDATE notifications SET read = 1 WHERE profile_id = ? AND read = 0 AND id IN (${rows.map(() => "?").join(",")})`,
    ).run(profileId, ...rows.map((r) => r.id));
    return okJson({
      未读通知: rows.map((r) => ({
        // id 是 cancel 的输入；pull 不回传它会让 notify.cancel 无法从工具输出获得 id。
        id: r.id,
        标题: r.title,
        种类: r.kind,
        时间: r.created_at,
        // 原「时间」是 UTC ISO（差 8 小时易误读），补本地文本；原键保留不动
        "时间(本地)": localTimeText(r.created_at),
        内容: r.body_md,
      })),
      数量: rows.length,
      说明: "已标记为已读，对应待投递的主动推送已取消",
    });
  }

  if (action === "quiet_hours") {
    const start = args.start as string | undefined;
    const end = args.end as string | undefined;
    if (args.clear === true) {
      deleteSetting(db, profileId, "quiet_hours");
      return ok("已清除静默时段设置");
    }
    if (start !== undefined || end !== undefined) {
      if (start === undefined || end === undefined)
        return fail("设置静默时段需要 start 和 end（HH:MM），或 clear=true 清除");
      if (!TIME_RE.test(start) || !TIME_RE.test(end)) return fail("时间格式需为 HH:MM");
      if (start === end) return fail("start 与 end 相同视为未启用");
      setSetting(db, profileId, "quiet_hours", { start, end });
      return okJson({
        静默时段: { start, end },
        说明: "窗口内暂停主动推送（不影响 notify.pull）；支持跨午夜，如 22:00-07:00",
      });
    }
    const current = getSetting<{ start: string; end: string }>(db, profileId, "quiet_hours");
    return okJson({ 静默时段: current ?? "未设置" });
  }

  if (action === "route") {
    const url = args.url as string | undefined;
    const channelArg = args.channel as string | undefined;
    const enabled = args.enabled as boolean | undefined;
    // 传 url 或 channel 都算「配置路由」：log 通道不需要 url，只传 channel 即可；
    // 只传 enabled 仍走启用/停用分支。
    if (url !== undefined || channelArg !== undefined) {
      // 先解析通道：未知通道名直接失败，不落任何设置
      const channel = getChannel(channelArg);
      const ownSecret = routeSecret(ctx.config, profileId);
      if (channel.requiresSecret && ownSecret === undefined) {
        return fail(
          `PROFILE_ROUTE_SECRETS_JSON 中没有 profile "${profileId}" 的 secret，无法启用推送`,
        );
      }
      // openclaw 的凭据是 daemon 全局 OPENCLAW_HOOK_TOKEN（属于 master）：隔离用户必须先
      // 提供自己的 secret，否则拒绝配置 —— 否则 daemon 会把全局 token 投到该用户自己填的
      // 回环地址（P2-17）。部署自身 profile（HERMES_PROFILE）不算隔离用户。明确报错，不静默降级。
      if (
        channel.name === "openclaw" &&
        ownSecret === undefined &&
        !canUseGlobalOpenclawToken(ctx.config, profileId)
      ) {
        return fail(
          `openclaw 通道使用 daemon 全局 OPENCLAW_HOOK_TOKEN（仅部署自身 profile ${ctx.config.deploymentProfile} 可配置）：` +
            `profile "${profileId}" 有独立的 Profile token，请先在 PROFILE_ROUTE_SECRETS_JSON 里为它配置独立 secret` +
            `（投递将用它作为 Bearer token，不再回退全局 token）`,
        );
      }
      const route = setPushRoute(db, profileId, {
        url,
        channel: channel.name,
        platform: args.platform as string | undefined,
        name: args.name as string | undefined,
        enabled: enabled ?? true,
      });
      return okJson({
        推送路由: route,
        说明:
          channel.name === "openclaw"
            ? "OpenClaw 回环通道（路径限 /hooks/<name>）：有独立 secret 时用它，否则用 daemon 的 OPENCLAW_HOOK_TOKEN（仅部署自身 profile）"
            : channel.requiresSecret
              ? "URL 仅允许回环地址；secret 来自环境变量"
              : "本地日志通道：不需要 URL 与 secret，通知写入进程日志并标记为已投递",
      });
    }
    if (enabled !== undefined) {
      // N-2：存量隔离用户的 openclaw 路由（收紧前落库、没有自己的 secret）过去在工具层
      // 一律拒绝重新启用，投递层却照投（只 warn）—— 契约不一致，用户误点一次「停用」
      // 就再也开不回来。这里与投递层对齐：允许启用，但用**同一个** warn 函数（同文案、
      // 同去重表）提示它仍走全局 token，建议补 secret 或改通道。
      // 配置/换 URL 的准入门槛不变（上面 url/channel 分支仍要求新配置自带 secret）。
      const current = getPushRoute(db, profileId);
      if (
        enabled &&
        current?.channel === "openclaw" &&
        routeSecret(ctx.config, profileId) === undefined &&
        !canUseGlobalOpenclawToken(ctx.config, profileId)
      ) {
        // 与投递层同口径：只在真的存在可回退的全局 token 时才提示（否则告警文案会误导）。
        // 投递层读的是 process.env.OPENCLAW_HOOK_TOKEN；config 快照在生产里与它同源，
        // 但测试环境用固定 env 对象建 config，不会带上它 —— 所以两边都取一次。
        warnOpenclawGlobalTokenFallback(
          profileId,
          ctx.config.openclawHookToken ?? process.env.OPENCLAW_HOOK_TOKEN?.trim(),
        );
      }
      // 必须走 core 的 setPushRouteEnabled：它在启用时会调 requeueRoute，
      // 把路由停用期间落入 fallback 的投递重新入队。直接 setSetting 会让
      // 那批通知永远停在 fallback（状态页只显示计数，用户无从补救）。
      const route = setPushRouteEnabled(db, profileId, enabled);
      return okJson({
        推送路由: route,
        说明: enabled
          ? "已启用；停用期间未投出的通知已重新入队"
          : "已停用（待投递行保留，重新启用会再投）",
      });
    }
    const current = getPushRoute(db, profileId);
    if (current === null)
      return okJson({
        推送路由: null,
        说明: `用 url 参数配置（webhook/openclaw 限回环地址，openclaw 路径限 /hooks/<name>），webhook secret 在 PROFILE_ROUTE_SECRETS_JSON，openclaw 用 profile secret（部署自身 profile 缺省才回退全局 OPENCLAW_HOOK_TOKEN）；channel 可选 ${supportedChannels().join(" / ")}（默认 ${DEFAULT_CHANNEL}）`,
      });
    return okJson({
      推送路由: {
        ...current,
        channel: getChannel(current.channel).name,
        secretConfigured: routeSecret(ctx.config, profileId) !== undefined,
      },
    });
  }

  if (action === "prefs") {
    // 读：不带 kind 时给出「已保存 / 内置默认 / 最终生效」三份，便于 agent 解释当前行为；
    // 写：带 kind + push 或 kind + channels，写入后立刻回显合并默认后的生效值。
    const kindRaw = args.kind;
    if (kindRaw !== undefined && (typeof kindRaw !== "string" || !KIND_RE.test(kindRaw))) {
      return fail(`kind 不合法: ${String(kindRaw)}（形如 bookkeeping.entry）`);
    }
    const stored = getNotifyPrefs(db, profileId);
    if (kindRaw === undefined) {
      return okJson({
        已保存: stored,
        内置默认: DEFAULT_KIND_PREFS,
        生效: prefsView(stored),
        说明: "push=false 表示不主动推送（通知仍入库，可 notify.pull 取回）；channels=null 表示不限通道",
      });
    }
    const kind = kindRaw;
    const pushRaw = args.push;
    const channelsRaw = args.channels;
    if (pushRaw === undefined && channelsRaw === undefined) {
      return fail(
        "prefs 带 kind 时需要 push（true/false）或 channels（通道名数组）；查看全部偏好请不要传 kind",
      );
    }
    if (pushRaw !== undefined && typeof pushRaw !== "boolean") {
      return fail("push 需要布尔值 true/false");
    }
    let channels: string[] | undefined;
    if (channelsRaw !== undefined) {
      if (!Array.isArray(channelsRaw)) return fail("channels 需要通道名数组");
      if (channelsRaw.some((item) => typeof item !== "string" || item.trim() === "")) {
        return fail("channels 只能包含非空通道名");
      }
      const names = (channelsRaw as string[]).map((item) => item.trim());
      const unknown = names.find((name) => !supportedChannels().includes(name));
      if (unknown !== undefined) {
        return fail(`不支持的通道: ${unknown}（可选 ${supportedChannels().join(" / ")}）`);
      }
      channels = [...new Set(names)];
    }
    const next: NotifyKindPref = { ...(stored[kind] ?? {}) };
    if (pushRaw !== undefined) next.push = pushRaw;
    if (channels !== undefined) {
      // 空数组 = 清除通道限制；若落成 `channels: []` 会被读回成「没有限制」，
      // 但存一份空数组在偏好里容易让人误以为「哪个通道都不允许」，所以直接删键。
      if (channels.length === 0) delete next.channels;
      else next.channels = channels;
    }
    stored[kind] = next;
    setNotifyPrefs(db, profileId, stored);
    const merged: NotifyKindPref = { ...DEFAULT_KIND_PREFS[kind], ...next };
    return okJson({
      已保存: { [kind]: next },
      生效: { push: merged.push !== false, channels: merged.channels ?? null },
      内置默认: DEFAULT_KIND_PREFS[kind] ?? null,
      说明: "push=false 表示不主动推送（通知仍入库，可 notify.pull 取回）；channels=null 表示不限通道",
    });
  }

  if (action === "test") {
    // dedupeKey 带时间戳 + 随机后缀：同一毫秒内连点两次不该被去重吞掉 —— 测试通知的意义
    // 就是「每次都真的发一次」，否则用户会以为通道坏了。
    const dedupeKey = `test:${Date.now()}-${randomUUID().slice(0, 8)}`;
    const blocks: NotifyBlock = {
      table: {
        columns: ["项目", "内容"],
        rows: [
          ["Profile", profileId],
          ["时间", localTimeText(nowIso())],
        ],
      },
      notes: ["这是一条通道测试通知；收到即表示推送路由可用。"],
    };
    // 直接用 core 的同步 publishProfile：与 ctx.services.publishProfile 是同一个实现
    // （createServices 只是把它包成 async），但同步返回让 test 与其它 action 一样
    // 直接给出结果，不必把整个工具改成 async（既有 action 的调用方都是同步取值的）。
    const result = publishProfile(db, ctx.config, profileId, {
      kind: "notify.test",
      title: "🔔 通知通道测试",
      blocks,
      dedupeKey,
    });
    const delivery = db
      .prepare(
        "SELECT route_name, status FROM deliveries WHERE notification_id = ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(result.id) as { route_name: string; status: string } | undefined;
    const route = getPushRoute(db, profileId);
    const channel = route === null ? null : (findChannel(route.channel)?.name ?? null);
    return okJson({
      已发送测试通知: {
        id: result.id,
        标题: "🔔 通知通道测试",
        种类: "notify.test",
        "时间(本地)": localTimeText(nowIso()),
        已建投递: delivery !== undefined,
        ...(delivery === undefined
          ? {}
          : { 通道: channel, 路由: delivery.route_name, 状态: delivery.status }),
      },
      说明:
        delivery === undefined
          ? "仅入库，未建立投递：没有启用中的推送路由，或该类型已关闭主动推送；可用 notify.pull 取回"
          : "已建立投递（结果见状态页，或稍后用 notify.pull 确认）",
    });
  }

  if (action === "history") {
    // 与 pull 的区别：pull 会**标记已读并取消待投递**，history 只是查看历史，
    // 绝不改 read/status —— 否则「翻一下历史」就会把没推出去的通知变成已读。
    const limit = clampInt(args.limit, 20, 1, 100);
    const offset = clampInt(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const kindRaw = args.kind;
    if (kindRaw !== undefined && (typeof kindRaw !== "string" || kindRaw.trim() === "")) {
      return fail("kind 需要非空字符串（如 bookkeeping.entry）");
    }
    const unreadRaw = args.unread;
    if (unreadRaw !== undefined && typeof unreadRaw !== "boolean") {
      return fail("unread 需要布尔值 true/false");
    }
    const conditions = ["profile_id = ?"];
    const params: (string | number)[] = [profileId];
    if (kindRaw !== undefined) {
      conditions.push("kind = ?");
      params.push((kindRaw as string).trim());
    }
    if (unreadRaw === true) conditions.push("read = 0");
    const where = conditions.join(" AND ");

    const total = (
      db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE ${where}`).get(...params) as {
        n: number;
      }
    ).n;
    const rows = db
      .prepare(
        `SELECT id, kind, title, created_at, read FROM notifications WHERE ${where}
         ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as {
      id: string;
      kind: string;
      title: string;
      created_at: string;
      read: number;
    }[];

    // 每条通知最近一条投递；同一通知有多条（换过路由/多通道路由历史）时取最新并标注，
    // 免得用户以为「只有这一条」而漏看另一条通道的失败。
    interface DeliveryInfo {
      status: string;
      attempts: number;
      last_error: string | null;
      routes: number;
    }
    const deliveryOf = new Map<string, DeliveryInfo>();
    if (rows.length > 0) {
      const placeholders = rows.map(() => "?").join(",");
      const deliveries = db
        .prepare(
          `SELECT notification_id, status, attempts, last_error FROM deliveries
           WHERE notification_id IN (${placeholders})
           ORDER BY notification_id, created_at DESC, id DESC`,
        )
        .all(...rows.map((r) => r.id)) as {
        notification_id: string;
        status: string;
        attempts: number;
        last_error: string | null;
      }[];
      for (const delivery of deliveries) {
        const existing = deliveryOf.get(delivery.notification_id);
        if (existing === undefined) {
          deliveryOf.set(delivery.notification_id, {
            status: delivery.status,
            attempts: delivery.attempts,
            last_error: delivery.last_error,
            routes: 1,
          });
        } else {
          existing.routes += 1;
        }
      }
    }

    return okJson({
      总数: total,
      偏移: offset,
      还有更多: offset + rows.length < total,
      记录: rows.map((row) => {
        const delivery = deliveryOf.get(row.id);
        return {
          id: row.id,
          种类: row.kind,
          标题: row.title,
          "时间(本地)": localTimeText(row.created_at),
          已读: row.read === 1,
          投递:
            delivery === undefined
              ? null
              : {
                  状态: delivery.status,
                  尝试次数: delivery.attempts,
                  最后错误: delivery.last_error,
                  ...(delivery.routes > 1 ? { 多路由: true } : {}),
                },
        };
      }),
    });
  }

  if (action === "retry") {
    const notificationIdRaw = args.notification_id;
    const deliveryIdRaw = args.delivery_id;
    if (
      notificationIdRaw !== undefined &&
      (typeof notificationIdRaw !== "string" || notificationIdRaw.trim() === "")
    ) {
      return fail("notification_id 需要非空字符串");
    }
    if (
      deliveryIdRaw !== undefined &&
      (typeof deliveryIdRaw !== "string" || deliveryIdRaw.trim() === "")
    ) {
      return fail("delivery_id 需要非空字符串");
    }
    const notificationId = notificationIdRaw as string | undefined;
    const deliveryId = deliveryIdRaw as string | undefined;
    const all = args.all === true;
    if (notificationId === undefined && deliveryId === undefined && !all) {
      return fail(
        "retry 需要 notification_id / delivery_id 指定单条，或 all=true 批量重试失败投递",
      );
    }

    // 归属预检：id 不存在或不属于当前 Profile 时明确报错（而不是回一句「重试 0 条」让人猜）
    if (deliveryId !== undefined) {
      const found = db
        .prepare(
          `SELECT 1 AS ok FROM deliveries d JOIN notifications n ON n.id = d.notification_id
           WHERE d.id = ? AND n.profile_id = ?`,
        )
        .get(deliveryId, profileId);
      if (found === undefined) return fail(`投递不存在或不属于当前 Profile: ${deliveryId}`);
    }
    if (notificationId !== undefined) {
      const found = db
        .prepare("SELECT 1 AS ok FROM notifications WHERE id = ? AND profile_id = ?")
        .get(notificationId, profileId);
      if (found === undefined) return fail(`通知不存在或不属于当前 Profile: ${notificationId}`);
    }

    const result = retryDeliveries(db, { profileId, notificationId, deliveryId, all });
    // 用户刚点了「重试」，不该等调度器 20s 那一轮；drainSoon 自带去抖与在途保护
    if (result.retried > 0) drainSoon(db, ctx.config);
    return okJson({
      重试数: result.retried,
      跳过数: result.skipped,
      说明: retryNote(result.retried, result.skipped),
    });
  }

  if (action === "cancel") {
    const id = args.id as string | undefined;
    if (id === undefined) return fail("cancel 需要 id（可从 pull 结果获取）");
    const row = db
      .prepare("SELECT id, title FROM notifications WHERE id = ? AND profile_id = ?")
      .get(id, profileId) as { id: string; title: string } | undefined;
    if (row === undefined) return fail(`通知不存在: ${id}`);
    const { cancelled, sending } = cancelPendingDeliveries(db, profileId, [id]);
    db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
    // P2-26：旧回执对「已发出 / 没有投递 / 拦不住的在途行 / 重复 cancel」一律回
    // 「已取消…待投递」，agent 会照抄成「已取消推送」，而用户可能已经收到。这里按实际
    // 条数分档回执：取消了 n 条、有没有发出过、有没有拦不住的 sending。
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent
         FROM deliveries WHERE notification_id = ?`,
      )
      .get(id) as { total: number; sent: number | null };
    const sent = counts.sent ?? 0;
    const detail =
      cancelled > 0
        ? `已取消投递 ${cancelled} 条`
        : counts.total === 0
          ? "没有投递记录（未配置推送路由，或该类型已关闭主动推送）"
          : sent > 0
            ? `没有待投递可取消（该通知的投递已发出 ${sent} 条）`
            : "没有待投递可取消";
    return ok(
      `通知《${row.title}》：${detail}；已标记为已读` +
        (sent > 0 && cancelled > 0 ? `；另有已发出的投递 ${sent} 条，撤回不了` : "") +
        (sending > 0
          ? `；仍有 ${sending} 条正在发送中，撤回不了（在途请求拦不住），是否已送达请以实际收到为准`
          : ""),
    );
  }

  return fail(`未知 action: ${String(action)}`);
}

/** z.enum 需要非空元组；通道清单以 src/core/channels.ts 为唯一来源 */
const CHANNEL_NAMES = supportedChannels() as [string, ...string[]];

/**
 * P2-22：通道清单只能由 supportedChannels() 生成。旧文案手写「webhook / openclaw / log」，
 * 后来新增 bark/ntfy/telegram/smtp 时没跟上 —— 工具描述与 enum 不一致，agent 会以为只有
 * 三个通道可选。这里只给个别通道补一句用途说明，清单本身仍来自 supportedChannels()。
 */
const CHANNEL_NOTES: Record<string, string> = {
  webhook: "默认，回环 HMAC V2，secret 在 PROFILE_ROUTE_SECRETS_JSON",
  openclaw:
    "OpenClaw Gateway 回环 hook，路径限 /hooks/<name>；凭据优先用该 profile 的 secret，部署自身 profile 缺省才回退全局 OPENCLAW_HOOK_TOKEN；隔离用户（登记了 Profile token 且非部署自身 profile）配置/换 URL 必须自带 route secret",
  log: "本地日志通道，不需要 URL/secret",
};
/** 工具总描述与 channel 字段描述共用一份清单，避免两处各写一份再次漂移 */
const CHANNEL_DESCRIPTION = supportedChannels()
  .map((name) => (CHANNEL_NOTES[name] === undefined ? name : `${name}（${CHANNEL_NOTES[name]}）`))
  .join(" / ");

registerModule({
  name: "notify",
  tools: [
    {
      name: "notify",
      description: `通知管理：action=pull 拉取未读通知（会话开始时调用一次，作为主动推送失败的兜底，会标记已读并取消待投递）；history 查看通知历史（limit/offset 分页，可按 kind 精确过滤、unread=true 只看未读；**不改变已读状态**，每条带最近一条投递的状态/尝试次数/最后错误，用于回答「哪条没发出去、为什么」）；retry 手动重试投递（notification_id 一条通知的全部投递 / delivery_id 单条投递 / all=true 批量重试该 Profile 所有 failed+fallback；重新入队后立即触发一轮投递）；quiet_hours 设置/查看/清除静默时段（HH:MM，支持跨午夜）；route 配置/查看主动推送通道（${CHANNEL_DESCRIPTION}）；prefs 查看/设置按类型的推送偏好（不带 kind 返回已保存+内置默认+最终生效值；带 kind+push 或 kind+channels 写入，push=false 表示不主动推送但通知仍入库、可用 pull 取回；bookkeeping.entry 默认不推，由每日摘要取代）；test 发一条测试通知验证通道（返回是否建立投递与所用通道，无路由时仅入库）；cancel 取消某条通知的待投递。`,
      inputSchema: {
        action: z.enum([
          "pull",
          "history",
          "retry",
          "quiet_hours",
          "route",
          "prefs",
          "test",
          "cancel",
        ]),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("pull/history 每页条数，默认 20（1-100）"),
        offset: z.number().int().min(0).optional().describe("history 偏移（从 0 开始），默认 0"),
        unread: z.boolean().optional().describe("history 只看未读（true）"),
        notification_id: z
          .string()
          .optional()
          .describe("retry 的通知 id（该通知下的投递全部重试）"),
        delivery_id: z.string().optional().describe("retry 的单条投递 id（精确到一条路由）"),
        all: z
          .boolean()
          .optional()
          .describe("retry 批量重试该 Profile 所有 failed/fallback 投递（上限 200 条）"),
        start: z.string().regex(TIME_RE).optional(),
        end: z.string().regex(TIME_RE).optional(),
        clear: z.boolean().optional().describe("清除静默时段"),
        url: z
          .string()
          .optional()
          .describe(
            "推送通道 URL（webhook/openclaw 仅允许 127.0.0.1/localhost/[::1] 回环地址；openclaw 路径限 /hooks/<name>）",
          ),
        channel: z
          .enum(CHANNEL_NAMES)
          .optional()
          .describe(`推送通道（默认 ${DEFAULT_CHANNEL}）：${CHANNEL_DESCRIPTION}`),
        platform: z.string().optional().describe("目标平台标识（如 wechat），仅记录"),
        name: z.string().max(80).optional().describe("路由名，默认 life-assistant-<profile>"),
        enabled: z.boolean().optional().describe("启用/停用路由"),
        id: z.string().optional().describe("cancel 的通知 id"),
        kind: z
          .string()
          .max(64)
          .optional()
          .describe(
            "prefs 的通知类型（如 bookkeeping.entry / schedule.reminder）；history 时作为精确过滤条件",
          ),
        push: z
          .boolean()
          .optional()
          .describe("prefs 设置该类型是否主动推送：false = 不打扰（通知仍入库，可 pull）"),
        channels: z
          .array(z.string())
          .max(10)
          .optional()
          .describe('prefs 限定该类型允许推送的通道（如 ["log"]）；传空数组清除限制，缺省不限通道'),
      },
      handler: notifyTool,
    },
  ],
  jobs: [
    {
      name: "retention",
      // 04:50（occurrence 清理 04:30 之后）：收敛只增不减的 notifications/deliveries
      // 与永不回收的已取消日程，避免长期运行后库无限增长
      cron: "50 4 * * *",
      handler: () => {
        const { db } = runtime();
        runRetention(db);
        // job_runs 与 notifications/deliveries 一样只增不减：随保留策略一起收敛。
        // 单独再挂一个 cron 只会多一个可能错过的触发点，还要再维护一份保留期配置。
        const prunedRuns = pruneJobRuns(db);
        logger.debug(`任务运行记录清理：删除 ${prunedRuns} 行`);
      },
    },
  ],
});
