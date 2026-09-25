import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { TZ, todayIso } from "../time.js";
import { HttpError, fetchJson, isTransientNetworkError } from "./http.js";
import type { JwtSigner } from "./qweather-jwt.js";
import { getCache, getSetting, setCache, setCacheUntil, setSetting } from "./settings.js";

/**
 * QWeather 客户端（v2 唯一天气数据源）。
 * 端点与参数对照旧仓库 provider 实现，业务错误为 HTTP 200 + body.code。
 *
 * 认证：JWT（Ed25519）优先，API KEY 保留为回退（官方自 2027-02-01 起限制 API KEY 日请求量）。
 * JWT 模式带 `Authorization: Bearer <token>` 且 URL 不带 `key=`；API KEY 模式 URL 带 `key=`。
 *
 * 上游合规约束（本文件的三条红线，均来自 QWeather 官方文档）：
 * 1. 《缓存你的数据》：按数据类型缓存推荐时间内的结果；
 * 2. 《优化请求》：限制并发，只对 429/5xx 做指数退避，4xx 立即停止 —— 反复重试
 *    错误请求会被判定为攻击并冻结账号；
 * 3. GeoAPI 结果不得缓存/批量存储/建索引，只允许进程内短期 memo。
 */

export interface LocationInfo {
  city: string;
  cityId: string;
  lat: number;
  lon: number;
}

/**
 * 上游请求计量（按本地日历日）。官方自 2027-02-01 起限制 API KEY 的每日请求量，
 * 没有计量就无法判断「今天还剩多少额度」，也无法发现缓存/退避被绕过导致的放大。
 *
 * 语义：只统计**真正发出去的 HTTP 请求**（重试各算一次），缓存命中不计。
 * 进程内存是实时真值；daemon 启动时从库里读回当天计数（重启不清零），
 * 每次自增通过 sink 落库（仅当 sink 被 daemon 注入；测试里只走内存）。
 */
export interface QweatherUsage {
  day: string;
  requests: number;
}

let usage: QweatherUsage = { day: todayIso(), requests: 0 };
let usageSink: ((day: string) => void) | null = null;

/** daemon 启动时注入落库函数；传 null 只走内存（测试/CLI） */
export function setQweatherUsageSink(sink: ((day: string) => void) | null): void {
  usageSink = sink;
}

/** 从持久化的计数继续累加（daemon 启动时调用一次，避免重启把当天用量清零） */
export function seedQweatherUsage(requests: number, day: string = todayIso()): void {
  usage = { day, requests: Math.max(0, Math.trunc(requests)) };
}

export function qweatherUsage(): QweatherUsage {
  rollUsageDay();
  return { ...usage };
}

function rollUsageDay(): void {
  const today = todayIso();
  if (usage.day !== today) usage = { day: today, requests: 0 };
}

function recordUpstreamRequest(): void {
  rollUsageDay();
  usage.requests += 1;
  usageSink?.(usage.day);
}

/** 落库：`cache` 表里按天存一个裸数字，过期时间给足（当天绝不会被 pruneCache 清掉） */
export function bumpQweatherUsage(db: DatabaseSync, day: string): void {
  const expiresAt = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
  try {
    db.prepare(
      `INSERT INTO cache (key, value_json, expires_at) VALUES (?, '1', ?)
       ON CONFLICT (key) DO UPDATE SET
         value_json = CAST(CAST(cache.value_json AS INTEGER) + 1 AS TEXT),
         expires_at = excluded.expires_at`,
    ).run(`qweather:usage:${day}`, expiresAt);
  } catch {
    // 计量是旁路：失败绝不能影响天气请求本身
  }
}

