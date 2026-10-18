import { loadConfig } from "./config.js";
import { runBackup } from "./core/backup.js";

/**
 * CLI 入口，同时保留 `runBackup(config, nowMs?)` 的向后兼容导出。
 * 备份逻辑（VACUUM INTO / 拒绝空库与覆盖 / Asia/Shanghai 时间戳 / 保留清理）在
 * src/core/backup.ts：daemon 的 maintenance.daily_backup job 与 CLI 共用同一实现。
 * 保留份数取 config.backupKeep（默认 14）；需要显式覆盖时改用 core/backup.ts 的 opts。
 */
export { runBackup };

function main(): void {
  const args = process.argv.slice(2);
  const env = { ...process.env };
  const dirIndex = args.indexOf("--data-dir");
  if (dirIndex >= 0 && args[dirIndex + 1] !== undefined) {
    env.DATA_DIR = args[dirIndex + 1] as string;
  }
  // 与 cleanup-preview 同一口径：不抛裸堆栈，输出里带上库与目标路径，
  // 用户才能判断是配置错、库损坏，还是留下了垃圾备份
  try {
    const config = loadConfig(env);
    const target = runBackup(config);
    console.log(target);
  } catch (e) {
    console.error(`备份失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = /backup\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) {
  main();
}
