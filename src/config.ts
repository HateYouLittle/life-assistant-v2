import { isAbsolute, join } from "node:path";
import { z } from "zod";
import cron from "node-cron";

export const PROFILE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const profileId = z.string().regex(PROFILE_ID_RE);

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ResolvedConfig {
  dataDir: string;
  dbPath: string;
  backupDir: string;
  host: string;
  port: number;
  webApiToken?: string;
  qweatherHost?: string;
  qweatherKey?: string;
  defaultCity: string;
  profileRouteSecrets: Record<string, string>;
  dailyBriefCron: string;
  logLevel: LogLevel;
}

function parseSecrets(raw: string | undefined): Record<string, string> {
  if (raw === undefined || raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      "PROFILE_ROUTE_SECRETS_JSON 不是合法 JSON：值里的引号可能被 shell 吃掉，请用单引号包裹整段（例：PROFILE_ROUTE_SECRETS_JSON='{\"default\":\"<64位hex>\"}'）",
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
      throw new Error(`PROFILE_ROUTE_SECRETS_JSON[${k}] 的 secret 至少 32 字符（建议 openssl rand -hex 32）`);
    }
    out[k] = v;
  }
  return out;
}

function normalizeHost(raw: string): string {
  const host = raw.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  return host;
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
  if (!isLoopbackHost(host) && !webApiToken) {
    throw new Error(`HOST=${host} 非回环地址且未设置 WEB_API_TOKEN，拒绝启动`);
  }

  const qweatherHost = env.QWEATHER_API_HOST?.trim() || undefined;
  const qweatherKey = env.QWEATHER_KEY?.trim() || undefined;
  if ((qweatherHost === undefined) !== (qweatherKey === undefined)) {
    throw new Error("QWEATHER_API_HOST 与 QWEATHER_KEY 必须同时设置或同时省略");
  }

  const dailyBriefCron = env.DAILY_BRIEF_CRON?.trim() || "0 7 * * *";
  if (!cron.validate(dailyBriefCron)) {
    throw new Error(`DAILY_BRIEF_CRON 不是合法 cron 表达式: ${dailyBriefCron}`);
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
    qweatherHost: qweatherHost === undefined ? undefined : normalizeHost(qweatherHost),
    qweatherKey,
    defaultCity: env.DEFAULT_CITY?.trim() || "北京",
    profileRouteSecrets: parseSecrets(env.PROFILE_ROUTE_SECRETS_JSON),
    dailyBriefCron,
    logLevel: logLevel.data,
  };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "::ffff:127.0.0.1";
}