/** 读回某天的计数（缺失=0） */
export function readQweatherUsage(db: DatabaseSync, day: string = todayIso()): number {
  const row = db
    .prepare("SELECT value_json FROM cache WHERE key = ?")
    .get(`qweather:usage:${day}`) as { value_json: string } | undefined;
  const value = Number(row?.value_json ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export interface CurrentWeather {
  temp: number;
  feelsLike: number;
  humidity: number;
  windSpeed: number;
  text: string;
  /**
   * 观测时刻（上游 `now.obsTime`，ISO 字符串）。SKILL.md 要求"标注数据来源时间"，
   * 而有 20 分钟缓存，所以必须把上游观测时间透出来，否则 agent 只能省略或编造。
   * 上游缺失时为 undefined（不猜）。
   */
  obsTime?: string;
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

/**
 * 缓存 TTL。QWeather《缓存你的数据》给出的是区间，本项目只取中间值：
 * 实时天气 10–30min → 20min；逐天预报 1–6h → 2h；天气预警 5–20min → 10min；
 * 实时空气质量 30–60min → 45min。
 */
export const CACHE_TTL_MS = {
  now: 20 * 60_000,
  daily: 2 * 3_600_000,
  alerts: 10 * 60_000,
  air: 45 * 60_000,
} as const;

/** 同一进程内对 QWeather 的并发请求上限（《优化请求》要求限制并发）。 */
export const QWEATHER_MAX_CONCURRENCY = 3;

/** 指数退避：t = b^c（b=2），c 上限 10，单次等待上限 15 分钟。 */
export const BACKOFF_BASE = 2;
export const BACKOFF_MAX_EXPONENT = 10;
export const BACKOFF_MAX_WAIT_MS = 15 * 60_000;

/** 供测试注入假 sleep / 假随机数；生产走默认实现。 */
export interface QweatherDeps {
  sleep(ms: number): Promise<void>;
  random(): number;
  /** 单次调用最多尝试次数（含首次） */
  maxAttempts: number;
  /** 单次退避等待上限 */
  maxWaitMs: number;
}

const defaultDeps: QweatherDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  random: Math.random,
  maxAttempts: 3,
  maxWaitMs: BACKOFF_MAX_WAIT_MS,
};

let deps: QweatherDeps = defaultDeps;

/** 进程内连续可重试错误计数 c；跨调用保留，任一次成功即重置。 */
let backoffExponent = 0;

/**
 * 并发闸门：同一时刻在飞的 QWeather 请求不超过 max，超出者排队等待
 * （不丢请求、不抛错）。释放时把名额直接移交给下一个等待者，避免瞬时超额。
 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  private release(): void {
    const next = this.queue.shift();
    if (next === undefined) this.active -= 1;
    else next();
  }
}

const gate = new Semaphore(QWEATHER_MAX_CONCURRENCY);

/** QWeather 认证：JWT（Ed25519，官方长期方案）优先；API KEY 保留为回退。 */
export type QweatherAuth = { mode: "jwt"; signer: JwtSigner } | { mode: "key"; apiKey: string };

const JWT_AUTH_HINT =
  "JWT 认证失败：核对 kid、项目 ID(sub)、开发者 ID(iss) 是否与上传到 QWeather 控制台的公钥匹配";
const KEY_AUTH_HINT =
  "API KEY 认证失败：核对 QWEATHER_KEY 是否有效、是否与 QWEATHER_API_HOST 属于同一项目";

/**
 * 当前认证方式。生产环境由 config 在启动时注入一次；模块内所有 QWeather 请求共用。
 * 之所以放在模块级而非逐调用传参：调用方（weather 模块）按旧签名只传 host+key，
 * 无法在不改动其契约的前提下携带 JWT 签名器。
 */
let activeAuth: QweatherAuth | null = null;

/** 注入当前认证方式（config 启动时调用；传 null 表示未配置 QWeather）。 */
export function setQweatherAuth(auth: QweatherAuth | null): void {
  activeAuth = auth;
}

/** 仅供测试：注入假 sleep/随机数并重置进程内状态。 */
export function setQweatherDepsForTests(overrides: Partial<QweatherDeps> | null): void {
  deps = overrides === null ? defaultDeps : { ...defaultDeps, ...overrides };
}

/** 仅供测试：重置退避计数、Geo memo 与认证方式，避免用例之间相互影响。 */
export function resetQweatherStateForTests(): void {
  deps = defaultDeps;
  backoffExponent = 0;
  activeAuth = null;
  geoMemo.clear();
  inflightByKey.clear();
}

export class QweatherApiError extends Error {
  readonly code: string;

  constructor(api: string, code: string) {
    super(`QWeather ${api} error code ${code}`);
    this.name = "QweatherApiError";
    this.code = code;
  }
}

function assertQwCode(code: unknown, api: string): void {
  if (code === undefined || code === null) return;
  if (String(code) === "200") return;
  throw new QweatherApiError(api, String(code));
}

/** 429 与 5xx 才是可重试的限流/服务端故障；4xx 不是。 */
function isRetryableStatus(status: number | string): boolean {
  const n = Number(status);
  return n === 429 || (n >= 500 && n <= 599);
}

/**
 * 官方红线：对错误的请求反复重试会被视为攻击、导致账号冻结。
 * 因此只对 429/5xx 与瞬时网络故障退避重试；400/401/403/404 等 4xx 与
 * 业务参数错误一律立即抛出，绝不重试。
 */
function isRetryableError(e: unknown): boolean {
  if (e instanceof HttpError) return isRetryableStatus(e.status);
  if (e instanceof QweatherApiError) return isRetryableStatus(e.code);
  // fetch 自身的网络失败：只重试瞬时故障。3xx（redirect: "error" 产生的 TypeError）
  // 与非法 URL 属确定性失败，重试只会白耗配额
  return isTransientNetworkError(e);
}

/** 第 c 次退避的等待毫秒数：2^c 秒 + [0, 2^c - 1] 秒抖动，再受 maxWaitMs 约束。 */
export function backoffDelayMs(c: number, random: () => number, maxWaitMs: number): number {
  const exponent = Math.min(c, BACKOFF_MAX_EXPONENT);
  const baseSeconds = BACKOFF_BASE ** exponent;
  const jitterSeconds = Math.floor(random() * baseSeconds);
  return Math.min((baseSeconds + jitterSeconds) * 1000, maxWaitMs);
}

/**
 * 退避重试。整个重试序列只在真正发起网络请求时占用并发名额，退避等待期间不占名额，
 * 避免一个被限流的请求拖住其它请求。operation 里只做「取数 + 判定是否可重试」，
 * 解析/校验失败抛普通 Error（不可重试）。
 */
async function withRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= deps.maxAttempts; attempt += 1) {
    try {
      const value = await operation();
      backoffExponent = 0; // 任一次成功即重置退避
      return value;
    } catch (e) {
      if (!isRetryableError(e)) throw e;
      lastError = e;
      backoffExponent = Math.min(backoffExponent + 1, BACKOFF_MAX_EXPONENT);
      if (attempt < deps.maxAttempts) {
        await deps.sleep(backoffDelayMs(backoffExponent, deps.random, deps.maxWaitMs));
      }
    }
  }
  throw lastError;
}

