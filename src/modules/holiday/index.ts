import { z } from "zod";
import { DATE_RE, isDate, todayIso } from "../../time.js";
import {
  dayType,
  ensureYears,
  holidayYearsReady,
  nextHolidayPeriod,
  requiredYears,
} from "../../core/holiday.js";
import {
  fail,
  ok,
  okJson,
  registerModule,
  runtime,
  type ToolContext,
  type ToolResult,
} from "../../core/registry.js";
import { logger } from "../../core/logger.js";

export async function holidayTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const view = args.view as string;
  const db = ctx.db;
  if (view === "next") {
    const period = nextHolidayPeriod(db);
    if (period === null) {
      const years = holidayYearsReady(db);
      if (years.length === 0) {
        return ok("节假日数据尚未导入，暂无法查询（导入后每天 02:00 自动刷新）");
      }
      // 覆盖到当年但查不到更晚的假期，通常是下一年数据还没导入，而不是「没有假期」。
      const currentYear = Number(todayIso().slice(0, 4));
      if (Math.max(...years) <= currentYear) {
        return ok(
          `覆盖年份内没有更晚的假期了；下一年（${currentYear + 1} 年）数据尚未导入（通常 11 月后发布）`,
        );
      }
      return ok("覆盖年份内没有更晚的假期了");
    }
    return okJson({
      下一假期: `${period.name}`,
      开始: period.start,
      结束: period.end,
      天数: period.days,
      数据覆盖年份: holidayYearsReady(db),
    });
  }
  if (view === "month") {
    const month = typeof args.month === "string" ? args.month : "";
    if (!/^\d{4}-\d{2}$/.test(month)) return fail("month 需为 YYYY-MM 格式");
    const rows = db
      .prepare("SELECT date, day_type, name FROM cn_holiday_days WHERE date LIKE ? ORDER BY date")
      .all(`${month}-%`) as { date: string; day_type: string; name: string }[];
    const table = rows.map((r) => [r.date, r.day_type === "holiday" ? "休息" : "上班", r.name]);
    return okJson({
      月份: month,
      安排:
        table.length > 0
          ? { columns: ["日期", "类型", "名称"], rows: table }
          : "当月无法定节假日/调休安排",
      数据覆盖年份: holidayYearsReady(db),
    });
  }
  // is_workday
  const date = typeof args.date === "string" ? args.date : "";
  if (!DATE_RE.test(date)) return fail("date 需为 YYYY-MM-DD 格式");
  // DATE_RE 只校验格式：2026-02-30 会因 weekday 为 NaN 被误判成「上班日（工作日）」
  if (!isDate(date)) return fail(`date 不是真实存在的日期: ${date}`);
  const cls = dayType(db, date);
  if (cls === "holiday") {
    const name = db.prepare("SELECT name FROM cn_holiday_days WHERE date = ?").get(date) as {
      name: string;
    };
    return ok(`${date}：休息日（法定节假日：${name.name}）`);
  }
  if (cls === "workday") return ok(`${date}：上班日（调休补班）`);
  if (cls === "weekend") return ok(`${date}：休息日（周末）`);
  if (cls === "weekday") return ok(`${date}：上班日（工作日）`);
  return ok(`${date}：未知（${date.slice(0, 4)} 年节假日数据未就绪，不猜测）`);
}

registerModule({
  name: "holiday",
  tools: [
    {
      name: "holiday",
      description:
        "中国大陆法定节假日/调休查询。view=next 查下一假期；view=month+month(YYYY-MM) 查某月安排；view=is_workday+date(YYYY-MM-DD) 判断某日是否上班。数据未覆盖时明确返回未知，绝不按星期猜测。",
      inputSchema: {
        view: z.enum(["next", "month", "is_workday"]).describe("查询类型"),
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe("view=month 时必填，如 2026-10"),
        date: z
          .string()
          .regex(DATE_RE)
          .optional()
          .describe("view=is_workday 时必填，如 2026-10-01"),
      },
      handler: holidayTool,
    },
  ],
  jobs: [
    {
      name: "refresh",
      cron: "0 2 * * *",
      handler: async () => {
        const { db } = runtime();
        const result = await ensureYears(db, requiredYears());
        if (result.failed.length > 0) logger.warn(`节假日刷新失败: ${result.failed.join("; ")}`);
      },
    },
  ],
  onStart: async () => {
    const { db } = runtime();
    const result = await ensureYears(db, requiredYears());
    if (result.failed.length > 0) logger.warn(`节假日引导导入失败: ${result.failed.join("; ")}`);
  },
});
