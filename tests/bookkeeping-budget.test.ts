import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import {
  addExpense,
  budgetStatus,
  clearBudget,
  createLedger,
  getBudgets,
  pushMonthlyReports,
  setBudget,
} from "../src/modules/bookkeeping/service.js";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import { cleanupTestEnv, makeTestEnv, type Published, type TestEnv } from "./helpers.js";

/** 固定到某个北京时间的 10:00 */
function freeze(t: TestContext, date: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(`${date}T10:00:00+08:00`) });
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

/**
 * 带 dedupeKey 去重的 publishGlobal 桩：与真实 notify 的
 * 「Profile 内同 dedupeKey 只物化一次」语义一致（用 Set 模拟 notifications 唯一约束）。
 */
function makeTools(env: TestEnv, profileId = "default") {
  const seen = new Set<string>();
  // attempts 记录每次 publishGlobal 调用（去重前）；published 只记物化成功的。
  // 「跨越阈值」与「达到即推」在去重后完全等价，只有看 attempts 才能区分，故两者都断言。
  const attempts: { kind: string; dedupeKey?: string }[] = [];
  const ctx = {
    profileId,
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async (input: { kind: string; dedupeKey?: string }) => {
        if (input.kind === "bookkeeping.budget") attempts.push(input);
        if (input.dedupeKey !== undefined) {
          if (seen.has(input.dedupeKey)) return { materialized: 0 };
          seen.add(input.dedupeKey);
        }
        env.published.push({ profileId: "*", input: input as never });
        return { materialized: 1 };
      },
    },
  };
  return {
    ledger: (args: Record<string, unknown>) => bookkeepingLedgerTool(args, ctx),
    expense: (args: Record<string, unknown>) => bookkeepingExpenseTool(args, ctx),
    budgetAlerts: () =>
      env.published.filter((p) => p.input.kind === "bookkeeping.budget") as Published[],
    budgetAlertAttempts: () => attempts,
  };
}

