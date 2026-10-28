import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DateTime } from "luxon";
import { createJobRunner } from "../src/core/job-runner.js";
import { CATCHUP_POLICY, type JobRunRow } from "../src/core/jobs.js";
import { allJobs, type JobDef } from "../src/core/registry.js";
import { matchedFireSlot, recoverMissedExecutionsFor, scheduleJobCron } from "../src/daemon.js";
import { now, TZ } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";
// 副作用 import：注册全部模块，allJobs() 才有真实 job 清单（与 daemon 同一份注册表）
import "../src/modules/index.js";

/**
 * P2-14：cron 错过触发的回放（node-cron `recoverMissedExecutions`）。
 *
 * 只对 `CATCHUP_POLICY` 白名单开启 —— 白名单 job 本来就允许「迟到的补发」且有 dedupeKey；
 * 其余（含每分钟的 tick）保持默认，语义与改动前完全一致。
 *
 * 用例直接驱动 cron 回调（`task.now(<匹配时刻>)`）而不等整分钟，因此稳定且快；
 * `scheduled: false` 保证测试进程不留定时器。
 */

function fakeDef(name: string, handler: JobDef["handler"] = () => undefined): JobDef {
  return { name, cron: "*/20 * * * *", handler };
}

/** 断言 cron 任务注册选项里的 recoverMissedExecutions（@types/node-cron 没暴露 options） */
function recoverOptionOf(task: ReturnType<typeof scheduleJobCron>): boolean | undefined {
  return (task as unknown as { options: { recoverMissedExecutions?: boolean } }).options
    .recoverMissedExecutions;
}

/** 等一轮 job 跑完（run() 返回的 promise 在 finally 里从 inFlight 摘除） */
async function settle(runner: ReturnType<typeof createJobRunner>, name: string): Promise<void> {
  await runner.inFlight.get(name);
}

function jobRuns(env: ReturnType<typeof makeTestEnv>): JobRunRow[] {
  return env.db.prepare("SELECT * FROM job_runs ORDER BY id").all() as unknown as JobRunRow[];
}

