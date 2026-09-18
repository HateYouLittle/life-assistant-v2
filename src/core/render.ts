import type { NotifyBlock } from "./registry.js";

export interface Rendered {
  body: string;
}

/**
 * 通知快照在发布时渲染一次，投递时不重渲染。
 * markdown：微信/企业微信的 Markdown 表格 —— 当前生产只走这一种（notify.ts 固定传入）。
 * plain：对齐的文本表格；宽度超限时降级为“键: 值”逐行。给不支持表格的渠道预留的降级实现，
 * 目前只有测试覆盖，接入前不要以为它在生产生效。
 * 标题不在这里渲染：发布方单独传 title，避免推送与 notify.pull 各多一行重复标题。
 */
export function renderBlocks(blocks: NotifyBlock, mode: "markdown" | "plain"): Rendered {
  const lines: string[] = [];
  const { table, notes } = blocks;
  if (table !== undefined && table.rows.length > 0) {
    if (mode === "markdown") lines.push(...markdownTable(table.columns, table.rows));
    else lines.push(...plainTable(table.columns, table.rows));
  }
  for (const note of notes ?? []) lines.push(note);
  return { body: lines.join("\n") };
}

function markdownTable(columns: string[], rows: string[][]): string[] {
  const head = `| ${columns.join(" | ")} |`;
  const sep = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${columns.map((_, i) => cell(r[i])).join(" | ")} |`);
  return [head, sep, ...body];
}

const MAX_PLAIN_WIDTH = 48;

function plainTable(columns: string[], rows: string[][]): string[] {
  const widths = columns.map((c, i) =>
    Math.max(displayWidth(c), ...rows.map((r) => displayWidth(cell(r[i])))),
  );
  const total = widths.reduce((a, b) => a + b, 0) + (columns.length - 1) * 3;
  if (columns.length >= 2 && total > MAX_PLAIN_WIDTH) {
    return rows.map((r) => columns.map((c, i) => `${c}: ${cell(r[i])}`).join("　"));
  }
  const widthAt = (i: number): number => widths[i] ?? 0;
  const pad = (s: string, w: number): string => {
    const deficit = Math.max(0, w - displayWidth(s));
    return s + "　".repeat(Math.floor(deficit / 2)) + (deficit % 2 === 1 ? " " : "");
  };
  const head = columns.map((c, i) => pad(c, widthAt(i))).join("  ");
  const sep = widths.map((w) => "─".repeat(w)).join("──");
  const body = rows.map((r) => columns.map((_, i) => pad(cell(r[i]), widthAt(i))).join("  "));
  return [head, sep, ...body];
}

function cell(v: string | undefined): string {
  return (v ?? "").replace(/\|/g, "／").replace(/\n/g, " ");
}

/** CJK 字符按 2 列计宽 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    w +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\u{f900}-\u{fa6f}\u{fe10}-\u{fe19}\u{fe30}-\u{fe6f}\u{ff00}-\u{ff60}\u{ffe0}-\u{ffe6}\u{20000}-\u{3fffd}]/u.test(
        ch,
      )
        ? 2
        : 1;
  }
  return w;
}
