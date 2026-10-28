import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { statusPage } from "../src/server/page.js";
import { SCRIPT, STYLE } from "../src/server/page-script.js";

/**
 * 状态页内联脚本的语法闸门（P2-23）。
 *
 * 起因：那段浏览器 JS 过去整段躺在 page.ts 的模板字符串里，tsc/biome 都看不见字符串内部 ——
 * 一个手滑的括号、漏掉的引号不会在 typecheck/lint/build 暴露，只在浏览器里白屏。
 * 现在字符串本体搬到 src/server/page-script.ts 并导出，本文件把「字符串 → 临时 .mjs →
 * `node --check`」跑成一条测试，任何语法级错误都会在 CI 直接变红。
 *
 * 校验器自身也要「改错即失败」：下面的变异自证故意把脚本改坏，断言 --check 必须报错，
 * 否则这条测试可能只是恒绿的摆设（例如路径写错、根本没跑起 node）。
 */

interface SyntaxCheck {
  ok: boolean;
  /** 报错输出（成功时为空串），断言失败时带进消息便于定位 */
  stderr: string;
}

/** 把一段 JS 文本落到临时 .mjs，用 `node --check` 做纯语法校验（不执行、不需要 DOM） */
function checkSyntax(source: string): SyntaxCheck {
  const dir = mkdtempSync(join(tmpdir(), "la-page-script-"));
  try {
    const file = join(dir, "page-script.mjs");
    writeFileSync(file, source, "utf8");
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    return { ok: result.status === 0, stderr: `${result.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 从页面 HTML 里取出某个标签的内联内容（状态页只有一处 <style> 与一处 <script>） */
function inlineOf(html: string, tag: "style" | "script"): string {
  const matched = new RegExp(`<${tag}[^>]*>([\\s\\S]*)</${tag}>`).exec(html);
  assert.ok(matched?.[1] !== undefined, `页面里应当有内联 <${tag}>`);
  return matched[1];
}

/** 花括号配平（CSS 没有可用的语法校验器，这是最小结构闸门） */
function bracesBalanced(source: string): boolean {
  let depth = 0;
  for (const ch of source) {
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    if (depth < 0) return false;
  }
  return depth === 0;
}

describe("状态页内联脚本语法（node --check）", () => {
  it("导出的 SCRIPT 是合法 JS：临时 .mjs + node --check 通过", () => {
    const checked = checkSyntax(SCRIPT);
    assert.ok(checked.ok, `内联脚本语法错误：\n${checked.stderr}`);
    // 空串/被截断的脚本会让 --check 白白通过，先钉住「确实是那段脚本」
    assert.ok(SCRIPT.length > 30_000, `脚本长度异常（${SCRIPT.length}），疑似搬移被截断`);
    for (const entry of [
      "openDrawer",
      "openExpenses",
      "openSchedules",
      "openDeliveries",
      "openHolidays",
      "openJobs",
      "openBudget",
      "openSystem",
    ]) {
      assert.ok(SCRIPT.includes(`function ${entry}`), `内联脚本应含抽屉入口 ${entry}()`);
    }
  });

  it("校验器能抓出语法错误（变异自证：改坏 → 必须变红）", () => {
    // ① 追加一条坏语句：证明 --check 真的在解析这份文件
    const appended = `${SCRIPT}\nvar broken = ;\n`;
    const appendedCheck = checkSyntax(appended);
    assert.equal(appendedCheck.ok, false, "追加语法错误后 --check 竟然通过，校验器没生效");
    assert.match(appendedCheck.stderr, /SyntaxError|Unexpected token/);

    // ② 在脚本靠后的位置把 `function ` 改坏（`function (`）：证明整段脚本都被解析，
    //    而不是只看了开头几条语句就收工。用 lastIndexOf 定位，避免钉死具体某行的写法。
    const anchor = SCRIPT.lastIndexOf("function ");
    assert.ok(anchor > SCRIPT.length / 2, "变异锚点应落在脚本后半段");
    const mutated = `${SCRIPT.slice(0, anchor)}function (${SCRIPT.slice(anchor + "function ".length)}`;
    assert.notEqual(mutated, SCRIPT, "变异没有生效，下面的断言会失去意义");
    const mutatedCheck = checkSyntax(mutated);
    assert.equal(mutatedCheck.ok, false, "函数定义被改坏竟然通过 --check");
    assert.match(mutatedCheck.stderr, /SyntaxError|Unexpected token/);
  });

  it("页面内联内容与导出的字符串逐字一致（搬移零漂移）", () => {
    const html = statusPage("2.0.0");
    // 搬移前后 statusPage 整页输出已逐字节比对（sha256 66a8baf2b97e64eb / script 3176729bdc8be73e），
    // 这条断言把「页面里注入的就是导出的常量」固定下来，防止将来有人再复制一份字符串。
    assert.equal(inlineOf(html, "script"), SCRIPT, "页面内联脚本与导出的 SCRIPT 不一致");
    assert.equal(inlineOf(html, "style"), STYLE, "页面内联样式与导出的 STYLE 不一致");
    // 带 nonce 时脚本本体不变（nonce 只加在标签属性上）
    assert.equal(inlineOf(statusPage("2.0.0", "NONCE"), "script"), SCRIPT);
  });

  it("STYLE 花括号配平（最小结构闸门 + 变异自证）", () => {
    assert.ok(STYLE.length > 5_000, `样式长度异常（${STYLE.length}）`);
    assert.ok(bracesBalanced(STYLE), "STYLE 花括号不配平");
    assert.equal(bracesBalanced(`${STYLE}\n.x { color: red;`), false, "配平检查抓不出缺失的右括号");
    assert.equal(bracesBalanced(`${STYLE}\n}`), false, "配平检查抓不出多余的右括号");
  });
});
