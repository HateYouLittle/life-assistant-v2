import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookkeepingExpenseTool } from "../src/modules/bookkeeping/index.js";
import {
  createLedger,
  csvField,
  EXPENSE_CSV_HEADER,
  EXPENSE_CSV_MAX_ROWS,
  expenseCsv,
  expenseCsvFilename,
  previousMonth,
} from "../src/modules/bookkeeping/service.js";
import { statusPage } from "../src/server/page.js";
import { createStatusApp } from "../src/server/status.js";
import { todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * CSV 导出回归：RFC 4180 转义 / UTF-8 BOM / 月份过滤 / 家庭账本口径
 * （看板不泄露个人账本）/ 401 / MCP export 输出与 2000 行截断。
 */

const CURRENT_YM = todayIso().slice(0, 7);
const PREV_YM = previousMonth();

function app(env: TestEnv) {
  return createStatusApp(env.config, env.db);
}

function tools(env: TestEnv, profileId = "default") {
  const ctx = {
    profileId,
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async () => ({ materialized: 1 }),
    },
  };
  return {
    expense: (args: Record<string, unknown>) => bookkeepingExpenseTool(args, ctx),
  };
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

interface InsertExpense {
  id: string;
  ledgerId: string;
  amountCents: number;
  spentOn: string;
  category?: string;
  note?: string | null;
  createdBy?: string;
  createdAt?: string;
}

function insertExpense(env: TestEnv, row: InsertExpense): void {
  env.db
    .prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, note, spent_on, created_by_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.ledgerId,
      row.amountCents,
      row.category ?? "其他",
      row.note ?? null,
      row.spentOn,
      row.createdBy ?? "default",
      row.createdAt ?? "2026-01-01T00:00:00.000Z",
    );
}

/** 把 CSV 文本按行拆开（BOM 已去掉；字段内的 LF 不是行分隔符，行分隔固定 CRLF） */
function csvLines(csv: string): string[] {
  return csv
    .replace(/^\uFEFF/, "")
    .trimEnd()
    .split("\r\n");
}

describe("CSV 构建：RFC 4180 转义", () => {
  it("普通字段不加引号；含逗号/引号/换行/CR 的字段加引号且内部引号双写", () => {
    assert.equal(csvField("普通"), "普通");
    assert.equal(csvField(""), "");
    assert.equal(csvField("a,b"), '"a,b"');
    assert.equal(csvField('说"引号"'), '"说""引号"""');
    assert.equal(csvField("第一行\n第二行"), '"第一行\n第二行"');
    assert.equal(csvField("带回车\r结尾"), '"带回车\r结尾"');
    assert.equal(csvField('a,b"c\nd'), '"a,b""c\nd"');
  });

  it("表头固定为「日期,账本,分类,金额(元),备注,记账人」", () => {
    assert.deepEqual(
      [...EXPENSE_CSV_HEADER],
      ["日期", "账本", "分类", "金额(元)", "备注", "记账人"],
    );
  });
});

