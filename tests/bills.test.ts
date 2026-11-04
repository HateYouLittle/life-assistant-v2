import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DateTime } from "luxon";
import { readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { TZ } from "../src/time.js";
import { runtime, type ToolContext } from "../src/core/registry.js";
import { getSchemaVersion, openDatabase, SCHEMA_VERSION } from "../src/core/database.js";
import { createLedger } from "../src/modules/bookkeeping/service.js";
import { billTool } from "../src/modules/bills/index.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { tickSchedules } from "../src/modules/schedule/service.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 周期账 / 订阅提醒（bill 工具，schema v6 recurring_bills）：
 * 模板到期 → 复用 schedule.reminder 推「该交话费了 ¥50（通讯）」→ 用户「交了」→
 * 提醒完成 + 按模板入账，期次幂等（同一期只入一笔）。
 */

type Result = { content: { text: string }[]; isError?: boolean };

function freeze(t: TestContext, iso: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(iso) });
}

function setNow(t: TestContext, iso: string): void {
  t.mock.timers.setTime(Date.parse(iso));
}

function ctx(env: TestEnv, profileId = "default"): ToolContext {
  return { profileId, db: env.db, config: env.config, services: runtime().services };
}

function call(
  env: TestEnv,
  args: Record<string, unknown>,
  profileId = "default",
): Record<string, unknown> {
  const result = billTool(args, ctx(env, profileId)) as Result;
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;
}

function callSchedule(env: TestEnv, args: Record<string, unknown>): Record<string, unknown> {
  const result = scheduleTool(args, ctx(env)) as Result;
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return JSON.parse(result.content[0]?.text ?? "") as Record<string, unknown>;
}

function addPhoneBill(env: TestEnv, ledgerId: string, date: string, extra = {}): string {
  const out = call(env, {
    action: "add",
    name: "话费",
    amount: 50,
    category: "通讯",
    ledger_id: ledgerId,
    date,
    ...extra,
  });
  return (out.已创建 as { id: string }).id;
}

function scheduleIdOf(env: TestEnv, billId: string): string {
  const row = env.db
    .prepare("SELECT schedule_id FROM recurring_bills WHERE id = ?")
    .get(billId) as {
    schedule_id: string | null;
  };
  assert.ok(row.schedule_id !== null);
  return row.schedule_id;
}

function eventDates(env: TestEnv, scheduleId: string): string[] {
  return (
    env.db
      .prepare("SELECT event_at FROM occurrences WHERE schedule_id = ? ORDER BY event_at")
      .all(scheduleId) as { event_at: string }[]
  ).map((r) => DateTime.fromISO(r.event_at, { zone: TZ }).toISODate() ?? "");
}

function expenses(env: TestEnv) {
  return env.db
    .prepare("SELECT ledger_id, amount_cents, category, spent_on, client_token FROM expenses")
    .all() as {
    ledger_id: string;
    amount_cents: number;
    category: string;
    spent_on: string;
    client_token: string;
  }[];
}

const tick = (iso: string) =>
  tickSchedules(DateTime.fromISO(iso, { zone: TZ }), runtime().services, runtime().db);

