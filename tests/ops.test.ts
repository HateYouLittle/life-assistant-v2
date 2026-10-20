import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { allJobs } from "../src/core/registry.js";
import { createOpsApp, escapeLabelValue } from "../src/server/ops.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";
// 副作用 import：注册全部模块，/metrics 的 job 行才有内容（与 daemon 同一份注册表）
import "../src/modules/index.js";

/** 按生产挂载方式驱动：子 app 挂在根路径，不起真实 HTTP 端口 */
function app(env: TestEnv): Hono {
  return new Hono().route("/", createOpsApp(env.config, env.db));
}

function seedNotification(env: TestEnv, id: string, createdAt: string): void {
  env.db
    .prepare(
      `INSERT INTO notifications (id, profile_id, kind, title, body_md, read, created_at)
       VALUES (?, 'default', 'reminder', '测试通知', '正文', 0, ?)`,
    )
    .run(id, createdAt);
}

function seedDelivery(
  env: TestEnv,
  over: { id: string; notificationId: string; status: string; createdAt: string },
): void {
  env.db
    .prepare(
      `INSERT INTO deliveries (id, notification_id, route_name, status, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, 'r', ?, ?, ?, ?)`,
    )
    .run(over.id, over.notificationId, over.status, over.createdAt, over.createdAt, over.createdAt);
}

/**
 * 取某个样本行的数值。用 startsWith 而不是正则：指标名与标签里含 `{`/`"`，
 * 拼进正则既要转义又容易把 `{status="queued"}` 误当量词。
 */
function metricValue(body: string, sample: string): number {
  const line = body.split("\n").find((l) => l.startsWith(`${sample} `));
  assert.ok(line !== undefined, `缺少指标样本行 ${sample}\n---\n${body}`);
  const raw = line.slice(sample.length + 1);
  const value = Number(raw);
  assert.ok(Number.isFinite(value), `指标 ${sample} 不是数字字面量: ${raw}`);
  return value;
}

const STATUSES = ["queued", "sending", "sent", "failed", "fallback", "cancelled"] as const;

