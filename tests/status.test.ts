import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createStatusApp, statusPayload } from "../src/server/status.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

function app(env: TestEnv) {
  return createStatusApp(env.config, env.db);
}

describe("状态接口", () => {
  it("/api/status 输出关键计数", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare("INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '日用', '2026-01-01T00:00:00.000Z')")
        .run();
      env.db
        .prepare(
          "INSERT INTO expenses (id, ledger_id, amount_cents, spent_on, created_by_profile, created_at) VALUES ('e1','l1',12345,?, 'default', '2026-01-01T00:00:00.000Z')",
        )
        .run(new Date().toISOString().slice(0, 10));
      const payload = statusPayload(env.config, env.db);
      assert.equal(payload.ok, true);
      assert.deepEqual(payload.profiles, ["default"]);
      const ledgers = payload.ledgers as { total: number };
      assert.equal(ledgers.total, 1);
      const expenses = payload.expenses as { month_cents: number };
      assert.equal(expenses.month_cents, 12345);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("设置 WEB_API_TOKEN 后需要鉴权", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: "t".repeat(16), HOST: "0.0.0.0" });
    try {
      const a = app(env);
      assert.equal((await a.request("/api/status")).status, 401);
      assert.equal((await a.request(`/api/status?token=${"t".repeat(16)}`)).status, 200);
      const withBearer = await a.request("/api/status", {
        headers: { Authorization: `Bearer ${"t".repeat(16)}` },
      });
      assert.equal(withBearer.status, 200);
      assert.equal((await a.request("/")).status, 200);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未设置 token 时本机零配置可访问", async () => {
    const env = makeTestEnv();
    try {
      const response = await app(env).request("/api/status");
      assert.equal(response.status, 200);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
