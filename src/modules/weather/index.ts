import { z } from "zod";
import { DateTime } from "luxon";
import { TZ, isDate, todayIso } from "../../time.js";
import {
  errorMessage,
  fail,
  ok,
  okJson,
  registerModule,
  runtime,
  type NotifyBlock,
  type ToolContext,
  type ToolResult,
} from "../../core/registry.js";
import { publishProfile } from "../../core/notify.js";
import type { DatabaseSync } from "node:sqlite";
import { dayType, holidayDayName, holidayPeriods, nextHolidayPeriod } from "../../core/holiday.js";
import { cachedLocation, currentWeather, saveLocation } from "../../core/qweather.js";
import type {
  AirQuality,
  CurrentWeather,
  ForecastDay,
  LocationInfo,
  WeatherAlert,
} from "../../core/qweather.js";
import { airQuality, alerts, forecast, geoLookup } from "../../core/qweather.js";
import { deleteSetting, getSetting, listProfiles, setSetting } from "../../core/settings.js";
import { logger } from "../../core/logger.js";

function requireQweather(ctx: ToolContext): { host: string; key: string } {
  if (ctx.config.qweatherHost === undefined || ctx.config.qweatherKey === undefined) {
    throw new Error("未配置 QWEATHER_API_HOST / QWEATHER_KEY，无法查询天气");
  }
  return { host: ctx.config.qweatherHost, key: ctx.config.qweatherKey };
}

/**
 * 出行计划（settings.travel_plan）：用户显式设置的行程，不是 GeoAPI 缓存。
 * 与 `weather locate` 保存的位置同理，只存解析后的城市/经纬度/城市 ID 与起止日历日
 * （含首尾），属用户主动配置；生效期间直接复用，绝不再请求 GeoAPI（版权/配额约束）。
 */
interface TravelPlan {
  city: string;
  cityId: string;
  lat: number;
  lon: number;
  start: string;
  end: string;
}

const TRAVEL_PLAN_KEY = "travel_plan";

type TravelPlanState = { kind: "none" } | { kind: "corrupt" } | { kind: "plan"; plan: TravelPlan };

/** MM-DD，用于简报里的紧凑日期区间 */
function shortDate(date: string): string {
  return date.slice(5);
}

/** 校验 settings 里的出行计划；字段缺失/类型不对/日期非法一律视为损坏（调用方安全忽略） */
function parseTravelPlan(raw: unknown): TravelPlan | null {
  if (typeof raw !== "object" || raw === null) return null;
  const p = raw as Record<string, unknown>;
  const city = typeof p.city === "string" ? p.city.trim() : "";
  const cityId = typeof p.cityId === "string" ? p.cityId.trim() : "";
  const lat = typeof p.lat === "number" ? p.lat : Number.NaN;
  const lon = typeof p.lon === "number" ? p.lon : Number.NaN;
  const start = typeof p.start === "string" ? p.start : "";
  const end = typeof p.end === "string" ? p.end : "";
  if (city === "" || cityId === "") return null;
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;
  if (!isDate(start) || !isDate(end) || start > end) return null;
  return { city, cityId, lat, lon, start, end };
}

function readTravelPlan(db: DatabaseSync, profileId: string): TravelPlanState {
  let raw: unknown;
  try {
    raw = getSetting<unknown>(db, profileId, TRAVEL_PLAN_KEY);
  } catch {
    // settings.value_json 不是合法 JSON：安全忽略，不能让简报/预警巡检整体失败
    return { kind: "corrupt" };
  }
  if (raw === undefined || raw === null) return { kind: "none" };
  const plan = parseTravelPlan(raw);
  return plan === null ? { kind: "corrupt" } : { kind: "plan", plan };
}

/** 出行计划是否在窗口内（本地日历日，含首尾） */
function isTravelActive(plan: TravelPlan, today: string): boolean {
  return plan.start <= today && today <= plan.end;
}

