import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MIN_TOKEN_LENGTH, isLoopbackHost, loadConfig, type ResolvedConfig } from "./config.js";
import { SCHEMA_VERSION, getSchemaVersion, openDatabase } from "./core/database.js";
import { loadEd25519PrivateKey } from "./core/qweather-jwt.js";

/**
 * `npm run doctor`：把「启动能过、第一次用到才炸」的配置问题提前暴露出来。
 *
 * 起因：JWT 私钥是**惰性加载**的（首次签发才读文件），DATA_DIR 写错要到首次写入才发现，
 * 弱 token 只在绑定非回环时拒绝……用户没有任何一处能一次看清这些。
 *
 * 只读为主：唯一会写的是数据目录可写性探针（用完即删）。
 * 网络检查默认跳过（`--network` 打开），避免内网环境里 doctor 卡住。
 */

export type CheckLevel = "ok" | "warn" | "fail";

export interface CheckResult {
  name: string;
  level: CheckLevel;
  detail: string;
}

export interface DoctorReport {
  checks: CheckResult[];
  failed: number;
  warned: number;
}

function ok(name: string, detail: string): CheckResult {
  return { name, level: "ok", detail };
}
function warn(name: string, detail: string): CheckResult {
  return { name, level: "warn", detail };
}
function fail(name: string, detail: string): CheckResult {
  return { name, level: "fail", detail };
}

function checkDataDir(config: ResolvedConfig): CheckResult {
  const name = "数据目录";
  try {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
    const probe = join(config.dataDir, ".doctor-write-probe");
    writeFileSync(probe, "ok");
    rmSync(probe, { force: true });
    return ok(name, `${config.dataDir}（可写）`);
  } catch (e) {
    return fail(name, `${config.dataDir} 不可写：${e instanceof Error ? e.message : String(e)}`);
  }
}

function checkDatabase(config: ResolvedConfig): CheckResult[] {
  const name = "数据库";
  if (!existsSync(config.dbPath)) {
    return [warn(name, `${config.dbPath} 还不存在（首次启动会创建）`)];
  }
  try {
    const db = openDatabase(config.dbPath);
    try {
      const integrity = db.prepare("PRAGMA quick_check").get() as
        | { quick_check?: string }
        | undefined;
      const schemaVersion = getSchemaVersion(db);
      const value = integrity?.quick_check ?? "unknown";
      if (value !== "ok") return [fail(name, `完整性检查未通过：${value}`)];
      const notes: CheckResult[] = [
        ok(name, `完整性 ok，schema v${schemaVersion}（程序支持 v${SCHEMA_VERSION}）`),
      ];
      const notifications = db.prepare("SELECT COUNT(*) AS n FROM notifications").get() as {
        n: number;
      };
      const pending = db
        .prepare(
          "SELECT COUNT(*) AS n FROM deliveries WHERE status IN ('queued','sending','failed')",
        )
        .get() as { n: number };
      notes.push(ok("outbox", `通知 ${notifications.n} 条，待投递/在途/失败 ${pending.n} 条`));
      return notes;
    } finally {
      db.close();
    }
  } catch (e) {
    return [fail(name, e instanceof Error ? e.message : String(e))];
  }
}

function checkAuth(config: ResolvedConfig): CheckResult {
  const name = "鉴权";
  if (config.webApiToken === undefined) {
    return isLoopbackHost(config.host)
      ? ok(name, `未设 WEB_API_TOKEN（仅绑定 ${config.host}，本地零配置可用）`)
      : fail(name, `绑定 ${config.host} 却没有 token`);
  }
  const length = config.webApiToken.length;
  if (length < MIN_TOKEN_LENGTH) {
    return isLoopbackHost(config.host)
      ? warn(name, `token 只有 ${length} 字符（建议 ≥${MIN_TOKEN_LENGTH}）；当前只绑回环，风险有限`)
      : fail(name, `token 只有 ${length} 字符，绑定了非回环地址`);
  }
  return ok(name, `token ${length} 字符，绑定 ${config.host}`);
}

