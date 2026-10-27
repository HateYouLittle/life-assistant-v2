import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createJobRunner } from "../src/core/job-runner.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/**
 * P1-3 回归：`busy.add` 之后写 `job_runs` 失败（SQLITE_BUSY / 表缺失）不得让该 job
 * 永久「被跳过」；异常必须被接住并记录，而不是从 cron 回调里抛出去被 node-cron 吞掉。
 */

const meta = {
  module: "test",
  jobName: "regression",
  trigger: "cron" as const,
  scheduledFor: "2026-01-01T00:00:00.000Z",
};

describe("core/job-runner（P1-3）", () => {
  it("写 running 行就抛错时：busy 不泄漏，run 不抛出，同名任务下次仍会执行", async () => {
    // 没有 job_runs 表：模拟 startJobRun 失败（真实场景是 SQLITE_BUSY）
    const db = new DatabaseSync(":memory:");
    try {
      const runner = createJobRunner(db);
      let ran = 0;
      await runner.run(
        "job:regression",
        () => {
          ran += 1;
        },
        meta,
      );
      assert.equal(ran, 0, "开跑前就失败，handler 不应执行");
      assert.equal(runner.inFlight.size, 0, "失败路径也必须清掉在途登记");

      // 关键断言：busy 里的 name 已释放（修复前这里会走 busy.has 分支，永远 skipped）
      await runner.run("job:regression", () => {
        ran += 1;
      });
      assert.equal(ran, 1, "同名任务的下一次触发必须能真正执行");
    } finally {
      db.close();
    }
  });

  it("handler 同步抛错：run 不 reject，busy 释放，可继续执行", async () => {
    const env = makeTestEnv();
    try {
      const runner = createJobRunner(env.db);
      let ran = 0;
      await runner.run("job:sync", () => {
        throw new Error("boom");
      });
      await runner.run("job:sync", () => {
        ran += 1;
      });
      assert.equal(ran, 1, "同步异常不能把 busy 卡死");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("正常路径写 ok 记录；handler 抛错写 failed 并带错误文本", async () => {
    const env = makeTestEnv();
    try {
      const runner = createJobRunner(env.db);
      await runner.run("job:ok", () => {}, meta);
      // 失败路径也要带 meta：只有登记过的 job 才写 job_runs（tick/未登记任务不记）
      await runner.run(
        "job:fail",
        () => {
          throw new Error("kaboom");
        },
        { ...meta, jobName: "failing" },
      );
      const rows = env.db
        .prepare("SELECT job_name, status, error FROM job_runs ORDER BY id")
        .all() as { job_name: string; status: string; error: string | null }[];
      assert.deepEqual(
        rows.map((row) => [row.job_name, row.status]),
        [
          ["regression", "ok"],
          ["failing", "failed"],
        ],
      );
      assert.match(rows[1]?.error ?? "", /kaboom/);
      assert.equal(runner.inFlight.size, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("重叠触发：第二次只记 skipped 且不执行 handler；第一次结束后同名任务恢复可用", async () => {
    const env = makeTestEnv();
    try {
      const runner = createJobRunner(env.db);
      let gate: () => void = () => {};
      const blocked = new Promise<void>((resolve) => {
        gate = resolve;
      });
      let ran = 0;
      const first = runner.run(
        "job:overlap",
        async () => {
          ran += 1;
          await blocked;
        },
        meta,
      );

      // 第一次已同步 busy.add；第二次必然走重叠分支
      await runner.run(
        "job:overlap",
        () => {
          throw new Error("重叠时 handler 不应执行");
        },
        meta,
      );
      const statuses = (
        env.db.prepare("SELECT status FROM job_runs ORDER BY id").all() as { status: string }[]
      ).map((row) => row.status);
      assert.deepEqual(statuses, ["running", "skipped"]);

      gate();
      await first;
      assert.equal(ran, 1);
      await runner.run("job:overlap", () => {
        ran += 1;
      });
      assert.equal(ran, 2, "前一轮结束后必须能再跑，不能被 skipped 永久卡住");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("成功记录写入抛错（如 SQLITE_BUSY）不会被误记成「执行失败」（复审 T-1027-02b）", async () => {
    const env = makeTestEnv();
    try {
      const real = env.db;
      // 只让 finishJobRun 的 UPDATE 失败，INSERT（startJobRun）走真库
      const busyOnUpdate = {
        prepare(sql: string) {
          if (sql.includes("UPDATE job_runs SET status = ?")) {
            return {
              run: () => {
                throw new Error("database is locked");
              },
            };
          }
          return real.prepare(sql);
        },
      } as unknown as DatabaseSync;
      const runner = createJobRunner(busyOnUpdate);
      let ran = 0;
      await runner.run(
        "job:ok-record",
        () => {
          ran += 1;
        },
        meta,
      );
      assert.equal(ran, 1, "handler 本身是成功的");
      const rows = real.prepare("SELECT status, error FROM job_runs ORDER BY id").all() as {
        status: string;
        error: string | null;
      }[];
      assert.deepEqual(
        rows.map((row) => row.status),
        ["running"],
        "写 ok 失败只能 warn，不能把这次运行记成 failed",
      );
      assert.equal(rows[0]?.error, null, "成功运行的 error 列必须为空");
      assert.equal(runner.inFlight.size, 0);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("看门狗：handler 挂死 → 记 failed；僵尸收敛前同名触发跳过，收敛后恢复（P2-9）", async () => {
    const env = makeTestEnv();
    try {
      const runner = createJobRunner(env.db, { timeoutMs: 30 });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = Date.now();
      await runner.run("job:hang", () => gate, meta);
      assert.ok(Date.now() - started >= 25, "run 应在看门狗超时后才返回");
      assert.equal(runner.inFlight.size, 0, "超时后必须清掉在途登记，停机不能被挂死 handler 卡住");
      assert.equal(runner.zombies.size, 1, "超时 handler 仍在后台跑，必须登记为僵尸");

      const rows = env.db.prepare("SELECT status, error FROM job_runs ORDER BY id").all() as {
        status: string;
        error: string | null;
      }[];
      assert.deepEqual(
        rows.map((r) => r.status),
        ["failed"],
      );
      assert.match(rows[0]?.error ?? "", /执行超时/);

      // 僵尸未收敛：同名触发必须跳过 —— 否则 tick（每分钟）会在 15 分钟窗口里堆出
      // 十几个并发僵尸，重复写库/重复推送（复审 T-1027-02c 的第 1 个风险）
      let ran = 0;
      await runner.run(
        "job:hang",
        () => {
          ran += 1;
        },
        meta,
      );
      await runner.run(
        "job:hang",
        () => {
          ran += 1;
        },
        meta,
      );
      assert.equal(ran, 0, "僵尸期间不得开新一轮");
      assert.equal(runner.zombies.size, 1, "跳过触发不能制造新僵尸");
      const skipped = env.db
        .prepare("SELECT COUNT(*) AS n FROM job_runs WHERE status = 'skipped'")
        .get() as { n: number };
      assert.equal(skipped.n, 2, "每次跳过都要留下 skipped 记录，不能静默消失");

      // 僵尸收敛 → 摘掉 → 同名任务恢复
      release();
      await gate;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runner.zombies.size, 0, "handler 收敛后必须摘掉僵尸");
      await runner.run(
        "job:hang",
        () => {
          ran += 1;
        },
        meta,
      );
      assert.equal(ran, 1, "僵尸收敛后同名任务必须能真正执行");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("看门狗：正常 handler 快于超时不受影响，仍记 ok（P2-9）", async () => {
    const env = makeTestEnv();
    try {
      const runner = createJobRunner(env.db, { timeoutMs: 5_000 });
      let ran = 0;
      await runner.run(
        "job:fast",
        () => {
          ran += 1;
        },
        meta,
      );
      assert.equal(ran, 1);
      const row = env.db.prepare("SELECT status FROM job_runs ORDER BY id DESC LIMIT 1").get() as {
        status: string;
      };
      assert.equal(row.status, "ok");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("看门狗：超时后 handler 迟到的 resolve/reject 不产生第二次记录，也不产生未处理拒绝", async () => {
    const env = makeTestEnv();
    try {
      // 迟到 settle 若漏出 unhandled rejection，node:test 会把它算成失败；这里再显式
      // 监听一次，把「不该发生」变成断言而不是靠运行器的偶然行为。
      const unhandled: unknown[] = [];
      const onUnhandled = (e: unknown): void => {
        unhandled.push(e);
      };
      process.on("unhandledRejection", onUnhandled);
      try {
        const runner = createJobRunner(env.db, { timeoutMs: 20 });
        // 50ms 后才 resolve：超时判定已经发生
        await runner.run(
          "job:late",
          () => new Promise<void>((resolve) => setTimeout(resolve, 50)),
          { ...meta, jobName: "late-ok" },
        );
        // 再等迟到的那次 settle 走完
        await new Promise((resolve) => setTimeout(resolve, 80));

        const lateRows = env.db
          .prepare("SELECT status, error FROM job_runs WHERE job_name = ? ORDER BY id")
          .all("late-ok") as { status: string; error: string | null }[];
        assert.equal(lateRows.length, 1, "迟到的 resolve 不得再写一条 ok 记录");
        assert.equal(lateRows[0]?.status, "failed");
        assert.match(lateRows[0]?.error ?? "", /执行超时/);

        // 迟到的 reject 同样不该触发二次记录，也不能漏成 unhandled rejection
        await runner.run(
          "job:late-reject",
          () =>
            new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error("late boom")), 50);
            }),
          { ...meta, jobName: "late-reject" },
        );
        await new Promise((resolve) => setTimeout(resolve, 80));
        const rejectRows = env.db
          .prepare("SELECT status, error FROM job_runs WHERE job_name = ? ORDER BY id")
          .all("late-reject") as { status: string; error: string | null }[];
        assert.equal(rejectRows.length, 1, "迟到的 reject 不得再写一条 failed 记录");
        assert.equal(rejectRows[0]?.status, "failed");
        assert.match(rejectRows[0]?.error ?? "", /执行超时/, "记录必须是超时原因，不是迟到异常");
        assert.doesNotMatch(rejectRows[0]?.error ?? "", /late boom/);
        assert.deepEqual(unhandled, [], "迟到的 handler 异常必须被接住，不能变成未处理拒绝");
        assert.equal(runner.inFlight.size, 0);
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("看门狗：僵尸期间多次触发只跳过不并发，收敛后 zset 清空（P2-9）", async () => {
    const env = makeTestEnv();
    try {
      const runner = createJobRunner(env.db, { timeoutMs: 20 });
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      await runner.run("job:relate", () => gate, { ...meta, jobName: "relate" });
      assert.equal(runner.zombies.size, 1);

      let runs = 0;
      for (let i = 0; i < 3; i++) {
        await runner.run(
          "job:relate",
          () => {
            runs += 1;
          },
          { ...meta, jobName: "relate" },
        );
      }
      assert.equal(runs, 0, "僵尸存活期间的触发必须全部跳过，不能出现并发执行");
      assert.equal(runner.zombies.size, 1, "跳过触发不得叠加僵尸");

      release();
      await gate;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(runner.zombies.size, 0, "僵尸收敛后必须从 zombies 摘掉");

      await runner.run(
        "job:relate",
        () => {
          runs += 1;
        },
        { ...meta, jobName: "relate" },
      );
      assert.equal(runs, 1);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
