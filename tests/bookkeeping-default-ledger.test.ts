import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import {
  DEFAULT_LEDGER_SETTING,
  getDefaultLedgerId,
  getExpense,
  listExpenses,
  setLedgerArchived,
} from "../src/modules/bookkeeping/service.js";
import { TZ, todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * A16：默认账本 + 常用分类（降低「记一笔」的摩擦，但不替用户猜账本）。
 *
 * 默认账本解析顺序：① settings 里有效且可写的默认账本 → ② 恰好只有一个可写活动账本
 * → ③ 否则报错并列出可选账本（提示用 expense set_default_ledger 指定）。
 * `常用分类` 只在 add 未显式传 category 时给出，窗口 90 天、按出现次数 top 5。
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

function createLedgerId(t: ReturnType<typeof tools>, name: string, personal = false): string {
  const args: Record<string, unknown> = { action: "create", name };
  if (personal) args.personal = true;
  const created = JSON.parse(text(t.ledger(args))) as { 已创建: { id: string } };
  return created.已创建.id;
}

interface AddReceipt {
  已记账: { id: string; 账本: string; 分类: string; 日期: string };
  常用分类?: string[];
  已存在?: boolean;
}

function addWithoutLedger(t: ReturnType<typeof tools>, extra: Record<string, unknown> = {}) {
  const result = t.expense({ action: "add", amount: 1, ...extra });
  assert.notEqual(result.isError, true, `默认账本应能记账：${text(result)}`);
  return JSON.parse(text(result)) as AddReceipt;
}

/** 本地日历日偏移（Asia/Shanghai），与 recentCategories 的 today 同口径 */
function localDay(offsetFromToday: number): string {
  return DateTime.fromISO(todayIso(), { zone: TZ })
    .plus({ days: offsetFromToday })
    .toISODate() as string;
}

describe("bookkeeping 默认账本：解析顺序", () => {
  it("多个可写账本且未设置默认 → fail 并列出候选、提示 set_default_ledger", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const a = createLedgerId(t, "日用");
      const b = createLedgerId(t, "旅行");
      const result = t.expense({ action: "add", amount: 5 });
      assert.equal(result.isError, true, "不能随手挑一个账本");
      const message = text(result);
      assert.match(message, /无法确定默认账本/);
      assert.match(message, /旅行/); // 候选账本名与 id 都要列出来
      assert.match(message, new RegExp(a));
      assert.match(message, new RegExp(b));
      assert.match(message, /set_default_ledger/);
      assert.equal(
        (env.db.prepare("SELECT COUNT(*) AS n FROM expenses").get() as { n: number }).n,
        0,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("设置默认账本后 add 未传 ledger_id 直接记入该账本；查询视图回读当前默认", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const a = createLedgerId(t, "日用");
      createLedgerId(t, "旅行");
      const set = JSON.parse(text(t.expense({ action: "set_default_ledger", ledger_id: a }))) as {
        已设置: { 默认账本: { id: string; 名称: string } };
      };
      assert.equal(set.已设置.默认账本.id, a);
      assert.equal(set.已设置.默认账本.名称, "日用");
      assert.equal(getDefaultLedgerId(env.db, "default"), a);

      const receipt = addWithoutLedger(t, { amount: 7, category: "餐饮" });
      assert.equal(receipt.已记账.账本, "日用");
      assert.equal(getExpense(env.db, receipt.已记账.id)?.ledger_id, a);

      // 再调用一次（不传 ledger）返回当前默认账本，供用户确认
      const queried = JSON.parse(text(t.expense({ action: "set_default_ledger" }))) as {
        默认账本: { id: string; 名称: string } | null;
        来源?: string;
        可写账本: { id: string }[];
      };
      assert.equal(queried.默认账本?.id, a);
      assert.equal(queried.来源, "默认设置");
      assert.equal(queried.可写账本.length, 2);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("恰好只有一个可写活动账本 → 直接用它，且不写 setting", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const only = createLedgerId(t, "唯一账本");
      const receipt = addWithoutLedger(t, { amount: 3 });
      assert.equal(receipt.已记账.账本, "唯一账本");
      assert.equal(getExpense(env.db, receipt.已记账.id)?.ledger_id, only);
      assert.equal(getDefaultLedgerId(env.db, "default"), undefined, "唯一账本不落设置");
      const settings = env.db
        .prepare("SELECT COUNT(*) AS n FROM settings WHERE key = ?")
        .get(DEFAULT_LEDGER_SETTING) as { n: number };
      assert.equal(settings.n, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("默认账本已归档或转给他人 → 设置自动失效，回落到唯一可写账本", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const first = createLedgerId(t, "旧默认");
      const second = createLedgerId(t, "新账本");
      t.expense({ action: "set_default_ledger", ledger_id: first });
      // 把默认账本归档：设置还在，但指向的账本已不可写
      setLedgerArchived(env.db, first, true);

      const receipt = addWithoutLedger(t, { amount: 2 });
      assert.equal(receipt.已记账.账本, "新账本", "失效的默认设置应回落到唯一可写账本");
      assert.equal(getExpense(env.db, receipt.已记账.id)?.ledger_id, second);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("没有任何可写账本 → fail 并提示先建账本", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const result = t.expense({ action: "add", amount: 5 });
      assert.equal(result.isError, true);
      assert.match(text(result), /没有可写的活动账本/);
      assert.match(text(result), /ledger \{action:"create"/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("set_default_ledger 只接受可写活动账本（他人个人账本/归档账本/不存在都拒绝）", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const partner = tools(env, "partner");
    try {
      const family = createLedgerId(owner, "家庭");
      const personal = createLedgerId(owner, "私房钱", true);
      const archived = createLedgerId(owner, "已归档");
      setLedgerArchived(env.db, archived, true);

      // 别人的个人账本：按「不存在或不可写」拒绝（不泄露存在性）
      const theirs = partner.expense({ action: "set_default_ledger", ledger_id: personal });
      assert.equal(theirs.isError, true);
      assert.match(text(theirs), /账本不存在或不可写/);

      const gone = owner.expense({ action: "set_default_ledger", ledger_id: "missing" });
      assert.equal(gone.isError, true);

      const archivedResult = owner.expense({
        action: "set_default_ledger",
        ledger_id: archived,
      });
      assert.equal(archivedResult.isError, true);

      // 自己的个人账本与家庭账本都可以设为默认
      const ownPersonal = owner.expense({ action: "set_default_ledger", ledger: personal });
      assert.notEqual(ownPersonal.isError, true, text(ownPersonal));
      assert.equal(getDefaultLedgerId(env.db, "default"), personal);
      owner.expense({ action: "set_default_ledger", ledger_id: family });
      assert.equal(getDefaultLedgerId(env.db, "default"), family);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("bookkeeping 默认账本：跨 Profile 隔离", () => {
  it("每个 Profile 的默认账本互不影响；他人个人账本不可见", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const partner = tools(env, "partner");
    try {
      const family = createLedgerId(owner, "家庭");
      const personal = createLedgerId(owner, "私房钱", true);
      owner.expense({ action: "set_default_ledger", ledger_id: personal });

      const mine = addWithoutLedger(owner, { amount: 10 });
      assert.equal(mine.已记账.账本, "私房钱", "归属人默认账本可以是自己的个人账本");

      // partner 看不到私房钱，只剩家庭账本 → 走「唯一可写账本」分支
      const theirs = addWithoutLedger(partner, { amount: 20 });
      assert.equal(theirs.已记账.账本, "家庭");
      assert.notEqual(theirs.已记账.id, mine.已记账.id);
      assert.equal(getDefaultLedgerId(env.db, "default"), personal);
      assert.equal(getDefaultLedgerId(env.db, "partner"), undefined);

      // partner 不能把自己的默认账本设成别人的个人账本
      const stolen = partner.expense({ action: "set_default_ledger", ledger_id: personal });
      assert.equal(stolen.isError, true);
      assert.equal(getDefaultLedgerId(env.db, "partner"), undefined);

      // partner 的家庭账本设置不影响 owner
      partner.expense({ action: "set_default_ledger", ledger_id: family });
      assert.equal(getDefaultLedgerId(env.db, "partner"), family);
      assert.equal(getDefaultLedgerId(env.db, "default"), personal);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("bookkeeping 常用分类：add 回执提示", () => {
  it("未传 category 时按出现次数 top 5；显式传 category 时不给该字段", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "常用分类");
      // 显式分类的记账（同时验证它们能进入统计）
      for (const [category, times] of [
        ["餐饮", 3],
        ["交通", 2],
        ["购物", 1],
        ["娱乐", 1],
      ] as const) {
        for (let i = 0; i < times; i++) {
          t.expense({ action: "add", ledger_id: ledgerId, amount: 1, category });
        }
      }
      const receipt = addWithoutLedger(t, { ledger_id: ledgerId, amount: 1 });
      assert.deepEqual(
        receipt.常用分类,
        ["餐饮", "交通", "娱乐", "购物"],
        "按笔数降序、同频按名称升序",
      );

      const explicit = JSON.parse(
        text(t.expense({ action: "add", ledger_id: ledgerId, amount: 2, category: "餐饮" })),
      ) as AddReceipt;
      assert.equal(explicit.常用分类, undefined, "显式给分类时不应再给常用分类（避免噪音）");

      // 只保留前 5 个
      for (const category of ["甲", "乙", "丙", "丁", "戊"]) {
        t.expense({ action: "add", ledger_id: ledgerId, amount: 1, category });
      }
      const limited = addWithoutLedger(t, { ledger_id: ledgerId, amount: 1 });
      assert.equal(limited.常用分类?.length, 5);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("90 天窗口：更早的分类不计入；空账本给空数组；本笔自身（默认分类）不混进建议", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "窗口");
      // 窗口内（今天-89 天）的旧分类会计入；窗口外（今天-90 天）不计入
      t.expense({
        action: "add",
        ledger_id: ledgerId,
        amount: 1,
        category: "窗口外",
        date: localDay(-90),
      });
      t.expense({
        action: "add",
        ledger_id: ledgerId,
        amount: 1,
        category: "窗口内",
        date: localDay(-89),
      });
      const recent = addWithoutLedger(t, { ledger_id: ledgerId, amount: 1 });
      assert.deepEqual(recent.常用分类, ["窗口内"], "只统计最近 90 天（含今天）");

      // 空账本：刚记的这笔本身（默认分类「其他」）不得出现在建议里
      const empty = createLedgerId(t, "空账本");
      const first = addWithoutLedger(t, { ledger_id: empty, amount: 1 });
      assert.equal(first.已记账.分类, "其他");
      assert.deepEqual(first.常用分类, [], "没有历史分类时给空数组，而不是把本笔的分类推荐回来");

      // 跨账本不串台：另一个账本的分类不会混进来
      t.expense({ action: "add", ledger_id: ledgerId, amount: 1, category: "只在窗口账本" });
      const other = addWithoutLedger(t, { ledger_id: empty, amount: 1 });
      assert.deepEqual(
        other.常用分类,
        ["其他"],
        "只统计本账本历史（空账本此前记过一笔「其他」），不掺入其它账本",
      );
      assert.ok(!other.常用分类?.includes("只在窗口账本"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("重试命中幂等键时回执仍带相同形状（常用分类不重复统计本笔）", () => {
    const env = makeTestEnv();
    const t = tools(env);
    try {
      const ledgerId = createLedgerId(t, "幂等分类");
      t.expense({ action: "add", ledger_id: ledgerId, amount: 1, category: "餐饮" });
      const first = JSON.parse(
        text(t.expense({ action: "add", ledger_id: ledgerId, amount: 5, request_id: "cat-req" })),
      ) as AddReceipt;
      // 本笔（默认分类「其他」）被排除，只回显历史分类
      assert.deepEqual(first.常用分类, ["餐饮"]);

      const retry = JSON.parse(
        text(t.expense({ action: "add", ledger_id: ledgerId, amount: 5, request_id: "cat-req" })),
      ) as AddReceipt;
      assert.equal(retry.已存在, true);
      assert.deepEqual(retry.常用分类, first.常用分类);
      assert.equal(listExpenses(env.db, ledgerId).total, 2);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
