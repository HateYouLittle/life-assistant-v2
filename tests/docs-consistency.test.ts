import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 文档/约定一致性回归：package.json 里带 --env-file 的脚本清单必须与 README / .env.example
 * 的说明同步（曾漏列 db:cleanup:preview）；GeoAPI「不得落盘」条款必须带 locate 例外说明
 * （locate 显式选定的位置是用户配置，不是缓存/批量索引——文档漏了例外会让实现看起来违约）；
 * 测试代码造日历日必须走本地时区（AGENTS.md：时区固定 Asia/Shanghai，本地日历日是 YYYY-MM-DD）。
 */

const read = (path: string): string => readFileSync(path, "utf8");

/**
 * 取出「哪些脚本会自动读 .env」的那一条清单说明。
 *
 * 曾经的坑（N10）：只用 `split(/\n\n/).find(p => p.includes("--env-file-if-exists"))`，
 * 在 AGENTS.md 上命中的是一整个**合并段**（485 字符、4 个 bullet）—— 同段里
 * 「npm start」「db:cleanup:preview 同理」这些**不相干**的句子用子串 `includes(name)`
 * 顶替了清单断言，于是删掉整条 .env 清单 bullet，用例仍只对 doctor 报错、其余 5 个全绿。
 *
 * 修法两步：
 * 1. 锚定到清单专属措辞（各文档的清单句式不同，逐个给出 anchor），排除同文档里其它
 *    提到 --env-file 的段落（如 README 的 systemd `ExecStart` 行、bash 代码块）；
 * 2. 同时按「行首 `- ` 的 bullet」和「空行分段」两种粒度切，取命中段。
 *    曾取**最短**的那一段（N14 已修）：清单被拆成多个 bullet/段落时那会误报，
 *    现在改为**所有**命中段拼起来一起断言（见 envFileList 的注释）。
 * 找不到返回 undefined（由调用方把所有名字报成缺失，不用 assert 提前中断，
 * 这样删掉整条 bullet 时 6 个名字会一起变红，而不是只报一条）。
 */
const ENV_FILE_LIST_ANCHOR: Record<string, string> = {
  "AGENTS.md": "只会被",
  "README.md": "自动读取同目录",
  ".env.example": "自动读取本文件",
};

/** 纯函数版（envFileList 的实现本体），拆出来是为了让变异自证用例能直接驱动**真实实现** */
function envFileListFrom(text: string, anchor: string | undefined): string | undefined {
  const hasAnchor = (p: string): boolean =>
    p.includes("--env-file-if-exists") && (anchor === undefined || p.includes(anchor));
  // N14：清单被拆成**多个 bullet / 多个段落**时（每段都带 anchor 与 --env-file-if-exists），
  // 取「最短的一段」会把后半的名字判成「文档漏列」—— 文档写得越清楚，用例越红。
  // 故把**所有**命中段按它们在原文里的出现顺序拼起来再断言：
  // `  · 每个名字出现在任一段里即算已列（等价于拼接后的子串匹配，但不受段间顺序影响）
  //    删掉整条 bullet → 那个名字在任何一段里都不存在 → 仍红（漏报防护不损失）
  //    只删其中一个名字 → 只有那一个红`
  // 注意不能退回到「取整段」（N10 的坑）：同段里「npm start」「db:backup 同理」等
  // 不相干句子会用子串顶替清单断言。listsScript 的整名边界正则已挡住 `start`↔`restart`
  // 这类顶替，anchor 又把范围收在清单句上，故拼接是安全的。
  const segments = text
    .split(/\n(?=\s*-\s)|\n\n/)
    .map((p) => p.trim())
    .filter((p) => p !== "");
  const hits = segments.filter(hasAnchor);
  if (hits.length === 0) return undefined;
  return hits.join("\n");
}

function envFileList(file: string): string | undefined {
  return envFileListFrom(read(file), ENV_FILE_LIST_ANCHOR[file]);
}

