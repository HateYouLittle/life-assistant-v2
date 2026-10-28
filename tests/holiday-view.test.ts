import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { importYear } from "../src/core/holiday.js";
import { holidayTool } from "../src/modules/holiday/index.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/**
 * P2-20② + P2-25 回归：holiday 的 action 规范名 / view 兼容别名，
 * 以及**未知分支的显式兜底**（此前没有 default，未知 view 会落入 is_workday，
 * 报出「date 需为 YYYY-MM-DD 格式」这种把未知分发误报成参数错误的信息）。
 */

function ctxOf(env: ReturnType<typeof makeTestEnv>) {
  return {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async () => ({ materialized: 0 }),
    },
  };
}

function textOf(result: { content: { text: string }[] }): string {
  return (result.content[0]?.text ?? "").trim();
}

function isErrorOf(result: { isError?: boolean }): boolean {
  return result.isError === true;
}

/** 造一份 2026 年最小数据：元旦为休息日 */
function seed2026(env: ReturnType<typeof makeTestEnv>): void {
  importYear(
    env.db,
    { year: 2026, days: [{ name: "元旦", date: "2026-01-01", isOffDay: true }] },
    "test",
  );
}

describe("P2-25 holiday 未知分支兜底", () => {
  it("未知 view / action → `未知 action: …`，绝不落入 is_workday", async () => {
    const env = makeTestEnv();
    try {
      seed2026(env);
      // 关键：即使带上合法 date，未知分发也必须报「未知 action」而不是当成 is_workday 执行
      for (const args of [
        { view: "bogus" },
        { action: "bogus" },
        { view: "bogus", date: "2026-01-01" },
        { action: "bogus", date: "2026-01-01" },
      ]) {
        const result = await holidayTool(args, ctxOf(env));
        assert.equal(isErrorOf(result), true, `${JSON.stringify(args)} 应被拒绝`);
        assert.equal(
          textOf(result),
          "错误：未知 action: bogus",
          `${JSON.stringify(args)} 的文案前缀应与其它工具一致`,
        );
        assert.doesNotMatch(textOf(result), /date 需为/, "未知分支不得落入 is_workday");
      }
      // 兜底同时覆盖「将来新增第四个 view 却忘了写分支」的形态
      const forgotten = await holidayTool({ view: "solar_term" }, ctxOf(env));
      assert.equal(textOf(forgotten), "错误：未知 action: solar_term");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("action 与 view 都不给 → 明确报缺（而不是落到 is_workday 的参数错误）", async () => {
    const env = makeTestEnv();
    try {
      const result = await holidayTool({}, ctxOf(env));
      assert.equal(isErrorOf(result), true);
      assert.match(textOf(result), /缺少 action/);
      assert.doesNotMatch(textOf(result), /date 需为/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("P2-20② holiday action/view 兼容", () => {
  it("action 与 view 等价（next / month / is_workday 输出逐字一致）", async () => {
    const env = makeTestEnv();
    try {
      seed2026(env);
      const cases: Array<Record<string, unknown>> = [
        {},
        { month: "2026-01" },
        { date: "2026-01-01" },
      ];
      const views = ["next", "month", "is_workday"];
      for (const [index, view] of views.entries()) {
        const base = cases[index] ?? {};
        const viaView = textOf(await holidayTool({ view, ...base }, ctxOf(env)));
        const viaAction = textOf(await holidayTool({ action: view, ...base }, ctxOf(env)));
        assert.equal(viaAction, viaView, `${view}: action 与 view 应逐字等价`);
      }
      // 钉住等价的具体语义：is_workday 必须真的命中元旦数据
      assert.match(
        textOf(await holidayTool({ action: "is_workday", date: "2026-01-01" }, ctxOf(env))),
        /休息日/,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同时传且一致 → 正常工作；冲突 → 明确报错", async () => {
    const env = makeTestEnv();
    try {
      seed2026(env);
      const both = await holidayTool({ action: "next", view: "next" }, ctxOf(env));
      assert.equal(isErrorOf(both), false, textOf(both));

      for (const args of [
        { action: "next", view: "month", month: "2026-01" },
        { action: "is_workday", view: "next", date: "2026-01-01" },
      ]) {
        const result = await holidayTool(args, ctxOf(env));
        assert.equal(isErrorOf(result), true, `${JSON.stringify(args)} 应被拒绝`);
        assert.match(textOf(result), /冲突/);
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("必填参数表集中校验：month / is_workday 缺参沿用既有文案", async () => {
    const env = makeTestEnv();
    try {
      const noMonth = await holidayTool({ action: "month" }, ctxOf(env));
      assert.equal(isErrorOf(noMonth), true);
      assert.match(textOf(noMonth), /month 需为 YYYY-MM 格式/);

      const noDate = await holidayTool({ action: "is_workday" }, ctxOf(env));
      assert.equal(isErrorOf(noDate), true);
      assert.match(textOf(noDate), /date 需为 YYYY-MM-DD 格式/);

      const blankMonth = await holidayTool({ view: "month", month: "   " }, ctxOf(env));
      assert.equal(isErrorOf(blankMonth), true);
      assert.match(textOf(blankMonth), /month 需为 YYYY-MM 格式/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("既有 view 写法保持可用（SKILL.md 示例口径）", async () => {
    const env = makeTestEnv();
    try {
      seed2026(env);
      const next = await holidayTool({ view: "next" }, ctxOf(env));
      assert.equal(isErrorOf(next), false, textOf(next));
      const month = await holidayTool({ view: "month", month: "2026-01" }, ctxOf(env));
      assert.equal(isErrorOf(month), false, textOf(month));
      assert.match(textOf(month), /2026-01-01/);
      const workday = await holidayTool({ view: "is_workday", date: "2026-01-01" }, ctxOf(env));
      assert.match(textOf(workday), /休息日（法定节假日：元旦）/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
