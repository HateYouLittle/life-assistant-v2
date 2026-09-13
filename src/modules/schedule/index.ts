import { z } from "zod";
import { DATE_RE, TIME_RE, instantToLocalDate } from "../../time.js";
import { describeRecurrence } from "../../core/recurrence.js";
import type { Recurrence } from "../../core/recurrence.js";
import { fail, ok, okJson, registerModule, runtime, errorMessage, type ToolContext } from "../../core/registry.js";
import {
  completeSchedule,
  createSchedule,
  deleteSchedule,
  getSchedule,
  KIND_LABEL,
  listSchedules,
  parseRecurrence,
  tickSchedules,
  upcoming,
  updateSchedule,
  type ScheduleInput,
  type SchedulePatch,
  type ScheduleRow,
} from "./service.js";

const recurrenceInput = z.object({
  freq: z.enum(["daily", "weekly", "monthly", "yearly"]).describe("循环频率"),
  interval: z.number().int().min(1).max(365).default(1).describe("间隔（默认 1）"),
  byweekday: z
    .array(z.number().int().min(0).max(6))
    .max(7)
    .optional()
    .describe("weekly 时生效：0=周一…6=周日，默认开始日期的星期"),
  until: z.string().regex(DATE_RE).optional().describe("最后一次发生的日期（含）"),
  count: z.number().int().min(1).max(9999).optional().describe("最多发生次数"),
});

function parseRecurrenceInput(value: unknown): Recurrence {
  const parsed = recurrenceInput.parse(value) as Recurrence;
  // 显式传空数组会让 recurrence 引擎无候选日可产出（历史上导致同步死循环），
  // 在入口处直接拒绝，而不是留到物化阶段。
  if (parsed.freq === "weekly" && parsed.byweekday !== undefined && parsed.byweekday.length === 0) {
    throw new Error("weekly 循环的 byweekday 不能为空数组；省略该字段表示使用开始日期的星期");
  }
  return parsed;
}

/** 只收集显式提供的字段：add 时补默认值，update 时未提供的字段保持原值 */
function buildPartial(args: Record<string, unknown>): SchedulePatch {
  const patch: SchedulePatch = {};
  if (args.title !== undefined) patch.title = String(args.title);
  if (args.note !== undefined) patch.note = String(args.note);
  if (args.kind !== undefined) patch.kind = args.kind as ScheduleInput["kind"];
  if (args.calendar !== undefined) patch.calendar = args.calendar as ScheduleInput["calendar"];
  if (args.date !== undefined) patch.startDate = String(args.date);
  if (args.lunar_month !== undefined) patch.lunarMonth = Number(args.lunar_month);
  if (args.lunar_day !== undefined) patch.lunarDay = Number(args.lunar_day);
  if (args.leap_policy !== undefined) patch.leapPolicy = args.leap_policy as "follow" | "regular";
  if (args.lunar_clamp !== undefined) patch.lunarClamp = Boolean(args.lunar_clamp);
  if (args.time !== undefined) patch.time = String(args.time);
  if (args.all_day !== undefined) patch.allDay = Boolean(args.all_day);
  if (args.recurrence !== undefined) patch.recurrence = parseRecurrenceInput(args.recurrence);
  if (args.remind_offsets !== undefined) {
    patch.remindOffsets = args.remind_offsets as number[];
  }
  if (args.resend_minutes !== undefined) patch.resendMinutes = Number(args.resend_minutes);
  if (args.workday_filter !== undefined) {
    patch.workdayFilter = args.workday_filter as ScheduleInput["workdayFilter"];
  }
  return patch;
}

function rowToPublic(row: ScheduleRow): Record<string, unknown> {
  const rec = parseRecurrence(row.recurrence_json);
  return {
    id: row.id,
    标题: row.title,
    类型: KIND_LABEL[row.kind],
    日历: row.calendar === "lunar" ? `农历${row.lunar_month}月${row.lunar_day}日` : row.start_date,
    时间: row.all_day === 1 ? `${row.time}（全天）` : row.time,
    重复: describeRecurrence(
      {
        calendar: row.calendar,
        recurrence: rec,
        lunarMonth: row.lunar_month,
        lunarDay: row.lunar_day,
        leapPolicy: (row.leap_policy ?? "follow") as "follow" | "regular",
      },
      row.start_date,
    ),
    提醒: JSON.parse(row.remind_offsets_json) as number[],
    状态: row.status,
    下次提醒: row.next_run_at,
    版本: row.version,
  };
}

export function scheduleTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    return scheduleToolInner(args, ctx);
  } catch (e) {
    return fail(errorMessage(e));
  }
}