/** 本地日历日差（to - from）；两端都是本地零点，同一时区下为整数天 */
function calendarDaysBetween(from: string, to: string): number {
  const diff = DateTime.fromISO(to, { zone: TZ }).diff(
    DateTime.fromISO(from, { zone: TZ }),
    "days",
  );
  return Math.round(diff.days);
}

/** weather 回执里的出行模式标注：城市 + 起止日期 */
function travelModeField(plan: TravelPlan): { 城市: string; 起止: string } {
  return { 城市: plan.city, 起止: `${plan.start} ~ ${plan.end}` };
}

/** 简报/预警通知里的紧凑出行模式标注 */
function travelModeText(plan: TravelPlan): string {
  return `出行模式：${plan.city} ${shortDate(plan.start)}–${shortDate(plan.end)}`;
}

/** 简报表格行里的出行模式内容：城市（起–止） */
function travelModeBrief(plan: TravelPlan): string {
  return `${plan.city}（${shortDate(plan.start)}–${shortDate(plan.end)}）`;
}

interface ResolvedPlace {
  loc: LocationInfo;
  /** 生效中的出行计划；非 null 表示本次查询使用目的地（而不是家/默认城市） */
  travel: TravelPlan | null;
}

/**
 * 按 Profile 解析当前位置（简报与预警巡检共用，口径与工具查询一致）：
 * 窗口内 travel_plan > 已保存 location > DEFAULT_CITY。
 * travel_plan 直接复用保存的 lat/lon/cityId，**绝不**重新请求 GeoAPI。
 */
async function resolveProfilePlace(
  db: DatabaseSync,
  host: string,
  key: string,
  defaultCity: string,
  profileId: string,
  cityCache: Map<string, LocationInfo>,
): Promise<ResolvedPlace> {
  const state = readTravelPlan(db, profileId);
  if (state.kind === "plan" && isTravelActive(state.plan, todayIso())) {
    const plan = state.plan;
    return {
      loc: { city: plan.city, cityId: plan.cityId, lat: plan.lat, lon: plan.lon },
      travel: plan,
    };
  }
  const saved = cachedLocation(db, profileId);
  if (saved !== null) return { loc: saved, travel: null };
  const cached = cityCache.get(defaultCity);
  if (cached !== undefined) return { loc: cached, travel: null };
  const loc = await geoLookup(db, host, key, defaultCity);
  cityCache.set(defaultCity, loc);
  return { loc, travel: null };
}

/**
 * 工具侧的位置解析：显式 city 始终优先（即使出行模式生效），此时不标注出行模式；
 * 否则与简报同口径（窗口内出行计划 > 已保存位置 > DEFAULT_CITY）。
 */
async function resolveToolPlace(
  ctx: ToolContext,
  city: string | undefined,
): Promise<ResolvedPlace> {
  const { host, key } = requireQweather(ctx);
  if (city !== undefined && city.trim() !== "") {
    return { loc: await geoLookup(ctx.db, host, key, city), travel: null };
  }
  return resolveProfilePlace(
    ctx.db,
    host,
    key,
    ctx.config.defaultCity,
    ctx.profileId,
    new Map<string, LocationInfo>(),
  );
}

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

