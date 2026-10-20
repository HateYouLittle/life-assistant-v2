import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, it } from "node:test";
import { rotateLogFile, rotateLogs } from "../src/core/logrotate.js";

/**
 * 日志轮转（copytruncate）：断言「原文件归零、轮转副本内容完整、保留份数、同秒不覆盖」。
 *
 * 失败路径刻意做成不抛错（skipped），因此这里对「文件不存在/目录不存在」也直接断言
 * 返回值而不是 assert.throws —— 一个日志文件坏掉不能连累另一个。
 */

function makeDir(): string {
  return mkdtempSync(join(tmpdir(), "life-assistant-logrotate-"));
}

function rotationNames(dir: string, base: string): string[] {
  const re = new RegExp(`^${base.replace(/\./g, "\\.")}\\.\\d{8}-\\d{6}(?:-\\d+)?\\.log$`);
  return readdirSync(dir)
    .filter((name) => re.test(name))
    .sort();
}

/** 2026-10-20 13:20:00.123Z = 上海 21:20:00.123 */
const NOW = new Date("2026-10-20T13:20:00.123Z");

describe("rotateLogFile（单文件 copytruncate）", () => {
  it("超过阈值：复制内容完整、原文件归零、文件名是本地时间戳", () => {
    const dir = makeDir();
    try {
      const file = join(dir, "daemon.err.log");
      const content = `${"x".repeat(2048)}\n最后一行\n`;
      writeFileSync(file, content);

      const result = rotateLogFile({ file, maxBytes: 1024, keep: 7, now: NOW });
      assert.equal(result.rotated, true);
      assert.equal(result.skipped, undefined);
      assert.equal(
        result.rotatedTo,
        join(dir, "daemon.err.log.20261020-212000.log"),
        "轮转文件名用 Asia/Shanghai 本地时间戳（UTC 13:20 = 上海 21:20）",
      );
      assert.equal(statSync(file).size, 0, "copytruncate 后原文件必须归零");
      assert.equal(readFileSync(result.rotatedTo ?? "", "utf8"), content, "副本必须是完整内容");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("未超过阈值：不动文件，返回 skipped 原因", () => {
    const dir = makeDir();
    try {
      const file = join(dir, "daemon.log");
      writeFileSync(file, "small");
      const result = rotateLogFile({ file, maxBytes: 1024, keep: 7, now: NOW });
      assert.equal(result.rotated, false);
      assert.equal(result.rotatedTo, undefined);
      assert.match(result.skipped ?? "", /未超过阈值/);
      assert.equal(readFileSync(file, "utf8"), "small");
      assert.equal(rotationNames(dir, "daemon.log").length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件/目录不存在：返回 skipped 而不抛错（一个文件坏不影响另一个）", () => {
    const dir = makeDir();
    try {
      const missing = rotateLogFile({
        file: join(dir, "nope.log"),
        maxBytes: 1,
        keep: 7,
        now: NOW,
      });
      assert.equal(missing.rotated, false);
      assert.match(missing.skipped ?? "", /不存在或不可访问/);

      const noDir = rotateLogFile({
        file: join(dir, "no-such-dir", "daemon.log"),
        maxBytes: 1,
        keep: 7,
        now: NOW,
      });
      assert.equal(noDir.rotated, false);
      assert.match(noDir.skipped ?? "", /不存在或不可访问/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("保留策略：同一基础文件只留最近 keep 份，删掉最旧的", () => {
    const dir = makeDir();
    try {
      const file = join(dir, "daemon.log");
      const rotated: string[] = [];
      for (let i = 0; i < 3; i += 1) {
        writeFileSync(file, `round-${i}-${"y".repeat(256)}`);
        const result = rotateLogFile({
          file,
          maxBytes: 128,
          keep: 2,
          now: new Date(NOW.getTime() + i * 1000),
        });
        assert.equal(result.rotated, true);
        rotated.push(result.rotatedTo ?? "");
      }
      const names = rotationNames(dir, "daemon.log");
      assert.equal(names.length, 2, "keep=2 时只保留最近两份");
      assert.ok(!names.includes(basename(rotated[0] ?? "")), "最旧一份应被删除");
      assert.ok(readFileSync(rotated[2] ?? "", "utf8").startsWith("round-2-"));
      assert.ok(readFileSync(rotated[1] ?? "", "utf8").startsWith("round-1-"));
      assert.equal(existsSync(rotated[0] ?? ""), false, "被删的最旧轮转文件不应还存在");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("同一秒轮转两次：不覆盖，第二个加 -1 后缀且内容各自完整", () => {
    const dir = makeDir();
    try {
      const file = join(dir, "daemon.err.log");
      writeFileSync(file, `first-${"a".repeat(512)}`);
      const first = rotateLogFile({ file, maxBytes: 128, keep: 7, now: NOW });
      writeFileSync(file, `second-${"b".repeat(512)}`);
      const second = rotateLogFile({ file, maxBytes: 128, keep: 7, now: NOW });

      assert.equal(first.rotated, true);
      assert.equal(second.rotated, true);
      assert.notEqual(first.rotatedTo, second.rotatedTo, "同秒轮转不能互相覆盖");
      assert.equal(second.rotatedTo, join(dir, "daemon.err.log.20261020-212000-1.log"));
      assert.ok(readFileSync(first.rotatedTo ?? "", "utf8").startsWith("first-"));
      assert.ok(readFileSync(second.rotatedTo ?? "", "utf8").startsWith("second-"));
      assert.equal(rotationNames(dir, "daemon.err.log").length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("rotateLogs（两个 launchd 日志文件）", () => {
  it("默认处理 daemon.err.log 与 daemon.log：各自轮转、freedBytes 累加，小文件进 skipped", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "daemon.err.log"), "e".repeat(2048));
      writeFileSync(join(dir, "daemon.log"), "o".repeat(64));
      const result = rotateLogs({ dir, maxBytes: 1024, keep: 7, now: NOW });

      assert.deepEqual(result.rotated, [join(dir, "daemon.err.log")], "只有超阈值的文件被轮转");
      assert.equal(result.freedBytes, 2048, "freedBytes 是清空的活动日志字节数");
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0]?.file, join(dir, "daemon.log"));
      assert.match(result.skipped[0]?.reason ?? "", /未超过阈值/);
      assert.equal(statSync(join(dir, "daemon.err.log")).size, 0);
      assert.equal(readFileSync(join(dir, "daemon.log"), "utf8"), "o".repeat(64));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("两个文件都超阈值：都轮转，磁盘上各一份完整副本", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "daemon.err.log"), "err".repeat(512));
      writeFileSync(join(dir, "daemon.log"), "out".repeat(512));
      const result = rotateLogs({ dir, maxBytes: 256, keep: 7, now: NOW });
      assert.equal(result.rotated.length, 2);
      assert.deepEqual(result.skipped, []);
      assert.equal(result.freedBytes, 1536 * 2);
      assert.equal(rotationNames(dir, "daemon.err.log").length, 1);
      assert.equal(rotationNames(dir, "daemon.log").length, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("目录不存在：全部 skipped、不抛错、freedBytes 为 0", () => {
    const dir = join(makeDir(), "missing");
    const result = rotateLogs({ dir, maxBytes: 1, keep: 7, now: NOW });
    assert.deepEqual(result.rotated, []);
    assert.equal(result.skipped.length, 2, "两个默认日志文件都应进 skipped");
    assert.equal(result.freedBytes, 0);
    for (const skipped of result.skipped) {
      assert.match(skipped.reason, /不存在或不可访问/);
    }
  });

  it("自定义 files 列表（只处理指定文件）", () => {
    const dir = makeDir();
    try {
      writeFileSync(join(dir, "custom.log"), "z".repeat(512));
      writeFileSync(join(dir, "ignored.log"), "z".repeat(512));
      const result = rotateLogs({
        dir,
        maxBytes: 128,
        keep: 3,
        files: ["custom.log"],
        now: NOW,
      });
      assert.deepEqual(result.rotated, [join(dir, "custom.log")]);
      assert.equal(rotationNames(dir, "custom.log").length, 1);
      assert.equal(statSync(join(dir, "ignored.log")).size, 512, "未列出的文件不受影响");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