function checkQweather(config: ResolvedConfig, env: NodeJS.ProcessEnv): CheckResult {
  const name = "QWeather";
  if (config.qweatherHost === undefined) {
    return warn(name, "未配置 QWEATHER_API_HOST：天气/空气质量/预警工具会返回明确错误");
  }
  if (config.qweatherAuth?.mode === "jwt") {
    const keyPath = env.QWEATHER_JWT_PRIVATE_KEY_PATH?.trim();
    if (keyPath === undefined || keyPath === "") {
      return fail(name, "JWT 模式但缺少 QWEATHER_JWT_PRIVATE_KEY_PATH");
    }
    try {
      // 与真实签发共用同一个加载函数：doctor 通过 == 首次请求不会再炸
      loadEd25519PrivateKey(keyPath);
    } catch (e) {
      return fail(name, e instanceof Error ? e.message : String(e));
    }
    if (process.platform !== "win32") {
      try {
        const mode = statSync(keyPath).mode & 0o777;
        if (mode !== 0o600) {
          return warn(name, `JWT（Ed25519）私钥可读，但权限是 ${mode.toString(8)}（建议 600）`);
        }
      } catch {
        // 权限读取失败不影响主结论
      }
    }
    return ok(name, `JWT（Ed25519）私钥已成功加载：${keyPath}`);
  }
  return warn(
    name,
    "使用 API KEY：官方自 2027-02-01 起逐步限制其每日请求量，建议迁移到 Ed25519 JWT",
  );
}

function checkBackups(config: ResolvedConfig): CheckResult {
  const name = "备份";
  if (!existsSync(config.backupDir)) {
    return warn(name, `还没有备份目录（${config.backupDir}）：建议配一个每日 db:backup 的 timer`);
  }
  const files = readdirSync(config.backupDir).filter((f) => f.endsWith(".db"));
  if (files.length === 0) return warn(name, "备份目录是空的");
  const newest = files
    .map((f) => statSync(join(config.backupDir, f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  const days = (Date.now() - newest) / (24 * 3600 * 1000);
  return days > 7
    ? warn(name, `最近一份备份在 ${days.toFixed(1)} 天前（建议每天一次）`)
    : ok(name, `${files.length} 份，最近一份在 ${days.toFixed(2)} 天前`);
}

async function checkNetwork(config: ResolvedConfig): Promise<CheckResult[]> {
  const targets: Array<{ name: string; url: string }> = [
    {
      name: "节假日数据源",
      url: "https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/2026.json",
    },
  ];
  if (config.qweatherHost !== undefined) {
    targets.push({ name: "QWeather", url: `https://${config.qweatherHost}/` });
  }
  const results: CheckResult[] = [];
  for (const target of targets) {
    try {
      const response = await fetch(target.url, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      });
      results.push(
        response.status < 500
          ? ok(`网络：${target.name}`, `HTTP ${response.status}`)
          : warn(`网络：${target.name}`, `HTTP ${response.status}`),
      );
    } catch (e) {
      results.push(
        fail(`网络：${target.name}`, `不可达：${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }
  return results;
}

export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  opts: { network?: boolean } = {},
): Promise<DoctorReport> {
  const checks: CheckResult[] = [];
  let config: ResolvedConfig;
  try {
    config = loadConfig(env);
  } catch (e) {
    checks.push(fail("配置解析", e instanceof Error ? e.message : String(e)));
    return { checks, failed: 1, warned: 0 };
  }
  checks.push(ok("配置解析", `.env 已读取，DATA_DIR=${config.dataDir}`));
  checks.push(checkDataDir(config));
  checks.push(...checkDatabase(config));
  // 鉴权与私钥检查都必须基于「实际会被 daemon 读取的那份 env」，不能偷看 process.env
  checks.push(checkAuth(config));
  checks.push(checkQweather(config, env));
  checks.push(checkBackups(config));
  if (opts.network === true) {
    checks.push(...(await checkNetwork(config)));
  }
  return {
    checks,
    failed: checks.filter((c) => c.level === "fail").length,
    warned: checks.filter((c) => c.level === "warn").length,
  };
}

const ICON: Record<CheckLevel, string> = { ok: "✅", warn: "⚠️ ", fail: "❌" };

function main(): void {
  const network = process.argv.slice(2).includes("--network");
  runDoctor(process.env, { network })
    .then((report) => {
      console.log("Life Assistant 自检\n");
      for (const check of report.checks) {
        console.log(`${ICON[check.level]} ${check.name}：${check.detail}`);
      }
      console.log(
        `\n合计 ${report.checks.length} 项：${report.failed} 项失败、${report.warned} 项警告`,
      );
      if (report.failed > 0) {
        console.log("有失败项：按上面的提示修正后重跑 `npm run doctor`。");
        process.exitCode = 1;
      }
      if (!network) console.log("（加 --network 可一并检查 QWeather 与节假日数据源的连通性）");
    })
    .catch((e: unknown) => {
      console.error(`自检失败：${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    });
}

const isDirectRun = /doctor\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) main();
