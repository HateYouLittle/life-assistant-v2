import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  defineActionTool,
  findUnknownField,
  MISSING_ACTION_MESSAGE,
  unknownActionMessage,
  unknownFieldMessage,
} from "../src/core/action-tool.js";
import type { ToolContext, ToolResult } from "../src/core/registry.js";

const ctx = {} as ToolContext;
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const text = (r: ToolResult): string => r.content[0]?.text ?? "";

function simple(viewAlias: boolean) {
  return defineActionTool({
    viewAlias,
    actions: {
      next: { handler: () => ok("next") },
      month: {
        fields: ["month"],
        requires: [{ field: "month", message: "month 需为 YYYY-MM 格式" }],
        handler: (a) => ok(`month:${String(a.month)}`),
      },
    },
  });
}

function grouped() {
  // 混合同步/异步 handler：TS 只取首个候选推断 R，需显式声明联合返回类型
  return defineActionTool<"now" | "travel" | "set" | "clear", ToolResult | Promise<ToolResult>>({
    viewAlias: true,
    conflictShowsGroup: true,
    actions: {
      now: { handler: () => ok("now") },
      travel: { handler: () => ok("travel") },
      set: { group: "travel", handler: async () => ok("set") },
      clear: { group: "travel", handler: () => ok("clear") },
    },
  });
}

describe("defineActionTool resolve", () => {
  it("action 与 view 等价", () => {
    const t = simple(true);
    assert.deepEqual(t.resolve({ action: "next" }), { action: "next" });
    assert.deepEqual(t.resolve({ view: "next" }), { action: "next" });
    assert.deepEqual(t.resolve({ action: "next", view: "next" }), { action: "next" });
  });

  it("冲突：普通形态", () => {
    const r = simple(true).resolve({ action: "next", view: "month" });
    assert.deepEqual(r, { error: "action 与 view 冲突: action=next, view=month" });
  });

  it("冲突：带分组形态", () => {
    const r = grouped().resolve({ action: "set", view: "now" });
    assert.deepEqual(r, { error: "action 与 view 冲突: action=set（travel）, view=now" });
    const r2 = grouped().resolve({ action: "now", view: "travel" });
    assert.deepEqual(r2, { error: "action 与 view 冲突: action=now（now）, view=travel" });
  });

  it("group 匹配：action=set + view=travel 解析为 set", () => {
    assert.deepEqual(grouped().resolve({ action: "set", view: "travel" }), { action: "set" });
    assert.deepEqual(grouped().resolve({ view: "travel" }), { action: "travel" });
  });

  it("未知 action / 未知 view", () => {
    const t = simple(true);
    assert.deepEqual(t.resolve({ action: "zzz" }), { error: "未知 action: zzz" });
    assert.deepEqual(t.resolve({ view: "zzz" }), { error: "未知 action: zzz" });
    // view 不是任何 group 值（set 是 action 但不是 group 值）
    assert.deepEqual(grouped().resolve({ view: "set" }), { error: "未知 action: set" });
  });

  it("缺少 action", () => {
    assert.deepEqual(simple(true).resolve({}), { error: MISSING_ACTION_MESSAGE });
    assert.equal(MISSING_ACTION_MESSAGE, "缺少 action（或兼容别名 view）");
    assert.deepEqual(simple(false).resolve({}), { error: "未知 action: undefined" });
    assert.deepEqual(simple(false).resolve({ action: 5 }), { error: "未知 action: 5" });
  });

  it("未开启 viewAlias 时忽略 view", () => {
    assert.deepEqual(simple(false).resolve({ action: "next", view: "month" }), { action: "next" });
  });

  it("文案函数", () => {
    assert.equal(unknownFieldMessage("x", "pull"), "未知字段: x（action=pull 不接受）");
    assert.equal(unknownActionMessage(undefined), "未知 action: undefined");
  });
});