function scheduleToolInner(args: Record<string, unknown>, ctx: ToolContext) {
  const action = args.action as string;
  const db = ctx.db;
  switch (action) {
    case "add": {
      if (args.title === undefined) return fail("add 需要 title");
      const patch = buildPartial(args);
      const kind = patch.kind ?? "todo";
      const input: ScheduleInput = {
        title: patch.title as string,
        note: patch.note ?? null,
        kind,
        calendar: patch.calendar ?? "solar",
        startDate: patch.startDate ?? null,
        lunarMonth: patch.lunarMonth ?? null,
        lunarDay: patch.lunarDay ?? null,
        leapPolicy: patch.leapPolicy ?? "follow",
        lunarClamp: patch.lunarClamp ?? true,
        time: patch.time ?? "09:00",
        // 未显式指定时按"有具体时刻"处理（对齐 v1 的 allDay 可空语义）；
        // 否则即使传了 time，也会被展示成"全天"。
        allDay: patch.allDay ?? false,
        recurrence: patch.recurrence ?? (kind === "todo" ? null : { freq: "yearly", interval: 1 }),
        remindOffsets: patch.remindOffsets ?? [0],
        resendMinutes: patch.resendMinutes ?? 0,
        workdayFilter: patch.workdayFilter ?? "any",
      };
      const row = createSchedule(db, ctx.profileId, input);
      return okJson({ 已创建: rowToPublic(row) });
    }
    case "list": {
      const status = (args.status as string) ?? "active";
      const limit = (args.limit as number) ?? 20;
      const rows = listSchedules(db, ctx.profileId, status, limit);
      return okJson({ 日程: rows.map(rowToPublic), 数量: rows.length });
    }
    case "update": {
      const id = args.id as string;
      if (id === undefined) return fail("update 需要 id");
      const patch = buildPartial(args);
      if (args.status !== undefined) {
        const status = args.status as ScheduleRow["status"];
        if (status === "active" || status === "done" || status === "cancelled") patch.status = status;
      }
      if (Object.keys(patch).length === 0) return fail("没有提供要更新的字段");
      const row = updateSchedule(db, ctx.profileId, id, patch);
      return okJson({ 已更新: rowToPublic(row) });
    }
    case "complete": {
      const id = args.id as string;
      if (id === undefined) return fail("complete 需要 id");
      const occurrenceKey = args.occurrence_key === undefined ? null : String(args.occurrence_key);
      const row = completeSchedule(db, ctx.profileId, id, occurrenceKey);
      return okJson({ 已完成: rowToPublic(row) });
    }
    case "delete": {
      const id = args.id as string;
      if (id === undefined) return fail("delete 需要 id");
      if (getSchedule(db, ctx.profileId, id) === undefined) return fail(`日程不存在: ${id}`);
      deleteSchedule(db, ctx.profileId, id);
      return ok(`已删除日程 ${id}`);
    }
    case "upcoming": {
      const limit = (args.limit as number) ?? 10;
      const items = upcoming(db, ctx.profileId, limit);
      return okJson({
        即将到来: items.map((i) => ({
          标题: i.title,
          类型: KIND_LABEL[i.kind],
          id: i.schedule_id,
          提醒时间: i.due_at,
          事件日期: instantToLocalDate(i.event_at),
          occurrence_key: i.occurrence_key,
        })),
      });
    }
    default:
      return fail(`未知 action: ${String(action)}`);
  }
}

registerModule({
  name: "schedule",
  tools: [
    {
      name: "schedule",
      description:
        "Profile 私有日程：待办/生日/纪念日，支持公历与农历（闰月策略、腊月三十顺延）、循环（每天/每周/每月/每年 + until/count）、按法定工作日/节假日重复、多级提醒与到点重发。" +
        "action=add 创建（calendar=lunar 时需 lunar_month/lunar_day 且按年循环；生日/纪念日默认按年循环）；list 查询；update 修改；complete 完成待办（可带 occurrence_key 只完成单次）；delete 删除；upcoming 查即将提醒。",
      inputSchema: {
        action: z.enum(["add", "list", "update", "complete", "delete", "upcoming"]),
        id: z.string().optional().describe("update/complete/delete 时必填"),
        title: z.string().min(1).max(120).optional(),
        note: z.string().max(500).optional(),
        kind: z.enum(["todo", "birthday", "anniversary"]).optional().describe("默认 todo"),
        calendar: z.enum(["solar", "lunar"]).optional().describe("默认 solar"),
        date: z.string().regex(DATE_RE).optional().describe("公历开始日期 YYYY-MM-DD"),
        lunar_month: z.number().int().min(1).max(12).optional(),
        lunar_day: z.number().int().min(1).max(30).optional(),
        leap_policy: z.enum(["follow", "regular"]).optional().describe("闰月策略，默认 follow"),
        lunar_clamp: z.boolean().optional().describe("农历日越界（如腊月三十缺失）取当月最后一天，默认 true"),
        time: z.string().regex(TIME_RE).optional().describe("提醒时刻 HH:MM，默认 09:00"),
        all_day: z.boolean().optional().describe("默认 false（有具体时刻按时间提醒）；纯日期事件设 true"),
        recurrence: recurrenceInput.optional(),
        workday_filter: z.enum(["any", "workday", "holiday"]).optional().describe("仅公历；节假日数据缺失时自动暂停"),
        remind_offsets: z
          .array(z.number().int().min(-43200).max(43200))
          .max(5)
          .optional()
          .describe("提醒偏移分钟（相对事件时间，负数=提前），默认 [0]"),
        resend_minutes: z.number().int().min(0).max(1440).optional().describe("待办到点后 N 分钟重发一次，默认 0"),
        status: z.enum(["active", "done", "cancelled"]).optional().describe("list 过滤 / update 修改"),
        limit: z.number().int().min(1).max(100).optional(),
        occurrence_key: z.string().optional().describe("complete 时可选，只完成该次发生"),
      },
      handler: scheduleTool,
    },
  ],
  tick: async (at) => {
    const rt = runtime();
    await tickSchedules(at, rt.services, rt.db);
  },
});
