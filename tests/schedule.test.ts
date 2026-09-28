import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { TZ, todayIso, now, instantToLocalDate } from "../src/time.js";
import { importYear, type HolidayYearPayload } from "../src/core/holiday.js";
import {
  catchupSweep,
  completeSchedule,
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
        tool(env, { action: "add", title: "默认全天验证", date: todayIso(), time: "17:16" })
          .content[0]?.text ?? "{}",
      ) as { 已创建: { id: string; 时间: string } };
      assert.doesNotMatch(created.已创建.时间, /全天/);
      const row = env.db
        .prepare("SELECT all_day FROM schedules WHERE id = ?")
        .get(created.已创建.id) as {
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
        tool(env, { action: "add", title: "测试", date: todayIso(), time: "09:00", all_day: false })
          .content[0]?.text ?? "{}",
      ) as { 已创建: { id: string; 版本: number } };
      const id = created.已创建.id;
      const updated = JSON.parse(
        tool(env, { action: "update", id, time: "10:30", note: "改时间" }).content[0]?.text ?? "{}",
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
        tool(env, { action: "add", title: "一次性任务", date: day(1), time: "09:00" }).content[0]
          ?.text ?? "{}",
      ) as { 已创建: { id: string } };
      const id = created.已创建.id;
      tool(env, { action: "complete", id });
      const row = getSchedule(env.db, "default", id);
      assert.equal(row?.status, "done");
      const rows = occurrenceRows(env, id);
      assert.ok(rows.every((r) => r.status === "done"));
      assert.throws(
        () => updateSchedule(env.db, "default", id, { status: "active" }),
        /不能重新激活/,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("delete 软删除并清空 occurrence", () => {
    const env = makeTestEnv();
    try {
      const created = JSON.parse(
        tool(env, { action: "add", title: "要删除", date: day(1) }).content[0]?.text ?? "{}",
      ) as { 已创建: { id: string } };
      const id = created.已创建.id;
      tool(env, { action: "delete", id });
      assert.equal(getSchedule(env.db, "default", id)?.status, "cancelled");
      assert.equal(occurrenceRows(env, id).length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("农历生日：每年循环，重复描述正确；下一次发生受物化前瞻约束", () => {
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
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
        已创建: { id: string; 重复: string };
      };
      assert.equal(payload.已创建.重复, "每年农历5月5日");
      // 农历 5/5 的下一次发生通常落在 62 天物化窗口之外。首条豁免保证「下一条」仍可见：
      // 该日程初始没有任何 pending，因此恰好物化 1 条（窗口内正常物化，窗口外由豁免补出），
      // 且越过物化前瞻的至多 1 条。
      const rows = occurrenceRows(env, payload.已创建.id);
      const horizon = now().plus({ days: 63 });
      assert.equal(rows.length, 1, "农历生日应恰好物化 1 条 occurrence");
      assert.ok(
        rows.filter((r) => DateTime.fromISO(r.event_at as string) > horizon).length <= 1,
        "越过物化前瞻的 occurrence 至多 1 条（首条豁免）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("生日 upcoming：窗口内的下一次发生仍可见", () => {
    const env = makeTestEnv();
    try {
      tool(env, {
        action: "add",
        title: "朋友生日",
        kind: "birthday",
        date: day(30),
        time: "09:00",
      });
      const up = JSON.parse(
        tool(env, { action: "upcoming", limit: 5 }).content[0]?.text ?? "{}",
      ) as { 即将到来: { 标题: string }[] };
      assert.ok(up.即将到来.some((i) => i.标题 === "朋友生日"));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("list/upcoming 提醒时刻附本地时区文本，原 UTC ISO 键保留不动", () => {
    const env = makeTestEnv();
    try {
      const d = day(1);
      const created = JSON.parse(
        tool(env, { action: "add", title: "本地时刻", date: d, time: "08:00" }).content[0]?.text ??
          "{}",
      ) as { 已创建: { 下次提醒: string | null; "下次提醒(本地)": string | null } };
      assert.ok((created.已创建.下次提醒 ?? "").endsWith("Z"), "原 UTC ISO 键不得改动");
      assert.equal(
        created.已创建["下次提醒(本地)"],
        `${d} 08:00`,
        "本地文本应为 Asia/Shanghai 时刻",
      );

      const list = JSON.parse(tool(env, { action: "list" }).content[0]?.text ?? "{}") as {
        日程: { 下次提醒: string | null; "下次提醒(本地)": string | null }[];
      };
      assert.equal(list.日程[0]?.["下次提醒(本地)"], `${d} 08:00`);

      const up = JSON.parse(tool(env, { action: "upcoming" }).content[0]?.text ?? "{}") as {
        即将到来: { 提醒时间: string; "提醒时间(本地)": string }[];
      };
      assert.ok((up.即将到来[0]?.提醒时间 ?? "").endsWith("Z"), "原 UTC ISO 键不得改动");
      assert.equal(up.即将到来[0]?.["提醒时间(本地)"], `${d} 08:00`);
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
      assert.equal(
        rows.find((r) => (r.occurrence_key as string).endsWith(":resend"))?.status,
        "notified",
      );
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
        .prepare(
          "SELECT status, COUNT(*) AS n FROM occurrences WHERE schedule_id = ? GROUP BY status",
        )
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
      assert.ok(
        rows.some((r) => (r.event_at as string).includes(target)),
        "数据到达后应物化目标日",
      );
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

  it("count 是硬上限：漏触发被取消的 occurrence 仍占次数", () => {
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
        remindOffsets: [0],
        resendMinutes: 0,
        workdayFilter: "any",
      });
      const rows = occurrenceRows(env, created.id);
      assert.equal(new Set(rows.map((r) => r.event_at)).size, 3);
      // 模拟多日停机：3 条 pending 全部过期且 due_at 互不相同
      rows.forEach((r, i) => {
        const due = now()
          .minus({ days: 10 - i })
          .toUTC()
          .toISO();
        env.db
          .prepare("UPDATE occurrences SET due_at = ? WHERE schedule_id = ? AND occurrence_key = ?")
          .run(due, created.id, r.occurrence_key as string);
      });
      catchupSweep(env.db);
      const cancelled = env.db
        .prepare(
          "SELECT COUNT(*) AS n FROM occurrences WHERE schedule_id = ? AND status = 'cancelled'",
        )
        .get(created.id) as { n: number };
      assert.ok(cancelled.n > 0, "构造前提：catchupSweep 应取消部分漏触发行");

      materializeSchedule(env.db, getSchedule(env.db, "default", created.id) as never);
      const after = occurrenceRows(env, created.id);
      assert.equal(
        new Set(after.map((r) => r.event_at)).size,
        3,
        "count=3 是硬上限：被取消的漏触发事件也占次数，不得补出第 4 个事件",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule 工具：weekly 空 byweekday 防护", () => {
  it("add 传 byweekday:[] 直接报错，不进入物化（曾导致进程假死）", () => {
    const env = makeTestEnv();
    try {
      const result = tool(env, {
        action: "add",
        title: "空星期周报",
        date: todayIso(),
        time: "09:00",
        recurrence: { freq: "weekly", interval: 1, byweekday: [] },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /byweekday/);
      const count = env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number };
      assert.equal(count.n, 0, "校验失败不应落库");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update 传 byweekday:[] 同样被拒绝", () => {
    const env = makeTestEnv();
    try {
      const created = tool(env, {
        action: "add",
        title: "正常周报",
        date: todayIso(),
        time: "09:00",
      });
      assert.equal(created.isError, undefined);
      const id = (JSON.parse(created.content[0]?.text ?? "{}") as { 已创建: { id: string } }).已创建
        .id;
      const result = tool(env, {
        action: "update",
        id,
        recurrence: { freq: "weekly", interval: 1, byweekday: [] },
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /byweekday/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("省略 byweekday 的 weekly 正常可用（回退到开始日期的星期）", () => {
    const env = makeTestEnv();
    try {
      const result = tool(env, {
        action: "add",
        title: "每周例会",
        date: todayIso(),
        time: "09:00",
        recurrence: { freq: "weekly", interval: 1 },
      });
      assert.equal(result.isError, undefined);
      const count = env.db.prepare("SELECT COUNT(*) AS n FROM occurrences").get() as { n: number };
      assert.ok(count.n > 0, "省略 byweekday 应正常物化 occurrence");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule 工具：更新不静默丢提醒", () => {
  const keysOf = (env: TestEnv, id: string): string[] =>
    (
      env.db
        .prepare(
          "SELECT occurrence_key FROM occurrences WHERE schedule_id = ? ORDER BY occurrence_key",
        )
        .all(id) as {
        occurrence_key: string;
      }[]
    ).map((r) => r.occurrence_key);

  function addDaily(env: TestEnv, extra: Record<string, unknown> = {}) {
    const created = createSchedule(env.db, "default", {
      title: "日常提醒",
      kind: "todo",
      calendar: "solar",
      startDate: todayIso(),
      time: "23:50",
      allDay: false,
      recurrence: { freq: "daily", interval: 1 },
      remindOffsets: [0],
      resendMinutes: 0,
      workdayFilter: "any",
      ...extra,
    });
    return created;
  }

  it("新增提醒偏移会真正补上新的提醒行（此前被 #0 存在性检查吞掉）", () => {
    const env = makeTestEnv();
    try {
      const created = addDaily(env);
      assert.ok(keysOf(env, created.id).some((k) => k.endsWith("#0")));
      assert.ok(!keysOf(env, created.id).some((k) => k.endsWith("#1")));

      updateSchedule(env.db, "default", created.id, { remindOffsets: [-30, 0] });
      assert.ok(
        keysOf(env, created.id).some((k) => k.endsWith("#1")),
        `新增偏移必须物化，实际 ${JSON.stringify(keysOf(env, created.id))}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("只改标题不动提醒：pending occurrence 全部保留", () => {
    const env = makeTestEnv();
    try {
      const created = addDaily(env);
      const before = keysOf(env, created.id);
      assert.ok(before.length > 0);
      updateSchedule(env.db, "default", created.id, { title: "改个名字" });
      assert.deepEqual(keysOf(env, created.id), before, "改标题不应删除任何 pending 提醒");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同事件部分提醒已发出：更新不丢尚未触发的那条，新增偏移也补到当前事件", async () => {
    const env = makeTestEnv();
    try {
      const event = now().plus({ minutes: 20 });
      const keyBase = `${event.toISODate()}T${event.toFormat("HH:mm")}`;
      const created = createSchedule(env.db, "default", {
        title: "部分触发",
        kind: "todo",
        calendar: "solar",
        startDate: event.toISODate() as string,
        time: event.toFormat("HH:mm"),
        allDay: false,
        recurrence: null,
        remindOffsets: [-30, 0],
        resendMinutes: 0,
        workdayFilter: "any",
      });
      // 提前 30 分钟那条已过（#0 已发出），正点那条未到（#1 pending）
      await fireDue(env.db, envServices(env), now());
      const statusOf = (key: string): unknown =>
        occurrenceRows(env, created.id).find((r) => r.occurrence_key === key)?.status;
      assert.equal(statusOf(`${keyBase}#0`), "notified");
      assert.equal(statusOf(`${keyBase}#1`), "pending");

      updateSchedule(env.db, "default", created.id, { title: "改标题" });
      assert.equal(
        statusOf(`${keyBase}#1`),
        "pending",
        "同事件尚未触发的提醒不能因 update 被删除（曾整条丢失）",
      );

      updateSchedule(env.db, "default", created.id, { remindOffsets: [-30, 0, 30] });
      assert.equal(
        statusOf(`${keyBase}#2`),
        "pending",
        "新增偏移应补到当前事件，而不是只从下一次发生开始",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("已排定的 :resend 强提醒在编辑后仍然存在", () => {
    const env = makeTestEnv();
    try {
      const created = addDaily(env, { resendMinutes: 30, time: "00:01" });
      env.db
        .prepare("UPDATE occurrences SET status = 'notified' WHERE schedule_id = ?")
        .run(created.id);
      env.db
        .prepare(
          `INSERT OR IGNORE INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
           VALUES (?, ?, ?, ?, 'pending')`,
        )
        .run(
          created.id,
          `${todayIso()}T00:01#0:resend`,
          new Date().toISOString(),
          new Date(Date.now() + 60_000).toISOString(),
        );
      assert.ok(keysOf(env, created.id).some((k) => k.endsWith(":resend")));

      updateSchedule(env.db, "default", created.id, { title: "编辑后" });
      assert.ok(
        keysOf(env, created.id).some((k) => k.endsWith(":resend")),
        "pending :resend 行不应被 update 清掉",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  describe("强提醒（:resend）与当前排期一致", () => {
    /**
     * 造出「主提醒已发出、强提醒待触发」的现场：事件定在 2 小时前（必然已过期），
     * reminder 行标 notified，:resend 行按 resendMinutes 排定。
     */
    function seedOverdueResend(env: TestEnv, resendMinutes: number) {
      const at = now().minus({ hours: 2 });
      const date = at.toISODate() as string;
      const time = at.toFormat("HH:mm");
      const created = createSchedule(env.db, "default", {
        title: "强提醒任务",
        kind: "todo",
        calendar: "solar",
        startDate: date,
        time,
        allDay: false,
        recurrence: { freq: "daily", interval: 1 },
        remindOffsets: [0],
        resendMinutes,
        workdayFilter: "any",
      });
      env.db.prepare("DELETE FROM occurrences WHERE schedule_id = ?").run(created.id);
      const event = DateTime.fromISO(`${date}T${time}`, { zone: TZ }).toUTC().toISO() ?? "";
      const insert = env.db.prepare(
        "INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run(created.id, `${date}T${time}#0`, event, event, "notified");
      insert.run(
        created.id,
        `${date}T${time}#0:resend`,
        event,
        DateTime.fromISO(event).plus({ minutes: resendMinutes }).toUTC().toISO() ?? event,
        "pending",
      );
      return { created, date, time, event, resendKey: `${date}T${time}#0:resend` };
    }

    it("改过提醒时刻后，旧强提醒作废、不按旧时间点推送", async () => {
      const env = makeTestEnv();
      try {
        const { created, resendKey, date, time } = seedOverdueResend(env, 30);
        const newTime = DateTime.fromISO(`${date}T${time}`, { zone: TZ })
          .plus({ hours: 3 })
          .toFormat("HH:mm");
        updateSchedule(env.db, "default", created.id, { time: newTime });

        await fireDue(env.db, envServices(env), now());
        const row = occurrenceRows(env, created.id).find((r) => r.occurrence_key === resendKey);
        assert.equal(row?.status, "cancelled", "旧时刻的强提醒应作废");
        assert.ok(
          !env.published.some((p) => p.input.dedupeKey === `sched:${created.id}:${resendKey}`),
          "不该按旧时间点推强提醒",
        );
      } finally {
        cleanupTestEnv(env);
      }
    });

    it("resend_minutes 归零后，已排定的强提醒作废", async () => {
      const env = makeTestEnv();
      try {
        const { created, resendKey } = seedOverdueResend(env, 30);
        updateSchedule(env.db, "default", created.id, { resendMinutes: 0 });
        await fireDue(env.db, envServices(env), now());
        const row = occurrenceRows(env, created.id).find((r) => r.occurrence_key === resendKey);
        assert.equal(row?.status, "cancelled");
        assert.ok(
          !env.published.some((p) => p.input.dedupeKey === `sched:${created.id}:${resendKey}`),
        );
      } finally {
        cleanupTestEnv(env);
      }
    });

    it("resend_minutes 调大后按新时刻触发，未到点不打扰", async () => {
      const env = makeTestEnv();
      try {
        const { created, event, resendKey } = seedOverdueResend(env, 30);
        updateSchedule(env.db, "default", created.id, { resendMinutes: 240 });

        // 校正在触发前完成（fireDue 是唯一判定点）：先按 now() 走一轮
        await fireDue(env.db, envServices(env), now());
        const expected = DateTime.fromISO(event).plus({ minutes: 240 }).toUTC().toISO();
        const row = occurrenceRows(env, created.id).find((r) => r.occurrence_key === resendKey);
        assert.equal(row?.due_at, expected, "due_at 应校正为 event_at + 新的 resend_minutes");
        assert.equal(row?.status, "pending");
        assert.ok(
          !env.published.some((p) => p.input.dedupeKey === `sched:${created.id}:${resendKey}`),
          "校正后还没到点，不该提前推",
        );

        await fireDue(env.db, envServices(env), now().plus({ hours: 3 }));
        assert.ok(
          env.published.some((p) => p.input.dedupeKey === `sched:${created.id}:${resendKey}`),
          "到达新时刻后应照常推送",
        );
      } finally {
        cleanupTestEnv(env);
      }
    });

    it("强提醒以事件时刻为基准，不被提醒偏移带偏", async () => {
      const env = makeTestEnv();
      try {
        const { created, event, time } = seedOverdueResend(env, 30);
        // 模拟 offsets[0] = -60：主提醒行比事件早一小时到点
        const early = DateTime.fromISO(event).minus({ minutes: 60 }).toUTC().toISO() ?? event;
        env.db
          .prepare("UPDATE occurrences SET due_at = ? WHERE schedule_id = ? AND occurrence_key = ?")
          .run(early, created.id, `${now().minus({ hours: 2 }).toISODate()}T${time}#0`);

        await fireDue(env.db, envServices(env), now());
        const resend = occurrenceRows(env, created.id).find((r) =>
          (r.occurrence_key as string).endsWith(":resend"),
        );
        const gapMinutes = DateTime.fromISO(resend?.due_at as string).diff(
          DateTime.fromISO(resend?.event_at as string),
          "minutes",
        ).minutes;
        assert.equal(Math.round(gapMinutes), 30, "重发基准应是事件时刻，而不是被偏移挪过的 due_at");
      } finally {
        cleanupTestEnv(env);
      }
    });
  });

  it("物化后存在 (schedule_id, status) 索引", () => {
    const env = makeTestEnv();
    try {
      const created = addDaily(env);
      materializeSchedule(
        env.db,
        getSchedule(env.db, "default", created.id) as Parameters<typeof materializeSchedule>[1],
      );
      const idx = env.db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_occurrences_schedule_status'",
        )
        .get();
      assert.ok(idx !== undefined, "应创建 idx_occurrences_schedule_status");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule update：rewind 只作用于进行中的最近事件", () => {
  function onceInput(time: string) {
    return {
      title: "时点任务",
      kind: "todo" as const,
      calendar: "solar" as const,
      startDate: todayIso(),
      time,
      allDay: false,
      recurrence: null,
      remindOffsets: [0],
      resendMinutes: 0,
      workdayFilter: "any" as const,
    };
  }

  it("count 已耗尽：改 time 不会造出新事件", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", {
        ...onceInput("09:00"),
        recurrence: { freq: "daily", interval: 1, count: 3 },
      });
      env.db
        .prepare("UPDATE occurrences SET status = 'notified' WHERE schedule_id = ?")
        .run(created.id);
      const before = new Set(occurrenceRows(env, created.id).map((r) => r.event_at));
      assert.equal(before.size, 3);

      updateSchedule(env.db, "default", created.id, { time: "10:00" });
      const after = new Set(occurrenceRows(env, created.id).map((r) => r.event_at));
      assert.equal(after.size, 3, "已耗尽 count 的日程不得因改时间多出第 4 个事件");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("用 occurrence_key 完成的事件：改 time 不会复活提醒", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", onceInput("09:00"));
      const key = occurrenceRows(env, created.id)[0]?.occurrence_key as string;
      completeSchedule(env.db, "default", created.id, key);
      const before = occurrenceRows(env, created.id);

      updateSchedule(env.db, "default", created.id, { time: "10:00" });
      const after = occurrenceRows(env, created.id);
      assert.equal(after.length, before.length, "不得为已完成的事件重建新 key");
      assert.ok(
        after.every((r) => r.status === "done"),
        `已完成的事件不得被重新物化，实际 ${JSON.stringify(after)}`,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("已全部提醒的事件：新增偏移不会为过去的事件补发", () => {
    const env = makeTestEnv();
    try {
      const past = now().minus({ hours: 2 });
      const created = createSchedule(env.db, "default", {
        ...onceInput(past.toFormat("HH:mm")),
        startDate: past.toISODate() as string,
      });
      env.db
        .prepare("UPDATE occurrences SET status = 'notified' WHERE schedule_id = ?")
        .run(created.id);
      const before = occurrenceRows(env, created.id).map((r) => r.occurrence_key);

      updateSchedule(env.db, "default", created.id, { remindOffsets: [-30, 0] });
      const after = occurrenceRows(env, created.id).map((r) => r.occurrence_key);
      assert.deepEqual(after, before, "全通知的事件不得因新增偏移被重新物化");
    } finally {
      cleanupTestEnv(env);
    }
  });

  /** count=3 daily：前两个事件全 notified，最近事件 #0 notified + #1 pending（进行中） */
  function seedLiveLastEvent(env: TestEnv) {
    const created = createSchedule(env.db, "default", {
      ...onceInput("09:00"),
      recurrence: { freq: "daily", interval: 1, count: 3 },
      remindOffsets: [-30, 0],
    });
    env.db
      .prepare("UPDATE occurrences SET status = 'notified' WHERE schedule_id = ?")
      .run(created.id);
    const lastAt = (
      env.db
        .prepare("SELECT MAX(event_at) AS m FROM occurrences WHERE schedule_id = ?")
        .get(created.id) as { m: string }
    ).m;
    env.db
      .prepare(
        "UPDATE occurrences SET status = 'pending' WHERE schedule_id = ? AND event_at = ? AND substr(occurrence_key, -2) = '#1'",
      )
      .run(created.id, lastAt);
    return { created };
  }

  it("count 已达上限：改规则不会借 rewind 多出第 4 个日期", () => {
    const env = makeTestEnv();
    try {
      const { created } = seedLiveLastEvent(env);
      updateSchedule(env.db, "default", created.id, {
        recurrence: { freq: "weekly", interval: 1, count: 3 },
      });
      const dates = new Set(
        occurrenceRows(env, created.id).map((r) => instantToLocalDate(String(r.event_at))),
      );
      assert.equal(dates.size, 3, "count=3 是硬上限，改规则不得新增第 4 个日期");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("count 日程改 time：同一日历日不计成新事件，也不会多出下一天", () => {
    const env = makeTestEnv();
    try {
      const { created } = seedLiveLastEvent(env);
      // 有意行为：进行中的事件允许当天改点——新时刻的提醒会为当天重建，
      // 但同一日历日不算新事件，也不会借 rewind 推出第 4 个日期。
      updateSchedule(env.db, "default", created.id, { time: "10:00" });
      const dates = (): Set<string> =>
        new Set(occurrenceRows(env, created.id).map((r) => instantToLocalDate(String(r.event_at))));
      assert.equal(dates().size, 3, "同一日历日改 time 不得计成新事件");
      materializeSchedule(env.db, getSchedule(env.db, "default", created.id) as never);
      assert.equal(dates().size, 3, "后续物化也不得推出第 4 个日期");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("只有派生行 pending：update 不触发回退重物化（不为已通知事件补行）", async () => {
    const env = makeTestEnv();
    try {
      const event = now().minus({ minutes: 5 });
      const created = createSchedule(env.db, "default", {
        ...onceInput(event.toFormat("HH:mm")),
        startDate: event.toISODate() as string,
        resendMinutes: 30,
      });
      // #0 触发 → 派生 :resend（事件 +30 分钟，尚未到点）
      await fireDue(env.db, envServices(env), now());
      const before = occurrenceRows(env, created.id).map((r) => r.occurrence_key);
      assert.equal(
        before.filter((k) => String(k).endsWith(":resend")).length,
        1,
        "构造前提：存在一条 pending 的派生行",
      );

      updateSchedule(env.db, "default", created.id, { remindOffsets: [-30, 0] });
      const after = occurrenceRows(env, created.id).map((r) => r.occurrence_key);
      assert.deepEqual(after, before, "派生行 pending 不该触发 rewind，不得为已通知事件补行");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule 创建/更新的原子性", () => {
  function dailyInput(title: string) {
    return {
      title,
      kind: "todo" as const,
      calendar: "solar" as const,
      startDate: todayIso(),
      time: "09:00",
      allDay: false,
      recurrence: { freq: "daily" as const, interval: 1 },
      remindOffsets: [0],
      resendMinutes: 0,
      workdayFilter: "any" as const,
    };
  }

  const blockOccurrenceInserts = (env: TestEnv): void => {
    env.db.exec(
      "CREATE TRIGGER boom BEFORE INSERT ON occurrences BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
  };

  it("物化失败时创建整体回滚，不留半成品日程", () => {
    const env = makeTestEnv();
    try {
      blockOccurrenceInserts(env);
      assert.throws(() => createSchedule(env.db, "default", dailyInput("半成品")), /boom/);
      const count = env.db
        .prepare("SELECT COUNT(*) AS n FROM schedules WHERE title = ?")
        .get("半成品") as { n: number };
      assert.equal(count.n, 0, "物化失败必须回滚插入，否则用户重试会造出第二条同名日程");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("物化失败时更新整体回滚，不留「报错但改动已生效」", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", dailyInput("原标题"));
      blockOccurrenceInserts(env);
      assert.throws(() => updateSchedule(env.db, "default", created.id, { title: "改坏" }), /boom/);
      assert.equal(getSchedule(env.db, "default", created.id)?.title, "原标题");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
