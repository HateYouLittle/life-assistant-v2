import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addExpense,
  budgetStatus,
  clearBudget,
  createLedger,
  getBudgets,
  setBudget,
} from "../src/modules/bookkeeping/service.js";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function makeTools(env: TestEnv, profileId = "default") {
  const ctx = {
    profileId,
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async () => ({ materialized: 0 }),
    },
  };
  return {
    ledger: (args: Record<string, unknown>) => bookkeepingLedgerTool(args, ctx),
    expense: (args: Record<string, unknown>) => bookkeepingExpenseTool(args, ctx),
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
      // 缺 ledger_id 时走默认账本：该 Profile 只有这一个可写账本，直接用它
      const byDefault = JSON.parse(text(tool.ledger({ action: "budget" }))) as { 账本: string };
      assert.equal(byDefault.账本, "查询");
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
