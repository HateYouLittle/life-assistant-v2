import { MissingDatabaseError, runBackup } from "../../core/backup.js";
import { logger } from "../../core/logger.js";
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
  ],
});
