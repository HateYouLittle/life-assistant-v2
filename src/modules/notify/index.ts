import { z } from "zod";
import { TIME_RE } from "../../time.js";
import {
  errorMessage,
  fail,
  ok,
  okJson,
  registerModule,
  type ToolContext,
} from "../../core/registry.js";
import {
  cancelPendingDeliveries,
  getPushRoute,
  routeSecret,
  setPushRoute,
} from "../../core/notify.js";
import { deleteSetting, getSetting, setSetting } from "../../core/settings.js";

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
        标题: r.title,
        种类: r.kind,
        时间: r.created_at,
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
    const enabled = args.enabled as boolean | undefined;
    if (url !== undefined) {
      if (routeSecret(ctx.config, profileId) === undefined) {
        return fail(
          `PROFILE_ROUTE_SECRETS_JSON 中没有 profile "${profileId}" 的 secret，无法启用推送`,
        );
      }
      const route = setPushRoute(db, profileId, {
        url,
        platform: args.platform as string | undefined,
        name: args.name as string | undefined,
        enabled: enabled ?? true,
      });
      return okJson({ 推送路由: route, 说明: "URL 仅允许回环地址；secret 来自环境变量" });
    }
    if (enabled !== undefined) {
      const current = getPushRoute(db, profileId);
      if (current === null) return fail("尚未配置推送路由，请先提供 url");
      setSetting(db, profileId, "push_route", { ...current, enabled });
      return okJson({ 推送路由: { ...current, enabled } });
    }
    const current = getPushRoute(db, profileId);
    if (current === null)
      return okJson({
        推送路由: null,
        说明: "用 url 参数配置（回环地址），secret 在 PROFILE_ROUTE_SECRETS_JSON",
      });
    return okJson({
      推送路由: {
        ...current,
        url: current.url,
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

registerModule({
  name: "notify",
  tools: [
    {
      name: "notify",
      description:
        "通知管理：action=pull 拉取未读通知（会话开始时调用一次，作为主动推送失败的兜底）；quiet_hours 设置/查看/清除静默时段（HH:MM，支持跨午夜）；route 配置/查看主动推送 webhook（回环地址，secret 在 env）；cancel 取消某条通知的待投递。",
      inputSchema: {
        action: z.enum(["pull", "quiet_hours", "route", "cancel"]),
        limit: z.number().int().min(1).max(100).optional().describe("pull 条数，默认 20"),
        start: z.string().regex(TIME_RE).optional(),
        end: z.string().regex(TIME_RE).optional(),
        clear: z.boolean().optional().describe("清除静默时段"),
        url: z.string().optional().describe("推送 webhook 地址（127.0.0.1/localhost/[::1]）"),
        platform: z.string().optional().describe("目标平台标识（如 wechat），仅记录"),
        name: z.string().optional().describe("路由名，默认 life-assistant-<profile>"),
        enabled: z.boolean().optional().describe("启用/停用路由"),
        id: z.string().optional().describe("cancel 的通知 id"),
      },
      handler: notifyTool,
    },
  ],
});
