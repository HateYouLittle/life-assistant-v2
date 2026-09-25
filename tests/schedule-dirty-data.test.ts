import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { tickSchedules, parseOffsets } from "../src/modules/schedule/service.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import type { Services, ToolContext } from "../src/core/registry.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";
import { TZ } from "../src/time.js";

/**
 * 脏数据隔离回归。
 *
 * 起因：`parseRecurrence` 曾直接 JSON.parse，而 tickSchedules 的物化循环没有逐行 try/catch，
 * 结果一条损坏的 recurrence_json 会让**该行之后的所有日程**都不再产生 occurrence，
 * 并且每分钟重复抛错 —— 日程提醒静默消失，只有日志里能看到。
 */

function servicesStub(): Services {
  return {
    publishProfile: async () => ({ id: "n", deduped: false }),
    publishGlobal: async () => ({ materialized: 0 }),
  };
}

function insertSchedule(
  env: TestEnv,
  id: string,
  title: string,
  recurrenceJson: string,
  remindOffsetsJson = "[0]",
): void {
  const stamp = new Date().toISOString();
  env.db
    .prepare(
      `INSERT INTO schedules
         (id, profile_id, title, kind, calendar, start_date, time, all_day,
          recurrence_json, remind_offsets_json, resend_minutes, workday_filter,
          status, version, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      id,
      "default",
      title,
      "todo",
      "solar",
      "2026-01-05",
      "09:00",
      0,
      recurrenceJson,
      remindOffsetsJson,
      0,
      "any",
      "active",
      1,
      stamp,
      stamp,
    );
}

function occurrencesOf(env: TestEnv, id: string): number {
  const row = env.db
    .prepare("SELECT COUNT(*) AS n FROM occurrences WHERE schedule_id = ?")
    .get(id) as { n: number };
  return row.n;
}

describe("schedule 脏数据隔离", () => {
  it("损坏的 recurrence_json 只跳过该行，不影响其它日程物化", async () => {
    const env = makeTestEnv();
    try {
      insertSchedule(env, "aaaa1111", "损坏日程", '{"freq":"daily"');
      insertSchedule(env, "bbbb2222", "正常日程", '{"freq":"daily","interval":1}');

      await tickSchedules(DateTime.now().setZone(TZ), servicesStub(), env.db);

      assert.equal(occurrencesOf(env, "aaaa1111"), 0, "损坏行不该物化出任何 occurrence");
      assert.ok(
        occurrencesOf(env, "bbbb2222") > 0,
        "坏行之后的正常日程必须照常物化（曾经被整批带走）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("list 遇到损坏的循环规则：该行显示「规则损坏」而不是整批报错", () => {
    const env = makeTestEnv();
    try {
      insertSchedule(env, "cccc3333", "损坏日程", '{"freq":"daily"');
      insertSchedule(env, "dddd4444", "正常日程", '{"freq":"daily"}');
      const ctx: ToolContext = {
        profileId: "default",
        db: env.db,
        config: env.config,
        services: servicesStub(),
      };
      const result = scheduleTool({ action: "list", status: "active" }, ctx);
      assert.notEqual(result.isError, true, `list 不该整批失败：${result.content[0]?.text}`);
      const payload = JSON.parse(result.content[0]?.text ?? "{}") as {
        日程?: Array<{ 标题: string; 重复: string }>;
      };
      const rows = payload.日程 ?? [];
      assert.equal(rows.length, 2);
      const broken = rows.find((r) => r.标题 === "损坏日程");
      const healthy = rows.find((r) => r.标题 === "正常日程");
      assert.match(String(broken?.重复), /损坏/);
      assert.equal(healthy?.重复, "每天", "正常行的循环描述必须保持原样");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("parseOffsets：非法值退化为 [0]，不做多余猜测", () => {
    assert.deepEqual(parseOffsets(null), [0]);
    assert.deepEqual(parseOffsets(""), [0]);
    assert.deepEqual(parseOffsets("{bad"), [0]);
    assert.deepEqual(parseOffsets('{"a":1}'), [0]);
    assert.deepEqual(parseOffsets("[]"), [0]);
    assert.deepEqual(parseOffsets("[null,3]"), [3], "非整数项被剔除，保留合法项");
    assert.deepEqual(parseOffsets("[-30,0]"), [-30, 0]);
  });
});
