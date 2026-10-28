import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { now } from "../src/time.js";
import {
  completeSchedule,
  createSchedule,
  getSchedule,
  skipSchedule,
  type ScheduleInput,
} from "../src/modules/schedule/service.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * P2-2 / C-03：一次性待办 skip 后「永久 active」的静默失败。
 *
 * 旧行为：skip 只把 occurrence 置 cancelled，schedules.status 仍是 active。一次性待办没有
 * 「下一次」，物化因 INSERT OR IGNORE 撞上 cancelled 行永不重建、next_run_at 变 NULL →
 * 该待办永留 active 列表、不再提醒，complete（带 key）又报「已结束」，只剩 all=true/delete
 * 能收尾；而回执只写「已跳过」，与真实状态不符。
 *
 * 新契约：一次性（recurrence_json 为空）且 kind=todo 的行，skip 时同时把 schedules.status
 * 置为 done（与 complete 对同形态日程的终态逐字一致，不引入第三种半终态），回执如实给出
 * 「状态」与「已结束该待办」；重复系列保持「跳过本次、系列继续」。
 *
 * 有牙齿：删掉 skipSchedule 里的终态置位（`if (ended) UPDATE schedules SET status='done'`）
 * 时，本文件所有断言 done 的用例失败（状态回落到 active）。
 */

const day = (offset: number): string => now().plus({ days: offset }).toISODate() as string;

function baseInput(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    title: "一次性待办",
    note: null,
    kind: "todo",
    calendar: "solar",
    startDate: day(0),
    lunarMonth: null,
    lunarDay: null,
    leapPolicy: "follow",
    lunarClamp: true,
    time: "09:00",
    allDay: false,
    recurrence: null,
    remindOffsets: [0],
    resendMinutes: 0,
    escalation: null,
    workdayFilter: "any",
    ...overrides,
  };
}

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

function payload<T>(result: { content: { text: string }[] }): T {
  return JSON.parse(result.content[0]?.text ?? "{}") as T;
}

function statusOf(env: TestEnv, id: string): string {
  return getSchedule(env.db, "default", id)?.status ?? "<missing>";
}

function occurrenceStatuses(env: TestEnv, id: string): string[] {
  return (
    env.db
      .prepare("SELECT status FROM occurrences WHERE schedule_id = ? ORDER BY occurrence_key")
      .all(id) as unknown as { status: string }[]
  ).map((r) => r.status);
}