interface QwRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * 认证方式的判定顺序：显式注入的 activeAuth（生产由 config 启动时设置）优先；
 * 否则退回调用方传入的 API KEY（测试直连场景）。两者都没有则明确报错，绝不发匿名请求。
 */
function resolveAuth(key: string): QweatherAuth {
  if (activeAuth !== null) return activeAuth;
  if (key !== "") return { mode: "key", apiKey: key };
  throw new Error("QWeather 未配置认证凭据（QWEATHER_KEY 或 QWEATHER_JWT_*）");
}

/**
 * 统一的 URL + 认证头构造：
 * - JWT 模式：URL 不带 `key=`，带 `Authorization: Bearer <token>`；
 * - API KEY 模式：URL 带 `key=`，不带 Authorization 头。
 * token 只在此处取一次：整个退避重试序列复用同一 token，不逐次重签。
 */
function buildRequest(
  host: string,
  path: string,
  params: Record<string, string>,
  auth: QweatherAuth,
): QwRequest {
  const search = new URLSearchParams(params);
  const headers: Record<string, string> = {};
  if (auth.mode === "jwt") headers.Authorization = `Bearer ${auth.signer.token()}`;
  else search.set("key", auth.apiKey);
  const query = search.toString();
  return { url: `https://${host}${path}${query === "" ? "" : `?${query}`}`, headers };
}

