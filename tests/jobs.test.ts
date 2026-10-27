import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import {
  CATCHUP_POLICY,
  INTERRUPTED_RUN_ERROR,
  JOB_RUN_KEEP_DAYS,
  finishJobRun,
  lastJobRun,
  markInterruptedJobRuns,
  planCatchups,
  previousFireTime,
  pruneJobRuns,
  recentJobRuns,
  runStartupCatchups,
  startJobRun,
} from "../src/core/jobs.js";
import { allJobs, type JobDef } from "../src/core/registry.js";
import { now as localNow, TZ } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";
// 副作用 import：注册全部模块，才能用 allJobs() 核对补发策略表的键（与 daemon 同一份注册表）
import { registerAllModules } from "../src/modules/index.js";

/**
 * job_runs 记录 / 启动补发 / 运行记录保留。补发判定是本文件的核心：
 * 「停机错过 → 补跑」「已经跑过 → 不补」「超窗 → 不补」三种结论都必须能单测出来，
 * 否则线上只能靠等一天看有没有推送来验证。
 */

function atLocal(localIso: string): DateTime {
  const dt = DateTime.fromISO(localIso, { zone: TZ });
  assert.ok(dt.isValid, `夹具时间不合法: ${localIso}`);
  return dt;
}

function def(name: string, cron: string | (() => string)): JobDef {
  return { name, cron, handler: () => {} };
}

