import { DateTime } from "luxon";
import { z } from "zod";
import { defineActionTool } from "../../core/action-tool.js";
import type { AirQuality, CurrentWeather, ForecastDay, WeatherAlert } from "../../core/qweather.js";
import {
  airQuality,
  alerts,
  currentWeather,
  forecast,
  geoLookup,
  saveLocation,
} from "../../core/qweather.js";
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
import { deleteSetting, setSetting } from "../../core/settings.js";
import { isDate, TZ, todayIso } from "../../time.js";
import { runAlertWatch, runDailyBrief, runEveningBrief } from "./briefs.js";
import {
  alertLocalTime,
  calendarDaysBetween,
  isTravelActive,
  readTravelPlan,
  requireQweather,
  resolveToolPlace,
  TRAVEL_PLAN_KEY,
  type TravelPlan,
  travelModeField,
  travelModeText,
} from "./place.js";

export {
  alertCacheTtlMs,
  runAlertWatch,
  runDailyBrief,
  runEveningBrief,
  specialDayNotes,
} from "./briefs.js";

/** 观测时刻 → 本地「yyyy-MM-dd HH:mm」；解析不了就原样返回（不编造） */
function obsTimeText(obsTime: string): string {
  const dt = DateTime.fromISO(obsTime, { zone: TZ });
  return dt.isValid ? dt.toFormat("yyyy-LL-dd HH:mm") : obsTime;
}

function weatherTable(cur: CurrentWeather): { columns: string[]; rows: string[][] } {
  // 「数据来源时间」：让 agent 能如实标注，而不是省略或编造（见 skill/SKILL.md）。
  // v1 实时天气不再返回观测时刻（obsTime），退回数据获取时刻（fetchedAt），并
  // **改标为「数据获取时间」** —— 两者语义不同，不能共用一个「更新时间」标签掩盖新鲜度。
  const timeRow: string[] | null =
    cur.obsTime !== undefined
      ? ["更新时间", obsTimeText(cur.obsTime)]
      : cur.fetchedAt !== undefined
        ? ["数据获取时间", obsTimeText(cur.fetchedAt)]
        : null;
  return {
    columns: ["项目", "内容"],
    rows: [
      ["天气", cur.text],
      ["气温", `${cur.temp}°C（体感 ${cur.feelsLike}°C）`],
      ["湿度", `${cur.humidity}%`],
      ["风速", `${cur.windSpeed} km/h`],
      ...(timeRow === null ? [] : [timeRow]),
    ],
  };
}

function forecastTable(days: ForecastDay[]): { columns: string[]; rows: string[][] } {
  return {
    columns: ["日期", "天气", "气温", "降水"],
    rows: days.map((d) => [
      d.date,
      d.textDay,
      `${d.tMin}~${d.tMax}°C`,
      d.precipMm === undefined ? "—" : `${d.precipMm}mm`,
    ]),
  };
}

function alertTable(list: WeatherAlert[]): { columns: string[]; rows: string[][] } {
  return {
    columns: ["级别", "类型", "生效", "失效", "内容"],
    rows: list.map((a) => [
      a.level || "—",
      a.type,
      alertLocalTime(a.startsAt),
      alertLocalTime(a.endsAt),
      a.description,
    ]),
  };
}

function airTable(air: AirQuality): { columns: string[]; rows: string[][] } {
  const rows: string[][] = [
    ["AQI（国标）", `${air.aqi}（${air.category}）`],
    ["首要污染物", air.primary ?? "—"],
  ];
  if (air.pm25 !== undefined) rows.push(["PM2.5", `${air.pm25} μg/m³`]);
  if (air.pm10 !== undefined) rows.push(["PM10", `${air.pm10} μg/m³`]);
  return { columns: ["项目", "内容"], rows };
}

/** view 兼容别名的合法取值（SKILL.md 与既有调用方仍写 view，必须继续可用） */
const WEATHER_VIEWS = ["current", "forecast", "alert", "air", "locate", "travel"] as const;
/**
 * 空气质量视图：`weather {action|view:"air"}` 与独立工具 `air_quality` 共用**同一份**实现
 * （P2-20①）。两条入口此前是并行代码（同样的 place 解析 + requireQweather + airQuality +
 * airTable + 出行模式字段拼装），改口径要同步两处、极易漂移；现在「输出逐字一致」由
 * 「同一个函数」保证，而不是靠人工对齐。
 */
