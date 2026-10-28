import { z } from "zod";
import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { DATE_RE, TZ, isDate, now, todayIso } from "../../time.js";
import {
  dayType,
  ensureYears,
  holidayDayName,
  holidayPeriods,
  holidayYearsNeedingData,
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

/*
 * 补班提醒的**唯一来源**是本模块的 workday_watch（它本就负责「今天补班 / 假期临近 /
 * 假期最后一天」三类调休提醒）；每日简报只做天气与日程，不再重复「今天要补班」。
 *
 * 历史缺陷：早报 notes 里也曾写「⚠️ 今天要补班」，两个 job 默认又同在 07:00 触发，
 * 用户同日收到两条同义推送（2026-09-19、2026-10-09 两个 Profile 均复现）。
 * 早期方案是「workday_watch 里先查当天是否已有 weather.brief 再跳过」，但真实库的
 * created_at（毫秒）证明 workday_watch 每次都在 daily_brief 之前跑完 —— 该判断在默认
 * 配置下永远为假，线上仍会双推。因此改为把补班内容从早报里移除（单一事实来源），
 * 两条 job 的相对顺序、以及某天简报成功与否都不再影响正确性。
 */

/**
 * 调休/补班提醒（job workday_watch）。三个互不干扰的触发条件，各自独立去重：
 * ① 今天补班；② 假期临近（首日距今 ≤ WORKDAY_REMIND_DAYS_BEFORE）；③ 假期最后一天。
 * 遍历口径与 runDailyBrief 一致（listProfiles）：即使无推送路由也保留通知，供 notify.pull 兜底。
 * 当天年份数据 unknown 时一律跳过、不猜；单个 Profile 失败只记日志，job 不抛。
 *
 * `at` = 这次运行对应的**参考时刻**：cron/手动调用传当前时刻（缺省 now()），启动补发
 * 则传「错过的那次原定触发时刻」。`WORKDAY_WATCH_CRON` 可配到 18:00 之后，6 小时补发
 * 窗口会跨午夜：若仍按 now() 取业务日，凌晨补发会把「今天/假期最后一天」整体错位一天
 * （该推的提醒整条丢失，与 B1 是同一缺陷的另一半）。
 */
export async function runWorkdayWatch(at?: DateTime): Promise<void> {
  const rt = runtime();
  const db = rt.db;
  // 业务日锚定参考时刻：下面的「今天补班 / 假期临近 / 假期最后一天」与 dedupeKey 都用它。
  const today = (at ?? now()).toISODate() ?? todayIso();
  const todayType = dayType(db, today);
  if (todayType === "unknown") return;

  const periods = holidayPeriods(db);
  const remindDays = rt.config.workdayRemindDaysBefore;

  for (const profileId of listProfiles(db)) {
    try {
      if (todayType === "workday") {
        // 补班提示只由本模块推送（早报已移除同义文案，见文件上方注释）；
        // dedupeKey 保持 `holiday:workday:<date>`：同一天重复跑仍只落一条。
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
        const tomorrowDate = DateTime.fromISO(today, { zone: TZ }).plus({ days: 1 }).toISODate();
        const tomorrow = tomorrowDate ?? "";
        // 次日不一定是上班日：公告假期最后一天可能是周五/周六（如 2019 清明/端午/中秋
        // 都是周五单日假），次日是普通周末且没有调休补班行。硬编码「恢复正常上班」会
        // 说错事实；按 dayType 分支，unknown 时保持中性、绝不猜。
        const tomorrowType = tomorrowDate === null ? "unknown" : dayType(db, tomorrowDate);
        const note =
          tomorrowType === "workday" || tomorrowType === "weekday"
            ? `明天（${tomorrow}）恢复正常上班`
            : tomorrowType === "weekend"
              ? `明天（${tomorrow}）是周末，正常休息`
              : tomorrowType === "holiday"
                ? `明天（${tomorrow}）仍是假期`
                : `明天（${tomorrow}）假期结束`;
        await publishProfile(db, rt.config, profileId, {
          kind: "holiday.lastday",
          title: `${ending.name}假期最后一天`,
          blocks: { notes: [note] },
          dedupeKey: `holiday:lastday:${today}`,
        });
      }
    } catch (e) {
      logger.warn(`调休/补班提醒失败 ${profileId}: ${errorMessage(e)}`);
    }
  }
}

/** 分发参数（P2-20②）：`action` 是规范名，`view` 是兼容别名（SKILL.md 与既有调用方仍写 view）。 */
const HOLIDAY_ACTIONS = ["next", "month", "is_workday"] as const;

/**
 * 必填参数表（P2-20③）：集中校验「哪个分支需要哪些参数」，不再在每个分支各写一遍。
 * 这里只判「缺失/纯空白」，格式校验仍留在各分支 —— 既有报错文案逐字不变。
 */
const ACTION_REQUIRES: Record<string, readonly { field: string; message: string }[]> = {
  month: [{ field: "month", message: "month 需为 YYYY-MM 格式" }],
  is_workday: [{ field: "date", message: "date 需为 YYYY-MM-DD 格式" }],
};

/**
 * 解析分发参数：action 与 view 同时给出且不同时明确报错（绝不静默取其一）；
 * 未知取值统一按规范名报 `未知 action: …`（与其余工具一致，见 P2-25）。
 */
function resolveHolidayAction(args: Record<string, unknown>): string | { error: string } {
  const action = typeof args.action === "string" ? args.action : undefined;
  const view = typeof args.view === "string" ? args.view : undefined;
  const known = (value: string): boolean => (HOLIDAY_ACTIONS as readonly string[]).includes(value);
  if (action !== undefined && !known(action)) return { error: `未知 action: ${action}` };
  // view 只是别名：未知取值同样按规范名报错，各工具的未知分支文案保持一致
  if (view !== undefined && !known(view)) return { error: `未知 action: ${view}` };
  if (action !== undefined && view !== undefined && action !== view) {
    return { error: `action 与 view 冲突: action=${action}, view=${view}` };
  }
  if (action !== undefined) return action;
  if (view !== undefined) return view;
  return { error: "缺少 action（或兼容别名 view）" };
}

/** 按 ACTION_REQUIRES 表校验必填参数；缺失/纯空白时返回报错文案（空串等同缺失） */
function missingRequiredArg(key: string, args: Record<string, unknown>): string | null {
  for (const rule of ACTION_REQUIRES[key] ?? []) {
    const value = args[rule.field];
    if (value === undefined || (typeof value === "string" && value.trim() === "")) {
      return rule.message;
    }
  }
  return null;
}

/**
 * 该月**所需年度**的并集中未 ready 的年份（P2-5 的 holidayYearsNeedingData 是单一来源）。
 *
 * 为什么不能只看「月份所属年份」：上游按**假期**归档，元旦假期/调休放在下一年度文件里
 * （实测 2023.json 含 2022-12-31），所以 2026-12 的权威数据包含 2027 年度。2026 ready、
 * 2027 未就绪时该月没有任何行，旧判据（只看 2026）会给出肯定式错答「当月无法定节假日/
 * 调休安排」——用户/agent 以为查到了答案，实际是数据没到。
 *
 * 逐日取并集而不是写死「12-25 起看下一年」：跨年窗口规则变化（提前/延后）时这里自动跟随，
 * 不产生第二份规则（P2-5 的 holidayLookupYears 是唯一来源）。
 */
function monthMissingYears(db: DatabaseSync, month: string): number[] {
  const first = DateTime.fromISO(`${month}-01`, { zone: TZ });
  if (!first.isValid) return [];
  const missing = new Set<number>();
  for (let day = 1; day <= (first.daysInMonth ?? 31); day += 1) {
    const date = `${month}-${String(day).padStart(2, "0")}`;
    for (const year of holidayYearsNeedingData(db, date)) missing.add(year);
  }
  return [...missing].sort((a, b) => a - b);
}

export async function holidayTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const resolved = resolveHolidayAction(args);
  if (typeof resolved !== "string") return fail(resolved.error);
  const action = resolved;
  const missing = missingRequiredArg(action, args);
  if (missing !== null) return fail(missing);
  const db = ctx.db;
  switch (action) {
    case "next": {
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
    case "month": {
      const month = typeof args.month === "string" ? args.month : "";
      if (!/^\d{4}-\d{2}$/.test(month)) return fail("month 需为 YYYY-MM 格式");
      // 格式合法不等于月份合法：`2026-13` 会被 LIKE '2026-13-%' 静默查成「无安排」。
      const monthNumber = Number(month.slice(5, 7));
      if (monthNumber < 1 || monthNumber > 12) {
        return fail(`月份不合法: ${month}（需为 01-12）`);
      }
      // 先按行查，再看所需年度 —— 与 dayType 的「行命中优先」口径一致：
      // 跨年日期（如 2027 年度文件里的 2026-12-31）会让「日期所属年份」未就绪但行已存在，
      // 此时 is_workday 给出确定答案，month 也必须照常展示，不能反过来报「未知」。
      const rows = db
        .prepare("SELECT date, day_type, name FROM cn_holiday_days WHERE date LIKE ? ORDER BY date")
        .all(`${month}-%`) as { date: string; day_type: string; name: string }[];
      // 只有「该月没有任何行」时才是真正未知；判据是**该月所需年度的并集**（P2-5 的
      // holidayYearsNeedingData，单一来源），而不是「月份所属年份」：跨年归档区间
      // （12-25~12-31，元旦假期/调休）的权威数据放在下一年度文件里，2026-12 在
      // 「2026 ready、2027 未就绪」时既没有行、也不该被当成「当月无法定节假日/调休安排」
      // （肯定式错答），必须点名真正缺失的 2027。
      if (rows.length === 0) {
        const missingYears = monthMissingYears(db, month);
        if (missingYears.length > 0) {
          return okJson({
            月份: month,
            安排: `未知（${missingYears.join("/")} 年节假日数据未就绪，不猜测）`,
            数据覆盖年份: holidayYearsReady(db),
          });
        }
      }
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
    case "is_workday": {
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
      // 未知时点名**真正缺失的年度**（P2-5 的 holidayYearsNeedingData 是单一来源）：
      // 跨年区间（12-25~12-31）的权威分类来自下一年度文件，此时日期所属年份往往已 ready，
      // 按 `date.slice(0,4)` 报年份会指向一个并不缺失的项，用户/agent 无从判断该补哪一年。
      const missingYears = holidayYearsNeedingData(db, date);
      if (missingYears.length === 0) {
        return ok(`${date}：未知（${date.slice(0, 4)} 年节假日数据未就绪，不猜测）`);
      }
      return ok(`${date}：未知（${missingYears.join("/")} 年节假日数据未就绪，不猜测）`);
    }
    // 显式兜底（P2-25）：未知分支绝不落入 is_workday，文案前缀与其它工具一致
    default:
      return fail(`未知 action: ${String(action)}`);
  }
}

registerModule({
  name: "holiday",
  tools: [
    {
      name: "holiday",
      description:
        "中国大陆法定节假日/调休查询。action=next 查下一假期；action=month+month(YYYY-MM) 查某月安排；action=is_workday+date(YYYY-MM-DD) 判断某日是否上班。action 为规范名，view 为兼容别名（两者等价；同时传且不同会报错）。数据未覆盖时明确返回未知，绝不按星期猜测。",
      inputSchema: {
        action: z
          .enum(HOLIDAY_ACTIONS)
          .optional()
          .describe("查询类型（规范名）：next 查下一假期 / month 查某月 / is_workday 判断某日"),
        view: z
          .enum(HOLIDAY_ACTIONS)
          .optional()
          .describe("兼容别名，等价于 action；同时传且冲突会明确报错"),
        month: z
          .string()
          .regex(/^\d{4}-\d{2}$/)
          .optional()
          .describe("action=month 时必填，如 2026-10"),
        date: z
          .string()
          .regex(DATE_RE)
          .optional()
          .describe("action=is_workday 时必填，如 2026-10-01"),
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
