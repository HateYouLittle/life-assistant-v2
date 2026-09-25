import { isAbsolute, join } from "node:path";
import { z } from "zod";
import cron from "node-cron";
import { logger } from "./core/logger.js";
import {
  JWT_DEFAULT_TTL_SECONDS,
  JWT_IAT_SKEW_SECONDS,
  JWT_MAX_TTL_SECONDS,
  createJwtSigner,
} from "./core/qweather-jwt.js";
import { type QweatherAuth, setQweatherAuth } from "./core/qweather.js";

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
  host: string;
  port: number;
  webApiToken?: string;
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
  const host = env.HOST?.trim() || "127.0.0.1";
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
    host,
    port,
    webApiToken,
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
    logLevel: logLevel.data,
  };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1";
}
