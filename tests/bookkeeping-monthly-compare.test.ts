import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addExpense,
  createLedger,
  monthComparisonFacts,
  monthComparisonLines,
  monthComparisonPeriods,
  pushMonthlyReports,
} from "../src/modules/bookkeeping/service.js";
import { cleanupTestEnv, makeTestEnv, type Published, type TestEnv } from "./helpers.js";

/**
 * 月报对比口径：本月 vs 上月同期（到同一天）、近 3 月同期均值；预算 0 行时不出现预算字样。
 */

function services(env: TestEnv) {
  return {
    publishProfile: async (profileId: string, input: unknown) => {
      env.published.push({ profileId, input: input as never });
      return { id: `n-${env.published.length}`, deduped: false };
    },
    publishGlobal: async (input: unknown) => {
      env.published.push({ profileId: "*", input: input as never });
      return { materialized: 1 };
    },
  };
}

function spend(env: TestEnv, ledgerId: string, spentOn: string, yuan: number, category = "餐饮") {
  addExpense(env.db, "default", { ledgerId, amountCents: yuan * 100, spentOn, category });
}

describe("monthComparisonPeriods：区间口径", () => {
  it("报表月已结束（1 号推上月）：本月全月，历史月取到同一天，短月取月末", () => {
    const p = monthComparisonPeriods("2026-03", "2026-04-01");
    assert.equal(p.partial, false);
    assert.deepEqual(p.current, { from: "2026-03-01", to: "2026-03-31" });
    // 2 月只有 28 天：同期 = 整个 2 月
    assert.deepEqual(p.previous, { ym: "2026-02", from: "2026-02-01", to: "2026-02-28" });
    assert.deepEqual(
      p.history.map((h) => [h.ym, h.to]),
      [
        ["2026-02", "2026-02-28"],
        ["2026-01", "2026-01-31"],
        ["2025-12", "2025-12-31"],
      ],
    );
  });

  it("上月比本月长：2 月月报的上月同期是 1 月 1–28 日；闰年 29 日", () => {
    assert.deepEqual(monthComparisonPeriods("2026-02", "2026-03-01").previous, {
      ym: "2026-01",
      from: "2026-01-01",
      to: "2026-01-28",
    });
    assert.deepEqual(monthComparisonPeriods("2028-02", "2028-03-01").previous, {
      ym: "2028-01",
      from: "2028-01-01",
      to: "2028-01-29",
    });
  });

  it("月初看本月（月中补跑/手动）：只对比到当天，不拿 3 天比上月整月", () => {
    const p = monthComparisonPeriods("2026-11", "2026-11-03");
    assert.equal(p.partial, true);
    assert.deepEqual(p.current, { from: "2026-11-01", to: "2026-11-03" });
    assert.deepEqual(p.previous, { ym: "2026-10", from: "2026-10-01", to: "2026-10-03" });
    // 跨年
    const jan = monthComparisonPeriods("2027-01", "2027-01-05");
    assert.deepEqual(
      jan.history.map((h) => `${h.from}~${h.to}`),
      ["2026-12-01~2026-12-05", "2026-11-01~2026-11-05", "2026-10-01~2026-10-05"],
    );
  });
});

describe("monthComparisonLines：文案", () => {
  const periods = monthComparisonPeriods("2026-10", "2026-11-01");

  it("上月同期与近 3 月均值，带百分比", () => {
    const lines = monthComparisonLines({
      periods,
      currentCents: 120000,
      previousCents: 100000,
      historyCents: [100000, 80000, 120000],
    });
    assert.deepEqual(lines, [
      "较上月同期（09-01~09-30，¥1000.00）：+20.0%",
      "较近 3 月均值（¥1000.00）：+20.0%",
    ]);
  });

  it("基数为 0 不做除法；只有 1 个可比月份时省略均值行；没有可比月份时整行省略", () => {
    assert.deepEqual(
      monthComparisonLines({ periods, currentCents: 5000, previousCents: 0, historyCents: [0, 0] }),
      [
        "较上月同期（09-01~09-30，¥0.00）：（基数为 0，不计百分比）",
        "较近 2 月均值（¥0.00）：（基数为 0，不计百分比）",
      ],
    );
    assert.deepEqual(
      monthComparisonLines({
        periods,
        currentCents: 5000,
        previousCents: 10000,
        historyCents: [10000],
      }),
      ["较上月同期（09-01~09-30，¥100.00）：-50.0%"],
    );
    assert.deepEqual(
      monthComparisonLines({ periods, currentCents: 5000, previousCents: null, historyCents: [] }),
      [],
    );
  });

  it("未结束的月份：先给「本月截至」，均值标「同期」", () => {
    const partial = monthComparisonPeriods("2026-11", "2026-11-03");
    const lines = monthComparisonLines({
      periods: partial,
      currentCents: 3000,
      previousCents: 6000,
      historyCents: [6000, 3000],
    });
    assert.deepEqual(lines, [
      "本月截至 11-03：¥30.00",
      "较上月同期（10-01~10-03，¥60.00）：-50.0%",
      "较近 2 月同期均值（¥45.00）：-33.3%",
    ]);
  });
});

describe("月报正文（pushMonthlyReports）", () => {
  it("按同期口径汇总：上月 31 日之后的支出不进 2 月月报的对比；账本首笔之前的月份不计入均值", async () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "家庭");
      spend(env, ledger.id, "2025-12-10", 300);
      spend(env, ledger.id, "2026-01-10", 200);
      spend(env, ledger.id, "2026-01-30", 999); // 1 月 29 日之后：不进 2 月月报的「上月同期」
      spend(env, ledger.id, "2026-02-05", 250, "交通");
      spend(env, ledger.id, "2026-02-20", 50);

      const facts = monthComparisonFacts(env.db, ledger.id, "2026-02", "2026-03-01");
      assert.equal(facts.currentCents, 30000);
      assert.equal(facts.previousCents, 20000);
      // 近 3 月：1 月 1–28（200）、12 月 1–28（300）；11 月在首笔之前不计入
      assert.deepEqual(facts.historyCents, [20000, 30000]);

      await pushMonthlyReports(env.db, services(env), "2026-02");
      const report = env.published.find((p) => p.input.kind === "bookkeeping.monthly") as Published;
      const notes = report.input.blocks.notes ?? [];
      assert.deepEqual(notes, [
        "共 2 笔",
        "较上月同期（01-01~01-28，¥200.00）：+50.0%",
        "较近 2 月均值（¥250.00）：+20.0%",
      ]);
      // Top 分类表沿用既有形状
      assert.deepEqual(report.input.blocks.table?.columns, ["分类", "金额", "占比"]);
      assert.deepEqual(report.input.blocks.table?.rows, [
        ["交通", "¥250.00", "83.3%"],
        ["餐饮", "¥50.00", "16.7%"],
        ["合计", "¥300.00", "100%"],
      ]);
      // budgets 0 行：不出现任何预算字样
      assert.ok(!notes.some((n) => n.includes("预算")));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("新账本第一个月：没有对比行", async () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "新账本");
      spend(env, ledger.id, "2026-10-05", 10);
      await pushMonthlyReports(env.db, services(env), "2026-10");
      const notes = env.published[0]?.input.blocks.notes ?? [];
      assert.deepEqual(notes, ["共 1 笔"]);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
