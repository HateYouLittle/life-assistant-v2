import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import { createLedger, listExpenses } from "../src/modules/bookkeeping/service.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * MCP 明细分页：listExpenses / expense {action:"list", offset}。
 * 200 条上限 + 无游标会让「这个月到底花了多少笔」看不全；加 offset 后必须保证
 * 翻页不重叠不跳过、最后一页 还有更多=false、越界 offset 返回空而不是报错。
 */

/** 造 n 笔支出：spent_on 从 2026-09-01 递增，金额 100+i 分，排序固定可断言 */
function seedPage(env: TestEnv, ledgerId: string, n: number): void {
  const insert = env.db.prepare(
    `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
     VALUES (?, ?, ?, '餐饮', ?, 'default', '2026-01-01T00:00:00.000Z')`,
  );
  for (let i = 1; i <= n; i++) {
    const day = String(i).padStart(2, "0");
    insert.run(`e${day}`, ledgerId, 100 + i, `2026-09-${day}`);
  }
}

function idsOf(page: { rows: { id: string }[] }): string[] {
  return page.rows.map((row) => row.id);
}

function tools(env: TestEnv) {
  const ctx = {
    profileId: "default",
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
  return result.content[0]?.text ?? "";
}

interface ListResult {
  账目: { id: string; 日期: string }[];
  已返回: number;
  偏移: number;
  匹配总数: number;
  还有更多: boolean;
}

describe("listExpenses：offset 分页（service）", () => {
  it("三页翻完不重叠不跳过，最后一页还有更多=false", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "分页账本");
      seedPage(env, ledger.id, 25);

      const page0 = listExpenses(env.db, ledger.id, { limit: 10 });
      assert.equal(page0.rows.length, 10);
      assert.equal(page0.total, 25);
      assert.equal(page0.hasMore, true, "第一页后面还有");
      assert.equal(page0.rows[0]?.spent_on, "2026-09-25", "按 spent_on 降序");

      const page1 = listExpenses(env.db, ledger.id, { limit: 10, offset: 10 });
      assert.equal(page1.rows.length, 10);
      assert.equal(page1.hasMore, true);
      assert.deepEqual(
        idsOf(page0).filter((id) => idsOf(page1).includes(id)),
        [],
        "相邻页不得重叠",
      );

      const page2 = listExpenses(env.db, ledger.id, { limit: 10, offset: 20 });
      assert.equal(page2.rows.length, 5);
      assert.equal(page2.hasMore, false, "最后一页不能再说「还有更多」（否则调用方会空翻）");

      const all = [...idsOf(page0), ...idsOf(page1), ...idsOf(page2)];
      assert.equal(all.length, 25, "三页恰好覆盖全部");
      assert.equal(new Set(all).size, 25, "翻页不重复");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("offset 超总数返回空页且不报错；负数/NaN 回退 0", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "边界");
      seedPage(env, ledger.id, 3);

      const beyond = listExpenses(env.db, ledger.id, { limit: 10, offset: 100 });
      assert.deepEqual(beyond.rows, []);
      assert.equal(beyond.total, 3);
      assert.equal(beyond.hasMore, false);

      const negative = listExpenses(env.db, ledger.id, { limit: 10, offset: -5 });
      assert.deepEqual(idsOf(negative), idsOf(listExpenses(env.db, ledger.id, { limit: 10 })));
      assert.equal(negative.rows.length, 3, "负数 offset 当作 0（不报错也不空页）");

      const nan = listExpenses(env.db, ledger.id, { limit: 10, offset: Number.NaN });
      assert.equal(nan.rows.length, 3, "NaN offset 回退 0");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("expense {action:'list'}：offset 与分页回执", () => {
  it("输出 已返回/偏移/匹配总数/还有更多，翻页与 service 一致", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const created = JSON.parse(text(t.ledger({ action: "create", name: "工具分页" }))) as {
        已创建: { id: string };
      };
      const ledgerId = created.已创建.id;
      seedPage(env, ledgerId, 25);

      const first = JSON.parse(
        text(t.expense({ action: "list", ledger_id: ledgerId, limit: 10 })),
      ) as ListResult;
      assert.equal(first.已返回, 10);
      assert.equal(first.偏移, 0);
      assert.equal(first.匹配总数, 25);
      assert.equal(first.还有更多, true);

      const second = JSON.parse(
        text(t.expense({ action: "list", ledger_id: ledgerId, limit: 10, offset: 10 })),
      ) as ListResult;
      assert.equal(second.偏移, 10, "回显实际生效的偏移");
      assert.equal(second.还有更多, true);
      assert.deepEqual(
        first.账目.filter((row) => second.账目.some((other) => other.id === row.id)),
        [],
        "相邻页不重叠",
      );

      const last = JSON.parse(
        text(t.expense({ action: "list", ledger_id: ledgerId, limit: 10, offset: 20 })),
      ) as ListResult;
      assert.equal(last.已返回, 5);
      assert.equal(last.还有更多, false);

      const beyond = JSON.parse(
        text(t.expense({ action: "list", ledger_id: ledgerId, limit: 10, offset: 999 })),
      ) as ListResult;
      assert.equal(beyond.已返回, 0);
      assert.equal(beyond.匹配总数, 25);
      assert.equal(beyond.还有更多, false);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非法 offset（负数/字符串）回退 0，不报错", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const created = JSON.parse(text(t.ledger({ action: "create", name: "非法偏移" }))) as {
        已创建: { id: string };
      };
      const ledgerId = created.已创建.id;
      seedPage(env, ledgerId, 5);

      const negative = t.expense({ action: "list", ledger_id: ledgerId, limit: 2, offset: -3 });
      assert.notEqual(negative.isError, true, text(negative));
      const parsedNegative = JSON.parse(text(negative)) as ListResult;
      assert.equal(parsedNegative.偏移, 0);
      assert.equal(parsedNegative.已返回, 2);

      const bogus = t.expense({ action: "list", ledger_id: ledgerId, limit: 2, offset: "abc" });
      assert.notEqual(bogus.isError, true);
      assert.equal((JSON.parse(text(bogus)) as ListResult).偏移, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
