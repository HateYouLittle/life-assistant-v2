import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLogTimestamp } from "../src/core/logger.js";

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
