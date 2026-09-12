import { timingSafeEqual } from "node:crypto";

/**
 * 单 token 鉴权（/api/* 与 /mcp 共用）。
 * WEB_API_TOKEN 未配置时不启用鉴权（默认只绑定回环地址）；
 * 绑定非回环地址时 config 层强制要求该 token，两条路径都不会再有裸露入口。
 */

/** 从 Authorization 头取 Bearer token */
export function bearerToken(authorization: string | undefined): string | undefined {
  const prefix = "Bearer ";
  if (authorization === undefined || !authorization.startsWith(prefix)) return undefined;
  const value = authorization.slice(prefix.length).trim();
  return value === "" ? undefined : value;
}

function matches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(presented);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Authorization: Bearer 或 ?token= 任一匹配即通过；expected 未配置 = 不鉴权 */
export function isRequestAuthorized(
  expected: string | undefined,
  authorization: string | undefined,
  queryToken?: string | undefined,
): boolean {
  if (expected === undefined) return true;
  return matches(expected, bearerToken(authorization)) || matches(expected, queryToken);
}

/** 从请求 URL 取 ?token=（仅用于状态页/调试直连；正式接入建议用 Authorization 头） */
export function queryTokenOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  const index = url.indexOf("?");
  if (index < 0) return undefined;
  const token = new URLSearchParams(url.slice(index + 1)).get("token");
  return token === null || token === "" ? undefined : token;
}