/** 写入一条历史运行记录（绕过 startJobRun 以便指定任意时间戳） */
function insertRun(
  env: TestEnv,
  over: {
    jobName: string;
    status: string;
    startedAt: string;
    finishedAt?: string | null;
    scheduledFor?: string;
    module?: string;
    trigger?: string;
    error?: string | null;
  },
): void {
  env.db
    .prepare(
      `INSERT INTO job_runs (job_name, module, trigger, scheduled_for, started_at, finished_at, status, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      over.jobName,
      over.module ?? "weather",
      over.trigger ?? "cron",
      over.scheduledFor ?? over.startedAt,
      over.startedAt,
      over.finishedAt === undefined ? over.startedAt : over.finishedAt,
      over.status,
      over.error ?? null,
    );
}

describe("previousFireTime（cron 反向求值）", () => {
  it("每日 07:00：取最近一次、含当前分钟", () => {
    const prev = previousFireTime("0 7 * * *", atLocal("2026-10-20T08:30:00"));
    assert.equal(prev?.setZone(TZ).toFormat("yyyy-LL-dd HH:mm"), "2026-10-20 07:00");
    // 返回的必须是 UTC 瞬间：DB 里所有时间戳都是 ...Z，混入 +08:00 偏移会让字符串比较出错
    assert.match(prev?.toISO() ?? "", /Z$/);

    // 恰好在触发分钟内（daemon 在此刻启动）→ 这次触发对当前进程就是「刚错过」
    assert.equal(
      previousFireTime("0 7 * * *", atLocal("2026-10-20T07:00:00"))?.setZone(TZ).toFormat("HH:mm"),
      "07:00",
    );
    // 差一分钟 → 上一次是昨天
    assert.equal(
      previousFireTime("0 7 * * *", atLocal("2026-10-20T06:59:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-19 07:00",
    );
  });

  it("6 段带秒表达式：丢掉秒字段按分钟反查（P2-19 兼容兜底）", () => {
    // 配置层已拒绝 6 段；这里兜住代码内新增的 job 定义。秒级触发最多差 59s，
    // 对「每天一次」的补发语义无影响，但绝不能返回 null 导致静默不补发。
    assert.equal(
      previousFireTime("30 0 7 * * *", atLocal("2026-10-20T08:30:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-20 07:00",
    );
  });

  it("*/20 每 20 分钟：08:05 → 08:00，08:00 → 08:00", () => {
    assert.equal(
      previousFireTime("*/20 * * * *", atLocal("2026-10-20T08:05:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "08:00",
    );
    assert.equal(
      previousFireTime("*/20 * * * *", atLocal("2026-10-20T08:00:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "08:00",
    );
    assert.equal(
      previousFireTime("*/20 * * * *", atLocal("2026-10-20T08:19:59"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "08:00",
    );
  });

  it("逗号列表 + 小时范围：0,30 8-9 * * *", () => {
    assert.equal(
      previousFireTime("0,30 8-9 * * *", atLocal("2026-10-20T09:10:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "09:00",
    );
    assert.equal(
      previousFireTime("0,30 8-9 * * *", atLocal("2026-10-20T09:40:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "09:30",
    );
    assert.equal(
      previousFireTime("0,30 8-9 * * *", atLocal("2026-10-20T10:00:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "09:30",
    );
  });

  it("日/月不是 * 时返回 null（宁可漏补，也不猜）；星期已支持", () => {
    const at = atLocal("2026-10-20T09:00:00");
    assert.equal(previousFireTime("0 7 1 * *", at), null, "带日限制的表达式不支持");
    assert.equal(previousFireTime("0 7 * 1 *", at), null, "带月限制的表达式不支持");
  });

  it("星期限制：单值/列表/范围/步长都支持；`7` 仅允许单值/列表（M3）", () => {
    // 2026-10-20 是周二
    assert.equal(
      previousFireTime("0 7 * * 1-5", atLocal("2026-10-20T09:00:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-20 07:00",
      "周二在工作日范围内 → 当天 07:00",
    );
    // 周一 09:00 启动：上一周的周日 20:00（周报的默认 cron）必须能算出来
    const monday = atLocal("2026-10-19T09:00:00");
    assert.equal(
      previousFireTime("0 20 * * 0", monday)?.setZone(TZ).toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-18 20:00",
      "0 = 周日",
    );
    assert.equal(
      previousFireTime("0 20 * * 7", monday)?.setZone(TZ).toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-18 20:00",
      "7 = 周日（node-cron 同义）",
    );
    // 单值逗号列表里的 7：node-cron 会把 7 替换成 0，5,7 = 周五+周日，与 0 同义
    assert.equal(
      previousFireTime("0 20 * * 5,7", monday)?.setZone(TZ).toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-18 20:00",
      "5,7 = 周五 + 周日；周一之前最近的是周日",
    );
    // 2026-10-22 是周四；列表里只有周一/周三/周五 → 最近一次是周三
    assert.equal(
      previousFireTime("0 7 * * 1,3,5", atLocal("2026-10-22T09:00:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-21 07:00",
    );
    // 单项（非范围）的星期仍可正常反查
    assert.equal(
      previousFireTime("0 7 * * 6", atLocal("2026-10-22T09:00:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-17 07:00",
      "周六",
    );
    // 不含 7 的步长：*/2 = 周日/周二/周四/周六；周四 09:00 → 当天 07:00
    assert.equal(
      previousFireTime("0 7 * * */2", atLocal("2026-10-22T09:00:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-22 07:00",
      "0/2/4/6 映射为 周日/周二/周四/周六",
    );
    // 越界的星期字段仍返回 null（8 / 负数不在 0-7 内）
    assert.equal(previousFireTime("0 7 * * 8", atLocal("2026-10-20T09:00:00")), null);
  });

  it("星期范围/步长含 7：node-cron 先做字符串 7→0 再展开，语义与数值区间不一致 → 保守放弃（M3）", () => {
    const at = atLocal("2026-10-19T09:00:00");
    // node-cron 的实际展开：6-7 → 0-6（每天）、0-7 → 0-0（仅周日）、1-7/2 → {0}（仅周日）
    assert.equal(previousFireTime("0 20 * * 6-7", at), null, "6-7 在 node-cron 里是每天");
    assert.equal(previousFireTime("0 20 * * 5-7", at), null, "5-7 在 node-cron 里是周一~周五+周日");
    assert.equal(previousFireTime("0 20 * * 0-7", at), null, "0-7 在 node-cron 里只有周日");
    assert.equal(previousFireTime("0 20 * * 1-7/2", at), null, "1-7/2 在 node-cron 里只有周日");
    assert.equal(previousFireTime("0 20 * * */7", at), null, "步长含 7 同样保守放弃");
    // 不含 7 的范围/步长不受影响（范围+步长按 node-cron 的取模语义，见下一个用例）
    assert.notEqual(previousFireTime("0 20 * * 6", at), null);
    assert.notEqual(previousFireTime("0 20 * * 0-6", at), null);
    assert.notEqual(previousFireTime("0 20 * * 0-6/2", at), null);
  });

  it("范围+步长按 node-cron 的「展开后取模」语义：1-5/2 = 周二/周四（J1）", () => {
    // 2026-10-21 是周三；node-cron 的 1-5/2 只保留偶数 → {2,4} = 周二/周四
    assert.equal(
      previousFireTime("0 20 * * 1-5/2", atLocal("2026-10-21T09:00:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-20 20:00",
      "周三是 1-5/2 的空档，最近一次是周二 20:00",
    );
    // 2026-10-22 是周四：当天 20:00 之前 → 上一次是周四（同一候选由「含当前分钟」决定）
    assert.equal(
      previousFireTime("0 20 * * 1-5/2", atLocal("2026-10-22T21:00:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-22 20:00",
    );
    // 1-6/2 = {2,4,6} = 周二/周四/周六；0-6/2 = {0,2,4,6} = 周日/周二/周四/周六
    assert.equal(
      previousFireTime("0 20 * * 1-6/2", atLocal("2026-10-18T09:00:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-17 20:00",
      "周六 20:00（-6 的 Sat）",
    );
    assert.equal(
      previousFireTime("0 20 * * 0-6/2", atLocal("2026-10-19T09:00:00"))
        ?.setZone(TZ)
        .toFormat("yyyy-LL-dd HH:mm"),
      "2026-10-18 20:00",
      "周日 20:00（0 属于 0-6/2）",
    );
  });

  it("分钟/小时字段的范围+步长同样取模：9-18/2 = 10/12/14/16/18（J1）", () => {
    assert.equal(
      previousFireTime("0 9-18/2 * * *", atLocal("2026-10-20T19:00:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "18:00",
      "9-18/2 含 18；不是「9、11、13…」",
    );
    assert.equal(
      previousFireTime("0 9-18/2 * * *", atLocal("2026-10-20T17:30:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "16:00",
      "17 是奇数不在集合内",
    );
    // 范围端点 a>b 会交换（node-cron range-conversion）：18-9/2 与 9-18/2 等价
    assert.equal(
      previousFireTime("0 18-9/2 * * *", atLocal("2026-10-20T19:00:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "18:00",
    );
    // 分钟：*/20 仍是 0/20/40；单值 a/n 只有 a%n===0 时才产生值
    assert.equal(
      previousFireTime("*/20 * * * *", atLocal("2026-10-20T08:45:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "08:40",
    );
    assert.equal(
      previousFireTime("5/5 * * * *", atLocal("2026-10-20T10:17:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "10:05",
      "5/5 = {5}（5%5===0）",
    );
    assert.equal(
      previousFireTime("5/2 * * * *", atLocal("2026-10-20T10:17:00")),
      null,
      "5%2!==0 → 空集",
    );
    // 逗号 + 步长：node-cron 是对展开后的值逐个取模（1,5/2 → 空集 → 无触发）
    assert.equal(previousFireTime("1,5/2 * * * *", atLocal("2026-10-20T10:17:00")), null);
    // 2,4/2 逐个取模都命中 → {2,4}（步长不再生效于间距）
    assert.equal(
      previousFireTime("2,4/2 * * * *", atLocal("2026-10-20T10:17:00"))
        ?.setZone(TZ)
        .toFormat("HH:mm"),
      "10:04",
    );
  });

  it("非法/超出范围的字段返回 null 而不是抛错", () => {
    const at = atLocal("2026-10-20T09:00:00");
    assert.equal(previousFireTime("not a cron", at), null);
    assert.equal(previousFireTime("0 7 * *", at), null, "段数不足");
    assert.equal(previousFireTime("60 7 * * *", at), null, "分钟越界");
    assert.equal(previousFireTime("0 25 * * *", at), null, "小时越界");
    assert.equal(previousFireTime("*/0 * * * *", at), null, "步长必须 ≥1");
    assert.equal(previousFireTime("0 7 * * *", DateTime.invalid("bad")), null);
  });
});

describe("job_runs 记录", () => {
  it("start → finish：running 行被回填成终态", () => {
    const env = makeTestEnv();
    try {
      const scheduledFor = "2026-10-19T23:00:00.000Z";
      const id = startJobRun(env.db, {
        jobName: "daily_brief",
        module: "weather",
        trigger: "cron",
        scheduledFor,
      });
      assert.ok(Number.isInteger(id) && id > 0, "startJobRun 应返回自增 id");

      const running = lastJobRun(env.db, "daily_brief");
      assert.equal(running?.status, "running");
      assert.equal(running?.trigger, "cron");
      assert.equal(running?.scheduled_for, scheduledFor);
      assert.equal(running?.finished_at, null);

      finishJobRun(env.db, id, "failed", "上游 503");
      const failed = lastJobRun(env.db, "daily_brief");
      assert.equal(failed?.status, "failed");
      assert.equal(failed?.error, "上游 503");
      assert.notEqual(failed?.finished_at, null);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("finishJobRun 不传 error 时写 NULL（不要把上一次的错误带到成功行上）", () => {
    const env = makeTestEnv();
    try {
      const id = startJobRun(env.db, {
        jobName: "refresh",
        module: "holiday",
        trigger: "startup",
        scheduledFor: "2026-10-20T00:00:00.000Z",
      });
      finishJobRun(env.db, id, "skipped");
      const row = lastJobRun(env.db, "refresh");
      assert.equal(row?.status, "skipped");
      assert.equal(row?.error, null);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("markInterruptedJobRuns 把遗留 running 行收敛成 failed（幂等，第二次 0 条）", () => {
    const env = makeTestEnv();
    try {
      const keptId = startJobRun(env.db, {
        jobName: "daily_backup",
        module: "maintenance",
        trigger: "cron",
        scheduledFor: "2026-10-20T00:00:00.000Z",
      });
      finishJobRun(env.db, keptId, "ok");
      startJobRun(env.db, {
        jobName: "daily_brief",
        module: "weather",
        trigger: "cron",
        scheduledFor: "2026-10-20T00:00:00.000Z",
      });

      assert.equal(markInterruptedJobRuns(env.db), 1);
      const interrupted = lastJobRun(env.db, "daily_brief");
      assert.equal(interrupted?.status, "failed");
      assert.equal(interrupted?.error, INTERRUPTED_RUN_ERROR);
      assert.notEqual(interrupted?.finished_at, null, "必须补上结束时间，否则看板显示不出耗时");
      assert.equal(lastJobRun(env.db, "daily_backup")?.status, "ok", "已结束的行不能被改写");
      assert.equal(markInterruptedJobRuns(env.db), 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("recentJobRuns：倒序、按 job 过滤、limit 夹紧", () => {
    const env = makeTestEnv();
    try {
      for (let i = 0; i < 3; i += 1) {
        insertRun(env, {
          jobName: "event_cleanup",
          startedAt: `2026-10-20T0${i}:00:00.000Z`,
          status: "ok",
        });
      }
      insertRun(env, {
        jobName: "retention",
        startedAt: "2026-10-21T00:00:00.000Z",
        status: "ok",
        module: "notify",
      });

      const all = recentJobRuns(env.db);
      assert.equal(all.length, 4);
      assert.equal(all[0]?.job_name, "retention", "最新的排最前");

      const filtered = recentJobRuns(env.db, { jobName: "event_cleanup", limit: 2 });
      assert.equal(filtered.length, 2);
      assert.deepEqual(
        filtered.map((row) => row.started_at),
        ["2026-10-20T02:00:00.000Z", "2026-10-20T01:00:00.000Z"],
      );
      // limit 为 0/负数时夹到 1，而不是返回空（调用方拿到空列表会误以为「没有记录」）
      assert.equal(recentJobRuns(env.db, { limit: 0 }).length, 1);
      assert.equal(lastJobRun(env.db, "不存在的任务"), undefined);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it(`pruneJobRuns 删除 ${JOB_RUN_KEEP_DAYS} 天前的记录，保留期可覆盖`, () => {
    const env = makeTestEnv();
    try {
      const now = Date.parse("2026-10-20T00:00:00.000Z");
      insertRun(env, { jobName: "old", startedAt: "2026-09-01T00:00:00.000Z", status: "ok" });
      insertRun(env, { jobName: "recent", startedAt: "2026-10-19T00:00:00.000Z", status: "ok" });

      assert.equal(pruneJobRuns(env.db, now, 7), 1, "只删超过 7 天的行");
      assert.equal(lastJobRun(env.db, "old"), undefined);
      assert.notEqual(lastJobRun(env.db, "recent"), undefined, "保留期内的行不受影响");

      insertRun(env, { jobName: "old2", startedAt: "2026-09-01T00:00:00.000Z", status: "ok" });
      assert.equal(pruneJobRuns(env.db, now), 1, "缺省保留期即 JOB_RUN_KEEP_DAYS");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("CATCHUP_POLICY（补发白名单）", () => {
  it("策略表的键都对应真实注册的 module.job（拼错就补不上）", () => {
    const registered = new Set(
      allJobs().map(({ module, def: jobDef }) => `${module}.${jobDef.name}`),
    );
    assert.ok(registered.size > 0, "模块未注册，无法核对策略表");
    for (const key of Object.keys(CATCHUP_POLICY)) {
      assert.ok(registered.has(key), `CATCHUP_POLICY 里的 "${key}" 不是已注册的 job（拼写错误？）`);
    }
  });

  it("关键任务都在白名单里，且窗口是正整数", () => {
    for (const key of [
      "weather.daily_brief",
      "weather.evening_brief",
      "weather.alert_watch",
      "holiday.workday_watch",
      "holiday.refresh",
      "maintenance.daily_backup",
      "maintenance.wal_checkpoint",
      "schedule.occurrence_cleanup",
      "notify.retention",
    ]) {
      assert.equal(typeof CATCHUP_POLICY[key], "number", `缺少补发策略: ${key}`);
    }
    for (const [key, hours] of Object.entries(CATCHUP_POLICY)) {
      assert.ok(Number.isInteger(hours) && hours > 0, `${key} 的窗口必须是正整数小时`);
    }
  });
});

describe("planCatchups（停机补发判定）", () => {
  const jobs = [{ module: "weather", def: def("daily_brief", "0 7 * * *") }];

  it("停机错过触发：产出一条补发（scheduled_for = 原定时刻）", () => {
    const env = makeTestEnv();
    try {
      const plans = planCatchups(env.db, jobs, atLocal("2026-10-20T09:00:00"));
      assert.equal(plans.length, 1);
      assert.equal(plans[0]?.module, "weather");
      assert.equal(plans[0]?.def.name, "daily_brief");
      assert.equal(plans[0]?.scheduledFor, "2026-10-19T23:00:00.000Z", "07:00 +08:00 = 23:00Z");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("已经成功跑过：不再补（finished_at 与 scheduled_for 两条证据任一满足即可）", () => {
    const env = makeTestEnv();
    try {
      const now = atLocal("2026-10-20T09:00:00");
      // 证据一：成功运行结束于原定时刻之后（无 scheduled_for 对齐也能判断）
      insertRun(env, {
        jobName: "daily_brief",
        status: "ok",
        startedAt: "2026-10-19T22:59:00.000Z",
        finishedAt: "2026-10-19T23:05:00.000Z",
        scheduledFor: "2026-10-19T22:00:00.000Z",
      });
      assert.deepEqual(planCatchups(env.db, jobs, now), []);

      // 证据二：更晚的触发已有成功记录（scheduled_for >= 原定时刻）
      env.db.prepare("DELETE FROM job_runs").run();
      insertRun(env, {
        jobName: "daily_brief",
        status: "ok",
        startedAt: "2026-10-20T00:10:00.000Z",
        finishedAt: "2026-10-20T00:11:00.000Z",
        scheduledFor: "2026-10-19T23:00:00.000Z",
      });
      assert.deepEqual(planCatchups(env.db, jobs, now), []);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("失败的运行不算「已补过」：仍要重试", () => {
    const env = makeTestEnv();
    try {
      insertRun(env, {
        jobName: "daily_brief",
        status: "failed",
        startedAt: "2026-10-19T23:01:00.000Z",
        finishedAt: "2026-10-19T23:02:00.000Z",
        error: "上游 503",
      });
      const plans = planCatchups(env.db, jobs, atLocal("2026-10-20T09:00:00"));
      assert.equal(plans.length, 1, "失败的那次不能当作已补发，否则永远补不上");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("超出补发窗口：不补（6 小时窗口，错过 8 小时就放弃）", () => {
    const env = makeTestEnv();
    try {
      assert.equal(planCatchups(env.db, jobs, atLocal("2026-10-20T15:00:00")).length, 0);
      // 边界内（恰好 6 小时）仍补
      assert.equal(planCatchups(env.db, jobs, atLocal("2026-10-20T13:00:00")).length, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("不在白名单 / cron 反向求值不支持 → 不补", () => {
    const env = makeTestEnv();
    try {
      const now = atLocal("2026-10-20T09:00:00");
      assert.deepEqual(
        planCatchups(
          env.db,
          [{ module: "bookkeeping", def: def("monthly_report", "0 9 1 * *") }],
          now,
        ),
        [],
        "月报不在白名单（它有自己 6 个月回看的补发逻辑）",
      );
      assert.deepEqual(
        planCatchups(env.db, [{ module: "weather", def: def("daily_brief", "0 9 1 * *") }], now),
        [],
        "日/月不是 * 的 cron 仍无法可靠反向求值，宁可漏补",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("周任务（dow≠*）现在可补发：周一启动能求出上周日 20:00", () => {
    const env = makeTestEnv();
    try {
      const now = atLocal("2026-10-19T09:00:00"); // 周一 09:00
      const plans = planCatchups(
        env.db,
        [{ module: "bookkeeping", def: def("weekly_report", "0 20 * * 0") }],
        now,
      );
      assert.equal(plans.length, 1, "周报 cron 的星期字段已支持反向求值");
      assert.equal(
        plans[0]?.scheduledFor,
        "2026-10-18T12:00:00.000Z",
        "周日 20:00 +08:00 = 12:00Z（不是把「本周一」当原定时刻）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("cron 是函数（从 config 惰性读取）时同样可用", () => {
    const env = makeTestEnv();
    try {
      const plans = planCatchups(
        env.db,
        [{ module: "maintenance", def: def("daily_backup", () => "0 3 * * *") }],
        atLocal("2026-10-20T05:00:00"),
      );
      assert.equal(plans.length, 1);
      assert.equal(plans[0]?.scheduledFor, "2026-10-19T19:00:00.000Z");
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("runStartupCatchups（串行执行 + 失败隔离）", () => {
  it("按计划调用 runJob（trigger=catchup、带原定时刻），返回补发条数", async () => {
    const env = makeTestEnv();
    try {
      const calls: { module: string; name: string; trigger: string; scheduledFor: string }[] = [];
      const result = await runStartupCatchups({
        db: env.db,
        jobs: [{ module: "weather", def: def("daily_brief", "0 7 * * *") }],
        runJob: async (module, jobDef, trigger, scheduledFor) => {
          calls.push({ module, name: jobDef.name, trigger, scheduledFor });
        },
        now: atLocal("2026-10-20T09:00:00"),
      });
      assert.deepEqual(result, { scheduled: 1, succeeded: 1, failed: 0 });
      assert.deepEqual(calls, [
        {
          module: "weather",
          name: "daily_brief",
          trigger: "catchup",
          scheduledFor: "2026-10-19T23:00:00.000Z",
        },
      ]);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("单个 job 失败只记日志，其余照常补发", async () => {
    const env = makeTestEnv();
    try {
      const attempted: string[] = [];
      const result = await runStartupCatchups({
        db: env.db,
        jobs: [
          { module: "weather", def: def("daily_brief", "0 7 * * *") },
          { module: "holiday", def: def("refresh", "0 2 * * *") },
        ],
        runJob: async (_module, jobDef) => {
          attempted.push(jobDef.name);
          if (jobDef.name === "refresh") throw new Error("上游 503");
        },
        now: atLocal("2026-10-20T09:00:00"),
      });
      // planCatchups 按 module.name 排序：holiday.refresh 先于 weather.daily_brief
      assert.deepEqual(attempted, ["refresh", "daily_brief"], "第一个失败不应中断第二个");
      assert.deepEqual(
        result,
        { scheduled: 2, succeeded: 1, failed: 1 },
        "失败算 failed，不能把「尝试数」当「成功数」（P2-16）",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("runJob 返回 failed（runExclusive 吞掉异常）也计入失败，不能当成功", async () => {
    const env = makeTestEnv();
    try {
      const result = await runStartupCatchups({
        db: env.db,
        jobs: [{ module: "weather", def: def("daily_brief", "0 7 * * *") }],
        // 真实 daemon 里 runExclusive 捕获异常后 resolve，只能靠返回值区分成败
        runJob: async () => "failed",
        now: atLocal("2026-10-20T09:00:00"),
      });
      assert.deepEqual(result, { scheduled: 1, succeeded: 0, failed: 1 });
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("没有错过触发时不调用任何 job", async () => {
    const env = makeTestEnv();
    try {
      let called = 0;
      const result = await runStartupCatchups({
        db: env.db,
        jobs: [{ module: "weather", def: def("daily_brief", "0 7 * * *") }],
        runJob: async () => {
          called += 1;
        },
        // 07:00 之后 8 小时：超出 6 小时窗口
        now: atLocal("2026-10-20T15:00:00"),
      });
      assert.deepEqual(result, { scheduled: 0, succeeded: 0, failed: 0 });
      assert.equal(called, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("运行记录保留接线（notify.retention 顺带清理）", () => {
  function retentionJob() {
    // 幂等：modules/index.ts 的副作用 import 已完成注册，这里只是拿真实模块清单
    registerAllModules();
    const job = allJobs().find(
      (entry) => entry.module === "notify" && entry.def.name === "retention",
    );
    assert.ok(job !== undefined, "应注册 notify.retention job");
    return job;
  }

  it("retention job 执行后删除 30 天前的 job_runs，保留期内的不动", async () => {
    const env = makeTestEnv();
    try {
      insertRun(env, { jobName: "ancient", startedAt: "2020-01-01T00:00:00.000Z", status: "ok" });
      insertRun(env, {
        jobName: "fresh",
        startedAt: new Date().toISOString(),
        status: "ok",
      });

      await retentionJob().def.handler(localNow());

      assert.equal(lastJobRun(env.db, "ancient"), undefined, "超过保留期的运行记录应被清理");
      assert.notEqual(lastJobRun(env.db, "fresh"), undefined, "保留期内的运行记录不受影响");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
