import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { createServices, setPushRoute } from "../src/core/notify.js";
import { allJobs, runtime } from "../src/core/registry.js";
import {
  DIGEST_TOP_CATEGORIES,
  monthDay,
  pushWeeklyReports,
  setBudget,
  weekRange,
} from "../src/modules/bookkeeping/service.js";
import { TZ, todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type Published, type TestEnv } from "./helpers.js";
// 副作用 import：注册全部模块，才能从 allJobs() 里取到 weekly_report 这个 job
import "../src/modules/index.js";

/**
 * 周报（bookkeeping.weekly）：每活跃账本一份「本周账单」，含 top5 分类、最大单笔、
 * 环比上周、本月预算剩余/日均。家庭账本 publishGlobal、个人账本只给归属人；
 * dedupeKey = weekly:<ledger>:<周一> 保证同一周重复触发（cron 与启动补发撞车）只发一条。
 */

function seedLedger(
  env: TestEnv,
  opts: { id: string; name: string; owner?: string | null; archived?: boolean },
): void {
  env.db
    .prepare(
      `INSERT INTO ledgers (id, name, created_at, archived_at, owner_profile_id)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?, ?)`,
    )
    .run(
      opts.id,
      opts.name,
      opts.archived === true ? "2026-06-01T00:00:00.000Z" : null,
      opts.owner ?? null,
    );
}

function seedExpense(
  env: TestEnv,
  input: {
    id: string;
    ledgerId: string;
    cents: number;
    category: string;
    date: string;
    profile?: string;
  },
): void {
  env.db
    .prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(
      input.id,
      input.ledgerId,
      input.cents,
      input.category,
      input.date,
      input.profile ?? "default",
    );
}

/** 取本次推送里唯一/第一条周报 */
function weeklyPublished(env: TestEnv): Published {
  const rows = env.published.filter((p) => p.input.kind === "bookkeeping.weekly");
  assert.equal(rows.length, 1, `应只发布一条周报，实际 ${rows.length} 条`);
  return rows[0] as Published;
}

describe("weekRange：本地日历周（周一~周日，Asia/Shanghai）", () => {
  it("周日 / 周一 / 周三都归到同一周（周一为起点）", () => {
    const expected = { start: "2026-10-12", end: "2026-10-18" };
    assert.deepEqual(weekRange("2026-10-12"), expected, "周一");
    assert.deepEqual(weekRange("2026-10-14"), expected, "周三");
    assert.deepEqual(weekRange("2026-10-18"), expected, "周日属于同一周（不是下一周）");
  });

  it("跨月：2026-09-30（周三）→ 2026-09-28~2026-10-04", () => {
    assert.deepEqual(weekRange("2026-09-30"), {
      start: "2026-09-28",
      end: "2026-10-04",
    });
  });

  it("跨年：2026-01-01（周四）→ 2025-12-29~2026-01-04", () => {
    assert.deepEqual(weekRange("2026-01-01"), {
      start: "2025-12-29",
      end: "2026-01-04",
    });
  });

  it("缺省取今天所在周：start 是周一、end 是周日、today 落在区间内", () => {
    const { start, end } = weekRange();
    assert.equal(DateTime.fromISO(start).weekday, 1, "start 必须是周一");
    assert.equal(DateTime.fromISO(end).weekday, 7, "end 必须是周日");
    assert.ok(start <= todayIso() && todayIso() <= end, "今天必须在区间内");
    assert.deepEqual(weekRange(todayIso()), { start, end });
  });

  it("非法日期抛错（不做静默兜底）", () => {
    assert.throws(() => weekRange("2026-02-30"), /日期不合法/);
    assert.throws(() => weekRange("2026/10/12"), /日期不合法/);
  });
});

