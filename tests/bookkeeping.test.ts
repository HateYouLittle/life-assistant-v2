import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addExpense,
  createLedger,
  listLedgers,
  monthRange,
  previousMonth,
  setLedgerArchived,
  summarizeExpenses,
  pushMonthlyReports,
} from "../src/modules/bookkeeping/service.js";
import { bookkeepingLedgerTool, bookkeepingExpenseTool } from "../src/modules/bookkeeping/index.js";
import { cleanupTestEnv, makeTestEnv, type Published, type TestEnv } from "./helpers.js";

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
    ctx,
  };
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

describe("bookkeeping：账本", () => {
  it("创建/重名/重命名/归档", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const created = JSON.parse(text(t.ledger({ action: "create", name: "日用" }))) as { 已创建: { id: string } };
      const id = created.已创建.id;
      assert.equal((t.ledger({ action: "create", name: "日用" })).isError, true, "重名应拒绝");
      t.ledger({ action: "rename", id, name: "日常开销" });
      assert.equal((t.ledger({ action: "create", name: "日常开销" })).isError, true);

      t.ledger({ action: "archive", id });
      assert.equal(listLedgers(env.db).length, 0, "归档后不在默认列表");
      assert.equal(listLedgers(env.db, true).length, 1);
      t.ledger({ action: "archive", id, unarchive: true });
      assert.equal(listLedgers(env.db).length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("bookkeeping：支出", () => {
  it("记账（元转分）+ 回执全局推送 + 跨 Profile 可写", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledger = JSON.parse(text(t.ledger({ action: "create", name: "日用" }))) as { 已创建: { id: string } };
      const ledgerId = ledger.已创建.id;
      const entry = JSON.parse(
        text(t.expense({ action: "add", ledger_id: ledgerId, amount: 12.34, category: "餐饮", note: "午饭" })),
      ) as { 已记账: { id: string; 金额: string; 日期: string; 记账人: string } };
      assert.equal(entry.已记账.金额, "¥12.34");
      assert.equal(entry.已记账.记账人, "default");
      assert.equal(env.published.length, 1);
      const receipt = env.published[0] as Published;
      assert.equal(receipt.input.kind, "bookkeeping.entry");
      assert.match((receipt.input as { dedupeKey?: string }).dedupeKey ?? "", /^entry:/);

      // 另一个 Profile 直接记账（无授权限制）
      const t2 = tools(env, "partner");
      t2.expense({ action: "add", ledger_id: ledgerId, amount: 30, category: "交通" });
      const month = new Date().toISOString().slice(0, 7);
      const sum = JSON.parse(text(t.expense({ action: "summary", ledger_id: ledgerId, month }))) as {
        合计: string;
        笔数: number;
        分类明细: { 分类: string; 金额: string; 占比: string }[];
        按记账人: { 记账人: string; 金额: string }[];
      };
      assert.equal(sum.合计, "¥42.34");
      assert.equal(sum.笔数, 2);
      assert.equal(sum.分类明细[0]?.分类, "交通");
      assert.equal(sum.按记账人.length, 2);

      const byPartner = JSON.parse(
        text(t.expense({ action: "summary", ledger_id: ledgerId, month, by: "partner" })),
      ) as { 合计: string; 笔数: number; 分类明细: unknown[]; 按记账人: unknown[] };
      assert.equal(byPartner.合计, "¥30.00");
      assert.equal(byPartner.笔数, 1);
      assert.equal(byPartner.分类明细.length, 1);
      assert.equal(byPartner.按记账人.length, 1);

      const byNobody = JSON.parse(
        text(t.expense({ action: "summary", ledger_id: ledgerId, month, by: "nobody" })),
      ) as { 合计: string; 笔数: number; 分类明细: unknown[]; 按记账人: unknown[] };
      assert.equal(byNobody.合计, "¥0.00");
      assert.equal(byNobody.笔数, 0);
      assert.equal(byNobody.分类明细.length, 0);
      assert.equal(byNobody.按记账人.length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("金额/账本校验", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledger = JSON.parse(text(t.ledger({ action: "create", name: "日用" }))) as { 已创建: { id: string } };
      const ledgerId = ledger.已创建.id;
      assert.equal(t.expense({ action: "add", ledger_id: ledgerId, amount: 0 }).isError, true);
      assert.equal(t.expense({ action: "add", ledger_id: ledgerId, amount: -5 }).isError, true);
      assert.equal(t.expense({ action: "add", ledger_id: "missing", amount: 5 }).isError, true);
      assert.equal(t.expense({ action: "add", ledger_id: ledgerId, amount: 5, date: "2026-02-30" }).isError, true);
      setLedgerArchived(env.db, ledgerId, true);
      assert.equal(t.expense({ action: "add", ledger_id: ledgerId, amount: 5 }).isError, true, "归档账本不可记账");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("summary 汇总与占比", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "测试账本");
      addExpense(env.db, "p1", { ledgerId: ledger.id, amountCents: 6000, category: "餐饮", spentOn: "2026-08-02" });
      addExpense(env.db, "p1", { ledgerId: ledger.id, amountCents: 2000, category: "交通", spentOn: "2026-08-10" });
      addExpense(env.db, "p2", { ledgerId: ledger.id, amountCents: 2000, category: "餐饮", spentOn: "2026-08-20" });
      const summary = summarizeExpenses(env.db, ledger.id, { from: "2026-08-01", to: "2026-08-31" });
      assert.equal(summary.total_cents, 10000);
      assert.equal(summary.categories[0]?.category, "餐饮");
      assert.equal(summary.categories[0]?.share, 0.8);
      assert.equal(summary.profiles.find((p) => p.profile === "p2")?.cents, 2000);

      const byP2 = summarizeExpenses(env.db, ledger.id, { from: "2026-08-01", to: "2026-08-31", by: "p2" });
      assert.equal(byP2.total_cents, 2000);
      assert.equal(byP2.count, 1);
      assert.equal(byP2.categories.length, 1);
      assert.equal(byP2.categories[0]?.share, 1);
      assert.equal(byP2.profiles.length, 1);

      const byNobody = summarizeExpenses(env.db, ledger.id, { from: "2026-08-01", to: "2026-08-31", by: "nobody" });
      assert.equal(byNobody.total_cents, 0);
      assert.equal(byNobody.count, 0);
      assert.equal(byNobody.categories.length, 0);
      assert.equal(byNobody.profiles.length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("月报推送：有账目的账本全局推送并去重", async () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledger = JSON.parse(text(t.ledger({ action: "create", name: "月报账本" }))) as { 已创建: { id: string } };
      const _empty = JSON.parse(text(t.ledger({ action: "create", name: "空账本" }))) as { 已创建: { id: string } };
      addExpense(env.db, "default", {
        ledgerId: ledger.已创建.id,
        amountCents: 5000,
        category: "购物",
        spentOn: `${previousMonth(new Date("2026-09-15"))}-15`,
      });
      const ym = previousMonth(new Date("2026-09-15"));
      const pushed = await pushMonthlyReports(env.db, t.ctx.services, ym);
      assert.equal(pushed, 1, "空账本不推送");
      assert.equal(env.published.length, 1);
      const report = env.published[0] as Published;
      assert.equal(report.input.kind, "bookkeeping.monthly");
      assert.match(
        (report.input as { dedupeKey?: string }).dedupeKey ?? "",
        new RegExp(`report:${ledger.已创建.id}:${ym}`),
      );
      const blocks = report.input.blocks as { table: { rows: string[][] } };
      assert.deepEqual(blocks.table.rows[blocks.table.rows.length - 1], ["合计", "¥50.00", "100%"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("monthRange 与 previousMonth", () => {
    assert.deepEqual(monthRange("2026-09"), { from: "2026-09-01", to: "2026-09-30" });
    assert.deepEqual(monthRange("2024-02"), { from: "2024-02-01", to: "2024-02-29" });
    assert.equal(previousMonth(new Date("2026-01-05")), "2025-12");
    assert.equal(previousMonth(new Date("2026-09-15")), "2026-08");
    // 本地已是 9 月 1 日凌晨，UTC 仍是 8 月 31 日：必须按 Asia/Shanghai 取月
    assert.equal(previousMonth(new Date("2026-08-31T20:00:00Z")), "2026-08");
  });

  it("delete 删除记错的一笔，汇总随之变化", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledger = JSON.parse(text(t.ledger({ action: "create", name: "日用" }))) as { 已创建: { id: string } };
      const ledgerId = ledger.已创建.id;
      const first = JSON.parse(text(t.expense({ action: "add", ledger_id: ledgerId, amount: 50 }))) as {
        已记账: { id: string };
      };
      t.expense({ action: "add", ledger_id: ledgerId, amount: 20 });
      const removed = JSON.parse(text(t.expense({ action: "delete", id: first.已记账.id }))) as {
        已删除: { 金额: string };
      };
      assert.equal(removed.已删除.金额, "¥50.00");
      const month = new Date().toISOString().slice(0, 7);
      const sum = JSON.parse(text(t.expense({ action: "summary", ledger_id: ledgerId, month }))) as {
        合计: string;
        笔数: number;
      };
      assert.equal(sum.合计, "¥20.00");
      assert.equal(sum.笔数, 1);
      assert.equal(t.expense({ action: "delete", id: first.已记账.id }).isError, true, "重复删除应报错");
      assert.equal(t.expense({ action: "delete" }).isError, true, "缺 id 应报错");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