/**
 * 401/403 补一句可操作的排查提示；其他错误原样返回。提示里不含 token / key。
 * 转成普通 Error 后不再被 isRetryableError 视为可重试 —— 认证失败重试无意义。
 */
function withAuthHint(e: unknown, auth: QweatherAuth): unknown {
  const unauthorized =
    (e instanceof HttpError && (e.status === 401 || e.status === 403)) ||
    (e instanceof QweatherApiError && (e.code === "401" || e.code === "403"));
  if (!unauthorized) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new Error(`${message}（${auth.mode === "jwt" ? JWT_AUTH_HINT : KEY_AUTH_HINT}）`);
}

async function gateFetch(req: QwRequest): Promise<Record<string, unknown>> {
  // 唯一的出网点：在这里计数，重试的每一次都算一次真实配额消耗
  recordUpstreamRequest();
  return gate.run(
    async () => (await fetchJson(req.url, undefined, req.headers)) as Record<string, unknown>,
  );
}

/**
 * v1 端点的失败契约是 HTTP 200 + `body.error{status,title}`（不是 `body.code`）。
 * 必须显式判定：否则错误响应会以「缺字段」的形态进入解析，被兜底成空结果 ——
 * 典型后果是气象预警被判成「当前无生效预警」并缓存 10 分钟，漏报且无人察觉。
 * 仍按 status 判定是否可重试：429/5xx 退避，其余（401/403/404…）立即抛出。
 */
function assertNoErrorBody(body: Record<string, unknown>, api: string): void {
  if (body.error === undefined) return;
  const err = body.error as { status?: unknown; title?: unknown };
  const status = Number(err.status);
  if (isRetryableStatus(status)) throw new QweatherApiError(api, String(err.status));
  throw new Error(`QWeather ${api} error ${String(err.status ?? "")}: ${String(err.title ?? "")}`);
}

/**
 * 取 JSON 并校验 QWeather 业务码。业务码校验必须在重试循环内 —— 否则 HTTP 200 +
 * body.code=429 这类限流会被当成不可重试，白白绕过退避直接失败。
 */
async function requestQw(
  req: QwRequest,
  auth: QweatherAuth,
  api: string,
): Promise<Record<string, unknown>> {
  try {
    return await withRetry(async () => {
      const body = await gateFetch(req);
      assertQwCode(body.code, api);
      assertNoErrorBody(body, api);
      return body;
    });
  } catch (e) {
    throw withAuthHint(e, auth);
  }
}

/** 空气质量走 v1：失败契约同上，额外按 status 判定可重试性 */
async function requestAirQuality(
  req: QwRequest,
  auth: QweatherAuth,
): Promise<Record<string, unknown>> {
  try {
    return await withRetry(async () => {
      const body = await gateFetch(req);
      assertNoErrorBody(body, "airquality");
      return body;
    });
  } catch (e) {
    throw withAuthHint(e, auth);
  }
}

/** 在途的缓存请求（cacheKey → Promise），用于合并同一 key 的并发上游请求 */
const inflightByKey = new Map<string, Promise<unknown>>();

/**
 * 读缓存 → 未命中则请求 → 仅成功结果写缓存。
 * produce 抛错时不会写缓存（错误被固化会让故障长期自愈不了）。
 * 并发同一 key 的调用合并为一次上游请求（single-flight）：否则并发的重复查询
 * 会各自打一次上游，白白消耗配额。
 */
