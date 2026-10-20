import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { listAudit, recordAudit } from "../src/core/audit.js";
import { getSchemaVersion, openDatabase } from "../src/core/database.js";
import { schemaFingerprint, storedSchemaFingerprint } from "../src/core/fingerprint.js";
import { createQuickApp } from "../src/server/quick.js";
import { createStatusApp } from "../src/server/status.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 审计日志（schema v5）：
 * ① v4 老库升级后 audit_log 存在、旧数据保留、重复打开幂等（且留了 pre-v4 快照）；
 * ② recordAudit 永不抛错（外键失败/库已关闭/不可序列化 detail 都只吞掉）；
 * ③ /api/quick/expenses|schedules 成功写审计（target 指向返回 id；detail 不含备注/token）；
 * ④ /api/audit 鉴权（401）、master 全量、profile 仅自己、分页与非法参数、detail 不跨 Profile。
 */

const MASTER = "m".repeat(64);
const BESTIE = "b".repeat(64);

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

function buildEnv(): TestEnv {
  return makeTestEnv({
    WEB_API_TOKEN: MASTER,
    PROFILE_TOKENS_JSON: JSON.stringify({ bestie: BESTIE }),
  });
}

function ensureBestie(env: TestEnv): void {
  env.db
    .prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES ('bestie', ?)")
    .run("2026-01-01T00:00:00.000Z");
}

interface AuditSeed {
  id: string;
  profileId: string;
  action: string;
  createdAt: string;
  targetKind?: string;
  targetId?: string;
  detail?: Record<string, unknown>;
}

