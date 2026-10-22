import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { getSchemaVersion, openDatabase, SCHEMA_VERSION } from "./core/database.js";
import { schemaFingerprint, storedSchemaFingerprint } from "./core/fingerprint.js";
import { applyCliSecurityBaseline } from "./core/security.js";

/**
 * `npm run db:fingerprint`：打印数据库结构指纹，并在打开时把 `meta.schema_fingerprint`
 * 对账到当前结构。
 *
 * 为什么需要这个命令：doctor 会把「指纹缺失/不一致」报成 warn，但修复动作需要一个
 * 显式入口 —— 顺手打开一次库（会触发迁移与对账）比手工写 SQL 安全得多。打开时传
 * `backupDir` 与 daemon 同口径：如果这次打开恰好要做 schema 前滚，会先留一份 pre-v 快照。
 *
 * 输出里的 `stored` 是**打开前**记录的值，`match` 也是「打开前是否一致」——
 * 若拿打开后的值来比，openDatabase 刚对账过，永远 true，这个命令就失去了诊断意义。
 */

type StoredBefore =
  | { state: "missing" }
  | { state: "unavailable" }
  | { state: "ok"; value: string | null };

function readStoredBefore(dbPath: string): StoredBefore {
  if (!existsSync(dbPath)) return { state: "missing" };
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // daemon 正在写的时候只读连接也可能先撞 BUSY：给 2 秒窗口，失败则如实报「读取失败」
    db.exec("PRAGMA busy_timeout = 2000");
    return { state: "ok", value: storedSchemaFingerprint(db) };
  } catch {
    return { state: "unavailable" };
  } finally {
    if (db?.isOpen) db.close();
  }
}

function main(): void {
  try {
    const config = loadConfig(process.env);
    // 安全基线必须在任何 mkdir/open 之前：本次打开可能前滚 schema 并落迁移前快照。
    // 库不存在时本命令会新建空库 —— 这种「DATA_DIR 可能写错」的情况只收紧 umask，
    // 不 chmod 用户写错指向的无关目录（Round2 R2-2）。
    applyCliSecurityBaseline(config, { harden: existsSync(config.dbPath) });
    const before = readStoredBefore(config.dbPath);
    // 与 daemon/doctor 同一入口：可能前滚 schema，必须带迁移前备份目录
    const db = openDatabase(config.dbPath, { backupDir: config.backupDir });
    try {
      const computed = schemaFingerprint(db);
      const match = before.state === "ok" && before.value === computed;
      console.log(`computed: ${computed}`);
      if (before.state === "ok") {
        console.log(`stored:   ${before.value ?? "（无，meta 里还没有指纹）"}`);
      } else if (before.state === "missing") {
        console.log("stored:   （无，数据库不存在，本次已新建）");
      } else {
        console.log("stored:   （读取失败：库被占用或暂时不可读）");
      }
      console.log(`match: ${match ? "true" : "false"}`);
      console.log(
        `schema: v${getSchemaVersion(db)}（程序支持 v${SCHEMA_VERSION}）  path: ${config.dbPath}`,
      );
      if (!match) {
        console.log("");
        console.log("已把 meta.schema_fingerprint 更新为当前结构指纹。");
        console.log(
          "若这不是预期变化（没升级程序、也没手工迁移），请用最近备份核对：npm run db:restore -- --latest",
        );
      }
    } finally {
      db.close();
    }
  } catch (e) {
    console.error(`读取结构指纹失败：${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  }
}

const isDirectRun = /fingerprint\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) main();
