import assert from "node:assert/strict";
import { generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/core/database.js";
import { createJwtSigner } from "../src/core/qweather-jwt.js";
import {
  type LocationInfo,
  currentWeather,
  resetQweatherStateForTests,
  setQweatherAuth,
} from "../src/core/qweather.js";

/**
 * 阶段 B2：QWeather JWT（Ed25519）认证，API KEY 保留为回退。
 * 全部走假 fetch / 假时钟 / 临时密钥文件，绝不打真实外网；私钥与 token 只存在于测试进程内存。
 */

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const dir = mkdtempSync(join(tmpdir(), "qw-jwt-"));
const keyPath = join(dir, "ed25519.pem");
writeFileSync(keyPath, privatePem, { mode: 0o600 });
after(() => rmSync(dir, { recursive: true, force: true }));

const BASE_OPTS = {
  keyId: "kid-1",
  projectId: "proj-1",
  developerId: "DEV1234567",
  ttlSeconds: 43_200,
};

const HOST = "test.example.com";
const LOC: LocationInfo = { city: "上海", cityId: "101020100", lat: 31.23, lon: 121.47 };
const NOW_BODY = {
  code: "200",
  now: { temp: "26", feelsLike: "28", humidity: "70", windSpeed: "12", text: "多云" },
};

interface DecodedToken {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: string;
  signature: string;
}

function decodeToken(token: string): DecodedToken {
  const [h, p, s] = token.split(".");
  assert.ok(h !== undefined && p !== undefined && s !== undefined, "token 应为三段");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString("utf8")),
    payload: JSON.parse(Buffer.from(p, "base64url").toString("utf8")),
    signingInput: `${h}.${p}`,
    signature: s,
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
}

interface FakeResponse {
  status?: number;
  body: unknown;
}

async function withFetch(
  handler: (url: string, call: number) => FakeResponse,
  fn: (calls: Call[]) => Promise<void>,
): Promise<void> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    const raw = init?.headers as Record<string, string> | undefined;
    if (raw !== undefined) {
      for (const [k, v] of Object.entries(raw)) headers[k.toLowerCase()] = String(v);
    }
    const { status = 200, body } = handler(url, calls.length);
    calls.push({ url, headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      body: null,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  return db;
}

beforeEach(() => {
  resetQweatherStateForTests();
});

describe("QWeather JWT：字段与签名", () => {
  it("header 只有 alg=EdDSA 与 kid；payload iss/sub/iat/exp 精确；公钥验签通过", () => {
    const nowMs = Date.parse("2026-09-18T00:00:00.000Z");
    const signer = createJwtSigner({ ...BASE_OPTS, privateKeyPath: keyPath, nowMs: () => nowMs });
    const token = signer.token();
    const { header, payload, signingInput, signature } = decodeToken(token);

    assert.deepEqual(Object.keys(header).sort(), ["alg", "kid"]);
    assert.equal(header.alg, "EdDSA");
    assert.equal(header.kid, "kid-1");
    assert.equal(header.typ, undefined, "不得输出 typ");
    assert.equal(header.aud, undefined, "不得输出 aud");
    assert.equal(header.nbf, undefined, "不得输出 nbf");

    assert.deepEqual(Object.keys(payload).sort(), ["exp", "iat", "iss", "sub"]);
    const nowSeconds = Math.floor(nowMs / 1000);
    assert.equal(payload.iat, nowSeconds - 30, "iat 应为当前时间减 30 秒");
    assert.equal(payload.exp, (payload.iat as number) + 43_200, "exp = iat + TTL");
    assert.equal(payload.iss, "DEV1234567");
    assert.equal(payload.sub, "proj-1");

    // 最强正确性断言：用对应公钥验签
    assert.equal(
      verify(
        null,
        Buffer.from(signingInput, "utf8"),
        publicKey,
        Buffer.from(signature, "base64url"),
      ),
      true,
    );
    assert.doesNotMatch(token, /=/, "必须是无填充 Base64URL");
  });

  it("token 复用：exp-300 之前不重签，越过之后重新签发", () => {
    let nowMs = Date.parse("2026-09-18T00:00:00.000Z");
    let signs = 0;
    const signer = createJwtSigner({
      ...BASE_OPTS,
      privateKeyPath: keyPath,
      nowMs: () => nowMs,
      signFn: (data, key) => {
        signs += 1;
        return sign(null, data, key);
      },
    });

    const first = signer.token();
    assert.equal(signs, 1);
    nowMs += 3_600_000; // +1h，仍在 exp-300 之前
    assert.equal(signer.token(), first);
    assert.equal(signer.token(), first);
    assert.equal(signs, 1, "复用窗口内不得重新签发");

    nowMs += 11 * 3_600_000; // 累计 +12h，越过 exp-300
    const second = signer.token();
    assert.equal(signs, 2, "越过复用窗口必须重签");
    assert.notEqual(second, first);
    const { payload } = decodeToken(second);
    assert.equal(payload.iat, Math.floor(nowMs / 1000) - 30);
  });

  it("reset 后重新加载私钥并重新签发", () => {
    let nowMs = Date.parse("2026-09-18T00:00:00.000Z");
    let signs = 0;
    const signer = createJwtSigner({
      ...BASE_OPTS,
      privateKeyPath: keyPath,
      nowMs: () => nowMs,
      signFn: (data, key) => {
        signs += 1;
        return sign(null, data, key);
      },
    });
    signer.token();
    signer.reset();
    nowMs += 60_000;
    signer.token();
    assert.equal(signs, 2);
  });
});

describe("QWeather JWT：私钥加载异常", () => {
  it("路径不存在：错误含路径、不含密钥内容", () => {
    const missing = join(dir, "does-not-exist.pem");
    const signer = createJwtSigner({ ...BASE_OPTS, privateKeyPath: missing });
    assert.throws(
      () => signer.token(),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        assert.match(message, /does-not-exist\.pem/);
        assert.doesNotMatch(message, /BEGIN/, "错误信息不得回显私钥内容");
        return true;
      },
    );
  });

  it("内容非法：错误含路径、不含密钥内容（即使文件里是伪 PEM）", () => {
    const bad = join(dir, "bad.pem");
    writeFileSync(bad, "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n");
    const signer = createJwtSigner({ ...BASE_OPTS, privateKeyPath: bad });
    assert.throws(
      () => signer.token(),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        assert.match(message, /bad\.pem/);
        assert.doesNotMatch(message, /BEGIN/, "错误信息不得回显私钥内容");
        return true;
      },
    );
  });

  it("非 Ed25519 私钥明确报错", () => {
    const rsaPath = join(dir, "rsa.pem");
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    }) as string;
    writeFileSync(rsaPath, rsa);
    const signer = createJwtSigner({ ...BASE_OPTS, privateKeyPath: rsaPath });
    assert.throws(() => signer.token(), /Ed25519/);
  });
});

