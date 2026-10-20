import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { setDefaultLedgerId } from "../src/modules/bookkeeping/service.js";
import { createQuickApp } from "../src/server/quick.js";
import { todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 手机写 API（/api/quick/*）的端到端测试：Hono app + 真实 SQLite。
 *
 * 重点守三件事：
 * ① 身份只来自凭据 —— Profile token 决定 profile，master 才能用 ?profile=/body.profile，
 *    X-Hermes-Profile 一律不认；
 * ② 写路径真的复用了 MCP 工具层 —— 幂等键重试只落一行、家庭账本回执照发；
 * ③ 可见性 —— bootstrap 只列家庭 + 自己的个人账本。
 */

const MASTER = "m".repeat(64);
const BESTIE = "b".repeat(64);
const OTHER = "c".repeat(64);

function buildEnv(): TestEnv {
  return makeTestEnv({
    WEB_API_TOKEN: MASTER,
    PROFILE_TOKENS_JSON: JSON.stringify({ bestie: BESTIE, other: OTHER }),
  });
}

function appFor(env: TestEnv): Hono {
  return new Hono().route("/", createQuickApp(env.config, env.db));
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

/** 一个家庭账本 + 两个 Profile 的个人账本（家庭账本所有人可写，个人账本只有归属人可见） */
function seedLedgers(env: TestEnv): void {
  env.db
    .prepare(
      "INSERT INTO ledgers (id, name, created_at) VALUES ('l-family','家庭账本','2026-01-01T00:00:00.000Z')",
    )
    .run();
  env.db
    .prepare(
      "INSERT INTO ledgers (id, name, created_at, owner_profile_id) VALUES ('l-bestie','bestie 的私房钱','2026-01-01T00:00:00.000Z','bestie')",
    )
    .run();
  env.db
    .prepare(
      "INSERT INTO ledgers (id, name, created_at, owner_profile_id) VALUES ('l-other','other 的私房钱','2026-01-01T00:00:00.000Z','other')",
    )
    .run();
}

describe("/api/quick 鉴权", () => {
  it("没有凭据：三个接口都是 401 + 中文错误体", async () => {
    const env = buildEnv();
    try {
      const app = appFor(env);
      const boot = await app.request("/api/quick/bootstrap");
      assert.equal(boot.status, 401);
      const bootBody = await body(boot);
      assert.equal(bootBody.ok, false);
      assert.match(String(bootBody.error), /未授权/);

      const exp = await app.request("/api/quick/expenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: 10 }),
      });
      assert.equal(exp.status, 401);

      const sch = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "交房租" }),
      });
      assert.equal(sch.status, 401);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("X-Hermes-Profile 不能决定身份（Profile token 只认自己）", async () => {
    const env = buildEnv();
    try {
      seedLedgers(env);
      const res = await appFor(env).request("/api/quick/bootstrap", {
        headers: { Authorization: `Bearer ${BESTIE}`, "X-Hermes-Profile": "other" },
      });
      assert.equal(res.status, 200);
      assert.equal((await body(res)).profile, "bestie");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("master 的 ?profile= 非法时 400，不落任何数据", async () => {
    const env = buildEnv();
    try {
      const res = await appFor(env).request("/api/quick/bootstrap?profile=Bad%20Name", {
        headers: { Authorization: `Bearer ${MASTER}` },
      });
      assert.equal(res.status, 400);
      assert.match(String((await body(res)).error), /Profile 名不合法/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("/api/quick/expenses", () => {
  it("Profile token 记账：落到该 Profile，家庭账本可写，并发出记账回执", async () => {
    const env = buildEnv();
    try {
      seedLedgers(env);
      const res = await appFor(env).request("/api/quick/expenses", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({
          amount: 20,
          ledger_id: "l-family",
          category: "餐饮",
          note: "午饭",
          spent_on: todayIso(),
        }),
      });
      assert.equal(res.status, 201);
      const data = await body(res);
      assert.equal(data.ok, true);
      assert.equal(data.ledger_name, "家庭账本");
      assert.equal(data.category, "餐饮");

      const row = env.db.prepare("SELECT * FROM expenses WHERE id = ?").get(String(data.id)) as {
        created_by_profile: string;
        amount_cents: number;
      };
      assert.equal(row.created_by_profile, "bestie", "记账人必须是 token 对应的 Profile");
      assert.equal(row.amount_cents, 2000);
      // 家庭账本的回执由工具层发布：证明写路径复用的是 expense add 而不是另起一套
      assert.ok(
        env.published.some((p) => p.input.kind === "bookkeeping.entry"),
        "家庭账本记账应发出回执",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("带 request_id 重试：只落一行，第二次返回 已存在", async () => {
    const env = buildEnv();
    try {
      seedLedgers(env);
      const app = appFor(env);
      const payload = JSON.stringify({
        amount: 12.5,
        ledger_id: "l-family",
        category: "咖啡",
        request_id: "quick-retry-1",
      });
      const first = await app.request("/api/quick/expenses", {
        method: "POST",
        headers: bearer(BESTIE),
        body: payload,
      });
      const second = await app.request("/api/quick/expenses", {
        method: "POST",
        headers: bearer(BESTIE),
        body: payload,
      });
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);
      const secondBody = await body(second);
      assert.equal(secondBody.已存在, true);
      assert.equal(secondBody.id, (await body(first)).id);
      const count = env.db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as { n: number };
      assert.equal(count.n, 1, "重试不能重复记账");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非法金额 / 缺金额都是 400 + 中文错误，且不落库", async () => {
    const env = buildEnv();
    try {
      seedLedgers(env);
      const app = appFor(env);
      for (const payload of [
        {},
        { amount: 0 },
        { amount: -5 },
        { amount: "abc" },
        { amount: 1_000_001 },
      ]) {
        const res = await app.request("/api/quick/expenses", {
          method: "POST",
          headers: bearer(BESTIE),
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400, `payload=${JSON.stringify(payload)}`);
        assert.match(String((await body(res)).error), /金额不合法/);
      }
      const count = env.db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as { n: number };
      assert.equal(count.n, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("Profile token 不能写别人的个人账本（一律报账本不存在）", async () => {
    const env = buildEnv();
    try {
      seedLedgers(env);
      const res = await appFor(env).request("/api/quick/expenses", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({ amount: 9, ledger_id: "l-other" }),
      });
      assert.equal(res.status, 400);
      assert.match(String((await body(res)).error), /账本不存在/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("master 带 ?profile=bestie 也能记账（记账人 = bestie）", async () => {
    const env = buildEnv();
    try {
      seedLedgers(env);
      const res = await appFor(env).request("/api/quick/expenses?profile=bestie", {
        method: "POST",
        headers: bearer(MASTER),
        body: JSON.stringify({ amount: 33, ledger_id: "l-bestie", category: "书" }),
      });
      assert.equal(res.status, 201);
      const data = await body(res);
      const row = env.db.prepare("SELECT * FROM expenses WHERE id = ?").get(String(data.id)) as {
        created_by_profile: string;
      };
      assert.equal(row.created_by_profile, "bestie");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("master 不传 profile 时缺省 default", async () => {
    const env = buildEnv();
    try {
      seedLedgers(env);
      const res = await appFor(env).request("/api/quick/expenses", {
        method: "POST",
        headers: bearer(MASTER),
        body: JSON.stringify({ amount: 5, ledger_id: "l-family" }),
      });
      assert.equal(res.status, 201);
      const row = env.db
        .prepare("SELECT * FROM expenses WHERE id = ?")
        .get(String((await body(res)).id)) as { created_by_profile: string };
      assert.equal(row.created_by_profile, "default");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("/api/quick/bootstrap", () => {
  it("只列该 Profile 可见的账本（家庭 + 自己的个人），并给出默认账本/常用分类/本月概况", async () => {
    const env = buildEnv();
    try {
      seedLedgers(env);
      // 常用分类取自默认账本；本月支出来自可见账本合计
      setDefaultLedgerId(env.db, "bestie", "l-bestie");
      env.db
        .prepare(
          `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
           VALUES ('e1','l-bestie',1234,'咖啡',?,'bestie','2026-01-01T00:00:00.000Z')`,
        )
        .run(todayIso());
      // other 的账目不能出现在 bestie 的本月合计里
      env.db
        .prepare(
          `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
           VALUES ('e2','l-other',9999,'书',?,'other','2026-01-01T00:00:00.000Z')`,
        )
        .run(todayIso());

      const res = await appFor(env).request("/api/quick/bootstrap", {
        headers: { Authorization: `Bearer ${BESTIE}` },
      });
      assert.equal(res.status, 200);
      const data = await body(res);
      assert.equal(data.profile, "bestie");
      const ledgers = data.ledgers as { id: string; name: string }[];
      assert.deepEqual(
        ledgers.map((l) => l.id).sort(),
        ["l-bestie", "l-family"],
        "只应看到家庭账本 + 自己的个人账本",
      );
      assert.equal(data.default_ledger_id, "l-bestie");
      assert.deepEqual(data.recent_categories, ["咖啡"]);
      assert.equal(data.month_cents, 1234);
      assert.equal(data.active_schedules, 0);
      const today = data.today as { date: string; weekday: string };
      assert.equal(today.date, todayIso());
      assert.match(today.weekday, /^周[一二三四五六日]$/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("多账本且未设默认时 default_ledger_id 为 null（绝不替用户挑一个）", async () => {
    const env = buildEnv();
    try {
      seedLedgers(env);
      const res = await appFor(env).request("/api/quick/bootstrap", {
        headers: { Authorization: `Bearer ${BESTIE}` },
      });
      assert.equal((await body(res)).default_ledger_id, null);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("/api/quick/schedules", () => {
  it("Profile token 设提醒：落到该 Profile，返回事件时间，重试返回 已存在", async () => {
    const env = buildEnv();
    try {
      const app = appFor(env);
      const payload = JSON.stringify({
        title: "交房租",
        date: "2026-11-01",
        time: "09:00",
        note: "转账",
        request_id: "quick-sch-1",
      });
      const first = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: payload,
      });
      assert.equal(first.status, 201);
      const data = await body(first);
      assert.equal(data.ok, true);
      assert.equal(data.事件时间, "2026-11-01 09:00");

      const row = env.db.prepare("SELECT * FROM schedules WHERE id = ?").get(String(data.id)) as {
        profile_id: string;
        title: string;
      };
      assert.equal(row.profile_id, "bestie");
      assert.equal(row.title, "交房租");

      const second = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: payload,
      });
      assert.equal(second.status, 201);
      assert.equal((await body(second)).已存在, true);
      const count = env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number };
      assert.equal(count.n, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("缺标题 400；只给标题时缺省「今天 09:00」", async () => {
    const env = buildEnv();
    try {
      const app = appFor(env);
      const bad = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({ title: "   " }),
      });
      assert.equal(bad.status, 400);
      assert.match(String((await body(bad)).error), /标题不能为空/);

      const ok = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({ title: "倒垃圾" }),
      });
      assert.equal(ok.status, 201);
      assert.equal((await body(ok)).事件时间, `${todayIso()} 09:00`);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
