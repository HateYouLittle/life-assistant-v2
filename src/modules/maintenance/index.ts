import { MissingDatabaseError, runBackup } from "../../core/backup.js";
import { logger } from "../../core/logger.js";
import { rotateLogs } from "../../core/logrotate.js";
import { registerModule, runtime } from "../../core/registry.js";

/**
 * 每日自动备份（job daily_backup，cron 取 BACKUP_CRON，默认每天 03:00）。
 * 备份是旁路能力：任何失败都只记日志，绝不让 daemon 崩溃或退出。
 * 数据库文件不存在（DATA_DIR 指错/尚未建库）属于配置问题而非备份故障，降级为 warn 跳过。
 */
function runDailyBackup(): void {
  try {
    const target = runBackup(runtime().config);
    logger.info(`每日备份完成: ${target}`);
  } catch (e) {
    if (e instanceof MissingDatabaseError) {
      logger.warn(`每日备份跳过：${e.message}`);
      return;
    }
    logger.error(`每日备份失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * WAL 高水位治理（job wal_checkpoint，固定 03:15）。
 *
 * 为什么需要：长跑 daemon 的 WAL 会长期维持在高水位（实测数 MB），只有 checkpoint
 * 才能把已提交页并回主库。`wal_checkpoint(TRUNCATE)` 顺带把 WAL 截断到 0 字节，
 * 让磁盘占用回到真实水位；`PRAGMA optimize` 刷新查询规划器统计（表数据量变化后
 * 旧统计会让索引选错）。
 *
 * 为什么是 03:15：03:00 的每日备份刚结束、凌晨低峰，避开了 02:00 节假日抓取与
 * 03:00 的 VACUUM INTO 对写锁的争抢。
 *
 * 为什么只 warn：维护动作失败（库被其他连接占用、磁盘只读）不该让 daemon 崩掉，
 * 更不该影响当天的提醒投递 —— 下次 checkpoint 会自动重试。
 */
function runWalCheckpoint(): void {
  const db = runtime().db;
  try {
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy: number; log: number; checkpointed: number }
      | undefined;
    if (row === undefined) {
      logger.warn("WAL checkpoint 未返回结果（可能不是 WAL 模式）");
    } else if (row.busy !== 0) {
      logger.warn(
        `WAL checkpoint 未能完成（日志 ${row.log} 页，已回收 ${row.checkpointed} 页）：库被其他连接占用，将随下次触发重试`,
      );
    } else {
      logger.info(`WAL checkpoint 完成：已回收 ${row.checkpointed}/${row.log} 页`);
    }
    db.exec("PRAGMA optimize");
  } catch (e) {
    logger.warn(`WAL checkpoint 失败：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 日志轮转（job log_rotate，固定 04:50）。
 *
 * launchd 把 daemon 的 stdout/stderr 重定向到 ${LOG_DIR}/{daemon.log,daemon.err.log}，
 * 这两个文件不会自己收敛；这里按 LOG_MAX_MB 用 copytruncate 轮转、按 LOG_KEEP 保留份数
 * （实现与「为什么先 copy 再 truncate」见 core/logrotate.ts）。
 *
 * 为什么与每天的保留策略同分钟（04:50）：都是低峰期的「磁盘收敛」动作，放在同一波维护里
 * 便于对照状态页的 job 卡片；固定时刻而不是配置项 —— 用户没有调轮转时机的需求。
 *
 * 为什么异常要 **rethrow**（与每日备份的「失败只记日志」不同）：备份/checkpoint 失败
 * 有各自的兜底（下一轮重试、外部 timer），而日志无限增长是**静默**劣化，必须让
 * job_runs 记 failed、状态页与 doctor 能看见连续失败；否则只能在磁盘写满时才发现。
 */
function runLogRotate(): void {
  const { logDir, logMaxBytes, logKeep } = runtime().config;
  try {
    const result = rotateLogs({ dir: logDir, maxBytes: logMaxBytes, keep: logKeep });
    logger.info(
      `日志轮转完成：轮转 ${result.rotated.length} 个文件（活动日志归零 ${result.freedBytes} 字节），` +
        `保留最近 ${logKeep} 份；跳过 ${result.skipped.length} 个` +
        (result.skipped.length === 0
          ? ""
          : `（${result.skipped.map((s) => `${s.file}：${s.reason}`).join("；")}）`),
    );
  } catch (e) {
    // 记一条 error 再抛：job 包装层（daemon 的 runExclusive）会把 failed 写进 job_runs
    logger.error(`日志轮转失败：${e instanceof Error ? e.message : String(e)}`);
    throw e;
  }
}

registerModule({
  name: "maintenance",
  jobs: [
    {
      name: "daily_backup",
      cron: () => runtime().config.backupCron,
      handler: runDailyBackup,
    },
    {
      name: "wal_checkpoint",
      // 与备份错开 15 分钟：固定时刻而不是配置项 —— 它是纯维护动作，用户没有调参需求
      cron: "15 3 * * *",
      handler: runWalCheckpoint,
    },
    {
      name: "log_rotate",
      // 04:50：与保留策略同一波低峰维护（02:00 抓节假日、03:00 备份、03:15 checkpoint 之后）；
      // 错过的触发由 CATCHUP_POLICY["maintenance.log_rotate"] 在启动时补一次（幂等）
      cron: "50 4 * * *",
      handler: runLogRotate,
    },
  ],
});
