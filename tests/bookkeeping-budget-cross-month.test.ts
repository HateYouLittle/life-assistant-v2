import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import { type Published, type TestEnv, cleanupTestEnv, makeTestEnv } from "./helpers.js";

/**
 * 预算告警跨月修复（P1-12b）：补记过去月份的支出时，
 * 告警必须按 `entry.spent_on` 所属月份判定、标题带月份，且 dedupeKey 含
 * 月份 + 账本 + 分类 —— 否则「8 月已超支」会把 9 月的超支静默去重掉。
 */

/** 固定到某个北京时间的 10:00（与既有预算测试同款假时钟） */
function freeze(t: TestContext, date: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(`${date}T10:00:00+08:00`) });
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

/** dedupeKey 去重桩：与真实 notify 的「Profile 内同 dedupeKey 只物化一次」一致 */
function makeTools(env: TestEnv, profileId = "default") {
  const seen = new Set<string>();
  const ctx = {
    profileId,
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async (input: { kind: string; dedupeKey?: string }) => {
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
    alerts: () => env.published.filter((p) => p.input.kind === "bookkeeping.budget") as Published[],
  };
}

function createLedgerId(t: ReturnType<typeof makeTools>, name: string): string {
  const created = JSON.parse(text(t.ledger({ action: "create", name }))) as {
    已创建: { id: string };
  };
  return created.已创建.id;
}

function addArgs(ledgerId: string, amount: number, date: string, category?: string) {
  return {
    action: "add",
    ledger_id: ledgerId,
    amount,
    date,
    ...(category === undefined ? {} : { category }),
  };
}

describe("bookkeeping 预算：补记历史月份按「那个月」口径告警", () => {
  it("补记两个月前的支出：告警标题带该月、dedupeKey 含月份", (t) => {
    freeze(t, "2026-10-15");
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedgerId(tool, "家庭账本");
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 1000 });

      // 补记 8 月：900 元 → 8 月从 0 跨到 90%，应按 2026-08 推一条 80% 提醒
      tool.expense(addArgs(ledgerId, 900, "2026-08-10"));
      const aug80 = tool.alerts();
      assert.equal(aug80.length, 1, "补记历史月份跨越阈值必须告警");
      assert.match(
        aug80[0]?.input.title ?? "",
        /⚠️ 家庭账本 2026-08 预算提醒/,
        `标题必须点明是哪个月：${aug80[0]?.input.title}`,
      );
      assert.match(aug80[0]?.input.dedupeKey ?? "", /:2026-08:80$/);

      // 再补 100 元 → 8 月到 100%
      tool.expense(addArgs(ledgerId, 100, "2026-08-20"));
      const aug100 = tool.alerts().filter((p) => /:2026-08:100$/.test(p.input.dedupeKey ?? ""));
      assert.equal(aug100.length, 1);
      assert.match(aug100[0]?.input.title ?? "", /⚠️ 家庭账本 2026-08 预算超支/);
      // 正文补一行「账本 · 月份」，表格之外也能确认口径
      assert.ok(
        (aug100[0]?.input.blocks.notes ?? []).includes("家庭账本 · 2026-08"),
        `提醒正文应带账本与月份：${JSON.stringify(aug100[0]?.input.blocks.notes)}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("连续两个月各超支一次：两条告警，不会因「同账本去过重」被吞掉", (t) => {
    freeze(t, "2026-10-15");
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedgerId(tool, "连续月");
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 1000 });

      // 8 月一笔到 150%
      tool.expense(addArgs(ledgerId, 1500, "2026-08-05"));
      // 9 月一笔到 150%
      tool.expense(addArgs(ledgerId, 1500, "2026-09-05"));
      // 当月（10 月）一笔到 150%
      tool.expense(addArgs(ledgerId, 1500, "2026-10-05"));

      const alerts = tool.alerts();
      assert.equal(alerts.length, 3, "每个月各一条，不能只留下第一条");
      const months = alerts.map((p) => (p.input.dedupeKey ?? "").split(":")[3]);
      assert.deepEqual(months.sort(), ["2026-08", "2026-09", "2026-10"]);
      assert.ok(alerts.every((p) => /预算超支/.test(p.input.title)));
      // 标题逐条含各自月份（旧标题只有账本名，三条长得一模一样）
      for (const alert of alerts) {
        const month = (alert.input.dedupeKey ?? "").split(":")[3] as string;
        assert.match(alert.input.title, new RegExp(month));
      }

      // 同月同阈值继续花钱：不再跨阈值，也不重复推
      tool.expense(addArgs(ledgerId, 10, "2026-08-06"));
      assert.equal(tool.alerts().length, 3);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("分类预算同口径：标题含「分类「餐饮」+ 月份」，dedupeKey 含分类与月份", (t) => {
    freeze(t, "2026-10-15");
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedgerId(tool, "分类账本");
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 500, category: "餐饮" });

      // 8 月餐饮：400 元 → 80%
      tool.expense(addArgs(ledgerId, 400, "2026-08-05", "餐饮"));
      const aug80 = tool.alerts();
      assert.equal(aug80.length, 1);
      assert.match(aug80[0]?.input.title ?? "", /分类「餐饮」2026-08 预算提醒/);
      assert.match(aug80[0]?.input.dedupeKey ?? "", /^budget:.*:餐饮:2026-08:80$/);

      // 8 月餐饮：+100 元 → 100%
      tool.expense(addArgs(ledgerId, 100, "2026-08-06", "餐饮"));
      const aug100 = tool.alerts().filter((p) => /:2026-08:100$/.test(p.input.dedupeKey ?? ""));
      assert.equal(aug100.length, 1);
      assert.match(aug100[0]?.input.title ?? "", /分类「餐饮」2026-08 预算超支/);

      // 9 月餐饮：同分类不同月份 → 独立一条，不被 8 月的键去重
      tool.expense(addArgs(ledgerId, 400, "2026-09-05", "餐饮"));
      const sep = tool.alerts().filter((p) => /:2026-09:80$/.test(p.input.dedupeKey ?? ""));
      assert.equal(sep.length, 1, "新月份必须重新判定");
      assert.match(sep[0]?.input.title ?? "", /分类「餐饮」2026-09 预算提醒/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("当月正常路径不回归：标题带当前月份、dedupeKey 与既有编码一致", (t) => {
    freeze(t, "2026-10-15");
    const env = makeTestEnv();
    const tool = makeTools(env);
    try {
      const ledgerId = createLedgerId(tool, "当月");
      tool.ledger({ action: "budget", ledger_id: ledgerId, amount: 100 });
      tool.expense(addArgs(ledgerId, 150, "2026-10-15"));
      const alerts = tool.alerts();
      assert.equal(alerts.length, 1);
      assert.match(alerts[0]?.input.title ?? "", /当月 2026-10 预算超支/);
      assert.equal(alerts[0]?.input.dedupeKey, `budget:${ledgerId}::2026-10:100`);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
