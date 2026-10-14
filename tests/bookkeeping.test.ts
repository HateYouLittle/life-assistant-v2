import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addExpense,
  createLedger,
  findMissingMonthlyReports,
  listExpenses,
  listLedgers,
  monthRange,
  monthlyReportPublished,
  previousMonth,
  setLedgerArchived,
  summarizeExpenses,
  pushMonthlyReports,
} from "../src/modules/bookkeeping/service.js";
import { bookkeepingLedgerTool, bookkeepingExpenseTool } from "../src/modules/bookkeeping/index.js";
import { TZ, todayIso } from "../src/time.js";
import { DateTime } from "luxon";
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
      const created = JSON.parse(text(t.ledger({ action: "create", name: "日用" }))) as {
        已创建: { id: string };
      };
      const id = created.已创建.id;
      assert.equal(t.ledger({ action: "create", name: "日用" }).isError, true, "重名应拒绝");
      t.ledger({ action: "rename", id, name: "日常开销" });
      assert.equal(t.ledger({ action: "create", name: "日常开销" }).isError, true);

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
      const ledger = JSON.parse(text(t.ledger({ action: "create", name: "日用" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      const entry = JSON.parse(
        text(
          t.expense({
            action: "add",
            ledger_id: ledgerId,
            amount: 12.34,
            category: "餐饮",
            note: "午饭",
          }),
        ),
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
      // 用本地（Asia/Shanghai）月份：addExpense 默认 spent_on 走 todayIso()，
      // 若这里取 UTC 月份，每月 1 号 00:00–08:00 的 8 小时窗口内断言必然失败。
      const month = todayIso().slice(0, 7);
      const sum = JSON.parse(
        text(t.expense({ action: "summary", ledger_id: ledgerId, month })),
      ) as {
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
      const ledger = JSON.parse(text(t.ledger({ action: "create", name: "日用" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      assert.equal(t.expense({ action: "add", ledger_id: ledgerId, amount: 0 }).isError, true);
      assert.equal(t.expense({ action: "add", ledger_id: ledgerId, amount: -5 }).isError, true);
      assert.equal(t.expense({ action: "add", ledger_id: "missing", amount: 5 }).isError, true);
      assert.equal(
        t.expense({ action: "add", ledger_id: ledgerId, amount: 5, date: "2026-02-30" }).isError,
        true,
      );
      setLedgerArchived(env.db, ledgerId, true);
      assert.equal(
        t.expense({ action: "add", ledger_id: ledgerId, amount: 5 }).isError,
        true,
        "归档账本不可记账",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("summary 不传 month/from/to 时默认「月初 → 今天」，且不含月内未来日", () => {
    // 与状态页/预算对照的「本月=自然月全月」不同：工具 summary 无参时是「本月至今」的
    // 查询默认（to = 今天），刻意不把已录入的月内未来日算进来。
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledger = createLedger(env.db, "默认区间账本");
      const today = todayIso();
      addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 1000,
        spentOn: today,
      });
      addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 2000,
        spentOn: "2099-01-15",
      });
      const body = JSON.parse(text(t.expense({ action: "summary", ledger_id: ledger.id }))) as {
        区间: { from: string; to: string };
        合计: string;
        笔数: number;
      };
      assert.deepEqual(body.区间, { from: `${today.slice(0, 7)}-01`, to: today });
      assert.equal(body.合计, "¥10.00");
      assert.equal(body.笔数, 1, "月内未到来的日期不在默认区间内");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("month 与 from/to 互斥：两个 action 同样报错，不再一个越界一个静默忽略", () => {
    // 回归：list 曾逐边合并（month + from 给出「月内且不早于 from」的越界区间，
    // month + to 甚至得到反向区间静默 0 笔），summary 则整体走 monthRange 静默忽略 from/to
    // —— 同一个工具两个 action 口径相反，且都不报错。
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledger = createLedger(env.db, "区间账本");
      for (const [spentOn, cents] of [
        ["2026-05-10", 1000],
        ["2026-06-10", 2000],
        ["2026-07-10", 4000],
      ] as const) {
        addExpense(env.db, "default", { ledgerId: ledger.id, amountCents: cents, spentOn });
      }
      const errorOf = (args: Record<string, unknown>): string => {
        const result = t.expense(args);
        assert.equal(result.isError, true, `应报错: ${text(result)}`);
        return text(result);
      };

      // 只给 month：两者的区间必须一致
      const listMonth = JSON.parse(
        text(t.expense({ action: "list", ledger_id: ledger.id, month: "2026-06" })),
      ) as { 账目: { 日期: string }[]; 匹配总数: number };
      assert.equal(listMonth.匹配总数, 1);
      assert.equal(listMonth.账目[0]?.日期, "2026-06-10");
      const sumMonth = JSON.parse(
        text(t.expense({ action: "summary", ledger_id: ledger.id, month: "2026-06" })),
      ) as { 区间: { from: string; to: string }; 合计: string; 笔数: number };
      assert.deepEqual(sumMonth.区间, { from: "2026-06-01", to: "2026-06-30" });
      assert.equal(sumMonth.合计, "¥20.00");
      assert.equal(sumMonth.笔数, 1, "list 与 summary 必须覆盖同一区间");

      // month + from / month + to：两个 action 报同一条错
      for (const extra of [{ from: "2026-05-01" }, { to: "2026-05-01" }]) {
        const fromList = errorOf({
          action: "list",
          ledger_id: ledger.id,
          month: "2026-06",
          ...extra,
        });
        const fromSummary = errorOf({
          action: "summary",
          ledger_id: ledger.id,
          month: "2026-06",
          ...extra,
        });
        assert.equal(fromList, fromSummary, "list 与 summary 对同一输入必须给同一条错误");
        assert.match(fromList, /month 与 from\/to 不能同时指定/);
      }

      // from > to：明确报错而不是静默 0 笔
      for (const action of ["list", "summary"]) {
        const message = errorOf({
          action,
          ledger_id: ledger.id,
          from: "2026-07-01",
          to: "2026-05-01",
        });
        assert.match(message, /2026-07-01.*2026-05-01/, "报错要说清哪个区间反了");
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("只给单边 from/to：summary 与 list 口径一致，不被补默认区间反转", () => {
    // 回归：expenseRange 的 defaults 曾是「逐边」兜底（from ?? defaults.from / to ?? defaults.to），
    // 于是只给 from 时 summary 被补上 to=今天 —— 明细说有 N 笔（含未来账目），汇总只覆盖到今天，
    // 同一句查询两个 action 给出相反结论；只给 to 时又补上 from=月初，静默丢掉更早的账目。
    // 现在 defaults 只在 from/to 都不传时整体套用，半边给参就是半边语义（[from, +∞) / (-∞, to]）。
    // 日期全部相对 todayIso() 派生（±400 天），断言对运行日不敏感。
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const today = DateTime.fromISO(todayIso(), { zone: TZ });
      const past = today.minus({ days: 100 }).toISODate() as string;
      const older = today.minus({ days: 400 }).toISODate() as string;
      const future = today.plus({ days: 400 }).toISODate() as string;
      const from = today.minus({ days: 200 }).toISODate() as string;
      const to = today.plus({ days: 200 }).toISODate() as string;

      const ledger = createLedger(env.db, "半边区间账本");
      addExpense(env.db, "default", { ledgerId: ledger.id, amountCents: 1000, spentOn: older });
      addExpense(env.db, "default", { ledgerId: ledger.id, amountCents: 2000, spentOn: past });
      addExpense(env.db, "default", { ledgerId: ledger.id, amountCents: 4000, spentOn: future });

      const summaryOf = (
        args: Record<string, unknown>,
      ): {
        区间: { from?: string; to?: string };
        合计: string;
        笔数: number;
      } => JSON.parse(text(t.expense({ action: "summary", ledger_id: ledger.id, ...args })));
      const countOf = (args: Record<string, unknown>): number =>
        (
          JSON.parse(text(t.expense({ action: "list", ledger_id: ledger.id, ...args }))) as {
            匹配总数: number;
          }
        ).匹配总数;

      // 只给 from：[from, +∞) —— 含未来账目，不补 to
      const sumFrom = summaryOf({ from });
      assert.deepEqual(sumFrom.区间, { from }, "只给 from 时不得补上默认 to");
      assert.equal(sumFrom.笔数, 2, "[from, +∞) 应含今天之后的账目");
      assert.equal(sumFrom.合计, "¥60.00");
      assert.equal(countOf({ from }), sumFrom.笔数, "list 与 summary 必须覆盖同一区间");

      // 只给 to：(-∞, to] —— 含月初之外的旧账目，不补 from
      const sumTo = summaryOf({ to });
      assert.deepEqual(sumTo.区间, { to }, "只给 to 时不得补上默认 from");
      assert.equal(sumTo.笔数, 2, "(-∞, to] 应含远早于本月的账目");
      assert.equal(sumTo.合计, "¥30.00");
      assert.equal(countOf({ to }), sumTo.笔数, "list 与 summary 必须覆盖同一区间");

      // 未来起点：list 静默 0 条，summary 也必须是 0 笔，而不是报「区间非法」
      const far = today.plus({ days: 3000 }).toISODate() as string;
      const resultFuture = t.expense({ action: "summary", ledger_id: ledger.id, from: far });
      assert.notEqual(resultFuture.isError, true, "未来区间不是写反了，不该报错");
      const sumFuture = JSON.parse(text(resultFuture)) as {
        区间: { from?: string; to?: string };
        笔数: number;
      };
      assert.deepEqual(sumFuture.区间, { from: far }, "未来起点不得被补上默认 to");
      assert.equal(sumFuture.笔数, 0);
      assert.equal(countOf({ from: far }), sumFuture.笔数, "未来区间两个 action 结论也必须一致");

      // 仍然不传：默认区间（月初→今天）整体套用，不退化成逐边兜底
      const sumDefault = summaryOf({});
      assert.deepEqual(sumDefault.区间, { from: `${todayIso().slice(0, 7)}-01`, to: todayIso() });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("summary 汇总与占比", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "测试账本");
      addExpense(env.db, "p1", {
        ledgerId: ledger.id,
        amountCents: 6000,
        category: "餐饮",
        spentOn: "2026-08-02",
      });
      addExpense(env.db, "p1", {
        ledgerId: ledger.id,
        amountCents: 2000,
        category: "交通",
        spentOn: "2026-08-10",
      });
      addExpense(env.db, "p2", {
        ledgerId: ledger.id,
        amountCents: 2000,
        category: "餐饮",
        spentOn: "2026-08-20",
      });
      const summary = summarizeExpenses(env.db, ledger.id, {
        from: "2026-08-01",
        to: "2026-08-31",
      });
      assert.equal(summary.total_cents, 10000);
      assert.equal(summary.categories[0]?.category, "餐饮");
      assert.equal(summary.categories[0]?.share, 0.8);
      assert.equal(summary.profiles.find((p) => p.profile === "p2")?.cents, 2000);

      const byP2 = summarizeExpenses(env.db, ledger.id, {
        from: "2026-08-01",
        to: "2026-08-31",
        by: "p2",
      });
      assert.equal(byP2.total_cents, 2000);
      assert.equal(byP2.count, 1);
      assert.equal(byP2.categories.length, 1);
      assert.equal(byP2.categories[0]?.share, 1);
      assert.equal(byP2.profiles.length, 1);

      const byNobody = summarizeExpenses(env.db, ledger.id, {
        from: "2026-08-01",
        to: "2026-08-31",
        by: "nobody",
      });
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
      const ledger = JSON.parse(text(t.ledger({ action: "create", name: "月报账本" }))) as {
        已创建: { id: string };
      };
      const _empty = JSON.parse(text(t.ledger({ action: "create", name: "空账本" }))) as {
        已创建: { id: string };
      };
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
      const ledger = JSON.parse(text(t.ledger({ action: "create", name: "日用" }))) as {
        已创建: { id: string };
      };
      const ledgerId = ledger.已创建.id;
      const first = JSON.parse(
        text(t.expense({ action: "add", ledger_id: ledgerId, amount: 50 })),
      ) as {
        已记账: { id: string };
      };
      t.expense({ action: "add", ledger_id: ledgerId, amount: 20 });
      const removed = JSON.parse(text(t.expense({ action: "delete", id: first.已记账.id }))) as {
        已删除: { 金额: string };
      };
      assert.equal(removed.已删除.金额, "¥50.00");
      const month = todayIso().slice(0, 7);
      const sum = JSON.parse(
        text(t.expense({ action: "summary", ledger_id: ledgerId, month })),
      ) as {
        合计: string;
        笔数: number;
      };
      assert.equal(sum.合计, "¥20.00");
      assert.equal(sum.笔数, 1);
      assert.equal(
        t.expense({ action: "delete", id: first.已记账.id }).isError,
        true,
        "重复删除应报错",
      );
      assert.equal(t.expense({ action: "delete" }).isError, true, "缺 id 应报错");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("bookkeeping：月报覆盖与分页语义", () => {
  it("已归档账本仍会推送其有支出的月份账单", async () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "家庭");
      addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 2500,
        spentOn: "2026-09-05",
      });
      setLedgerArchived(env.db, ledger.id, true);

      const pushed = await pushMonthlyReports(env.db, makeServices(env), "2026-09");
      assert.ok(pushed >= 1, "归档账本的当月账单不应被漏发");
      assert.ok(
        env.published.some((p) => (p.input as { title?: string }).title?.includes("家庭")),
        "应推送归档账本的月报",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("月报幂等：同月重复推送不产生第二条", async () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "幂等");
      addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 100,
        spentOn: "2026-09-05",
      });
      const services = makeServices(env);
      await pushMonthlyReports(env.db, services, "2026-09");
      const first = env.published.length;
      await pushMonthlyReports(env.db, services, "2026-09");
      assert.equal(env.published.length, first, "同月同账本应被 dedupeKey 去重");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("能识别并补发错过的历史月报", async () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "补发");
      addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 500,
        spentOn: "2026-08-10",
      });
      const missing = findMissingMonthlyReports(env.db, 6, "2026-10-05");
      assert.ok(
        missing.missing.some((m) => m.ym === "2026-08"),
        `未推送的 8 月账单应被识别：${JSON.stringify(missing.missing)}`,
      );
      await pushMonthlyReports(env.db, makeServices(env), "2026-08");
      assert.ok(monthlyReportPublished(env.db, ledger.id, "2026-08"));
      const after = findMissingMonthlyReports(env.db, 6, "2026-10-05");
      assert.ok(!after.missing.some((m) => m.ym === "2026-08"), "补发后不再缺失");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("早于回看窗口的未推送月报记入 tooOld（不自动补发，但可告警）", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "太久远");
      addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 900,
        spentOn: "2026-01-10",
      });
      const found = findMissingMonthlyReports(env.db, 6, "2026-10-05");
      assert.ok(
        !found.missing.some((m) => m.ym === "2026-01"),
        "窗口外的月份不进入补发清单（只告警）",
      );
      assert.ok(
        found.tooOld.some((m) => m.ym === "2026-01"),
        `窗口外未推送的月份应记入 tooOld：${JSON.stringify(found.tooOld)}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("expense list 报告真实总数与截断标志，且负数 limit 不变成不限量", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "多笔");
      for (let i = 1; i <= 25; i++) {
        addExpense(env.db, "default", {
          ledgerId: ledger.id,
          amountCents: 100 + i,
          spentOn: "2026-09-05",
        });
      }
      const page = listExpenses(env.db, ledger.id);
      assert.equal(page.rows.length, 20);
      assert.equal(page.total, 25, "匹配总数应为 25 而不只是返回的 20");
      assert.equal(page.hasMore, true);

      const neg = listExpenses(env.db, ledger.id, { limit: -1 });
      assert.ok(neg.rows.length <= 20, `负数 limit 应被夹紧，实际 ${neg.rows.length} 行`);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("恢复归档账本时拒绝制造同名活跃账本", () => {
    const env = makeTestEnv();
    try {
      const first = createLedger(env.db, "重名");
      setLedgerArchived(env.db, first.id, true);
      const second = createLedger(env.db, "重名");
      assert.notEqual(first.id, second.id, "归档后允许新建同名");
      assert.throws(() => setLedgerArchived(env.db, first.id, false), /同名/);
      const active = env.db
        .prepare("SELECT COUNT(*) AS n FROM ledgers WHERE name = '重名' AND archived_at IS NULL")
        .get() as { n: number };
      assert.equal(active.n, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

/** 用真实 notifications 表模拟 publishGlobal/publishProfile 的 Profile 内去重 */
function makeServices(env: TestEnv) {
  return {
    publishProfile: async (
      profileId: string,
      input: { kind: string; title: string; dedupeKey?: string },
    ) => {
      const existing = env.db
        .prepare("SELECT 1 FROM notifications WHERE profile_id = ? AND dedupe_key = ?")
        .get(profileId, input.dedupeKey ?? null);
      if (existing !== undefined) return { deduped: true };
      env.db
        .prepare(
          "INSERT INTO notifications (id, profile_id, kind, title, body_md, dedupe_key, read, created_at) VALUES (?, ?, ?, ?, '', ?, 0, ?)",
        )
        .run(
          `n-${env.published.length + 1}`,
          profileId,
          input.kind,
          input.title,
          input.dedupeKey ?? null,
          new Date().toISOString(),
        );
      env.published.push({ profileId, input: input as never });
      return { deduped: false };
    },
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