describe("CSV 构建：service.expenseCsv", () => {
  it("BOM + CRLF + 元金额 + 升序稳定排序 + 邻月排除", () => {
    const env = makeTestEnv();
    try {
      // 账本名带逗号与引号、分类带逗号、备注带引号与换行：都必须被正确转义
      const ledger = createLedger(env.db, '日,用"账本');
      // created_at 显式给值，保证「同一天两笔」的次级排序可断言
      insertExpense(env, {
        id: "e-late",
        ledgerId: ledger.id,
        amountCents: 1234,
        category: "餐,饮",
        note: '午饭"加辣"',
        spentOn: "2026-01-20",
        createdAt: "2026-01-20T04:00:00.000Z",
      });
      insertExpense(env, {
        id: "e-same-day-newer",
        ledgerId: ledger.id,
        amountCents: 100,
        category: "其他",
        note: "含\n换行",
        spentOn: "2026-01-05",
        createdBy: "partner",
        createdAt: "2026-01-05T02:00:00.000Z",
      });
      insertExpense(env, {
        id: "e-same-day-older",
        ledgerId: ledger.id,
        amountCents: 5,
        category: "其他",
        note: null,
        spentOn: "2026-01-05",
        createdAt: "2026-01-05T01:00:00.000Z",
      });
      insertExpense(env, {
        id: "e-next-month",
        ledgerId: ledger.id,
        amountCents: 777,
        spentOn: "2026-02-01",
      });

      const result = expenseCsv(env.db, { ledgerId: ledger.id, month: "2026-01" });
      assert.ok(result.csv.startsWith("\uFEFF日期,账本,分类,金额(元),备注,记账人\r\n"));
      assert.ok(result.csv.endsWith("\r\n"), "每条记录（含最后一条）以 CRLF 结束");
      assert.equal(result.rows, 3, "邻月（2026-02）不得导出");
      assert.equal(result.total, 3);
      assert.equal(result.truncated, false);

      const lines = csvLines(result.csv);
      assert.equal(lines.length, 4, "表头 + 3 行数据");
      assert.equal(
        lines[1],
        '2026-01-05,"日,用""账本",其他,0.05,,default',
        "同一 spent_on 先按 created_at 升序，金额转元并保留两位",
      );
      assert.equal(lines[2], '2026-01-05,"日,用""账本",其他,1.00,"含\n换行",partner');
      assert.equal(lines[3], '2026-01-20,"日,用""账本","餐,饮",12.34,"午饭""加辣""",default');
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("不传 ledgerId 时只导家庭账本（个人账本不出现）；limit 截断并给 truncated", () => {
    const env = makeTestEnv();
    try {
      const family = createLedger(env.db, "家庭账本");
      const personal = createLedger(env.db, "私房账本", "default");
      insertExpense(env, {
        id: "f1",
        ledgerId: family.id,
        amountCents: 1111,
        spentOn: "2026-03-02",
      });
      insertExpense(env, {
        id: "p1",
        ledgerId: personal.id,
        amountCents: 9999,
        note: "个人私房消费",
        spentOn: "2026-03-03",
      });

      const familyOnly = expenseCsv(env.db, { month: "2026-03" });
      assert.equal(familyOnly.rows, 1);
      assert.match(familyOnly.csv, /家庭账本/);
      assert.doesNotMatch(familyOnly.csv, /私房账本|个人私房消费|99\.99/);

      const personalExport = expenseCsv(env.db, { ledgerId: personal.id, month: "2026-03" });
      assert.equal(personalExport.rows, 1);
      assert.match(personalExport.csv, /个人私房消费/);
      assert.match(personalExport.csv, /99\.99/);

      const limited = expenseCsv(env.db, { ledgerId: family.id, month: "2026-03", limit: 0 });
      assert.equal(limited.rows, 1, "limit 下限 clamp 到 1，不会变成「不限量」");
      assert.equal(limited.total, 1);
      assert.equal(limited.truncated, false);

      insertExpense(env, {
        id: "f2",
        ledgerId: family.id,
        amountCents: 2222,
        spentOn: "2026-03-04",
      });
      const truncated = expenseCsv(env.db, { ledgerId: family.id, month: "2026-03", limit: 1 });
      assert.equal(truncated.rows, 1);
      assert.equal(truncated.total, 2);
      assert.equal(truncated.truncated, true);
      assert.equal(csvLines(truncated.csv).length, 2, "截断后的 CSV = 表头 + 1 行数据");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("文件名固定为 expenses-<月>.csv（HTTP 的 Content-Disposition 可直接用）", () => {
    assert.equal(expenseCsvFilename("2026-10"), "expenses-2026-10.csv");
  });
});

describe("GET /api/expenses.csv", () => {
  it("沿用 /api/* 鉴权：未授权 401；Bearer/?token= 放行", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      const a = app(env);
      assert.equal((await a.request("/api/expenses.csv")).status, 401);
      const bearer = await a.request("/api/expenses.csv", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(bearer.status, 200);
      assert.equal((await a.request(`/api/expenses.csv?token=${token}`)).status, 200);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("附件头/CSV 类型/no-store；只导家庭账本；month 过滤与非法月回退当月", async () => {
    const env = makeTestEnv();
    try {
      const family = createLedger(env.db, "家庭账本");
      const personal = createLedger(env.db, "私房账本", "default");
      insertExpense(env, {
        id: "cur-family",
        ledgerId: family.id,
        amountCents: 1234,
        category: "餐饮",
        note: "本月家庭",
        spentOn: `${CURRENT_YM}-05`,
      });
      insertExpense(env, {
        id: "prev-family",
        ledgerId: family.id,
        amountCents: 5678,
        category: "交通",
        note: "上月家庭",
        spentOn: `${PREV_YM}-15`,
      });
      insertExpense(env, {
        id: "cur-personal",
        ledgerId: personal.id,
        amountCents: 9999,
        note: "个人私房消费",
        spentOn: `${CURRENT_YM}-06`,
      });
      const a = app(env);

      const current = await a.request("/api/expenses.csv");
      assert.equal(current.status, 200);
      assert.match(current.headers.get("content-type") ?? "", /^text\/csv;\s*charset=utf-8/);
      assert.equal(current.headers.get("cache-control"), "no-store", "个人数据不得进缓存");
      assert.match(
        current.headers.get("content-disposition") ?? "",
        new RegExp(`^attachment; filename="expenses-${CURRENT_YM}\\.csv"$`),
        "附件下载且文件名含月份",
      );
      const currentBytes = new Uint8Array(await current.arrayBuffer());
      assert.deepEqual(
        [...currentBytes.slice(0, 3)],
        [0xef, 0xbb, 0xbf],
        "响应字节必须以 UTF-8 BOM 开头（Excel 识别编码靠它；Response.text() 会自动吃掉 BOM，故看原始字节）",
      );
      const currentCsv = new TextDecoder("utf-8", { ignoreBOM: true }).decode(currentBytes);
      assert.ok(currentCsv.startsWith("\uFEFF"));
      assert.match(currentCsv, /日期,账本,分类,金额\(元\),备注,记账人/);
      assert.match(currentCsv, /本月家庭/);
      assert.match(currentCsv, /12\.34/);
      assert.doesNotMatch(currentCsv, /上月家庭|56\.78/, "邻月不得混入当月导出");
      assert.doesNotMatch(
        currentCsv,
        /私房账本|个人私房消费|99\.99/,
        "个人账本不得出现在看板 CSV（共享 token 下会泄露）",
      );

      const prev = await a.request(`/api/expenses.csv?month=${PREV_YM}`);
      assert.match(prev.headers.get("content-disposition") ?? "", new RegExp(PREV_YM));
      const prevCsv = await prev.text();
      assert.match(prevCsv, /上月家庭/);
      assert.match(prevCsv, /56\.78/);
      assert.doesNotMatch(prevCsv, /本月家庭|12\.34/);

      const invalid = await a.request("/api/expenses.csv?month=2026-13");
      assert.equal(invalid.status, 200);
      assert.match(
        invalid.headers.get("content-disposition") ?? "",
        new RegExp(`expenses-${CURRENT_YM}\\.csv`),
        "非法月份按 normalizeMonth 口径回退当月",
      );
      const invalidCsv = await invalid.text();
      assert.match(invalidCsv, /本月家庭/);
      assert.doesNotMatch(invalidCsv, /上月家庭/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("MCP expense action=export", () => {
  it("返回账本/月份/行数/文件名/CSV；默认当月，month 可指定", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      insertExpense(env, {
        id: "cur",
        ledgerId: ledger.id,
        amountCents: 1234,
        note: "本月备注",
        spentOn: `${CURRENT_YM}-05`,
      });
      insertExpense(env, {
        id: "prev",
        ledgerId: ledger.id,
        amountCents: 500,
        note: "上月备注",
        spentOn: `${PREV_YM}-15`,
      });
      const t = tools(env);

      const exported = JSON.parse(text(t.expense({ action: "export", ledger_id: ledger.id }))) as {
        账本: string;
        月份: string;
        行数: number;
        文件名: string;
        已截断: boolean;
        CSV: string;
      };
      assert.equal(exported.账本, "日用");
      assert.equal(exported.月份, CURRENT_YM, "缺省导出当月");
      assert.equal(exported.行数, 1);
      assert.equal(exported.文件名, `expenses-${CURRENT_YM}.csv`);
      assert.equal(exported.已截断, false);
      assert.ok(exported.CSV.startsWith("\uFEFF日期,账本,分类,金额(元),备注,记账人\r\n"));
      assert.match(exported.CSV, /本月备注/);
      assert.doesNotMatch(exported.CSV, /上月备注/);

      const prev = JSON.parse(
        text(t.expense({ action: "export", ledger_id: ledger.id, month: PREV_YM })),
      ) as { 月份: string; 行数: number; CSV: string };
      assert.equal(prev.月份, PREV_YM);
      assert.equal(prev.行数, 1);
      assert.match(prev.CSV, /上月备注/);
      assert.doesNotMatch(prev.CSV, /本月备注/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("只支持 month：显式传 from/to 明确报错，不静默回落当月", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      const t = tools(env);
      for (const args of [
        { action: "export", ledger_id: ledger.id, from: `${CURRENT_YM}-01` },
        { action: "export", ledger_id: ledger.id, to: `${CURRENT_YM}-28` },
      ]) {
        const result = t.expense(args);
        assert.equal(result.isError, true);
        assert.match(text(result), /只支持按自然月/);
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("可见性同 delete：个人账本仅归属人可导出，他人一律「账本不存在」", () => {
    const env = makeTestEnv();
    try {
      const personal = createLedger(env.db, "私房钱", "default");
      insertExpense(env, {
        id: "p1",
        ledgerId: personal.id,
        amountCents: 8888,
        note: "私房",
        spentOn: `${CURRENT_YM}-05`,
      });
      const owner = tools(env);
      const other = tools(env, "partner");

      const mine = JSON.parse(
        text(owner.expense({ action: "export", ledger_id: personal.id })),
      ) as { 账本: string; 行数: number; CSV: string };
      assert.equal(mine.账本, "私房钱");
      assert.equal(mine.行数, 1);
      assert.match(mine.CSV, /私房/);

      const stolen = other.expense({ action: "export", ledger_id: personal.id });
      assert.equal(stolen.isError, true);
      assert.match(text(stolen), /账本不存在/);

      const missing = owner.expense({ action: "export" });
      assert.equal(missing.isError, true);
      assert.match(text(missing), /export 需要 ledger_id/);

      const badMonth = owner.expense({
        action: "export",
        ledger_id: personal.id,
        month: "2026-13",
      });
      assert.equal(badMonth.isError, true);
      assert.match(text(badMonth), /月份不合法/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it(`超过 ${EXPENSE_CSV_MAX_ROWS} 行时截断并置 已截断=true（同时给总行数）`, () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      const total = EXPENSE_CSV_MAX_ROWS + 5;
      const insert = env.db.prepare(
        `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
         VALUES (?, ?, 100, '其他', ?, 'default', ?)`,
      );
      env.db.exec("BEGIN");
      try {
        for (let i = 0; i < total; i += 1) {
          insert.run(
            `bulk-${i}`,
            ledger.id,
            `${CURRENT_YM}-10`,
            `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}.000Z`,
          );
        }
      } finally {
        env.db.exec("COMMIT");
      }

      const exported = JSON.parse(
        text(tools(env).expense({ action: "export", ledger_id: ledger.id })),
      ) as {
        行数: number;
        总行数?: number;
        已截断: boolean;
        说明?: string;
        CSV: string;
      };
      assert.equal(exported.行数, EXPENSE_CSV_MAX_ROWS);
      assert.equal(exported.总行数, total);
      assert.equal(exported.已截断, true);
      assert.match(exported.说明 ?? "", new RegExp(`超过 ${EXPENSE_CSV_MAX_ROWS}`));
      assert.match(exported.说明 ?? "", /缩小查询范围/);
      assert.equal(csvLines(exported.CSV).length, EXPENSE_CSV_MAX_ROWS + 1, "表头 + 2000 行");

      // HTTP 导出按月且不走 2000 行上限：同一份数据应全量（不静默截断看板数据）
      const httpCsv = expenseCsv(env.db, { month: CURRENT_YM });
      assert.equal(httpCsv.rows, total);
      assert.equal(httpCsv.truncated, false);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("看板「导出 CSV」按钮（静态断言）", () => {
  it("月份导航含导出按钮；走带 Authorization 的 fetch + Blob 下载；无内联事件、token 不进 URL", () => {
    const html = statusPage("2.0.0");
    assert.match(html, /data-export="' \+ expMonth \+ '"/, "导出按钮跟随当前所选月份");
    assert.match(html, /导出 CSV/);
    assert.match(
      html,
      /fetch\('\/api\/expenses\.csv\?month=' \+ encodeURIComponent\(month\)/,
      "导出请求按月拼 URL",
    );
    assert.match(html, /Authorization: 'Bearer ' \+ token/, "凭据只走 Authorization 头");
    assert.doesNotMatch(html, /expenses\.csv\?month=[^\n'"`]*token=/, "token 不得拼进 URL");
    assert.match(html, /URL\.createObjectURL/, "用 Blob objectURL 触发下载");
    assert.match(html, /a\.download = 'expenses-' \+ month \+ '\.csv'/);
    assert.match(html, /URL\.revokeObjectURL/, "下载后释放 objectURL");
    assert.match(html, /querySelectorAll\('\[data-export\]'\)/);
    assert.match(html, /addEventListener\('click'/, "CSP 下不能用内联 onclick");
    assert.doesNotMatch(html, /onclick=/, "页面不得引入内联事件处理器");
  });
});
