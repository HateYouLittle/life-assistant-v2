import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type ResolvedConfig } from "./config.js";
import { logger } from "./core/logger.js";

const FILE_RE = /^life-assistant-\d{8}-\d{6}\.db$/;
const KEEP = 14;

export function runBackup(config: ResolvedConfig, nowMs: number = Date.now()): string {
  // sqlite 打开不存在的路径会顺手建一个空库，从而「成功」产出一份空备份
  if (!existsSync(config.dbPath)) {
    throw new Error(`数据库不存在，拒绝生成空备份: ${config.dbPath}（检查 DATA_DIR 是否指向真实数据目录）`);
  }
  mkdirSync(config.backupDir, { recursive: true });
  const iso = new Date(nowMs).toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
  const target = join(config.backupDir, `life-assistant-${stamp}.db`);
  if (statSync(target, { throwIfNoEntry: false }) !== undefined) {
    throw new Error(`备份已存在，拒绝覆盖: ${target}`);
  }
  const db = new DatabaseSync(config.dbPath);
  try {
    db.prepare("VACUUM INTO ?").run(target);
  } finally {
    db.close();
  }
  prune(config.backupDir);
  return target;
}

function prune(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .sort()
    .reverse();
  for (const stale of files.slice(KEEP)) {
    try {
      unlinkSync(join(dir, stale));
      logger.info(`已清理旧备份: ${stale}`);
    } catch (e) {
      logger.warn(`清理旧备份失败: ${stale} ${e instanceof Error ? e.message : e}`);
    }
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const env = { ...process.env };
  const dirIndex = args.indexOf("--data-dir");
  if (dirIndex >= 0 && args[dirIndex + 1] !== undefined) {
    env.DATA_DIR = args[dirIndex + 1] as string;
  }
  const config = loadConfig(env);
  const target = runBackup(config);
  console.log(target);
}

const isDirectRun = /backup\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) {
  main();
}
