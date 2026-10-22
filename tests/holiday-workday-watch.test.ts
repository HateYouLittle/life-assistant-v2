import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { DateTime } from "luxon";
import { importYear } from "../src/core/holiday.js";
import { allJobs } from "../src/core/registry.js";
import { runWorkdayWatch } from "../src/modules/holiday/index.js";
import { TZ } from "../src/time.js";
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

  it("次日是普通周末：说「周末正常休息」，不硬编码「恢复正常上班」（B4）", async (t) => {
    // 2026 元旦 1/1~1/3 放假（1/3 周六），1/4 周日是普通周末、没有调休补班行。
    // 真实数据里同形态：2019 清明/端午/中秋都是周五单日假，次日为普通周末。
    freeze(t, "2026-01-03");
    const env = makeTestEnv();
    try {
      importYear(
        env.db,
        {
          year: 2026,
          days: [
            { name: "元旦", date: "2026-01-01", isOffDay: true },
            { name: "元旦", date: "2026-01-02", isOffDay: true },
            { name: "元旦", date: "2026-01-03", isOffDay: true },
          ],
        },
        "test",
      );
      await runWorkdayWatch();
      const rows = notifications(env);
      const lastday = rows.find((row) => row.kind === "holiday.lastday");
      assert.ok(lastday !== undefined, "最后一天仍要提醒，只是文案不能撒谎");
      assert.match(lastday.body_md, /明天（2026-01-04）是周末，正常休息/);
      assert.doesNotMatch(lastday.body_md, /恢复上班/, "次日是周末时不能告诉用户「恢复正常上班」");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("次日数据未就绪：中性「假期结束」，不猜上班与否", async (t) => {
    freeze(t, "2026-01-03");
    const env = makeTestEnv();
    try {
      importYear(
        env.db,
        {
          year: 2026,
          days: [
            { name: "元旦", date: "2026-01-01", isOffDay: true },
            { name: "元旦", date: "2026-01-02", isOffDay: true },
            { name: "元旦", date: "2026-01-03", isOffDay: true },
          ],
        },
        "test",
      );
      // today 的 dayType 优先按行命中（仍是 holiday），但次日 2026-01-04 不在表里、
      // 年份 metadata 又被降级 → dayType = unknown，文案不得猜「上班/休息」。
      env.db.prepare("UPDATE cn_holiday_years SET status = 'pending' WHERE year = 2026").run();
      await runWorkdayWatch();
      const lastday = notifications(env).find((row) => row.kind === "holiday.lastday");
      assert.ok(lastday !== undefined);
      assert.match(lastday.body_md, /明天（2026-01-04）假期结束/);
      assert.doesNotMatch(lastday.body_md, /上班|休息日/);
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
      // settings 的坏 JSON 已由 core/settings.ts 防御（按缺省值处理、不再抛错），
      // 因此改用 SQLite 触发器注入「该 Profile 的通知写入必然失败」，继续验证隔离性。
      env.db.exec(
        `CREATE TRIGGER fail_notification_a_bad BEFORE INSERT ON notifications
         WHEN NEW.profile_id = 'a_bad'
         BEGIN SELECT RAISE(ABORT, 'injected notification failure'); END;`,
      );
      await runWorkdayWatch();
      assert.equal(notifications(env, "a_bad").length, 0, "坏行 Profile 不应产生通知");
      assert.equal(notifications(env, "b_good").length, 1, "其它 Profile 不受影响");
      assert.equal(notifications(env, "default").length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday workday_watch：补班提示的单一来源", () => {
  /** 直接种一条今天的 weather.brief（真实 runDailyBrief 由 weather 模块的测试覆盖） */
  function seedBrief(env: TestEnv, profileId = "default"): void {
    env.db
      .prepare(
        `INSERT INTO notifications (id, profile_id, kind, title, body_md, blocks_json, dedupe_key, read, created_at)
         VALUES (?, ?, 'weather.brief', '北京 每日简报', '', '{}', ?, 0, ?)`,
      )
      .run(
        `brief-${profileId}`,
        profileId,
        `brief:${profileId}:北京:seed`,
        new Date().toISOString(),
      );
  }

  it("当天已有 weather.brief 也照常推补班通知（补班不再由早报承载）", async (t) => {
    // 回归：曾经的修法是「早报已送达就跳过 holiday.workday」，但真实库时序证明
    // workday_watch 总是先于 daily_brief 跑完，该判断在默认配置下永远为假。
    // 现在补班文案只在本模块出现，早报是否存在都不应影响这条通知。
    freeze(t, "2026-09-20");
    const env = makeTestEnv();
    try {
      seed2026(env);
      seedBrief(env);
      await runWorkdayWatch();
      const rows = notifications(env);
      const workdays = rows.filter((row) => row.kind === "holiday.workday");
      assert.equal(workdays.length, 1, "补班提醒只由调休模块发且只发一条");
      assert.equal(workdays[0]?.dedupe_key, "holiday:workday:2026-09-20");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("同一天重复跑仍只落一条（dedupeKey 保持 holiday:workday:<date>）", async (t) => {
    freeze(t, "2026-09-20");
    const env = makeTestEnv();
    try {
      seed2026(env);
      await runWorkdayWatch();
      await runWorkdayWatch();
      assert.equal(notifications(env).filter((r) => r.kind === "holiday.workday").length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("holiday workday_watch：启动补发按原定触发日（M2）", () => {
  it("晚 cron 跨午夜补发：at=前一天 22:00 仍推假期最后一天（按 now 则整条丢失）", async (t) => {
    t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-01-04T01:00:00+08:00") });
    const env = makeTestEnv();
    try {
      importYear(
        env.db,
        {
          year: 2026,
          days: [
            { name: "元旦", date: "2026-01-01", isOffDay: true },
            { name: "元旦", date: "2026-01-02", isOffDay: true },
            { name: "元旦", date: "2026-01-03", isOffDay: true },
          ],
        },
        "test",
      );
      // 不传 at（当前时钟 01-04 凌晨）：01-04 不是补班、假期也已结束 → 零通知
      await runWorkdayWatch();
      assert.equal(notifications(env).length, 0, "按 now() 算会整条丢失");

      // daemon 补发会传原定触发时刻（本地 01-03 22:00）→ 业务日 01-03 = 假期最后一天
      await runWorkdayWatch(DateTime.fromISO("2026-01-03T22:00:00", { zone: TZ }));
      const rows = notifications(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.kind, "holiday.lastday");
      assert.equal(rows[0]?.dedupe_key, "holiday:lastday:2026-01-03");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