function seedAudit(env: TestEnv, entry: AuditSeed): void {
  env.db
    .prepare(
      `INSERT INTO audit_log (id, profile_id, action, target_kind, target_id, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      entry.id,
      entry.profileId,
      entry.action,
      entry.targetKind ?? null,
      entry.targetId ?? null,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      entry.createdAt,
    );
}

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe("schema v4 -> v5 迁移", () => {
  it("升级后 audit_log 表与索引存在、旧数据保留、留了 pre-v4 快照、重复打开幂等", () => {
    const env = makeTestEnv();
    try {
      // 升级前既有业务数据：必须原样保留
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l1', '家庭账本', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      env.db.close();

      // 还原成 v4 形状：没有 audit_log、没有结构指纹、版本号写回 4
      const raw = new DatabaseSync(env.config.dbPath);
      raw.exec("DROP TABLE audit_log");
      raw.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
      raw.prepare("DELETE FROM meta WHERE key = 'schema_fingerprint'").run();
      raw.close();

      const upgraded = openDatabase(env.config.dbPath, { backupDir: env.config.backupDir });
      try {
        assert.equal(getSchemaVersion(upgraded), 5);
        const table = upgraded
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'audit_log'")
          .get() as { sql: string } | undefined;
        assert.ok(table !== undefined, "v5 必须建出 audit_log");
        assert.match(table.sql, /STRICT/, "审计表也必须 STRICT");
        const columns = (
          upgraded.prepare("PRAGMA table_info(audit_log)").all() as { name: string }[]
        ).map((row) => row.name);
        assert.deepEqual(columns, [
          "id",
          "profile_id",
          "action",
          "target_kind",
          "target_id",
          "detail_json",
          "created_at",
        ]);
        const indexes = (
          upgraded
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'audit_log' AND name NOT LIKE 'sqlite_%' ORDER BY name",
            )
            .all() as { name: string }[]
        ).map((row) => row.name);
        assert.deepEqual(indexes, ["idx_audit_log_created_at", "idx_audit_log_profile"]);

        const ledgers = upgraded.prepare("SELECT COUNT(*) AS n FROM ledgers").get() as {
          n: number;
        };
        assert.equal(ledgers.n, 1, "升级不得丢既有数据");
        // 迁移完成后 openDatabase 会对账指纹：v4 老库没有指纹，首写
        assert.equal(storedSchemaFingerprint(upgraded), schemaFingerprint(upgraded));
      } finally {
        upgraded.close();
      }

      // 升级前快照：stored=4 < 5，必须留 pre-v4（供回滚）
      const snapshots = readdirSync(env.config.backupDir).filter((name) =>
        /^life-assistant-pre-v4-\d{8}-\d{6}\.db$/.test(name),
      );
      assert.equal(snapshots.length, 1, "v4 升级到 v5 前必须留一份 pre-v4 快照");

      // 幂等：重复打开不重复备份、版本不漂移、数据不丢
      for (let i = 0; i < 2; i += 1) {
        const again = openDatabase(env.config.dbPath, { backupDir: env.config.backupDir });
        try {
          assert.equal(getSchemaVersion(again), 5);
          const ledgers = again.prepare("SELECT COUNT(*) AS n FROM ledgers").get() as { n: number };
          assert.equal(ledgers.n, 1);
        } finally {
          again.close();
        }
      }
      assert.equal(
        readdirSync(env.config.backupDir).filter((name) => name.includes("-pre-v")).length,
        1,
        "已是最新版本时不得重复生成迁移前快照",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("recordAudit / listAudit", () => {
  it("写一条审计：字段落库、detail 序列化；失败只记日志不抛（外键/关闭的库/循环 detail）", () => {
    const env = buildEnv();
    try {
      ensureBestie(env);
      assert.equal(
        recordAudit(env.db, {
          profileId: "bestie",
          action: "quick.expense.add",
          targetKind: "expense",
          targetId: "e-1",
          detail: { 金额: 12.5, 分类: "餐饮", 已存在: false },
        }),
        true,
      );
      const row = env.db.prepare("SELECT * FROM audit_log").get() as {
        profile_id: string;
        action: string;
        target_kind: string;
        target_id: string;
        detail_json: string;
        created_at: string;
      };
      assert.equal(row.profile_id, "bestie");
      assert.equal(row.action, "quick.expense.add");
      assert.equal(row.target_kind, "expense");
      assert.equal(row.target_id, "e-1");
      assert.deepEqual(JSON.parse(row.detail_json), { 金额: 12.5, 分类: "餐饮", 已存在: false });
      assert.match(row.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

      // 不存在的 Profile → 外键失败，只吞掉
      assert.doesNotThrow(() =>
        recordAudit(env.db, { profileId: "ghost", action: "quick.expense.add" }),
      );
      // 循环引用 detail → 不抛
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      assert.doesNotThrow(() =>
        recordAudit(env.db, { profileId: "bestie", action: "x.circular", detail: circular }),
      );
      const circularRow = env.db
        .prepare("SELECT detail_json FROM audit_log WHERE action = 'x.circular'")
        .get() as { detail_json: string | null };
      assert.equal(circularRow.detail_json, null, "不可序列化的 detail 记 null，而不是让写入失败");
    } finally {
      cleanupTestEnv(env);
    }

    // 库已关闭：审计失败也不能抛
    const env2 = makeTestEnv();
    try {
      const closed = openDatabase(join(env2.dir, "closed.db"));
      closed.close();
      assert.doesNotThrow(() => recordAudit(closed, { profileId: "default", action: "x" }));
    } finally {
      cleanupTestEnv(env2);
    }
  });

  it("listAudit：时间倒序 + id 兜底、总数、Profile 过滤、分页夹紧", () => {
    const env = buildEnv();
    try {
      ensureBestie(env);
      seedAudit(env, {
        id: "a-1",
        profileId: "default",
        action: "quick.expense.add",
        createdAt: "2026-10-20T01:00:00.000Z",
      });
      seedAudit(env, {
        id: "a-2",
        profileId: "default",
        action: "quick.expense.add",
        createdAt: "2026-10-20T02:00:00.000Z",
      });
      seedAudit(env, {
        id: "a-3",
        profileId: "bestie",
        action: "quick.schedule.add",
        createdAt: "2026-10-20T03:00:00.000Z",
      });
      // 同一毫秒：id DESC 兜底，顺序才稳定
      seedAudit(env, {
        id: "b-1",
        profileId: "bestie",
        action: "quick.schedule.add",
        createdAt: "2026-10-20T04:00:00.000Z",
      });
      seedAudit(env, {
        id: "b-2",
        profileId: "bestie",
        action: "quick.schedule.add",
        createdAt: "2026-10-20T04:00:00.000Z",
      });

      const all = listAudit(env.db);
      assert.equal(all.total, 5);
      assert.deepEqual(
        all.items.map((row) => row.id),
        ["b-2", "b-1", "a-3", "a-2", "a-1"],
        "时间倒序；同毫秒按 id 倒序兜底",
      );

      const page = listAudit(env.db, { limit: 2, offset: 2 });
      assert.equal(page.total, 5);
      assert.deepEqual(
        page.items.map((row) => row.id),
        ["a-3", "a-2"],
      );

      const mine = listAudit(env.db, { profileId: "bestie" });
      assert.equal(mine.total, 3);
      assert.ok(mine.items.every((row) => row.profile_id === "bestie"));

      // 非法参数按缺省/夹紧处理，而不是 500 或返回负数偏移
      assert.equal(listAudit(env.db, { limit: Number.NaN }).items.length, 5);
      assert.equal(listAudit(env.db, { limit: 0 }).items.length, 1);
      assert.equal(listAudit(env.db, { limit: 999 }).items.length, 5);
      assert.deepEqual(
        listAudit(env.db, { offset: -5 }).items.map((row) => row.id),
        all.items.map((row) => row.id),
      );
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("/api/quick 写操作产生审计", () => {
  function quickAppFor(env: TestEnv): Hono {
    return new Hono().route("/", createQuickApp(env.config, env.db));
  }

  it("记账成功写 quick.expense.add（target=返回 id，detail 无备注/token）", async () => {
    const env = buildEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l-family', '家庭账本', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      const app = quickAppFor(env);
      const payload = {
        amount: 12.5,
        ledger_id: "l-family",
        category: "餐饮",
        note: "敏感备注：血压药",
        request_id: "audit-exp-1",
      };
      const first = await app.request("/api/quick/expenses", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify(payload),
      });
      assert.equal(first.status, 201);
      const firstBody = await jsonBody(first);

      const rows = env.db.prepare("SELECT * FROM audit_log ORDER BY created_at").all() as {
        profile_id: string;
        action: string;
        target_kind: string;
        target_id: string;
        detail_json: string;
      }[];
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.action, "quick.expense.add");
      assert.equal(rows[0]?.target_kind, "expense");
      assert.equal(rows[0]?.target_id, firstBody.id);
      assert.equal(rows[0]?.profile_id, "bestie");
      const detail = JSON.parse(rows[0]?.detail_json ?? "{}") as Record<string, unknown>;
      assert.equal(detail.金额, 12.5);
      assert.equal(detail.分类, "餐饮");
      assert.equal(detail.账本, "家庭账本");
      assert.equal(detail.已存在, undefined);
      // 隐私：备注全文与 token 都不能进审计
      assert.doesNotMatch(rows[0]?.detail_json ?? "", /血压/);
      assert.doesNotMatch(rows[0]?.detail_json ?? "", new RegExp(BESTIE));

      // 幂等重试：第二次也要留痕，并标记 已存在
      const second = await app.request("/api/quick/expenses", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify(payload),
      });
      assert.equal(second.status, 201);
      const dupRows = env.db
        .prepare("SELECT detail_json FROM audit_log ORDER BY created_at")
        .all() as { detail_json: string }[];
      assert.equal(dupRows.length, 2);
      assert.equal(
        (JSON.parse(dupRows[1]?.detail_json ?? "{}") as Record<string, unknown>).已存在,
        true,
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("设提醒成功写 quick.schedule.add；失败请求不写审计；master 代操作记目标 Profile", async () => {
    const env = buildEnv();
    try {
      env.db
        .prepare(
          "INSERT INTO ledgers (id, name, created_at) VALUES ('l-family', '家庭账本', '2026-01-01T00:00:00.000Z')",
        )
        .run();
      const app = quickAppFor(env);
      // 失败请求（标题为空）：不应留下审计
      const bad = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({ title: "   " }),
      });
      assert.equal(bad.status, 400);
      assert.equal(
        (env.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number }).n,
        0,
      );

      const created = await app.request("/api/quick/schedules", {
        method: "POST",
        headers: bearer(BESTIE),
        body: JSON.stringify({
          title: "交房租",
          date: "2026-11-01",
          time: "09:00",
          note: "转账给房东",
          request_id: "audit-sch-1",
        }),
      });
      assert.equal(created.status, 201);
      const createdBody = await jsonBody(created);
      const row = env.db
        .prepare("SELECT * FROM audit_log WHERE action = 'quick.schedule.add'")
        .get() as {
        target_kind: string;
        target_id: string;
        detail_json: string;
        profile_id: string;
      };
      assert.equal(row.target_kind, "schedule");
      assert.equal(row.target_id, createdBody.id);
      assert.equal(row.profile_id, "bestie");
      const detail = JSON.parse(row.detail_json) as Record<string, unknown>;
      assert.equal(detail.标题, "交房租");
      assert.equal(detail.事件时间, "2026-11-01 09:00");
      assert.doesNotMatch(row.detail_json, /房东/, "备注全文不得进审计");

      // master 代 bestie 记账：审计身份必须是目标 Profile（谁的数据），而不是 master
      const delegated = await app.request("/api/quick/expenses?profile=bestie", {
        method: "POST",
        headers: bearer(MASTER),
        body: JSON.stringify({ amount: 5, ledger_id: "l-family" }),
      });
      assert.equal(delegated.status, 201);
      const delegatedRow = env.db
        .prepare("SELECT profile_id, target_id FROM audit_log WHERE action = 'quick.expense.add'")
        .get() as { profile_id: string; target_id: string };
      assert.equal(delegatedRow.profile_id, "bestie");
      assert.equal(delegatedRow.target_id, (await jsonBody(delegated)).id);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("/api/audit", () => {
  function appFor(env: TestEnv) {
    return createStatusApp(env.config, env.db);
  }

  function seedAuditRows(env: TestEnv): void {
    ensureBestie(env);
    seedAudit(env, {
      id: "a-default",
      profileId: "default",
      action: "quick.expense.add",
      targetKind: "expense",
      targetId: "e-default",
      createdAt: "2026-10-20T16:30:00.000Z", // 北京时间 2026-10-21 00:30
      detail: { 金额: 88, 备注: "default-only-detail" },
    });
    seedAudit(env, {
      id: "a-bestie",
      profileId: "bestie",
      action: "quick.schedule.add",
      targetKind: "schedule",
      targetId: "s-bestie",
      createdAt: "2026-10-21T01:00:00.000Z",
      detail: { 标题: "bestie 的提醒" },
    });
  }

  it("无凭据 401；master 全量；Profile token 只看到自己的记录且 detail 不跨 Profile", async () => {
    const env = buildEnv();
    try {
      seedAuditRows(env);
      const app = appFor(env);
      assert.equal((await app.request("/api/audit")).status, 401);

      const master = await app.request("/api/audit", { headers: bearer(MASTER) });
      assert.equal(master.status, 200);
      const masterBody = await jsonBody(master);
      assert.equal(masterBody.总数, 2);
      assert.equal(masterBody.偏移, 0);
      assert.equal(masterBody.还有更多, false);
      const masterRows = masterBody.记录 as Record<string, unknown>[];
      assert.equal(masterRows.length, 2);
      assert.deepEqual(Object.keys(masterRows[0] ?? {}).sort(), [
        "动作",
        "对象",
        "时间",
        "详情",
        "身份",
      ]);
      const bestieRow = masterRows.find((row) => row.身份 === "bestie");
      assert.equal(bestieRow?.动作, "quick.schedule.add");
      assert.equal(bestieRow?.对象, "schedule:s-bestie");
      assert.deepEqual(bestieRow?.详情, { 标题: "bestie 的提醒" });

      const profile = await app.request("/api/audit", { headers: bearer(BESTIE) });
      assert.equal(profile.status, 200);
      const profileBody = await jsonBody(profile);
      assert.equal(profileBody.总数, 1, "Profile token 只应看到自己的审计");
      const profileRows = profileBody.记录 as Record<string, unknown>[];
      assert.equal(profileRows.length, 1);
      assert.equal(profileRows[0]?.身份, "bestie");
      assert.doesNotMatch(
        JSON.stringify(profileBody),
        /default-only-detail/,
        "不得通过审计接口泄漏别人的 detail",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("本地时间渲染、分页、非法参数夹紧与空页", async () => {
    const env = buildEnv();
    try {
      seedAuditRows(env);
      const app = appFor(env);

      const first = await app.request("/api/audit?limit=1", { headers: bearer(MASTER) });
      const firstBody = await jsonBody(first);
      assert.equal(firstBody.总数, 2);
      assert.equal(firstBody.还有更多, true);
      const firstRows = firstBody.记录 as Record<string, unknown>[];
      assert.equal(firstRows.length, 1);
      // 最新一条（bestie 那条）在前
      assert.equal(firstRows[0]?.身份, "bestie");

      const second = await app.request("/api/audit?limit=1&offset=1", {
        headers: bearer(MASTER),
      });
      const secondBody = await jsonBody(second);
      assert.equal(secondBody.还有更多, false);
      const secondRows = secondBody.记录 as Record<string, unknown>[];
      assert.equal(secondRows[0]?.身份, "default");
      // UTC 16:30 必须显示成北京时间次日 00:30（前端不做时区推算）
      assert.equal(secondRows[0]?.时间, "2026-10-21 00:30");
      assert.equal(secondRows[0]?.对象, "expense:e-default");
      assert.deepEqual(secondRows[0]?.详情, { 金额: 88, 备注: "default-only-detail" });

      // 非法 limit/offset 回退缺省（limit 50 / offset 0），不是 400/500
      const invalid = await app.request("/api/audit?limit=abc&offset=-3", {
        headers: bearer(MASTER),
      });
      assert.equal(invalid.status, 200);
      const invalidBody = await jsonBody(invalid);
      assert.equal(invalidBody.偏移, 0);
      assert.equal((invalidBody.记录 as unknown[]).length, 2);

      // limit=0 夹到 1
      const zero = await app.request("/api/audit?limit=0", { headers: bearer(MASTER) });
      assert.equal((((await jsonBody(zero)).记录 as unknown[]) ?? []).length, 1);

      // 深偏移：空页但总数仍准确
      const deep = await app.request("/api/audit?offset=500", { headers: bearer(MASTER) });
      const deepBody = await jsonBody(deep);
      assert.equal(deepBody.总数, 2);
      assert.deepEqual(deepBody.记录, []);
      assert.equal(deepBody.还有更多, false);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
