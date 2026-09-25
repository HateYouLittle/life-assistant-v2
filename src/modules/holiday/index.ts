import { z } from "zod";
import { DateTime } from "luxon";
import { DATE_RE, TZ, isDate, todayIso } from "../../time.js";
import {
  dayType,
  ensureYears,
  holidayDayName,
  holidayPeriods,
  holidayYearsReady,
  nextHolidayPeriod,
  requiredYears,
} from "../../core/holiday.js";
import {
  errorMessage,
  fail,
  ok,
  okJson,
  registerModule,
  runtime,
  type ToolContext,
  type ToolResult,
} from "../../core/registry.js";
import { listProfiles } from "../../core/settings.js";
import { publishProfile } from "../../core/notify.js";
import { logger } from "../../core/logger.js";

const ONE_DAY_MS = 86_400_000;

/**
 * 调休/补班提醒（job workday_watch）。三个互不干扰的触发条件，各自独立去重：
 * ① 今天补班；② 假期临近（首日距今 ≤ WORKDAY_REMIND_DAYS_BEFORE）；③ 假期最后一天。
 * 遍历口径与 runDailyBrief 一致（listProfiles）：即使无推送路由也保留通知，供 notify.pull 兜底。
 * 当天年份数据 unknown 时一律跳过、不猜；单个 Profile 失败只记日志，job 不抛。
 */
export async function runWorkdayWatch(): Promise<void> {
  const rt = runtime();
  const db = rt.db;
  const today = todayIso();
  const todayType = dayType(db, today);
  if (todayType === "unknown") return;

  const periods = holidayPeriods(db);
  const remindDays = rt.config.workdayRemindDaysBefore;

  for (const profileId of listProfiles(db)) {
    try {
      if (todayType === "workday") {
        const name = holidayDayName(db, today) ?? "调休";
        await publishProfile(db, rt.config, profileId, {
          kind: "holiday.workday",
          title: `⚠️ 今天要补班（${name}调休）`,
          blocks: { notes: [`${today} 属${name}调休上班日`] },
          dedupeKey: `holiday:workday:${today}`,
        });
      }

      for (const period of periods) {
        if (period.start <= today) continue;
        const daysUntil = Math.round(
          (DateTime.fromISO(period.start, { zone: TZ }).toMillis() -
            DateTime.fromISO(today, { zone: TZ }).toMillis()) /
            ONE_DAY_MS,
        );
        if (daysUntil > remindDays) continue;
        // 只列今天及以后的调休日：已过去的调休日（早已补过班）列进提醒只是噪音。
        // 过滤后为空时整行省略 —— 「调休日都已过完」与「本来就没有调休日」语义不同，
        // 后者仍保留「本假期无调休上班日」，前者不再输出。
        const upcomingWorkdays = period.workdays.filter((date) => date >= today);
        const notes = [`${period.name}：${period.start}–${period.end}，共 ${period.days} 天`];
        if (period.workdays.length === 0) {
          notes.push("本假期无调休上班日");
        } else if (upcomingWorkdays.length > 0) {
          notes.push(`调休上班日：${upcomingWorkdays.join("、")}`);
        }
        await publishProfile(db, rt.config, profileId, {
          kind: "holiday.period",
          title: `📅 ${period.name} 放假安排`,
          blocks: { notes },
          dedupeKey: `holiday:period:${period.start}`,
        });
      }

      const ending = periods.find((period) => period.end === today);
      if (ending !== undefined) {
        const tomorrow = DateTime.fromISO(today, { zone: TZ }).plus({ days: 1 }).toISODate();
        await publishProfile(db, rt.config, profileId, {
          kind: "holiday.lastday",
          title: `${ending.name}假期最后一天`,
          blocks: { notes: [`明天（${tomorrow}）恢复正常上班`] },
          dedupeKey: `holiday:lastday:${today}`,
        });
      }
    } catch (e) {
      logger.warn(`调休/补班提醒失败 ${profileId}: ${errorMessage(e)}`);
    }
  }
}

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
      进行中: period.inProgress,
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
    {
      name: "workday_watch",
      cron: () => runtime().config.workdayWatchCron,
      handler: runWorkdayWatch,
    },
  ],
  onStart: async () => {
    const { db } = runtime();
    const result = await ensureYears(db, requiredYears());
    if (result.failed.length > 0) logger.warn(`节假日引导导入失败: ${result.failed.join("; ")}`);
  },
});
