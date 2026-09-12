import type { DatabaseSync } from "node:sqlite";
import { todayIso } from "../time.js";
import { fetchJson } from "./http.js";
import { getCache, getSetting, setCache, setSetting } from "./settings.js";

/**
 * QWeather 客户端（v2 唯一天气数据源）。
 * 端点与参数对照旧仓库 provider 实现，key 走 query 参数、业务错误为 HTTP 200 + body.code。
 */

export interface LocationInfo {
  city: string;
  cityId: string;
  lat: number;
  lon: number;
}

export interface CurrentWeather {
  temp: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  text: string;
}

export interface ForecastDay {
  date: string;
  tMax: number;
  tMin: number;
  textDay: string;
  precipMm?: number;
}

export interface WeatherAlert {
  id: string;
  title: string;
  level: string;
  type: string;
  description: string;
  startsAt?: string;
  endsAt?: string;
}

export interface AirQuality {
  aqi: number;
  category: string;
  primary?: string;
  pm25?: number;
  pm10?: number;
}

function assertQwCode(code: unknown, api: string): void {
  if (code === undefined || code === null) return;
  if (String(code) === "200") return;
  throw new Error(`QWeather ${api} error code ${String(code)}`);
}

function num(value: unknown, field: string): number {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`QWeather ${field} 数值不合法: ${String(value)}`);
  return n;
}

const GEO_ID_RE = /^[A-Za-z0-9]+$/;

export async function geoLookup(
  db: DatabaseSync,
  host: string,
  key: string,
  city: string,
): Promise<LocationInfo> {
  const trimmed = city.trim();
  if (trimmed === "" || trimmed.length > 64) throw new Error(`城市名不合法: ${trimmed}`);
  const cacheKey = `qweather:geo:${trimmed}`;
  const cached = getCache<{ id: string; lat: number; lon: number }>(db, cacheKey);
  if (cached !== undefined) {
    if (GEO_ID_RE.test(cached.id) && Number.isFinite(cached.lat) && Number.isFinite(cached.lon)) {
      return { city: trimmed, cityId: cached.id, lat: cached.lat, lon: cached.lon };
    }
  }
  const body = (await fetchJson(
    `https://${host}/geo/v2/city/lookup?location=${encodeURIComponent(trimmed)}&key=${key}`,
  )) as { code?: unknown; location?: Array<{ id: string; lat: string; lon: string }> };
  assertQwCode(body.code, "GeoAPI");
  const hit = body.location?.[0];
  const id = hit?.id ?? "";
  if (!GEO_ID_RE.test(id)) throw new Error(`未找到城市: ${trimmed}`);
  const lat = num(hit?.lat, "lat");
  const lon = num(hit?.lon, "lon");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) throw new Error(`城市坐标不合法: ${trimmed}`);
  setCache(db, cacheKey, { id, lat, lon }, 7 * 24 * 3600 * 1000);
  return { city: trimmed, cityId: id, lat, lon };
}

export function cachedLocation(db: DatabaseSync, profileId: string): LocationInfo | null {
  return getSetting<LocationInfo>(db, profileId, "location") ?? null;
}

export function saveLocation(db: DatabaseSync, profileId: string, loc: LocationInfo): void {
  setSetting(db, profileId, "location", loc);
}

export async function currentWeather(
  host: string,
  key: string,
  loc: LocationInfo,
): Promise<CurrentWeather> {
  const body = (await fetchJson(
    `https://${host}/v7/weather/now?location=${loc.cityId}&key=${key}`,
  )) as { code?: unknown; now?: Record<string, unknown> };
  assertQwCode(body.code, "weather/now");
  const now = body.now;
  if (now === undefined) throw new Error("QWeather weather/now 响应缺少 now");
  return {
    temp: num(now.temp, "temp"),
    feelsLike: num(now.feelsLike, "feelsLike"),
    humidity: num(now.humidity, "humidity"),
    windSpeed: num(now.windSpeed, "windSpeed"),
    text: String(now.text ?? ""),
  };
}

