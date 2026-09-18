import { z } from "zod";
import { todayIso } from "../../time.js";
import {
  errorMessage,
  fail,
  ok,
  okJson,
  registerModule,
  runtime,
  type ToolContext,
} from "../../core/registry.js";
import { publishProfile } from "../../core/notify.js";
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
            : alertList.map((a) => `${a.level}${a.type}`).join("；"),
      ]);

      const notes: string[] = [];
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
  ],
});
