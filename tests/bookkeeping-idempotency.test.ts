import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import {
  addExpenseChecked,
  findExpenseByClientToken,
  getExpense,
  listExpenses,
  setBudget,
  createLedger,
} from "../src/modules/bookkeeping/service.js";
import { cleanupTestEnv, makeTestEnv, type Published, type TestEnv } from "./helpers.js";

/**
 * 写路径幂等键（P1-12c）：`expense add` 的 request_id → expenses.client_token。
 *
 * 语义：同一 Profile 用同一个 request_id 重试，永远不会落第二行；第二次返回首次记录
 * 并附「已存在: true」，且**不重复发回执/预算提醒**（重复推送是这类重试最烦人的后果）。
 * 幂等范围是 (created_by_profile, client_token)，不同人的同名 request_id 互不影响。
 */

function tools(env: TestEnv, profileId = "default") {
  const ctx = {
    profileId,
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
  };
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function createLedgerId(t: ReturnType<typeof tools>, name: string): string {
  const created = JSON.parse(text(t.ledger({ action: "create", name }))) as {
    已创建: { id: string };
  };
  return created.已创建.id;
}

function rowCount(env: TestEnv): number {
  return (env.db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as { n: number }).n;
}

interface AddReceipt {
  已记账: {
    id: string;
    账本: string;
    金额: string;
    分类: string;
    日期: string;
    记账人: string;
  };
  已存在?: boolean;
  常用分类?: string[];
}

describe("bookkeeping 幂等：request_id → client_token", () => {
  it("同 request_id 调两次只落一行，第二次回执形状一致并带 已存在: true", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "幂等账本");
      const first = JSON.parse(
        text(
          t.expense({
            action: "add",
            ledger_id: ledgerId,
            amount: 12.34,
            category: "餐饮",
            request_id: "req-0001",
          }),
        ),
      ) as AddReceipt;
      assert.equal(first.已记账.金额, "¥12.34");
      assert.equal(first.已存在, undefined, "首次成功不应带 已存在");

      const retry = JSON.parse(
        text(
          t.expense({
            action: "add",
            ledger_id: ledgerId,
            amount: 12.34,
            category: "餐饮",
            request_id: "req-0001",
          }),
        ),
      ) as AddReceipt;
      assert.equal(retry.已记账.id, first.已记账.id, "重试必须返回首次写入的那一行");
      assert.equal(retry.已存在, true, "命中幂等键的回执要明确标注已存在");
      assert.deepEqual(retry.已记账, first.已记账, "回执形状必须与首次成功一致");
      assert.equal(rowCount(env), 1, "同 request_id 不能落第二行");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("重试不重复发通知：回执与预算提醒各只发一次", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "幂等预算");
      t.ledger({ action: "budget", ledger_id: ledgerId, amount: 100 });
      // 第一笔 500 元：一笔从 0 跨到 500%，只推最高阈值 100%，同时发一条回执
      t.expense({ action: "add", ledger_id: ledgerId, amount: 500, request_id: "req-budget" });
      const kindsAfterFirst = env.published.map((p) => p.input.kind);
      assert.deepEqual(
        kindsAfterFirst.sort(),
        ["bookkeeping.budget", "bookkeeping.entry"],
        "首次成功应发回执与预算超支提醒各一条",
      );

      env.published.length = 0;
      const retry = JSON.parse(
        text(
          t.expense({
            action: "add",
            ledger_id: ledgerId,
            amount: 500,
            request_id: "req-budget",
          }),
        ),
      ) as AddReceipt;
      assert.equal(retry.已存在, true);
      assert.equal(env.published.length, 0, "幂等命中不得重发回执或预算提醒");
      assert.equal(rowCount(env), 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("不同人用同一个 request_id 互不影响（幂等范围按创建人隔离）", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const partner = tools(env, "partner");
    try {
      const ledgerId = createLedgerId(owner, "共享家庭");
      const mine = JSON.parse(
        text(
          owner.expense({
            action: "add",
            ledger_id: ledgerId,
            amount: 10,
            request_id: "same-token",
          }),
        ),
      ) as AddReceipt;
      const theirs = JSON.parse(
        text(
          partner.expense({
            action: "add",
            ledger_id: ledgerId,
            amount: 20,
            request_id: "same-token",
          }),
        ),
      ) as AddReceipt;

      assert.notEqual(mine.已记账.id, theirs.已记账.id, "不同人的同名 token 不是同一次请求");
      assert.equal(theirs.已存在, undefined);
      assert.equal(mine.已记账.记账人, "default");
      assert.equal(theirs.已记账.记账人, "partner");
      assert.equal(rowCount(env), 2);
      assert.equal(
        env.published.filter((p) => p.input.kind === "bookkeeping.entry").length,
        2,
        "两笔都是真实新增，各发一条回执",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("不同 request_id 或不带 request_id：各记一笔", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "多笔");
      t.expense({ action: "add", ledger_id: ledgerId, amount: 1, request_id: "a" });
      t.expense({ action: "add", ledger_id: ledgerId, amount: 2, request_id: "b" });
      t.expense({ action: "add", ledger_id: ledgerId, amount: 3 });
      t.expense({ action: "add", ledger_id: ledgerId, amount: 4 });
      assert.equal(rowCount(env), 4);
      assert.equal(listExpenses(env.db, ledgerId).total, 4);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("request_id 非法（空白/超长/非字符串）直接 fail，且不落库", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "校验");
      for (const bad of ["", "   ", "x".repeat(129), 123, { id: "x" }, null]) {
        const result = t.expense({
          action: "add",
          ledger_id: ledgerId,
          amount: 5,
          request_id: bad,
        });
        assert.equal(result.isError, true, `非法 request_id 应报错: ${JSON.stringify(bad)}`);
        assert.match(text(result), /request_id 不合法/);
      }
      assert.equal(rowCount(env), 0, "校验失败不得落任何行");
      assert.equal(env.published.length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("回执 dedupeKey 由 request_id 派生（不含随机 id），重试得到同一个键", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "去重键");
      const first = JSON.parse(
        text(t.expense({ action: "add", ledger_id: ledgerId, amount: 9, request_id: "req-key" })),
      ) as AddReceipt;
      const receipt = env.published.find((p) => p.input.kind === "bookkeeping.entry") as Published;
      assert.equal(receipt.input.dedupeKey, "entry:req:default:req-key");
      assert.ok(
        !(receipt.input.dedupeKey ?? "").includes(first.已记账.id),
        "键里不应含随机生成的账目 id",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("重试时即使传了不同的金额/账本，也返回首次那一行（同一请求只执行一次）", () => {
    const env = makeTestEnv();
    try {
      const ledgerA = createLedger(env.db, "A");
      const ledgerB = createLedger(env.db, "B");
      const first = addExpenseChecked(env.db, "default", {
        ledgerId: ledgerA.id,
        amountCents: 1000,
        clientToken: "svc-token",
      });
      assert.equal(first.reused, false);
      const retry = addExpenseChecked(env.db, "default", {
        ledgerId: ledgerB.id,
        amountCents: 9999,
        clientToken: "svc-token",
      });
      assert.equal(retry.reused, true);
      assert.equal(retry.entry.id, first.entry.id);
      assert.equal(retry.entry.ledger_id, ledgerA.id, "不得因重试参数变化而改写原记录");
      assert.equal(retry.entry.amount_cents, 1000);

      // 查回入口与唯一索引口径一致：按 (创建人, token) 定位
      assert.equal(findExpenseByClientToken(env.db, "default", "svc-token")?.id, first.entry.id);
      assert.equal(findExpenseByClientToken(env.db, "partner", "svc-token"), undefined);
      assert.equal(getExpense(env.db, first.entry.id)?.amount_cents, 1000);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("预算提醒按「这笔支出所属月份」判定（幂等重试不影响跨月口径）", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "跨月幂等");
      setBudget(env.db, ledgerId, "", 100_00);
      // 补记两个月前的支出：提醒必须按 2026-08 口径，而不是今天所在月份
      const result = t.expense({
        action: "add",
        ledger_id: ledgerId,
        amount: 120,
        date: "2026-08-10",
        request_id: "past-month",
      });
      assert.notEqual(result.isError, true, text(result));
      const alert = env.published.find((p) => p.input.kind === "bookkeeping.budget");
      assert.ok(alert !== undefined, "补记历史月份跨越阈值仍应提醒（标题带月份）");
      assert.match(alert.input.title, /2026-08/);

      env.published.length = 0;
      t.expense({
        action: "add",
        ledger_id: ledgerId,
        amount: 120,
        date: "2026-08-10",
        request_id: "past-month",
      });
      assert.equal(env.published.length, 0, "幂等重试不得再次告警");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
