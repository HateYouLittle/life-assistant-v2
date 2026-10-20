import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { localToInstant, nowIso } from "../src/time.js";
import { agendaForDate } from "../src/modules/schedule/service.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { ensureProfile } from "../src/core/settings.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 简报议程 helper（agendaForDate）——天气模块的每日简报直接 import，字段名是契约。
 * 冻结时钟只是为了物化窗口可预期；查询日期显式传入。
 */

const D = "2026-10-20";
const PREV = "2026-10-17";

function freeze(t: TestContext, at: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(at) });
}

function tool(env: TestEnv, args: Record<string, unknown>, profileId = "default") {
  return scheduleTool(args, {
    profileId,
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

function payload<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0]?.text ?? "{}") as T;
}

function add(
  env: TestEnv,
  over: {
    title: string;
    date?: string;
    time?: string;
    all_day?: boolean;
    kind?: string;
    remind_offsets?: number[];
    profileId?: string;
  },
): string {
  const result = tool(
    env,
    {
      action: "add",
      title: over.title,
      date: over.date ?? D,
      time: over.time ?? "09:00",
      ...(over.all_day === undefined ? {} : { all_day: over.all_day }),
      ...(over.kind === undefined ? {} : { kind: over.kind }),
      ...(over.remind_offsets === undefined ? {} : { remind_offsets: over.remind_offsets }),
    },
    over.profileId ?? "default",
  ) as { content: { text: string }[]; isError?: boolean };
  assert.notEqual(result.isError, true, result.content[0]?.text);
  return payload<{ 已创建: { id: string } }>(result).已创建.id;
}