async function cached<T>(
  db: DatabaseSync,
  cacheKey: string,
  ttlMs: number,
  produce: () => Promise<T>,
  /**
   * 可选：由调用方给出绝对过期时刻。TTL 必须在**写入时**换算 —— 在调用时算好再等响应
   * （重试时可达数十秒）会让「次日 00:00 失效」推迟到零点之后，
   * 那段时间里逐天预报的首行已经是昨天。
   */
  expiresAtOf?: () => string,
): Promise<T> {
  const hit = getCache<T>(db, cacheKey);
  if (hit !== undefined) return hit;
  const inflight = inflightByKey.get(cacheKey);
  if (inflight !== undefined) return inflight as Promise<T>;
  const task = (async (): Promise<T> => {
    const value = await produce();
    if (expiresAtOf === undefined) setCache(db, cacheKey, value, ttlMs);
    else setCacheUntil(db, cacheKey, value, expiresAtOf());
    return value;
  })();
  inflightByKey.set(cacheKey, task);
  try {
    return await task;
  } finally {
    inflightByKey.delete(cacheKey);
  }
}

function num(value: unknown, field: string): number {
  // 只接受 number 或非空数字字符串：Number(null)/Number("")/Number([]) 都是 0，
  // 会把「字段缺失」伪装成 0（aqi 缺失会被误报成「优」）。
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`QWeather ${field} 数值不合法: ${String(value)}`);
  }
  if (typeof value === "string" && value.trim() === "") {
    throw new Error(`QWeather ${field} 数值不合法: 空字符串`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`QWeather ${field} 数值不合法: ${String(value)}`);
  return n;
}

const GEO_ID_RE = /^[A-Za-z0-9]+$/;

/** Geo memo 容量与有效期（仅进程内，绝不落盘）。 */
const GEO_MEMO_MAX = 64;
const GEO_MEMO_TTL_MS = 24 * 3_600_000;
const geoMemo = new Map<string, { at: number; value: LocationInfo }>();
const legacyGeoCleared = new WeakSet<object>();

/**
 * GeoAPI 合规红线：官方《缓存你的数据》与《使用限制》明确禁止缓存、提取、
 * 批量存储 GeoAPI 数据，也不得据此建立索引（版权方要求，违规可能承担法律责任）。
 * 旧实现曾把结果写进 cache 表 7 天，这里清理可能残留的历史行（每库一次）。
 */
function clearLegacyGeoCache(db: DatabaseSync): void {
  if (legacyGeoCleared.has(db)) return;
  legacyGeoCleared.add(db);
  db.prepare("DELETE FROM cache WHERE key LIKE 'qweather:geo:%'").run();
}

function geoMemoGet(city: string, nowMs: number): LocationInfo | undefined {
  const entry = geoMemo.get(city);
  if (entry === undefined) return undefined;
  if (nowMs - entry.at > GEO_MEMO_TTL_MS) {
    geoMemo.delete(city);
    return undefined;
  }
  return entry.value;
}

function geoMemoSet(city: string, value: LocationInfo, nowMs: number): void {
  geoMemo.delete(city);
  geoMemo.set(city, { at: nowMs, value });
  while (geoMemo.size > GEO_MEMO_MAX) {
    const oldest = geoMemo.keys().next().value;
    if (oldest === undefined) break;
    geoMemo.delete(oldest);
  }
}

