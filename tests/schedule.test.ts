import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { TZ, todayIso, now } from "../src/time.js";
import { importYear, type HolidayYearPayload } from "../src/core/holiday.js";
import {
  catchupSweep,
  createSchedule,
  fireDue,
  getSchedule,
  materializeSchedule,
  updateSchedule,
} from "../src/modules/schedule/service.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

const day = (offset: number): string => now().plus({ days: offset }).toISODate() as string;

function tool(env: TestEnv, args: Record<string, unknown>) {
  return scheduleTool(args, {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async (profileId, input) => {
        env.published.push({ profileId, input });
        return { id: `n-${env.published.length}`, deduped: false };
      },
      publishGlobal: async () => ({ materialized: 0 }),
    },
  });
}

function occurrenceRows(env: TestEnv, scheduleId: string): Record<string, unknown>[] {
  return env.db
    .prepare("SELECT * FROM occurrences WHERE schedule_id = ? ORDER BY due_at")
    .all(scheduleId) as unknown as Record<string, unknown>[];
}

function envServices(env: TestEnv) {
  return {
    publishProfile: async (profileId: string, input: { kind: string }) => {
      env.published.push({ profileId, input: input as never });
      return { id: `n-${env.published.length}`, deduped: false };
    },
    publishGlobal: async () => ({ materialized: 0 }),
  };
}

