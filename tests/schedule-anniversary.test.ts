import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DateTime } from "luxon";
import { TZ } from "../src/time.js";
import {
  anniversaryMilestoneText,
  countdownText,
  daysBetween,
  defaultRemindOffsets,
  milestoneOn,
  milestoneText,
} from "../src/modules/schedule/anniversary.js";
import {
  createSchedule,
  fireDue,
  reminderBlocks,
  upcomingSpecialDays,
  type ScheduleInput,
  type ScheduleRow,
} from "../src/modules/schedule/service.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { specialDayNotes } from "../src/modules/weather/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 生日 / 纪念日增强：默认三档提醒、第 N 天 / N 周年、倒计时、备注、早报近 14 天栏。
 * 时钟用 node:test mock timers（apis:["Date"]）冻结。
 */

function freeze(t: TestContext, at: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
}

function services(env: TestEnv) {
  return {
    publishProfile: async (profileId: string, input: { kind: string }) => {
      env.published.push({ profileId, input: input as never });
      return { id: `n-${env.published.length}`, deduped: false };
    },
    publishGlobal: async () => ({ materialized: 0 }),
  };
}

function input(over: Partial<ScheduleInput>): ScheduleInput {
  return {
    title: "纪念日",
    note: null,
    kind: "anniversary",
    calendar: "solar",
    startDate: "2024-06-01",
    time: "09:00",
    allDay: true,
    recurrence: { freq: "yearly", interval: 1 },
    remindOffsets: [-10080, -1440, 0],
    resendMinutes: 0,
    workdayFilter: "any",
    ...over,
  };
}

function rowsOf(blocks: { table?: { rows: string[][] } }): Record<string, string> {
  return Object.fromEntries((blocks.table?.rows ?? []).map((r) => [r[0], r[1]]));
}

describe("纪念日纯函数", () => {
  it("第 N 天：开始当天不算（返回 null），次日为第 2 天；跨年、跨月", () => {
    assert.equal(milestoneOn("2024-06-01", "2024-06-01"), null);
    assert.deepEqual(milestoneOn("2024-06-01", "2024-06-02"), { dayNumber: 2, years: null });
    assert.deepEqual(milestoneOn("2025-12-31", "2026-01-01"), { dayNumber: 2, years: null });
    assert.deepEqual(milestoneOn("2026-01-31", "2026-03-01"), { dayNumber: 30, years: null });
    // 早于开始日 / 非法日期
    assert.equal(milestoneOn("2024-06-01", "2024-05-31"), null);
    assert.equal(milestoneOn("2024-02-30", "2025-01-01"), null);
  });

  it("N 周年：同月同日才算，跨闰年天数正确", () => {
    // 2021-11-08 → 2026-11-08：5 年，含 2024 闰日共 1826 天 → 第 1827 天
    assert.deepEqual(milestoneOn("2021-11-08", "2026-11-08"), { dayNumber: 1827, years: 5 });
    assert.equal(milestoneText({ dayNumber: 1827, years: 5 }), "5 周年 · 第 1827 天");
    assert.equal(milestoneText({ dayNumber: 885, years: null }), "第 885 天");
    // 2024-06-01 → 2026-06-01：730 天 → 第 731 天，2 周年
    assert.deepEqual(milestoneOn("2024-06-01", "2026-06-01"), { dayNumber: 731, years: 2 });
  });

  it("2 月 29 日开始：平年 2-28 算周年（与引擎夹取一致），闰年只认 2-29", () => {
    assert.deepEqual(milestoneOn("2024-02-29", "2025-02-28"), { dayNumber: 366, years: 1 });
    assert.deepEqual(milestoneOn("2024-02-29", "2028-02-29"), { dayNumber: 1462, years: 4 });
    assert.deepEqual(milestoneOn("2024-02-29", "2028-02-28"), { dayNumber: 1461, years: null });
    assert.deepEqual(milestoneOn("2024-02-29", "2025-03-01"), { dayNumber: 367, years: null });
  });

  it("倒计时与天数差", () => {
    assert.equal(countdownText("2026-11-04", "2026-11-04"), "今天");
    assert.equal(countdownText("2026-12-30", "2027-01-02"), "还有 3 天");
    assert.equal(countdownText("2026-11-04", "2026-11-03"), null);
    assert.equal(daysBetween("2024-02-28", "2024-03-01"), 2);
    assert.equal(daysBetween("2025-02-28", "2025-03-01"), 1);
  });

  it("只有公历纪念日给纪念文案；生日、农历、缺开始日一律不给", () => {
    const base = { kind: "anniversary", calendar: "solar", start_date: "2024-06-01" };
    assert.equal(anniversaryMilestoneText(base, "2026-06-01"), "2 周年 · 第 731 天");
    assert.equal(anniversaryMilestoneText({ ...base, kind: "birthday" }, "2026-06-01"), null);
    assert.equal(anniversaryMilestoneText({ ...base, calendar: "lunar" }, "2026-06-01"), null);
    assert.equal(anniversaryMilestoneText({ ...base, start_date: null }, "2026-06-01"), null);
  });

  it("默认提醒偏移：待办 [0]，生日/纪念日三档；返回新数组", () => {
    assert.deepEqual(defaultRemindOffsets("todo"), [0]);
    assert.deepEqual(defaultRemindOffsets("birthday"), [-10080, -1440, 0]);
    assert.deepEqual(defaultRemindOffsets("anniversary"), [-10080, -1440, 0]);
    const a = defaultRemindOffsets("birthday");
    a.push(1);
    assert.deepEqual(defaultRemindOffsets("birthday"), [-10080, -1440, 0]);
  });
});