describe("defineActionTool handler", () => {
  it("resolve 失败返回错误结果", async () => {
    const r = await simple(true).handler({ action: "zzz" }, ctx);
    assert.equal(r.isError, true);
    assert.equal(text(r), "错误：未知 action: zzz");
  });

  it("未知字段拒绝；undefined 值与 view 键放行", async () => {
    const t = simple(true);
    const bad = await t.handler({ action: "month", month: "2026-01", foo: 1 }, ctx);
    assert.equal(text(bad), "错误：未知字段: foo（action=month 不接受）");
    const good = await t.handler({ action: "month", month: "2026-01", foo: undefined }, ctx);
    assert.equal(text(good), "month:2026-01");
    const withView = await t.handler({ view: "month", month: "2026-01" }, ctx);
    assert.equal(text(withView), "month:2026-01");
  });

  it("未开启 viewAlias 时 view 键不放行（fields 有定义）", async () => {
    const r = await simple(false).handler(
      { action: "month", month: "2026-01", view: "month" },
      ctx,
    );
    assert.equal(text(r), "错误：未知字段: view（action=month 不接受）");
  });

  it("fields 省略时不校验未知字段", async () => {
    const r = await simple(true).handler({ action: "next", anything: 1 }, ctx);
    assert.equal(text(r), "next");
  });

  it("requires：缺失、纯空白、顺序", async () => {
    const t = defineActionTool({
      actions: {
        a: {
          requires: [
            { field: "x", message: "need x" },
            { field: "y", message: "need y" },
          ],
          handler: () => ok("a"),
        },
      },
    });
    assert.equal(text(await t.handler({ action: "a" }, ctx)), "错误：need x");
    assert.equal(text(await t.handler({ action: "a", x: "  ", y: "" }, ctx)), "错误：need x");
    assert.equal(text(await t.handler({ action: "a", x: "1", y: " " }, ctx)), "错误：need y");
    assert.equal(text(await t.handler({ action: "a", x: "1", y: "2" }, ctx)), "a");
  });

  it("异步 handler 与分组 action 可执行；handler 抛错不被吞", async () => {
    const g = grouped();
    assert.equal(text(await g.handler({ action: "set", view: "travel" }, ctx)), "set");
    const t = defineActionTool({
      actions: {
        boom: {
          handler: () => {
            throw new Error("boom");
          },
        },
      },
    });
    assert.throws(() => t.handler({ action: "boom" }, ctx), /boom/);
  });
});

describe("defineActionTool 元数据", () => {
  it("actionNames 保持声明顺序，actionEnum 可 parse", () => {
    const t = grouped();
    assert.deepEqual(t.actionNames, ["now", "travel", "set", "clear"]);
    assert.equal(t.actionEnum().parse("set"), "set");
    assert.throws(() => t.actionEnum().parse("zzz"));
  });

  it("group 不是 action 名时 define 抛错", () => {
    assert.throws(
      () => defineActionTool({ actions: { a: { group: "nope", handler: () => ok("a") } } }),
      /group/,
    );
  });
});

describe("findUnknownField", () => {
  it("返回第一个未知键，跳过 action / skip / undefined", () => {
    assert.equal(findUnknownField({ action: "x", a: 1, b: 2 }, ["a"]), "b");
    assert.equal(findUnknownField({ action: "x", a: 1, b: undefined }, ["a"]), null);
    assert.equal(findUnknownField({ view: "x", a: 1 }, ["a"], ["action", "view"]), null);
    assert.equal(findUnknownField({ view: "x" }, []), "view");
  });
});

describe("defineActionTool 返回类型", () => {
  it("全同步 handler 的 dispatcher 同步返回 ToolResult（类型层面，无需 await）", () => {
    const tool = defineActionTool({
      actions: {
        a: { handler: () => ok("a") },
        b: { handler: () => ok("b") },
      },
    });
    const result: ToolResult = tool.handler({ action: "a" }, ctx);
    assert.equal(result.content[0]?.text, "a");
    const failed: ToolResult = tool.handler({ action: "zzz" }, ctx);
    assert.ok(text(failed).includes(unknownActionMessage("zzz")));
  });
});