export async function forecast(
  host: string,
  key: string,
  loc: LocationInfo,
  days: 3 | 7,
): Promise<ForecastDay[]> {
  const path = days <= 3 ? "3d" : "7d";
  const body = (await fetchJson(
    `https://${host}/v7/weather/${path}?location=${loc.cityId}&key=${key}`,
  )) as { code?: unknown; daily?: Array<Record<string, unknown>> };
  assertQwCode(body.code, `weather/${path}`);
  const daily = body.daily ?? [];
  // 用本地日历日过滤：UTC 日期在 00:00–08:00（Asia/Shanghai）会落在前一天，放行已过期的预报行
  const today = todayIso();
  return daily
    .map((d) => ({
      date: String(d.fxDate ?? ""),
      tMax: num(d.tempMax, "tempMax"),
      tMin: num(d.tempMin, "tempMin"),
      textDay: String(d.textDay ?? "").trim(),
      precipMm: d.precip === undefined || d.precip === "" || d.precip === "0" ? undefined : num(d.precip, "precip"),
    }))
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date >= today);
}

export async function alerts(host: string, key: string, loc: LocationInfo): Promise<WeatherAlert[]> {
  const lat = loc.lat.toFixed(2);
  const lon = loc.lon.toFixed(2);
  const body = (await fetchJson(
    `https://${host}/weatheralert/v1/current/${lat}/${lon}?key=${key}`,
  )) as { code?: unknown; alerts?: Array<Record<string, unknown>> };
  assertQwCode(body.code, "weatheralert");
  return (body.alerts ?? []).map((a) => ({
    id: String(a.id ?? ""),
    title: String(a.headline ?? a.title ?? "天气预警"),
    level: String(a.level ?? ""),
    type: String((a.eventType as { name?: unknown } | undefined)?.name ?? "天气预警"),
    description: String(a.description ?? a.headline ?? ""),
    startsAt: a.startsAt === undefined ? undefined : String(a.startsAt),
    endsAt: a.endsAt === undefined ? undefined : String(a.endsAt),
  }));
}

const CN_AQI_CATEGORIES: Array<[number, string]> = [
  [50, "优"],
  [100, "良"],
  [150, "轻度污染"],
  [200, "中度污染"],
  [300, "重度污染"],
  [Number.POSITIVE_INFINITY, "严重污染"],
];

export function cnAqiCategory(aqi: number): string {
  for (const [max, label] of CN_AQI_CATEGORIES) {
    if (aqi <= max) return label;
  }
  return "严重污染";
}

export async function airQuality(host: string, key: string, loc: LocationInfo): Promise<AirQuality> {
  const lat = loc.lat.toFixed(2);
  const lon = loc.lon.toFixed(2);
  const body = (await fetchJson(
    `https://${host}/airquality/v1/current/${lat}/${lon}?key=${key}&lang=zh`,
  )) as {
    error?: { status?: unknown; title?: unknown };
    indexes?: Array<Record<string, unknown>>;
    pollutants?: Array<Record<string, unknown>>;
  };
  if (body.error !== undefined) {
    throw new Error(`QWeather airquality error ${String(body.error.status ?? "")}: ${String(body.error.title ?? "")}`);
  }
  const index = (body.indexes ?? []).find((i) => i.code === "cn-mee" || i.code === "cn-mee-1h");
  if (index === undefined) throw new Error("QWeather airquality 未返回国标指数(cn-mee)");
  const aqi = num(index.aqi, "aqi");
  if (aqi < 0 || aqi > 500) throw new Error(`QWeather aqi 超出范围: ${aqi}`);
  const rawCategory = String(index.category ?? "");
  const category = /\p{Script=Han}/u.test(rawCategory) ? rawCategory : cnAqiCategory(aqi);
  const primaryRaw = String((index.primaryPollutant as { name?: unknown } | undefined)?.name ?? "");
  const pollutants: Record<string, number> = {};
  for (const p of body.pollutants ?? []) {
    const code = String(p.code ?? "");
    const concentration = p.concentration as { value?: unknown; unit?: unknown } | undefined;
    const unit = String(concentration?.unit ?? "").replace(/µ|μ/g, "u").replace(/\s/g, "");
    if (concentration?.value === undefined || !Number.isFinite(Number(concentration.value))) continue;
    if (unit !== "ug/m3" && unit !== "ug/m³") continue;
    pollutants[code] = Number(concentration.value);
  }
  return {
    aqi,
    category,
    primary: primaryRaw === "" || primaryRaw === "NA" ? undefined : primaryRaw,
    pm25: pollutants.pm2p5,
    pm10: pollutants.pm10,
  };
}
