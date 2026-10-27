import type { DatabaseSync } from "node:sqlite";
import { finishJobRun, type JobTrigger, startJobRun } from "./jobs.js";
import { logger } from "./logger.js";

/**
 * job 互斥执行器（P1-3 / T-1027-02）。
 *
 * 之前的实现把 `busy.add(name)` 放在 `startJobRun()` 之前、却没有接住它的同步异常：
 * 一次 `SQLITE_BUSY`（跨进程写锁超过 busy_timeout=5000 就会发生，README 的 import
 * 一节自己承认过）就让 `busy` 里的 name 永远不释放，该 job 之后每次触发都只写一条
 * skipped；更糟的是这个异常从 cron 回调里抛出，被 node-cron 捕获后 emit('task-failed')，
 * 而 daemon 从未监听该事件 → 日志里一条 error 都没有。
 *
 * 现在：写 running 行失败时立刻释放 busy 并记录 error（不向调用方抛出），handler 的
 * 同步/异步异常同样在 `.catch` 里记录，`.finally` 兜底释放 busy 与在途登记。daemon 侧
 * 还给 cron task 挂 `task-failed` 监听作为最后一道兜底。
 */
export interface JobRunMeta {
  module: string;
  jobName: string;
  trigger: JobTrigger;
  scheduledFor: string;
}

export interface JobRunnerOptions {
  /**
   * 单次 job 执行超时（毫秒；<=0 表示关闭看门狗）。来自 `config.jobTimeoutMs`
   * （JOB_TIMEOUT_MINUTES，默认 15 分钟）。
   */
  timeoutMs?: number;
}

export interface JobRunner {
  /**
   * 同名任务不重叠执行；**不会向调用方抛出**任何异常（同步/异步都在内部记录），
   * 调用方可以 `void runner.run(...)` 而不产生 unhandled rejection。
   */
  run(name: string, fn: () => Promise<void> | void, meta?: JobRunMeta): Promise<void>;
  /** 在途任务（name → Promise）；停机时必须等它们收敛，否则 db.close() 会撞上在途写入 */
  readonly inFlight: Map<string, Promise<void>>;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function timeoutText(timeoutMs: number): string {
  return timeoutMs % 60_000 === 0 ? `${timeoutMs / 60_000} 分钟` : `${timeoutMs} 毫秒`;
}

export function createJobRunner(db: DatabaseSync, opts: JobRunnerOptions = {}): JobRunner {
  const busy = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const timeoutMs = opts.timeoutMs ?? 0;

  function recordSkip(meta: JobRunMeta): void {
    // 记一条 skipped：状态页/doctor 能看出「这次是被上一轮挡掉的」，而不是静默消失
    try {
      finishJobRun(db, startJobRun(db, meta), "skipped");
    } catch (e) {
      logger.warn(`写入 job 跳过记录失败: ${errorText(e)}`);
    }
  }

  function run(name: string, fn: () => Promise<void> | void, meta?: JobRunMeta): Promise<void> {
    if (busy.has(name)) {
      logger.debug(`跳过重叠触发: ${name}`);
      if (meta !== undefined) recordSkip(meta);
      return Promise.resolve();
    }
    busy.add(name);
    let runId: number | undefined;
    try {
      if (meta !== undefined) runId = startJobRun(db, meta);
    } catch (e) {
      // 写 running 行失败（典型：SQLITE_BUSY）时本轮不执行，但绝不能留下 busy 标记，
      // 否则该 job 之后每次都走「重叠跳过」分支，永久停摆。
      busy.delete(name);
      logger.error(`${name} 记录运行开始失败，本轮未执行: ${errorText(e)}`);
      return Promise.resolve();
    }
    // 看门狗：handler 永不 settle 时释放 busy 并记 failed，否则该 job 永久只记 skipped。
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    const finished = Promise.resolve()
      .then(fn)
      .then(() => {
        // 成功记录写失败（同样可能是 SQLITE_BUSY）不能落进下面的 .catch 被记成
        // 「执行失败」—— handler 明明成功了（复审 T-1027-02b 指出）。只 warn。
        if (timedOut) return;
        if (runId !== undefined) {
          try {
            finishJobRun(db, runId, "ok");
          } catch (recordError) {
            logger.warn(`写入 job 成功记录失败: ${errorText(recordError)}`);
          }
        }
      })
      .catch((e) => {
        // 超时已经记过 failed，挂死 handler 迟到的异常不再二次落库
        if (timedOut) {
          logger.debug(`${name} 超时后才失败（已按超时记 failed）: ${errorText(e)}`);
          return;
        }
        logger.error(`${name} 执行失败: ${errorText(e)}`);
        // 记录失败不能反过来让 job 崩溃：db 可能恰好处于关闭过程中
        if (runId !== undefined) {
          try {
            finishJobRun(db, runId, "failed", errorText(e));
          } catch (recordError) {
            logger.warn(`写入 job 失败记录失败: ${errorText(recordError)}`);
          }
        }
      });
    const watchdog =
      timeoutMs > 0
        ? new Promise<void>((resolve) => {
            timer = setTimeout(() => {
              timedOut = true;
              const text = `执行超时（${timeoutText(timeoutMs)}）`;
              logger.error(`${name} ${text}，已按失败记录并释放互斥；handler 仍在后台运行`);
              if (runId !== undefined) {
                try {
                  finishJobRun(db, runId, "failed", text);
                } catch (recordError) {
                  logger.warn(`写入 job 超时记录失败: ${errorText(recordError)}`);
                }
              }
              resolve();
            }, timeoutMs);
            // 看门狗本身不该拖住进程退出（daemon 停机不看它，只看 inFlight）
            timer.unref?.();
          })
        : null;
    const task = (watchdog === null ? finished : Promise.race([finished, watchdog])).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      busy.delete(name);
      inFlight.delete(name);
    });
    inFlight.set(name, task);
    return task;
  }

  return { run, inFlight };
}