/**
 * 清单里是否**整名**提到了该脚本。
 *
 * 子串 `includes(name)` 会被更长的名字顶替（`start` 命中 `restart`、`dev` 命中
 * `dev:*` 变体），且同段里毫不相干的句子也能顶替（见 envFileList 的注释）。
 * 这里要求名字前后都不是「标识符字符」：字母数字与 `_ : . - *` 都不算边界，
 * 故 `dev` 不会命中 `dev:*`、`start` 不会命中 `restart`。
 * 三个文档的清单写法不同（AGENTS 用反引号整名、README 用 `npm run x`、
 * .env.example 无反引号），故不能锚定某一种字面形态。
 */
function listsScript(bullet: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w:.*-])${escaped}(?![\\w:.*-])`).test(bullet);
}

describe("文档一致性", () => {
  it("package.json 带 --env-file 的脚本都写进 README 与 .env.example 的清单", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const withEnvFile = Object.entries(pkg.scripts)
      .filter(([, cmd]) => cmd.includes("--env-file-if-exists"))
      .map(([name]) => name)
      // dev:* 变体在文档中统一以「及其 dev:* 变体」表述，不逐个列名
      .filter((name) => !name.startsWith("dev:"));
    assert.ok(
      withEnvFile.length >= 4,
      `应至少有 start/dev/db:backup/db:cleanup:preview/import:v1，实际 ${withEnvFile.join(", ")}`,
    );

    const readmeList = envFileList("README.md") ?? "";
    const envExampleList = envFileList(".env.example") ?? "";
    const missing = withEnvFile.filter(
      (name) => !listsScript(readmeList, name) || !listsScript(envExampleList, name),
    );
    assert.deepEqual(
      missing,
      [],
      `README / .env.example 的 --env-file 清单缺 ${missing.join(" / ")}（清单必须与 package.json 同步）`,
    );
  });

  it("SKILL.md 的农历 interval 条款不承诺「填了会直接报错」", () => {
    // 回归（N11）：条款曾写「填 interval: 2 会直接报错」，但这只在**显式传**时成立。
    // 当时有两条绕过路径（solar→lunar 转换不传 recurrence、import:v1 裸 INSERT），
    // 文档的过度承诺让 agent 无法判断该行还能不能编辑。N9 已在写入侧收口，
    // 这里钉住文档口径与实装一致：必须同时说清「显式传才报错」与「旧数据仍可编辑」。
    const skill = read("skill/SKILL.md");
    const clause = skill.split(/\n(?=\s*-\s)/).find((p) => p.includes("农历日程只支持按年循环"));
    assert.ok(clause !== undefined, "SKILL.md 应有农历循环条款");
    // 「农历只支持按年循环」这条主口径必须在
    assert.match(clause, /农历/, "条款应说明农历只支持按年循环");
    // 过度承诺：整句断言「填了必报错」——只在显式传时成立
    assert.doesNotMatch(
      clause,
      /填 `?interval: \d+`? 会直接报错/,
      "农历 interval 并非一律报错（转换/导入路径按 1 收敛），不得写成「填了就报错」",
    );
    // 必须写清显式传才是报错路径
    assert.match(clause, /显式传[^\n]*直接报错/, "必须写明只有显式传 recurrence 才会直接报错");
    // 必须写清旧数据仍可编辑（agent 读到回显带 interval=N 不生效时需要据此判断）
    assert.match(
      clause,
      /旧数据[^\n]*仍可正常编辑/,
      "必须写明 interval>1 的存量农历行仍可正常编辑（改标题/备注不会被拒）",
    );
  });

  it("GeoAPI「不得落盘」条款带 locate 显式选定位置的例外说明", () => {
    const locateException = "显式选定的位置会作为该 Profile 的配置长期保存";
    assert.ok(
      read("README.md").includes(locateException),
      "README 的 GeoAPI 条款应说明 locate 选定位置属用户配置例外",
    );
    assert.ok(
      read("AGENTS.md").includes(locateException),
      "AGENTS.md 的 GeoAPI 条款应说明 locate 选定位置属用户配置例外",
    );
  });

  it("清单断言在「拆成多个 bullet / 段落」时不误报，且不牺牲漏报防护（envFileList 变异自证）", () => {
    // N14：envFileList 曾取「最短的命中段」。清单被拆成两段（每段都带 anchor 与
    // --env-file-if-exists）时，后半的名字被判「文档漏列」——文档写得越碎，用例越红。
    // 修法是合并所有命中段。这里用**合成的内存文档**跑同一套 envFileList + listsScript
    // 做三向变异自证（不依赖真实文档形状，断言精确）：
    //   ① 删整条清单 bullet      → 6 个名字**全红**（漏报防护不损失）
    //   ② 清单拆成两个 bullet     → **零红**（修复目标）
    //   ③ 只删其中一个名字        → **只有那一个红**（不多报不少报）
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const names = Object.entries(pkg.scripts)
      .filter(([, cmd]) => cmd.includes("--env-file-if-exists"))
      .map(([name]) => name)
      .filter((name) => !name.startsWith("dev:"));
    // 驱动**真实实现**（envFileListFrom 就是 envFileList 的本体），不复制一份逻辑
    const missing = (doc: string, anchor: string): string[] =>
      names.filter((name) => !listsScript(envFileListFrom(doc, anchor) ?? "", name));

    const bulletOf = (doc: string): string =>
      doc.split(/\n(?=\s*-\s)/).find((p) => p.includes("只会被")) ?? "";
    const doc = read("AGENTS.md");
    const realBullet = bulletOf(doc);
    assert.notEqual(realBullet, "", "夹具前提：AGENTS.md 应有一条含 anchor 的清单 bullet");

    // 0) 基线：真实文档零缺失（修法没有把现状判成红）
    assert.deepEqual(
      names.filter((name) => !listsScript(envFileList("AGENTS.md") ?? "", name)),
      [],
      "真实 AGENTS.md 的清单应覆盖全部带 --env-file 的脚本",
    );

    // ① 删整条清单 bullet → 6 个名字全红
    assert.deepEqual(
      missing(doc.replace(realBullet, ""), "只会被"),
      names,
      "删掉整条清单 bullet 时全部名字都必须报缺失（漏报防护）",
    );

    // ② 清单拆成两个 bullet（前半 3 个 + 后半 3 个，都仍带 anchor 与 --env-file）→ 零红
    const half = Math.ceil(names.length / 2);
    const twoBullets = [
      `- \`.env\` 只会被 ${names
        .slice(0, half)
        .map((n) => `\`${n}\``)
        .join(" / ")} 通过 \`--env-file-if-exists\` 自动读取。`,
      `- ${names
        .slice(half)
        .map((n) => `\`${n}\``)
        .join(" / ")} 及其 \`dev:*\` 变体同样只会被 \`--env-file-if-exists\` 自动读取。`,
    ].join("\n");
    assert.deepEqual(
      missing(twoBullets, "只会被"),
      [],
      "清单拆成两个 bullet 时不得误报（N14 的修复目标）",
    );
    // 自证：修法前的「取最短命中段」实现确实会在这份文档上误报
    const halves = twoBullets
      .split(/\n(?=\s*-\s)|\n\n/)
      .map((p) => p.trim())
      .filter((p) => p.includes("--env-file-if-exists") && p.includes("只会被"));
    const shortest = halves.sort((a, b) => a.length - b.length)[0] ?? "";
    assert.ok(
      names.filter((name) => !listsScript(shortest, name)).length > 0,
      "变异自证的前提：旧的「取最短段」实现在拆段文档上确实会误报",
    );

    // ③ 只删其中一个名字 → 只有那一个红
    const dropOne = twoBullets.replace(`\`${names[0]}\` / `, "");
    assert.deepEqual(
      missing(dropOne, "只会被"),
      [names[0]],
      "只删一个名字时只能报那一个（不能顺带把别的也判成缺失）",
    );
  });

  it("--env-file 脚本清单也要写进 AGENTS.md（曾漏列 doctor/dev:doctor）", () => {
    // 回归（N10）：这条用例曾近乎恒真 —— 段落切分命中的是一整个 4-bullet 合并段，
    // 「npm start」「db:backup 同理」等不相干句子用子串匹配顶替了清单断言。
    // 报者的变异验证：删掉整条 .env 清单 bullet，用例仍只对 doctor 报错，其余 5 个全绿。
    // 现在锚定到 bullet 粒度 + 整名匹配，删 bullet 会让 6 个名字全部报错。
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    const withEnvFile = Object.entries(pkg.scripts)
      .filter(([, cmd]) => cmd.includes("--env-file-if-exists"))
      .map(([name]) => name)
      // dev:* 变体在文档中统一以「及其 dev:* 变体」表述，不逐个列名
      .filter((name) => !name.startsWith("dev:"));
    const agentsList = envFileList("AGENTS.md") ?? "";
    const missing = withEnvFile.filter((name) => !listsScript(agentsList, name));
    assert.deepEqual(
      missing,
      [],
      `AGENTS.md 的 --env-file 清单缺 ${missing.join(" / ")}（清单必须与 package.json 同步）`,
    );
  });
});

