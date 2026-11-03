import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { createHttpHandler } from "../src/daemon.js";
import {
  ACTION_LINK_EXPIRED_MESSAGE,
  ACTION_LINK_INVALID_MESSAGE,
  actionTokenFingerprint,
  reminderActionLinks,
  signActionToken,
  verifyActionToken,
} from "../src/core/action-link.js";
import { setNotifyPrefs } from "../src/core/notify-prefs.js";
import { scheduleTool } from "../src/modules/schedule/index.js";
import { cleanupTestEnv, makeTestEnv, SECRET, type TestEnv } from "./helpers.js";

/**
 * 推送里的一键操作链接：
 * 1. 签名 token 的签发 / 验签 / 过期 / 篡改（含非规范 base64 写法）；
 * 2. `reminderActionLinks` 的三个「不发链接」前提（关偏好 / 无基址 / 无密钥）与反代子路径；
 * 3. HTTP 层：GET 只渲染不写库、POST 才执行、重复 POST 幂等、篡改 403、过期 403。
 */

/** 用「今天」而不是写死日期：一次性日程的过去日期会被服务端直接拒绝（教训同 5cb6ca1） */
const D = DateTime.now().setZone("Asia/Shanghai").toISODate() as string;

function envServices(env: TestEnv) {
  return {
    publishProfile: async (profileId: string, input: { kind: string }) => {
      env.published.push({ profileId, input: input as never });
      return { id: `n-${env.published.length}`, deduped: false };
    },
    publishGlobal: async () => ({ materialized: 0 }),
  };
}

function tool(env: TestEnv, args: Record<string, unknown>, profileId = "default") {
  return scheduleTool(args, {
    profileId,
    db: env.db,
    config: env.config,
    services: envServices(env),
  }) as { content: { text: string }[]; isError?: boolean };
}

function addOnce(env: TestEnv): string {
  const result = tool(env, { action: "add", title: "打下班卡", date: D, time: "17:30" });
  assert.notEqual(result.isError, true, result.content[0]?.text ?? "");
  return (JSON.parse(result.content[0]?.text ?? "{}") as { 已创建: { id: string } }).已创建.id;
}

function firstKey(env: TestEnv, id: string): string {
  const row = env.db
    .prepare(
      "SELECT occurrence_key FROM occurrences WHERE schedule_id = ? ORDER BY event_at, occurrence_key LIMIT 1",
    )
    .get(id) as { occurrence_key: string } | undefined;
  assert.ok(row !== undefined, "应当已物化出 occurrence");
  return row.occurrence_key;
}

