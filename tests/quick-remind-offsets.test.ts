import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { createQuickApp } from "../src/server/quick.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import {
  createSchedule,
  getSchedule,
  type ScheduleInput,
} from "../src/modules/schedule/service.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * A6 回归：`/api/quick/schedules` 直接调用工具层，绕过了 MCP 的 zod schema，
 * 因此 `remind_offsets` 的边界（1-5 项、整数、±43200 分钟）必须在服务层收口；
 * 同时**不能**卡住历史脏数据的无关编辑（改标题等 patch 不传 remind_offsets 时沿用原值）。
 */

const MASTER = "m".repeat(64);
const BESTIE = "b".repeat(64);

function buildEnv(): TestEnv {
  return makeTestEnv({
    WEB_API_TOKEN: MASTER,
    PROFILE_TOKENS_JSON: JSON.stringify({ bestie: BESTIE }),
  });
}

function appFor(env: TestEnv): Hono {
  return new Hono().route("/", createQuickApp(env.config, env.db));
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function toolCtx(env: TestEnv) {
  return {
    profileId: "default",
    db: env.db,
    config: env.config,
    services: {
      publishProfile: async () => ({ id: "x", deduped: false }),
      publishGlobal: async () => ({ materialized: 0 }),
    },
  };
}

function text(result: { content: { text: string }[] }): string {
  return result.content[0]?.text ?? "";
}

describe("/api/quick/schedules：remind_offsets 边界（A6）", () => {
  it("越界偏移 [999999] 与空数组 [] 都返回 400，且不落库", async () => {
    const env = buildEnv();
    try {
      const app = appFor(env);
      const tooFar = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({
          title: "越界提醒",
          date: "2026-11-01",
          remind_offsets: [999999],
        }),
      });
      assert.equal(tooFar.status, 400);
      assert.match(String(((await tooFar.json()) as { error?: string }).error), /remind_offsets/);

      const empty = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({
          title: "空偏移",
          date: "2026-11-01",
          remind_offsets: [],
        }),
      });
      assert.equal(empty.status, 400);
      assert.match(String(((await empty.json()) as { error?: string }).error), /remind_offsets/);

      const count = env.db.prepare("SELECT COUNT(*) AS n FROM schedules").get() as { n: number };
      assert.equal(count.n, 0, "被拒绝的写请求不得落库");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("合法偏移仍可用（-30 / 0）；越界负数 -43201 被拒", async () => {
    const env = buildEnv();
    try {
      const app = appFor(env);
      const ok = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({
          title: "提前半小时",
          date: "2026-11-01",
          remind_offsets: [-30, 0],
        }),
      });
      assert.equal(ok.status, 201);
      const id = String(((await ok.json()) as { id?: string }).id);
      const row = getSchedule(env.db, "bestie", id);
      assert.equal(row?.remind_offsets_json, "[-30,0]");

      const outOfRange = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({
          title: "越界负数",
          date: "2026-11-01",
          remind_offsets: [-43201],
        }),
      });
      assert.equal(outOfRange.status, 400);
      assert.match(
        String(((await outOfRange.json()) as { error?: string }).error),
        /remind_offsets/,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("schedule 服务层：remind_offsets 边界（A6）", () => {
  function baseInput(remindOffsets: number[]): ScheduleInput {
    return {
      title: "服务层校验",
      kind: "todo",
      calendar: "solar",
      startDate: "2026-11-01",
      time: "09:00",
      allDay: false,
      recurrence: null,
      remindOffsets,
      resendMinutes: 0,
      escalation: null,
      workdayFilter: "any",
    };
  }

  it("createSchedule 拒绝越界/空/多于 5 项；合法值通过", () => {
    const env = makeTestEnv();
    try {
      assert.throws(() => createSchedule(env.db, "default", baseInput([999999])), /remind_offsets/);
      assert.throws(
        () => createSchedule(env.db, "default", baseInput([0, -43201])),
        /remind_offsets/,
      );
      assert.throws(() => createSchedule(env.db, "default", baseInput([])), /remind_offsets/);
      assert.throws(
        () => createSchedule(env.db, "default", baseInput([0, 1, 2, 3, 4, 5])),
        /remind_offsets/,
        "超过 5 项",
      );
      const created = createSchedule(env.db, "default", baseInput([-30, 0, 30]));
      assert.equal(created.remind_offsets_json, "[-30,0,30]");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("MCP 工具层同样拒绝（quick 走的也是这条 handler）", () => {
    const env = makeTestEnv();
    try {
      const ctx = toolCtx(env);
      const tooFar = scheduleTool(
        { action: "add", title: "越界", date: "2026-11-01", remind_offsets: [999999] },
        ctx,
      ) as { isError?: boolean; content: { text: string }[] };
      assert.equal(tooFar.isError, true);
      assert.match(text(tooFar), /remind_offsets/);

      const ok = scheduleTool(
        { action: "add", title: "合法", date: "2026-11-01", remind_offsets: [-30, 0] },
        ctx,
      ) as { isError?: boolean; content: { text: string }[] };
      assert.notEqual(ok.isError, true, text(ok));
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("历史脏数据（已入库的越界偏移）仍可改标题等无关字段", () => {
    const env = makeTestEnv();
    try {
      // 先正常建一条，再把库里的值改成越界值（模拟旧版本/手工改库留下的脏数据）
      const created = createSchedule(env.db, "default", baseInput([0]));
      env.db
        .prepare("UPDATE schedules SET remind_offsets_json = '[999999]' WHERE id = ?")
        .run(created.id);

      const updated = scheduleTool(
        { action: "update", id: created.id, title: "只改标题" },
        toolCtx(env),
      ) as { isError?: boolean; content: { text: string }[] };
      assert.notEqual(updated.isError, true, `脏数据不该被锁死：${text(updated)}`);
      const row = getSchedule(env.db, "default", created.id);
      assert.equal(row?.title, "只改标题");
      assert.equal(row?.remind_offsets_json, "[999999]", "无关 patch 不得顺手改写历史值");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("update 显式传越界偏移仍被拒绝（宽容只给继承值）", () => {
    const env = makeTestEnv();
    try {
      const created = createSchedule(env.db, "default", baseInput([0]));
      const rejected = scheduleTool(
        { action: "update", id: created.id, remind_offsets: [999999] },
        toolCtx(env),
      ) as { isError?: boolean; content: { text: string }[] };
      assert.equal(rejected.isError, true);
      assert.match(text(rejected), /remind_offsets/);
      assert.equal(
        getSchedule(env.db, "default", created.id)?.remind_offsets_json,
        "[0]",
        "被拒绝的 update 不得落库",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});
