import { isAbsolute, join } from "node:path";
import cron from "node-cron";
import { z } from "zod";
import { logger } from "./core/logger.js";
import { type QweatherAuth, setQweatherAuth } from "./core/qweather.js";
import {
  createJwtSigner,
  JWT_DEFAULT_TTL_SECONDS,
  JWT_IAT_SKEW_SECONDS,
  JWT_MAX_TTL_SECONDS,
} from "./core/qweather-jwt.js";

export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * 共享凭据（WEB_API_TOKEN / MCP_DAEMON_TOKEN）的最小长度。
 * 与 PROFILE_ROUTE_SECRETS_JSON 的 secret 同一口径（openssl rand -hex 32 = 64 字符）：
 * 绑定非回环地址时，弱 token 等于没有鉴权。
 */
export const MIN_TOKEN_LENGTH = 32;

const profileId = z.string().regex(PROFILE_ID_RE);

export type LogLevel = "debug" | "info" | "warn" | "error";

/** 气象预警推送的级别阈值（含），由 ALERT_MIN_LEVEL 配置。 */
export type AlertLevel = "blue" | "yellow" | "orange" | "red";

export interface ResolvedConfig {
  dataDir: string;
  dbPath: string;
  backupDir: string;
  /** 每日自动备份 cron（Asia/Shanghai，BACKUP_CRON，默认 "0 3 * * *"） */
  backupCron: string;
  /** 备份保留份数（BACKUP_KEEP，默认 14，范围 1..365） */
  backupKeep: number;
  host: string;
  port: number;
  webApiToken?: string;
  /**
   * 强制鉴权（REQUIRE_AUTH，1/true/yes/on）。为 true 时没有 WEB_API_TOKEN 直接拒绝启动；
   * 默认 false 保留「回环地址零配置可用」的行为。
   */
  requireAuth: boolean;
  /**
   * 额外放行的 Host 名单（WEB_ALLOWED_HOSTS，逗号分隔）。条目可带端口（`host:3080`，
   * 精确匹配）也可裸主机（`host`，不限端口）；大小写不敏感。用于反代/DNS 名访问与
   * DNS rebinding 防护的显式白名单。
   */
  allowedHosts: string[];
  /**
   * 每人一个 token（PROFILE_TOKENS_JSON：{"profileId":"<token>"}）。
   * 非空时 MCP/写接口按 token 反查 Profile，不再信任 X-Hermes-Profile 自报身份；
   * master WEB_API_TOKEN 仍可访问看板/运维接口。
   */
  profileTokens: Record<string, string>;
  /** 每身份每分钟请求上限（RATE_LIMIT_PER_MINUTE，默认 120；0 = 关闭） */
  rateLimitPerMinute: number;
  /** 反向代理后信任 X-Forwarded-For 第一个地址（TRUST_PROXY，默认 false） */
  trustProxy: boolean;
  qweatherHost?: string;
  qweatherKey?: string;
  /** 实际使用的认证方式：JWT 优先，其次 API KEY；未配置 QWeather 时为 undefined。 */
  qweatherAuth?: QweatherAuth;
  defaultCity: string;
  profileRouteSecrets: Record<string, string>;
  dailyBriefCron: string;
  /** 气象预警巡检 cron（Asia/Shanghai） */
  alertWatchCron: string;
  /** 低于此级别的预警不主动推送 */
  alertMinLevel: AlertLevel;
  /** 调休/补班提醒 cron（Asia/Shanghai） */
  workdayWatchCron: string;
  /** 假期首日提前提醒天数（WORKDAY_REMIND_DAYS_BEFORE） */
  workdayRemindDaysBefore: number;
  /** 每日晚报 cron（EVENING_BRIEF_CRON，默认 "0 21 * * *"，Asia/Shanghai） */
  eveningBriefCron: string;
  /** 每日记账摘要 cron（LEDGER_DIGEST_CRON，默认 "30 21 * * *"，Asia/Shanghai） */
  ledgerDigestCron: string;
  /** 周报 cron（WEEKLY_REPORT_CRON，默认 "0 20 * * 0" 即周日 20:00，Asia/Shanghai） */
  weeklyReportCron: string;
  logLevel: LogLevel;
}