describe("默认三档提醒的物化", () => {
  function tool(env: TestEnv, args: Record<string, unknown>) {
    return scheduleTool(args, {
      profileId: "default",
      db: env.db,
      config: env.config,
      services: services(env),
    }) as { isError?: boolean; content: { text: string }[] };
  }

  function dueAts(env: TestEnv, id: string): string[] {
    return (
      env.db
        .prepare("SELECT due_at FROM occurrences WHERE schedule_id = ? ORDER BY due_at")
        .all(id) as { due_at: string }[]
    ).map((r) => DateTime.fromISO(r.due_at, { zone: TZ }).toFormat("yyyy-MM-dd HH:mm"));
  }

  it("生日不传 remind_offsets：落库 [-10080,-1440,0]，物化出提前 7 天 / 前 1 天 / 当天", (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      const res = tool(env, {
        action: "add",
        title: "朋友生日",
        kind: "birthday",
        date: "2026-11-20",
        time: "09:00",
      });
      assert.notEqual(res.isError, true, res.content[0]?.text);
      const id = (JSON.parse(res.content[0]?.text ?? "{}") as { 已创建: { id: string } }).已创建.id;
      const row = env.db
        .prepare("SELECT remind_offsets_json FROM schedules WHERE id = ?")
        .get(id) as { remind_offsets_json: string };
      assert.equal(row.remind_offsets_json, "[-10080,-1440,0]");
      assert.deepEqual(dueAts(env, id), [
        "2026-11-13 09:00",
        "2026-11-19 09:00",
        "2026-11-20 09:00",
      ]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("显式 remind_offsets 以配置为准；待办缺省仍是到点提醒", (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      const custom = tool(env, {
        action: "add",
        title: "纪念日",
        kind: "anniversary",
        date: "2026-11-20",
        remind_offsets: [0],
      });
      const customId = (JSON.parse(custom.content[0]?.text ?? "{}") as { 已创建: { id: string } })
        .已创建.id;
      assert.deepEqual(dueAts(env, customId), ["2026-11-20 09:00"]);
      const todo = tool(env, { action: "add", title: "交话费", date: "2026-11-20" });
      const todoId = (JSON.parse(todo.content[0]?.text ?? "{}") as { 已创建: { id: string } })
        .已创建.id;
      assert.deepEqual(dueAts(env, todoId), ["2026-11-20 09:00"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("存量日程不被改写：库里的 [0] 生日保持单档", (t) => {
    freeze(t, "2026-11-04T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      const row = createSchedule(
        env.db,
        "default",
        input({ kind: "birthday", startDate: "2026-11-20", remindOffsets: [0] }),
      );
      assert.equal(row.remind_offsets_json, "[0]");
      assert.deepEqual(dueAts(env, row.id), ["2026-11-20 09:00"]);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("提醒正文：倒计时 / 纪念 / 备注", () => {
  it("纪念日提前 7 天那条：带「还有 7 天」与「2 周年 · 第 731 天」", async (t) => {
    freeze(t, "2026-05-20T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      createSchedule(env.db, "default", input({ title: "在一起纪念日", note: "订餐厅" }));
      await fireDue(env.db, services(env), DateTime.fromISO("2026-05-25T09:00", { zone: TZ }));
      assert.equal(env.published.length, 1);
      const rows = rowsOf(env.published[0]?.input.blocks ?? {});
      assert.equal(rows.倒计时, "还有 7 天");
      assert.equal(rows.纪念, "2 周年 · 第 731 天");
      assert.equal(rows.备注, "订餐厅");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("当天那条：倒计时为「今天」", async (t) => {
    freeze(t, "2026-05-20T10:00:00+08:00");
    const env = makeTestEnv();
    try {
      createSchedule(env.db, "default", input({}));
      await fireDue(env.db, services(env), DateTime.fromISO("2026-06-01T09:00", { zone: TZ }));
      // 三档提醒都已到点：取当天那条（最后一条）
      const last = env.published[env.published.length - 1];
      assert.equal(rowsOf(last?.input.blocks ?? {}).倒计时, "今天");
    } finally {
      cleanupTestEnv(env);
    }
  });

  function row(over: Partial<ScheduleRow>): ScheduleRow {
    return {
      id: "s1",
      profile_id: "default",
      title: "宝的生日",
      note: null,
      kind: "birthday",
      calendar: "lunar",
      start_date: null,
      lunar_month: 5,
      lunar_day: 2,
      leap_policy: "follow",
      lunar_clamp: 1,
      time: "09:00",
      all_day: 1,
      recurrence_json: '{"freq":"yearly","interval":1}',
      remind_offsets_json: "[-10080,-1440,0]",
      resend_minutes: 0,
      escalation_json: null,
      workday_filter: "any",
      status: "active",
      next_run_at: null,
      version: 1,
      created_at: "2026-08-02T00:00:00.000Z",
      updated_at: "2026-08-02T00:00:00.000Z",
      ...over,
    };
  }

  it("生日：有备注带「备注」行；备注为空/空白时整行省略；生日不给纪念文案", () => {
    const eventAt = "2027-06-07T01:00:00.000Z";
    const withNote = rowsOf(
      reminderBlocks(row({ note: "礼物：香水" }), eventAt, null, undefined, "2027-06-06"),
    );
    assert.equal(withNote.备注, "礼物：香水");
    assert.equal(withNote.倒计时, "还有 1 天");
    assert.equal(withNote.纪念, undefined);
    for (const note of [null, "", "   "]) {
      const blocks = reminderBlocks(row({ note }), eventAt, null, undefined, "2027-06-06");
      assert.ok(
        !(blocks.table?.rows ?? []).some((r) => r[0] === "备注"),
        `note=${JSON.stringify(note)} 不应输出备注行`,
      );
    }
  });

  it("不传 today 时不输出倒计时（既有调用方形状不变）；待办不带纪念/倒计时", () => {
    const eventAt = "2027-06-07T01:00:00.000Z";
    assert.equal(rowsOf(reminderBlocks(row({}), eventAt, null)).倒计时, undefined);
    const todo = rowsOf(
      reminderBlocks(
        row({ kind: "todo", calendar: "solar", start_date: "2020-01-01" }),
        eventAt,
        null,
        undefined,
        "2027-06-06",
      ),
    );
    assert.equal(todo.倒计时, undefined);
    assert.equal(todo.纪念, undefined);
  });
});

describe("近 14 天生日/纪念日（早报栏数据）", () => {
  it("按日期升序、含当天、窗口外不列；多档提醒只算一次；待办不列", (t) => {
    freeze(t, "2026-11-04T08:00:00+08:00");
    const env = makeTestEnv();
    try {
      createSchedule(env.db, "default", input({ title: "认识纪念日", startDate: "2021-11-08" }));
      createSchedule(
        env.db,
        "default",
        input({ title: "妹妹生日", kind: "birthday", startDate: "2026-11-04" }),
      );
      createSchedule(
        env.db,
        "default",
        input({ title: "第 14 天", kind: "birthday", startDate: "2026-11-18" }),
      );
      createSchedule(
        env.db,
        "default",
        input({ title: "第 15 天", kind: "birthday", startDate: "2026-11-19" }),
      );
      createSchedule(
        env.db,
        "default",
        input({
          title: "交话费",
          kind: "todo",
          startDate: "2026-11-05",
          recurrence: null,
          remindOffsets: [0],
        }),
      );
      // 别人的生日不串 Profile
      createSchedule(
        env.db,
        "bestie",
        input({ title: "别人的生日", kind: "birthday", startDate: "2026-11-06" }),
      );
      const items = upcomingSpecialDays(env.db, "default", "2026-11-04");
      assert.deepEqual(
        items.map((i) => [i.title, i.event_date, i.days_left, i.milestone]),
        [
          ["妹妹生日", "2026-11-04", 0, null],
          ["认识纪念日", "2026-11-08", 4, "5 周年 · 第 1827 天"],
          ["第 14 天", "2026-11-18", 14, null],
        ],
      );
      assert.equal(
        specialDayNotes(items)[0],
        "近期生日/纪念日：11-04 妹妹生日（今天）；11-08 认识纪念日（还有 4 天，5 周年 · 第 1827 天）；11-18 第 14 天（还有 14 天）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("没有即将到来的生日/纪念日：栏目整行省略", () => {
    assert.deepEqual(specialDayNotes([]), []);
  });
});
