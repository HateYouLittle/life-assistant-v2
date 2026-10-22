import { z } from "zod";
import { DateTime } from "luxon";
import { TZ, isDate, localToInstant, now, todayIso } from "../../time.js";
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
import { deleteSetting, listProfiles, readSetting, setSetting } from "../../core/settings.js";
import { logger } from "../../core/logger.js";
import type { ResolvedConfig } from "../../config.js";
import { agendaForDate, type AgendaItem } from "../schedule/service.js";

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
  // 用 readSetting 而不是 getSetting：坏 JSON 已被 settings 层防御成 undefined，
  // 只有 readSetting 能区分「没设置」与「写了但损坏」——后者要提示用户重设/清除，
  // 若混同成 none，`travel show` 会静默返回 null，看起来像出行计划自己消失了。
  const state = readSetting<unknown>(db, profileId, TRAVEL_PLAN_KEY);
  if (state.kind === "corrupt") return { kind: "corrupt" };
  if (state.kind === "missing" || state.value === undefined || state.value === null) {
    return { kind: "none" };
  }
  const plan = parseTravelPlan(state.value);
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

/** 本地日历日 + n 天；解析失败返回 null（调用方跳过依赖该日期的块，绝不猜日期） */
function addDays(date: string, days: number): string | null {
  return DateTime.fromISO(date, { zone: TZ }).plus({ days }).toISODate();
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
 *
 * `today` = 判断出行计划是否生效所用的本地日历日：工具/预警巡检传当前日；简报按
 * `at` 锚定的业务日传（启动补发跨午夜时，「原定触发那天」的行程才是对的）。
 */
async function resolveProfilePlace(
  db: DatabaseSync,
  host: string,
  key: string,
  defaultCity: string,
  profileId: string,
  cityCache: Map<string, LocationInfo>,
  today: string = todayIso(),
): Promise<ResolvedPlace> {
  const state = readTravelPlan(db, profileId);
  if (state.kind === "plan" && isTravelActive(state.plan, today)) {
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
 * 简报的「补班/放假」提示行：明天补班 → 明天开始放假，按序取首个命中。
 * 都不命中返回 null（保持简报简洁）；节假日数据 unknown 时同样返回 null，绝不猜测。
 *
 * **当天的补班不在这里提示**：补班提醒的单一来源是 holiday 模块的 `holiday.workday`
 * 独立推送（`workday_watch`）。两个 job 默认同为 07:00，触发先后由注册顺序决定 ——
 * 如果早报也写一行，用户就会收到「早报里一行 + 独立通知」的两条同义推送（真实库
 * 2026-09-19、2026-10-09 各出现过）。把当天补班交给 holiday 模块后，无论两个 cron
 * 谁先跑都不会重复。这里保留的「明天」前瞻提醒时间上不与当天独立通知重叠。
 */
function holidayNote(db: DatabaseSync, today: string): string | null {
  // 今天的数据未知时不猜：连「明天是否补班」也宁可不说，避免在不可信的年份数据上给结论
  if (dayType(db, today) === "unknown") return null;
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

/**
 * 预警缓存 TTL 与巡检间隔对齐（P1-9）。
 *
 * 预警巡检默认 `*\/20 * * * *`，而 qweather.alerts 固定 10 分钟 TTL：每 20 分钟一轮里
 * 上一轮写入的缓存早已过期，各地每轮都要重新出网 —— 上游请求量被放大约 3 倍
 * （真实用量采样 76–84 次/日，占 QWeather 配额的大头）。这里把 TTL 取
 * 「巡检间隔 + 30s 余量」：下一轮巡检必定落在缓存有效期内；30s 余量用于容忍
 * cron 触发/响应落地比整点略晚，否则同一轮可能刚好在过期瞬间穿透缓存。
 *
 * 复杂表达式（固定时刻、小时段等）的实际间隔无法静态推导，回退 15 分钟：
 * 宁可多花一点配额，也不能把 TTL 算短 —— 算短才是真正放大请求。
 * `* * * * *` 单独返回 90s（下一轮 60s 后触发，同样留 30s 余量）。
 */
export function alertCacheTtlMs(config: Pick<ResolvedConfig, "alertWatchCron">): number {
  const cron = config.alertWatchCron.trim();
  if (cron === "* * * * *") return 90_000;
  // 只认「分钟位为 `*\/N`、其余四位为 `*`」的严格形态：混合写法（如 `*\/20 8-20 * * *`）
  // 的间隔随小时变化，静态推导会给出偏小的 TTL，反而放大请求。
  const everyMinutes = /^\*\/(\d+) \* \* \* \*$/.exec(cron);
  if (everyMinutes !== null) {
    const n = Number(everyMinutes[1]);
    // 分钟位合法范围是 1..59；0/越界是配置层不该放行的值，回退而不是抛错。
    if (Number.isInteger(n) && n >= 1 && n <= 59) return n * 60_000 + 30_000;
  }
  return 15 * 60_000;
}

/** 日程块最多列出的条数；超出只报「另有 N 项」，避免一条通知被日程撑爆 */
const AGENDA_LIMIT = 6;

/** 日程条目的紧凑文本：全天日程不给时刻，其余给本地时刻（与日程工具口径一致） */
function agendaItemText(item: AgendaItem): string {
  return item.all_day ? `全天 ${item.title}` : `${item.time} ${item.title}`;
}

/**
 * 逾期标注（按本地日历日）。event_date 是「该次发生的日期」；今天到期但已过时刻的
 * 待办会算出 0 天，此时不写「逾期 0 天」这种没有信息量的文案。
 */
function overdueLabel(item: AgendaItem, today: string): string {
  const days = calendarDaysBetween(item.event_date, today);
  return days >= 1 ? `（逾期 ${days} 天）` : "（已逾期）";
}

/** 单条日程文本（逾期项带标注） */
function agendaItemLabel(item: AgendaItem, today: string): string {
  return `${agendaItemText(item)}${item.overdue ? overdueLabel(item, today) : ""}`;
}

/**
 * 日程排序：逾期项一律在前 —— 早报的价值是「今天做什么 + 欠了什么」，
 * 逾期项被截断在 6 条之外会让人误以为没有欠账。组内保持 agendaForDate 的
 * 时间升序（Array#sort 稳定）；逾期组再按发生日期从早到晚，最久的欠账先亮相。
 */
function compareAgendaItems(a: AgendaItem, b: AgendaItem): number {
  if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
  if (a.overdue && a.event_date !== b.event_date) return a.event_date < b.event_date ? -1 : 1;
  return 0;
}

/** 日程条目拼成一段文本：最多 limit 条，超出附「…另有 N 项」 */
function agendaListText(
  items: AgendaItem[],
  label: (item: AgendaItem) => string,
  limit = AGENDA_LIMIT,
): string {
  const sorted = [...items].sort(compareAgendaItems);
  const shown = sorted.slice(0, limit);
  const hidden = sorted.length - shown.length;
  const parts = shown.map((item) => label(item));
  if (hidden > 0) parts.push(`…另有 ${hidden} 项`);
  return parts.join("；");
}

/**
 * 「今日未完成」条目文本（晚报用）：今天到期的项只列时刻/标题 —— 21:00 的晚报里
 * 今天 23:00 的事还没到期，标「已逾期」是错的；更早的欠账才标逾期天数。
 */
function incompleteItemLabel(item: AgendaItem, today: string): string {
  const days = calendarDaysBetween(item.event_date, today);
  return days >= 1 ? `${agendaItemText(item)}（逾期 ${days} 天）` : agendaItemText(item);
}

/**
 * 早报日程块的 notes 行：一条 `今日日程：…` + 有逾期时的数量行。
 * 没有任何条目时仍给 `今日日程：无`（明确「今天没事」，而不是让用户以为简报漏了）。
 */
function agendaNotes(items: AgendaItem[], today: string, emptyText: string): string[] {
  if (items.length === 0) return [emptyText];
  const lines = [`今日日程：${agendaListText(items, (item) => agendaItemLabel(item, today))}`];
  // 逾期数量单独一行：即使逾期项本身被 6 条上限截掉，用户也能看到欠了多少；
  // 也覆盖「今天没有日程、但仍有逾期」的情况（上面那行此时全是逾期项）。
  const overdueCount = items.filter((item) => item.overdue).length;
  if (overdueCount > 0) lines.push(`逾期未完成：${overdueCount} 项`);
  return lines;
}

/**
 * 早报日程块：schedule 模块的只读查询失败时只跳过该块（logger.warn），
 * 绝不让整份早报失败 —— 气象是主内容，日程是增强，缺一块也不能让用户早上收不到简报。
 */
function appendAgendaNotes(
  notes: string[],
  db: DatabaseSync,
  profileId: string,
  today: string,
): void {
  try {
    notes.push(...agendaNotes(agendaForDate(db, profileId, today), today, "今日日程：无"));
  } catch (e) {
    logger.warn(`每日简报：今日日程块已跳过（${profileId}）: ${errorMessage(e)}`);
  }
}

/**
 * 每日简报：确定性组装，无 LLM；单边数据失败用另一侧，全部失败不发送。
 *
 * `at` = 这次运行对应的**参考时刻**：cron/手动调用传当前时刻（缺省 now()），
 * 启动补发则传「错过的那次原定触发时刻」。`DAILY_BRIEF_CRON` 是可配置项，配到 18:00
 * 之后时 6 小时补发窗口会跨午夜：若仍按 now() 取业务日，凌晨补发会写入「新一天」的
 * dedupeKey 并吞掉当晚的正常简报（与 B1 是同一缺陷的另一半）。
 */
export async function runDailyBrief(at?: DateTime): Promise<void> {
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
  // 业务日锚定参考时刻：简报里的「今日日程/下个假期/假期提示」与 dedupeKey 都用它。
  const calendarToday = (at ?? now()).toISODate() ?? todayIso();
  // 预警缓存与巡检间隔对齐（P1-9）：早报与巡检共用同一缓存键，若这里按固定 10 分钟
  // 写缓存，会让随后那一轮巡检重新出网；用同一个 TTL 口径让两次自动查询共享结果。
  const alertTtlMs = alertCacheTtlMs(rt.config);
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
        calendarToday,
      );
      const loc = place.loc;
      const [cur, fc, air, alertList] = await Promise.all([
        currentWeather(rt.db, host, key, loc).catch(() => null),
        forecast(rt.db, host, key, loc, 7).catch(() => null),
        airQuality(rt.db, host, key, loc).catch(() => null),
        alerts(rt.db, host, key, loc, alertTtlMs).catch(() => null),
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
      // 日程块放在天气结论之后：既不能挤掉「适宜出行」的兜底 note，
      // 也保证日程查询失败时早报只剩天气、照常发送。
      appendAgendaNotes(notes, rt.db, profileId, calendarToday);

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
  const alertTtlMs = alertCacheTtlMs(rt.config);
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
      const list = await alerts(rt.db, host, key, loc, alertTtlMs);
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

/**
 * 晚报「明天」提示：补班/法定假日，措辞与早报一致（`明天要补班（X调休）` /
 * `明天休息（国庆节）`）。节假日数据 unknown 时不猜 —— 宁可不说，也不能凭星期猜调休。
 */
function eveningHolidayNote(db: DatabaseSync, tomorrow: string): string | null {
  const type = dayType(db, tomorrow);
  if (type === "unknown") return null;
  if (type === "workday") {
    const name = holidayDayName(db, tomorrow);
    return name === null ? null : `⚠️ 明天要补班（${name}调休）`;
  }
  if (type === "holiday") {
    const name = holidayDayName(db, tomorrow);
    return name === null ? "🎉 明天休息" : `🎉 明天休息（${name}）`;
  }
  // weekend / weekday 不额外提示：不是异常安排，加进晚报只会变成噪音
  return null;
}

/**
 * 晚报内容：明日天气 + 明日日程 + 今天没做完的事 + 明天是否补班/假期。
 * 天气与日程各自隔离：任一取数失败只把对应内容写成「未知」，另一侧照常送达 ——
 * 睡前信息里日程和补班同样重要，不能因为 QWeather 抖动就把整条晚报丢掉。
 */
async function eveningBriefBlocks(
  db: DatabaseSync,
  host: string,
  key: string,
  defaultCity: string,
  profileId: string,
  today: string,
  tomorrow: string,
  cityCache: Map<string, LocationInfo>,
): Promise<NotifyBlock> {
  const rows: string[][] = [];
  const notes: string[] = [];
  let travel: TravelPlan | null = null;
  let weatherText = "未知";
  try {
    // 与早报同一解析口径：窗口内出行计划 > 已保存位置 > DEFAULT_CITY（含出行模式标注）。
    // 出行计划的生效判定同样用本次运行的业务日（补发跨午夜时按原定触发那天算）。
    const place = await resolveProfilePlace(
      db,
      host,
      key,
      defaultCity,
      profileId,
      cityCache,
      today,
    );
    travel = place.travel;
    const list = await forecast(db, host, key, place.loc, 7);
    // 「第 2 天」按日期匹配而不是按下标取：上游跨零点/少返回一天时下标会错位；
    // 匹配不到再退回下标 1（QWeather 首行固定是今天）。
    const day = list.find((candidate) => candidate.date === tomorrow) ?? list[1];
    if (day !== undefined) {
      weatherText = `${day.textDay} ${day.tMin}~${day.tMax}°C`;
      if (day.precipMm !== undefined && day.precipMm > 0) notes.push("明天有降水，出门带伞");
      if (day.tMax - day.tMin >= 10) notes.push("明天昼夜温差较大，注意增减衣物");
    }
  } catch (e) {
    logger.warn(`晚报：明日天气获取失败（${profileId}），写未知: ${errorMessage(e)}`);
  }
  // 出行模式放第一行：标题不带城市，用户必须知道明天看到的是目的地还是家
  if (travel !== null) rows.push(["出行模式", travelModeBrief(travel)]);
  rows.push(["明日天气", weatherText]);

  let tomorrowItems: AgendaItem[] | null = null;
  let incompleteItems: AgendaItem[] | null = null;
  try {
    // agendaForDate(明天) 同时给出明天的日程与「今天及更早没做完」的条目：
    // 明天日程按 event_date 命中，逾期项单独成行（晚报告诉用户「还欠什么」）。
    const items = agendaForDate(db, profileId, tomorrow);
    tomorrowItems = items.filter((item) => item.event_date === tomorrow);
    incompleteItems = items.filter((item) => item.overdue);
  } catch (e) {
    // 日程只是增强内容：查询失败就明确写「未知」，不猜也不让整条晚报失败
    logger.warn(`晚报：日程块已跳过（${profileId}）: ${errorMessage(e)}`);
  }
  rows.push([
    "明日日程",
    tomorrowItems === null
      ? "未知"
      : tomorrowItems.length === 0
        ? "无"
        : agendaListText(tomorrowItems, (item) => agendaItemLabel(item, tomorrow)),
  ]);
  rows.push([
    "今日未完成",
    incompleteItems === null
      ? "未知"
      : incompleteItems.length === 0
        ? "无"
        : agendaListText(incompleteItems, (item) => incompleteItemLabel(item, today)),
  ]);

  const holiday = eveningHolidayNote(db, tomorrow);
  if (holiday !== null) notes.push(holiday);
  return { table: { columns: ["项目", "内容"], rows }, notes };
}

/**
 * 21:00 晚报：睡前把「明天」一次说清。与早报同为确定性组装（无 LLM），
 * 覆盖所有已知 Profile（与早报同口径：无推送路由也保留，供 notify.pull 兜底）。
 * 同一天重复触发由 dedupeKey 去重；expiresAt 设为明天中午 12:00 ——
 * 晚报是睡前信息，静默时段结束后也不再补投一条已经过期的「明日安排」。
 *
 * `at` = 这次运行对应的**参考时刻**：cron/手动调用传当前时刻（缺省 now()），
 * 启动补发则传「错过的那次原定触发时刻」。跨午夜补发（21:00 的触发在次日 00:00–03:00
 * 才补跑）若仍按 now() 推导「今天/明天」，内容与 dedupeKey 都会漂移一天：补发算出的
 * `evening:<profile>:<后天>` 会与当天 21:00 的正常运行同键，把当晚的晚报静默吞掉。
 */
export async function runEveningBrief(at?: DateTime): Promise<void> {
  const rt = runtime();
  if (rt.config.qweatherHost === undefined || rt.config.qweatherKey === undefined) {
    logger.warn("晚报跳过：未配置 QWeather");
    return;
  }
  const host = rt.config.qweatherHost;
  const key = rt.config.qweatherKey;
  const today = (at ?? now()).toISODate() ?? todayIso();
  const tomorrow = addDays(today, 1);
  if (tomorrow === null) {
    logger.warn(`晚报跳过：无法从 ${today} 推算明天`);
    return;
  }
  const expiresAt = localToInstant(tomorrow, "12:00");
  const cityCache = new Map<string, LocationInfo>();
  for (const profileId of listProfiles(rt.db)) {
    try {
      const blocks = await eveningBriefBlocks(
        rt.db,
        host,
        key,
        rt.config.defaultCity,
        profileId,
        today,
        tomorrow,
        cityCache,
      );
      await publishProfile(rt.db, rt.config, profileId, {
        kind: "weather.evening",
        title: "🌙 明日安排",
        blocks,
        dedupeKey: `evening:${profileId}:${tomorrow}`,
        expiresAt,
      });
    } catch (e) {
      logger.error(`晚报失败 ${profileId}: ${errorMessage(e)}`);
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
    {
      // 晚报：cron 由 EVENING_BRIEF_CRON 配置（默认 "0 21 * * *"），与早报同一 config 口径
      name: "evening_brief",
      cron: () => runtime().config.eveningBriefCron,
      handler: runEveningBrief,
    },
  ],
});