function parseSecrets(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      'PROFILE_ROUTE_SECRETS_JSON 不是合法 JSON：值里的引号可能被 shell 吃掉，请用单引号包裹整段（例：PROFILE_ROUTE_SECRETS_JSON=\'{"default":"<64位hex>"}\'）',
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("PROFILE_ROUTE_SECRETS_JSON 必须是 {profile: secret} 对象");
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (!PROFILE_ID_RE.test(k)) {
      throw new Error(`PROFILE_ROUTE_SECRETS_JSON 的 profile 名不合法: ${k}`);
    }
    if (typeof v !== "string" || v.length < 32) {
      throw new Error(
        `PROFILE_ROUTE_SECRETS_JSON[${k}] 的 secret 至少 32 字符（建议 openssl rand -hex 32）`,
      );
    }
    out[k] = v;
  }
  return out;
}

function normalizeHost(raw: string): string {
  const host = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/+$/, "");
  return host;
}

const TRUE_FLAGS = new Set(["1", "true", "yes", "on"]);
const FALSE_FLAGS = new Set(["0", "false", "no", "off"]);

/**
 * 布尔开关解析（REQUIRE_AUTH）。只接受明确的 1/true/yes/on 与 0/false/no/off：
 * 写成 `REQUIRE_AUTH=treu` 时静默按 false 处理等于把安全开关关掉，必须拒绝启动。
 * 空值（未设置）取默认值。
 */
function parseBooleanFlag(raw: string | undefined, name: string, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase() ?? "";
  if (value === "") return fallback;
  if (TRUE_FLAGS.has(value)) return true;
  if (FALSE_FLAGS.has(value)) return false;
  throw new Error(`${name} 不合法: ${raw}（可选 1/true/yes/on 或 0/false/no/off）`);
}

/**
 * WEB_ALLOWED_HOSTS：逗号分隔。归一化与 HOST 同口径（剥 scheme/尾斜杠/空项），
 * 大小写与端口的语义交给 core/security.ts 的守卫在比较时处理。
 */
function parseAllowedHosts(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((entry) => normalizeHost(entry))
    .filter((entry) => entry !== "");
}

/**
 * 每人一个 token。校验从严：Profile 名合法、token ≥ MIN_TOKEN_LENGTH、
 * 同一 token 不能绑定两个 Profile、也不能与 master token 相同（否则身份二义）。
 */
