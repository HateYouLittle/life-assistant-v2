import { createHash, timingSafeEqual } from "node:crypto";

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

/**
 * 固定长度比较：先各自 SHA-256 再 timingSafeEqual。
 * 直接比较原文时 `a.length === b.length` 会提前返回，泄漏预期 token 的长度。
 */
function matches(expected: string, presented: string | undefined): boolean {
  if (presented === undefined) return false;
  const a = createHash("sha256").update(expected).digest();
  const b = createHash("sha256").update(presented).digest();
  return timingSafeEqual(a, b);
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
