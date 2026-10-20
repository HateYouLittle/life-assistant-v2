import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampOffset, deliveryDetails, expenseDetails } from "../src/server/details.js";
import { createStatusApp } from "../src/server/status.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 看板明细分页：limit/offset 的页边界必须**不重叠、不跳行**（加载更多是按 offset 续页，
 * 一旦排序不稳定或 next_offset 用 offset+limit 推进，用户就会看到重复/漏掉的记录）。
 *
 * 这里同时钉住 clampOffset 的口径：空串/非法/负数回退 0、上限 100000，
 * 因为 /api/* 是直接暴露给调用方的，坏参数不能变成 SQL 的 NaN/OFFSET -1。
 */

/** 造一个家庭账本 + 当月 N 笔支出（spent_on/created_at 全相同，专门考验分页兜底排序） */
function seedExpenses(env: TestEnv, count: number): void {
  env.db
    .prepare(
      "INSERT INTO ledgers (id, name, created_at) VALUES ('lf', '家庭账本', '2026-01-01T00:00:00.000Z')",
    )
    .run();
  const insert = env.db.prepare(
    `INSERT INTO expenses (id, ledger_id, amount_cents, category, note, spent_on, created_by_profile, created_at)
     VALUES (?, 'lf', 100, '餐饮', ?, '2026-10-10', 'default', '2026-10-10T00:00:00.000Z')`,
  );
  for (let i = 0; i < count; i += 1) {
    const id = `e${String(i).padStart(2, "0")}`;
    insert.run(id, `第 ${i} 笔`);
  }
}

/** 造一条通知 + N 条投递记录（created_at 递增，最新在前） */
function seedDeliveries(env: TestEnv, count: number): void {
  env.db
    .prepare(
      `INSERT INTO notifications (id, profile_id, kind, title, body_md, created_at)
       VALUES ('n1', 'default', 'k', '标题', '正文', '2026-10-01T00:00:00.000Z')`,
    )
    .run();
  const insert = env.db.prepare(
    `INSERT INTO deliveries (id, notification_id, route_name, status, next_attempt_at, created_at, updated_at)
     VALUES (?, 'n1', 'r', 'sent', ?, ?, ?)`,
  );
  for (let i = 0; i < count; i += 1) {
    const id = `d${String(i).padStart(2, "0")}`;
    // 秒数唯一：created_at DESC 的排序完全确定
    const stamp = `2026-10-20T00:00:${String(i).padStart(2, "0")}.000Z`;
    insert.run(id, stamp, stamp, stamp);
  }
}

describe("clampOffset", () => {
  it("空串/非法/负数回退 0", () => {
    assert.equal(clampOffset(undefined), 0);
    assert.equal(clampOffset(""), 0);
    assert.equal(clampOffset("   "), 0);
    assert.equal(clampOffset("abc"), 0);
    assert.equal(clampOffset("NaN"), 0);
    assert.equal(clampOffset("-5"), 0, "负数 offset 会让 SQLite 行为不可预期，必须回退 0");
  });

  it("正常值取整，深分页有上限", () => {
    assert.equal(clampOffset("50"), 50);
    assert.equal(clampOffset("12.9"), 12, "offset 取整（SQLite 的 OFFSET 需要整数）");
    assert.equal(clampOffset("999999"), 100_000, "深分页上限");
    assert.equal(clampOffset("100000"), 100_000);
  });
});

