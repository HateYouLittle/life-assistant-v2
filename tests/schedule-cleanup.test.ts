import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { now, todayIso } from "../src/time.js";
import {
  createSchedule,
  previewOccurrenceCleanup,
  runOccurrenceCleanup,
  type ScheduleInput,
  type ScheduleRow,
} from "../src/modules/schedule/service.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

type OccurrenceStatus = "pending" | "notified" | "done" | "cancelled";

function addSchedule(env: TestEnv, overrides: Partial<ScheduleInput> = {}): ScheduleRow {
  return createSchedule(env.db, "default", {
    title: "清理用例",
    kind: "todo",
    calendar: "solar",
    startDate: todayIso(),
    time: "09:00",
    allDay: false,
    recurrence: { freq: "daily", interval: 1 },
    remindOffsets: [0],
    resendMinutes: 0,
    workdayFilter: "any",
    ...overrides,
  });
}

/** 丢弃自动物化的 occurrence，改为手工构造，保证断言确定性 */
function resetOccurrences(env: TestEnv, scheduleId: string): void {
  env.db.prepare("DELETE FROM occurrences WHERE schedule_id = ?").run(scheduleId);
}

function insertOccurrence(
  env: TestEnv,
  scheduleId: string,
  key: string,
  daysAgo: number,
  status: OccurrenceStatus,
): void {
  const event = now().minus({ days: daysAgo }).toUTC().toISO() as string;
  env.db
    .prepare(
      `INSERT INTO occurrences (schedule_id, occurrence_key, event_at, due_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(scheduleId, key, event, event, status);
}

function keysOf(env: TestEnv, scheduleId: string): string[] {
  return (
    env.db
      .prepare(
        "SELECT occurrence_key FROM occurrences WHERE schedule_id = ? ORDER BY occurrence_key",
      )
      .all(scheduleId) as { occurrence_key: string }[]
  ).map((r) => r.occurrence_key);
}

function totalOccurrences(env: TestEnv): number {
  return (env.db.prepare("SELECT COUNT(*) AS n FROM occurrences").get() as { n: number }).n;
}

describe("schedule occurrence 保留策略", () => {
  it("删除 90 天前的 notified，保留同日程近期的 notified", () => {
    const env = makeTestEnv();
    try {
      const s = addSchedule(env);
      resetOccurrences(env, s.id);
      insertOccurrence(env, s.id, "old#0", 100, "notified");
      insertOccurrence(env, s.id, "recent#0", 10, "notified");

      assert.equal(runOccurrenceCleanup(env.db), 1);
      assert.deepEqual(keysOf(env, s.id), ["recent#0"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("pending 行无论多旧都保留", () => {
    const env = makeTestEnv();
    try {
      const s = addSchedule(env);
      resetOccurrences(env, s.id);
      insertOccurrence(env, s.id, "old#0", 400, "pending");
      insertOccurrence(env, s.id, "recent#0", 1, "pending");

      assert.equal(runOccurrenceCleanup(env.db), 0);
      assert.deepEqual(keysOf(env, s.id), ["old#0", "recent#0"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("历史 done/cancelled 一并清理，近期 done 保留", () => {
    const env = makeTestEnv();
    try {
      const s = addSchedule(env);
      resetOccurrences(env, s.id);
      insertOccurrence(env, s.id, "a-done#0", 120, "done");
      insertOccurrence(env, s.id, "b-cancelled#0", 130, "cancelled");
      insertOccurrence(env, s.id, "c-recent-done#0", 5, "done");

      assert.equal(runOccurrenceCleanup(env.db), 2);
      assert.deepEqual(keysOf(env, s.id), ["c-recent-done#0"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("使用 recurrence.count 的日程整条豁免：100 天前的 notified 也不删", () => {
    const env = makeTestEnv();
    try {
      const s = addSchedule(env, { recurrence: { freq: "daily", interval: 1, count: 3 } });
      resetOccurrences(env, s.id);
      insertOccurrence(env, s.id, "old#0", 100, "notified");

      const preview = previewOccurrenceCleanup(env.db);
      assert.equal(preview.deletable, 0);
      assert.equal(preview.protectedByCount, 1);

      assert.equal(runOccurrenceCleanup(env.db), 0);
      assert.deepEqual(keysOf(env, s.id), ["old#0"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("preview 与实际删除一致，且预演零副作用", () => {
    const env = makeTestEnv();
    try {
      const a = addSchedule(env);
      const b = addSchedule(env, { title: "另一个日程" });
      resetOccurrences(env, a.id);
      resetOccurrences(env, b.id);
      insertOccurrence(env, a.id, "a-old1#0", 100, "notified");
      insertOccurrence(env, a.id, "a-old2#0", 200, "done");
      insertOccurrence(env, a.id, "a-new#0", 1, "notified");
      insertOccurrence(env, b.id, "b-old#0", 150, "cancelled");
      insertOccurrence(env, b.id, "b-pending#0", 150, "pending");

      const before = totalOccurrences(env);
      const preview = previewOccurrenceCleanup(env.db);
      assert.equal(totalOccurrences(env), before, "preview 不得写库");
      assert.equal(preview.deletable, 3);
      assert.deepEqual(preview.bySchedule.map((r) => r.schedule_id).sort(), [a.id, b.id].sort());

      assert.equal(runOccurrenceCleanup(env.db), preview.deletable);
      assert.equal(totalOccurrences(env), before - preview.deletable);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("无到期的历史行时返回 0 且不报错", () => {
    const env = makeTestEnv();
    try {
      const s = addSchedule(env);
      resetOccurrences(env, s.id);
      insertOccurrence(env, s.id, "pending#0", 100, "pending");

      assert.equal(previewOccurrenceCleanup(env.db).deletable, 0);
      assert.equal(runOccurrenceCleanup(env.db), 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