/** 预警起止时间（库内是 UTC ISO）→ 本地文本；缺失/非法原样保留或显示 — */
function alertLocalTime(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "—";
  const dt = DateTime.fromISO(iso, { zone: TZ });
  return dt.isValid ? dt.toFormat("yyyy-LL-dd HH:mm") : iso;
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

/** view=travel：出行计划的 set/clear/show（只写该 Profile 的 settings.travel_plan，不新增表） */
async function travelView(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const action = args.action;
  const today = todayIso();
  if (action === "show") {
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
  if (action === "clear") {
    deleteSetting(ctx.db, ctx.profileId, TRAVEL_PLAN_KEY);
    return ok("已清除出行模式");
  }
  if (action !== "set") return fail("travel 需要 action 参数（set/clear/show）");
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

export async function weatherTool(args: Record<string, unknown>, ctx: ToolContext) {
  try {
    const view = args.view as string;
    const city = args.city as string | undefined;
    if (view === "travel") return await travelView(args, ctx);
    if (view === "locate") {
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
    const place = await resolveToolPlace(ctx, city);
    const loc = place.loc;
    const travel = place.travel === null ? {} : { 出行模式: travelModeField(place.travel) };
    if (view === "current") {
      const { host, key } = requireQweather(ctx);
      const cur = await currentWeather(ctx.db, host, key, loc);
      return okJson({ 城市: loc.city, ...travel, 天气: weatherTable(cur) });
    }
    if (view === "forecast") {
      const { host, key } = requireQweather(ctx);
      const days = (args.days as number) === 3 ? 3 : 7;
      const list = await forecast(ctx.db, host, key, loc, days);
      return okJson({ 城市: loc.city, ...travel, 预报: forecastTable(list) });
    }
    if (view === "alert") {
      const { host, key } = requireQweather(ctx);
      const list = await alerts(ctx.db, host, key, loc);
      if (list.length === 0) {
        const suffix = place.travel === null ? "" : `（${travelModeText(place.travel)}）`;
        return ok(`${loc.city}：当前无生效气象预警${suffix}`);
      }
      return okJson({ 城市: loc.city, ...travel, 预警: alertTable(list) });
    }
    if (view === "air") {
      const { host, key } = requireQweather(ctx);
      const air = await airQuality(ctx.db, host, key, loc);
      return okJson({ 城市: loc.city, ...travel, 空气质量: airTable(air) });
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

/**
 * 简报「下个假期」行：未开始 → 倒计时；进行中 → 第几天；无数据 → 明确未知。
 * 口径完全来自 nextHolidayPeriod（与 holiday 工具同一套区间），不猜调休/假期。
 */
function nextHolidayText(db: DatabaseSync, today: string): string {
  const period = nextHolidayPeriod(db, today);
  if (period === null) return "未知（节假日数据未就绪）";
  if (period.inProgress) {
    const day = calendarDaysBetween(period.start, today) + 1;
    return `${period.name}（假期中，第 ${day}/${period.days} 天，至 ${shortDate(period.end)}）`;
  }
  const daysLeft = calendarDaysBetween(today, period.start);
  return `${period.name} ${shortDate(period.start)} 起，还有 ${daysLeft} 天（共 ${period.days} 天）`;
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
  const calendarToday = todayIso();
  for (const profileId of profiles) {
    try {
      // 与工具查询同一解析口径：窗口内出行计划 > 已保存位置 > DEFAULT_CITY。
      // saved location 直接复用（含显式选定时的 lat/lon/cityId）：按城市名重新 Geo 查询
      // 会重新取「第一个同名结果」，可能偏离用户选定的位置，也会多消耗 GeoAPI 配额。
      const place = await resolveProfilePlace(
        rt.db,
        host,
        key,
        rt.config.defaultCity,
        profileId,
        cityCache,
      );
      const loc = place.loc;
      const [cur, fc, air, alertList] = await Promise.all([
        currentWeather(rt.db, host, key, loc).catch(() => null),
        forecast(rt.db, host, key, loc, 7).catch(() => null),
        airQuality(rt.db, host, key, loc).catch(() => null),
        alerts(rt.db, host, key, loc).catch(() => null),
      ]);
      if (cur === null && fc === null) {
        logger.warn(`每日简报跳过 ${profileId}(${loc.city})：天气与预报均失败`);
        continue;
      }
      const rows: string[][] = [];
      // 出行模式显式标注（标题已用目的地城市，但必须让用户知道这不是「家」的天气）
      if (place.travel !== null) rows.push(["出行模式", travelModeBrief(place.travel)]);
      if (cur !== null) {
        rows.push(["天气", `${cur.text} ${cur.temp}°C（体感 ${cur.feelsLike}°C）`]);
        rows.push(["湿度/风速", `${cur.humidity}% / ${cur.windSpeed} km/h`]);
      }
      const today = fc?.[0];
      if (today !== undefined)
        rows.push(["今日气温", `${today.tMin}~${today.tMax}°C ${today.textDay}`]);
      if (air !== null) rows.push(["空气质量", `AQI ${air.aqi}（${air.category}）`]);
      rows.push(["下个假期", nextHolidayText(rt.db, calendarToday)]);
      rows.push([
        "预警",
        alertList === null
          ? "未知"
          : alertList.length === 0
            ? "无"
            : alertList.map(briefAlertText).join("；"),
      ]);

      const notes: string[] = [];
      const calendarNote = holidayNote(rt.db, calendarToday);
      if (calendarNote !== null) notes.push(calendarNote);
      // 有生效预警时绝不能落到「适宜出行」（预警在表格里、默认 note 却给出相反结论）。
      if (alertList !== null && alertList.length > 0) notes.push("有气象预警，注意防范");
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
        dedupeKey: `brief:${profileId}:${loc.city}:${calendarToday}`,
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
  // 同 alertLevelOf：不能用裸索引，`constructor` 会取到 Object 构造函数（非 number），
  // 阈值比较恒为 false，会让级别过滤静默失效。
  return Object.hasOwn(ALERT_LEVEL_RANK, key)
    ? (ALERT_LEVEL_RANK[key] as number)
    : UNKNOWN_LEVEL_RANK;
}

/** endsAt 已早于当前时刻的预警不再推送；无 endsAt 或解析失败时保留（不误杀）。 */
function isExpiredAlert(alert: WeatherAlert, nowMs: number): boolean {
  if (alert.endsAt === undefined) return false;
  const end = Date.parse(alert.endsAt);
  return Number.isFinite(end) && end < nowMs;
}

/**
 * 去重键：weather.alert:<内容键>:<级别>。内容键有 id 用 id、缺 id 回退到标题（不同预警
 * 不能共用空串相互覆盖）。同一预警同级别只推一次；级别升级会得到新键而再推一次。
 */
const ALERT_DEDUPE_PREFIX = "weather.alert:";

/** 同一预警的内容键：有 id 用 id，缺 id 回退到 `title:<标题>`（与去重键一一对应） */
function alertContentKey(alert: WeatherAlert): string {
  const id = alert.id.trim();
  return id === "" ? `title:${alert.title.trim()}` : id;
}

function alertDedupeKey(alert: WeatherAlert): string {
  return `${ALERT_DEDUPE_PREFIX}${alertContentKey(alert)}:${alert.level.trim()}`;
}

/**
 * 从已落库的去重键还原「内容键 + 级别」；非本类键返回 null。
 * 级别恒在最后一个冒号之后（色名不含冒号），内容键本身可能含冒号（标题回退）。
 */
function parseAlertDedupeKey(key: string): { contentKey: string; level: string } | null {
  if (!key.startsWith(ALERT_DEDUPE_PREFIX)) return null;
  const rest = key.slice(ALERT_DEDUPE_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  if (cut < 0) return null;
  return { contentKey: rest.slice(0, cut), level: rest.slice(cut + 1) };
}

/**
 * 各预警内容键「已推送过的最高级别」。级别降级不重推的依据：去重键含 level，若不查历史，
 * orange→yellow 也会得到新键再推一次，与「只有级别升级才再推」的口径不符。
 * 回看 30 天：既要覆盖持续数天的长预警（24h 窗口会让降级在窗口外漏判），
 * 又要避免用极远古的同 id 记录误压当前预警。空级别（未知，按最高优先级处理）
 * 不纳入历史，否则会误压后续真实级别。
 */
function notifiedAlertRanks(db: DatabaseSync, profileId: string): Map<string, number> {
  const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
  const rows = db
    .prepare(
      "SELECT dedupe_key FROM notifications WHERE profile_id = ? AND kind = 'weather.alert' AND dedupe_key IS NOT NULL AND created_at >= ?",
    )
    .all(profileId, since) as { dedupe_key: string }[];
  const ranks = new Map<string, number>();
  for (const { dedupe_key } of rows) {
    const parsed = parseAlertDedupeKey(dedupe_key);
    if (parsed === null || parsed.level === "") continue;
    const rank = levelRank(parsed.level);
    ranks.set(parsed.contentKey, Math.max(ranks.get(parsed.contentKey) ?? 0, rank));
  }
  return ranks;
}

function alertTitle(alert: WeatherAlert): string {
  const level = alert.level.trim();
  return level === "" ? `⚠️ 气象预警：${alert.type}` : `⚠️ 气象预警：${alert.type} ${level}`;
}

function alertBlocks(alert: WeatherAlert, travel: TravelPlan | null): NotifyBlock {
  return {
    table: {
      columns: ["级别", "类型", "生效", "失效", "说明"],
      rows: [
        [
          alert.level.trim() || "—",
          alert.type,
          alertLocalTime(alert.startsAt),
          alertLocalTime(alert.endsAt),
          alert.description,
        ],
      ],
    },
    // 出行模式生效时预警来自目的地，通知必须标注，避免用户误以为是在家乡
    ...(travel === null ? {} : { notes: [travelModeText(travel)] }),
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
      // 与每日简报同口径：窗口内出行计划 > 已保存位置 > DEFAULT_CITY。
      const place = await resolveProfilePlace(
        rt.db,
        host,
        key,
        rt.config.defaultCity,
        profileId,
        cityCache,
      );
      const loc = place.loc;
      const list = await alerts(rt.db, host, key, loc);
      const notified = notifiedAlertRanks(rt.db, profileId);
      for (const alert of list) {
        try {
          if (isExpiredAlert(alert, nowMs)) continue;
          const currentRank = levelRank(alert.level);
          if (currentRank < minRank) continue;
          const contentKey = alertContentKey(alert);
          const previousRank = notified.get(contentKey);
          // 级别降级不再重推：去重键含级别，不比较历史的话 orange→yellow 也会再推一次，
          // 与 README/SKILL「只有级别升级才再推」的口径不符（同级别仍由去重键兜底）。
          if (previousRank !== undefined && previousRank > currentRank) continue;
          await publishProfile(rt.db, rt.config, profileId, {
            kind: "weather.alert",
            title: alertTitle(alert),
            blocks: alertBlocks(alert, place.travel),
            dedupeKey: alertDedupeKey(alert),
            // 预警失效时刻即投递截止：静默时段结束后不再补投已失效的预警
            expiresAt: alert.endsAt,
          });
          // 空级别不纳入历史（未知按最高优先级处理，纳入会误压后续真实级别）
          if (alert.level.trim() !== "") {
            notified.set(contentKey, Math.max(previousRank ?? 0, currentRank));
          }
        } catch (e) {
          // 逐条隔离：一条坏预警只损失它自己，不能让同批其余预警一起丢
          logger.warn(`气象预警处理失败（跳过该条，不影响其余）: ${errorMessage(e)}`);
        }
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
        "天气查询（QWeather）：view=current 实时天气；view=forecast 七天/三天预报；view=alert 气象预警；view=locate 设置该 Profile 的默认位置（city 参数，如 '上海'）；view=air 空气质量（国标）；view=travel 出行模式（action=set 需 city/start/end，action=clear 清除，action=show 查看）。city 参数可选，缺省按「出行计划（窗口内）> 已设置位置 > DEFAULT_CITY」解析。",
      inputSchema: {
        view: z.enum(["current", "forecast", "alert", "air", "locate", "travel"]),
        action: z.enum(["set", "clear", "show"]).optional().describe("view=travel 的操作"),
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
        "空气质量（QWeather 国标 AQI/PM2.5/PM10）。city 可选，缺省按「出行计划（窗口内）> 已设置位置 > DEFAULT_CITY」解析。",
      inputSchema: {
        city: z.string().max(64).optional(),
      },
      handler: async (args, ctx) => {
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
