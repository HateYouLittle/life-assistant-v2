import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import type { LocationInfo } from "../../core/qweather.js";
import { cachedLocation, geoLookup } from "../../core/qweather.js";
import type { ToolContext } from "../../core/registry.js";
import { readSetting } from "../../core/settings.js";
import { isDate, TZ, todayIso } from "../../time.js";

export function requireQweather(ctx: ToolContext): { host: string; key: string } {
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
export interface TravelPlan {
  city: string;
  cityId: string;
  lat: number;
  lon: number;
  start: string;
  end: string;
}

export const TRAVEL_PLAN_KEY = "travel_plan";

export type TravelPlanState =
  | { kind: "none" }
  | { kind: "corrupt" }
  | { kind: "plan"; plan: TravelPlan };

/** MM-DD，用于简报里的紧凑日期区间 */
export function shortDate(date: string): string {
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

export function readTravelPlan(db: DatabaseSync, profileId: string): TravelPlanState {
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
export function isTravelActive(plan: TravelPlan, today: string): boolean {
  return plan.start <= today && today <= plan.end;
}

/** 本地日历日差（to - from）；两端都是本地零点，同一时区下为整数天 */
export function calendarDaysBetween(from: string, to: string): number {
  const diff = DateTime.fromISO(to, { zone: TZ }).diff(
    DateTime.fromISO(from, { zone: TZ }),
    "days",
  );
  return Math.round(diff.days);
}

/** 本地日历日 + n 天；解析失败返回 null（调用方跳过依赖该日期的块，绝不猜日期） */
export function addDays(date: string, days: number): string | null {
  return DateTime.fromISO(date, { zone: TZ }).plus({ days }).toISODate();
}

/** weather 回执里的出行模式标注：城市 + 起止日期 */
export function travelModeField(plan: TravelPlan): { 城市: string; 起止: string } {
  return { 城市: plan.city, 起止: `${plan.start} ~ ${plan.end}` };
}

/** 简报/预警通知里的紧凑出行模式标注 */
export function travelModeText(plan: TravelPlan): string {
  return `出行模式：${plan.city} ${shortDate(plan.start)}–${shortDate(plan.end)}`;
}

/** 简报表格行里的出行模式内容：城市（起–止） */
export function travelModeBrief(plan: TravelPlan): string {
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
export async function resolveProfilePlace(
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
export async function resolveToolPlace(
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

/** 预警起止时间（库内是 UTC ISO）→ 本地文本；缺失/非法原样保留或显示 — */
export function alertLocalTime(iso: string | undefined): string {
  if (iso === undefined || iso === "") return "—";
  const dt = DateTime.fromISO(iso, { zone: TZ });
  return dt.isValid ? dt.toFormat("yyyy-LL-dd HH:mm") : iso;
}
