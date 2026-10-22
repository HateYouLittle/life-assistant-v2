import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLogTimestamp, sanitizeLogText } from "../src/core/logger.js";

/**
 * 日志时间戳：本地（Asia/Shanghai）带偏移的 ISO 8601。
 * 排查时看的是「本地几点」，但机器仍要能解析 —— 两个要求在这里一起钉住。
 */
describe("formatLogTimestamp", () => {
  it("Unix 纪元：输出上海本地时间 +08:00（不是 UTC 的 00:00）", () => {
    assert.equal(formatLogTimestamp(new Date(0)), "1970-01-01T08:00:00.000+08:00");
  });

  it("指定时刻：UTC 13:20:00.123Z → 21:20:00.123+08:00，且 Date.parse 能还原同一瞬间", () => {
    const date = new Date("2026-10-20T13:20:00.123Z");
    const stamp = formatLogTimestamp(date);
    assert.equal(stamp, "2026-10-20T21:20:00.123+08:00");
    assert.equal(Date.parse(stamp), date.getTime(), "带偏移的 ISO 8601 必须可被机器解析");
  });

  it("格式稳定：毫秒三位、带 +08:00 偏移（无 DST，偏移恒为 +08:00）", () => {
    const stamp = formatLogTimestamp(new Date("2026-01-15T00:00:00.000Z"));
    assert.match(stamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+08:00$/);
    assert.ok(stamp.endsWith("+08:00"));
    assert.equal(new Date(stamp).toISOString(), "2026-01-15T00:00:00.000Z");
  });

  it("缺省参数：当前时刻同样可解析（logger 每行都走这条路径）", () => {
    const before = Date.now();
    const stamp = formatLogTimestamp();
    const parsed = Date.parse(stamp);
    const after = Date.now();
    assert.ok(Number.isFinite(parsed), `时间戳不可解析: ${stamp}`);
    assert.ok(parsed >= before - 1000 && parsed <= after + 1000, `时间戳偏离当前时刻: ${stamp}`);
  });
});

/**
 * 日志字段净化：外部可控文本（path/来源地址/失败原因）拼进单行日志前必须剔除全部
 * 「换行等价物」。除 C0/DEL 外，C1 区（U+0080–U+009F，含 NEL U+0085）与 U+2028/U+2029
 * 在部分工具（Python `splitlines()`、部分 grep/编辑器）里同样按行拆分 —— 单个原始 HTTP
 * 头字节就可能把一行审计日志拆成两行。
 */
describe("sanitizeLogText", () => {
  it("去掉 C0/DEL 与 C1（含 NEL U+0085、0x9F）控制字符", () => {
    assert.equal(sanitizeLogText("a\u001bb\u007fc\u0085d\u009fe"), "abcde");
    assert.equal(sanitizeLogText("\u0000\u0008\u000a\u000dX"), "X");
  });

  it("去掉 U+2028/U+2029 行/段分隔符", () => {
    assert.equal(sanitizeLogText("行1\u2028行2\u2029行3"), "行1行2行3");
  });

  it("混合控制字符 + 超长：先净化再按 maxLength 截断（补省略号）", () => {
    const raw = `\u0000\u0085\u2028\u2029${"x".repeat(300)}`;
    assert.equal(sanitizeLogText(raw, 10), `${"x".repeat(10)}…`);
    assert.equal(sanitizeLogText(raw, 200), `${"x".repeat(200)}…`);
    assert.equal(
      sanitizeLogText(`\u0085\u2028${"x".repeat(299)}`, 300),
      "x".repeat(299),
      "净化后不足上限时不截断",
    );
  });

  it("正常文本（含中文/emoji）原样保留", () => {
    assert.equal(sanitizeLogText("鉴权失败: /api/status 🚫"), "鉴权失败: /api/status 🚫");
    assert.equal(sanitizeLogText("", 200), "");
  });
});