describe("QWeather：认证方式接入请求", () => {
  it("JWT 模式：URL 不带 key= 且带 Authorization: Bearer", async () => {
    const db = makeDb();
    const signer = createJwtSigner({ ...BASE_OPTS, privateKeyPath: keyPath });
    setQweatherAuth({ mode: "jwt", signer });
    await withFetch(
      () => ({ body: NOW_BODY }),
      async (calls) => {
        await currentWeather(db, HOST, "should-be-ignored", LOC);
        assert.equal(calls.length, 1);
        const call = calls[0];
        assert.ok(call !== undefined);
        assert.doesNotMatch(call.url, /key=/, "JWT 模式 URL 不得带 key=");
        assert.equal(call.headers.authorization, `Bearer ${signer.token()}`);
        assert.doesNotMatch(call.headers.authorization ?? "", /BEGIN/);
      },
    );
    db.close();
  });

  it("API KEY 模式：URL 含 key= 且不带 Authorization 头", async () => {
    const db = makeDb();
    setQweatherAuth({ mode: "key", apiKey: "test-key" });
    await withFetch(
      () => ({ body: NOW_BODY }),
      async (calls) => {
        await currentWeather(db, HOST, "test-key", LOC);
        const call = calls[0];
        assert.ok(call !== undefined);
        assert.match(call.url, /[?&]key=test-key/);
        assert.equal(call.headers.authorization, undefined);
      },
    );
    db.close();
  });

  it("401：只请求一次即抛错，并给出 JWT 排查提示（不回显 token）", async () => {
    const db = makeDb();
    const signer = createJwtSigner({ ...BASE_OPTS, privateKeyPath: keyPath });
    setQweatherAuth({ mode: "jwt", signer });
    await withFetch(
      () => ({ status: 401, body: { error: { title: "UNAUTHORIZED" } } }),
      async (calls) => {
        await assert.rejects(
          () => currentWeather(db, HOST, "", { ...LOC, cityId: "U401" }),
          (e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            assert.match(message, /401/);
            assert.match(message, /JWT 认证失败/);
            assert.doesNotMatch(message, /Bearer /, "不得回显 token");
            return true;
          },
        );
        assert.equal(calls.length, 1, "401 绝不重试");
      },
    );
    db.close();
  });

  it("403（API KEY 模式）：只请求一次即抛错，并给出 API KEY 排查提示", async () => {
    const db = makeDb();
    setQweatherAuth({ mode: "key", apiKey: "bad-key" });
    await withFetch(
      () => ({ status: 403, body: { error: { title: "NO CREDIT" } } }),
      async (calls) => {
        await assert.rejects(
          () => currentWeather(db, HOST, "bad-key", { ...LOC, cityId: "U403" }),
          (e: unknown) => {
            const message = e instanceof Error ? e.message : String(e);
            assert.match(message, /403/);
            assert.match(message, /API KEY 认证失败/);
            return true;
          },
        );
        assert.equal(calls.length, 1, "403 绝不重试");
      },
    );
    db.close();
  });
});