describe("expenseDetails 分页", () => {
  it("55 条、limit=50：首页 has_more/next_offset 正确，两页 id 不重叠且拼起来是全集", () => {
    const env = makeTestEnv();
    try {
      seedExpenses(env, 55);
      const first = expenseDetails(env.db, "2026-10", "50");
      assert.equal(first.entries_total, 55, "总数不受分页影响");
      assert.equal(first.entries.length, 50);
      assert.equal(first.offset, 0);
      assert.equal(first.has_more, true);
      assert.equal(first.next_offset, 50);

      const second = expenseDetails(env.db, "2026-10", "50", String(first.next_offset));
      assert.equal(second.entries_total, 55);
      assert.equal(second.entries.length, 5);
      assert.equal(second.offset, 50);
      assert.equal(second.has_more, false, "第二页已到底");
      assert.equal(second.next_offset, null);

      const firstIds = first.entries.map((entry) => entry.id);
      const secondIds = second.entries.map((entry) => entry.id);
      assert.equal(new Set([...firstIds, ...secondIds]).size, 55, "两页拼起来必须是完整 55 条");
      assert.equal(
        firstIds.filter((id) => secondIds.includes(id)).length,
        0,
        "spent_on/created_at 完全相同的记录也不能在两页重复出现（靠 id 兜底排序）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("offset 超过总数：空页且 has_more=false（而不是报错或回到第一页）", () => {
    const env = makeTestEnv();
    try {
      seedExpenses(env, 55);
      const page = expenseDetails(env.db, "2026-10", "50", "1000");
      assert.deepEqual(page.entries, []);
      assert.equal(page.entries_total, 55);
      assert.equal(page.offset, 1000, "offset 原样回传（夹紧后），便于调用方识别越界");
      assert.equal(page.has_more, false);
      assert.equal(page.next_offset, null);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非法 offset 回退 0；limit+offset 组合按页取", () => {
    const env = makeTestEnv();
    try {
      seedExpenses(env, 55);
      const fromBad = expenseDetails(env.db, "2026-10", "50", "abc");
      assert.equal(fromBad.offset, 0);
      assert.equal(fromBad.entries.length, 50);

      const middle = expenseDetails(env.db, "2026-10", "10", "10");
      assert.equal(middle.offset, 10);
      assert.equal(middle.entries.length, 10);
      assert.equal(middle.has_more, true);
      assert.equal(middle.next_offset, 20);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("恰好整页（50/50）时 has_more=false，不会多给一个空页", () => {
    const env = makeTestEnv();
    try {
      seedExpenses(env, 50);
      const page = expenseDetails(env.db, "2026-10", "50");
      assert.equal(page.entries.length, 50);
      assert.equal(page.has_more, false);
      assert.equal(page.next_offset, null);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("deliveryDetails 分页", () => {
  it("65 条、limit=60：两页不重叠，items_total 不受分页影响", () => {
    const env = makeTestEnv();
    try {
      seedDeliveries(env, 65);
      const first = deliveryDetails(env.db, "60");
      assert.equal(first.items_total, 65);
      assert.equal(first.items.length, 60);
      assert.equal(first.offset, 0);
      assert.equal(first.has_more, true);
      assert.equal(first.next_offset, 60);

      const second = deliveryDetails(env.db, "60", String(first.next_offset));
      assert.equal(second.items.length, 5);
      assert.equal(second.offset, 60);
      assert.equal(second.has_more, false);
      assert.equal(second.next_offset, null);

      const ids = [...first.items, ...second.items].map((item) => item.id);
      assert.equal(new Set(ids).size, 65);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非法 offset 回退 0；越界 offset 返回空页", () => {
    const env = makeTestEnv();
    try {
      seedDeliveries(env, 65);
      assert.equal(deliveryDetails(env.db, "60", "oops").offset, 0);
      const beyond = deliveryDetails(env.db, "60", "999");
      assert.deepEqual(beyond.items, []);
      assert.equal(beyond.has_more, false);
      assert.equal(beyond.next_offset, null);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("/api 分页参数透传", () => {
  it("/api/expenses?offset=50 返回第二页；401/鉴权行为不变", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      seedExpenses(env, 55);
      const app = createStatusApp(env.config, env.db);
      assert.equal(
        (await app.request("/api/expenses?offset=50")).status,
        401,
        "分页参数不能绕过鉴权",
      );

      const page = (await (
        await app.request(`/api/expenses?month=2026-10&limit=50&offset=50&token=${token}`)
      ).json()) as {
        entries: { id: string }[];
        entries_total: number;
        offset: number;
        has_more: boolean;
        next_offset: number | null;
      };
      assert.equal(page.offset, 50);
      assert.equal(page.entries_total, 55);
      assert.equal(page.entries.length, 5);
      assert.equal(page.has_more, false);
      assert.equal(page.next_offset, null);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("/api/deliveries?offset=... 透传并返回分页字段", async () => {
    const env = makeTestEnv();
    try {
      seedDeliveries(env, 65);
      const app = createStatusApp(env.config, env.db);
      const page = (await (await app.request("/api/deliveries?limit=60&offset=60")).json()) as {
        items: { id: string }[];
        items_total: number;
        offset: number;
        has_more: boolean;
        next_offset: number | null;
      };
      assert.equal(page.offset, 60);
      assert.equal(page.items_total, 65);
      assert.equal(page.items.length, 5);
      assert.equal(page.has_more, false);
      assert.equal(page.next_offset, null);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