describe("bookkeeping 预算：服务层 CRUD 与对照", () => {
  it("setBudget 是 upsert：同 (ledger, category) 二次设置为覆盖；账本不存在抛错", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      setBudget(env.db, ledger.id, "", 10000);
      setBudget(env.db, ledger.id, "", 25000);
      const rows = getBudgets(env.db, ledger.id);
      assert.equal(rows.length, 1, "同范围应覆盖而非新增");
      assert.equal(rows[0]?.amount_cents, 25000);
      assert.equal(rows[0]?.category, "");
      assert.throws(() => setBudget(env.db, "missing", "", 100), /账本不存在/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("clearBudget 删除后 budgetStatus 回到 null / 不含该分类", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      setBudget(env.db, ledger.id, "", 10000);
      setBudget(env.db, ledger.id, "餐饮", 5000);
      assert.equal(budgetStatus(env.db, ledger.id, "2026-09").categories.length, 1);

      assert.equal(clearBudget(env.db, ledger.id, "餐饮"), true);
      const afterCategory = budgetStatus(env.db, ledger.id, "2026-09");
      assert.equal(afterCategory.categories.length, 0);
      assert.ok(afterCategory.total !== null, "总额预算仍在");

      assert.equal(clearBudget(env.db, ledger.id, ""), true);
      const afterTotal = budgetStatus(env.db, ledger.id, "2026-09");
      assert.equal(afterTotal.total, null);
      assert.equal(clearBudget(env.db, ledger.id, ""), false, "重复清除返回 false");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("budgetStatus 的 spent_cents 只算 ym 当月（每账本每月滚动）", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "滚动");
      setBudget(env.db, ledger.id, "", 100000);
      addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 30000,
        spentOn: "2026-08-10",
      });
      addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 20000,
        spentOn: "2026-09-05",
      });
      const sept = budgetStatus(env.db, ledger.id, "2026-09");
      assert.equal(sept.total?.spent_cents, 20000, "只应计入 9 月，不含 8 月");
      assert.equal(sept.total?.ratio, 0.2);
      const aug = budgetStatus(env.db, ledger.id, "2026-08");
      assert.equal(aug.total?.spent_cents, 30000);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("bookkeeping 预算：阈值触达提醒", () => {
  it("总额预算：跨 80% 推一条、跨 100% 推一条，同阈值不重推（dedupeKey）", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledger = JSON.parse(text(tool.ledger({ action: "create", name: "总额" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      const setResult = tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 1000 });
      assert.notEqual(setResult.isError, true, "设置预算应成功");

      tool.expense({ action: "add", ledger_id: ledgerId, amount: 500, category: "餐饮" }); // 50%
      assert.equal(tool.budgetAlerts().length, 0, "未跨阈值不推");

      tool.expense({ action: "add", ledger_id: ledgerId, amount: 300, category: "餐饮" }); // 80%
      const at80 = tool.budgetAlerts();
      assert.equal(at80.length, 1);
      assert.equal(at80[0]?.input.kind, "bookkeeping.budget");
      assert.match(at80[0]?.input.title ?? "", /预算提醒/);
      assert.match(at80[0]?.input.dedupeKey ?? "", /budget:.*:-:\d{4}-\d{2}:80$/);

      tool.expense({ action: "add", ledger_id: ledgerId, amount: 200, category: "餐饮" }); // 100%
      const at100 = tool.budgetAlerts().filter((p) => /:100$/.test(p.input.dedupeKey ?? ""));
      assert.equal(at100.length, 1);
      assert.match(at100[0]?.input.title ?? "", /预算超支/);

      tool.expense({ action: "add", ledger_id: ledgerId, amount: 100, category: "餐饮" }); // 110%
      assert.equal(tool.budgetAlerts().length, 2, "已越过的阈值不再重推");
      // 已达 100% 后继续加钱：不是「跨越」，连尝试都不应有
      assert.equal(
        tool.budgetAlertAttempts().filter((a) => /:80$/.test(a.dedupeKey ?? "")).length,
        1,
        "80% 只在跨越那一刻尝试一次",
      );

      // 删除后再记回：再次跨越 100%，但 dedupeKey 相同 → 被去重
      const list = JSON.parse(text(tool.expense({ action: "list", ledger_id: ledgerId }))) as {
        账目: { id: string; 金额: string }[];
      };
      const last200 = list.账目.find((r) => r.金额 === "¥200.00");
      assert.ok(last200 !== undefined);
      tool.expense({ action: "delete", id: last200.id }); // 删除不触发提醒
      assert.equal(tool.budgetAlerts().length, 2);
      tool.expense({ action: "add", ledger_id: ledgerId, amount: 200, category: "餐饮" }); // 再次跨 100%
      assert.equal(
        tool.budgetAlertAttempts().filter((a) => /:100$/.test(a.dedupeKey ?? "")).length,
        2,
        "两次跨越 100% 会有两次尝试",
      );
      assert.equal(tool.budgetAlerts().length, 2, "同月同阈值应被 dedupeKey 去重");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("单笔同时跨 80% 与 100%：同一预算只推最高阈值（反向断言 80% 不出现）", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledger = JSON.parse(text(tool.ledger({ action: "create", name: "阶梯" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 3000 });
      tool.expense({ action: "add", ledger_id: ledgerId, amount: 2000 }); // 66.7%：未跨阈值
      assert.equal(tool.budgetAlerts().length, 0);

      tool.expense({ action: "add", ledger_id: ledgerId, amount: 2000 }); // 一笔到 133%：同时跨 80/100
      const alerts = tool.budgetAlerts();
      assert.equal(alerts.length, 1, "同一预算一笔只推一条");
      assert.match(alerts[0]?.input.dedupeKey ?? "", /:100$/);
      assert.match(alerts[0]?.input.title ?? "", /预算超支/);
      assert.ok(
        !alerts.some((p) => /:80$/.test(p.input.dedupeKey ?? "")),
        "published 里不得出现该预算的 80% 那条",
      );
      assert.ok(
        !tool.budgetAlertAttempts().some((a) => /:80$/.test(a.dedupeKey ?? "")),
        "80% 连尝试都不应有",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("分类预算与总额预算并存：各推各的，互不替代", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledger = JSON.parse(text(tool.ledger({ action: "create", name: "并存" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 100 });
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 100, category: "餐饮" });

      tool.expense({ action: "add", ledger_id: ledgerId, amount: 80, category: "餐饮" });
      const at80 = tool.budgetAlerts();
      assert.equal(at80.length, 2, "总额与分类各推一条 80%");
      assert.equal(new Set(at80.map((p) => p.input.dedupeKey)).size, 2, "dedupeKey 互不相同");

      tool.expense({ action: "add", ledger_id: ledgerId, amount: 20, category: "餐饮" });
      const at100 = tool.budgetAlerts().filter((p) => /:100$/.test(p.input.dedupeKey ?? ""));
      assert.equal(at100.length, 2, "总额与分类各推一条 100%");
      assert.ok(
        at100.some((p) => p.input.dedupeKey?.includes(":餐饮:")),
        "应含分类预算的超支提醒",
      );
      assert.ok(
        at100.some((p) => p.input.dedupeKey?.includes(":-:")),
        "应含总额预算的超支提醒",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨月重置：dedupeKey 带 ym，新月份第一笔重新判定", (t) => {
    freeze(t, "2026-09-15");
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledger = JSON.parse(text(tool.ledger({ action: "create", name: "跨月" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 1000 });
      tool.expense({ action: "add", ledger_id: ledgerId, amount: 1200 });
      const sept = tool.budgetAlerts();
      assert.equal(sept.length, 1, "9 月一笔从 0 跨到 120%：只推跨过的最高阈值 100%");
      assert.match(sept[0]?.input.dedupeKey ?? "", /:2026-09:100$/);
      assert.ok(
        !sept.some((p) => /:2026-09:80$/.test(p.input.dedupeKey ?? "")),
        "同一笔不得再推该预算的 80%",
      );

      t.mock.timers.setTime(Date.parse("2026-10-05T10:00:00+08:00"));
      tool.expense({ action: "add", ledger_id: ledgerId, amount: 900 });
      const all = tool.budgetAlerts();
      const oct = all.filter((p) => p.input.dedupeKey?.includes(":2026-10:"));
      assert.equal(all.length - sept.length, 1, "10 月第一笔应重新判定并推一条");
      assert.equal(oct.length, 1);
      assert.match(oct[0]?.input.dedupeKey ?? "", /:2026-10:80$/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未设预算的账本：记账后没有任何 bookkeeping.budget", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledger = JSON.parse(text(tool.ledger({ action: "create", name: "无预算" }))) as {
        已创建: { id: string };
      };
      tool.expense({
        action: "add",
        ledger_id: ledger.已创建.id,
        amount: 999999,
        category: "大额",
      });
      assert.equal(tool.budgetAlerts().length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("提醒块的表格能看出 预算 / 已用 / 剩余 / 占比，并点明范围", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledger = JSON.parse(text(tool.ledger({ action: "create", name: "表格" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 1000 });
      tool.expense({ action: "add", ledger_id: ledgerId, amount: 900, category: "餐饮" });
      const alert = tool.budgetAlerts()[0];
      assert.ok(alert !== undefined);
      const table = alert.input.blocks.table;
      assert.ok(table !== undefined);
      assert.deepEqual(table.columns, ["项目", "预算", "已用", "剩余", "占比"]);
      const row = table.rows[0] ?? [];
      assert.equal(row[0], "总额");
      assert.equal(row[1], "¥1000.00");
      assert.equal(row[2], "¥900.00");
      assert.equal(row[3], "¥100.00");
      assert.equal(row[4], "90.0%");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("bookkeeping 预算：ledger {action:'budget'} 工具", () => {
  it("只传 ledger_id 返回全部预算与本月对照", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledger = JSON.parse(text(tool.ledger({ action: "create", name: "查询" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 1000 });
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 200, category: "餐饮" });
      const result = JSON.parse(text(tool.ledger({ action: "budget", ledger_id: ledgerId }))) as {
        账本: string;
        月份: string;
        预算: { 范围: string; 预算: string }[];
        本月对照: { 总额: { 预算: string } | null; 分类: { 分类: string }[] };
      };
      assert.equal(result.账本, "查询");
      assert.equal(result.预算.length, 2);
      assert.ok(result.本月对照.总额 !== null);
      assert.equal(result.本月对照.分类[0]?.分类, "餐饮");
      assert.equal(
        tool.ledger({ action: "budget", ledger_id: "missing" }).isError,
        true,
        "账本不存在应报错",
      );
      assert.equal(tool.ledger({ action: "budget" }).isError, true, "缺 ledger_id 应报错");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("clear:true 删除该范围预算并回显", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledger = JSON.parse(text(tool.ledger({ action: "create", name: "清除" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 1000 });
      const cleared = JSON.parse(
        text(tool.ledger({ action: "budget", ledger_id: ledgerId, clear: true })),
      ) as { 已清除: { 范围: string } };
      assert.equal(cleared.已清除.范围, "总额");
      const after = JSON.parse(text(tool.ledger({ action: "budget", ledger_id: ledgerId }))) as {
        预算: unknown[];
        本月对照: { 总额: unknown | null };
      };
      assert.equal(after.预算.length, 0);
      assert.equal(after.本月对照.总额, null);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("amount 非法（0 / 负数 / 超上限）返回 fail 且库里无行", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledger = JSON.parse(text(tool.ledger({ action: "create", name: "校验" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      assert.equal(tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 0 }).isError, true);
      assert.equal(
        tool.ledger({ action: "budget", ledger_id: ledgerId, amount: -5 }).isError,
        true,
      );
      assert.equal(
        tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 1_000_001 }).isError,
        true,
      );
      assert.equal(getBudgets(env.db, ledgerId).length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("bookkeeping 预算：月报增强", () => {
  it("设了预算 → 月报追加预算对照；没设 → 与既有断言一致", async () => {
    const env = makeTestEnv();
    try {
      const withBudget = createLedger(env.db, "有预算");
      addExpense(env.db, "default", {
        ledgerId: withBudget.id,
        amountCents: 80000,
        spentOn: "2026-09-05",
      });
      setBudget(env.db, withBudget.id, "", 100000);

      const noBudget = createLedger(env.db, "无预算");
      addExpense(env.db, "default", {
        ledgerId: noBudget.id,
        amountCents: 5000,
        spentOn: "2026-09-06",
      });

      await pushMonthlyReports(env.db, makeServices(env), "2026-09");

      const withPub = env.published.find((p) => p.input.title.includes("有预算")) as Published;
      const noPub = env.published.find((p) => p.input.title.includes("无预算")) as Published;
      assert.ok(withPub !== undefined && noPub !== undefined);

      const withNotes = withPub.input.blocks.notes ?? [];
      const budgetLine = withNotes.find((n) => n.includes("预算"));
      assert.ok(budgetLine !== undefined, "设了预算应有预算对照");
      assert.match(budgetLine ?? "", /¥1000\.00/);
      assert.match(budgetLine ?? "", /¥800\.00/);
      assert.match(budgetLine ?? "", /80\.0%/);

      // 没设预算：不出现任何「预算」噪音，且表格仍以合计结尾
      const noNotes = noPub.input.blocks.notes ?? [];
      assert.ok(!noNotes.some((n) => n.includes("预算")), "未设预算不应有预算行");
      const rows = noPub.input.blocks.table?.rows ?? [];
      assert.deepEqual(rows[rows.length - 1], ["合计", "¥50.00", "100%"]);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

/** 用真实 notifications 表模拟 publishGlobal 的 Profile 内去重（与既有测试一致） */
function makeServices(env: TestEnv) {
  return {
    publishGlobal: async (input: { kind: string; title: string; dedupeKey?: string }) => {
      const existing = env.db
        .prepare("SELECT 1 FROM notifications WHERE profile_id = 'default' AND dedupe_key = ?")
        .get(input.dedupeKey ?? null);
      if (existing !== undefined) return { materialized: 0 };
      env.db
        .prepare(
          "INSERT INTO notifications (id, profile_id, kind, title, body_md, dedupe_key, read, created_at) VALUES (?, 'default', ?, ?, '', ?, 0, ?)",
        )
        .run(
          `n-${env.published.length + 1}`,
          input.kind,
          input.title,
          input.dedupeKey ?? null,
          new Date().toISOString(),
        );
      env.published.push({ profileId: "*", input: input as never });
      return { materialized: 1 };
    },
  };
}