describe("config：QWeather 认证判定", () => {
  const BASE = { DATA_DIR: "/tmp/la-test", HERMES_PROFILE: "default" };
  const JWT_ENV = {
    QWEATHER_JWT_KEY_ID: BASE_OPTS.keyId,
    QWEATHER_JWT_PROJECT_ID: BASE_OPTS.projectId,
    QWEATHER_JWT_DEVELOPER_ID: BASE_OPTS.developerId,
    QWEATHER_JWT_PRIVATE_KEY_PATH: keyPath,
  };

  it("部分 JWT 配置：启动即抛错并逐一指出缺失项", () => {
    assert.throws(
      () => loadConfig({ ...BASE, QWEATHER_API_HOST: HOST, QWEATHER_JWT_KEY_ID: "kid-1" }),
      (e: unknown) => {
        const message = e instanceof Error ? e.message : String(e);
        assert.match(message, /QWEATHER_JWT_PROJECT_ID/);
        assert.match(message, /QWEATHER_JWT_DEVELOPER_ID/);
        assert.match(message, /QWEATHER_JWT_PRIVATE_KEY_PATH/);
        return true;
      },
    );
  });

  it("两者都配 → 判定为 JWT；仅 API KEY → 判定为 key", () => {
    const both = loadConfig({
      ...BASE,
      QWEATHER_API_HOST: HOST,
      QWEATHER_KEY: "api-key",
      ...JWT_ENV,
    });
    assert.equal(both.qweatherAuth?.mode, "jwt");
    assert.equal(both.qweatherHost, HOST);

    const keyOnly = loadConfig({ ...BASE, QWEATHER_API_HOST: HOST, QWEATHER_KEY: "api-key" });
    assert.equal(keyOnly.qweatherAuth?.mode, "key");
  });

  it("host 配了但没有任何认证 → 报错", () => {
    assert.throws(() => loadConfig({ ...BASE, QWEATHER_API_HOST: HOST }), /同时/);
  });

  it("TTL 非正整数或超上限 → 报错", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "86401"]) {
      assert.throws(
        () =>
          loadConfig({
            ...BASE,
            QWEATHER_API_HOST: HOST,
            QWEATHER_KEY: "k",
            QWEATHER_JWT_TTL_SECONDS: bad,
          }),
        /QWEATHER_JWT_TTL_SECONDS/,
      );
    }
    const ok = loadConfig({
      ...BASE,
      QWEATHER_API_HOST: HOST,
      QWEATHER_KEY: "k",
      QWEATHER_JWT_TTL_SECONDS: "3600",
    });
    assert.equal(ok.qweatherHost, HOST);
  });

  it("两者都配：loadConfig 注入的 JWT 被客户端实际使用（URL 无 key、带 Authorization）", async () => {
    const db = makeDb();
    loadConfig({ ...BASE, QWEATHER_API_HOST: HOST, QWEATHER_KEY: "api-key", ...JWT_ENV });
    await withFetch(
      () => ({ body: NOW_BODY }),
      async (calls) => {
        await currentWeather(db, HOST, "api-key", LOC);
        const call = calls[0];
        assert.ok(call !== undefined);
        assert.doesNotMatch(call.url, /key=/, "两者都配必须走 JWT");
        assert.match(call.headers.authorization ?? "", /^Bearer /);
      },
    );
    db.close();
  });
});
