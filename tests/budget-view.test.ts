import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  type BudgetPayload,
  budgetPayload,
  budgetSuggestion,
  UNSET_BUDGET_SUGGESTION,
} from "../src/server/budget.js";
import { createStatusApp } from "../src/server/status.js";
import { TZ, todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 预算看板：建议文案的口径（纯函数）+ 数据口径（只家庭账本、月份回退、pace 时间进度）
 * + HTTP 形状与页面卡片。
 *
 * 建议文案是「可执行」的承诺（「日均 ≤ ¥9.00」用户会照做），因此这里逐字断言，
 * 不写 `assert.match(/超支/)` 这种松断言 —— 口径被改坏时必须立刻变红。
 */

function atLocal(localIso: string): DateTime {
  const dt = DateTime.fromISO(localIso, { zone: TZ });
  assert.ok(dt.isValid, `夹具时间不合法: ${localIso}`);
  return dt;
}

function seedLedger(
  env: TestEnv,
  id: string,
  name: string,
  over: { owner?: string; archived?: boolean } = {},
): void {
  env.db
    .prepare(
      `INSERT INTO ledgers (id, name, created_at, archived_at, owner_profile_id)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?, ?)`,
    )
    .run(id, name, over.archived === true ? "2026-02-01T00:00:00.000Z" : null, over.owner ?? null);
}

function seedBudget(
  env: TestEnv,
  id: string,
  ledgerId: string,
  category: string,
  cents: number,
): void {
  env.db
    .prepare(
      `INSERT INTO budgets (id, ledger_id, category, amount_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, ledgerId, category, cents);
}

function seedExpense(
  env: TestEnv,
  id: string,
  ledgerId: string,
  cents: number,
  category: string,
  spentOn: string,
): void {
  env.db
    .prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
       VALUES (?, ?, ?, ?, ?, 'default', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, ledgerId, cents, category, spentOn);
}

describe("budgetSuggestion（建议口径）", () => {
  it("未设预算：提示设置方法，不编造比例", () => {
    const result = budgetSuggestion({ budget: 0, spent: 5000, day: 10, daysInMonth: 30 });
    assert.equal(result.suggestion, UNSET_BUDGET_SUGGESTION);
    assert.equal(result.suggestion, '未设预算，可用 expense {action:"budget"} 设置');
    assert.equal(result.ratio, 0);
    assert.equal(result.pace, 0);
    assert.equal(result.remaining_cents, 0);
  });

  it("已超支：给出确切超支金额与负剩余", () => {
    const result = budgetSuggestion({ budget: 10000, spent: 12000, day: 15, daysInMonth: 30 });
    assert.equal(result.suggestion, "已超支 ¥20.00");
    assert.equal(result.remaining_cents, -2000);
    assert.equal(result.ratio, 1.2);
  });

  it("刚好用完（spent == budget）也报已超支 ¥0.00，不能报「进度正常」", () => {
    const result = budgetSuggestion({ budget: 10000, spent: 10000, day: 20, daysInMonth: 30 });
    assert.equal(result.suggestion, "已超支 ¥0.00");
    assert.equal(result.remaining_cents, 0);
    assert.equal(result.ratio, 1);
  });

  it("花速过快（pace > 1.1）：预估超支 + 剩余天数 + 日均上限", () => {
    // 预算 ¥300，第 10/30 天已花 ¥120 → 时间过去 1/3、钱花了 40% → pace = 1.2
    // 外推整月 ¥360 → 会超支 ¥60；剩余 ¥180 / 20 天 → 日均 ≤ ¥9
    const result = budgetSuggestion({ budget: 30000, spent: 12000, day: 10, daysInMonth: 30 });
    assert.equal(result.suggestion, "按当前速度会超支约 ¥60.00；剩余 20 天，建议日均 ≤ ¥9.00");
    assert.equal(result.remaining_cents, 18000);
    assert.ok(Math.abs(result.pace - 1.2) < 1e-9, `pace 应为 1.2，实际 ${result.pace}`);
  });

  it("日均上限向下取整：说「日均 ≤ ¥8.00」时不能悄悄四舍五入成 ¥8.01", () => {
    // 剩余 20020 分 / 25 天 = 800.8 分 → floor 800 分 = ¥8.00（四舍五入会变成 801 分）
    const result = budgetSuggestion({ budget: 30020, spent: 10000, day: 5, daysInMonth: 30 });
    assert.match(result.suggestion, /建议日均 ≤ ¥8\.00$/);
  });

  it("pace 恰好 1.1：不预警（阈值是 > 1.1，给正常波动留 10% 余量）", () => {
    // 时间进度 10/30=1/3；ratio 1.1/3 → spent = 11000 分
    const result = budgetSuggestion({ budget: 30000, spent: 11000, day: 10, daysInMonth: 30 });
    assert.equal(result.pace.toFixed(4), "1.1000");
    assert.equal(result.suggestion, "进度正常，剩余 ¥190.00（20 天）");
  });

  it("进度正常：剩余金额 + 剩余天数", () => {
    const result = budgetSuggestion({ budget: 30000, spent: 8000, day: 10, daysInMonth: 30 });
    assert.equal(result.suggestion, "进度正常，剩余 ¥220.00（20 天）");
    assert.equal(result.ratio.toFixed(4), "0.2667");
    assert.ok(result.pace < 1);
  });

  it("月首边界：day=1/31 恰好与时间同步，不误报超速", () => {
    const result = budgetSuggestion({ budget: 31000, spent: 1000, day: 1, daysInMonth: 31 });
    assert.equal(result.pace.toFixed(6), "1.000000");
    assert.equal(result.suggestion, "进度正常，剩余 ¥300.00（30 天）");
  });

  it("月末边界：day=daysInMonth 时 pace=ratio、剩余 0 天，且不出现除零", () => {
    const result = budgetSuggestion({ budget: 30000, spent: 15000, day: 31, daysInMonth: 31 });
    assert.equal(result.pace, 0.5);
    assert.equal(result.suggestion, "进度正常，剩余 ¥150.00（0 天）");
  });

  it("未来月份（day=0）：pace 记 0，不产生「无限超速」", () => {
    const result = budgetSuggestion({ budget: 30000, spent: 1000, day: 0, daysInMonth: 31 });
    assert.equal(result.pace, 0);
    assert.equal(result.suggestion, "进度正常，剩余 ¥290.00（31 天）");
  });

  it("day 越界（负数/超过月天数）被夹紧，不会出现负天数或除零", () => {
    const before = budgetSuggestion({ budget: 31000, spent: 1000, day: -5, daysInMonth: 31 });
    assert.equal(before.pace, 0);
    assert.match(before.suggestion, /（31 天）$/);
    const after = budgetSuggestion({ budget: 31000, spent: 1000, day: 99, daysInMonth: 31 });
    assert.equal(after.pace.toFixed(6), "0.032258");
    assert.match(after.suggestion, /（0 天）$/);
  });
});

describe("budgetPayload（数据口径）", () => {
  /** 2026-10：家庭账本 A（总额 + 餐饮/交通分类）、无预算账本 B、
   *  个人账本 C、归档家庭账本 D —— 后两者必须从看板消失 */
  function seedFixture(env: TestEnv): void {
    seedLedger(env, "a", "A-日常");
    seedLedger(env, "b", "B-无预算");
    seedLedger(env, "c", "C-私房", { owner: "default" });
    seedLedger(env, "d", "D-旧账本", { archived: true });

    // A：总额 ¥300、餐饮 ¥100、交通 ¥50
    seedBudget(env, "bud-a-total", "a", "", 30000);
    seedBudget(env, "bud-a-food", "a", "餐饮", 10000);
    seedBudget(env, "bud-a-traffic", "a", "交通", 5000);
    seedExpense(env, "exp-a1", "a", 12000, "餐饮", "2026-10-05");
    seedExpense(env, "exp-a2", "a", 1000, "交通", "2026-10-06");

    // C/D 有预算与支出，但一个是个人账本、一个已归档：都不该出现在看板
    seedBudget(env, "bud-c", "c", "", 999900);
    seedExpense(env, "exp-c1", "c", 50000, "餐饮", "2026-10-05");
    seedBudget(env, "bud-d", "d", "", 100);
    seedExpense(env, "exp-d1", "d", 50000, "餐饮", "2026-10-05");
  }

  const NOW = atLocal("2026-10-10T12:00:00");

  it("只统计活跃家庭账本：个人账本与归档账本不出现，按账本名排序", () => {
    const env = makeTestEnv();
    try {
      seedFixture(env);
      const payload = budgetPayload(env.db, "2026-10", NOW);
      assert.equal(payload.month, "2026-10");
      assert.deepEqual(
        payload.ledgers.map((ledger) => ledger.ledger_id),
        ["a", "b"],
        "个人账本/归档账本不能出现在共享看板",
      );
      assert.deepEqual(
        payload.ledgers.map((ledger) => ledger.ledger_name),
        ["A-日常", "B-无预算"],
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("总额行：spent/remaining/ratio/pace/建议按时间进度计算", () => {
    const env = makeTestEnv();
    try {
      seedFixture(env);
      const family = budgetPayload(env.db, "2026-10", NOW).ledgers.find((l) => l.ledger_id === "a");
      assert.ok(family !== undefined);
      assert.equal(family.has_budget, true);
      const total = family.total;
      assert.ok(total !== null, "设了总额预算就应有 total");
      assert.equal(total.budget_cents, 30000);
      assert.equal(total.spent_cents, 13000);
      assert.equal(total.remaining_cents, 17000);
      assert.ok(Math.abs(total.ratio - 13000 / 30000) < 1e-9);
      // 10/31 天过去、花了 43.3% → pace ≈ 1.343
      assert.ok(Math.abs(total.pace - 13000 / 30000 / (10 / 31)) < 1e-9);
      assert.equal(total.suggestion, "按当前速度会超支约 ¥103.00；剩余 21 天，建议日均 ≤ ¥8.09");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("分类行：超支分类给出「已超支」，正常分类给出剩余；未设预算账本 has_budget=false", () => {
    const env = makeTestEnv();
    try {
      seedFixture(env);
      const payload = budgetPayload(env.db, "2026-10", NOW);
      const family = payload.ledgers.find((l) => l.ledger_id === "a");
      assert.ok(family !== undefined);
      const byCategory = new Map(family.categories.map((c) => [c.category, c]));
      const food = byCategory.get("餐饮");
      assert.ok(food !== undefined);
      assert.equal(food.budget_cents, 10000);
      assert.equal(food.spent_cents, 12000);
      assert.equal(food.remaining_cents, -2000);
      assert.equal(food.suggestion, "已超支 ¥20.00");
      const traffic = byCategory.get("交通");
      assert.ok(traffic !== undefined);
      assert.equal(traffic.suggestion, "进度正常，剩余 ¥40.00（21 天）");

      const noBudget = payload.ledgers.find((l) => l.ledger_id === "b");
      assert.ok(noBudget !== undefined);
      assert.equal(noBudget.has_budget, false);
      assert.equal(noBudget.total, null);
      assert.deepEqual(noBudget.categories, []);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("只有分类预算（没设总额）：has_budget=true 但 total=null", () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "only-cat", "仅分类");
      seedBudget(env, "bud-oc", "only-cat", "餐饮", 5000);
      seedExpense(env, "exp-oc", "only-cat", 6000, "餐饮", "2026-10-05");
      const ledger = budgetPayload(env.db, "2026-10", NOW).ledgers.find(
        (l) => l.ledger_id === "only-cat",
      );
      assert.ok(ledger !== undefined);
      assert.equal(ledger.has_budget, true);
      assert.equal(ledger.total, null);
      assert.equal(ledger.categories[0]?.suggestion, "已超支 ¥10.00");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("月份非法/缺省回退当月；过去月份按整月时间进度", () => {
    const env = makeTestEnv();
    try {
      seedFixture(env);
      const fallback = budgetPayload(env.db, "2099-13");
      assert.equal(fallback.month, todayIso().slice(0, 7), "非法月份必须回退当月而不是空数据");

      // 2026-09 已过完：时间进度=1，pace 恒等于 ratio（不会因为「今天还很早」误报超速）
      const past = budgetPayload(env.db, "2026-09", NOW);
      assert.equal(past.month, "2026-09");
      const family = past.ledgers.find((l) => l.ledger_id === "a");
      assert.ok(family !== undefined);
      assert.equal(family.total?.spent_cents, 0, "9 月没有支出");
      assert.equal(family.total?.pace, 0);
      assert.equal(family.total?.suggestion, "进度正常，剩余 ¥300.00（0 天）");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("/api/budget（HTTP）", () => {
  it("配 token 时 401/200、Bearer 可用、month 生效且 no-store", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      seedLedger(env, "a", "A-日常");
      seedBudget(env, "bud-a", "a", "", 10000);
      seedExpense(env, "exp-a", "a", 12000, "餐饮", "2026-10-05");
      const app = createStatusApp(env.config, env.db);

      assert.equal((await app.request("/api/budget")).status, 401, "/api/budget 漏了鉴权");
      assert.equal((await app.request(`/api/budget?token=${token}`)).status, 200);
      const response = await app.request("/api/budget?month=2026-10", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store", "预算明细不得进缓存");
      const body = (await response.json()) as BudgetPayload;
      assert.equal(body.month, "2026-10");
      assert.equal(body.ledgers.length, 1);
      assert.equal(body.ledgers[0]?.ledger_name, "A-日常");
      assert.equal(body.ledgers[0]?.total?.budget_cents, 10000);
      assert.equal(body.ledgers[0]?.total?.suggestion, "已超支 ¥20.00");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未配 token 时零配置可访问；非法 month 回退当月", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "a", "A-日常");
      const app = createStatusApp(env.config, env.db);
      assert.equal((await app.request("/api/budget")).status, 200);
      const body = (await (await app.request("/api/budget?month=2026-13")).json()) as BudgetPayload;
      assert.equal(body.month, todayIso().slice(0, 7));
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("状态页预算卡片", () => {
  it("HTML 含预算卡片、明细入口与「未设预算」建议文案", async () => {
    const env = makeTestEnv();
    try {
      const html = await (await createStatusApp(env.config, env.db).request("/")).text();
      assert.match(html, /data-drawer="budget"/, "缺少预算卡的抽屉入口");
      assert.match(html, /<div class="card-k">预算 /, "缺少「预算」卡片标题");
      assert.match(html, /id="budget-body"/, "缺少预算卡内容容器");
      assert.match(html, /data-api="\/api\/budget"/, "系统信息里的原始入口应包含 /api/budget");
      // 建议文案由服务端拼进脚本（与 budget.ts 同源）：无预算时页面能直接提示怎么设置。
      // JSON.stringify 会把 "budget" 的双引号转义，故只断言文案主体。
      assert.ok(
        html.includes("未设预算，可用 expense"),
        "页面脚本应内嵌「未设预算」建议文案（与 UNSET_BUDGET_SUGGESTION 同源）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/status 带 budget 段，与 /api/budget 同源且含可执行建议", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, "a", "A-日常");
      seedBudget(env, "bud-a", "a", "", 10000);
      seedExpense(env, "exp-today", "a", 12000, "餐饮", todayIso());
      const app = createStatusApp(env.config, env.db);

      const status = (await (await app.request("/api/status")).json()) as {
        budget: BudgetPayload;
      };
      const budget = (await (await app.request("/api/budget")).json()) as BudgetPayload;
      assert.equal(status.budget.month, budget.month);
      assert.equal(status.budget.ledgers.length, budget.ledgers.length);
      assert.equal(
        status.budget.ledgers[0]?.total?.suggestion,
        "已超支 ¥20.00",
        "本月已超支的账本必须在状态页建议里直接说清超支金额",
      );
      assert.match(JSON.stringify(status.budget), /已超支 ¥20\.00/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
