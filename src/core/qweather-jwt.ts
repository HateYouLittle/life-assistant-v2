import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * QWeather JWT（Ed25519）签名器。
 *
 * 规范来自官方《项目和凭据》：
 *   header  {"alg":"EdDSA","kid":"<凭据ID>"}            —— alg 必须是 EdDSA；不输出 typ/aud/nbf
 *   payload {"iss":"<开发者ID>","sub":"<项目ID>","iat":now-30,"exp":iat+TTL}
 *   签名     base64url(header) + "." + base64url(payload) 的 Ed25519 签名，再 base64url 拼接
 * 必须使用无填充的 Base64URL（不能用标准 Base64）。请求时放 Authorization: Bearer <token>。
 *
 * 官方自 2027-02-01 起逐步限制 API KEY 的每日请求量，JWT 是长期方案、API KEY 保留为回退。
 *
 * 红线：本文件任何日志/错误信息都不得包含私钥内容或 token；错误只带私钥文件路径。
 */

/** 官方要求 iat 回拨 30 秒，容忍签发方与校验方的时钟偏差。 */
export const JWT_IAT_SKEW_SECONDS = 30;
/** 官方 exp 上限：距 iat 最长 24 小时。 */
export const JWT_MAX_TTL_SECONDS = 86400;
/** 默认有效期 12 小时。 */
export const JWT_DEFAULT_TTL_SECONDS = 43200;
/** token 复用窗口：距过期不足这么久就重新签发，避免每个请求都签一次。 */
export const JWT_REFRESH_MARGIN_SECONDS = 300;

export interface JwtSignerOptions {
  keyId: string;
  projectId: string;
  developerId: string;
  /** Ed25519 私钥 PKCS8 PEM 的路径（不读入内存前会做合法性校验）。 */
  privateKeyPath: string;
  ttlSeconds: number;
  /** 仅供测试：注入时钟（毫秒）。 */
  nowMs?: () => number;
  /** 仅供测试：替换签名实现，便于统计签发次数。 */
  signFn?: (data: Buffer, key: KeyObject) => Buffer;
}

export interface JwtSigner {
  /** 取当前有效 token；首次或临近过期时重新签发。 */
  token(): string;
  /** 丢弃缓存（私钥与 token），下次调用重新加载并签发。 */
  reset(): void;
}

/** 无填充 Base64URL（Node 的 "base64url" 编码即此）。 */
function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

export function createJwtSigner(opts: JwtSignerOptions): JwtSigner {
  const nowMs = opts.nowMs ?? Date.now;
  const signFn = opts.signFn ?? ((data: Buffer, key: KeyObject) => sign(null, data, key));
  let privateKey: KeyObject | null = null;
  let cached: { token: string; expSeconds: number } | null = null;

  function loadPrivateKey(): KeyObject {
    if (privateKey !== null) return privateKey;
    let pem: string;
    try {
      pem = readFileSync(opts.privateKeyPath, "utf8");
    } catch {
      // 不回显文件内容；异常原因（不存在/无权限）由路径即可推断
      throw new Error(
        `无法读取 QWeather JWT 私钥文件：${opts.privateKeyPath}（请检查路径是否存在、权限是否可读）`,
      );
    }
    let key: KeyObject;
    try {
      key = createPrivateKey({ key: pem, format: "pem" });
    } catch {
      throw new Error(
        `QWeather JWT 私钥不是合法的 PKCS8 PEM（需 Ed25519 私钥）：${opts.privateKeyPath}`,
      );
    }
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error(
        `QWeather JWT 私钥必须是 Ed25519（当前为 ${key.asymmetricKeyType ?? "未知"}）：${opts.privateKeyPath}`,
      );
    }
    privateKey = key;
    return key;
  }

  function issue(): string {
    const key = loadPrivateKey();
    const nowSeconds = Math.floor(nowMs() / 1000);
    const iat = nowSeconds - JWT_IAT_SKEW_SECONDS;
    const exp = iat + opts.ttlSeconds;
    const header = base64Url(JSON.stringify({ alg: "EdDSA", kid: opts.keyId }));
    const payload = base64Url(
      JSON.stringify({ iss: opts.developerId, sub: opts.projectId, iat, exp }),
    );
    const signingInput = `${header}.${payload}`;
    const signature = signFn(Buffer.from(signingInput, "utf8"), key).toString("base64url");
    const token = `${signingInput}.${signature}`;
    cached = { token, expSeconds: exp };
    return token;
  }

  return {
    token(): string {
      if (cached !== null) {
        const nowSeconds = Math.floor(nowMs() / 1000);
        if (nowSeconds < cached.expSeconds - JWT_REFRESH_MARGIN_SECONDS) return cached.token;
      }
      return issue();
    },
    reset(): void {
      privateKey = null;
      cached = null;
    },
  };
}