async function airView(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  try {
    const place = await resolveToolPlace(ctx, args.city as string | undefined);
    const { host, key } = requireQweather(ctx);
    const air = await airQuality(ctx.db, host, key, place.loc);
    return okJson({
      城市: place.loc.city,
      ...(place.travel === null ? {} : { 出行模式: travelModeField(place.travel) }),
      空气质量: airTable(air),
    });
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/** travel：出行计划的 set/clear/show（只写该 Profile 的 settings.travel_plan，不新增表） */
async function travelView(
  travelOp: string | undefined,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const today = todayIso();
  if (travelOp === "show") {
    const state = readTravelPlan(ctx.db, ctx.profileId);
    if (state.kind === "corrupt") {
      return okJson({
        出行模式: null,
        说明: "出行计划数据损坏，已忽略；可重新 set 覆盖，或先 clear 清除",
      });
    }
    if (state.kind === "none") return okJson(null);
    const plan = state.plan;
    return okJson({
      出行模式: {
        城市: plan.city,
        城市ID: plan.cityId,
        纬度: plan.lat,
        经度: plan.lon,
        开始: plan.start,
        结束: plan.end,
      },
      生效: isTravelActive(plan, today),
      今天: today,
    });
  }
  if (travelOp === "clear") {
    deleteSetting(ctx.db, ctx.profileId, TRAVEL_PLAN_KEY);
    return ok("已清除出行模式");
  }
  if (travelOp !== "set") return fail("travel 需要 action 参数（set/clear/show）");
  const city = typeof args.city === "string" ? args.city.trim() : "";
  if (city === "") return fail("设置出行计划需要 city 参数");
  const start = typeof args.start === "string" ? args.start : "";
  const end = typeof args.end === "string" ? args.end : "";
  if (!isDate(start) || !isDate(end)) {
    return fail("设置出行计划需要合法的 start/end 日期（YYYY-MM-DD）");
  }
  if (start > end) return fail("出行计划开始日期不能晚于结束日期");
  if (end < today) return fail(`出行计划结束日期不能早于今天（${today}）`);
  const windowDays = calendarDaysBetween(start, end) + 1;
  if (windowDays > 366) return fail(`出行窗口最长 366 天（当前 ${windowDays} 天）`);
  const { host, key } = requireQweather(ctx);
  const loc = await geoLookup(ctx.db, host, key, city);
  const plan: TravelPlan = {
    city: loc.city,
    cityId: loc.cityId,
    lat: loc.lat,
    lon: loc.lon,
    start,
    end,
  };
  setSetting(ctx.db, ctx.profileId, TRAVEL_PLAN_KEY, plan);
  const active = isTravelActive(plan, today);
  return okJson({
    已设置出行: { 城市: plan.city, 城市ID: plan.cityId, 开始: start, 结束: end },
    生效: active,
    说明: active
      ? "今天在出行窗口内：天气、空气质量、预警、每日简报与预警巡检将使用目的地"
      : `今天（${today}）不在出行窗口内，${start} 起自动生效；在此之前仍使用家位置`,
  });
}

async function currentAction(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const place = await resolveToolPlace(ctx, args.city as string | undefined);
  const loc = place.loc;
  const travel = place.travel === null ? {} : { 出行模式: travelModeField(place.travel) };
  const { host, key } = requireQweather(ctx);
  const cur = await currentWeather(ctx.db, host, key, loc);
  return okJson({ 城市: loc.city, ...travel, 天气: weatherTable(cur) });
}

async function forecastAction(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const place = await resolveToolPlace(ctx, args.city as string | undefined);
  const loc = place.loc;
  const travel = place.travel === null ? {} : { 出行模式: travelModeField(place.travel) };
  const { host, key } = requireQweather(ctx);
  const days = (args.days as number) === 3 ? 3 : 7;
  const list = await forecast(ctx.db, host, key, loc, days);
  return okJson({ 城市: loc.city, ...travel, 预报: forecastTable(list) });
}

async function alertAction(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const place = await resolveToolPlace(ctx, args.city as string | undefined);
  const loc = place.loc;
  const travel = place.travel === null ? {} : { 出行模式: travelModeField(place.travel) };
  const { host, key } = requireQweather(ctx);
  const list = await alerts(ctx.db, host, key, loc);
  if (list.length === 0) {
    const suffix = place.travel === null ? "" : `（${travelModeText(place.travel)}）`;
    return ok(`${loc.city}：当前无生效气象预警${suffix}`);
  }
  return okJson({ 城市: loc.city, ...travel, 预警: alertTable(list) });
}

async function locateAction(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const city = args.city as string | undefined;
  if (city === undefined || city.trim() === "") return fail("locate 需要 city 参数");
  const place = await resolveToolPlace(ctx, city);
  saveLocation(ctx.db, ctx.profileId, place.loc);
  const payload: Record<string, unknown> = {
    已设置位置: place.loc,
    说明: "该 Profile 后续天气查询与每日简报将使用此位置",
  };
  // locate 设置的始终是「家」的位置；出行生效期间查询仍走目的地，必须明确告知
  const state = readTravelPlan(ctx.db, ctx.profileId);
  if (state.kind === "plan" && isTravelActive(state.plan, todayIso())) {
    payload.出行模式提示 = "出行模式生效中，天气查询仍使用目的地，结束后自动恢复";
  }
  return okJson(payload);
}

/**
 * 分发（P2-20）：`action` 是规范名，`view` 是兼容别名。`set/clear/show` 属于 travel 组
 * （隐含 view=travel），所以 `{view:"travel", action:"set"}` 的既有写法不变；
 * 只给 `view:"travel"` 或 `action:"travel"` 时 travelOp 为 undefined，由 travelView 明确报错。
 * 必填项集中校验（只判缺失/纯空白），格式校验仍留在各分支。
 * 空气质量只有 airView 一份实现：weather 的 air 分支与独立工具 air_quality 都调它。
 */
const weatherDispatch = defineActionTool({
  viewAlias: true,
  conflictShowsGroup: true,
  actions: {
    current: { handler: currentAction },
    forecast: { handler: forecastAction },
    alert: { handler: alertAction },
    air: { handler: airView },
    locate: {
      requires: [{ field: "city", message: "locate 需要 city 参数" }],
      handler: locateAction,
    },
    travel: { handler: (args, ctx) => travelView(undefined, args, ctx) },
    set: {
      group: "travel",
      requires: [
        { field: "city", message: "设置出行计划需要 city 参数" },
        { field: "start", message: "设置出行计划需要合法的 start/end 日期（YYYY-MM-DD）" },
        { field: "end", message: "设置出行计划需要合法的 start/end 日期（YYYY-MM-DD）" },
      ],
      handler: (args, ctx) => travelView("set", args, ctx),
    },
    clear: { group: "travel", handler: (args, ctx) => travelView("clear", args, ctx) },
    show: { group: "travel", handler: (args, ctx) => travelView("show", args, ctx) },
  },
});

export async function weatherTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    return await weatherDispatch.handler(args, ctx);
  } catch (e) {
    return fail(errorMessage(e));
  }
}