export async function geoLookup(
  db: DatabaseSync,
  host: string,
  key: string,
  city: string,
): Promise<LocationInfo> {
  const trimmed = city.trim();
  if (trimmed === "" || trimmed.length > 64) throw new Error(`城市名不合法: ${trimmed}`);
  clearLegacyGeoCache(db);
  const nowMs = Date.now();
  const memo = geoMemoGet(trimmed, nowMs);
  if (memo !== undefined) return memo;
  const auth = resolveAuth(key);
  const body = (await requestQw(
    buildRequest(host, "/geo/v2/city/lookup", { location: trimmed }, auth),
    auth,
    "GeoAPI",
  )) as { code?: unknown; location?: Array<{ id: string; lat: string; lon: string }> };
  const hit = body.location?.[0];
  const id = hit?.id ?? "";
  if (!GEO_ID_RE.test(id)) throw new Error(`未找到城市: ${trimmed}`);
  const lat = num(hit?.lat, "lat");
  const lon = num(hit?.lon, "lon");
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180)
    throw new Error(`城市坐标不合法: ${trimmed}`);
  const value = { city: trimmed, cityId: id, lat, lon };
  geoMemoSet(trimmed, value, nowMs);
  return value;
}

export function cachedLocation(db: DatabaseSync, profileId: string): LocationInfo | null {
  return getSetting<LocationInfo>(db, profileId, "location") ?? null;
}

export function saveLocation(db: DatabaseSync, profileId: string, loc: LocationInfo): void {
  setSetting(db, profileId, "location", loc);
}

export async function currentWeather(
  db: DatabaseSync,
  host: string,
  key: string,
  loc: LocationInfo,
): Promise<CurrentWeather> {
  const auth = resolveAuth(key);
  return cached(db, `qweather:now:${loc.cityId}`, CACHE_TTL_MS.now, async () => {
    const body = (await requestQw(
      buildRequest(host, "/v7/weather/now", { location: loc.cityId }, auth),
      auth,
      "weather/now",
    )) as { code?: unknown; now?: Record<string, unknown> };
    const now = body.now;
    if (now === undefined) throw new Error("QWeather weather/now 响应缺少 now");
    return {
      temp: num(now.temp, "temp"),
      feelsLike: num(now.feelsLike, "feelsLike"),
      humidity: num(now.humidity, "humidity"),
      windSpeed: num(now.windSpeed, "windSpeed"),
      text: String(now.text ?? ""),
      obsTime: typeof now.obsTime === "string" && now.obsTime !== "" ? now.obsTime : undefined,
    };
  });
}

/**
 * 逐天预报的过期时刻：min(写入时刻 + 2h, 下一个本地零点)。
 * 逐天预报的跨日陷阱 —— 23:00 取到的 7 天预报若沿用 2 小时 TTL，过了 00:00 首日
 * 会变成「昨天」。所以必须在**写入时刻**换算绝对过期时刻（见 cached 的 expiresAtOf）。
 */
export function dailyForecastExpiresAt(nowMs: number): string {
  const dt = DateTime.fromMillis(nowMs, { zone: TZ });
  const nextMidnight = dt.startOf("day").plus({ days: 1 });
  return new Date(Math.min(nowMs + CACHE_TTL_MS.daily, nextMidnight.toMillis())).toISOString();
}

/** 同上，返回剩余毫秒数（测试与展示用） */
export function dailyForecastTtlMs(nowMs: number): number {
  return Math.max(0, Date.parse(dailyForecastExpiresAt(nowMs)) - nowMs);
}

