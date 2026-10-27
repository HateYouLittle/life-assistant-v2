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
});
