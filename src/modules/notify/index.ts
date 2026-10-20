import { z } from "zod";
import { DateTime } from "luxon";
import { TIME_RE, TZ } from "../../time.js";
import { DEFAULT_CHANNEL, getChannel, supportedChannels } from "../../core/channels.js";
import {
  errorMessage,
  fail,
  ok,
  okJson,
  registerModule,
  runtime,
  type ToolContext,
} from "../../core/registry.js";
import { runRetention } from "../../core/retention.js";
import { pruneJobRuns } from "../../core/jobs.js";
import { logger } from "../../core/logger.js";
import {
  cancelPendingDeliveries,
  getPushRoute,
  routeSecret,
  setPushRoute,
  setPushRouteEnabled,
} from "../../core/notify.js";
import { deleteSetting, getSetting, setSetting } from "../../core/settings.js";

/** UTC ISO → 本地（Asia/Shanghai）文本；解析失败原样返回，不编造 */
function localTimeText(iso: string): string {
  const dt = DateTime.fromISO(iso, { zone: TZ });
  return dt.isValid ? dt.toFormat("yyyy-LL-dd HH:mm") : iso;
}

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
      if (channel.requiresSecret && routeSecret(ctx.config, profileId) === undefined) {
        return fail(
          `PROFILE_ROUTE_SECRETS_JSON 中没有 profile "${profileId}" 的 secret，无法启用推送`,
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
        说明: channel.requiresSecret
          ? "URL 仅允许回环地址；secret 来自环境变量"
          : "本地日志通道：不需要 URL 与 secret，通知写入进程日志并标记为已投递",
      });
    }
    if (enabled !== undefined) {
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
        说明: `用 url 参数配置（回环地址），secret 在 PROFILE_ROUTE_SECRETS_JSON；channel 可选 ${supportedChannels().join(" / ")}（默认 ${DEFAULT_CHANNEL}）`,
      });
    return okJson({
      推送路由: {
        ...current,
        channel: getChannel(current.channel).name,
        secretConfigured: routeSecret(ctx.config, profileId) !== undefined,
      },
    });
  }

  if (action === "cancel") {
    const id = args.id as string | undefined;
    if (id === undefined) return fail("cancel 需要 id（可从 pull 结果获取）");
    const row = db
      .prepare("SELECT id, title FROM notifications WHERE id = ? AND profile_id = ?")
      .get(id, profileId) as { id: string; title: string } | undefined;
    if (row === undefined) return fail(`通知不存在: ${id}`);
    cancelPendingDeliveries(db, profileId, [id]);
    db.prepare("UPDATE notifications SET read = 1 WHERE id = ?").run(id);
    return ok(`已取消通知《${row.title}》的待投递并标记已读`);
  }

  return fail(`未知 action: ${String(action)}`);
}

/** z.enum 需要非空元组；通道清单以 src/core/channels.ts 为唯一来源 */
const CHANNEL_NAMES = supportedChannels() as [string, ...string[]];

registerModule({
  name: "notify",
  tools: [
    {
      name: "notify",
      description:
        "通知管理：action=pull 拉取未读通知（会话开始时调用一次，作为主动推送失败的兜底）；quiet_hours 设置/查看/清除静默时段（HH:MM，支持跨午夜）；route 配置/查看主动推送通道（channel=webhook 默认，HMAC V2 回环 webhook、secret 在 env；channel=log 本地日志通道，不需要 URL/secret）；cancel 取消某条通知的待投递。",
      inputSchema: {
        action: z.enum(["pull", "quiet_hours", "route", "cancel"]),
        limit: z.number().int().min(1).max(100).optional().describe("pull 条数，默认 20"),
        start: z.string().regex(TIME_RE).optional(),
        end: z.string().regex(TIME_RE).optional(),
        clear: z.boolean().optional().describe("清除静默时段"),
        url: z.string().optional().describe("推送 webhook 地址（127.0.0.1/localhost/[::1]）"),
        channel: z
          .enum(CHANNEL_NAMES)
          .optional()
          .describe("推送通道：webhook（默认，回环 HMAC V2）或 log（本地日志，不需要 URL/secret）"),
        platform: z.string().optional().describe("目标平台标识（如 wechat），仅记录"),
        name: z.string().max(80).optional().describe("路由名，默认 life-assistant-<profile>"),
        enabled: z.boolean().optional().describe("启用/停用路由"),
        id: z.string().optional().describe("cancel 的通知 id"),
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
