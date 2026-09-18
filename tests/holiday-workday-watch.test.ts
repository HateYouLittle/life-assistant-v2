import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { importYear } from "../src/core/holiday.js";
import { allJobs } from "../src/core/registry.js";
import { runWorkdayWatch } from "../src/modules/holiday/index.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 阶段 C2：调休/补班提醒（job workday_watch）。
 * 全部使用假时钟（node:test mock timers）+ 临时库，绝不打真实外网。
 */

/** 固定到某个北京时间（Asia/Shanghai）日历日的凌晨 03:00 */
function freeze(t: TestContext, date: string): void {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(`${date}T03:00:00+08:00`) });
}

function setCst(t: TestContext, date: string): void {
  t.mock.timers.setTime(Date.parse(`${date}T03:00:00+08:00`));
}

const NATIONAL_DAY_HOLIDAYS = [
  "2026-10-01",
  "2026-10-02",
  "2026-10-03",
  "2026-10-04",
  "2026-10-05",
  "2026-10-06",
  "2026-10-07",
].map((date) => ({ name: "国庆节", date, isOffDay: true }));

/** 生产库口径：workday 行的 name 即所属假期名（如 2026-09-20 国庆节调休） */
function seed2026(env: TestEnv, workdays: string[] = ["2026-09-20", "2026-10-10"]): void {
  const days = [
    ...NATIONAL_DAY_HOLIDAYS,
    ...workdays.map((date) => ({ name: "国庆节", date, isOffDay: false })),
  ];
  importYear(env.db, { year: 2026, days }, "test");
}

interface NotifRow {
  kind: string;
  dedupe_key: string | null;
  title: string;
  body_md: string;
}

function notifications(env: TestEnv, profileId = "default"): NotifRow[] {
  return env.db
    .prepare(
      "SELECT kind, dedupe_key, title, body_md FROM notifications WHERE profile_id = ? ORDER BY created_at, id",
    )
    .all(profileId) as unknown as NotifRow[];
}

function addProfile(env: TestEnv, id: string): void {
  env.db
    .prepare("INSERT OR IGNORE INTO profiles (id, created_at) VALUES (?, ?)")
    .run(id, new Date().toISOString());
}