describe("P2-14 cron 错过触发回放", () => {
  it("只对 CATCHUP_POLICY 白名单开启：非白名单 job 注册选项保持默认 false", () => {
    assert.equal(recoverMissedExecutionsFor("weather.daily_brief"), true);
    assert.equal(recoverMissedExecutionsFor("weather.alert_watch"), true);
    assert.equal(recoverMissedExecutionsFor("maintenance.daily_backup"), true);
    assert.equal(recoverMissedExecutionsFor("tick"), false);
    assert.equal(recoverMissedExecutionsFor("不存在的任务"), false);

    // 真实注册表：白名单里的键必须对应真实 job；且确实存在不开启的 job（否则等于全开）
    const jobs = allJobs().map(({ module, def }) => `${module}.${def.name}`);
    for (const key of Object.keys(CATCHUP_POLICY)) {
      assert.ok(jobs.includes(key), `CATCHUP_POLICY 的键 ${key} 没有对应的注册 job`);
    }
    assert.ok(
      jobs.some((key) => !recoverMissedExecutionsFor(key)),
      "至少有一个 job 不开回放（如 tick），否则「只对白名单开放」形同虚设",
    );
  });

  it("注册选项随白名单分叉：白名单 true、非白名单 false", () => {
    const env = makeTestEnv();
    const runner = createJobRunner(env.db, { timeoutMs: 0 });
    try {
      const on = scheduleJobCron("weather", fakeDef("daily_brief"), "*/20 * * * *", runner, {
        scheduled: false,
      });
      const off = scheduleJobCron("weather", fakeDef("tick"), "* * * * *", runner, {
        scheduled: false,
      });
      try {
        assert.equal(recoverOptionOf(on), true);
        assert.equal(recoverOptionOf(off), false);
      } finally {
        on.stop();
        off.stop();
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("错过的触发被补跑一次：写 job_runs（trigger=catchup + 原定时刻），handler 收到原定时刻", async () => {
    const env = makeTestEnv();
    const runner = createJobRunner(env.db, { timeoutMs: 0 });
    const handled: DateTime[] = [];
    const def = fakeDef("daily_brief", (at) => {
      handled.push(at);
    });
    const task = scheduleJobCron("weather", def, "*/20 * * * *", runner, { scheduled: false });
    try {
      // 伪造「事件循环被阻塞 3 分钟后，node-cron 回放 3 分钟前那一分钟」
      const missed = DateTime.now().setZone(TZ).minus({ minutes: 3 }).startOf("minute");
      task.now(missed.toJSDate());
      await settle(runner, "job:daily_brief");

      const rows = jobRuns(env);
      assert.equal(rows.length, 1, "补跑必须留下且只留下一条运行记录");
      assert.equal(rows[0]?.trigger, "catchup", "补跑必须与普通触发可区分");
      assert.equal(rows[0]?.scheduled_for, missed.toUTC().toISO(), "scheduled_for 记原定时刻");
      assert.equal(rows[0]?.status, "ok");
      assert.equal(handled.length, 1);
      assert.equal(
        handled[0]?.toUTC().toISO(),
        missed.toUTC().toISO(),
        "handler 必须拿到原定时刻（早报/摘要按它取业务日期）",
      );
      // scheduled_for 与 started_at 的间隔 ≈ 3 分钟：启动补发（catchup）与本次回放
      // 都能靠「trigger=catchup 且 scheduled_for 明显早于 started_at」识别
      const startedAt = Date.parse(rows[0]?.started_at ?? "");
      const scheduledFor = Date.parse(rows[0]?.scheduled_for ?? "");
      assert.ok(
        startedAt - scheduledFor >= 2 * 60 * 1000,
        `scheduled_for 应早于 started_at 约 3 分钟（实际差 ${(startedAt - scheduledFor) / 1000}s）`,
      );
    } finally {
      task.stop();
      cleanupTestEnv(env);
    }
  });

  it("同一个触发时刻只跑一次：node-cron 的重复回放不会重复执行", async () => {
    const env = makeTestEnv();
    const runner = createJobRunner(env.db, { timeoutMs: 0 });
    let calls = 0;
    const def = fakeDef("daily_brief", () => {
      calls += 1;
    });
    const task = scheduleJobCron("weather", def, "*/20 * * * *", runner, { scheduled: false });
    try {
      const missed = DateTime.now().setZone(TZ).minus({ minutes: 2 }).startOf("minute");
      // node-cron 3.0.3 会把 lastExecution 归零到秒，同一个匹配秒在相邻两次轮询里各发一次：
      // 第 2 次必须被守卫吃掉，否则快任务会被执行两遍（备份会出两份文件）。
      task.now(missed.toJSDate());
      await settle(runner, "job:daily_brief");
      task.now(missed.plus({ seconds: 1 }).toJSDate());
      await settle(runner, "job:daily_brief");

      assert.equal(calls, 1, "同一个触发时刻不得执行两次");
      assert.equal(jobRuns(env).length, 1, "被守卫吃掉的重复触发不写第二条 job_runs");
    } finally {
      task.stop();
      cleanupTestEnv(env);
    }
  });

  it("正常到点触发不回归：trigger=cron、scheduled_for=当前时刻", async () => {
    const env = makeTestEnv();
    const runner = createJobRunner(env.db, { timeoutMs: 0 });
    const handled: DateTime[] = [];
    const def = fakeDef("daily_brief", (at) => {
      handled.push(at);
    });
    const task = scheduleJobCron("weather", def, "*/20 * * * *", runner, { scheduled: false });
    try {
      const firedAt = now();
      task.now(firedAt.toJSDate());
      await settle(runner, "job:daily_brief");

      const rows = jobRuns(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.trigger, "cron");
      const recorded = Date.parse(rows[0]?.scheduled_for ?? "");
      assert.ok(
        Number.isFinite(recorded) && Math.abs(recorded - firedAt.toMillis()) < 3000,
        `正常触发仍按实际触发时刻落库（记录 ${rows[0]?.scheduled_for}）`,
      );
      assert.equal(handled.length, 1);
    } finally {
      task.stop();
      cleanupTestEnv(env);
    }
  });

  it("非白名单 job 不受影响：即便收到过去时刻的匹配也按普通触发处理", async () => {
    const env = makeTestEnv();
    const runner = createJobRunner(env.db, { timeoutMs: 0 });
    const handled: DateTime[] = [];
    const def = fakeDef("not_whitelisted", (at) => {
      handled.push(at);
    });
    const task = scheduleJobCron("weather", def, "* * * * *", runner, { scheduled: false });
    try {
      const firedAt = now();
      task.now(firedAt.minus({ minutes: 5 }).toJSDate());
      await settle(runner, "job:not_whitelisted");

      const rows = jobRuns(env);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.trigger, "cron", "没开回放的 job 不得被标成补跑");
      const handledAt = handled[0]?.toMillis() ?? Number.NaN;
      assert.ok(
        Math.abs(handledAt - firedAt.toMillis()) < 3000,
        "没开回放的 job 仍按「此刻」执行，不看匹配参数",
      );
    } finally {
      task.stop();
      cleanupTestEnv(env);
    }
  });

  it("matchedFireSlot：同一分钟算正常触发，过去的分钟算补跑，非法参数不崩", () => {
    const at = DateTime.fromISO("2026-10-28T09:30:45", { zone: TZ });
    assert.equal(matchedFireSlot(at.toJSDate(), at), null, "同一分钟 = 正常触发");
    assert.equal(
      matchedFireSlot(at.minus({ seconds: 30 }).toJSDate(), at),
      null,
      "同一分钟内晚 1 秒检测到 = 正常触发（不是补跑）",
    );
    assert.equal(
      matchedFireSlot(at.minus({ minutes: 1 }).toJSDate(), at)
        ?.toUTC()
        .toISO(),
      at.minus({ minutes: 1 }).startOf("minute").toUTC().toISO(),
      "上一分钟 = 补跑，槽位取那一分钟",
    );
    // node-cron 也会传字符串（runOnInit 的 "init"）；不得抛错，按正常触发处理
    assert.equal(matchedFireSlot("init", at), null);
    assert.equal(matchedFireSlot(undefined, at), null);
    assert.equal(matchedFireSlot(new Date(Number.NaN), at), null);
  });
});
