import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveIdentity, tokenFingerprint } from "../src/core/auth.js";

const MASTER = "m".repeat(64);
const BESTIE = "b".repeat(64);
const PROFILE_TOKENS = { bestie: BESTIE };

function bearer(token: string): string {
  return `Bearer ${token}`;
}

describe("resolveIdentity：master / Profile token", () => {
  it("未配置任何 token：返回 master（回环零配置的旧行为）", () => {
    assert.deepEqual(resolveIdentity({}), { kind: "master" });
    assert.deepEqual(resolveIdentity({ authorization: bearer("whatever") }), { kind: "master" });
  });

  it("只有 master token：匹配返回 master，缺失/不匹配返回 null", () => {
    assert.deepEqual(resolveIdentity({ masterToken: MASTER, authorization: bearer(MASTER) }), {
      kind: "master",
    });
    assert.equal(resolveIdentity({ masterToken: MASTER }), null);
    assert.equal(resolveIdentity({ masterToken: MASTER, authorization: bearer(BESTIE) }), null);
    assert.equal(resolveIdentity({ masterToken: MASTER, authorization: "Basic abc" }), null);
  });

  it("Profile token 绑定到自己的 Profile；master 仍可用；错误 token 拒绝", () => {
    const input = { masterToken: MASTER, profileTokens: PROFILE_TOKENS };
    assert.deepEqual(resolveIdentity({ ...input, authorization: bearer(BESTIE) }), {
      kind: "profile",
      profileId: "bestie",
    });
    assert.deepEqual(resolveIdentity({ ...input, authorization: bearer(MASTER) }), {
      kind: "master",
    });
    assert.equal(resolveIdentity({ ...input, authorization: bearer("x".repeat(64)) }), null);
  });

  it("?token= 只作为兜底：header 存在时以 header 为准（避免两处冲突）", () => {
    const input = { masterToken: MASTER, profileTokens: PROFILE_TOKENS };
    assert.deepEqual(
      resolveIdentity({
        ...input,
        authorization: bearer(BESTIE),
        queryToken: MASTER,
      }),
      { kind: "profile", profileId: "bestie" },
      "header 与 query 同时存在时不得降级成 master",
    );
    assert.deepEqual(resolveIdentity({ ...input, queryToken: MASTER }), { kind: "master" });
  });

  it("tokenFingerprint 稳定、定长、不包含原文", () => {
    const digest = tokenFingerprint(BESTIE);
    assert.equal(digest.length, 16);
    assert.equal(digest, tokenFingerprint(BESTIE));
    assert.notEqual(digest, tokenFingerprint(MASTER));
    assert.ok(!digest.includes(BESTIE), "指纹里不得出现 token 原文");
  });
});
