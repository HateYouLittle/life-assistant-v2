import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import { createLedger } from "../src/modules/bookkeeping/service.js";
import { todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * P2-21 / M-05 回归：共享 inputSchema 暴露全部 action 的字段，但 handler 只读其中一部分。
 * 未列出的字段此前被**静默忽略**（`export` 带 by/limit 仍导出当月全部、非 budget 的
 * amount 被丢弃）——「成功返回但语义错误」比报错更难发现。现在按 action 白名单显式拒绝，
 * 文案与 notify 侧一致：`未知字段: <名>（action=<action> 不接受）`。
 */

function tools(env: TestEnv, profileId = "default") {
  const ctx = {
    profileId,
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async () => ({ materialized: 1 }),
    },
  };
  return {
    ledger: (args: Record<string, unknown>) => bookkeepingLedgerTool(args, ctx),
    expense: (args: Record<string, unknown>) => bookkeepingExpenseTool(args, ctx),
  };
}

function text(result: { content: { text: string }[] }): string {
  return (result.content[0]?.text ?? "").trim();
}

function isErrorOf(result: { isError?: boolean }): boolean {
  return result.isError === true;
}

/** 断言：被拒绝，且文案正是统一格式（改错即失败） */
function assertUnknownField(
  result: { content: { text: string }[]; isError?: boolean },
  field: string,
  action: string,
): void {
  assert.equal(isErrorOf(result), true, `${action} 传 ${field} 应被拒绝：${text(result)}`);
  assert.equal(text(result), `错误：未知字段: ${field}（action=${action} 不接受）`);
}

describe("P2-21 未知字段显式拒绝", () => {
  it("export 传 by/limit → 明确 fail（不再静默导出当月全部）", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      const t = tools(env);
      assertUnknownField(
        t.expense({ action: "export", ledger_id: ledger.id, by: "alice" }),
        "by",
        "export",
      );
      assertUnknownField(
        t.expense({ action: "export", ledger_id: ledger.id, limit: 10 }),
        "limit",
        "export",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("ledger 传 amount/category/clear 但 action 不是 budget → 明确 fail", () => {
    const env = makeTestEnv();
    try {
      const t = tools(env);
      assertUnknownField(
        t.ledger({ action: "create", name: "日用", amount: 500 }),
        "amount",
        "create",
      );
      assertUnknownField(t.ledger({ action: "list", category: "餐饮" }), "category", "list");
      assertUnknownField(
        t.ledger({ action: "rename", id: "x", name: "y", clear: true }),
        "clear",
        "rename",
      );
      // budget 自己的参数不受影响
      const created = JSON.parse(text(t.ledger({ action: "create", name: "日用" }))) as {
        已创建: { id: string };
      };
      const budget = t.ledger({
        action: "budget",
        ledger_id: created.已创建.id,
        amount: 500,
        category: "餐饮",
      });
      assert.equal(isErrorOf(budget), false, text(budget));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("add 传 ledger 简写 → 明确 fail（此前静默记到默认账本）", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      const t = tools(env);
      assertUnknownField(
        t.expense({ action: "add", ledger: ledger.name, amount: 12 }),
        "ledger",
        "add",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("set_default_ledger 的 ledger 简写不误伤；add 用 ledger_id 正常", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      const t = tools(env);
      const viaShorthand = t.expense({ action: "set_default_ledger", ledger: ledger.id });
      assert.equal(isErrorOf(viaShorthand), false, text(viaShorthand));
      const viaId = t.expense({ action: "set_default_ledger", ledger_id: ledger.id });
      assert.equal(isErrorOf(viaId), false, text(viaId));
      // 白名单生效后 add 仍按默认账本记账
      const added = t.expense({ action: "add", amount: 12 });
      assert.equal(isErrorOf(added), false, text(added));
      assert.match(text(added), /日用/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("既有更具体的拒绝文案保留：export 的 from/to、update 的 ledger_id", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      const t = tools(env);
      const from = t.expense({ action: "export", ledger_id: ledger.id, from: `${todayIso()}-01` });
      assert.equal(isErrorOf(from), true);
      assert.match(text(from), /只支持按自然月/);

      const added = JSON.parse(text(t.expense({ action: "add", amount: 12 }))) as {
        已记账: { id: string };
      };
      const move = t.expense({ action: "update", id: added.已记账.id, ledger_id: ledger.id });
      assert.equal(isErrorOf(move), true);
      assert.match(text(move), /不支持更换账本/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("值为 undefined 的键不算「传了字段」", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      const t = tools(env);
      const listed = t.expense({
        action: "list",
        ledger_id: ledger.id,
        amount: undefined,
        by: undefined,
      });
      assert.equal(isErrorOf(listed), false, text(listed));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("各 action 的正常参数不回归", () => {
    const env = makeTestEnv();
    try {
      const t = tools(env);
      const created = JSON.parse(
        text(t.ledger({ action: "create", name: "日用", personal: false })),
      ) as {
        已创建: { id: string };
      };
      const id = created.已创建.id;
      const ok = (result: { content: { text: string }[]; isError?: boolean }, why: string) => {
        assert.equal(isErrorOf(result), false, `${why}: ${text(result)}`);
      };
      ok(t.ledger({ action: "list", include_archived: true }), "ledger list");
      ok(t.ledger({ action: "rename", id, name: "日常开销" }), "ledger rename");
      ok(t.ledger({ action: "archive", id, unarchive: true }), "ledger archive");
      ok(t.ledger({ action: "budget", ledger_id: id }), "ledger budget");

      const added = JSON.parse(
        text(
          t.expense({
            action: "add",
            ledger_id: id,
            amount: 12,
            category: "餐饮",
            note: "午饭",
            date: todayIso(),
            request_id: "req-1",
          }),
        ),
      ) as { 已记账: { id: string } };
      const expenseId = added.已记账.id;
      ok(t.expense({ action: "list", ledger_id: id, limit: 5, offset: 0 }), "expense list");
      ok(
        t.expense({ action: "list", ledger_id: id, month: todayIso().slice(0, 7) }),
        "expense list month",
      );
      ok(t.expense({ action: "summary", ledger_id: id, by: "default" }), "expense summary");
      ok(t.expense({ action: "update", id: expenseId, amount: 15, note: "" }), "expense update");
      ok(
        t.expense({ action: "export", ledger_id: id, month: todayIso().slice(0, 7) }),
        "expense export",
      );
      ok(t.expense({ action: "categories" }), "expense categories");
      ok(
        t.expense({ action: "category_alias", category: "餐饮", alias: "吃饭" }),
        "expense category_alias",
      );
      ok(t.expense({ action: "delete", id: expenseId }), "expense delete");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未知 action 仍报 `未知 action`（白名单不改变未知分支语义）", () => {
    const env = makeTestEnv();
    try {
      const t = tools(env);
      const result = t.expense({ action: "bogus", by: "alice" });
      assert.equal(isErrorOf(result), true);
      assert.match(text(result), /未知 action: bogus/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