export async function forecast(
  db: DatabaseSync,
  host: string,
  key: string,
  loc: LocationInfo,
  days: 3 | 7,
): Promise<ForecastDay[]> {
  const path = days <= 3 ? "3d" : "7d";
  const auth = resolveAuth(key);
  // 过期时刻按「请求发起时刻」换算成绝对值，但等响应回来（重试时可达数十秒）才写入：
  // 若按发起时刻算好「剩余毫秒」再延迟写入，过期时刻会被顺延到零点之后；
  // 若按写入时刻算，23:59 发起、00:00 返回的响应会活到**下一个**零点，首行仍是昨天。
  const requestedAt = Date.now();
  return cached(
    db,
    `qweather:daily:${days}:${loc.cityId}`,
    CACHE_TTL_MS.daily,
    async () => {
      const body = (await requestQw(
        buildRequest(host, `/v7/weather/${path}`, { location: loc.cityId }, auth),
        auth,
        `weather/${path}`,
      )) as { code?: unknown; daily?: Array<Record<string, unknown>> };
      // 缺失 daily 说明响应不完整；静默变成空预报会让简报得出「适宜出行」的错误结论。
      if (!Array.isArray(body.daily) || body.daily.length === 0) {
        throw new Error(`QWeather weather/${path} 响应缺少有效的 daily 数组`);
      }
      const daily = body.daily;
      // 用本地日历日过滤：UTC 日期在 00:00–08:00（Asia/Shanghai）会落在前一天，放行已过期的预报行
      const today = todayIso();
      const rows = daily
        .map((d) => {
          // 上游把「无降水」写作 "0.0"（而非 "0"），必须按数值判断
          const precip =
            d.precip === undefined || d.precip === null || d.precip === ""
              ? 0
              : num(d.precip, "precip");
          return {
            date: String(d.fxDate ?? ""),
            tMax: num(d.tempMax, "tempMax"),
            tMin: num(d.tempMin, "tempMin"),
            textDay: String(d.textDay ?? "").trim(),
            precipMm: precip > 0 ? precip : undefined,
          };
        })
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date >= today);
      // 全部行都不可用（日期格式坏 / 全是过期日）时抛错：返回空数组会被当成「有预报」
      // 缓存 2 小时，简报照发但缺「今日气温」，且「天气与预报全失败则不发送」的兜底失效。
      if (rows.length === 0) {
        throw new Error(`QWeather weather/${path} 响应没有可用的预报日（本地今天 ${today}）`);
      }
      return rows;
    },
    () => dailyForecastExpiresAt(requestedAt),
  );
}

/** v1 预警的 color.code 即国标预警级别；也兼容少数返回英文色名的实现 */
const ALERT_LEVEL_NAMES: Record<string, string> = {
  blue: "蓝色",
  yellow: "黄色",
  orange: "橙色",
  red: "红色",
};

function alertLevelOf(color: unknown, severity: unknown): string {
  const code = typeof color === "string" ? color : undefined;
  const fromObject =
    typeof color === "object" && color !== null ? (color as { code?: unknown }).code : undefined;
  const raw = String(fromObject ?? code ?? "").trim();
  if (raw !== "") return ALERT_LEVEL_NAMES[raw.toLowerCase()] ?? raw;
  const sev = String(severity ?? "").trim();
  return sev === "unknown" ? "" : sev;
}

export async function alerts(
  db: DatabaseSync,
  host: string,
  key: string,
  loc: LocationInfo,
): Promise<WeatherAlert[]> {
  const lat = loc.lat.toFixed(2);
  const lon = loc.lon.toFixed(2);
  const auth = resolveAuth(key);
  return cached(db, `qweather:alerts:${lat},${lon}`, CACHE_TTL_MS.alerts, async () => {
    const body = (await requestQw(
      buildRequest(host, `/weatheralert/v1/current/${lat}/${lon}`, {}, auth),
      auth,
      "weatheralert",
    )) as { code?: unknown; metadata?: unknown; alerts?: Array<Record<string, unknown>> };
    // v1 预警结构为 { id, eventType{name,code}, color{code}, severity, effectiveTime,
    // onsetTime, expireTime, headline, description }：没有 level/startsAt/endsAt/title。
    // 此前按已废弃的 v7 结构读取，导致级别恒为空、起止时间恒为 undefined。
    //
    // alerts 缺失时不能一律当成「无预警」：结构异常（如错误响应体）会被静默成空结果，
    // 「无预警」是安全相关的结论，宁可抛错让调用方显示「未知」。
    // 只有看起来正常的「零结果」响应（带 metadata 或业务码）才当空处理。
    if (!Array.isArray(body.alerts)) {
      if (body.metadata !== undefined || body.code !== undefined) return [];
      throw new Error("QWeather weatheralert 响应结构不合法：既无 alerts 也无 metadata/code");
    }
    return body.alerts.map((a) => ({
      id: String(a.id ?? ""),
      title: String(a.headline ?? a.title ?? "天气预警"),
      level: alertLevelOf(a.color, a.severity),
      type: String((a.eventType as { name?: unknown } | undefined)?.name ?? "天气预警"),
      description: String(a.description ?? a.headline ?? ""),
      startsAt: isoOrUndefined(a.effectiveTime ?? a.onsetTime ?? a.startsAt),
      endsAt: isoOrUndefined(a.expireTime ?? a.endsAt),
    }));
  });
}

