import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import {
  createLedger,
  EXPENSE_CSV_HEADER,
  expenseCsv,
  sanitizeCsvCell,
} from "../src/modules/bookkeeping/service.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * CSV 公式注入（CSV injection）：Excel / Google Sheets 会把以 `= + - @` 或制表符/回车
 * 开头的单元格当公式执行。导出时必须中和文本列，但普通中文/数字/日期保持原样、
 * RFC 4180 引号规则不变。
 */

function insertExpense(
  env: TestEnv,
  row: {
    id: string;
    ledgerId: string;
    cents: number;
    category: string;
    note: string | null;
    date: string;
    profile?: string;
  },
): void {
  env.db
    .prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, note, spent_on, created_by_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(
      row.id,
      row.ledgerId,
      row.cents,
      row.category,
      row.note,
      row.date,
      row.profile ?? "default",
    );
}

/** CSV 文本 → 数据行（去掉 BOM；行分隔固定 CRLF） */
function csvLines(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split("\r\n");
}

function tools(env: TestEnv) {
  const ctx = {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async () => ({ materialized: 1 }),
    },
  };
  return {
    ledger: (args: Record<string, unknown>) => bookkeepingLedgerTool(args, ctx),
    expense: (args: Record<string, unknown>) => bookkeepingExpenseTool(args, ctx),
  };
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

describe("sanitizeCsvCell：公式前缀中和", () => {
  it("= + - @ 制表符 回车开头的单元格前加单引号", () => {
    assert.equal(
      sanitizeCsvCell('=HYPERLINK("http://evil","点我")'),
      '\'=HYPERLINK("http://evil","点我")',
    );
    assert.equal(sanitizeCsvCell("=1+1"), "'=1+1");
    assert.equal(sanitizeCsvCell("+1"), "'+1");
    assert.equal(sanitizeCsvCell("-1"), "'-1");
    assert.equal(sanitizeCsvCell("-分类"), "'-分类");
    assert.equal(sanitizeCsvCell("@x"), "'@x");
    assert.equal(sanitizeCsvCell("\t=1"), "'\t=1");
    assert.equal(sanitizeCsvCell("\r=1"), "'\r=1");
  });

  it("前导空格/制表符绕过也要挡（先 trimStart 再判断）", () => {
    assert.equal(sanitizeCsvCell(" =1"), "' =1");
    assert.equal(sanitizeCsvCell("   -1"), "'   -1");
    assert.equal(sanitizeCsvCell("  \t@x"), "'  \t@x");
  });

  it("普通文本、数字、日期、空值不变（只中和真正的公式起始字符）", () => {
    assert.equal(sanitizeCsvCell(""), "");
    assert.equal(sanitizeCsvCell("   "), "   ");
    assert.equal(sanitizeCsvCell("午餐"), "午餐");
    assert.equal(sanitizeCsvCell("12.34"), "12.34");
    assert.equal(sanitizeCsvCell("2026-01-05"), "2026-01-05", "日期里的 - 不在开头");
    assert.equal(sanitizeCsvCell("a=1"), "a=1", "等号在中间不触发");
    assert.equal(sanitizeCsvCell("1+1"), "1+1");
  });
});

describe("expenseCsv：导出时中和公式注入", () => {
  it("账本名/分类/备注/记账人里的公式前缀都被加单引号，数据与 RFC 转义不受影响", () => {
    const env = makeTestEnv();
    try {
      const evil = createLedger(env.db, "=账本");
      insertExpense(env, {
        id: "e1",
        ledgerId: evil.id,
        cents: 1234,
        category: "-分类",
        note: "@note",
        date: "2026-01-05",
        profile: "+profile",
      });
      // 含逗号的公式：中和后仍需 RFC 引号包裹
      insertExpense(env, {
        id: "e2",
        ledgerId: evil.id,
        cents: 100,
        category: "其他",
        note: "=SUM(A1,B1)",
        date: "2026-01-06",
      });

      const result = expenseCsv(env.db, { ledgerId: evil.id, month: "2026-01" });
      const lines = csvLines(result.csv);
      assert.equal(lines[0], EXPENSE_CSV_HEADER.join(","), "表头不需要处理");
      assert.equal(
        lines[1],
        "2026-01-05,'=账本,'-分类,12.34,'@note,'+profile",
        "每个文本列都被中和；金额/日期（数字列）保持原样",
      );
      assert.equal(
        lines[2],
        "2026-01-06,'=账本,其他,1.00,\"'=SUM(A1,B1)\",default",
        "中和后再按 RFC 引号规则包裹含逗号的字段",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("普通中文/数字/日期/空备注完全不变", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "家庭账本");
      insertExpense(env, {
        id: "n1",
        ledgerId: ledger.id,
        cents: 1000,
        category: "餐饮",
        note: "午饭",
        date: "2026-02-03",
        profile: "default",
      });
      insertExpense(env, {
        id: "n2",
        ledgerId: ledger.id,
        cents: 5,
        category: "其他",
        note: null,
        date: "2026-02-04",
      });
      const lines = csvLines(expenseCsv(env.db, { ledgerId: ledger.id, month: "2026-02" }).csv);
      assert.equal(lines[1], "2026-02-03,家庭账本,餐饮,10.00,午饭,default");
      assert.equal(lines[2], "2026-02-04,家庭账本,其他,0.05,,default");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("MCP export 走同一实现：工具返回的 CSV 也已中和", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const created = JSON.parse(text(t.ledger({ action: "create", name: "导出账本" }))) as {
        已创建: { id: string };
      };
      const added = t.expense({
        action: "add",
        ledger_id: created.已创建.id,
        amount: 8.5,
        category: "=cat",
        note: "=1+1",
      });
      assert.notEqual(added.isError, true, text(added));

      const exported = JSON.parse(
        text(t.expense({ action: "export", ledger_id: created.已创建.id })),
      ) as { CSV: string; 行数: number };
      assert.equal(exported.行数, 1);
      const line = csvLines(exported.CSV)[1] ?? "";
      assert.ok(line.includes("'=cat"), `分类应被中和：${line}`);
      assert.ok(line.includes("'=1+1"), `备注应被中和：${line}`);
      assert.ok(!/^(?:[^,]*,){2}=cat/.test(line), "原始 =cat 不得以未中和形式出现");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