function occurrenceStatus(env: TestEnv, id: string, key: string): string | undefined {
  const row = env.db
    .prepare("SELECT status FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
    .get(id, key) as { status: string } | undefined;
  return row?.status;
}

function auditCount(env: TestEnv): number {
  const row = env.db.prepare("SELECT COUNT(*) AS n FROM audit_log").get() as { n: number };
  return row.n;
}

const LINK_ENV = {
  WEB_API_TOKEN: SECRET,
  WEB_ALLOWED_HOSTS: "192.168.31.20:3080",
};

/** 起一个真实 HTTP 服务（端口 0），返回基址 */
function serve(env: TestEnv): Promise<{ server: Server; base: string }> {
  const server = createServer(createHttpHandler(env.config, env.db));
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

describe("一键操作链接：签名", () => {
  it("签发后可验签，载荷原样返回", () => {
    const env = makeTestEnv(LINK_ENV);
    try {
      const token = signActionToken(
        env.config,
        { profileId: "default", scheduleId: "s-1", occurrenceKey: `${D}T17:30#0`, action: "done" },
        Date.now() + 60_000,
      );
      const verdict = verifyActionToken(env.config, token);
      assert.deepEqual(verdict.ok && verdict.claims, {
        profileId: "default",
        scheduleId: "s-1",
        occurrenceKey: `${D}T17:30#0`,
        action: "done",
        exp: Math.floor((Date.now() + 60_000) / 1000),
      });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("篡改载荷 / 篡改签名 / 非规范 base64 写法一律签名无效", () => {
    const env = makeTestEnv(LINK_ENV);
    try {
      const token = signActionToken(
        env.config,
        { profileId: "default", scheduleId: "s-1", occurrenceKey: `${D}T17:30#0`, action: "done" },
        Date.now() + 60_000,
      );
      const [payload, sig] = token.split(".") as [string, string];

      // 把 action=done 改成 snooze30（重新编码载荷，签名不变）
      const forgedPayload = Buffer.from(
        Buffer.from(payload, "base64url").toString("utf8").replace("|done|", "|snooze30|"),
        "utf8",
      ).toString("base64url");
      const forged = verifyActionToken(env.config, `${forgedPayload}.${sig}`);
      assert.equal(forged.ok, false);
      assert.equal(forged.ok === false && forged.message, ACTION_LINK_INVALID_MESSAGE);

      // 只改签名末位
      const badSig = sig.slice(0, -1) + (sig.endsWith("A") ? "B" : "A");
      const badSigVerdict = verifyActionToken(env.config, `${payload}.${badSig}`);
      assert.equal(badSigVerdict.ok, false);

      // 结构不合法
      for (const bad of ["", "abc", `${payload}`, `${payload}.${sig}.extra`, "a.b"]) {
        assert.equal(verifyActionToken(env.config, bad).ok, false, `应拒绝: ${bad}`);
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("过期（超过 60 秒时钟偏移）单独区分过期文案", () => {
    const env = makeTestEnv(LINK_ENV);
    try {
      const token = signActionToken(
        env.config,
        { profileId: "default", scheduleId: "s-1", occurrenceKey: `${D}T17:30#0`, action: "done" },
        Date.now() - 10 * 60_000,
      );
      const verdict = verifyActionToken(env.config, token);
      assert.equal(verdict.ok, false);
      assert.equal(verdict.ok === false && verdict.message, ACTION_LINK_EXPIRED_MESSAGE);
      assert.equal(verdict.ok === false && verdict.reason, "expired");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("一键操作链接：正文链接行", () => {
  it("默认为循环/一次性待办生成「完成」+「推迟」两条，基址取非回环条目", () => {
    const env = makeTestEnv(LINK_ENV);
    try {
      const lines = reminderActionLinks(env.config, env.db, {
        profileId: "default",
        scheduleId: "s-1",
        occurrenceKey: `${D}T17:30#0`,
        snoozable: true,
      });
      assert.equal(lines.length, 2);
      assert.match(lines[0] as string, /^完成：http:\/\/192\.168\.31\.20:3080\/a\//);
      assert.match(lines[1] as string, /^推迟 30 分钟：http:\/\/192\.168\.31\.20:3080\/a\//);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("派生提醒行（不可推迟）只给「完成」", () => {
    const env = makeTestEnv(LINK_ENV);
    try {
      const lines = reminderActionLinks(env.config, env.db, {
        profileId: "default",
        scheduleId: "s-1",
        occurrenceKey: `${D}T17:30#0:resend`,
        snoozable: false,
      });
      assert.equal(lines.length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("PUBLIC_BASE_URL 优先，且保留反代子路径", () => {
    const env = makeTestEnv({
      ...LINK_ENV,
      PUBLIC_BASE_URL: "https://life.wdshare.top:30301/life/",
    });
    try {
      const lines = reminderActionLinks(env.config, env.db, {
        profileId: "default",
        scheduleId: "s-1",
        occurrenceKey: `${D}T17:30#0`,
        snoozable: false,
      });
      assert.match(lines[0] as string, /^完成：https:\/\/life\.wdshare\.top:30301\/life\/a\//);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("关掉 links 偏好后不追加链接", () => {
    const env = makeTestEnv(LINK_ENV);
    try {
      setNotifyPrefs(env.db, "default", { "schedule.reminder": { links: false } });
      const lines = reminderActionLinks(env.config, env.db, {
        profileId: "default",
        scheduleId: "s-1",
        occurrenceKey: `${D}T17:30#0`,
        snoozable: true,
      });
      assert.deepEqual(lines, []);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("没有可用基址（主机只有回环）或没有签名密钥时不追加链接", () => {
    const loopbackOnly = makeTestEnv({ WEB_API_TOKEN: SECRET, WEB_ALLOWED_HOSTS: "127.0.0.1" });
    try {
      assert.deepEqual(
        reminderActionLinks(loopbackOnly.config, loopbackOnly.db, {
          profileId: "default",
          scheduleId: "s-1",
          occurrenceKey: `${D}T17:30#0`,
          snoozable: true,
        }),
        [],
      );
    } finally {
      cleanupTestEnv(loopbackOnly);
    }

    const noToken = makeTestEnv({ WEB_ALLOWED_HOSTS: "192.168.31.20:3080" });
    try {
      assert.deepEqual(
        reminderActionLinks(noToken.config, noToken.db, {
          profileId: "default",
          scheduleId: "s-1",
          occurrenceKey: `${D}T17:30#0`,
          snoozable: true,
        }),
        [],
      );
    } finally {
      cleanupTestEnv(noToken);
    }
  });

  it("PUBLIC_BASE_URL 填回环地址直接拒绝启动（生成的链接手机一定打不开）", () => {
    assert.throws(
      () => makeTestEnv({ ...LINK_ENV, PUBLIC_BASE_URL: "http://127.0.0.1:3080" }),
      /回环|通配/,
    );
    assert.throws(
      () => makeTestEnv({ ...LINK_ENV, PUBLIC_BASE_URL: "http://0.0.0.0:3080" }),
      /回环|通配/,
    );
  });
});

describe("一键操作链接：HTTP 行为", () => {
  it("GET 只渲染确认页不写库，POST 才完成；重复 POST 幂等", async () => {
    const env = makeTestEnv(LINK_ENV);
    const { server, base } = await serve(env);
    try {
      const id = addOnce(env);
      const key = firstKey(env, id);
      const host = base.replace("http://", "");
      const token = signActionToken(
        env.config,
        { profileId: "default", scheduleId: id, occurrenceKey: key, action: "done" },
        Date.now() + 60_000,
      );
      const url = `${base}/a/${token}`;
      const before = auditCount(env);

      const get = await fetch(url, { headers: { Host: host } });
      const getBody = await get.text();
      assert.equal(get.status, 200);
      assert.match(getBody, /确认|完成/);
      assert.equal(occurrenceStatus(env, id, key), "pending", "GET 不得改动 occurrence");
      assert.equal(auditCount(env), before, "GET 不得写审计");

      const post = await fetch(url, { method: "POST", headers: { Host: host } });
      assert.equal(post.status, 200);
      assert.notEqual(occurrenceStatus(env, id, key), "pending", "POST 应当完成该次");
      assert.equal(auditCount(env), before + 1, "POST 应落一条审计");

      const again = await fetch(url, { method: "POST", headers: { Host: host } });
      const againBody = await again.text();
      assert.equal(again.status, 200);
      assert.match(againBody, /已经处理过/);
      assert.equal(auditCount(env), before + 1, "重复 POST 不再写审计");

      const getAfter = await fetch(url, { headers: { Host: host } });
      assert.match(await getAfter.text(), /已经处理过/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanupTestEnv(env);
    }
  });

  it("篡改 token → 403 签名无效；过期 token → 403 已过期", async () => {
    const env = makeTestEnv(LINK_ENV);
    const { server, base } = await serve(env);
    try {
      const id = addOnce(env);
      const key = firstKey(env, id);
      const host = base.replace("http://", "");
      const token = signActionToken(
        env.config,
        { profileId: "default", scheduleId: id, occurrenceKey: key, action: "done" },
        Date.now() + 60_000,
      );
      const [payload, sig] = token.split(".") as [string, string];

      const tampered = await fetch(`${base}/a/${payload}.${sig.slice(0, -1)}Z`, {
        method: "POST",
        headers: { Host: host },
      });
      assert.equal(tampered.status, 403);
      assert.match(await tampered.text(), /签名无效/);
      assert.equal(occurrenceStatus(env, id, key), "pending", "验签失败不得执行动作");

      const expiredToken = signActionToken(
        env.config,
        { profileId: "default", scheduleId: id, occurrenceKey: key, action: "done" },
        Date.now() - 10 * 60_000,
      );
      const expired = await fetch(`${base}/a/${expiredToken}`, { headers: { Host: host } });
      assert.equal(expired.status, 403);
      assert.match(await expired.text(), /链接已过期/);
      assert.equal(occurrenceStatus(env, id, key), "pending");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanupTestEnv(env);
    }
  });

  it("令牌指纹只进审计、不进 URL 以外的地方", async () => {
    const env = makeTestEnv(LINK_ENV);
    const { server, base } = await serve(env);
    try {
      const id = addOnce(env);
      const key = firstKey(env, id);
      const host = base.replace("http://", "");
      const beforeDueAt = (
        env.db
          .prepare("SELECT due_at FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?")
          .get(id, key) as { due_at: string }
      ).due_at;
      const token = signActionToken(
        env.config,
        { profileId: "default", scheduleId: id, occurrenceKey: key, action: "snooze30" },
        Date.now() + 60_000,
      );
      const res = await fetch(`${base}/a/${token}`, { method: "POST", headers: { Host: host } });
      assert.equal(res.status, 200);
      const row = env.db
        .prepare(
          "SELECT action, detail_json FROM audit_log WHERE target_id = ? ORDER BY rowid DESC LIMIT 1",
        )
        .get(id) as { action: string; detail_json: string };
      assert.equal(row.action, "link.schedule.snooze30");
      const detail = JSON.parse(row.detail_json) as { token?: string };
      assert.equal(detail.token, actionTokenFingerprint(token));
      assert.equal(row.detail_json.includes(token), false, "审计不得存 token 原文");
      // 推迟不改状态，只把 due_at 往后推 30 分钟（与 schedule snooze 的既有语义一致）
      const after = env.db
        .prepare(
          "SELECT status, due_at FROM occurrences WHERE schedule_id = ? AND occurrence_key = ?",
        )
        .get(id, key) as { status: string; due_at: string };
      assert.equal(after.status, "pending");
      const deltaMinutes = (Date.parse(after.due_at) - Date.parse(beforeDueAt)) / 60_000;
      assert.ok(
        Math.abs(deltaMinutes - 30) <= 1,
        `due_at 应推迟约 30 分钟，实际 ${deltaMinutes} 分钟`,
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      cleanupTestEnv(env);
    }
  });
});
