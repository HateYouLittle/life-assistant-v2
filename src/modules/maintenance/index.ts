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

registerModule({
  name: "maintenance",
  jobs: [
    {
      name: "daily_backup",
      cron: () => runtime().config.backupCron,
      handler: runDailyBackup,
    },
  ],
});