/**
 * `/` 处于「正则位置」的启发式：前一个有效字符是运算符/左括号/赋值/分隔符，或前一个词是
 * `return`/`typeof` 等关键字。反之（前面是标识符、数字、`)`、`]`）就是普通除法。
 * 不做完整语法分析 —— 只需要在「像正则」的位置尝试按正则字面量解析，解析失败就当除法。
 */
const REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);

function regexCanStartHere(prevCodeChar: string | null, prevWord: string): boolean {
  if (prevWord !== "" && REGEX_PRECEDING_KEYWORDS.has(prevWord)) return true;
  if (prevCodeChar === null) return true;
  return "([{=,:;!&|?+-*%<>~^".includes(prevCodeChar);
}

/**
 * 只留可执行代码：剥掉注释，并把字符串/模板/正则字面量的**内容**换成空格。
 * 换行保留、**长度逐字符不变**（行号与命中下标因此仍指向原文）。
 *
 * 逐字符单遍扫描：只有处在「代码位置」时 `//`、`/*` 才是注释，引号才开启字面量，
 * `/` 才可能是正则起点。四个必须处理的坑（每一个都实测造成过漏报或误报）：
 * - 行尾注释要连着前面的代码一起剥：`const x = y; // 反例 new Date().toISOString()` 这行
 *   整行 trimStart 后并不以 `//` 开头，只按整行过滤会把注释里的反例当代码报出来（误报）。
 * - 字符串字面量里的 `//`（如 "http://x"）不是注释起点；反过来字符串里的内容也不是可执行
 *   代码（字符串里写反例是正当的 —— 本文件自己就要写）。
 * - **模板串要按深度处理**：一遇反引号就整段抹白会把插值表达式（源文件里的反引号 +
 *   `${` + 表达式 + `}`）里的真实代码一起吞掉（曾整段漏报）。只有匹配到**同层未转义**
 *   的反引号才结束模板；插值表达式内继续按代码扫描（内层的字符串/正则要剥、内层的
 *   `//` 要当注释），且其中可再嵌模板串 —— 故 scan 是递归的，并用花括号深度配对。
 * - **要识别正则字面量**：`/\/\//` 的第二个 `/` 会被当成 `//` 注释起点把后文吞掉，
 *   `/'/g` 里的 `'` 会被当成单引号字面量起点（两者都实测漏报）。按 `\/` 转义规则跳过，
 *   并用「前一字符/词」启发式区分正则与除法。
 */