/**
 * 预警时间归一化为 UTC ISO（Z 结尾）。上游 QWeather 的 effectiveTime/expireTime 是带
 * 偏移的本地时间（如 `2026-09-21T02:00+08:00`）；若原样存入 deliveries.expire_at，
 * 之后与 nowIso()（Z 结尾）做字符串比较会把「此刻已过期」误判成「尚未过期」，导致
 * 静默时段结束后补投一条已经失效的预警。
 * 解析失败返回 undefined：不设起止时间（isExpiredAlert 视为未过期），不会误杀。
 */
function isoOrUndefined(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const dt = DateTime.fromISO(String(value), { zone: TZ });
  return dt.isValid ? (dt.toUTC().toISO() ?? undefined) : undefined;
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

export async function airQuality(
  db: DatabaseSync,
  host: string,
  key: string,
  loc: LocationInfo,
): Promise<AirQuality> {
  const lat = loc.lat.toFixed(2);
  const lon = loc.lon.toFixed(2);
  const auth = resolveAuth(key);
  return cached(db, `qweather:air:${lat},${lon}`, CACHE_TTL_MS.air, async () => {
    const body = (await requestAirQuality(
      buildRequest(host, `/airquality/v1/current/${lat}/${lon}`, { lang: "zh" }, auth),
      auth,
    )) as {
      indexes?: Array<Record<string, unknown>>;
      pollutants?: Array<Record<string, unknown>>;
    };
    const index = (body.indexes ?? []).find((i) => i.code === "cn-mee" || i.code === "cn-mee-1h");
    if (index === undefined) throw new Error("QWeather airquality 未返回国标指数(cn-mee)");
    const aqi = num(index.aqi, "aqi");
    if (aqi < 0 || aqi > 500) throw new Error(`QWeather aqi 超出范围: ${aqi}`);
    const rawCategory = String(index.category ?? "");
    const category = /\p{Script=Han}/u.test(rawCategory) ? rawCategory : cnAqiCategory(aqi);
    const primaryRaw = String(
      (index.primaryPollutant as { name?: unknown } | undefined)?.name ?? "",
    );
    const pollutants: Record<string, number> = {};
    for (const p of body.pollutants ?? []) {
      const code = String(p.code ?? "");
      const concentration = p.concentration as { value?: unknown; unit?: unknown } | undefined;
      const unit = String(concentration?.unit ?? "")
        .replace(/µ|μ/g, "u")
        .replace(/\s/g, "");
      if (unit !== "ug/m3" && unit !== "ug/m³") continue;
      const raw = concentration?.value;
      // 与 num() 同一口径：Number(null)/Number("")/Number([]) 都是 0，会把「没有数据」
      // 伪装成实测的 0（页面上显示「PM2.5 0 μg/m³」）；而 0 是合法读数，不能靠数值判断。
      if (typeof raw !== "number" && typeof raw !== "string") continue;
      if (typeof raw === "string" && raw.trim() === "") continue;
      const value = Number(raw);
      if (!Number.isFinite(value)) continue;
      pollutants[code] = value;
    }
    return {
      aqi,
      category,
      primary: primaryRaw === "" || primaryRaw === "NA" ? undefined : primaryRaw,
      pm25: pollutants.pm2p5,
      pm10: pollutants.pm10,
    };
  });
}
