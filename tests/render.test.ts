import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { displayWidth, renderBlocks } from "../src/core/render.js";

describe("通知渲染", () => {
  const table = {
    table: {
      columns: ["项目", "内容"],
      rows: [
        ["天气", "晴 26°C"],
        ["空气质量", "优 (AQI 42)"],
      ],
    },
    notes: ["来源：QWeather"],
  };

  it("markdown：输出微信支持的表格", () => {
    const r = renderBlocks(table, "markdown");
    const lines = r.body.split("\n");
    assert.equal(lines[0], "| 项目 | 内容 |");
    assert.equal(lines[1], "| --- | --- |");
    assert.equal(lines[2], "| 天气 | 晴 26°C |");
    assert.equal(lines[4], "来源：QWeather");
  });

  it("markdown：竖线被转义，不破坏表格", () => {
    const r = renderBlocks({ table: { columns: ["a"], rows: [["x|y"]] } }, "markdown");
    assert.match(r.body, /x／y/);
  });

  it("plain：对齐文本表格（CJK 按 2 列宽）", () => {
    assert.equal(displayWidth("天气"), 4);
    assert.equal(displayWidth("ab"), 2);
    const r = renderBlocks(table, "plain");
    const lines = r.body.split("\n");
    const col1Width = (s: string): number => {
      const cut = s.indexOf("  ");
      return displayWidth(cut < 0 ? s : s.slice(0, cut));
    };
    assert.ok(lines.length >= 5, "应包含表头、分隔线与两行数据");
    assert.equal(
      col1Width(lines[0] ?? ""),
      col1Width(lines[2] ?? ""),
      "表头与数据行第一列应等宽对齐",
    );
    assert.equal(col1Width(lines[0] ?? ""), 8, "第一列宽度应取最宽单元格（空气质量=8）");
    assert.match(lines[1] ?? "", /^─+───+$/);
  });

  it("plain：超宽表格降级为键值逐行", () => {
    const wide = {
      table: {
        columns: ["超长项目名称一", "超长内容列一列一列"],
        rows: [["很长的值很长很长很长很长很长很长", "也很长的值也很长也很长也很长也很长"]],
      },
    };
    const r = renderBlocks(wide, "plain");
    assert.match(r.body, /超长项目名称一: 很长的值/);
  });

  it("空 blocks 渲染为空 body", () => {
    const r = renderBlocks({}, "markdown");
    assert.equal(r.body, "");
  });
});
