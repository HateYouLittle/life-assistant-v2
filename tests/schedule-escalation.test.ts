import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DateTime } from "luxon";
import { TZ } from "../src/time.js";
import {
  fireDue,
  formatElapsed,
  getSchedule,
  type ScheduleRow,
} from "../src/modules/schedule/service.js";
import { scheduleEscalationInput, scheduleTool } from "../src/modules/schedule/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 阶段 2：deadline（截止型日程 = 带 escalation 的 todo）+ 逾期阶梯升级提醒。
 * 时钟用 node:test mock timers（apis:["Date"]）冻结；触发时刻直接作为 fireDue 的 at 传入。
 */

const D = "2026-09-27";
const EVENT = `${D}T08:00`;

/** 冻结到某个北京时间（Asia/Shanghai） */
function freeze(t: TestContext, date: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(`${date}T07:00:00+08:00`) });
}

const T = (s: string): DateTime => DateTime.fromISO(s, { zone: TZ });
const iso = (s: string): string => T(s).toUTC().toISO() as string;

function envServices(env: TestEnv) {
  return {
    publishProfile: async (profileId: string, input: { kind: string }) => {
      env.published.push({ profileId, input: input as never });
      return { id: `n-${env.published.length}`, deduped: false };
    },
    publishGlobal: async () => ({ materialized: 0 }),
  };
}

function tool(env: TestEnv, args: Record<string, unknown>) {
  return scheduleTool(args, {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: envServices(env),
  });
}

function fire(env: TestEnv, at: string): Promise<number> {
  return fireDue(env.db, envServices(env), T(at));
}

function addDeadline(
  env: TestEnv,
  opts: {
    date?: string;
    time?: string;
    escalation?: number[];
    resendMinutes?: number;
    title?: string;
  } = {},
): string {
  const result = tool(env, {
    action: "add",
    title: opts.title ?? "美团确认",
    date: opts.date ?? D,
    time: opts.time ?? "08:00",
    escalation: opts.escalation ?? [0, 60, 360, 1440],
    ...(opts.resendMinutes === undefined ? {} : { resend_minutes: opts.resendMinutes }),
  }) as { content: { text: string }[]; isError?: boolean };
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return (JSON.parse(result.content[0]?.text ?? "{}") as { 已创建: { id: string } }).已创建.id;
}

function reminders(env: TestEnv) {
  return env.published.filter((p) => p.input.kind === "schedule.reminder");
}

