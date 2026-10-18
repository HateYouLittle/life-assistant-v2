import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import {
  addExpense,
  createLedger,
  getExpense,
  updateExpense,
} from "../src/modules/bookkeeping/service.js";
import { todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 记账编辑（expense update）回归：
 * - service 层只改显式传入字段、校验口径与 add 完全一致；
 * - 工具层可见性与 delete 同口径（不可见账本一律「账本不存在」）；
 * - **编辑不触发任何主动推送**（回执/预算提醒）——这是与「删除重记」的关键差异，
 *   既有 add 的推送行为也必须保持不变。
 */

function tools(env: TestEnv, profileId = "default") {
  const ctx = {
    profileId,
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async (input: { kind: string; dedupeKey?: string }) => {
        env.published.push({ profileId: "*", input: input as never });
        return { materialized: 1 };
      },
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

/** 建账本并返回 id；personal=true 建个人账本 */
function createLedgerId(t: ReturnType<typeof tools>, name: string, personal = false): string {
  const args: Record<string, unknown> = { action: "create", name };
  if (personal) args.personal = true;
  const created = JSON.parse(text(t.ledger(args))) as { 已创建: { id: string } };
  return created.已创建.id;
}

function countExpenses(env: TestEnv): number {
  return (env.db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as { n: number }).n;
}

describe("bookkeeping 编辑：service.updateExpense", () => {
  it("只更新显式传入的字段，其余字段（含记账人/创建时间）保持原值", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      const row = addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 1234,
        category: "餐饮",
        note: "午饭",
        spentOn: "2026-01-10",
      });

      const amountOnly = updateExpense(env.db, row.id, { amountCents: 5678 });
      assert.equal(amountOnly.amount_cents, 5678);
      assert.equal(amountOnly.category, "餐饮", "未传的字段不该被覆盖");
      assert.equal(amountOnly.note, "午饭");
      assert.equal(amountOnly.spent_on, "2026-01-10");
      assert.equal(amountOnly.ledger_id, ledger.id, "编辑不能改账本");
      assert.equal(amountOnly.created_by_profile, "default", "记账人不变");
      assert.equal(amountOnly.created_at, row.created_at, "创建时间不变");

      const rest = updateExpense(env.db, row.id, {
        category: " 交通 ",
        note: "",
        spentOn: "2026-02-03",
      });
      assert.equal(rest.category, "交通", "分类 trim 后落库");
      assert.equal(rest.note, null, "空备注归一为 NULL");
      assert.equal(rest.spent_on, "2026-02-03");
      assert.equal(countExpenses(env), 1, "编辑是 UPDATE，不得插入新行");
      assert.equal(getExpense(env.db, row.id)?.amount_cents, 5678);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("校验口径与 addExpense 完全一致（非法金额/分类/备注/日期一律拒绝且不落库）", () => {
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "日用");
      const row = addExpense(env.db, "default", {
        ledgerId: ledger.id,
        amountCents: 100,
        spentOn: "2026-01-10",
      });

      const cases: Array<[string, () => void, RegExp]> = [
        ["金额为 0", () => updateExpense(env.db, row.id, { amountCents: 0 }), /金额不合法/],
        ["金额为负", () => updateExpense(env.db, row.id, { amountCents: -1 }), /金额不合法/],
        ["金额非整数分", () => updateExpense(env.db, row.id, { amountCents: 1.5 }), /金额不合法/],
        [
          "分类超长",
          () => updateExpense(env.db, row.id, { category: "长".repeat(21) }),
          /分类过长/,
        ],
        ["备注超长", () => updateExpense(env.db, row.id, { note: "长".repeat(201) }), /备注过长/],
        ["日期非法", () => updateExpense(env.db, row.id, { spentOn: "2026-13-01" }), /日期不合法/],
        [
          "日期格式非法",
          () => updateExpense(env.db, row.id, { spentOn: "2026/01/10" }),
          /日期不合法/,
        ],
        ["账目不存在", () => updateExpense(env.db, "missing", { amountCents: 1 }), /账目不存在/],
        ["空 patch", () => updateExpense(env.db, row.id, {}), /没有需要更新的字段/],
      ];
      for (const [why, run, expected] of cases) {
        assert.throws(run, expected, `${why}应被拒绝`);
      }
      const after = getExpense(env.db, row.id);
      assert.equal(after?.amount_cents, 100, "失败的编辑不得改动原值");
      assert.equal(after?.category, "其他");
      assert.equal(after?.spent_on, "2026-01-10");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("bookkeeping 编辑：expense action=update", () => {
  it("改金额/分类/备注/日期：回执包含新值，并说明不触发回执/预算提醒", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "日用");
      const added = JSON.parse(
        text(
          t.expense({
            action: "add",
            ledger_id: ledgerId,
            amount: 10,
            category: "餐饮",
            note: "午饭",
            date: todayIso(),
          }),
        ),
      ) as { 已记账: { id: string } };
      assert.equal(env.published.length, 1, "add 仍应发布家庭账本回执");

      env.published.length = 0;
      const updated = t.expense({
        action: "update",
        id: added.已记账.id,
        amount: 88.5,
        category: "交通",
        note: "打车",
        date: "2026-01-05",
      });
      assert.equal(updated.isError, undefined, text(updated));
      const payload = JSON.parse(text(updated)) as {
        已更新: {
          id: string;
          账本: string;
          金额: string;
          分类: string;
          日期: string;
          备注: string | null;
          记账人: string;
        };
        说明: string;
      };
      assert.equal(payload.已更新.id, added.已记账.id);
      assert.equal(payload.已更新.账本, "日用");
      assert.equal(payload.已更新.金额, "¥88.50");
      assert.equal(payload.已更新.分类, "交通");
      assert.equal(payload.已更新.日期, "2026-01-05");
      assert.equal(payload.已更新.备注, "打车");
      assert.equal(payload.已更新.记账人, "default");
      assert.match(payload.说明, /不会重发记账回执/);
      assert.match(payload.说明, /不会重新判定预算提醒/);
      assert.equal(env.published.length, 0, "编辑不得推送回执/预算提醒");

      // 备注传空串即清空
      const cleared = JSON.parse(
        text(t.expense({ action: "update", id: added.已记账.id, note: "" })),
      ) as { 已更新: { 备注: string | null } };
      assert.equal(cleared.已更新.备注, null);
      assert.equal(env.published.length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("编辑把金额改到远超预算也不推预算提醒；add 的跨阈值提醒行为保持不变", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const budgetLedger = createLedgerId(t, "预算账本");
      t.ledger({ action: "budget", ledger_id: budgetLedger, amount: 100 });
      const added = JSON.parse(
        text(t.expense({ action: "add", ledger_id: budgetLedger, amount: 10 })),
      ) as { 已记账: { id: string } };
      // 记账 10 元（10%）不跨阈值，只有回执
      assert.equal(env.published.length, 1);
      assert.equal(env.published[0]?.input.kind, "bookkeeping.entry");

      env.published.length = 0;
      const updated = t.expense({ action: "update", id: added.已记账.id, amount: 500 });
      assert.equal(updated.isError, undefined, text(updated));
      assert.equal(
        env.published.length,
        0,
        "编辑改到 500%（远超 80%/100%）也不得触发任何预算提醒或回执",
      );

      // 既有 add 行为：一笔支出跨过 100% 时仍推预算提醒（本测试防止重构 service 时误伤）
      const freshLedger = createLedgerId(t, "对照账本");
      t.ledger({ action: "budget", ledger_id: freshLedger, amount: 100 });
      env.published.length = 0;
      t.expense({ action: "add", ledger_id: freshLedger, amount: 150 });
      assert.ok(
        env.published.some((p) => p.input.kind === "bookkeeping.budget"),
        `add 跨阈值仍应推预算提醒，实际：${env.published.map((p) => p.input.kind).join(",")}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("不可见账本按「账本不存在」拒绝；传 ledger_id 明确报不支持换账本", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const other = tools(env, "partner");
    try {
      const personal = createLedgerId(owner, "私房钱", true);
      const added = JSON.parse(
        text(owner.expense({ action: "add", ledger_id: personal, amount: 30 })),
      ) as { 已记账: { id: string } };

      const stolen = other.expense({
        action: "update",
        id: added.已记账.id,
        amount: 1,
      });
      assert.equal(stolen.isError, true);
      assert.match(text(stolen), /账本不存在/);
      assert.equal(getExpense(env.db, added.已记账.id)?.amount_cents, 3000, "他人编辑不得生效");

      // 归属人自己可以改个人账本的账目
      const mine = owner.expense({ action: "update", id: added.已记账.id, amount: 45 });
      assert.equal(mine.isError, undefined, text(mine));
      assert.equal(getExpense(env.db, added.已记账.id)?.amount_cents, 4500);

      const moveLedger = owner.expense({
        action: "update",
        id: added.已记账.id,
        ledger_id: createLedgerId(owner, "另一个账本"),
        amount: 1,
      });
      assert.equal(moveLedger.isError, true);
      assert.match(text(moveLedger), /不支持更换账本/);
      assert.equal(getExpense(env.db, added.已记账.id)?.ledger_id, personal);

      // 家庭账本对任何 Profile 可见，partner 也能编辑
      const family = createLedgerId(owner, "家庭账本");
      const familyEntry = JSON.parse(
        text(other.expense({ action: "add", ledger_id: family, amount: 5 })),
      ) as { 已记账: { id: string } };
      const edited = other.expense({
        action: "update",
        id: familyEntry.已记账.id,
        note: "对方改的备注",
      });
      assert.equal(edited.isError, undefined, text(edited));
      assert.equal(getExpense(env.db, familyEntry.已记账.id)?.note, "对方改的备注");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("参数缺失/账目不存在/无待改字段给出可操作错误", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "日用");
      const added = JSON.parse(
        text(t.expense({ action: "add", ledger_id: ledgerId, amount: 10 })),
      ) as { 已记账: { id: string } };

      const noId = t.expense({ action: "update", amount: 1 });
      assert.equal(noId.isError, true);
      assert.match(text(noId), /update 需要 id/);

      const ghost = t.expense({ action: "update", id: "missing", amount: 1 });
      assert.equal(ghost.isError, true);
      assert.match(text(ghost), /账目不存在/);

      const nothing = t.expense({ action: "update", id: added.已记账.id });
      assert.equal(nothing.isError, true);
      assert.match(text(nothing), /至少一个待改字段/);

      const badAmount = t.expense({ action: "update", id: added.已记账.id, amount: 0 });
      assert.equal(badAmount.isError, true);
      assert.match(text(badAmount), /金额不合法/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
