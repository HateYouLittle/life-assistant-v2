import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createStatusApp } from "../src/server/status.js";
import { runRetention, retentionPreview } from "../src/core/retention.js";
import {
  bumpQweatherUsage,
  currentWeather,
  qweatherUsage,
  readQweatherUsage,
  seedQweatherUsage,
} from "../src/core/qweather.js";
import { todayIso } from "../src/time.js";
import { runDoctor } from "../src/doctor.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/** 保留策略：只删该删的（未读通知、仍有待投递的通知、count 日程都不许动） */
describe("保留策略", () => {
  function seedNotification(
    env: TestEnv,
    id: string,
    createdAt: string,
    read: 0 | 1,
    deliveryStatus?: string,
  ): void {
    env.db
      .prepare(
        "INSERT INTO notifications (id, profile_id, kind, title, body_md, read, created_at) VALUES (?, 'default', 'k', 't', 'b', ?, ?)",
      )
      .run(id, read, createdAt);
    if (deliveryStatus !== undefined) {
      env.db
        .prepare(
          `INSERT INTO deliveries (id, notification_id, route_name, status, next_attempt_at, created_at, updated_at)
           VALUES (?, ?, 'r', ?, ?, ?, ?)`,
        )
        .run(`d-${id}`, id, deliveryStatus, createdAt, createdAt, createdAt);
    }
  }

  const OLD = "2020-01-01T00:00:00.000Z";
  const RECENT = new Date().toISOString();

  it("删已读且投递终结的老通知；未读、仍有待投递、新通知一律保留", () => {
    const env = makeTestEnv();
    try {
      seedNotification(env, "n-old-read-sent", OLD, 1, "sent");
      seedNotification(env, "n-old-read-none", OLD, 1);
      seedNotification(env, "n-old-read-queued", OLD, 1, "queued");
      seedNotification(env, "n-old-unread", OLD, 0);
      seedNotification(env, "n-new-read-sent", RECENT, 1, "sent");

      const preview = retentionPreview(env.db);
      assert.equal(preview.notifications, 2, "只应预演到两条老且已读且无待投递的通知");
      assert.equal(preview.deliveries, 2, "被删通知的投递记录会随外键级联");

      const result = runRetention(env.db);
      assert.equal(result.notifications, 2);
      const left = (
        env.db.prepare("SELECT id FROM notifications ORDER BY id").all() as { id: string }[]
      ).map((r) => r.id);
      assert.deepEqual(left, ["n-new-read-sent", "n-old-read-queued", "n-old-unread"]);
      const deliveries = env.db.prepare("SELECT COUNT(*) AS n FROM deliveries").get() as {
        n: number;
      };
      assert.equal(deliveries.n, 2, "级联只影响被删通知的记录");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("已取消日程超期回收；使用 recurrence.count 的永不删", () => {
    const env = makeTestEnv();
    try {
      const insert = env.db.prepare(
        `INSERT INTO schedules (id, profile_id, title, kind, calendar, start_date, time, all_day,
           recurrence_json, remind_offsets_json, resend_minutes, workday_filter, status, version, created_at, updated_at)
         VALUES (?, 'default', ?, 'todo', 'solar', '2026-01-01', '09:00', 1, ?, '[0]', 0, 'any', 'cancelled', 1, ?, ?)`,
      );
      insert.run("s-old-cancelled", "旧已取消", '{"freq":"daily","interval":1}', OLD, OLD);
      insert.run(
        "s-old-count",
        "旧但有 count",
        '{"freq":"daily","interval":1,"count":5}',
        OLD,
        OLD,
      );
      insert.run("s-old-active", "仍活跃", '{"freq":"daily","interval":1}', OLD, OLD);
      env.db.prepare("UPDATE schedules SET status = 'active' WHERE id = 's-old-active'").run();

      const preview = retentionPreview(env.db);
      assert.equal(preview.cancelledSchedules, 1);

      const result = runRetention(env.db);
      assert.equal(result.cancelledSchedules, 1);
      const left = (
        env.db.prepare("SELECT id FROM schedules ORDER BY id").all() as { id: string }[]
      ).map((r) => r.id);
      assert.deepEqual(
        left,
        ["s-old-active", "s-old-count"],
        "count 日程删了会让已达上限的循环复活",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("/healthz", () => {
  it("存活探针无需凭据，返回 ok 与版本；不影响 / 与 /api/*", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: "t".repeat(32), HOST: "0.0.0.0" });
    try {
      const app = createStatusApp(env.config, env.db);
      const health = await app.request("/healthz");
      assert.equal(health.status, 200);
      const body = (await health.json()) as { ok: boolean; version: string; uptime_s: number };
      assert.equal(body.ok, true);
      assert.equal(typeof body.version, "string");
      assert.ok(body.uptime_s >= 0);
      assert.equal((await app.request("/api/status")).status, 401, "健康检查不该放宽数据接口");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("QWeather 用量计量", () => {
  it("落库后可从库里读回（daemon 重启不清零）", () => {
    const env = makeTestEnv();
    try {
      const day = todayIso();
      assert.equal(readQweatherUsage(env.db, day), 0, "没请求过就是 0");
      bumpQweatherUsage(env.db, day);
      bumpQweatherUsage(env.db, day);
      assert.equal(readQweatherUsage(env.db, day), 2);
      assert.equal(readQweatherUsage(env.db, "1999-01-01"), 0, "别的日子互不影响");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("真实出网才计数：第二次走缓存不再增加", async () => {
    const env = makeTestEnv({ QWEATHER_API_HOST: "h.example.com", QWEATHER_KEY: "k" });
    const originalFetch = globalThis.fetch;
    let calls = 0;
    try {
      seedQweatherUsage(0);
      globalThis.fetch = (async () => {
        calls += 1;
        return new Response(
          JSON.stringify({
            code: "200",
            now: { temp: "26", feelsLike: "28", humidity: "70", windSpeed: "12", text: "多云" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch;
      const loc = { city: "上海", cityId: "101020100", lat: 31.23, lon: 121.47 };
      await currentWeather(env.db, "h.example.com", "k", loc);
      await currentWeather(env.db, "h.example.com", "k", loc);
      assert.equal(calls, 1, "20 分钟缓存内的第二次不该再打上游");
      assert.equal(qweatherUsage().requests, 1, "计数必须与实际出网次数一致");
    } finally {
      globalThis.fetch = originalFetch;
      cleanupTestEnv(env);
    }
  });
});

describe("doctor 自检", () => {
  it("正常配置：全绿且能打开既有库", async () => {
    const env = makeTestEnv();
    try {
      const report = await runDoctor({
        DATA_DIR: env.dir,
        HERMES_PROFILE: "default",
        LOG_LEVEL: "error",
      });
      assert.equal(report.failed, 0, JSON.stringify(report.checks));
      assert.ok(
        report.checks.some((c) => c.name === "数据库" && c.level === "ok"),
        JSON.stringify(report.checks),
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("配置写错：DATA_DIR 相对路径直接失败而不是抛异常", async () => {
    const report = await runDoctor({ DATA_DIR: "relative/path", LOG_LEVEL: "error" });
    assert.equal(report.failed, 1);
    assert.match(report.checks[0]?.detail ?? "", /绝对路径/);
  });

  it("JWT 私钥不可用：doctor 阶段就能发现（而不是等首次天气请求）", async () => {
    const env = makeTestEnv();
    try {
      const bogus = join(env.dir, "not-a-key.pem");
      writeFileSync(
        bogus,
        "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
      );
      const report = await runDoctor({
        DATA_DIR: env.dir,
        QWEATHER_API_HOST: "h.example.com",
        QWEATHER_JWT_KEY_ID: "kid",
        QWEATHER_JWT_PROJECT_ID: "proj",
        QWEATHER_JWT_DEVELOPER_ID: "dev",
        QWEATHER_JWT_PRIVATE_KEY_PATH: bogus,
        LOG_LEVEL: "error",
      });
      const check = report.checks.find((c) => c.name === "QWeather");
      assert.equal(check?.level, "fail", JSON.stringify(report.checks));
      assert.match(check?.detail ?? "", /PKCS8|Ed25519/);
      assert.ok(
        !readFileSync(bogus, "utf8").includes("secret"),
        "自检输出不得回显私钥内容（这里只是确认探针文件没被改动）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});
