import type { DatabaseSync } from "node:sqlite";
import { DateTime } from "luxon";
import { TZ, nowIso, todayIso } from "../time.js";
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

/** 落库：按本地日历日累加到独立的 `qweather_usage` 表（不再借道 cache 表） */
export function bumpQweatherUsage(db: DatabaseSync, day: string): void {
  try {
    db.prepare(
      `INSERT INTO qweather_usage (day, requests) VALUES (?, 1)
       ON CONFLICT (day) DO UPDATE SET requests = requests + 1`,
    ).run(day);
  } catch {
    // 计量是旁路：失败绝不能影响天气请求本身
  }
}

/** 读回某天的计数（缺失=0） */
export function readQweatherUsage(db: DatabaseSync, day: string = todayIso()): number {
  const row = db.prepare("SELECT requests FROM qweather_usage WHERE day = ?").get(day) as
    | { requests: number }
    | undefined;
  const value = Number(row?.requests ?? 0);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

export interface CurrentWeather {
  temp: number;
  feelsLike: number;
  /** 相对湿度百分数（0-100）；上游 v1 给的是 [0,1] 小数，映射时已换算 */
  humidity: number;
  /** 风速 km/h；上游 v1 给的是 m/s，映射时已换算 */
  windSpeed: number;
  text: string;
  /**
   * 观测时刻（旧 v7 上游 `now.obsTime`）。**v1 实时天气不再返回观测时刻**，
   * 因此该字段在迁移后恒为 undefined；新鲜度改由 fetchedAt（数据获取时刻）表达。
   */
  obsTime?: string;
  /**
   * 数据获取时刻（缓存写入时的 ISO）。v1 没有观测时刻，用它作为「数据新鲜度」信号；
   * SKILL.md 要求标注数据来源时间，有 20 分钟缓存时不标注就等于隐瞒新鲜度。
   */
  fetchedAt?: string;
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
  const message = e instanceof Error ? e.message : String(e);
  const unauthorized =
    (e instanceof HttpError && (e.status === 401 || e.status === 403)) ||
    (e instanceof QweatherApiError && (e.code === "401" || e.code === "403")) ||
    // v1 的失败契约是 HTTP 200 + body.error{status,title}，assertNoErrorBody 会抛普通
    // Error（保留 title/detail）。这类 401/403 也要拿到认证排查提示。
    /^QWeather .* error (401|403)\b/.test(message);
  if (!unauthorized) return e;
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

/**
 * 解包 v1 的 `{value, unit}` 度量对象。v7 把数值写成裸字符串，v1 一律包一层，
 * 直接取字段会得到对象（`Number({...})` = NaN）——必须先解包再校验。
 */
function measureValue(value: unknown, field: string, units?: readonly string[]): number {
  if (typeof value !== "object" || value === null) {
    throw new Error(`QWeather ${field} 度量对象不合法: ${String(value)}`);
  }
  const raw = value as { value?: unknown; unit?: unknown };
  if (units !== undefined) {
    const unit = String(raw.unit ?? "")
      .trim()
      .toLowerCase();
    // 单位缺失时按上游默认值处理（v1 一直带 unit）；带了不认识的单位必须报错，
    // 否则 °F 会被静默标成 °C、英寸会被静默标成 mm。
    if (unit !== "" && !units.includes(unit)) {
      throw new Error(`QWeather ${field} 单位不支持: ${String(raw.unit)}`);
    }
  }
  return num(raw.value, field);
}

/** 温度单位白名单（v1 返回 °C；兼容不带符号的写法） */
const TEMPERATURE_UNITS = ["°c", "c", "℃", "celsius"] as const;

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * v1 风速单位是 m/s（v7 是 km/h），内部统一换算为 km/h 展示。
 * 单位不识别时抛错，避免把 m/s 当 km/h 静默报小 3.6 倍。
 */
function windSpeedKmh(wind: unknown): number {
  const speed = (wind as { speed?: unknown } | undefined)?.speed;
  const value = measureValue(speed, "wind.speed");
  const unit = String((speed as { unit?: unknown } | undefined)?.unit ?? "")
    .trim()
    .toLowerCase();
  if (unit === "m/s" || unit === "mps") return round1(value * 3.6);
  if (unit === "km/h" || unit === "kph") return round1(value);
  throw new Error(`QWeather wind.speed 单位不支持: ${unit}`);
}

/** 某半天（daytime/nighttime）的降水量 mm；缺失/非法按 0 计（不是「有降水」） */
function periodPrecipMm(period: Record<string, unknown> | undefined): number {
  const amount = (
    period?.precipitation as { amount?: { value?: unknown; unit?: unknown } } | undefined
  )?.amount;
  const unit = String(amount?.unit ?? "")
    .trim()
    .toLowerCase();
  // 单位缺失时按 mm 处理；带单位就必须是 mm，否则降水量会被静默错报。
  if (unit !== "" && unit !== "mm" && unit !== "millimeter" && unit !== "millimeters") {
    throw new Error(`QWeather precipitation 单位不支持: ${String(amount?.unit)}`);
  }
  const value = amount?.value;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function conditionText(period: Record<string, unknown> | undefined): string {
  const condition = period?.condition as { text?: unknown } | undefined;
  return typeof condition?.text === "string" ? condition.text.trim() : "";
}

/** v1 逐日预报用 forecastStartTime（UTC ISO）标识某一天；换算成本地日历日 */
function localDateOf(value: unknown): string {
  const dt = DateTime.fromISO(String(value ?? ""), { zone: TZ });
  return dt.isValid ? (dt.toISODate() ?? "") : "";
}

/**
 * 实时天气。v1 端点是 `GET /weather/v1/current/{lat}/{lon}`（按经纬度，不再用 location=城市ID），
 * 字段为 `temperature/feelsLike` 的 `{value}`、`humidity` 小数、`wind.speed`（m/s）。
 * 特别注意：**v1 不再返回观测时刻**，故用数据获取时刻表达新鲜度（见 fetchedAt）。
 */
export async function currentWeather(
  db: DatabaseSync,
  host: string,
  key: string,
  loc: LocationInfo,
): Promise<CurrentWeather> {
  const auth = resolveAuth(key);
  const lat = loc.lat.toFixed(2);
  const lon = loc.lon.toFixed(2);
  return cached(db, `qweather:now:${loc.cityId}`, CACHE_TTL_MS.now, async () => {
    const body = (await requestQw(
      buildRequest(host, `/weather/v1/current/${lat}/${lon}`, { lang: "zh" }, auth),
      auth,
      "weather/current",
    )) as Record<string, unknown>;
    const humidity = num(body.humidity, "humidity");
    // v1 humidity 是 [0,1] 小数（v7 是百分数）。若上游改回百分数，这里必须报错而不是
    // 静默输出「7000%」——那正是「直接换路径会静默错报湿度」的坑。
    if (humidity < 0 || humidity > 1) {
      throw new Error(
        `QWeather humidity 应为 [0,1] 小数（v1），收到 ${humidity}，拒绝按百分数误报`,
      );
    }
    return {
      temp: measureValue(body.temperature, "temperature", TEMPERATURE_UNITS),
      feelsLike: measureValue(body.feelsLike, "feelsLike", TEMPERATURE_UNITS),
      humidity: Math.round(humidity * 100),
      windSpeed: windSpeedKmh(body.wind),
      text: conditionText(body),
      fetchedAt: nowIso(),
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
  const auth = resolveAuth(key);
  const lat = loc.lat.toFixed(2);
  const lon = loc.lon.toFixed(2);
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
        buildRequest(
          host,
          `/weather/v1/daily/${lat}/${lon}`,
          { days: String(days), lang: "zh" },
          auth,
        ),
        auth,
        "weather/daily",
      )) as { days?: Array<Record<string, unknown>> };
      // 缺失 days 说明响应不完整；静默变成空预报会让简报得出「适宜出行」的错误结论。
      if (!Array.isArray(body.days) || body.days.length === 0) {
        throw new Error("QWeather weather/daily 响应缺少有效的 days 数组");
      }
      // 用本地日历日过滤：UTC 日期在 00:00–08:00（Asia/Shanghai）会落在前一天，放行已过期的预报行
      const today = todayIso();
      const rows = body.days
        .map((d) => {
          const daytime = d.daytime as Record<string, unknown> | undefined;
          const nighttime = d.nighttime as Record<string, unknown> | undefined;
          // v1 没有「当天降水总量」字段：白天 + 夜间累计相加
          const precip = round1(periodPrecipMm(daytime) + periodPrecipMm(nighttime));
          return {
            date: localDateOf(d.forecastStartTime),
            tMax: measureValue(d.temperatureMax, "temperatureMax", TEMPERATURE_UNITS),
            tMin: measureValue(d.temperatureMin, "temperatureMin", TEMPERATURE_UNITS),
            textDay: conditionText(daytime) || conditionText(nighttime),
            precipMm: precip > 0 ? precip : undefined,
          };
        })
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.date >= today);
      // 全部行都不可用（日期格式坏 / 全是过期日）时抛错：返回空数组会被当成「有预报」
      // 缓存 2 小时，简报照发但缺「今日气温」，且「天气与预报全失败则不发送」的兜底失效。
      if (rows.length === 0) {
        throw new Error(`QWeather weather/daily 响应没有可用的预报日（本地今天 ${today}）`);
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
  if (raw !== "") {
    const key = raw.toLowerCase();
    // 必须用 Object.hasOwn：ALERT_LEVEL_NAMES 是普通字面量对象，color.code 若为
    // "constructor"/"__proto__" 会命中 Object.prototype（函数），?? 不回退，
    // 级别变成非字符串 → 后续 level.trim() 抛错并让整批预警丢失、简报正文被污染。
    return Object.hasOwn(ALERT_LEVEL_NAMES, key) ? (ALERT_LEVEL_NAMES[key] as string) : raw;
  }
  const sev = String(severity ?? "").trim();
  return sev === "unknown" ? "" : sev;
}

/**
 * 气象预警。`ttlMs` 让调用方按巡检节奏覆盖缓存 TTL（默认 10 分钟不变，保持工具查询口径）：
 * 预警巡检是「每 N 分钟一轮」的周期性查询，固定 10 分钟 TTL 会让每轮都有一半请求
 * 穿透缓存，把上游请求量放大约 3 倍（见 weather 模块的 alertCacheTtlMs）。
 */
export async function alerts(
  db: DatabaseSync,
  host: string,
  key: string,
  loc: LocationInfo,
  ttlMs: number = CACHE_TTL_MS.alerts,
): Promise<WeatherAlert[]> {
  const lat = loc.lat.toFixed(2);
  const lon = loc.lon.toFixed(2);
  const auth = resolveAuth(key);
  return cached(db, `qweather:alerts:${lat},${lon}`, ttlMs, async () => {
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
    // 只有看起来正常的「零结果」响应（带 metadata 或业务码）才当空处理；
    // alerts 字段存在但不是数组同样属于结构异常（如 alerts:null），不得当成零结果。
    if (body.alerts !== undefined && !Array.isArray(body.alerts)) {
      throw new Error("QWeather weatheralert 响应结构不合法：alerts 不是数组");
    }
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