describe("P2-2 一次性待办 skip：跳过即收尾，回执与真实状态一致", () => {
  it("skip 一次性待办：日程置 done、occurrence 置 cancelled，不再是「active 但永不提醒」", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", baseInput());
      assert.equal(statusOf(env, created.id), "active");
      const outcome = skipSchedule(env.db, "default", created.id, null);
      assert.equal(outcome.ended, true, "一次性待办 skip 必须同时收尾");
      assert.equal(outcome.row.status, "done");
      assert.equal(outcome.remaining, 0);
      assert.equal(statusOf(env, created.id), "done", "库内状态必须是终态 done");
      assert.deepEqual(
        new Set(occurrenceStatuses(env, created.id)),
        new Set(["cancelled"]),
        "该次发生必须置 cancelled（不复活）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("工具层回执：状态=done、已结束该待办=true、说明说清「已跳过并结束该待办」", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", baseInput({ title: "交房租" }));
      const skipped = payload<{
        已跳过: { 状态: string; 已结束该待办: boolean; 说明?: string; 剩余未完成: number };
      }>(tool(env, { action: "skip", id: created.id }));

      assert.equal(skipped.已跳过.状态, "done", "回执状态必须与库内真实状态一致");
      assert.equal(skipped.已跳过.已结束该待办, true);
      assert.match(skipped.已跳过.说明 ?? "", /已跳过并结束该待办/, "回执文案必须说清已收尾");
      assert.equal(skipped.已跳过.剩余未完成, 0);

      // 收尾后不再出现在 active 列表（旧行为下它会永远留在列表里）
      const listed = payload<{ 日程: { id: string }[]; 数量: number }>(
        tool(env, { action: "list", status: "active" }),
      );
      assert.equal(listed.数量, 0, "已收尾的待办不得再出现在 active 列表");
      assert.ok(!listed.日程.some((r) => r.id === created.id));
      // 而 done 列表里能看到它（收尾可见，不是凭空消失）
      const doneList = payload<{ 日程: { id: string }[] }>(
        tool(env, { action: "list", status: "done" }),
      );
      assert.ok(
        doneList.日程.some((r) => r.id === created.id),
        "终态必须可见（done 列表）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("终态一致性：一次性待办经 skip / complete(key) / complete(all=true) 都收敛到 done", () => {
    const env = makeTestEnv();
    try {
      const bySkip = createSchedule(env.db, "default", baseInput({ title: "skip" }));
      const byKey = createSchedule(env.db, "default", baseInput({ title: "complete-key" }));
      const byAll = createSchedule(env.db, "default", baseInput({ title: "complete-all" }));

      skipSchedule(env.db, "default", bySkip.id, null);
      const key = (
        env.db
          .prepare("SELECT occurrence_key FROM occurrences WHERE schedule_id = ? LIMIT 1")
          .get(byKey.id) as { occurrence_key: string }
      ).occurrence_key;
      completeSchedule(env.db, "default", byKey.id, key);
      completeSchedule(env.db, "default", byAll.id, null, { all: true });

      for (const id of [bySkip.id, byKey.id, byAll.id]) {
        assert.equal(statusOf(env, id), "done", "三条路径的终态必须同为 done（无第三种半终态）");
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("重复系列（每天）skip：仍 active、系列继续，回执 已结束该待办=false", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(
        env.db,
        "default",
        baseInput({ title: "每日巡检", recurrence: { freq: "daily", interval: 1 } }),
      );
      const skipped = payload<{
        已跳过: { 状态: string; 已结束该待办: boolean; 说明?: string; 剩余未完成: number };
      }>(tool(env, { action: "skip", id: created.id }));

      assert.equal(skipped.已跳过.状态, "active", "循环系列 skip 后必须仍是 active");
      assert.equal(skipped.已跳过.已结束该待办, false);
      assert.equal(skipped.已跳过.说明, undefined, "系列继续时不得给「已结束」的文案");
      assert.ok(skipped.已跳过.剩余未完成 > 0, "系列后续发生必须仍在");
      assert.equal(statusOf(env, created.id), "active");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("已提醒过（notified）的一次性待办：skip 同样收尾", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", baseInput());
      env.db
        .prepare("UPDATE occurrences SET status = 'notified' WHERE schedule_id = ?")
        .run(created.id);
      const outcome = skipSchedule(env.db, "default", created.id, null);
      assert.equal(outcome.ended, true);
      assert.equal(statusOf(env, created.id), "done");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("边界：kind≠todo 的一次性日程 skip 不收尾；收尾只能靠 all=true（P2-1 口径）", () => {
    const env = makeTestEnv();
    try {
      // skip 的收尾判定与 complete 的**一次性待办**分支逐字对齐：只有
      // recurrence_json===null && kind==='todo' 由 skip 收尾（P2-2）。
      const created = createSchedule(
        env.db,
        "default",
        baseInput({ title: "一次性纪念日", kind: "anniversary" }),
      );
      const key = (
        env.db
          .prepare("SELECT occurrence_key FROM occurrences WHERE schedule_id = ? LIMIT 1")
          .get(created.id) as { occurrence_key: string }
      ).occurrence_key;
      const outcome = skipSchedule(env.db, "default", created.id, key);
      assert.equal(outcome.ended, false);
      assert.equal(statusOf(env, created.id), "active");
      // 裸调 complete（无 key、无 all）保持现状：完成这次但不改 status
      completeSchedule(env.db, "default", created.id, null);
      assert.equal(statusOf(env, created.id), "active", "裸调 complete 对 kind≠todo 的现状未变");
      // P2-1：all=true 是「结束整个系列」的显式入口，对任意 kind（含纪念日）置终态 done，
      // 终态只有一种（与 P2-2 的 done 口径一致）。
      completeSchedule(env.db, "default", created.id, null, { all: true });
      assert.equal(statusOf(env, created.id), "done", "all=true 必须对 kind≠todo 也置终态");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
