import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runtime } from "../src/core/registry.js";
import { ensureProfile } from "../src/core/settings.js";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import { getLedger, pushMonthlyReports } from "../src/modules/bookkeeping/service.js";
import { todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 与 bookkeeping.test.ts 同形的工具桩：publishProfile 不回写 env.published，
 * publishGlobal 记录到 env.published，便于断言「个人账本是否被推送」。
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

/** 该 Profile 的账本列表中是否出现某个 id */
function visibleInList(t: ReturnType<typeof tools>, id: string): boolean {
  const listed = JSON.parse(text(t.ledger({ action: "list" }))) as { 账本: { id: string }[] };
  return listed.账本.some((l) => l.id === id);
}

describe("bookkeeping：个人账本", () => {
  it("仅归属人可见，列表标注类型与归属人", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const other = tools(env, "partner");
    try {
      const id = createLedgerId(owner, "私房钱", true);

      const mine = JSON.parse(text(owner.ledger({ action: "list" }))) as {
        账本: { id: string; 类型: string; 归属人?: string }[];
      };
      assert.equal(mine.账本.length, 1);
      assert.equal(mine.账本[0]?.id, id);
      assert.equal(mine.账本[0]?.类型, "个人");
      assert.equal(mine.账本[0]?.归属人, "default");

      const theirs = JSON.parse(text(other.ledger({ action: "list" }))) as { 账本: unknown[] };
      assert.deepEqual(theirs.账本, [], "他人不可见个人账本");

      assert.equal(getLedger(env.db, id)?.owner_profile_id, "default");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非归属人的读写与账本管理一律报「账本不存在」", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const other = tools(env, "partner");
    try {
      const id = createLedgerId(owner, "私房钱", true);
      const added = JSON.parse(
        text(owner.expense({ action: "add", ledger_id: id, amount: 10 })),
      ) as { 已记账: { id: string } };

      const attempts = [
        other.expense({ action: "add", ledger_id: id, amount: 1 }),
        other.expense({ action: "list", ledger_id: id }),
        other.expense({ action: "summary", ledger_id: id }),
        other.expense({ action: "delete", id: added.已记账.id }),
        other.ledger({ action: "rename", id, name: "改名" }),
        other.ledger({ action: "archive", id }),
        other.ledger({ action: "budget", ledger_id: id }),
      ];
      for (const r of attempts) {
        assert.equal(r.isError, true);
        assert.match(text(r), /账本不存在/);
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("个人账本记账不回执、不推预算提醒", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    try {
      const id = createLedgerId(owner, "私房钱", true);
      owner.ledger({ action: "budget", ledger_id: id, amount: 100 });
      env.published.length = 0;
      const added = owner.expense({ action: "add", ledger_id: id, amount: 200 });
      assert.equal(added.isError, undefined, "个人账本记账应成功");
      assert.equal(env.published.length, 0, "个人账本不应有任何回执或预算提醒推送");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("个人账本月报只发给归属人", async () => {
    const env = makeTestEnv();
    const owner = tools(env);
    try {
      ensureProfile(env.db, "partner");
      const id = createLedgerId(owner, "私房钱", true);
      const ym = todayIso().slice(0, 7);
      owner.expense({ action: "add", ledger_id: id, amount: 50, date: `${ym}-05` });

      env.published.length = 0;
      await pushMonthlyReports(env.db, runtime().services, ym);

      assert.ok(env.published.length >= 1, "归属人应收到月报");
      assert.ok(
        env.published.every((p) => p.profileId === "default"),
        "只有归属人收到月报，不得全局推送",
      );
      assert.ok(env.published.some((p) => p.input.kind === "bookkeeping.monthly"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同名分范围唯一：不同人可建同名个人账本，家庭与个人也可同名", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const partner = tools(env, "partner");
    try {
      const a = createLedgerId(owner, "日常", true);
      const b = createLedgerId(partner, "日常", true);
      assert.notEqual(a, b, "不同人的同名个人账本应各自创建成功");
      // 同一个人再建同名 → 同范围，拒绝
      const again = owner.ledger({ action: "create", name: "日常", personal: true });
      assert.equal(again.isError, true);
      assert.match(text(again), /已存在同名账本/);
      // 家庭账本与个人账本可同名（跨范围）
      const fam = createLedgerId(owner, "日常", false);
      assert.notEqual(fam, a);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("转移归属若目标范围已有同名账本，给出可操作报错而不是裸 UNIQUE", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const partner = tools(env, "partner");
    try {
      const mine = createLedgerId(owner, "私房钱", true);
      createLedgerId(partner, "私房钱", true); // 目标 Profile 已有同名个人账本
      const moved = owner.ledger({ action: "transfer", id: mine, profile: "partner" });
      assert.equal(moved.isError, true);
      assert.match(text(moved), /已有同名活跃账本/);
      // 转移失败必须保持原归属不变
      assert.equal(getLedger(env.db, mine)?.owner_profile_id, "default");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("bookkeeping：账本转移", () => {
  it("个人账本可转给他人、可转回家庭；家庭账本不可转个人", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    try {
      ensureProfile(env.db, "partner");
      const id = createLedgerId(owner, "私房钱", true);

      const moved = owner.ledger({ action: "transfer", id, profile: "partner" });
      assert.equal(moved.isError, undefined);
      assert.equal(getLedger(env.db, id)?.owner_profile_id, "partner");
      assert.equal(visibleInList(owner, id), false, "原归属人不再可见");
      assert.equal(visibleInList(tools(env, "partner"), id), true, "新归属人可见");

      // 新归属人转回家庭（不可逆）
      const family = tools(env, "partner").ledger({ action: "transfer", id });
      assert.equal(family.isError, undefined);
      assert.equal(getLedger(env.db, id)?.owner_profile_id, null);
      assert.equal(visibleInList(owner, id), true, "家庭账本人人可见");

      // 家庭 → 个人永不允许
      const back = owner.ledger({ action: "transfer", id, profile: "default" });
      assert.equal(back.isError, true);
      assert.match(text(back), /家庭账本不支持转移/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非归属人转移报不存在；目标 Profile 不存在报错", () => {
    const env = makeTestEnv();
    const owner = tools(env);
    const other = tools(env, "partner");
    try {
      const id = createLedgerId(owner, "私房钱", true);

      const stolen = other.ledger({ action: "transfer", id, profile: "partner" });
      assert.equal(stolen.isError, true);
      assert.match(text(stolen), /账本不存在/);

      const ghost = owner.ledger({ action: "transfer", id, profile: "ghost" });
      assert.equal(ghost.isError, true);
      assert.match(text(ghost), /目标 Profile 不存在/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