function codeOnly(src: string): string {
  const out: string[] = [];
  /** 前一个非空白代码字符 / 前一个词（供正则位置启发式用） */
  let prevCodeChar: string | null = null;
  let prevWord = "";

  /** 抹白 [from, to)：保留换行，长度不变 */
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k += 1) out.push(src[k] === "\n" ? "\n" : " ");
  };
  /** 保留一个代码字符，并更新正则位置启发式所需的状态 */
  const emit = (c: string): void => {
    out.push(c);
    if (/\s/.test(c)) return;
    prevCodeChar = c;
    prevWord = /[A-Za-z_$]/.test(c) ? prevWord + c : "";
  };
  /** 字面量/注释结束后：前一字符不再是标识符，切断正则启发式的词状态 */
  const afterLiteral = (): void => {
    prevCodeChar = null;
    prevWord = "";
  };

  /** 单/双引号字面量：返回结束后的下标 */
  const scanQuoted = (start: number, quote: string): number => {
    blank(start, start + 1);
    let i = start + 1;
    while (i < src.length) {
      const c = src[i] as string;
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === quote) {
        blank(i, i + 1);
        return i + 1;
      }
      if (c === "\n") break; // 未闭合的字面量不跨行吞掉后续代码
      blank(i, i + 1);
      i += 1;
    }
    blank(i, i + 1);
    return i + 1;
  };

  /** 正则字面量的结束下标（不含）；未闭合返回 -1（调用方按普通除法处理） */
  const regexEnd = (start: number): number => {
    let i = start + 1;
    let inClass = false;
    while (i < src.length) {
      const c = src[i] as string;
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === "\n") return -1; // 未闭合，不吞掉后续代码
      if (c === "[") inClass = true;
      else if (c === "]") inClass = false;
      else if (c === "/" && !inClass) {
        // 跟上标志位（gimsuy 与 d v）
        let j = i + 1;
        while (j < src.length && /[a-z]/.test(src[j] as string)) j += 1;
        return j;
      }
      i += 1;
    }
    return -1;
  };

  /** 模板串：返回结束后的下标；`${` 内交给 scan 按代码解析（可递归嵌套） */
  const scanTemplate = (start: number): number => {
    blank(start, start + 1);
    let i = start + 1;
    while (i < src.length) {
      const c = src[i] as string;
      if (c === "\\") {
        blank(i, i + 2);
        i += 2;
        continue;
      }
      if (c === "`") {
        blank(i, i + 1);
        return i + 1;
      }
      if (c === "$" && src[i + 1] === "{") {
        blank(i, i + 2);
        // 内层 scan 停在配对的 `}` 上（花括号深度已在 scan 内计数）
        const end = scan(i + 2, true);
        blank(end, end + 1);
        i = end + 1;
        continue;
      }
      blank(i, i + 1);
      i += 1;
    }
    return i;
  };

  /**
   * 从 from 开始按代码扫描。`stopAtBrace=true` 时在**深度回到 0** 的 `}` 处停下
   * 并返回它的下标（供模板串 `${}` 配对），否则扫到输入末尾返回 src.length。
   */
  const scan = (from: number, stopAtBrace: boolean): number => {
    let i = from;
    let depth = 0;
    while (i < src.length) {
      const c = src[i] as string;
      const next = src[i + 1];
      if (c === "}") {
        if (stopAtBrace && depth === 0) return i;
        depth -= 1;
      } else if (c === "{") {
        depth += 1;
      }
      if (c === "/" && next === "/") {
        const eol = src.indexOf("\n", i);
        const end = eol === -1 ? src.length : eol;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === "/" && next === "*") {
        let end = src.indexOf("*/", i + 2);
        end = end === -1 ? src.length : end + 2;
        blank(i, end);
        i = end;
        continue;
      }
      if (c === '"' || c === "'") {
        i = scanQuoted(i, c);
        afterLiteral();
        continue;
      }
      if (c === "`") {
        i = scanTemplate(i);
        afterLiteral();
        continue;
      }
      if (c === "/") {
        const end = regexCanStartHere(prevCodeChar, prevWord) ? regexEnd(i) : -1;
        if (end > 0) {
          blank(i, end);
          i = end;
          afterLiteral();
          continue;
        }
      }
      emit(c);
      i += 1;
    }
    return i;
  };

  scan(0, false);
  return out.join("");
}