registerModule({
  name: "weather",
  tools: [
    {
      name: "weather",
      description:
        "天气查询（QWeather）：action=current 实时天气；action=forecast 七天/三天预报；action=alert 气象预警；action=locate 设置该 Profile 的默认位置（city 参数，如 '上海'）；action=air 空气质量（国标）；action=travel 出行模式（action=set 需 city/start/end，action=clear 清除，action=show 查看）。action 为规范名，view 为兼容别名（两者等价；同时传且指向不同分支会报错）。city 参数可选，缺省按「出行计划（窗口内）> 已设置位置 > DEFAULT_CITY」解析。",
      inputSchema: {
        action: weatherDispatch
          .actionEnum()
          .optional()
          .describe(
            "分发（规范名）：current/forecast/alert/air/locate/travel；travel 另接受子操作 set/clear/show",
          ),
        view: z
          .enum(WEATHER_VIEWS)
          .optional()
          .describe("兼容别名，等价于 action；同时传且冲突会明确报错"),
        city: z.string().max(64).optional().describe("城市名；locate / travel set 时必填"),
        start: z.string().max(10).optional().describe("出行开始日期 YYYY-MM-DD；travel set 必填"),
        end: z.string().max(10).optional().describe("出行结束日期 YYYY-MM-DD；travel set 必填"),
        days: z
          .union([z.literal(3), z.literal(7)])
          .optional()
          .describe("预报天数，默认 7"),
      },
      handler: weatherTool,
    },
    {
      name: "air_quality",
      description:
        '空气质量（QWeather 国标 AQI/PM2.5/PM10），等价于 weather {action:"air"}（同一份实现，输出逐字一致）。city 可选，缺省按「出行计划（窗口内）> 已设置位置 > DEFAULT_CITY」解析。',
      inputSchema: {
        city: z.string().max(64).optional(),
      },
      handler: airView,
    },
  ],
  jobs: [
    {
      name: "daily_brief",
      cron: () => runtime().config.dailyBriefCron,
      handler: runDailyBrief,
    },
    {
      name: "alert_watch",
      cron: () => runtime().config.alertWatchCron,
      handler: runAlertWatch,
    },
    {
      // 晚报：cron 由 EVENING_BRIEF_CRON 配置（默认 "0 21 * * *"），与早报同一 config 口径
      name: "evening_brief",
      cron: () => runtime().config.eveningBriefCron,
      handler: runEveningBrief,
    },
  ],
});
