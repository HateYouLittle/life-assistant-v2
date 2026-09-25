import { existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { openDatabase } from "./core/database.js";
import {
  CANCELLED_SCHEDULE_RETENTION_DAYS,
  NOTIFICATION_RETENTION_DAYS,
  retentionPreview,
} from "./core/retention.js";
import { OCCURRENCE_CLEANUP_DAYS, previewOccurrenceCleanup } from "./modules/schedule/service.js";

/**
 * 清理预演（只读）：occurrence 与保留策略（通知/投递/已取消日程）都会删什么。
 * 判定与每日 job 共用同一份谓词（schedule/service.ts 与 core/retention.ts），
 * 因此这里的结论与 job 实际行为一致。
 */

function main(): void {
  const config = loadConfig(process.env);
  // 与 backup 同理：sqlite 会顺手建出空库，「预演成功、0 行」会掩盖 DATA_DIR 指错
  if (!existsSync(config.dbPath)) {
    throw new Error(`数据库不存在: ${config.dbPath}（检查 DATA_DIR 是否指向真实数据目录）`);
  }
  const db = openDatabase(config.dbPath);
  try {
    const preview = previewOccurrenceCleanup(db);
    console.log(
      `保留策略：早于 ${preview.cutoff} 的已结束 occurrence（${OCCURRENCE_CLEANUP_DAYS} 天前）`,
    );
    console.log(
      `将删除 ${preview.deletable} 行；因 recurrence.count 整条豁免的日程：${preview.protectedByCount} 个`,
    );
    for (const row of preview.bySchedule) {
      console.log(`  - ${row.title}（${row.schedule_id}）：${row.rows} 行`);
    }
    if (preview.deletable === 0) console.log("当前没有可清理的历史行。");

    const retention = retentionPreview(db);
    console.log("");
    console.log(
      `保留策略（通知 ${NOTIFICATION_RETENTION_DAYS} 天 / 已取消日程 ${CANCELLED_SCHEDULE_RETENTION_DAYS} 天）：`,
    );
    console.log(
      `将删除已读通知 ${retention.notifications} 条（其中投递记录 ${retention.deliveries} 条随外键级联）、` +
        `已取消日程 ${retention.cancelledSchedules} 条`,
    );
    console.log("未读通知与仍有待投递的通知不会删；使用 recurrence.count 的日程不删。");
  } finally {
    db.close();
  }
}

const isDirectRun = /cleanup-preview\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) {
  try {
    main();
  } catch (e) {
    console.error(`预演失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}