/**
 * 匹配必须跨行：Biome 在 100 列上限下会自动折行，
 * `new Date()\n  .toISOString()\n  .slice(0, 10)` 是完全正常的写法形态，
 * 逐行匹配会漏掉它（曾实测漏报）。
 *
 * 用正则字面量而不是 `new RegExp`：反斜杠写法一致，且 codeOnly 只剥注释、字符串/模板/
 * 正则字面量，正则字面量本身属于「代码位置」会被扫到 —— 但它写的是 `\.toISOString\(\)`
 * （带反斜杠），与本模式要求的 `.toISOString()` 字面量不匹配，所以扫描本文件时不会把自己报出来。
 *
 * global 必需：非 global 时只报首个命中，同一文件后面的违规全被无视（曾如此），
 * `matchAll` 也会直接抛 TypeError 要求 global。
 */
const UTC_DATE_SLICE = /\.toISOString\(\)[\s\S]{0,60}?\.slice\(\s*0\s*,/g;

/**
 * 递归收集目录下所有 .ts（含子目录）。
 * 曾用非递归的 readdirSync(dir).filter(.ts) —— 当前 tests/ 恰好是平目录所以没暴露，
 * 将来加子目录就会静默漏扫。返回相对 dir 的 posix 风格路径。
 */
function scanTestFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...scanTestFiles(join(dir, entry.name), rel));
    else if (entry.name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** 扫出目录下所有 UTC 日历日反例；用 matchAll 报全部命中（exec 只会给首个） */
function scanUtcDateSlice(dir: string): string[] {
  const offenders: string[] = [];
  for (const rel of scanTestFiles(dir)) {
    const code = codeOnly(readFileSync(join(dir, rel), "utf8"));
    for (const match of code.matchAll(UTC_DATE_SLICE)) {
      const line = code.slice(0, match.index).split("\n").length;
      offenders.push(`${rel}:${line}: ${match[0].replace(/\s+/g, " ")}`);
    }
  }
  return offenders;
}

/**
 * 命中次数（与扫描路径同一个模式，但每次新建正则）。
 * **不能用 `UTC_DATE_SLICE.test()`**：global 正则的 `test` 会推进 lastIndex，
 * 同一个正则连着多次调用会交替给出 true/false（实测踩过）。
 */
const flagged = (src: string): number => [...codeOnly(src).matchAll(UTC_DATE_SLICE)].length;

describe("测试代码的时区约定", () => {
  it("不得用 UTC 日历日构造 spent_on/日期（本地日历日是 Asia/Shanghai 的 YYYY-MM-DD）", () => {
    // 回归：tests/status.test.ts 曾用 `new Date().toISOString().slice(0, 10)` 取「今天」，
    // 那是 UTC 日 —— 本地时间 00:00-08:00 且本地日是当月 1 号时，落在月初之前，
    // 当月计数恒为 0，测试随机变红。要日历日就用 src/time.ts 的 todayIso()。
    const testDir = fileURLToPath(new URL("./", import.meta.url));
    // 递归扫描（子目录也算），并用 matchAll 报出**全部**命中
    const offenders = scanUtcDateSlice(testDir);
    assert.deepEqual(
      offenders,
      [],
      `日历日必须用 todayIso()，不得从 toISOString() 切 UTC 日期：\n${offenders.join("\n")}`,
    );
  });

  it("扫描器有牙齿：跨行链式报出、行尾注释与字面量内容不误报", () => {
    // 防「扫描器退化成恒绿/恒红」：三组反例必须分别得到 1 / 0 / 0。
    const multiLine = "const d = new Date()\n  .toISOString()\n  .slice(0, 10);";
    assert.equal(flagged(multiLine), 1, "跨行链式必须能报出");
    const inline = "const today = todayIso(); // 旧写法 new Date().toISOString().slice(0, 10)";
    assert.equal(flagged(inline), 0, "行尾注释里的反例不误报");
    // 字符串字面量里的 // 不能被当成注释起点，字面量内容也不算可执行代码
    const urlLiteral = 'const u = "http://example.com"; // .toISOString().slice(0,';
    assert.equal(flagged(urlLiteral), 0, "URL 里的 // 不是注释");
  });

  it("扫描器有牙齿：模板串占位符与正则字面量不造成漏报", () => {
    // 回归（Hermes 实测 5 类漏报）：codeOnly 曾一遇反引号就整段抹白（不区分插值表达式里
    // 是真实代码），也不识别正则字面量 —— 正则里的第二个 `/` 被当 `//` 注释起点、
    // 正则里的 `'` 被当字面量起点，都会把后面的真实代码整段吞掉（漏报）。
    // 这 5 组必须报出；同一用例里再钉住 4 组不该报的形态（todayIso / URL / 普通除法 /
    // 正则与字符串内容里的类反例）。
    // 反例字符串本身必须含反引号插值，故整块忽略 noTemplateCurlyInString（那是**被测数据**，
    // 不是本文件里真正的模板占位符）
    // biome-ignore-start lint/suspicious/noTemplateCurlyInString: 反例字符串里的反引号插值是被测数据，不是本文件的模板占位符
    const mustFlag: [string, string][] = [
      [
        "模板串里的插值表达式是真实代码",
        "const id = `n-${new Date().toISOString().slice(0, 10)}`;",
      ],
      [
        "模板串插值表达式折行版",
        "const id = `n-${new Date()\n  .toISOString()\n  .slice(0, 10)}`;",
      ],
      [
        "模板串里既有字面量内容又有插值代码，// 不是注释起点",
        "const s = `${a}// ${new Date().toISOString().slice(0, 10)}`;",
      ],
      [
        "正则字面量里的 // 不是注释起点",
        "const re = /\\/\\//; const d = new Date().toISOString().slice(0, 10);",
      ],
      [
        "正则字面量里的引号不是字面量起点",
        "if (s.replace(/'/g, '')) { const d = new Date().toISOString().slice(0, 10); }",
      ],
    ];
    // biome-ignore-end lint/suspicious/noTemplateCurlyInString: 见上一行 ignore-start
    for (const [why, code] of mustFlag) {
      assert.equal(flagged(code), 1, `${why}：必须报出（曾漏报）—— ${code}`);
    }

    const mustNotFlag: [string, string][] = [
      ["todayIso 不是反例", "const today = todayIso();"],
      ["URL 字面量", 'const u = "http://example.com/a//b";'],
      ["普通除法不是注释", "const ratio = total / count;"],
      [
        "正则内容与字符串内容里的类反例不误报",
        'const re = /\\/\\//; const s = "new Date().toISOString().slice(0, 10)";',
      ],
    ];
    for (const [why, code] of mustNotFlag) {
      assert.equal(flagged(code), 0, `${why}：不该报出（误报）—— ${code}`);
    }
  });

  it("同一文件多处违规要全部报出（曾只报首个命中）", () => {
    // 回归：UTC_DATE_SLICE 曾非 global 且用 exec，只返回首个命中，同文件后面的违规全被无视。
    const code = codeOnly(
      [
        "const a = new Date().toISOString().slice(0, 10);",
        "const b = new Date().toISOString().slice(0, 10);",
        "const c = new Date().toISOString().slice(0, 10);",
      ].join("\n"),
    );
    const found = [...code.matchAll(UTC_DATE_SLICE)];
    assert.equal(found.length, 3, `三处违规必须全部报出，实际 ${found.length} 处`);
    // 逐行定位也要对：matchAll 的 index 必须能换算回原文行号（否则报错定位是错的）
    assert.deepEqual(
      found.map((m) => code.slice(0, m.index).split("\n").length),
      [1, 2, 3],
    );
    // scanUtcDateSlice（真实扫描路径）同样要全报
    const root = mkdtempSync(join(tmpdir(), "docs-consistency-multi-"));
    try {
      writeFileSync(
        join(root, "two.test.ts"),
        "const a = new Date().toISOString().slice(0, 10);\nconst b = new Date().toISOString().slice(0, 10);\n",
      );
      assert.deepEqual(
        scanUtcDateSlice(root),
        ["two.test.ts:1: .toISOString().slice(0,", "two.test.ts:2: .toISOString().slice(0,"],
        "同一文件两处违规必须都报出且行号正确",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("扫描面递归进子目录（否则将来 tests/ 下加子目录会静默失效）", () => {
    // 回归：扫描面曾是 readdirSync(testDir).filter(.ts)（非递归），当前 tests/ 恰好
    // 平目录才没暴露；将来加子目录就会静默漏扫。这里用临时目录钉住递归行为。
    const root = mkdtempSync(join(tmpdir(), "docs-consistency-"));
    const sub = join(root, "nested", "deeper");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(root, "top.test.ts"), "const ok = todayIso();\n");
    writeFileSync(
      join(sub, "deep.test.ts"),
      "const bad = new Date().toISOString().slice(0, 10);\n",
    );
    writeFileSync(join(sub, "notes.md"), "new Date().toISOString().slice(0, 10)\n");
    try {
      const files = scanTestFiles(root);
      assert.deepEqual(
        files.sort(),
        ["nested/deeper/deep.test.ts", "top.test.ts"],
        `必须递归收集子目录里的 .ts（且不收 .md），实际 ${files.join(", ")}`,
      );
      const offenders = scanUtcDateSlice(root);
      assert.equal(offenders.length, 1, `只应报出深层目录那一处，实际 ${offenders.join(" | ")}`);
      assert.match(offenders[0] ?? "", /^nested\/deeper\/deep\.test\.ts:1:/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