describe("bill 周期账", () => {
  it("建模板即物化到期提醒；到期 tick 推「该交话费了 ¥50（通讯）」并附「交了」提示", async (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "家庭");
      const billId = addPhoneBill(env, ledger.id, "2026-11-10");
      const sid = scheduleIdOf(env, billId);
      assert.deepEqual(eventDates(env, sid).slice(0, 2), ["2026-11-10", "2026-12-10"]);

      setNow(t, "2026-11-10T09:00:30+08:00");
      await tick("2026-11-10T09:00:30+08:00");
      const reminders = env.published.filter((p) => p.input.kind === "schedule.reminder");
      assert.equal(reminders.length, 1);
      const reminder = reminders[0]?.input;
      assert.equal(reminder?.title, "该交话费了 ¥50（通讯）");
      const rows = reminder?.blocks?.table?.rows ?? [];
      assert.deepEqual(
        rows.find((r) => r[0] === "金额"),
        ["金额", "¥50"],
      );
      assert.deepEqual(
        rows.find((r) => r[0] === "账本"),
        ["账本", "家庭"],
      );
      assert.ok(reminder?.blocks?.notes?.some((n) => n.includes("交了")));
      assert.equal(expenses(env).length, 0, "提醒本身不入账");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("bill pay：完成当期提醒并入账；同一期重复调用只入一笔（已处理）", async (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "家庭");
      const billId = addPhoneBill(env, ledger.id, "2026-11-10");
      const sid = scheduleIdOf(env, billId);
      setNow(t, "2026-11-10T09:01:00+08:00");
      await tick("2026-11-10T09:01:00+08:00");

      const first = call(env, { action: "pay", match: "话费" });
      assert.equal(first.结果, "已入账");
      assert.equal(first.已完成提醒, true);
      assert.equal(first.下次到期, "2026-12-10");
      const second = call(env, { action: "pay", id: billId, date: "2026-11-10" });
      assert.equal(second.结果, "已处理");
      assert.equal((second.入账 as { 已存在?: boolean }).已存在, true);

      const rows = expenses(env);
      assert.equal(rows.length, 1);
      assert.deepEqual(
        { ...rows[0] },
        {
          ledger_id: ledger.id,
          amount_cents: 5000,
          category: "通讯",
          spent_on: "2026-11-10",
          client_token: `bill:${billId}:2026-11-10`,
        },
      );
      const done = env.db
        .prepare(
          "SELECT COUNT(*) AS n FROM occurrences WHERE schedule_id = ? AND status = 'done' AND occurrence_key NOT LIKE '%:resend'",
        )
        .get(sid) as { n: number };
      assert.equal(done.n, 1, "只完成当期那一次（同事件的晚间追提醒行一并收敛，不计入）");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("schedule complete {recent:true}（用户只说「交了」）也自动入账，且与 bill pay 共用期次幂等键", async (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "家庭");
      const billId = addPhoneBill(env, ledger.id, "2026-11-10");
      setNow(t, "2026-11-10T09:01:00+08:00");
      await tick("2026-11-10T09:01:00+08:00");
      setNow(t, "2026-11-10T12:00:00+08:00");

      const done = callSchedule(env, { action: "complete", recent: true });
      assert.equal(done.结果, "已完成");
      const booked = done.周期账入账 as { 金额: string; 分类: string; 期次: string };
      assert.deepEqual([booked.金额, booked.分类, booked.期次], ["¥50", "通讯", "2026-11-10"]);

      const again = call(env, { action: "pay", id: billId, date: "2026-11-10" });
      assert.equal(again.结果, "已处理");
      assert.equal(expenses(env).length, 1, "两条路径重复「交了」只入一笔");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("金额/分类落到模板指定的账本（个人账本），而非默认账本", (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      createLedger(env.db, "家庭");
      const personal = createLedger(env.db, "我的", "default");
      call(env, {
        action: "add",
        name: "视频会员",
        amount: 25.5,
        category: "电子卡",
        ledger_id: personal.id,
        date: "2026-11-04",
        time: "08:00",
      });
      const out = call(env, { action: "pay", match: "会员" });
      assert.equal((out.入账 as { 账本: string }).账本, "我的");
      const rows = expenses(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.ledger_id, personal.id);
      assert.equal(rows[0]?.amount_cents, 2550);
      assert.equal(rows[0]?.category, "电子卡");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("停用后不再产生提醒，历史入账不受影响；恢复后重新提醒", async (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "家庭");
      const billId = addPhoneBill(env, ledger.id, "2026-11-04", { time: "09:00" });
      call(env, { action: "pay", id: billId });
      const sid = scheduleIdOf(env, billId);

      const paused = call(env, { action: "pause", id: billId });
      assert.equal((paused.已停用 as { 状态: string }).状态, "已停用");
      const schedule = env.db.prepare("SELECT status FROM schedules WHERE id = ?").get(sid) as {
        status: string;
      };
      assert.equal(schedule.status, "cancelled");

      setNow(t, "2026-12-04T09:01:00+08:00");
      await tick("2026-12-04T09:01:00+08:00");
      assert.equal(
        env.published.filter((p) => p.input.kind === "schedule.reminder").length,
        0,
        "停用后 12 月那期不能再提醒",
      );
      const pending = env.db
        .prepare(
          "SELECT COUNT(*) AS n FROM occurrences WHERE schedule_id = ? AND status = 'pending'",
        )
        .get(sid) as { n: number };
      assert.equal(pending.n, 0);
      assert.equal(expenses(env).length, 1, "历史入账保留");
      const payPaused = billTool({ action: "pay", id: billId }, ctx(env)) as Result;
      assert.equal(payPaused.isError, true);

      call(env, { action: "resume", id: billId });
      const newSid = scheduleIdOf(env, billId);
      assert.notEqual(newSid, sid);
      // 恢复当天（12-04）那期本身就到期了：从今天起物化，不回补停用期间更早的期次
      assert.deepEqual(eventDates(env, newSid)[0], "2026-12-04");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨月：31 日模板在 30 天月份按当月最后一天到期，下个月回到 31 日；各期独立入账", (t) => {
    freeze(t, "2026-10-01T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "家庭");
      const billId = addPhoneBill(env, ledger.id, "2026-10-31");
      const dates = eventDates(env, scheduleIdOf(env, billId));
      assert.deepEqual(dates.slice(0, 2), ["2026-10-31", "2026-11-30"]);

      setNow(t, "2026-11-30T10:00:00+08:00");
      // 10-31 那期没交，11-30 这期到了：pay 默认取已到期未交的最早一期（10-31）
      const oct = call(env, { action: "pay", id: billId });
      assert.equal((oct.入账 as { 期次: string }).期次, "2026-10-31");
      const nov = call(env, { action: "pay", id: billId });
      assert.equal((nov.入账 as { 期次: string }).期次, "2026-11-30");
      assert.equal(nov.下次到期, "2026-12-31");
      assert.deepEqual(
        expenses(env)
          .map((r) => r.spent_on)
          .sort(),
        ["2026-10-31", "2026-11-30"],
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("add 的 request_id 幂等；未知字段与缺 category 明确报错", (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      const ledger = createLedger(env.db, "家庭");
      const a = addPhoneBill(env, ledger.id, "2026-11-10", { request_id: "r1" });
      const again = call(env, {
        action: "add",
        name: "话费",
        amount: 50,
        category: "通讯",
        ledger_id: ledger.id,
        date: "2026-11-10",
        request_id: "r1",
      });
      assert.equal(again.已存在, true);
      assert.equal((again.已创建 as { id: string }).id, a);
      const schedules = env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as {
        n: number;
      };
      assert.equal(schedules.n, 1, "幂等命中不能多建一条提醒日程");

      const unknown = billTool({ action: "pay", id: a, amount: 1 }, ctx(env)) as Result;
      assert.equal(unknown.isError, true);
      assert.match(unknown.content[0]?.text ?? "", /未知字段: amount（action=pay 不接受）/);
      const noCategory = billTool(
        { action: "add", name: "x", amount: 1, ledger_id: ledger.id, date: "2026-11-10" },
        ctx(env),
      ) as Result;
      assert.equal(noCategory.isError, true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("不能用别人的个人账本建模板；他人看不到我的模板", (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      env.db
        .prepare("INSERT INTO profiles (id, created_at) VALUES ('other', '2026-01-01T00:00:00Z')")
        .run();
      const theirs = createLedger(env.db, "TA 的", "other");
      const denied = billTool(
        {
          action: "add",
          name: "话费",
          amount: 50,
          category: "通讯",
          ledger_id: theirs.id,
          date: "2026-11-10",
        },
        ctx(env),
      ) as Result;
      assert.equal(denied.isError, true);
      assert.equal(
        (env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number }).n,
        0,
        "校验失败不能留下孤儿提醒日程",
      );
      const mine = addPhoneBill(env, createLedger(env.db, "家庭").id, "2026-11-10");
      const peek = call(env, { action: "list" }, "other");
      assert.equal(peek.数量, 0);
      const pay = call(env, { action: "pay", id: mine }, "other");
      assert.equal(pay.结果, "未找到");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schema v5 -> v6 迁移", () => {
  it("附加式建出 recurring_bills，旧数据保留，升级前留 pre-v5 快照", () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '家庭账本', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      env.db.close();
      const raw = new DatabaseSync(env.config.dbPath);
      raw.exec("DROP INDEX idx_recurring_bills_client_token");
      raw.exec("DROP TABLE recurring_bills");
      raw.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
      raw.close();

      const upgraded = openDatabase(env.config.dbPath, { backupDir: env.config.backupDir });
      try {
        assert.equal(getSchemaVersion(upgraded), SCHEMA_VERSION);
        assert.equal(SCHEMA_VERSION, 6);
        assert.ok(
          upgraded
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='recurring_bills'")
            .get() !== undefined,
        );
        const n = upgraded.prepare("SELECT COUNT(*) AS n FROM ledgers").get() as { n: number };
        assert.equal(n.n, 1);
      } finally {
        upgraded.close();
      }
      const snapshots = readdirSync(env.config.backupDir).filter((name) =>
        /^life-assistant-pre-v5-\d{8}-\d{6}\.db$/.test(name),
      );
      assert.equal(snapshots.length, 1, "v5 升级到 v6 前必须留一份 pre-v5 快照");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