describe("schedule 工具：生命周期", () => {
  it("创建待办并物化 occurrence", () => {
    const env = makeTestEnv();
    try {
      const result = tool(env, {
        action: "add",
        title: "写周报",
        date: todayIso(),
        time: "18:00",
        all_day: false,
        remind_offsets: [-30, 0],
      }) as { content: { text: string }[]; isError?: boolean };
      assert.ok(!result.isError);
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as { 已创建: { id: string } };
      const id = payload.已创建.id;
      const rows = occurrenceRows(env, id);
      assert.ok(rows.length >= 2, "一次性日程应物化 2 个偏移");
      assert.ok(rows.every((r) => (r.occurrence_key as string).startsWith(todayIso())));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("add 缺 title / 农历缺循环 / 农历带 workday_filter 均报错", () => {
    const env = makeTestEnv();
    try {
      const noTitle = tool(env, { action: "add", date: todayIso() }) as { isError?: boolean };
      assert.equal(noTitle.isError, true);
      const lunarNoRec = tool(env, {
        action: "add",
        title: "农历",
        calendar: "lunar",
        lunar_month: 5,
        lunar_day: 5,
        recurrence: { freq: "daily", interval: 1 },
      }) as { isError?: boolean };
      assert.equal(lunarNoRec.isError, true);
      const lunarWorkday = tool(env, {
        action: "add",
        title: "农历",
        calendar: "lunar",
        lunar_month: 5,
        lunar_day: 5,
        workday_filter: "workday",
      }) as { isError?: boolean };
      assert.equal(lunarWorkday.isError, true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未传 all_day 时默认为 false：设了 time 就不该显示全天", () => {
    const env = makeTestEnv();
    try {
      const created = JSON.parse(
        (tool(env, { action: "add", title: "默认全天验证", date: todayIso(), time: "17:16" }).content[0]?.text ?? "{}"),
      ) as { 已创建: { id: string; 时间: string } };
      assert.doesNotMatch(created.已创建.时间, /全天/);
      const row = env.db.prepare("SELECT all_day FROM schedules WHERE id = ?").get(created.已创建.id) as {
        all_day: number;
      };
      assert.equal(row.all_day, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update 修改时间并重新物化，version 递增", () => {
    const env = makeTestEnv();
    try {
      const created = JSON.parse(
        (tool(env, { action: "add", title: "测试", date: todayIso(), time: "09:00", all_day: false }).content[0]?.text ?? "{}"),
      ) as { 已创建: { id: string; 版本: number } };
      const id = created.已创建.id;
      const updated = JSON.parse(
        (tool(env, { action: "update", id, time: "10:30", note: "改时间" }).content[0]?.text ?? "{}"),
      ) as { 已更新: { 版本: number; 时间: string; 重复: string } };
      assert.equal(updated.已更新.版本, 2);
      assert.match(updated.已更新.时间, /^10:30/);
      const rows = occurrenceRows(env, id);
      assert.ok(rows.length > 0);
      assert.ok(
        rows.every((r) => (r.occurrence_key as string).includes("T10:30")),
        "旧 occurrence 应被清理并按新时间物化",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("complete 完成待办；已完成的待办不能重新激活", () => {
    const env = makeTestEnv();
    try {
      const created = JSON.parse(
        (tool(env, { action: "add", title: "一次性任务", date: day(1), time: "09:00" }).content[0]?.text ?? "{}"),
      ) as { 已创建: { id: string } };
      const id = created.已创建.id;
      tool(env, { action: "complete", id });
      const row = getSchedule(env.db, "default", id);
      assert.equal(row?.status, "done");
      const rows = occurrenceRows(env, id);
      assert.ok(rows.every((r) => r.status === "done"));
      assert.throws(() => updateSchedule(env.db, "default", id, { status: "active" }), /不能重新激活/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("delete 软删除并清空 occurrence", () => {
    const env = makeTestEnv();
    try {
      const created = JSON.parse(
        (tool(env, { action: "add", title: "要删除", date: day(1) }).content[0]?.text ?? "{}"),
      ) as { 已创建: { id: string } };
      const id = created.已创建.id;
      tool(env, { action: "delete", id });
      assert.equal(getSchedule(env.db, "default", id)?.status, "cancelled");
      assert.equal(occurrenceRows(env, id).length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("农历生日：每年循环，upcoming 可见", () => {
    const env = makeTestEnv();
    try {
      const result = tool(env, {
        action: "add",
        title: "妈妈生日",
        kind: "birthday",
        calendar: "lunar",
        lunar_month: 5,
        lunar_day: 5,
      }) as { content: { text: string }[] };
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as { 已创建: { id: string; 重复: string } };
      assert.equal(payload.已创建.重复, "每年农历5月5日");
      const up = JSON.parse(
        (tool(env, { action: "upcoming", limit: 5 }).content[0]?.text ?? "{}"),
      ) as { 即将到来: { 标题: string }[] };
      assert.ok(up.即将到来.some((i) => i.标题 === "妈妈生日"));
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule 提醒触发", () => {
  it("到点发布提醒并标记 notified；待办重发一次", async () => {
    const env = makeTestEnv();
    try {
      // 事件在今天 00:01（必然已过），10 分钟后重发；手工构造单一 occurrence 保证确定性
      const date = now().toISODate() as string;
      const created = createSchedule(env.db, "default", {
        title: "到期任务",
        kind: "todo",
        calendar: "solar",
        startDate: date,
        time: "00:01",
        allDay: false,
        recurrence: null,
        remindOffsets: [0],
        resendMinutes: 10,
        workdayFilter: "any",
      });
      env.db.prepare("DELETE FROM occurrences WHERE schedule_id = ?").run(created.id);
      const event = DateTime.fromISO(`${date}T00:01`, { zone: TZ }).toUTC().toISO() ?? "";
      env.db
        .prepare(
          "INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status) VALUES (?, ?, ?, ?, 'pending')",
        )
        .run(created.id, `${date}T00:01#0`, event, event);

      await fireDue(env.db, envServices(env), now().plus({ hours: 1 }));
      let rows = occurrenceRows(env, created.id);
      const main = rows.find((r) => r.occurrence_key === `${date}T00:01#0`);
      const resend = rows.find((r) => r.occurrence_key === `${date}T00:01#0:resend`);
      assert.equal(main?.status, "notified");
      assert.ok(resend !== undefined, "应创建重发 occurrence");
      assert.equal(env.published.length, 1);
      assert.equal(env.published[0]?.input.kind, "schedule.reminder");

      await fireDue(env.db, envServices(env), now().plus({ hours: 1 }));
      rows = occurrenceRows(env, created.id);
      assert.equal(rows.find((r) => (r.occurrence_key as string).endsWith(":resend"))?.status, "notified");
      assert.equal(env.published.length, 2);
      const notes = (env.published[1]?.input.blocks.notes ?? []).join(" ");
      assert.match(notes, /强提醒/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("错过的多次提醒只补发最近一次", async () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", {
        title: "每日打卡",
        kind: "todo",
        calendar: "solar",
        startDate: day(-9),
        time: "09:00",
        allDay: false,
        recurrence: { freq: "daily", interval: 1 },
        remindOffsets: [0],
        resendMinutes: 0,
        workdayFilter: "any",
      });
      // 手工构造：10 个已过期 pending（模拟 daemon 停机 10 天）
      env.db.prepare("DELETE FROM occurrences WHERE schedule_id = ?").run(created.id);
      const insert = env.db.prepare(
        "INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status) VALUES (?, ?, ?, ?, 'pending')",
      );
      for (let offset = 10; offset >= 1; offset--) {
        const d = day(-offset);
        const event = DateTime.fromISO(`${d}T09:00`, { zone: TZ }).toUTC().toISO() ?? "";
        insert.run(created.id, `${d}T09:00#0`, event, event);
      }
      catchupSweep(env.db);
      const stale = env.db
        .prepare("SELECT status, COUNT(*) AS n FROM occurrences WHERE schedule_id = ? GROUP BY status")
        .all(created.id) as { status: string; n: number }[];
      const cancelled = stale.find((s) => s.status === "cancelled");
      const pending = stale.find((s) => s.status === "pending");
      assert.equal(cancelled?.n, 9, "只保留最近一次");
      assert.equal(pending?.n, 1);

      await fireDue(env.db, envServices(env), now().plus({ days: 1 }));
      assert.equal(env.published.length, 1);
      const blocks = env.published[0]?.input.blocks as { notes?: string[] };
      assert.match((blocks.notes ?? []).join(" "), /补发/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("workday 过滤：节假日数据缺失时暂停，数据到达后继续", () => {
    const env = makeTestEnv();
    try {
      const target = day(7);
      const created = createSchedule(env.db, "default", {
        title: "工作日任务",
        kind: "todo",
        calendar: "solar",
        startDate: target,
        time: "09:00",
        allDay: false,
        recurrence: { freq: "daily", interval: 1 },
        remindOffsets: [0],
        resendMinutes: 0,
        workdayFilter: "workday",
      });
      assert.equal(occurrenceRows(env, created.id).length, 0, "数据缺失应暂停物化");
      assert.equal(getSchedule(env.db, "default", created.id)?.next_run_at, null);

      const payload: HolidayYearPayload = {
        year: Number(target.slice(0, 4)),
        days: [{ name: "调休", date: target, isOffDay: false }],
      };
      importYear(env.db, payload, "test");
      materializeSchedule(env.db, getSchedule(env.db, "default", created.id) as never);
      const rows = occurrenceRows(env, created.id);
      assert.ok(rows.some((r) => (r.event_at as string).includes(target)), "数据到达后应物化目标日");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("daily 循环省略 interval 也能物化（防止日期推进死循环）", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", {
        title: "缺省间隔",
        kind: "todo",
        calendar: "solar",
        startDate: todayIso(),
        time: "09:00",
        allDay: false,
        recurrence: { freq: "daily" } as never,
        remindOffsets: [0],
        resendMinutes: 0,
        workdayFilter: "any",
      });
      assert.ok(occurrenceRows(env, created.id).length > 0, "缺省 interval 应视为 1 并正常物化");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("count 计的是事件次数，不是提醒行数", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", {
        title: "限次任务",
        kind: "todo",
        calendar: "solar",
        startDate: todayIso(),
        time: "09:00",
        allDay: false,
        recurrence: { freq: "daily", interval: 1, count: 3 },
        remindOffsets: [-30, 0, 30],
        resendMinutes: 0,
        workdayFilter: "any",
      });
      const rows = occurrenceRows(env, created.id);
      const events = new Set(rows.map((r) => r.event_at));
      assert.equal(events.size, 3, "count=3 应物化 3 天（此前按偏移行数计数只物化 1 天）");
      assert.equal(rows.length, 9, "3 个事件 × 3 个提醒偏移");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