describe("/metrics", () => {
  it("未配置 token 时直接放行（回环零配置），并输出关键指标", async () => {
    const env = makeTestEnv();
    try {
      const response = await app(env).request("/metrics");
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get("content-type"),
        "text/plain; version=0.0.4; charset=utf-8",
        "Prometheus 抓取端按这个 content-type 识别文本格式",
      );
      assert.equal(response.headers.get("cache-control"), "no-store");
      const body = await response.text();
      assert.match(body, /^life_assistant_up 1$/m);

      // 六个状态必须各一行：只有出现过的状态才会被 GROUP BY 返回，缺行会让曲线断开
      for (const status of STATUSES) {
        assert.ok(
          body.includes(`life_assistant_deliveries{status="${status}"} `),
          `缺少 ${status} 状态行`,
        );
      }

      // 每个注册 job 一行，从未成功过为 0（job 清单来自 allJobs()，与 daemon 一致）
      const jobs = allJobs();
      assert.ok(jobs.length > 0, "模块未注册：本文件需 import ../src/modules/index.js");
      for (const { module, def } of jobs) {
        const sample = `life_assistant_job_last_success_timestamp_seconds{job="${module}.${def.name}"}`;
        assert.equal(metricValue(body, sample), 0, `${sample} 从未运行过应为 0`);
      }

      assert.equal(metricValue(body, "life_assistant_outbox_oldest_pending_seconds"), 0);
      assert.equal(metricValue(body, "life_assistant_notifications_total"), 0);
      assert.equal(metricValue(body, "life_assistant_qweather_requests_today"), 0);
      // 没有备份目录 → -1（而不是 0：0 会被误读成「刚刚备份过」）
      assert.equal(metricValue(body, "life_assistant_backup_latest_age_seconds"), -1);
      assert.ok(metricValue(body, "life_assistant_db_bytes") > 0, "主库文件应已存在");
      assert.ok(metricValue(body, "life_assistant_wal_bytes") >= 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("投递状态计数、最老排队秒数、通知总数、job 最近成功与备份年龄", async () => {
    const env = makeTestEnv();
    try {
      const now = Date.now();
      seedNotification(env, "n1", new Date(now - 3 * 3600 * 1000).toISOString());
      // queued 那条刻意放到 120 秒前：验证 outbox_oldest_pending_seconds 取的是最老的一条
      seedDelivery(env, {
        id: "d-queued",
        notificationId: "n1",
        status: "queued",
        createdAt: new Date(now - 120_000).toISOString(),
      });
      for (const status of STATUSES) {
        if (status === "queued") continue;
        seedDelivery(env, {
          id: `d-${status}`,
          notificationId: "n1",
          status,
          createdAt: new Date(now).toISOString(),
        });
      }

      // 一次成功运行：时间戳口径是 finished_at（「跑完并成功」才算成功）
      const finished = new Date(now - 3600 * 1000);
      env.db
        .prepare(
          `INSERT INTO job_runs (job_name, module, trigger, scheduled_for, started_at, finished_at, status)
           VALUES ('daily_backup', 'maintenance', 'cron', ?, ?, ?, 'ok')`,
        )
        .run(
          new Date(now - 3660 * 1000).toISOString(),
          new Date(now - 3660 * 1000).toISOString(),
          finished.toISOString(),
        );

      // 规范命名的备份文件：mtime 就是生成时间，年龄应接近 0
      mkdirSync(env.config.backupDir, { recursive: true });
      writeFileSync(join(env.config.backupDir, "life-assistant-20260101-030000.db"), "backup");

      const body = await (await app(env).request("/metrics")).text();
      for (const status of STATUSES) {
        assert.equal(
          metricValue(body, `life_assistant_deliveries{status="${status}"}`),
          1,
          `${status} 计数应为 1`,
        );
      }
      const oldest = metricValue(body, "life_assistant_outbox_oldest_pending_seconds");
      assert.ok(oldest >= 119 && oldest < 130, `最老排队应约 120 秒，实际 ${oldest}`);
      assert.equal(metricValue(body, "life_assistant_notifications_total"), 1);
      assert.equal(
        metricValue(
          body,
          'life_assistant_job_last_success_timestamp_seconds{job="maintenance.daily_backup"}',
        ),
        Math.floor(finished.getTime() / 1000),
        "job 最近成功时间戳应取 finished_at",
      );
      const age = metricValue(body, "life_assistant_backup_latest_age_seconds");
      assert.ok(age >= 0 && age < 60, `备份年龄应接近 0，实际 ${age}`);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("最近一次运行失败但此前成功过时，仍报出真正的最近成功时刻", async () => {
    const env = makeTestEnv();
    try {
      const now = Date.now();
      const insert = env.db.prepare(
        `INSERT INTO job_runs (job_name, module, trigger, scheduled_for, started_at, finished_at, status, error)
         VALUES ('daily_backup', 'maintenance', 'cron', ?, ?, ?, ?, ?)`,
      );
      const okAt = new Date(now - 26 * 3600 * 1000);
      insert.run(okAt.toISOString(), okAt.toISOString(), okAt.toISOString(), "ok", null);
      const failAt = new Date(now - 3600 * 1000);
      insert.run(
        failAt.toISOString(),
        failAt.toISOString(),
        failAt.toISOString(),
        "failed",
        "磁盘满",
      );

      const body = await (await app(env).request("/metrics")).text();
      assert.equal(
        metricValue(
          body,
          'life_assistant_job_last_success_timestamp_seconds{job="maintenance.daily_backup"}',
        ),
        Math.floor(okAt.getTime() / 1000),
        "只看最近一次运行会把「昨天成功、今天失败」误报成从未成功（0）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("仅 master token：无 token 401、Profile token 403、master 200，并计入鉴权计数", async () => {
    const master = "m".repeat(64);
    const bestie = "b".repeat(64);
    const env = makeTestEnv({
      WEB_API_TOKEN: master,
      HOST: "0.0.0.0",
      PROFILE_TOKENS_JSON: JSON.stringify({ bestie }),
    });
    try {
      const a = app(env);
      const denied = await a.request("/metrics");
      assert.equal(denied.status, 401, "无凭据必须拒绝");
      assert.equal(denied.headers.get("cache-control"), "no-store");
      assert.equal(
        (await a.request("/metrics", { headers: { Authorization: `Bearer ${bestie}` } })).status,
        403,
        "Profile token 不得看运维指标",
      );
      const ok = await a.request("/metrics", { headers: { Authorization: `Bearer ${master}` } });
      assert.equal(ok.status, 200);
      const body = await ok.text();
      assert.match(body, /^life_assistant_up 1$/m);
      // 与状态页共用同一组进程内计数器：失败/越权各记一次
      assert.equal(metricValue(body, "life_assistant_auth_failed_total"), 1);
      assert.equal(metricValue(body, "life_assistant_auth_forbidden_total"), 1);
      assert.equal(
        metricValue(body, "life_assistant_rate_limited_total"),
        0,
        "未出现过的计数器键必须按 0 输出（缺样本与值为 0 要能区分）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("/readyz", () => {
  it("正常时 200 {ok:true}，且无需 token（外部监控不持有凭据）", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: "t".repeat(32), HOST: "0.0.0.0" });
    try {
      const response = await app(env).request("/readyz");
      assert.equal(response.status, 200, "配了 token 也必须放行：探针给外部监控用");
      assert.deepEqual(await response.json(), { ok: true }, "正常时只回答健康，不带任何明细");
      assert.equal(response.headers.get("cache-control"), "no-store");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("outbox 最老 queued 超过 30 分钟 → 503 且 reasons 含 outbox", async () => {
    const env = makeTestEnv();
    try {
      seedNotification(env, "n1", new Date().toISOString());
      seedDelivery(env, {
        id: "d-old",
        notificationId: "n1",
        status: "queued",
        createdAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      });
      const response = await app(env).request("/readyz");
      assert.equal(response.status, 503);
      const body = (await response.json()) as { ok: boolean; reasons: string[] };
      assert.equal(body.ok, false);
      assert.ok(
        body.reasons.some((reason) => reason.includes("outbox")),
        `reasons 应含 outbox：${body.reasons.join(",")}`,
      );
      // 只给原因标识符：响应里不得出现计数/年龄/库路径这类主机与个人细节
      assert.deepEqual(Object.keys(body).sort(), ["ok", "reasons"]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("卡住的判定只算 queued：failed 行还在退避重试，不该让就绪探针报警", async () => {
    const env = makeTestEnv();
    try {
      seedNotification(env, "n1", new Date().toISOString());
      seedDelivery(env, {
        id: "d-failed",
        notificationId: "n1",
        status: "failed",
        createdAt: new Date(Date.now() - 40 * 60 * 1000).toISOString(),
      });
      const response = await app(env).request("/readyz");
      assert.equal(response.status, 200, "failed 由 drain 按 next_attempt_at 退避重试，不是卡住");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("db.close() 后 503（原因 db_not_writable，探针不得 500）", async () => {
    const env = makeTestEnv();
    try {
      env.db.close();
      const response = await app(env).request("/readyz");
      assert.equal(response.status, 503, "库不可用必须是 503 而不是 500（否则监控把探针当故障）");
      const body = (await response.json()) as { ok: boolean; reasons: string[] };
      assert.equal(body.ok, false);
      assert.ok(body.reasons.includes("db_not_writable"), `reasons: ${body.reasons.join(",")}`);
    } finally {
      // cleanupTestEnv 对已关闭的库安全（helpers 里先判 isOpen 再 close）
      cleanupTestEnv(env);
    }
  });
});

describe("Prometheus 文本编码", () => {
  it("标签值转义反斜杠/双引号/换行（不转义会让抓取端整份响应解析失败）", () => {
    assert.equal(escapeLabelValue('a\\b"c\nd'), 'a\\\\b\\"c\\nd');
    assert.equal(escapeLabelValue("weather.daily_brief"), "weather.daily_brief");
  });

  it("挂到根路径时不污染同级路由（no-store 只作用于自己的端点）", async () => {
    // 本 app 会被 .route("/", …) 与状态页并排挂载：若用 app.use("*") 设响应头，
    // Hono 会把它以 "/*" 合并进父路由，状态页会凭空多出 no-store。
    const env = makeTestEnv();
    try {
      const sibling = new Hono().get("/sibling", (c) => c.text("ok"));
      const parent = new Hono().route("/", createOpsApp(env.config, env.db)).route("/", sibling);
      const response = await parent.request("/sibling");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), null, "同级路由不该被加上 no-store");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