/** 直接插一条历史日程 + 一条 occurrence（物化窗口只会产出「现在之后」的事件，逾期只能这样造） */
function insertPastOccurrence(
  env: TestEnv,
  id: string,
  over: { title: string; date: string; time: string; status?: string; profileId?: string },
): void {
  const ts = nowIso();
  env.db
    .prepare(
      `INSERT INTO schedules (id, profile_id, title, kind, calendar, start_date, time, all_day,
         created_at, updated_at)
       VALUES (?, ?, ?, 'todo', 'solar', ?, ?, 0, ?, ?)`,
    )
    .run(id, over.profileId ?? "default", over.title, over.date, over.time, ts, ts);
  const eventAt = localToInstant(over.date, over.time);
  env.db
    .prepare(
      `INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(id, `${over.date}T${over.time}#0`, eventAt, eventAt, over.status ?? "pending");
}

function setStatus(env: TestEnv, id: string, key: string, status: string): void {
  env.db
    .prepare("UPDATE occurrences SET status = ? WHERE schedule_id = ? AND occurrence_key = ?")
    .run(status, id, key);
}

describe("agendaForDate：简报议程", () => {
  it("当天条目按时刻升序，同一事件的多条提醒行只出现一次", (t) => {
    freeze(t, `${D}T07:00:00+08:00`);
    const env = makeTestEnv();
    try {
      add(env, { title: "晚间例行", time: "18:00" });
      add(env, { title: "早间同步", time: "09:00", remind_offsets: [-30, 0] });
      add(env, { title: "全天事项", time: "12:00", all_day: true });
      // 两个不同日程同一时刻：各自必须单独成条（去重只按「同一日程的事件前缀」）
      add(env, { title: "并行事项", time: "09:00" });

      const items = agendaForDate(env.db, "default", D);
      assert.deepEqual(
        items.map((item) => item.time),
        ["09:00", "09:00", "12:00", "18:00"],
      );
      // 同一时刻不同日程的先后由 SQL 决定，不做断言；只确认两条都在
      assert.deepEqual(
        items
          .slice(0, 2)
          .map((item) => item.title)
          .sort(),
        ["并行事项", "早间同步"],
      );
      assert.deepEqual(
        items.slice(2).map((item) => item.title),
        ["全天事项", "晚间例行"],
      );
      const all = items.find((item) => item.title === "全天事项");
      assert.equal(all?.all_day, true, "全天事件必须带 all_day 标记");
      assert.equal(all?.kind, "todo");
      assert.ok(items.every((item) => item.overdue === false));
      assert.ok(items.every((item) => item.event_date === D));
      // occurrence_key 可直接用于 complete/snooze/skip
      assert.match(items[0]?.occurrence_key ?? "", /^2026-10-20T09:00#\d$/);
      assert.match(items[0]?.schedule_id ?? "", /^[0-9a-f]{8}$/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("逾期条目排在前面，overdue=true；已完成/已取消不出现，notified 仍算待办", (t) => {
    freeze(t, `${D}T07:00:00+08:00`);
    const env = makeTestEnv();
    try {
      insertPastOccurrence(env, "past0001", {
        title: "逾期三天",
        date: PREV,
        time: "09:00",
      });
      const todayId = add(env, { title: "今天要办", time: "20:00" });
      setStatus(env, todayId, `${D}T20:00#0`, "notified");
      const completedId = add(env, { title: "今天已办", time: "08:00" });
      tool(env, { action: "complete", id: completedId, occurrence_key: `${D}T08:00#0` });
      const cancelledId = add(env, { title: "今天跳过", time: "10:00" });
      setStatus(env, cancelledId, `${D}T10:00#0`, "cancelled");

      const items = agendaForDate(env.db, "default", D);
      assert.deepEqual(
        items.map((item) => item.title),
        ["逾期三天", "今天要办"],
        "逾期在前；已完成/已取消不出现；notified 属于未完成",
      );
      assert.equal(items[0]?.overdue, true);
      assert.equal(items[0]?.event_date, PREV);
      assert.equal(items[0]?.time, "09:00");
      assert.equal(items[1]?.overdue, false);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("只包含事件本地日期 <= 查询日的条目（明天的不出现）", (t) => {
    freeze(t, `${D}T07:00:00+08:00`);
    const env = makeTestEnv();
    try {
      add(env, { title: "明天的事", date: "2026-10-21", time: "09:00" });
      add(env, { title: "今天的事", time: "15:00" });
      assert.deepEqual(
        agendaForDate(env.db, "default", D).map((item) => item.title),
        ["今天的事"],
      );
      // 查明天时，今天仍未完成的 pending 属于「逾期」而不是消失（agenda 含逾期未完成）
      const tomorrow = agendaForDate(env.db, "default", "2026-10-21");
      assert.deepEqual(
        tomorrow.map((item) => [item.title, item.overdue]),
        [
          ["今天的事", true],
          ["明天的事", false],
        ],
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("跨 Profile 隔离：只返回该 Profile 的条目", (t) => {
    freeze(t, `${D}T07:00:00+08:00`);
    const env = makeTestEnv();
    try {
      ensureProfile(env.db, "other");
      add(env, { title: "我的事", time: "09:00" });
      add(env, { title: "别人的事", time: "10:00", profileId: "other" });
      insertPastOccurrence(env, "otherlg1", {
        title: "别人的逾期",
        date: PREV,
        time: "09:00",
        profileId: "other",
      });

      assert.deepEqual(
        agendaForDate(env.db, "default", D).map((item) => item.title),
        ["我的事"],
      );
      assert.deepEqual(
        agendaForDate(env.db, "other", D).map((item) => item.title),
        ["别人的逾期", "别人的事"],
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("生日/纪念日 kind 原样透出，且无数据时返回空数组", (t) => {
    freeze(t, `${D}T07:00:00+08:00`);
    const env = makeTestEnv();
    try {
      assert.deepEqual(agendaForDate(env.db, "default", D), []);
      add(env, { title: "妈妈生日", time: "09:00", kind: "birthday", all_day: true });
      add(env, { title: "结婚纪念日", time: "10:00", kind: "anniversary", all_day: true });
      const items = agendaForDate(env.db, "default", D);
      assert.deepEqual(
        items.map((item) => [item.title, item.kind, item.all_day]),
        [
          ["妈妈生日", "birthday", true],
          ["结婚纪念日", "anniversary", true],
        ],
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非法日期报错；日程被删除后其 occurrence 不再出现", (t) => {
    freeze(t, `${D}T07:00:00+08:00`);
    const env = makeTestEnv();
    try {
      assert.throws(() => agendaForDate(env.db, "default", "2026-13-01"), /日期不合法/);
      const id = add(env, { title: "要删除的", time: "09:00" });
      tool(env, { action: "delete", id });
      assert.deepEqual(agendaForDate(env.db, "default", D), []);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
