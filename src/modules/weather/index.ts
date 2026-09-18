import { z } from "zod";
import { DateTime } from "luxon";
import { TZ, todayIso } from "../../time.js";
import {
  errorMessage,
  fail,
  ok,
  okJson,
  registerModule,
  runtime,
  type NotifyBlock,
  type ToolContext,
} from "../../core/registry.js";
import { publishProfile } from "../../core/notify.js";
import type { DatabaseSync } from "node:sqlite";
import { dayType, holidayDayName, holidayPeriods } from "../../core/holiday.js";
import { cachedLocation, currentWeather, saveLocation } from "../../core/qweather.js";
import type {
  AirQuality,
  CurrentWeather,
  ForecastDay,
  LocationInfo,
  WeatherAlert,
} from "../../core/qweather.js";
import { airQuality, alerts, forecast, geoLookup } from "../../core/qweather.js";
import { listProfiles } from "../../core/settings.js";
import { logger } from "../../core/logger.js";

function requireQweather(ctx: ToolContext): { host: string; key: string } {
  if (ctx.config.qweatherHost === undefined || ctx.config.qweatherKey === undefined) {
    throw new Error("未配置 QWEATHER_API_HOST / QWEATHER_KEY，无法查询天气");
  }
  return { host: ctx.config.qweatherHost, key: ctx.config.qweatherKey };
}

async function resolveLocation(ctx: ToolContext, city: string | undefined): Promise<LocationInfo> {
  const { host, key } = requireQweather(ctx);
  if (city !== undefined && city.trim() !== "") return geoLookup(ctx.db, host, key, city);
  const saved = cachedLocation(ctx.db, ctx.profileId);
  if (saved !== null) return saved;
  return geoLookup(ctx.db, host, key, ctx.config.defaultCity);
}

