import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import { getBudgets } from "../src/modules/bookkeeping/service.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * B2 回归：`ledger {action:"budget"}` 的分类必须与 `expense add/update` 走同一份分类字典
 * 归一。否则用户用别名（「吃饭」）设的预算会落在别名文本下、而归一后的支出记在标准名
 * （「餐饮」）下：已用恒为 0、80%/100% 阈值提醒永不触发，且没有任何提示。
 */

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function payload<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(text(result)) as T;
}

function makeTools(env: TestEnv) {
  const ctx = {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async (input: { kind: string; dedupeKey?: string }) => {
        env.published.push({ profileId: "*", input: input as never });
        return { materialized: 1 };
      },
    },
  };
  return {
    ledger: (args: Record<string, unknown>) => bookkeepingLedgerTool(args, ctx),
    expense: (args: Record<string, unknown>) => bookkeepingExpenseTool(args, ctx),
    budgetAlerts: () => env.published.filter((p) => p.input.kind === "bookkeeping.budget"),
  };
}

function createLedger(tool: ReturnType<typeof makeTools>, name: string): string {
  const created = payload<{ 已创建: { id: string } }>(tool.ledger({ action: "create", name }));
  return created.已创建.id;
}

/** 直接插入一条「旧版本写入路径」的预算行（未归一：category 为别名原文） */
function insertLegacyBudget(
  env: TestEnv,
  ledgerId: string,
  category: string,
  amountCents: number,
): void {
  env.db
    .prepare(
      `INSERT INTO budgets (id, ledger_id, category, amount_cents, created_at, updated_at)
       VALUES (?, ?, ?, ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(`legacy-${category}`, ledgerId, category, amountCents);
}

describe("ledger budget：分类别名归一（B2）", () => {
  it("别名设预算 + 别名记账：预算命中标准名，已用正确并能触发 100% 提醒", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedger(tool, "别名预算");
      const alias = payload<{ 分类: { 名称: string } }>(
        tool.expense({ action: "category_alias", category: "餐饮", alias: "吃饭" }),
      );
      assert.equal(alias.分类.名称, "餐饮");

      const set = payload<{
        已设置: { 范围: string; 预算: string };
        分类归一?: string;
      }>(tool.ledger({ action: "budget", ledger_id: ledgerId, category: "吃饭", amount: 10 }));
      assert.equal(set.已设置.范围, "餐饮", "预算范围必须落在字典标准名上");
      assert.equal(set.分类归一, "餐饮", "归一回显：让调用方知道「吃饭」被记到了「餐饮」");
      assert.deepEqual(
        getBudgets(env.db, ledgerId).map((b) => b.category),
        ["餐饮"],
        "库里不得留下别名文本的预算",
      );

      // 记账写别名（会被归一成「餐饮」），金额超过 ¥10 预算 → 跨 100%
      const added = payload<{ 已记账: { 分类: string } }>(
        tool.expense({ action: "add", ledger_id: ledgerId, amount: 12, category: "吃饭" }),
      );
      assert.equal(added.已记账.分类, "餐饮");

      const status = payload<{
        本月对照: { 分类: Array<{ 分类: string; 已用: string }> };
      }>(tool.ledger({ action: "budget", ledger_id: ledgerId }));
      assert.equal(status.本月对照.分类[0]?.分类, "餐饮");
      assert.equal(status.本月对照.分类[0]?.已用, "¥12.00", "已用必须包含这笔归一到「餐饮」的支出");

      const alerts = tool.budgetAlerts();
      assert.equal(alerts.length, 1, "跨越 100% 必须触发预算提醒");
      assert.match(alerts[0]?.input.dedupeKey ?? "", /:餐饮:\d{4}-\d{2}:100$/);
      assert.match(alerts[0]?.input.title ?? "", /分类「餐饮」/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("clear 也用别名：能删掉标准名下的同一份预算", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedger(tool, "别名清除");
      tool.expense({ action: "category_alias", category: "交通", alias: "打车" });
      tool.ledger({ action: "budget", ledger_id: ledgerId, category: "打车", amount: 50 });
      const cleared = payload<{ 已清除: { 范围: string; 删除: boolean } }>(
        tool.ledger({ action: "budget", ledger_id: ledgerId, category: "打车", clear: true }),
      );
      assert.equal(cleared.已清除.范围, "交通");
      assert.equal(cleared.已清除.删除, true);
      assert.deepEqual(getBudgets(env.db, ledgerId), []);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未命中字典的自由文本分类原样保留（不强行归到默认分类）", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedger(tool, "自由分类");
      const set = payload<{ 已设置: { 范围: string } }>(
        tool.ledger({ action: "budget", ledger_id: ledgerId, category: "宠物", amount: 100 }),
      );
      assert.equal(set.已设置.范围, "宠物");
      const added = payload<{ 已记账: { 分类: string } }>(
        tool.expense({ action: "add", ledger_id: ledgerId, amount: 8, category: "宠物" }),
      );
      assert.equal(added.已记账.分类, "宠物");
      const status = payload<{
        本月对照: { 分类: Array<{ 分类: string; 已用: string }> };
      }>(tool.ledger({ action: "budget", ledger_id: ledgerId }));
      assert.equal(status.本月对照.分类[0]?.已用, "¥8.00");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("ledger budget：存量别名预算行（M5）", () => {
  it("用别名重新设预算：清掉旧原文行，只留归一后的标准名一条", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedger(tool, "存量别名");
      tool.expense({ action: "category_alias", category: "餐饮", alias: "吃饭" });
      // 旧版本只归一写入路径，库里可能已有 category='吃饭' 的预算行
      insertLegacyBudget(env, ledgerId, "吃饭", 1000);
      assert.deepEqual(
        getBudgets(env.db, ledgerId).map((b) => b.category),
        ["吃饭"],
      );

      payload<{ 已设置: { 范围: string } }>(
        tool.ledger({ action: "budget", ledger_id: ledgerId, category: "吃饭", amount: 20 }),
      );
      const budgets = getBudgets(env.db, ledgerId);
      assert.deepEqual(
        budgets.map((b) => [b.category, b.amount_cents]),
        [["餐饮", 2000]],
        "重设后不得与旧原文行并存（否则对照表出现两条同义分类）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("clear 别名：旧原文行与归一后的行都清掉", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedger(tool, "存量清除");
      tool.expense({ action: "category_alias", category: "交通", alias: "打车" });
      insertLegacyBudget(env, ledgerId, "打车", 5000);
      tool.ledger({ action: "budget", ledger_id: ledgerId, category: "打车", amount: 60 });
      assert.equal(getBudgets(env.db, ledgerId).length, 1, "重设后只剩归一后的行");

      const cleared = payload<{ 已清除: { 删除: boolean } }>(
        tool.ledger({ action: "budget", ledger_id: ledgerId, category: "打车", clear: true }),
      );
      assert.equal(cleared.已清除.删除, true);
      assert.deepEqual(getBudgets(env.db, ledgerId), []);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("clear 别名时旧原文行单独存在也能清掉", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedger(tool, "仅旧行");
      tool.expense({ action: "category_alias", category: "购物", alias: "买买买" });
      insertLegacyBudget(env, ledgerId, "买买买", 3000);

      const cleared = payload<{ 已清除: { 删除: boolean; 范围: string } }>(
        tool.ledger({ action: "budget", ledger_id: ledgerId, category: "买买买", clear: true }),
      );
      assert.equal(cleared.已清除.删除, true, "只存在旧原文行时清除也必须生效");
      assert.equal(cleared.已清除.范围, "购物");
      assert.deepEqual(getBudgets(env.db, ledgerId), []);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("ledger budget：用标准名重设/清除也清旧别名行（J3）", () => {
  it("种子旧别名行 + 用标准名重设：只剩标准名一条", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedger(tool, "标准名重设");
      tool.expense({ action: "category_alias", category: "餐饮", alias: "吃饭" });
      insertLegacyBudget(env, ledgerId, "吃饭", 1000);

      payload<{ 已设置: { 范围: string } }>(
        tool.ledger({ action: "budget", ledger_id: ledgerId, category: "餐饮", amount: 20 }),
      );
      const budgets = getBudgets(env.db, ledgerId);
      assert.deepEqual(
        budgets.map((row) => [row.category, row.amount_cents]),
        [["餐饮", 2000]],
        "用标准名重设必须把同义的旧别名行一起清掉（否则两条同义预算并存）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("用标准名 clear：同时清掉旧别名行", () => {
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedger(tool, "标准名清除");
      tool.expense({ action: "category_alias", category: "交通", alias: "打车" });
      payload<{ 已设置: { 范围: string } }>(
        tool.ledger({ action: "budget", ledger_id: ledgerId, category: "交通", amount: 60 }),
      );
      // 再塞一条旧别名行（模拟旧版本遗留 / 手工改库）
      insertLegacyBudget(env, ledgerId, "打车", 5000);
      assert.equal(getBudgets(env.db, ledgerId).length, 2, "构造前提：同义两行并存");

      const cleared = payload<{ 已清除: { 删除: boolean; 范围: string } }>(
        tool.ledger({ action: "budget", ledger_id: ledgerId, category: "交通", clear: true }),
      );
      assert.equal(cleared.已清除.范围, "交通");
      assert.equal(cleared.已清除.删除, true);
      assert.deepEqual(getBudgets(env.db, ledgerId), [], "残留的别名旧行也必须一并清除");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
