import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { createServices } from "../src/core/notify.js";
import { allJobs, type PublishInput, runtime, type ToolContext } from "../src/core/registry.js";
import { bookkeepingExpenseTool, bookkeepingLedgerTool } from "../src/modules/bookkeeping/index.js";
import { DIGEST_TOP_CATEGORIES, pushDailyDigests } from "../src/modules/bookkeeping/service.js";
import { todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type Published, type TestEnv } from "./helpers.js";
// 副作用 import：注册全部模块，才能从 allJobs() 里取到 ledger_digest 这个 job
import "../src/modules/index.js";

/**
 * 降噪三件事里属于记账侧的两件：
 * ① 家庭账本逐笔回执只发记账人（预算提醒仍全局）；
 * ② 每晚 21:30 的每日摘要 pushDailyDigests（按记账人、当天、幂等、跨 Profile 隔离）。
 */

function toolCtx(env: TestEnv, profileId = "default"): ToolContext {
  // 用 runtime().services（makeTestEnv 的记录桩）：publishProfile 记真实 profileId，
  // publishGlobal 记 "*"，正好能断言「谁收到了什么」
  return { profileId, db: env.db, config: env.config, services: runtime().services };
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

function createLedger(env: TestEnv, name: string, profileId = "default"): string {
  const created = JSON.parse(
    text(bookkeepingLedgerTool({ action: "create", name }, toolCtx(env, profileId))),
  ) as { 已创建: { id: string } };
  return created.已创建.id;
}

function addExpense(
  env: TestEnv,
  ledgerId: string,
  amount: number,
  profileId = "default",
  category?: string,
): void {
  const args: Record<string, unknown> = { action: "add", ledger_id: ledgerId, amount };
  if (category !== undefined) args.category = category;
  const result = bookkeepingExpenseTool(args, toolCtx(env, profileId));
  assert.equal(result.isError, undefined, `记账失败：${text(result)}`);
}

/** 记录型 services：不做去重，便于断言「发了什么」；幂等另用真实 createServices 验 */
function recorder() {
  const published: Published[] = [];
  return {
    published,
    services: {
      publishProfile: async (profileId: string, input: PublishInput) => {
        published.push({ profileId, input });
        return { id: `n-${published.length}`, deduped: false };
      },
    },
  };
}

/** 直接落库造数据：摘要按 spent_on + created_by_profile 聚合，不必走 add 的副作用 */
function seedExpense(
  env: TestEnv,
  input: {
    id: string;
    ledgerId: string;
    cents: number;
    category: string;
    profile: string;
    date: string;
  },
): void {
  env.db
    .prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(input.id, input.ledgerId, input.cents, input.category, input.date, input.profile);
}

function seedLedger(env: TestEnv, id = "l1", name = "家庭账本"): void {
  env.db
    .prepare("INSERT INTO ledgers (id, name, created_at) VALUES (?, ?, '2026-01-01T00:00:00.000Z')")
    .run(id, name);
}

describe("记账回执受众（降噪①）", () => {
  it("家庭账本回执只发记账人：两个人各记一笔，各收到自己那条", () => {
    const env = makeTestEnv();
    try {
      const ledgerId = createLedger(env, "家庭日用");
      addExpense(env, ledgerId, 12.34, "default", "餐饮");
      addExpense(env, ledgerId, 30, "partner", "交通");

      const receipts = env.published.filter((p) => p.input.kind === "bookkeeping.entry");
      assert.equal(receipts.length, 2, "两笔各一条回执");
      assert.deepEqual(
        receipts.map((p) => p.profileId).sort(),
        ["default", "partner"],
        "回执只发给记账人，不再 publishGlobal",
      );
      assert.ok(
        !env.published.some((p) => p.profileId === "*"),
        "家庭账本回执不得再走全局推送（这正是 172 条噪声的来源）",
      );
      // 内容仍是那笔账本身（dedupeKey 形状不变，便于想恢复逐笔推送的人去重）
      assert.match(receipts[0]?.input.title ?? "", /¥12\.34/);
      assert.match(receipts[0]?.input.dedupeKey ?? "", /^entry:/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("预算阈值提醒仍走全局推送（降噪只针对逐笔回执）", () => {
    const env = makeTestEnv();
    try {
      const ledgerId = createLedger(env, "预算账本");
      bookkeepingLedgerTool({ action: "budget", ledger_id: ledgerId, amount: 100 }, toolCtx(env));
      addExpense(env, ledgerId, 90, "default");

      const budget = env.published.find((p) => p.input.kind === "bookkeeping.budget");
      assert.ok(budget !== undefined, "跨 80% 应推预算提醒");
      assert.equal(budget.profileId, "*", "预算提醒保持 publishGlobal");
      const receipt = env.published.find((p) => p.input.kind === "bookkeeping.entry");
      assert.equal(receipt?.profileId, "default", "同一次记账的回执只给记账人");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("个人账本仍不回执、不推预算提醒", () => {
    const env = makeTestEnv();
    try {
      const created = JSON.parse(
        text(
          bookkeepingLedgerTool({ action: "create", name: "私房钱", personal: true }, toolCtx(env)),
        ),
      ) as { 已创建: { id: string } };
      bookkeepingLedgerTool(
        { action: "budget", ledger_id: created.已创建.id, amount: 100 },
        toolCtx(env),
      );
      env.published.length = 0;
      addExpense(env, created.已创建.id, 200);
      assert.equal(env.published.length, 0, "个人账本保持完全安静");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("每日记账摘要 pushDailyDigests（降噪②）", () => {
  it("当天没有记账：不发布任何东西", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env);
      const rec = recorder();
      assert.equal(await pushDailyDigests(env.db, rec.services, todayIso()), 0);
      assert.deepEqual(rec.published, []);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("只汇总当天：昨天的记账不出现，跨 Profile 互不串账", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env);
      const today = todayIso();
      const yesterday = DateTime.fromISO(today).minus({ days: 1 }).toISODate() as string;
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 1234,
        category: "餐饮",
        profile: "default",
        date: today,
      });
      seedExpense(env, {
        id: "e2",
        ledgerId: "l1",
        cents: 660,
        category: "交通",
        profile: "default",
        date: today,
      });
      seedExpense(env, {
        id: "e3",
        ledgerId: "l1",
        cents: 5000,
        category: "房租",
        profile: "partner",
        date: today,
      });
      seedExpense(env, {
        id: "e4",
        ledgerId: "l1",
        cents: 9999,
        category: "旧账",
        profile: "default",
        date: yesterday,
      });

      const rec = recorder();
      assert.equal(await pushDailyDigests(env.db, rec.services, today), 2, "当天有两个记账人");

      const mine = rec.published.find((p) => p.profileId === "default");
      const theirs = rec.published.find((p) => p.profileId === "partner");
      assert.ok(mine !== undefined && theirs !== undefined);
      assert.equal(mine.input.kind, "bookkeeping.digest");
      assert.equal(mine.input.title, "🧾 今日记账 2 笔 · ¥18.94", "只统计当天、只统计自己记的");
      assert.equal(theirs.input.title, "🧾 今日记账 1 笔 · ¥50.00");
      assert.equal(mine.input.dedupeKey, `digest:default:${today}`);
      assert.equal(theirs.input.dedupeKey, `digest:partner:${today}`);
      const rows = mine.input.blocks.table?.rows ?? [];
      assert.deepEqual(rows[0], ["餐饮", "¥12.34", "1 笔"], "分类按金额降序");
      assert.deepEqual(rows[rows.length - 1], ["合计", "¥18.94", "2 笔"]);
      assert.ok(!JSON.stringify(mine.input.blocks).includes("旧账"), "昨天的账不得混进今天的摘要");
      assert.ok(!JSON.stringify(mine.input.blocks).includes("房租"), "别人的账不得混进我的摘要");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同一天重复触发只物化一条（dedupeKey 幂等）", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env);
      const today = todayIso();
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 100,
        category: "餐饮",
        profile: "default",
        date: today,
      });

      // 真实 services（走 notifications 的 (profile_id, dedupe_key) 唯一约束）
      const services = createServices(env.db, env.config);
      assert.equal(await pushDailyDigests(env.db, services, today), 1);
      assert.equal(await pushDailyDigests(env.db, services, today), 0, "第二次全部被去重");
      const count = env.db
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'bookkeeping.digest'")
        .get() as { n: number };
      assert.equal(count.n, 1, "一天一条摘要，不因补跑/cron 撞车重复");
      assert.equal(
        (
          env.db
            .prepare("SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key = ?")
            .get(`digest:default:${today}`) as { n: number }
        ).n,
        1,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("分类超过 top5：表格只留金额最高的 5 类，其余合并进备注", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env);
      const today = todayIso();
      // 7 类，金额依次 700..100 分：前 5 类进表格，后 2 类（200/100）进备注
      for (let i = 0; i < 7; i++) {
        seedExpense(env, {
          id: `e${i}`,
          ledgerId: "l1",
          cents: (7 - i) * 100,
          category: `分类${i + 1}`,
          profile: "default",
          date: today,
        });
      }
      const rec = recorder();
      assert.equal(await pushDailyDigests(env.db, rec.services, today), 1);
      const blocks = rec.published[0]?.input.blocks;
      assert.equal(blocks?.table?.rows.length, DIGEST_TOP_CATEGORIES + 1, "top5 + 合计行");
      assert.deepEqual(blocks?.table?.rows[0], ["分类1", "¥7.00", "1 笔"]);
      assert.deepEqual(blocks?.table?.rows[4], ["分类5", "¥3.00", "1 笔"]);
      assert.deepEqual(blocks?.notes, ["共 7 笔", "其余 2 类：¥3.00"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("job 接线：ledger_digest 的 cron 来自 config，handler 真的发布摘要", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env);
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 250,
        category: "餐饮",
        profile: "default",
        date: todayIso(),
      });
      const job = allJobs().find(
        (j) => j.module === "bookkeeping" && j.def.name === "ledger_digest",
      );
      assert.ok(job !== undefined, "bookkeeping 应注册 ledger_digest job");
      assert.equal(typeof job.def.cron, "function", "cron 必须惰性读取 config");
      assert.equal((job.def.cron as () => string)(), "30 21 * * *", "默认 21:30");
      assert.equal(env.config.ledgerDigestCron, "30 21 * * *");
      // 用 LEDGER_DIGEST_CRON 覆盖时，job 必须跟着变（不能把默认值写死在注册表里）
      assert.equal((job.def.cron as () => string)(), env.config.ledgerDigestCron);

      await job.def.handler(DateTime.now());
      const digest = env.published.find((p) => p.input.kind === "bookkeeping.digest");
      assert.ok(digest !== undefined, "handler 应发布摘要");
      assert.equal(digest.profileId, "default");
      assert.match(digest.input.title, /今日记账 1 笔 · ¥2\.50/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("job 的 cron 随 LEDGER_DIGEST_CRON 变化", () => {
    const env = makeTestEnv({ LEDGER_DIGEST_CRON: "45 22 * * *" });
    try {
      const job = allJobs().find(
        (j) => j.module === "bookkeeping" && j.def.name === "ledger_digest",
      );
      assert.ok(job !== undefined);
      assert.equal((job.def.cron as () => string)(), "45 22 * * *");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