function weatherTable(cur: CurrentWeather): { columns: string[]; rows: string[][] } {
  return {
    columns: ["项目", "内容"],
    rows: [
      ["天气", cur.text],
      ["气温", `${cur.temp}°C（体感 ${cur.feelsLike}°C）`],
      ["湿度", `${cur.humidity}%`],
      ["风速", `${cur.windSpeed} km/h`],
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
    columns: ["级别", "类型", "内容"],
    rows: list.map((a) => [a.level || "—", a.type, a.description]),
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

export async function weatherTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    const view = args.view as string;
    const city = args.city as string | undefined;
    if (view === "locate") {
      if (city === undefined || city.trim() === "") return fail("locate 需要 city 参数");
      const loc = await resolveLocation(ctx, city);
      saveLocation(ctx.db, ctx.profileId, loc);
      return okJson({ 已设置位置: loc, 说明: "该 Profile 后续天气查询与每日简报将使用此位置" });
    }
    const loc = await resolveLocation(ctx, city);
    if (view === "current") {
      const { host, key } = requireQweather(ctx);
      const cur = await currentWeather(ctx.db, host, key, loc);
      return okJson({ 城市: loc.city, 天气: weatherTable(cur) });
    }
    if (view === "forecast") {
      const { host, key } = requireQweather(ctx);
      const days = (args.days as number) === 3 ? 3 : 7;
      const list = await forecast(ctx.db, host, key, loc, days);
      return okJson({ 城市: loc.city, 预报: forecastTable(list) });
    }
    if (view === "alert") {
      const { host, key } = requireQweather(ctx);
      const list = await alerts(ctx.db, host, key, loc);
      if (list.length === 0) return ok(`${loc.city}：当前无生效气象预警`);
      return okJson({ 城市: loc.city, 预警: alertTable(list) });
    }
    if (view === "air") {
      const { host, key } = requireQweather(ctx);
      const air = await airQuality(ctx.db, host, key, loc);
      return okJson({ 城市: loc.city, 空气质量: airTable(air) });
    }
    return fail(`未知 view: ${view}`);
  } catch (e) {
    return fail(errorMessage(e));
  }
}

/** 简报里的紧凑时刻；无法解析时返回空串，由调用方决定省略 */
function compactInstant(iso: string | undefined): string {
  if (iso === undefined) return "";
  const dt = DateTime.fromISO(iso, { zone: TZ });
  return dt.isValid ? dt.toFormat("MM-dd HH:mm") : "";
}

/** 简报预警描述：级别 + 类型 + 起止时间（时间缺失时省略括号，避免出现空括号） */
function briefAlertText(alert: WeatherAlert): string {
  const start = compactInstant(alert.startsAt);
  const end = compactInstant(alert.endsAt);
  if (start === "" && end === "") return `${alert.level}${alert.type}`;
  return `${alert.level}${alert.type}（${start || "?"}–${end || "?"}）`;
}

/** MM-DD，用于简报里的紧凑日期区间 */
function shortDate(date: string): string {
  return date.slice(5);
}

/**
 * 简报的「补班/放假」提示行：今天补班 → 明天补班 → 明天开始放假，按序取首个命中。
 * 都不命中返回 null（保持简报简洁）；节假日数据 unknown 时同样返回 null，绝不猜测。
 */
function holidayNote(db: DatabaseSync, today: string): string | null {
  const todayType = dayType(db, today);
  if (todayType === "unknown") return null;
  if (todayType === "workday") {
    const name = holidayDayName(db, today);
    if (name !== null) return `⚠️ 今天要补班（${name}调休）`;
  }
  const tomorrow = DateTime.fromISO(today, { zone: TZ }).plus({ days: 1 }).toISODate();
  if (tomorrow === null) return null;
  const tomorrowType = dayType(db, tomorrow);
  if (tomorrowType === "workday") {
    const name = holidayDayName(db, tomorrow);
    if (name !== null) return `⚠️ 明天要补班（${name}调休）`;
  }
  if (tomorrowType === "holiday") {
    const period = holidayPeriods(db).find((candidate) => candidate.start === tomorrow);
    if (period !== undefined) {
      return `🎉 明天开始放假（${period.name}，${shortDate(period.start)}–${shortDate(period.end)}，共 ${period.days} 天）`;
    }
  }
  return null;
}

/** 每日简报：确定性组装，无 LLM；单边数据失败用另一侧，全部失败不发送 */
export async function runDailyBrief(): Promise<void> {
  const rt = runtime();
  if (rt.config.qweatherHost === undefined || rt.config.qweatherKey === undefined) {
    logger.warn("每日简报跳过：未配置 QWeather");
    return;
  }
  const host = rt.config.qweatherHost;
  const key = rt.config.qweatherKey;
  // 覆盖所有已知 Profile，而不只是配置了推送路由的：publishProfile 明确「即使无路由
  // 也保留，供 notify.pull 兜底」，只发给有路由的 Profile 会让纯 pull 型 Profile
  // 永远收不到简报。
  const profiles = listProfiles(rt.db);
  const cityCache = new Map<string, LocationInfo>();
  for (const profileId of profiles) {
    try {
      const saved = cachedLocation(rt.db, profileId);
      const city = saved?.city ?? rt.config.defaultCity;
      let loc = cityCache.get(city);
      if (loc === undefined) {
        loc = await geoLookup(rt.db, host, key, city);
        cityCache.set(city, loc);
      }
      const [cur, fc, air, alertList] = await Promise.all([
        currentWeather(rt.db, host, key, loc).catch(() => null),
        forecast(rt.db, host, key, loc, 7).catch(() => null),
        airQuality(rt.db, host, key, loc).catch(() => null),
        alerts(rt.db, host, key, loc).catch(() => null),
      ]);
      if (cur === null && fc === null) {
        logger.warn(`每日简报跳过 ${profileId}(${city})：天气与预报均失败`);
        continue;
      }
      const rows: string[][] = [];
      if (cur !== null) {
        rows.push(["天气", `${cur.text} ${cur.temp}°C（体感 ${cur.feelsLike}°C）`]);
        rows.push(["湿度/风速", `${cur.humidity}% / ${cur.windSpeed} km/h`]);
      }
      const today = fc?.[0];
      if (today !== undefined)
        rows.push(["今日气温", `${today.tMin}~${today.tMax}°C ${today.textDay}`]);
      if (air !== null) rows.push(["空气质量", `AQI ${air.aqi}（${air.category}）`]);
      rows.push([
        "预警",
        alertList === null
          ? "未知"
          : alertList.length === 0
            ? "无"
            : alertList.map(briefAlertText).join("；"),
      ]);

      const notes: string[] = [];
      const calendarNote = holidayNote(rt.db, todayIso());
      if (calendarNote !== null) notes.push(calendarNote);
      if (today !== undefined && today.precipMm !== undefined && today.precipMm > 0)
        notes.push("今日有降水，出门带伞");
      if (today !== undefined && today.tMax - today.tMin >= 10)
        notes.push("昼夜温差较大，注意增减衣物");
      if (air !== null && air.aqi > 100) notes.push("空气质量较差，敏感人群减少户外活动");
      if (notes.length === 0) notes.push("适宜出行");

      await publishProfile(rt.db, rt.config, profileId, {
        kind: "weather.brief",
        title: `${loc.city} 每日简报`,
        blocks: { table: { columns: ["项目", "内容"], rows }, notes },
        dedupeKey: `brief:${profileId}:${loc.city}:${todayIso()}`,
      });
    } catch (e) {
      logger.error(`每日简报失败 ${profileId}: ${errorMessage(e)}`);
    }
  }
}

/**
 * 预警级别 → 序号（越大越严重）。上游 level 既可能是中文色名（qweather 客户端已把英文
 * 色名转成中文），也可能直接是英文色名，两种都认。
 */
const ALERT_LEVEL_RANK: Record<string, number> = {
  blue: 1,
  蓝: 1,
  蓝色: 1,
  yellow: 2,
  黄: 2,
  黄色: 2,
  orange: 3,
  橙: 3,
  橙色: 3,
  red: 4,
  红: 4,
  红色: 4,
};

/**
 * 无法识别的级别（含空串）按最高优先级处理：宁可多推，不可漏推。
 */
const UNKNOWN_LEVEL_RANK = 5;

function levelRank(level: string): number {
  const key = level.trim().toLowerCase();
  if (key === "") return UNKNOWN_LEVEL_RANK;
  return ALERT_LEVEL_RANK[key] ?? UNKNOWN_LEVEL_RANK;
}

/** endsAt 已早于当前时刻的预警不再推送；无 endsAt 或解析失败时保留（不误杀）。 */
function isExpiredAlert(alert: WeatherAlert, nowMs: number): boolean {
  if (alert.endsAt === undefined) return false;
  const end = Date.parse(alert.endsAt);
  return Number.isFinite(end) && end < nowMs;
}

/**
 * 去重键：weather.alert:<id>:<级别>。同一预警同级别只推一次；级别升级会得到新键而再推一次。
 * id 缺失时不能退化成空串（不同预警会共用一个键相互覆盖），改用标题构造稳定串。
 */
function alertDedupeKey(alert: WeatherAlert): string {
  const level = alert.level.trim();
  const id = alert.id.trim();
  return id === ""
    ? `weather.alert:title:${alert.title.trim()}:${level}`
    : `weather.alert:${id}:${level}`;
}

function alertTitle(alert: WeatherAlert): string {
  const level = alert.level.trim();
  return level === "" ? `⚠️ 气象预警：${alert.type}` : `⚠️ 气象预警：${alert.type} ${level}`;
}

function alertBlocks(alert: WeatherAlert): NotifyBlock {
  return {
    table: {
      columns: ["级别", "类型", "生效", "失效", "说明"],
      rows: [
        [
          alert.level.trim() || "—",
          alert.type,
          alert.startsAt ?? "—",
          alert.endsAt ?? "—",
          alert.description,
        ],
      ],
    },
  };
}

/**
 * 气象预警巡检：为每个 Profile（与每日简报同为 listProfiles 口径）检查其位置的生效预警，
 * 命中即推。走普通通知路径（publishProfile）——静默时段由投递层照常拦截，这里不做任何绕过。
 * 单个 Profile 失败只记日志，不影响其它 Profile，也不让 job 抛出。
 */
export async function runAlertWatch(): Promise<void> {
  const rt = runtime();
  if (rt.config.qweatherHost === undefined || rt.config.qweatherKey === undefined) {
    logger.warn("气象预警巡检跳过：未配置 QWeather");
    return;
  }
  const host = rt.config.qweatherHost;
  const key = rt.config.qweatherKey;
  const minRank = ALERT_LEVEL_RANK[rt.config.alertMinLevel] ?? 1;
  const nowMs = Date.now();
  const cityCache = new Map<string, LocationInfo>();
  for (const profileId of listProfiles(rt.db)) {
    try {
      const city = cachedLocation(rt.db, profileId)?.city ?? rt.config.defaultCity;
      let loc = cityCache.get(city);
      if (loc === undefined) {
        loc = await geoLookup(rt.db, host, key, city);
        cityCache.set(city, loc);
      }
      const list = await alerts(rt.db, host, key, loc);
      for (const alert of list) {
        if (isExpiredAlert(alert, nowMs)) continue;
        if (levelRank(alert.level) < minRank) continue;
        await publishProfile(rt.db, rt.config, profileId, {
          kind: "weather.alert",
          title: alertTitle(alert),
          blocks: alertBlocks(alert),
          dedupeKey: alertDedupeKey(alert),
          // 预警失效时刻即投递截止：静默时段结束后不再补投已失效的预警
          expiresAt: alert.endsAt,
        });
      }
    } catch (e) {
      logger.warn(`气象预警巡检失败 ${profileId}: ${errorMessage(e)}`);
    }
  }
}

registerModule({
  name: "weather",
  tools: [
    {
      name: "weather",
      description:
        "天气查询（QWeather）：view=current 实时天气；view=forecast 七天/三天预报；view=alert 气象预警；view=locate 设置该 Profile 的默认位置（city 参数，如 '上海'）；view=air 空气质量（国标）。city 参数可选，缺省用已设置位置或 DEFAULT_CITY。",
      inputSchema: {
        view: z.enum(["current", "forecast", "alert", "air", "locate"]),
        city: z.string().max(64).optional().describe("城市名；locate 时必填"),
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
        "空气质量（QWeather 国标 AQI/PM2.5/PM10）。city 可选，缺省用已设置位置或 DEFAULT_CITY。",
      inputSchema: {
        city: z.string().max(64).optional(),
      },
      handler: async (args, ctx) => {
        try {
          const loc = await resolveLocation(ctx, args.city as string | undefined);
          const { host, key } = requireQweather(ctx);
          const air = await airQuality(ctx.db, host, key, loc);
          return okJson({ 城市: loc.city, 空气质量: airTable(air) });
        } catch (e) {
          return fail(errorMessage(e));
        }
      },
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
  ],
});