describe("周报内容：表格 / 笔数 / 最大单笔 / 环比", () => {
  it("本周账单：标题、表格、笔数、最大单笔、环比上周；家庭账本 publishGlobal", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "l1", name: "家庭账本" });
      // 上周（10/5~10/11）：¥20
      seedExpense(env, {
        id: "p1",
        ledgerId: "l1",
        cents: 2000,
        category: "餐饮",
        date: "2026-10-06",
      });
      // 本周（10/12~10/18）：餐饮 30 / 交通 20 / 购物 10
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 3000,
        category: "餐饮",
        date: "2026-10-12",
      });
      seedExpense(env, {
        id: "e2",
        ledgerId: "l1",
        cents: 2000,
        category: "交通",
        date: "2026-10-14",
      });
      seedExpense(env, {
        id: "e3",
        ledgerId: "l1",
        cents: 1000,
        category: "购物",
        date: "2026-10-18",
      });

      assert.equal(await pushWeeklyReports(env.db, runtime().services, "2026-10-12"), 1);
      const pub = weeklyPublished(env);
      assert.equal(pub.profileId, "*", "家庭账本走 publishGlobal");
      assert.equal(pub.input.title, "📅 本周账单 · 10/12–10/18");
      assert.equal(pub.input.dedupeKey, "weekly:l1:2026-10-12");

      const table = pub.input.blocks.table;
      assert.ok(table !== undefined);
      assert.deepEqual(table.columns, ["分类", "金额", "占比"]);
      assert.deepEqual(
        table.rows,
        [
          ["餐饮", "¥30.00", "50.0%"],
          ["交通", "¥20.00", "33.3%"],
          ["购物", "¥10.00", "16.7%"],
          ["合计", "¥60.00", "100%"],
        ],
        "只统计本周；上周的账不进表格",
      );

      const notes = pub.input.blocks.notes ?? [];
      assert.equal(notes[0], "共 3 笔");
      assert.match(notes[1] ?? "", /^最大单笔 ¥30\.00（餐饮，10\/12）$/);
      // 60 vs 20 → +200.0%
      assert.equal(notes[2], "环比上周 +200.0%");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("上周无支出：明确写「上周无支出」，不出现 Infinity/NaN", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "l1", name: "新账本" });
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 500,
        category: "餐饮",
        date: "2026-10-13",
      });
      await pushWeeklyReports(env.db, runtime().services, "2026-10-12");
      const notes = weeklyPublished(env).input.blocks.notes ?? [];
      assert.ok(
        notes.includes("环比上周：上周无支出"),
        `上周没数据时不能除以 0，实际备注：${notes.join(" / ")}`,
      );
      assert.ok(!/Infinity|NaN/.test(JSON.stringify(notes)), "不得出现 Infinity/NaN");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("环比下降时带负号；上周合计相同显示 0.0%", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "l1", name: "下降" });
      // 上周 100、本周 50 → -50.0%
      seedExpense(env, {
        id: "p1",
        ledgerId: "l1",
        cents: 10000,
        category: "餐饮",
        date: "2026-10-05",
      });
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 5000,
        category: "餐饮",
        date: "2026-10-13",
      });
      await pushWeeklyReports(env.db, runtime().services, "2026-10-12");
      assert.ok((weeklyPublished(env).input.blocks.notes ?? []).includes("环比上周 -50.0%"));
    } finally {
      cleanupTestEnv(env);
    }

    const env2 = makeTestEnv();
    try {
      seedLedger(env2, { id: "l1", name: "持平" });
      seedExpense(env2, {
        id: "p1",
        ledgerId: "l1",
        cents: 1000,
        category: "餐饮",
        date: "2026-10-06",
      });
      seedExpense(env2, {
        id: "e1",
        ledgerId: "l1",
        cents: 1000,
        category: "餐饮",
        date: "2026-10-13",
      });
      await pushWeeklyReports(env2.db, runtime().services, "2026-10-12");
      assert.ok((weeklyPublished(env2).input.blocks.notes ?? []).includes("环比上周 0.0%"));
    } finally {
      cleanupTestEnv(env2);
    }
  });

  it("分类超过 top5：表格只留金额最高的 5 类，其余合并进备注", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "l1", name: "多分类" });
      // 7 类，金额 700..100 分：前 5 类进表格，后 2 类进备注
      for (let i = 0; i < 7; i++) {
        seedExpense(env, {
          id: `e${i}`,
          ledgerId: "l1",
          cents: (7 - i) * 100,
          category: `分类${i + 1}`,
          date: "2026-10-14",
        });
      }
      assert.equal(await pushWeeklyReports(env.db, runtime().services, "2026-10-12"), 1);
      const blocks = weeklyPublished(env).input.blocks;
      assert.equal(blocks.table?.rows.length, DIGEST_TOP_CATEGORIES + 1, "top5 + 合计行");
      assert.deepEqual(blocks.table?.rows[0], ["分类1", "¥7.00", "25.0%"]);
      assert.deepEqual(blocks.table?.rows[4], ["分类5", "¥3.00", "10.7%"]);
      assert.deepEqual(blocks.notes?.slice(0, 2), ["共 7 笔", "其余 2 类：¥3.00"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨年周：标题 M/D 跨年正确，两天支出都算本周", async () => {
    const env = makeTestEnv();
    try {
      // 2025-12-29（周一）~2026-01-04（周日）
      seedLedger(env, { id: "l1", name: "跨年" });
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 1000,
        category: "餐饮",
        date: "2025-12-31",
      });
      seedExpense(env, {
        id: "e2",
        ledgerId: "l1",
        cents: 2000,
        category: "交通",
        date: "2026-01-02",
      });
      await pushWeeklyReports(env.db, runtime().services, "2025-12-29");
      const pub = weeklyPublished(env);
      assert.equal(pub.input.title, "📅 本周账单 · 12/29–1/4");
      const rows = pub.input.blocks.table?.rows ?? [];
      assert.deepEqual(rows[rows.length - 1], ["合计", "¥30.00", "100%"]);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("周报受众：家庭全局 / 个人只给归属人", () => {
  it("家庭账本 publishGlobal；个人账本 publishProfile(owner)，不泄露给其他 Profile", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "family", name: "家庭" });
      seedLedger(env, { id: "mine", name: "私房钱", owner: "default" });
      seedLedger(env, { id: "theirs", name: "对方的私房钱", owner: "partner" });
      seedExpense(env, {
        id: "e1",
        ledgerId: "family",
        cents: 1000,
        category: "餐饮",
        date: "2026-10-13",
      });
      seedExpense(env, {
        id: "e2",
        ledgerId: "mine",
        cents: 2000,
        category: "购物",
        date: "2026-10-13",
        profile: "default",
      });
      seedExpense(env, {
        id: "e3",
        ledgerId: "theirs",
        cents: 3000,
        category: "娱乐",
        date: "2026-10-13",
        profile: "partner",
      });

      assert.equal(await pushWeeklyReports(env.db, runtime().services, "2026-10-12"), 3);
      const byProfile = env.published
        .filter((p) => p.input.kind === "bookkeeping.weekly")
        .map((p) => ({ profileId: p.profileId, key: p.input.dedupeKey }));
      assert.deepEqual(
        byProfile.map((p) => p.profileId).sort(),
        ["*", "default", "partner"],
        "家庭账本走全局；两本个人账本只发给各自的归属人",
      );
      assert.ok(byProfile.some((p) => p.key === "weekly:family:2026-10-12" && p.profileId === "*"));
      assert.ok(
        byProfile.some((p) => p.key === "weekly:mine:2026-10-12" && p.profileId === "default"),
      );
      assert.ok(
        byProfile.some((p) => p.key === "weekly:theirs:2026-10-12" && p.profileId === "partner"),
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("无支出的账本跳过（不推「本周 0 笔」）；已归档账本不推（只算活跃账本）", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "active", name: "有支出" });
      seedLedger(env, { id: "empty", name: "空账本" });
      seedLedger(env, { id: "archived", name: "已归档", archived: true });
      seedExpense(env, {
        id: "e1",
        ledgerId: "active",
        cents: 1000,
        category: "餐饮",
        date: "2026-10-13",
      });
      seedExpense(env, {
        id: "e2",
        ledgerId: "archived",
        cents: 2000,
        category: "餐饮",
        date: "2026-10-13",
      });

      assert.equal(await pushWeeklyReports(env.db, runtime().services, "2026-10-12"), 1);
      assert.equal(weeklyPublished(env).input.dedupeKey, "weekly:active:2026-10-12");
      assert.equal(env.published.length, 1, "空账本与归档账本都不应产生通知");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("周报预算：本月预算的剩余与日均", () => {
  it("设了总额/分类预算：备注追预算行（已用/剩余/本周日均），未设预算则没有该行", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "l1", name: "预算账本" });
      seedLedger(env, { id: "plain", name: "无预算" });
      // 上月最后一周也发生在 10 月内：上周 ¥20（餐饮）计入本月已用
      seedExpense(env, {
        id: "p1",
        ledgerId: "l1",
        cents: 2000,
        category: "餐饮",
        date: "2026-10-06",
      });
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 3000,
        category: "餐饮",
        date: "2026-10-13",
      });
      seedExpense(env, {
        id: "e2",
        ledgerId: "l1",
        cents: 2000,
        category: "交通",
        date: "2026-10-14",
      });
      seedExpense(env, {
        id: "e3",
        ledgerId: "plain",
        cents: 1000,
        category: "餐饮",
        date: "2026-10-14",
      });
      setBudget(env.db, "l1", "", 10000); // 总额预算 ¥100
      setBudget(env.db, "l1", "餐饮", 5000); // 餐饮预算 ¥50

      assert.equal(await pushWeeklyReports(env.db, runtime().services, "2026-10-12"), 2);
      const pub = env.published.find(
        (p) => p.input.dedupeKey === "weekly:l1:2026-10-12",
      ) as Published;
      assert.ok(pub !== undefined);
      const notes = pub.input.blocks.notes ?? [];
      // 10 月已用：20（上周餐饮）+ 30（本周餐饮）+ 20（交通）= 70；本周合计 50 → 日均 50/7
      const totalLine = notes.find((n) => n.startsWith("预算 · 总额"));
      assert.equal(totalLine, "预算 · 总额：已用 ¥70.00 / 剩余 ¥30.00 / 本周日均 ¥7.14");
      const categoryLine = notes.find((n) => n.startsWith("预算 · 分类「餐饮」"));
      assert.equal(categoryLine, "预算 · 分类「餐饮」：已用 ¥50.00 / 剩余 ¥0.00 / 本周日均 ¥7.14");

      // 未设预算的账本：周报里不出现任何「预算」噪音
      const plain = env.published
        .filter((p) => p.input.kind === "bookkeeping.weekly")
        .find((p) => p.input.dedupeKey === "weekly:plain:2026-10-12");
      assert.ok(plain !== undefined);
      assert.ok(
        !(plain.input.blocks.notes ?? []).some((n) => n.includes("预算")),
        "未设预算不应有预算行",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("周报幂等与 job 接线", () => {
  it("同周跑两次只物化一条（真实 createServices 走 notifications 唯一约束）", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "l1", name: "幂等" });
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 1000,
        category: "餐饮",
        date: "2026-10-13",
      });
      setPushRoute(env.db, "default", { url: "http://127.0.0.1:9/hook" });
      const services = createServices(env.db, env.config);
      assert.equal(await pushWeeklyReports(env.db, services, "2026-10-12"), 1);
      assert.equal(await pushWeeklyReports(env.db, services, "2026-10-12"), 0, "第二次全被去重");

      const count = env.db
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE kind = 'bookkeeping.weekly'")
        .get() as { n: number };
      assert.equal(count.n, 1, "同一周只能有一条周报");
      const keyed = env.db
        .prepare("SELECT COUNT(*) AS n FROM notifications WHERE dedupe_key = ?")
        .get("weekly:l1:2026-10-12") as { n: number };
      assert.equal(keyed.n, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("job 接线：weekly_report 的 cron 来自 config，handler 真的发布周报", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "l1", name: "家庭账本", owner: null });
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 250,
        category: "餐饮",
        date: todayIso(),
      });
      const job = allJobs().find(
        (j) => j.module === "bookkeeping" && j.def.name === "weekly_report",
      );
      assert.ok(job !== undefined, "bookkeeping 应注册 weekly_report job");
      assert.equal(typeof job.def.cron, "function", "cron 必须惰性读取 config");
      assert.equal((job.def.cron as () => string)(), "0 20 * * 0", "默认周日 20:00");
      assert.equal(env.config.weeklyReportCron, "0 20 * * 0");

      await job.def.handler(DateTime.now());
      const { start, end } = weekRange(todayIso());
      const pub = weeklyPublished(env);
      assert.equal(pub.profileId, "*");
      assert.equal(pub.input.title, `📅 本周账单 · ${monthDay(start)}–${monthDay(end)}`);
      assert.equal(pub.input.dedupeKey, `weekly:l1:${start}`);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("周一 09:00 补周日 20:00 的周报：weekStart 是刚结束那一周（不是新一周）", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "l1", name: "补发周报" });
      // 10/12~10/18 那一周有支出；10/19（周一）没有
      seedExpense(env, {
        id: "e1",
        ledgerId: "l1",
        cents: 3000,
        category: "餐饮",
        date: "2026-10-14",
      });
      const job = allJobs().find(
        (j) => j.module === "bookkeeping" && j.def.name === "weekly_report",
      );
      assert.ok(job !== undefined);

      // 补发：daemon 把「错过的那次原定触发时刻」（周日 20:00）作为 at 传入
      await job.def.handler(DateTime.fromISO("2026-10-18T20:00:00", { zone: TZ }));
      const pub = weeklyPublished(env);
      assert.equal(
        pub.input.dedupeKey,
        "weekly:l1:2026-10-12",
        "周起点必须是刚结束那一周的周一，而不是补发当天（周一 10-19）所在的新一周",
      );
      assert.equal(pub.input.title, "📅 本周账单 · 10/12–10/18");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("job 的 cron 随 WEEKLY_REPORT_CRON 变化", () => {
    const env = makeTestEnv({ WEEKLY_REPORT_CRON: "30 19 * * 6" });
    try {
      const job = allJobs().find(
        (j) => j.module === "bookkeeping" && j.def.name === "weekly_report",
      );
      assert.ok(job !== undefined);
      assert.equal((job.def.cron as () => string)(), "30 19 * * 6");
      assert.equal(env.config.weeklyReportCron, "30 19 * * 6");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("handler 失败会 rethrow（交给 job_runs 记 failed，不静默吞掉）", async () => {
    const env = makeTestEnv();
    try {
      seedLedger(env, { id: "l1", name: "坏库" });
      const job = allJobs().find(
        (j) => j.module === "bookkeeping" && j.def.name === "weekly_report",
      );
      assert.ok(job !== undefined);
      // 让推送必然失败：删掉 expenses 表后 listLedgers 成功、汇总时会抛错
      env.db.exec("DROP TABLE expenses");
      await assert.rejects(async () => {
        await job.def.handler(DateTime.now());
      }, /no such table: expenses/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