describe("holiday workday_watch：job 注册", () => {
  it("已注册，且 cron 走 config（默认每天早上 7 点）", () => {
    const env = makeTestEnv();
    try {
      const job = allJobs().find((j) => j.def.name === "workday_watch");
      assert.ok(job !== undefined, "应注册 workday_watch job");
      const cron = typeof job.def.cron === "function" ? job.def.cron() : job.def.cron;
      assert.equal(cron, "0 7 * * *");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday workday_watch：① 今天补班", () => {
  it("今天为 workday：推 1 条，标题含假期名，重复跑不重复推", async (t) => {
    freeze(t, "2026-09-20");
    const env = makeTestEnv();
    try {
      seed2026(env);
      await runWorkdayWatch();
      const rows = notifications(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.kind, "holiday.workday");
      assert.equal(rows[0]?.dedupe_key, "holiday:workday:2026-09-20");
      assert.match(rows[0]?.title ?? "", /国庆节/);
      await runWorkdayWatch();
      assert.equal(notifications(env).length, 1, "同日重复跑应被去重");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday workday_watch：② 假期临近", () => {
  it("首日距今 ≤3 天：推安排，正文含起止、天数与调休清单；重复跑不重复推", async (t) => {
    freeze(t, "2026-09-28");
    const env = makeTestEnv();
    try {
      seed2026(env);
      await runWorkdayWatch();
      const rows = notifications(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.kind, "holiday.period");
      assert.equal(rows[0]?.dedupe_key, "holiday:period:2026-10-01");
      assert.match(rows[0]?.title ?? "", /国庆节/);
      const body = rows[0]?.body_md ?? "";
      assert.match(body, /2026-10-01/);
      assert.match(body, /2026-10-07/);
      assert.match(body, /共 7 天/);
      // 2026-09-28 推送时 2026-09-20 已经过去，不应再列；2026-10-10 仍未到，正常列
      assert.match(body, /2026-10-10/);
      assert.doesNotMatch(body, /2026-09-20/);
      await runWorkdayWatch();
      assert.equal(notifications(env).length, 1, "同假期重复跑应被去重");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("边界：WORKDAY_REMIND_DAYS_BEFORE=5 时第 5 天推、第 6 天不推", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-26T03:00:00+08:00") });
    const env = makeTestEnv({ WORKDAY_REMIND_DAYS_BEFORE: "5" });
    try {
      seed2026(env);
      await runWorkdayWatch();
      assert.equal(notifications(env).length, 1, "距首日 5 天应推送");
    } finally {
      cleanupTestEnv(env);
    }

    setCst(t, "2026-09-25");
    const env2 = makeTestEnv({ WORKDAY_REMIND_DAYS_BEFORE: "5" });
    try {
      seed2026(env2);
      await runWorkdayWatch();
      assert.equal(notifications(env2).length, 0, "距首日 6 天不应推送");
    } finally {
      cleanupTestEnv(env2);
    }
  });

  it("首日当天不算「临近」（今天不早于首日不推该条）", async (t) => {
    freeze(t, "2026-10-02");
    const env = makeTestEnv();
    try {
      seed2026(env);
      await runWorkdayWatch();
      assert.equal(notifications(env).length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday workday_watch：② 假期临近 — 调休清单只列未来", () => {
  it("已过去的调休日不出现，未来调休日正常列出（反向断言）", async (t) => {
    freeze(t, "2026-09-28");
    const env = makeTestEnv();
    try {
      seed2026(env);
      await runWorkdayWatch();
      const body = notifications(env)[0]?.body_md ?? "";
      assert.match(body, /调休上班日：2026-10-10/);
      assert.doesNotMatch(body, /2026-09-20/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("该假期数据里本来就没有调休日：仍输出「本假期无调休上班日」", async (t) => {
    freeze(t, "2026-09-28");
    const env = makeTestEnv();
    try {
      seed2026(env, []);
      await runWorkdayWatch();
      const body = notifications(env)[0]?.body_md ?? "";
      assert.match(body, /本假期无调休上班日/);
      assert.doesNotMatch(body, /调休上班日：/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("调休日全部已过完：整行省略，不再输出「本假期无调休上班日」", async (t) => {
    freeze(t, "2026-09-28");
    const env = makeTestEnv();
    try {
      seed2026(env, ["2026-09-20"]);
      await runWorkdayWatch();
      const body = notifications(env)[0]?.body_md ?? "";
      assert.match(body, /2026-10-01/);
      assert.doesNotMatch(body, /调休上班日/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday workday_watch：③ 假期最后一天", () => {
  it("今天是区间最末一天：推「明天恢复正常上班」", async (t) => {
    freeze(t, "2026-10-07");
    const env = makeTestEnv();
    try {
      seed2026(env);
      await runWorkdayWatch();
      const rows = notifications(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.kind, "holiday.lastday");
      assert.equal(rows[0]?.dedupe_key, "holiday:lastday:2026-10-07");
      assert.match(rows[0]?.body_md ?? "", /明天（2026-10-08）恢复正常上班/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday workday_watch：不推场景", () => {
  it("普通工作日 / 普通周末 / 无临近假期：都不推", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-20T03:00:00+08:00") });
    const env = makeTestEnv();
    try {
      seed2026(env);
      for (const date of ["2026-10-20", "2026-10-17", "2026-11-15"]) {
        setCst(t, date);
        await runWorkdayWatch();
      }
      assert.equal(notifications(env).length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday workday_watch：数据未就绪", () => {
  it("年份数据 unknown：三个触发全部跳过，不推不抛", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-09-20T03:00:00+08:00") });
    const env = makeTestEnv();
    try {
      for (const date of ["2026-09-20", "2026-10-01", "2026-10-07"]) {
        setCst(t, date);
        await runWorkdayWatch();
      }
      assert.equal(notifications(env).length, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday workday_watch：多 Profile", () => {
  it("多 Profile 隔离：各推各的", async (t) => {
    freeze(t, "2026-09-28");
    const env = makeTestEnv();
    try {
      seed2026(env);
      addProfile(env, "p1");
      addProfile(env, "p2");
      await runWorkdayWatch();
      assert.equal(notifications(env, "default").length, 1);
      assert.equal(notifications(env, "p1").length, 1);
      assert.equal(notifications(env, "p2").length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("单个 Profile 异常不拖垮其它 Profile", async (t) => {
    freeze(t, "2026-09-28");
    const env = makeTestEnv();
    try {
      seed2026(env);
      addProfile(env, "a_bad");
      addProfile(env, "b_good");
      // 坏掉的 push_route（非法 JSON）会让该 Profile 的 publishProfile 抛错
      env.db
        .prepare(
          "INSERT INTO settings (profile_id, key, value_json, updated_at) VALUES ('a_bad', 'push_route', '{bad', ?)",
        )
        .run(new Date().toISOString());
      await runWorkdayWatch();
      assert.equal(notifications(env, "a_bad").length, 0, "坏行 Profile 不应产生通知");
      assert.equal(notifications(env, "b_good").length, 1, "其它 Profile 不受影响");
      assert.equal(notifications(env, "default").length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