function parseProfileTokens(
  raw: string | undefined,
  masterToken: string | undefined,
): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `PROFILE_TOKENS_JSON 不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error('PROFILE_TOKENS_JSON 必须是 {"profileId":"token"} 形式的对象');
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > 32) throw new Error("PROFILE_TOKENS_JSON 最多 32 个 Profile");
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [profileId, value] of entries) {
    if (!PROFILE_ID_RE.test(profileId)) {
      throw new Error(`PROFILE_TOKENS_JSON 的 Profile 名不合法: ${profileId}`);
    }
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`PROFILE_TOKENS_JSON.${profileId} 必须是非空字符串`);
    }
    const token = value.trim();
    if (token.length < MIN_TOKEN_LENGTH) {
      throw new Error(`PROFILE_TOKENS_JSON.${profileId} 至少 ${MIN_TOKEN_LENGTH} 字符`);
    }
    if (token === masterToken) {
      throw new Error(`PROFILE_TOKENS_JSON.${profileId} 不能与 WEB_API_TOKEN 相同`);
    }
    if (seen.has(token)) {
      throw new Error(`PROFILE_TOKENS_JSON 里有两个 Profile 用了同一个 token: ${profileId}`);
    }
    seen.add(token);
    out[profileId] = token;
  }
  return out;
}

/**
 * 判断 host 是否误写了「主机:端口」。端口应由 PORT 单独指定，混进 HOST 会让
 * `isLoopbackHost` 判成非回环（进而要求 WEB_API_TOKEN），报错也牛头不对马嘴。
 * IPv6 字面量（`::1`、`[::1]`）必然含多个冒号或方括号，不在此列；
 * 只有「恰好一个冒号 + 纯数字端口」才判定为误写。
 */
function looksLikeHostWithPort(host: string): boolean {
  if (host.startsWith("[")) {
    // 带方括号的 IPv6：`[::1]` 合法，`[::1]:3080` 仍是「把端口写进 HOST」
    return /^\[[^\]]+\]:\d+$/.test(host);
  }
  const colon = host.lastIndexOf(":");
  if (colon < 0 || host.indexOf(":") !== colon) return false;
  return /^\d+$/.test(host.slice(colon + 1));
}

interface JwtCredentials {
  keyId: string;
  projectId: string;
  developerId: string;
  privateKeyPath: string;
}

/**
 * JWT「已配置」= 四个变量全部存在。部分配置返回缺失清单，由调用方在启动时直接抛错
 * —— 绝不允许因为「只写了一半」而静默退回 API KEY。
 */
function readJwtCredentials(
  env: NodeJS.ProcessEnv,
): { ok: true; value: JwtCredentials } | { ok: false; missing: string[] } {
  const keyId = env.QWEATHER_JWT_KEY_ID?.trim() || undefined;
  const projectId = env.QWEATHER_JWT_PROJECT_ID?.trim() || undefined;
  const developerId = env.QWEATHER_JWT_DEVELOPER_ID?.trim() || undefined;
  const privateKeyPath = env.QWEATHER_JWT_PRIVATE_KEY_PATH?.trim() || undefined;
  if (
    keyId !== undefined &&
    projectId !== undefined &&
    developerId !== undefined &&
    privateKeyPath !== undefined
  ) {
    return { ok: true, value: { keyId, projectId, developerId, privateKeyPath } };
  }
  const missing: string[] = [];
  if (keyId === undefined) missing.push("QWEATHER_JWT_KEY_ID");
  if (projectId === undefined) missing.push("QWEATHER_JWT_PROJECT_ID");
  if (developerId === undefined) missing.push("QWEATHER_JWT_DEVELOPER_ID");
  if (privateKeyPath === undefined) missing.push("QWEATHER_JWT_PRIVATE_KEY_PATH");
  return { ok: false, missing };
}

interface QweatherResolution {
  host?: string;
  /**
   * 传给天气工具的 API KEY。JWT-only 时为空串，仅用于让下游「qweatherKey !== undefined
   * 即已配置」的判定成立；JWT 模式下该值不参与请求签名。
   */
  key?: string;
  auth?: QweatherAuth;
}

/**
 * QWeather 认证方式判定：
 * 1. host 未配置时，任何认证凭据出现都是错误；
 * 2. 四个 JWT 变量齐全 → JWT（优先）；
 * 3. 否则有 QWEATHER_KEY → API KEY（回退）；
 * 4. 都没有 → 明确报错。
 */
function resolveQweather(env: NodeJS.ProcessEnv): QweatherResolution {
  const jwt = readJwtCredentials(env);
  if (!jwt.ok && jwt.missing.length < 4) {
    throw new Error(
      `QWEATHER JWT 配置不完整，缺少：${jwt.missing.join("、")}（四个 JWT 变量必须同时设置，或全部省略）`,
    );
  }

  const ttlRaw = env.QWEATHER_JWT_TTL_SECONDS?.trim();
  let ttlSeconds = JWT_DEFAULT_TTL_SECONDS;
  if (ttlRaw !== undefined && ttlRaw !== "") {
    const parsed = Number(ttlRaw);
    // 下界不是洁癖：exp = iat + TTL 且 iat 回拨 30 秒，TTL ≤ 30 会签出「出生即过期」的
    // token（所有天气请求 401，而错误提示把排查引向 kid/项目 ID）；
    // 小于 回拨量 + 复用余量 时 token 缓存永不命中，每个请求都重签。
    if (
      !Number.isInteger(parsed) ||
      parsed <= JWT_IAT_SKEW_SECONDS ||
      parsed > JWT_MAX_TTL_SECONDS
    ) {
      throw new Error(
        `QWEATHER_JWT_TTL_SECONDS 必须是 ${JWT_IAT_SKEW_SECONDS + 1}..${JWT_MAX_TTL_SECONDS} 之间的整数: ${ttlRaw}`,
      );
    }
    ttlSeconds = parsed;
  }

  const rawHost = env.QWEATHER_API_HOST?.trim();
  const host = rawHost === undefined || rawHost === "" ? undefined : normalizeHost(rawHost);
  const apiKey = env.QWEATHER_KEY?.trim() || undefined;

  if (host === undefined) {
    if (apiKey !== undefined) {
      throw new Error("QWEATHER_KEY 与 QWEATHER_API_HOST 必须同时设置");
    }
    if (jwt.ok) {
      throw new Error("QWEATHER_JWT_* 凭据与 QWEATHER_API_HOST 必须同时设置");
    }
    return {};
  }

  if (jwt.ok) {
    const auth: QweatherAuth = {
      mode: "jwt",
      signer: createJwtSigner({ ...jwt.value, ttlSeconds }),
    };
    return { host, key: apiKey ?? "", auth };
  }
  if (apiKey !== undefined) {
    return { host, key: apiKey, auth: { mode: "key", apiKey } };
  }
  throw new Error(
    "QWEATHER_API_HOST 已配置，但缺少认证凭据：QWEATHER_KEY 与 QWEATHER_JWT_* 必须同时设置其一",
  );
}

export function parseProfileId(value: string | undefined, source = "HERMES_PROFILE"): string {
  const parsed = profileId.safeParse(value ?? "");
  if (!parsed.success) {
    throw new Error(`${source} 缺失或不合法（需匹配 ${PROFILE_ID_RE}），拒绝启动`);
  }
  return parsed.data;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const dataDir = env.DATA_DIR?.trim() ?? "";
  if (dataDir === "") throw new Error("DATA_DIR 未设置（必须为绝对路径）");
  if (!isAbsolute(dataDir)) throw new Error(`DATA_DIR 必须是绝对路径: ${dataDir}`);

  const webApiToken = env.WEB_API_TOKEN?.trim() || undefined;
  // 与 QWEATHER_API_HOST 同口径归一（剥 scheme/尾斜杠），否则 `HOST=http://127.0.0.1`
  // 会被判成非回环并索要 WEB_API_TOKEN，用户完全看不懂。
  const host = normalizeHost(env.HOST ?? "") || "127.0.0.1";
  if (looksLikeHostWithPort(host)) {
    throw new Error(`HOST 不能带端口（端口请用 PORT 指定）: ${host}`);
  }
  const loopback = isLoopbackHost(host);
  if (!loopback && !webApiToken) {
    throw new Error(`HOST=${host} 非回环地址且未设置 WEB_API_TOKEN，拒绝启动`);
  }
  if (webApiToken !== undefined && webApiToken.length < MIN_TOKEN_LENGTH) {
    // 非回环：弱 token 会被直接爆破，拒绝启动；回环：只告警，不打断本地零配置使用
    if (!loopback) {
      throw new Error(
        `WEB_API_TOKEN 至少 ${MIN_TOKEN_LENGTH} 字符（当前 ${webApiToken.length}）：HOST=${host} 暴露在网络上，弱 token 等于没有鉴权`,
      );
    }
    logger.warn(
      `WEB_API_TOKEN 只有 ${webApiToken.length} 字符，建议至少 ${MIN_TOKEN_LENGTH}（openssl rand -hex 32）`,
    );
  }

  // 严格模式：显式要求鉴权却拿不到 token 时拒绝启动，避免「以为开了鉴权、实际裸奔」
  const requireAuth = parseBooleanFlag(env.REQUIRE_AUTH, "REQUIRE_AUTH", false);
  if (requireAuth && webApiToken === undefined) {
    throw new Error("REQUIRE_AUTH=1 但未设置 WEB_API_TOKEN（严格模式拒绝无鉴权启动）");
  }
  const allowedHosts = parseAllowedHosts(env.WEB_ALLOWED_HOSTS);
  const profileTokens = parseProfileTokens(env.PROFILE_TOKENS_JSON, webApiToken);
  if (Object.keys(profileTokens).length > 0 && webApiToken === undefined) {
    logger.warn(
      "PROFILE_TOKENS_JSON 已配置但没有 WEB_API_TOKEN：仅回环部署可用，看板/运维接口将无 master 凭据",
    );
  }

  // 每身份每分钟请求上限：默认 120 次；0 表示关闭（本地调试用）。
  const rateLimitRaw = env.RATE_LIMIT_PER_MINUTE?.trim() || "120";
  const rateLimitPerMinute = Number(rateLimitRaw);
  if (
    !Number.isInteger(rateLimitPerMinute) ||
    rateLimitPerMinute < 0 ||
    rateLimitPerMinute > 100_000
  ) {
    throw new Error(`RATE_LIMIT_PER_MINUTE 必须是 0..100000 的整数: ${rateLimitRaw}`);
  }
  // 反代（Lucky/nginx）后面关闭信任：只有显式开启才采信 X-Forwarded-For 做限流/日志。
  const trustProxy = parseBooleanFlag(env.TRUST_PROXY, "TRUST_PROXY", false);

  const { host: qweatherHost, key: qweatherKey, auth: qweatherAuth } = resolveQweather(env);
  // 注入给 qweather 客户端（模块级）：天气工具按旧签名只传 host+key，JWT 签名器走这里
  setQweatherAuth(qweatherAuth ?? null);
  if (qweatherAuth !== undefined) {
    logger.info(
      qweatherAuth.mode === "jwt"
        ? "QWeather 认证方式：JWT（Ed25519）"
        : "QWeather 认证方式：API KEY（未配置 JWT）",
    );
  }

  const dailyBriefCron = env.DAILY_BRIEF_CRON?.trim() || "0 7 * * *";
  if (!cron.validate(dailyBriefCron)) {
    throw new Error(`DAILY_BRIEF_CRON 不是合法 cron 表达式: ${dailyBriefCron}`);
  }

  // 晚报与早报同一套 cron 校验：非法表达式在启动期拒绝，而不是等 21:00 才静默不触发
  const eveningBriefCron = env.EVENING_BRIEF_CRON?.trim() || "0 21 * * *";
  if (!cron.validate(eveningBriefCron)) {
    throw new Error(`EVENING_BRIEF_CRON 不是合法 cron 表达式: ${eveningBriefCron}`);
  }

  const weeklyReportCron = env.WEEKLY_REPORT_CRON?.trim() || "0 20 * * 0";
  if (!cron.validate(weeklyReportCron)) {
    throw new Error(`WEEKLY_REPORT_CRON 不是合法 cron 表达式: ${weeklyReportCron}`);
  }

  const ledgerDigestCron = env.LEDGER_DIGEST_CRON?.trim() || "30 21 * * *";
  if (!cron.validate(ledgerDigestCron)) {
    throw new Error(`LEDGER_DIGEST_CRON 不是合法 cron 表达式: ${ledgerDigestCron}`);
  }

  const alertWatchCron = env.ALERT_WATCH_CRON?.trim() || "*/20 * * * *";
  if (!cron.validate(alertWatchCron)) {
    throw new Error(`ALERT_WATCH_CRON 不是合法 cron 表达式: ${alertWatchCron}`);
  }

  const alertMinLevelRaw = env.ALERT_MIN_LEVEL?.trim() || "blue";
  const alertMinLevel = z.enum(["blue", "yellow", "orange", "red"]).safeParse(alertMinLevelRaw);
  if (!alertMinLevel.success) {
    throw new Error(`ALERT_MIN_LEVEL 不合法: ${alertMinLevelRaw}（可选 blue|yellow|orange|red）`);
  }

  const workdayWatchCron = env.WORKDAY_WATCH_CRON?.trim() || "0 7 * * *";
  if (!cron.validate(workdayWatchCron)) {
    throw new Error(`WORKDAY_WATCH_CRON 不是合法 cron 表达式: ${workdayWatchCron}`);
  }

  const remindDaysRaw = env.WORKDAY_REMIND_DAYS_BEFORE?.trim() || "3";
  const workdayRemindDaysBefore = Number(remindDaysRaw);
  if (
    !Number.isInteger(workdayRemindDaysBefore) ||
    workdayRemindDaysBefore < 0 ||
    workdayRemindDaysBefore > 30
  ) {
    throw new Error(`WORKDAY_REMIND_DAYS_BEFORE 必须是 0..30 之间的整数: ${remindDaysRaw}`);
  }

  const backupCron = env.BACKUP_CRON?.trim() || "0 3 * * *";
  if (!cron.validate(backupCron)) {
    throw new Error(`BACKUP_CRON 不是合法 cron 表达式: ${backupCron}`);
  }

  const backupKeepRaw = env.BACKUP_KEEP?.trim() || "14";
  const backupKeep = Number(backupKeepRaw);
  if (!Number.isInteger(backupKeep) || backupKeep < 1 || backupKeep > 365) {
    throw new Error(`BACKUP_KEEP 必须是 1..365 之间的整数: ${backupKeepRaw}`);
  }

  const portRaw = env.PORT?.trim() || "3080";
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT 不合法: ${portRaw}`);
  }

  const logLevelRaw = env.LOG_LEVEL?.trim() || "info";
  const logLevel = z.enum(["debug", "info", "warn", "error"]).safeParse(logLevelRaw);
  if (!logLevel.success) throw new Error(`LOG_LEVEL 不合法: ${logLevelRaw}`);

  return {
    dataDir,
    dbPath: join(dataDir, "life-assistant.db"),
    backupDir: join(dataDir, "backups"),
    backupCron,
    backupKeep,
    host,
    port,
    webApiToken,
    requireAuth,
    allowedHosts,
    profileTokens,
    rateLimitPerMinute,
    trustProxy,
    qweatherHost,
    qweatherKey,
    qweatherAuth,
    defaultCity: env.DEFAULT_CITY?.trim() || "北京",
    profileRouteSecrets: parseSecrets(env.PROFILE_ROUTE_SECRETS_JSON),
    dailyBriefCron,
    alertWatchCron,
    alertMinLevel: alertMinLevel.data,
    workdayWatchCron,
    workdayRemindDaysBefore,
    eveningBriefCron,
    ledgerDigestCron,
    weeklyReportCron,
    logLevel: logLevel.data,
  };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1";
}

/**
 * listen 用主机：Node 的 `server.listen(port, host)` 不接受 IPv6 字面量的方括号 ——
 * `listen(port, "[::1]")` 会把它当主机名去解析，直接 `getaddrinfo ENOTFOUND` 拒绝启动。
 * 配置层允许写 URL 形态的 `[::1]`（也允许 `::1`），这里统一剥掉方括号再交给 listen。
 */
export function bindHost(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * 展示 / 拼 URL 用主机：IPv6 字面量补方括号（`::1` → `[::1]`），否则
 * `http://::1:3080` 不是合法 URL。已带方括号的原样返回。
 */
export function urlHost(host: string): string {
  if (host === "" || host.startsWith("[")) return host;
  return host.includes(":") ? `[${host}]` : host;
}
