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

/**
 * 请求身份：master（看板/运维，允许 X-Hermes-Profile 自报）或某个 Profile（每人一个 token）。
 * 未配置任何 token 时返回 master，保持「回环地址零配置可用」的旧行为。
 */
export type Identity = { kind: "master" } | { kind: "profile"; profileId: string };

export interface IdentityInput {
  masterToken?: string;
  profileTokens?: Record<string, string>;
  authorization?: string;
  /** 仅状态页/只读 API 支持 ?token= 引导；/mcp 不允许把凭据放进 URL */
  queryToken?: string;
}

function digest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** token 指纹（日志/限流 key 用）：不泄漏 token 本身，又能把同一凭据的请求归并 */
export function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

/**
 * 解析身份。对比必须走完全部候选（不提前 return），否则「命中第几个」会泄漏时间差。
 * 同时命中 master 与某个 Profile 时以 Profile 为准（配置层已禁止两者相同，属防御性处理）。
 */
export function resolveIdentity(input: IdentityInput): Identity | null {
  const profiles = input.profileTokens ?? {};
  const hasTokens = input.masterToken !== undefined || Object.keys(profiles).length > 0;
  if (!hasTokens) return { kind: "master" };
  const presented = bearerToken(input.authorization) ?? input.queryToken;
  if (presented === undefined) return null;
  const presentedDigest = digest(presented);
  let matched: Identity | null = null;
  if (
    input.masterToken !== undefined &&
    timingSafeEqual(presentedDigest, digest(input.masterToken))
  ) {
    matched = { kind: "master" };
  }
  for (const [profileId, token] of Object.entries(profiles)) {
    if (timingSafeEqual(presentedDigest, digest(token))) matched = { kind: "profile", profileId };
  }
  return matched;
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
