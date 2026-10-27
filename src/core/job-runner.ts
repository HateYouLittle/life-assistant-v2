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
 *
 * P2-9 看门狗：handler **永不 settle** 时上面的兜底全都等不到 —— busy 里的 name 永远
 * 不释放，该 job 之后每次触发只写一条 skipped，停机时 inFlight 也会被这个 Promise 卡住。
 * 现在每次执行都挂一个超时定时器（默认 15 分钟，`JOB_TIMEOUT_MINUTES` 可配，0 关闭）：
 * 到点即记 failed、释放互斥并把该 Promise 从 inFlight 摘掉，允许下一次触发。挂死的
 * handler 无法取消（JS 没有抢占式取消），它继续在后台跑，但迟到的 resolve/reject
 * 受「本轮已超时」标记保护，不会再写第二条记录、也不会影响下一轮的互斥标记。
 */
export interface JobRunMeta {
  module: string;
  jobName: string;
  trigger: JobTrigger;
  scheduledFor: string;
}

/**
 * 默认看门狗超时：15 分钟。维护类 job（备份 VACUUM、日志轮转、occurrence 清理）在
 * 大库上会跑几分钟，留足余量；真挂死的 handler 也不可能「跑着跑着自己好了」。
 */
export const DEFAULT_JOB_TIMEOUT_MS = 15 * 60_000;

export interface JobRunnerOptions {
  /**
   * 单次 job 执行超时（毫秒；<=0 表示关闭看门狗）。daemon 传 `config.jobTimeoutMs`
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
  /**
   * 已超时但仍在后台跑的「僵尸」handler（name → 其收敛 Promise）。
   * - 同名任务在僵尸收敛前一律跳过：否则 tick（每分钟）会在 15 分钟窗口里堆出十几个
   *   并发僵尸，重复写库/重复推送；
   * - 停机时 daemon 对它们给一个短 grace 并 warn：db.close() 后迟到写入只会报
   *   "database is not open"（已被 catch 记 warn），但不该悄无声息。
   */
  readonly zombies: Map<string, Promise<void>>;
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function timeoutText(timeoutMs: number): string {
  // 小于 1 分钟的超时（测试/调参）按毫秒显示，否则「执行超时 0 分钟」毫无信息量
  return timeoutMs >= 60_000 && timeoutMs % 60_000 === 0
    ? `${timeoutMs / 60_000} 分钟`
    : `${timeoutMs} 毫秒`;
}

export function createJobRunner(db: DatabaseSync, opts: JobRunnerOptions = {}): JobRunner {
  const busy = new Set<string>();
  const inFlight = new Map<string, Promise<void>>();
  const zombies = new Map<string, Promise<void>>();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;

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
    if (zombies.has(name)) {
      // 上一轮已超时但 handler 仍挂在后台：再开一轮会和它对同一份数据并发写，
      // 违背「同名不重叠」的初衷（tick 每分钟一次 → 15 分钟内能堆 15 个僵尸）。
      logger.warn(`${name} 上一次执行已超时但仍在后台运行，本轮跳过（防僵尸堆积）`);
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
    // timedOut 是「本轮已判超时」的标记：迟到的 resolve/reject 靠它跳过二次落库；
    // settled 是反向保护——handler 恰好抢在定时器之前落库时，看门狗不能再把它改写成 failed。
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finished = Promise.resolve()
      .then(fn)
      .then(() => {
        // 成功记录写失败（同样可能是 SQLITE_BUSY）不能落进下面的 .catch 被记成
        // 「执行失败」—— handler 明明成功了（复审 T-1027-02b 指出）。只 warn。
        if (timedOut) return;
        settled = true;
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
        settled = true;
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
              if (!settled) {
                timedOut = true;
                const text = `执行超时 ${timeoutText(timeoutMs)}`;
                logger.error(`${name} ${text}，已按失败记录并释放互斥；handler 仍在后台运行`);
                if (runId !== undefined) {
                  try {
                    finishJobRun(db, runId, "failed", text);
                  } catch (recordError) {
                    logger.warn(`写入 job 超时记录失败: ${errorText(recordError)}`);
                  }
                }
                // 登记僵尸：它收敛前同名任务一律跳过（见 run 开头的 zombies.has 分支）
                let zombie: Promise<void>;
                zombie = finished.finally(() => {
                  if (zombies.get(name) === zombie) zombies.delete(name);
                });
                zombies.set(name, zombie);
              }
              resolve();
            }, timeoutMs);
            // 看门狗本身不该拖住进程退出（daemon 停机不看它，只看 inFlight）
            timer.unref?.();
          })
        : null;
    // `.finally` 挂在**竞赛**结果上（不是挂在 handler 的 promise 上）：超时那一刻就执行一次，
    // 因此不存在「挂死的 handler 迟到的 settle 再删一遍 busy、误删新一轮标记」的问题 ——
    // 迟到 settle 只走 finished 里的 timedOut 分支，不碰 busy/inFlight、也不落库。
    const task = (watchdog === null ? finished : Promise.race([finished, watchdog])).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      busy.delete(name);
      inFlight.delete(name);
    });
    inFlight.set(name, task);
    return task;
  }

  return { run, inFlight, zombies };
}