function occRow(env: TestEnv, id: string, key: string) {
  return env.db
    .prepare("SELECT status, due_at FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
    .get(id, key) as { status: string; due_at: string } | undefined;
}

function statusOf(env: TestEnv, id: string, key: string): string | undefined {
  return occRow(env, id, key)?.status;
}

function dueOf(env: TestEnv, id: string, key: string): string | undefined {
  return occRow(env, id, key)?.due_at;
}

function allKeys(env: TestEnv, id: string): string[] {
  return (
    env.db
      .prepare(
        "SELECT occurrence_key FROM occurrences WHERE schedule_id = ? ORDER BY occurrence_key",
      )
      .all(id) as { occurrence_key: string }[]
  ).map((r) => r.occurrence_key);
}

function publishedKeys(env: TestEnv): string[] {
  return reminders(env).map((p) => p.input.dedupeKey ?? "");
}

function noteOf(pub: { input: { blocks?: { notes?: string[] } } }): string | null {
  return pub.input.blocks?.notes?.[0] ?? null;
}

function scheduleStatus(env: TestEnv, id: string): ScheduleRow["status"] | undefined {
  return getSchedule(env.db, "default", id)?.status;
}

describe("schedule escalation：入库与校验", () => {
  it("add 带 escalation → 入库正确，类型为「截止」，list/upcoming 带「升级提醒」", (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const created = JSON.parse(
        (
          tool(env, {
            action: "add",
            title: "美团确认",
            date: D,
            time: "08:00",
            escalation: [0, 60, 360, 1440],
          }) as { content: { text: string }[] }
        ).content[0]?.text ?? "{}",
      ) as { 已创建: { id: string; 类型: string; 升级提醒: number[] } };
      assert.equal(created.已创建.类型, "截止");
      assert.deepEqual(created.已创建.升级提醒, [0, 60, 360, 1440]);

      const row = env.db
        .prepare("SELECT escalation_json FROM schedules WHERE id = ?")
        .get(created.已创建.id) as { escalation_json: string | null };
      assert.equal(row.escalation_json, JSON.stringify([0, 60, 360, 1440]));

      const list = JSON.parse(
        (tool(env, { action: "list" }) as { content: { text: string }[] }).content[0]?.text ?? "{}",
      ) as { 日程: { 类型: string; 升级提醒?: number[] }[] };
      assert.equal(list.日程[0]?.类型, "截止");
      assert.deepEqual(list.日程[0]?.升级提醒, [0, 60, 360, 1440]);

      const up = JSON.parse(
        (tool(env, { action: "upcoming", limit: 5 }) as { content: { text: string }[] }).content[0]
          ?.text ?? "{}",
      ) as { 即将到来: { 类型: string; 升级提醒?: number[] }[] };
      assert.equal(up.即将到来[0]?.类型, "截止");
      assert.deepEqual(up.即将到来[0]?.升级提醒, [0, 60, 360, 1440]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未设 escalation 的日程：类型仍是「待办」，不含升级提醒字段", (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const created = JSON.parse(
        (
          tool(env, { action: "add", title: "普通待办", date: D, time: "08:00" }) as {
            content: { text: string }[];
          }
        ).content[0]?.text ?? "{}",
      ) as { 已创建: { 类型: string; 升级提醒?: number[] } };
      assert.equal(created.已创建.类型, "待办");
      assert.equal(created.已创建.升级提醒, undefined);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("MCP 入口 schema：[] 过校验（清除阶梯），6 个/负数/非整数被拒", () => {
    // 真实 MCP 链路会用 zod safeParse 在进入 handler 之前校验；[] 必须能通过，
    // 否则「update 传 [] 清除阶梯」在真实链路上不可达（只有直接调 handler 的测试能用）。
    assert.equal(scheduleEscalationInput.safeParse([]).success, true, "[] 必须过 schema");
    assert.equal(scheduleEscalationInput.safeParse(undefined).success, true, "未提供");
    assert.equal(scheduleEscalationInput.safeParse([0, 60, 360, 1440]).success, true, "合法阶梯");
    assert.equal(
      scheduleEscalationInput.safeParse([0, 1, 2, 3, 4, 5]).success,
      false,
      "6 个元素超上限",
    );
    assert.equal(scheduleEscalationInput.safeParse([-1, 0]).success, false, "负数");
    assert.equal(scheduleEscalationInput.safeParse([0, 1.5]).success, false, "非整数");
  });

  it("校验：escalation 只允许挂在 kind=todo 上", (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const addBad = tool(env, {
        action: "add",
        title: "生日",
        date: D,
        time: "08:00",
        kind: "birthday",
        escalation: [0, 60],
      }) as { isError?: boolean };
      assert.equal(addBad.isError, true, "birthday 不允许设阶梯");
      assert.equal(
        (env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number }).n,
        0,
        "被拒不应落库",
      );

      const id = addDeadline(env, { escalation: [0, 60] });
      const updateBad = tool(env, { action: "update", id, kind: "birthday" }) as {
        isError?: boolean;
      };
      assert.equal(updateBad.isError, true, "把 todo 改成 birthday 时阶梯不合法");
      assert.equal(getSchedule(env.db, "default", id)?.kind, "todo", "校验失败不应改动落库");
      assert.equal(
        getSchedule(env.db, "default", id)?.escalation_json,
        JSON.stringify([0, 60]),
        "阶梯原样保留",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非法 escalation 一律 fail，且库里不落日程", (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const bad: number[][] = [
        [-1, 0], // 负数
        [0, 43201], // 超上限（30 天 = 43200）
        [0, 60, 30], // 非升序
        [0, 0, 60], // 重复值
        [], // 长度 0
        [0, 1, 2, 3, 4, 5], // 长度 6
        [30, 60], // 首元素非 0：首元素悬空无效
        [60], // 首元素非 0
      ];
      for (const escalation of bad) {
        const result = tool(env, {
          action: "add",
          title: "坏日程",
          date: D,
          time: "08:00",
          escalation,
        }) as { isError?: boolean };
        assert.equal(result.isError, true, `应拒绝 ${JSON.stringify(escalation)}`);
      }
      const count = env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number };
      assert.equal(count.n, 0, "校验失败不应落库");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule escalation：阶梯按时触发", () => {
  it("截止 / +1h / +6h / +24h 各推一次，走完最后一步后 7 天不再新增", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const id = addDeadline(env);
      assert.equal(reminders(env).length, 0);

      await fire(env, `${D}T08:00+08:00`); // 第 0 步：截止时刻
      assert.equal(reminders(env).length, 1);
      assert.equal(statusOf(env, id, `${EVENT}#0`), "notified");
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:1`), "pending");
      assert.equal(dueOf(env, id, `${EVENT}#0#esc:1`), iso(`${D}T09:00+08:00`));

      await fire(env, `${D}T09:00+08:00`); // +1h
      assert.equal(reminders(env).length, 2);
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:1`), "notified");
      assert.equal(dueOf(env, id, `${EVENT}#0#esc:2`), iso(`${D}T14:00+08:00`));

      await fire(env, `${D}T14:00+08:00`); // +6h
      assert.equal(reminders(env).length, 3);
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:2`), "notified");
      assert.equal(dueOf(env, id, `${EVENT}#0#esc:3`), iso(`2026-09-28T08:00+08:00`));

      await fire(env, "2026-09-28T08:00+08:00"); // +24h（最后一步）
      assert.equal(reminders(env).length, 4);
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:3`), "notified");
      assert.equal(occRow(env, id, `${EVENT}#0#esc:4`), undefined, "不应派生超出阶梯的行");

      await fire(env, "2026-10-05T08:00+08:00"); // 再推 7 天
      assert.equal(reminders(env).length, 4, "最后一步之后不再产生新提醒");
      assert.equal(allKeys(env, id).length, 4, "#0 + #esc:1..3");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同一步骤重复 tick 十次不重复发布", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const id = addDeadline(env);
      await fire(env, `${D}T08:00+08:00`);
      assert.equal(reminders(env).length, 1);
      for (let i = 0; i < 10; i++) await fire(env, `${D}T08:00+08:00`);
      assert.equal(reminders(env).length, 1, "同一步骤只推一次");

      await fire(env, `${D}T09:00+08:00`);
      assert.equal(reminders(env).length, 2);
      for (let i = 0; i < 10; i++) await fire(env, `${D}T09:00+08:00`);
      assert.equal(reminders(env).length, 2);
      // 靠 occurrence 行状态（notified）保证，而不是只依赖 dedupeKey
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:1`), "notified");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule escalation：完成即停", () => {
  it("complete 后收敛所有 occurrence，再推时钟也不再重发（反向断言）", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const id = addDeadline(env, { escalation: [0, 60, 360] });
      await fire(env, `${D}T08:00+08:00`);
      assert.equal(reminders(env).length, 1);
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:1`), "pending");

      tool(env, { action: "complete", id });
      assert.equal(scheduleStatus(env, id), "done");
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:1`), "done");

      await fire(env, `${D}T09:00+08:00`);
      await fire(env, "2026-09-28T08:00+08:00");
      await fire(env, "2026-10-05T08:00+08:00");
      assert.equal(reminders(env).length, 1, "完成后即便到点也不重发");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("done 日程上残留的 pending 升级行：fireDue 的 s.status='active' 必须挡住", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      // update status=done 不会收敛 pending occurrence（与 complete 不同路径），
      // 但 fireDue 只挑 active 日程，绝不该按旧排期打扰
      const id = addDeadline(env, { date: "2026-09-28", escalation: [0, 60, 360] });
      await fire(env, "2026-09-28T08:00+08:00");
      assert.equal(reminders(env).length, 1);
      assert.equal(statusOf(env, id, `2026-09-28T08:00#0#esc:1`), "pending");

      tool(env, { action: "update", id, status: "done" });
      assert.equal(scheduleStatus(env, id), "done");
      assert.equal(
        statusOf(env, id, `2026-09-28T08:00#0#esc:1`),
        "pending",
        "update status=done 保留 pending 行，正因如此才需要 active 守卫",
      );

      await fire(env, "2026-09-28T09:00+08:00");
      await fire(env, "2026-09-28T14:00+08:00");
      assert.equal(reminders(env).length, 1, "done 日程不得再推");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule escalation：改动失效", () => {
  it("update 改事件时间后，旧 #esc 行作废、不按旧排期打扰", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const id = addDeadline(env, { escalation: [0, 60] });
      await fire(env, `${D}T08:00+08:00`);
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:1`), "pending");

      tool(env, { action: "update", id, time: "10:00" });
      await fire(env, `${D}T09:00+08:00`);

      assert.equal(statusOf(env, id, `${EVENT}#0#esc:1`), "cancelled");
      assert.ok(
        !publishedKeys(env).includes(`sched:${id}:${EVENT}#0#esc:1`),
        "不得按旧时间点推升级提醒",
      );
      assert.equal(reminders(env).length, 1, "只保留最初的一条截止提醒");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update 缩短 escalation 后，已不存在的步作废", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const id = addDeadline(env, { escalation: [0, 60, 360] });
      await fire(env, `${D}T08:00+08:00`); // #0 → esc:1
      await fire(env, `${D}T09:00+08:00`); // esc:1 → esc:2（pending，due 14:00）
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:2`), "pending");

      tool(env, { action: "update", id, escalation: [0, 60] }); // 3 步改 2 步
      await fire(env, `${D}T14:00+08:00`);

      assert.equal(statusOf(env, id, `${EVENT}#0#esc:2`), "cancelled");
      assert.ok(!publishedKeys(env).includes(`sched:${id}:${EVENT}#0#esc:2`));
      assert.equal(reminders(env).length, 2, "只保留 #0 与 esc:1");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update escalation: [] 清除阶梯：此后按普通待办处理，残留 esc 行作废", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const id = addDeadline(env, { escalation: [0, 60] });
      await fire(env, `${D}T08:00+08:00`);
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:1`), "pending");

      // 走真实 MCP 入口的 schema 校验（safeParse 在 handler 之前跑），再交给 handler；
      // 不能直接塞 [] 绕过 schema，否则测不到「[] 能进 handler」这条真实链路。
      const escalationArg = scheduleEscalationInput.parse([]);
      assert.deepEqual(escalationArg, []);
      const updated = JSON.parse(
        (
          tool(env, { action: "update", id, escalation: escalationArg }) as {
            content: { text: string }[];
          }
        ).content[0]?.text ?? "{}",
      ) as { 已更新: { 类型: string; 升级提醒?: number[] } };
      assert.equal(updated.已更新.类型, "待办");
      assert.equal(updated.已更新.升级提醒, undefined);
      const row = env.db.prepare("SELECT escalation_json FROM schedules WHERE id = ?").get(id) as {
        escalation_json: string | null;
      };
      assert.equal(row.escalation_json, null, "空数组应清除阶梯");

      await fire(env, `${D}T09:00+08:00`);
      assert.equal(statusOf(env, id, `${EVENT}#0#esc:1`), "cancelled");
      assert.equal(reminders(env).length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule escalation：逾期文案", () => {
  it("分 / 小时 / 天 按单位渲染，且不出现「0 天 / 0 小时 / 0 分」", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      // 直接校验格式化函数
      const eventIso = iso(`${EVENT}+08:00`);
      assert.equal(formatElapsed(eventIso, T(`${D}T08:03+08:00`)), "3 分");
      assert.equal(formatElapsed(eventIso, T(`${D}T09:03+08:00`)), "1 小时 3 分");
      assert.equal(formatElapsed(eventIso, T("2026-09-28T08:00+08:00")), "1 天");
      assert.equal(formatElapsed(eventIso, T("2026-09-28T10:00+08:00")), "1 天 2 小时");

      // 经由 fireDue 的 note 渲染
      const id = addDeadline(env, { escalation: [0, 3, 63, 1560] });
      await fire(env, `${D}T08:00+08:00`); // #0
      await fire(env, `${D}T08:03+08:00`); // esc:1 → 3 分
      await fire(env, `${D}T09:03+08:00`); // esc:2 → 1 小时 3 分
      await fire(env, "2026-09-28T10:00+08:00"); // esc:3 → 1 天 2 小时

      const notes = reminders(env).map(noteOf);
      assert.match(notes[1] ?? "", /截止已过 3 分，仍未完成/);
      assert.match(notes[2] ?? "", /截止已过 1 小时 3 分，仍未完成/);
      assert.match(notes[3] ?? "", /截止已过 1 天 2 小时，仍未完成/);
      for (const note of notes) {
        assert.doesNotMatch(note ?? "", /0 天|0 小时|0 分/, `不该出现空单位：${note ?? ""}`);
      }
      assert.equal(allKeys(env, id).length, 4);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule escalation：与 resend_minutes 互斥", () => {
  it("同时设置时只按阶梯走，不产生 #resend 行", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const id = addDeadline(env, { escalation: [0, 60], resendMinutes: 30 });
      await fire(env, `${D}T08:00+08:00`);

      assert.ok(
        !allKeys(env, id).some((k) => k.endsWith(":resend")),
        "设置 escalation 后不应生成 #resend 行",
      );
      assert.ok(allKeys(env, id).includes(`${EVENT}#0#esc:1`));

      await fire(env, `${D}T08:30+08:00`); // resend_minutes 的时点：阶梯忽略它
      assert.equal(reminders(env).length, 1, "08:30 不该有到点重发");

      await fire(env, `${D}T09:00+08:00`);
      assert.equal(reminders(env).length, 2);
      assert.ok(!allKeys(env, id).some((k) => k.endsWith(":resend")));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("没有 escalation 的待办仍走 resend_minutes（回归，行为逐字节不变）", async (t) => {
    freeze(t, "2026-09-27");
    const env = makeTestEnv();
    try {
      const result = tool(env, {
        action: "add",
        title: "普通重发任务",
        date: D,
        time: "08:00",
        resend_minutes: 30,
      }) as { content: { text: string }[] };
      const id = (JSON.parse(result.content[0]?.text ?? "{}") as { 已创建: { id: string } }).已创建
        .id;

      await fire(env, `${D}T08:00+08:00`);
      assert.equal(reminders(env).length, 1);
      assert.ok(
        allKeys(env, id).some((k) => k.endsWith(":resend")),
        "无 escalation 时应照常派生 #resend",
      );
      await fire(env, `${D}T08:30+08:00`);
      assert.equal(reminders(env).length, 2);
      assert.match(noteOf(reminders(env)[1] as never) ?? "", /强提醒/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
