import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import {
  isLoopbackHost,
  loadConfig,
  MIN_TOKEN_LENGTH,
  type ResolvedConfig,
  urlHost,
} from "./config.js";
import { BACKUP_STALE_HOURS, backupStatus } from "./core/backup.js";
import { getSchemaVersion, openDatabase, SCHEMA_VERSION } from "./core/database.js";
import { schemaFingerprint, storedSchemaFingerprint } from "./core/fingerprint.js";
import { holidaySourceUrls, requiredYears } from "./core/holiday.js";
import { fetchJson } from "./core/http.js";
import { CATCHUP_POLICY, previousFireTime } from "./core/jobs.js";
import { loadEd25519PrivateKey } from "./core/qweather-jwt.js";
import { applySecureUmask } from "./core/security.js";
import { now } from "./time.js";

/**
 * `npm run doctor`：把「启动能过、第一次用到才炸」的配置问题提前暴露出来。
 *
 * 起因：JWT 私钥是**惰性加载**的（首次签发才读文件），DATA_DIR 写错要到首次写入才发现，
 * 弱 token 只在绑定非回环时拒绝……用户没有任何一处能一次看清这些。
 *
 * 不删任何数据：唯一会写的业务动作是数据目录可写性探针（用完即删）。
 * 注意数据库检查与 daemon 共用 openDatabase，因此会应用附加式的 schema 升级
 * （老库会被升级到当前版本），需要数据目录可写。
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

/**
 * 结构指纹：回答「这个库的表结构和上次启动时是否一致」。
 * 必须用独立的只读连接读**打开前**的 stored —— 紧随其后的 checkDatabase 走 openDatabase，
 * 它会在迁移后把指纹对账到当前结构，用同一条连接比较永远相等。
 * 等级只到 warn：指纹变化本身可能是合法的（升级程序、附加式迁移），不能因此让自检退出码变红。
 */
function checkSchemaFingerprint(config: ResolvedConfig): CheckResult {
  const name = "结构指纹";
  if (!existsSync(config.dbPath)) {
    return warn(name, "数据库还不存在（首次启动会创建并写入结构指纹）");
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.dbPath, { readOnly: true });
    // daemon 正在写时只读连接也可能先撞 BUSY：给 2 秒窗口，失败按「无法检查」处理
    db.exec("PRAGMA busy_timeout = 2000");
    const computed = schemaFingerprint(db);
    const stored = storedSchemaFingerprint(db);
    if (stored === null) {
      return warn(
        name,
        `meta 里还没有结构指纹（老库/首次升级）：启动一次 daemon 或运行 npm run db:fingerprint 写入；当前 ${computed.slice(0, 12)}…`,
      );
    }
    if (stored !== computed) {
      return warn(
        name,
        `与上次启动不一致：可能手工 ALTER 或升级不完整（stored ${stored.slice(0, 12)}… / computed ${computed.slice(0, 12)}…）。确认无误后运行 npm run db:fingerprint 更新`,
      );
    }
    return ok(name, `与上次启动一致（${computed.slice(0, 12)}…）`);
  } catch (e) {
    return warn(
      name,
      `无法检查（库被占用或不可读）：${e instanceof Error ? e.message : String(e)}`,
    );
  } finally {
    if (db?.isOpen) db.close();
  }
}

function checkDatabase(config: ResolvedConfig): CheckResult[] {
  const name = "数据库";
  if (!existsSync(config.dbPath)) {
    return [warn(name, `${config.dbPath} 还不存在（首次启动会创建）`)];
  }
  try {
    // 与 daemon 共用同一入口：需要 schema 升级时先备份（doctor 是「第一次启动前」最常跑的动作，
    // 不传 backupDir 会让这次升级失去迁移前快照）。
    const db = openDatabase(config.dbPath, { backupDir: config.backupDir });
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
  // daemon 内置每日备份 job（默认 03:00），不再必须配 systemd timer；
  // 备份目录不存在/为空说明 job 从未成功执行过（daemon 未跑、BACKUP_CRON 未到点或失败）。
  if (!existsSync(config.backupDir)) {
    return warn(
      name,
      `还没有备份目录（${config.backupDir}）：daemon 的每日备份 job（BACKUP_CRON=${config.backupCron}）首次成功后才会创建；daemon 长期不运行时请改用外部 timer`,
    );
  }
  const files = readdirSync(config.backupDir).filter((f) => f.endsWith(".db"));
  if (files.length === 0) {
    return warn(name, "备份目录是空的：检查 daemon 是否在运行、BACKUP_CRON 是否已到点");
  }
  const newest = files
    .map((f) => statSync(join(config.backupDir, f)).mtimeMs)
    .reduce((a, b) => Math.max(a, b), 0);
  const days = (Date.now() - newest) / (24 * 3600 * 1000);
  return days > 7
    ? warn(
        name,
        `最近一份备份在 ${days.toFixed(1)} 天前：检查 daemon 是否在运行、BACKUP_CRON=${config.backupCron}，日志搜「每日备份」`,
      )
    : ok(name, `${files.length} 份，最近一份在 ${days.toFixed(2)} 天前`);
}

// ── --live：检查运行中的 daemon ────────────────────────────────────────────

/** live 请求超时：daemon 就在本机，3 秒连不上就该快速报「不可达」，不能拖住自检 */
const LIVE_TIMEOUT_MS = 3000;

/**
 * 需要看「新鲜度」的任务（键与 `CATCHUP_POLICY` 同源）。
 * 只挑用户能感知到的推送/备份任务：清理类任务晚跑一天不会有人发现，
 * 把它们也列进来只会让自检变长。
 */
const LIVE_FRESHNESS_KEYS = [
  "weather.daily_brief",
  "weather.evening_brief",
  "weather.alert_watch",
  "holiday.workday_watch",
  "maintenance.daily_backup",
] as const;

interface LiveJobItem {
  module: string;
  name: string;
  cron: string;
  last_ok_at: string | null;
  last_run: { status: string; started_at: string } | null;
  failed_24h: number;
}

/** 请求运行中 daemon 的 JSON 端点；非 2xx 一律当失败（401 给出可操作提示） */
async function fetchLiveJson<T>(url: string, token: string | undefined): Promise<T> {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "HTTP 401（WEB_API_TOKEN 与 daemon 不一致？）"
        : `HTTP ${response.status}`,
    );
  }
  return (await response.json()) as T;
}

/**
 * 通配绑定（0.0.0.0 / ::）不是可连接的地址：自检连本机回环即可。
 * 直接用 0.0.0.0 拼 URL 会连不上（Host 守卫也不放行 0.0.0.0），
 * 于是在「为局域网/反代绑定 0.0.0.0」的部署下 doctor --live 会假报 daemon 不可达。
 */
function isWildcardBindHost(host: string): boolean {
  const h = host.replace(/^\[/, "").replace(/\]$/, "");
  return h === "0.0.0.0" || h === "::" || h === "::0" || /^0(:0){7}$/.test(h);
}

function liveBaseUrl(config: ResolvedConfig): string {
  const probeHost = isWildcardBindHost(config.host) ? "127.0.0.1" : config.host;
  return `http://${urlHost(probeHost)}:${config.port}`;
}

function hoursText(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} 分钟`;
  if (hours < 48) return `${hours.toFixed(1)} 小时`;
  return `${(hours / 24).toFixed(1)} 天`;
}

function bytesText(bytes: number): string {
  if (bytes <= 0) return "0 B";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 任务新鲜度：每个关键 job 的 `last_ok_at` 是否落在补发窗口的 2 倍内。
 * 用 `/api/jobs` 而不是直接查库 —— 自检要和状态页看到的是同一份事实，
 * 也能顺带验证鉴权与 HTTP 通路。
 *
 * 「缺 job」「cron 无法反向求值」「尚无成功记录」只 warn：前两者可能是版本不一致或用户
 * 自定义了带星期限制的 cron；后者在升级/首次部署后的第一天必然出现（job_runs 是 v4 才有的
 * 新表），把它判成故障等于每次升级都报一次假警。真正能断定「任务停摆」的是「有成功记录
 * 但已超出窗口 2 倍」——那条才 fail。
 */
function checkJobFreshness(items: LiveJobItem[], at: DateTime): CheckResult[] {
  const byKey = new Map(items.map((item) => [`${item.module}.${item.name}`, item]));
  const results: CheckResult[] = [];
  for (const key of LIVE_FRESHNESS_KEYS) {
    const name = `任务新鲜度：${key}`;
    const withinHours = CATCHUP_POLICY[key];
    if (withinHours === undefined) {
      results.push(warn(name, "没有补发窗口配置，无法判断新鲜度"));
      continue;
    }
    const item = byKey.get(key);
    if (item === undefined) {
      results.push(warn(name, "daemon 未注册该任务（程序版本不一致？）"));
      continue;
    }
    const previous = previousFireTime(item.cron, at);
    if (previous === null) {
      results.push(
        warn(name, `cron "${item.cron}" 无法反向求值（仅支持日/月为 *），不能判断是否新鲜`),
      );
      continue;
    }
    // 新鲜度阈值不能只看补发窗口：日报/晚报/调休/备份是**每天一次**的任务，自然间隔
    // 就有 24h，而 CATCHUP_POLICY 的窗口是 6h/24h —— 按「窗口×2」会在
    // 「上次成功已过 12h（如 21:00 晚报到次日 09:00）」时误报停更（更新/首次部署后的
    // 凌晨同理）。用 cron 的**实际触发间隔**（再反推一次上一次触发）把阈值放宽到
    // 「间隔×1.5 + 1h」，再与「窗口×2」取大；*/20 这种高频任务的窗口阈值仍占主导。
    // 注意 previousFireTime 按 `at` 所在时区解释分钟/小时字段，必须把 UTC 返回值
    // 换回本地时区再喂进去，否则 7 点会被当成 UTC 7 点，算出的间隔会错位 8 小时。
    const previousLocal = previous.setZone(at.zone);
    const previousPrevious = previousFireTime(item.cron, previousLocal.minus({ minutes: 1 }));
    const cadenceHours =
      previousPrevious === null
        ? 0
        : Math.max(1 / 60, previous.diff(previousPrevious, "hours").hours);
    const limitHours = Math.max(withinHours * 2, Math.round(cadenceHours * 1.5 + 1));
    if (item.last_ok_at === null) {
      results.push(
        warn(
          name,
          `尚无成功运行记录（cron "${item.cron}"）：升级/首次启动后属正常，等下一次触发即可；` +
            "若持续如此再看日志或手动触发一次",
        ),
      );
      continue;
    }
    const ageHours = (at.toMillis() - Date.parse(item.last_ok_at)) / 3_600_000;
    if (!Number.isFinite(ageHours)) {
      results.push(warn(name, `last_ok_at 不是合法时间：${item.last_ok_at}`));
      continue;
    }
    const age = Math.max(0, ageHours);
    const detail = `${hoursText(age)}前成功（cron "${item.cron}"，阈值 ${limitHours} 小时）`;
    results.push(
      age <= limitHours
        ? ok(name, detail)
        : fail(name, `${detail}：检查 daemon 是否长期未运行、或该任务是否一直失败`),
    );
  }
  return results;
}

/**
 * 备份新鲜度：`backupStatus` 是 daemon 备份 job 与 `db:restore` 共用的只读口径。
 * 超过 BACKUP_STALE_HOURS（36h）warn；超过一周 fail（每日 job 不可能连续 7 天都没跑成）。
 */
function checkLiveBackup(config: ResolvedConfig): CheckResult[] {
  const name = "备份新鲜度";
  // verifyLatest：坏备份的 mtime 往往很新，只看 mtime 会报「备份新鲜健康」，
  // 而真正要恢复时才发现用不了（P1-4）。这是手动 --live 检查，做一次 quick_check 值得。
  const status = backupStatus(config, Date.now(), { verifyLatest: true });
  const results: CheckResult[] = [];
  const canonical = status.files.filter((file) => file.canonical);
  if (status.latest === null) {
    results.push(
      warn(
        name,
        `还没有规范备份（${status.dir}）：daemon 的每日备份 job（BACKUP_CRON=${config.backupCron}）首次成功后才会生成；立即备份用 npm run db:backup`,
      ),
    );
  } else {
    const age = status.ageHours ?? 0;
    const detail = `${canonical.length} 份规范备份，最新 ${status.latest.name}（${hoursText(age)}前，${bytesText(status.latest.sizeBytes)}）`;
    if (status.latestVerified === false) {
      results.push(
        fail(
          name,
          `${detail}：最新备份**校验失败**（quick_check/schema 读不出），不能当成可恢复的快照；` +
            "检查磁盘与备份日志。可用 `npm run db:restore -- --latest`（会自动跳过坏文件，回退到上一份可用备份）",
        ),
      );
    } else if (age > BACKUP_STALE_HOURS * 7) {
      results.push(fail(name, `${detail}：超过一周没有新备份，daemon 很可能没在运行`));
    } else if (age > BACKUP_STALE_HOURS) {
      results.push(
        warn(
          name,
          `${detail}：超过 ${BACKUP_STALE_HOURS} 小时（BACKUP_CRON=${config.backupCron}），检查 daemon 是否在运行、日志搜「每日备份」`,
        ),
      );
    } else {
      results.push(ok(name, detail));
    }
  }
  if (status.nonCanonical.length > 0) {
    results.push(
      warn(
        "备份文件命名",
        `${status.nonCanonical.length} 个文件不符合规范命名（迁移前快照/恢复留底/手工拷贝？）：${status.nonCanonical
          .slice(0, 5)
          .join(
            "、",
          )}${status.nonCanonical.length > 5 ? " 等" : ""}；它们不会被保留策略清理，也不会被「恢复最新备份」选中`,
      ),
    );
  }
  return results;
}

/**
 * `doctor --live`：检查运行中的 daemon。默认关闭，避免未启动/内网环境下自检卡住
 * （与 `--network` 同一取舍）。三项检查各自独立：daemon 不可达时仍会检查备份目录。
 */
async function checkLive(config: ResolvedConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  const base = liveBaseUrl(config);
  const token = config.webApiToken;

  let alive = false;
  try {
    const health = await fetchLiveJson<{ ok?: boolean; version?: string; uptime_s?: number }>(
      `${base}/healthz`,
      undefined,
    );
    alive = health.ok === true;
    results.push(
      alive
        ? ok(
            "daemon 存活",
            `${base}/healthz 正常（v${health.version ?? "?"}，已运行 ${hoursText((health.uptime_s ?? 0) / 3600)}）`,
          )
        : fail("daemon 存活", `${base}/healthz 返回 ok=false：进程在，但数据库不可用`),
    );
  } catch (e) {
    results.push(
      fail("daemon 存活", `${base} 不可达：${e instanceof Error ? e.message : String(e)}`),
    );
  }

  if (alive) {
    // /api/status 主要用来确认鉴权通路：配了 WEB_API_TOKEN 时最容易在这里与 daemon 对不上
    try {
      await fetchLiveJson<{ ok?: boolean }>(`${base}/api/status`, token);
      results.push(
        ok(
          "只读 API",
          `/api/status 可读（${token === undefined ? "未启用 token" : "Bearer 鉴权通过"}）`,
        ),
      );
    } catch (e) {
      results.push(
        warn(
          "只读 API",
          `/api/status 读取失败：${
            e instanceof Error ? e.message : String(e)
          }（检查本机 .env 的 WEB_API_TOKEN 是否与 daemon 一致）`,
        ),
      );
    }
    try {
      const jobs = await fetchLiveJson<{ items?: LiveJobItem[] }>(`${base}/api/jobs`, token);
      results.push(...checkJobFreshness(jobs.items ?? [], now()));
    } catch (e) {
      results.push(
        fail("任务新鲜度", `读取 /api/jobs 失败：${e instanceof Error ? e.message : String(e)}`),
      );
    }
  } else {
    // 后续检查都依赖 /api/*：daemon 没起来时重复报同一件事只会淹没第一因
    results.push(warn("任务新鲜度", "daemon 未存活，无法检查任务新鲜度"));
  }

  // 备份检查直接读备份目录，不依赖 daemon：daemon 挂了更要知道备份还新不新
  results.push(...checkLiveBackup(config));
  return results;
}

async function checkNetwork(config: ResolvedConfig): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 节假日数据源：按 daemon 的同一份 URL 列表与同一套判定（fetchJson，非 2xx 一律失败）检查，
  // 且年份取 requiredYears()（10 月起包含下一年）—— 写死某一年时，自检在 10 月后
  // 根本覆盖不到「次年数据还没发布」这个真实故障点。
  for (const year of requiredYears()) {
    let lastError = "未知错误";
    let reachable = false;
    for (const url of holidaySourceUrls(year)) {
      try {
        await fetchJson(url, 8000);
        results.push(ok(`网络：节假日数据源 ${year}`, `可获取（${new URL(url).host}）`));
        reachable = true;
        break;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
    if (!reachable) results.push(fail(`网络：节假日数据源 ${year}`, `不可用：${lastError}`));
  }

  if (config.qweatherHost !== undefined) {
    // QWeather 只做可达性探测：真实调用会消耗当日配额，而根路径返回 4xx 属正常。
    // 因此这里不套用 fetchJson 的「非 2xx 即失败」，只把 5xx 与网络故障当问题。
    const url = `https://${config.qweatherHost}/`;
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(8000),
        redirect: "manual",
      });
      results.push(
        response.status < 500
          ? ok("网络：QWeather", `可达（HTTP ${response.status}，未做鉴权请求）`)
          : warn("网络：QWeather", `上游 5xx：HTTP ${response.status}`),
      );
    } catch (e) {
      results.push(fail("网络：QWeather", `不可达：${e instanceof Error ? e.message : String(e)}`));
    }
  }
  return results;
}

export async function runDoctor(
  env: NodeJS.ProcessEnv = process.env,
  opts: { network?: boolean; live?: boolean } = {},
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
  // 必须在 openDatabase 之前：后者会在迁移后把指纹对账到当前结构，届时永远「一致」。
  checks.push(checkSchemaFingerprint(config));
  checks.push(...checkDatabase(config));
  // 鉴权与私钥检查都必须基于「实际会被 daemon 读取的那份 env」，不能偷看 process.env
  checks.push(checkAuth(config));
  checks.push(checkQweather(config, env));
  checks.push(checkBackups(config));
  // 默认不碰网络：`--live` 才会连本机 daemon（未启动/内网环境下自检不能卡住）
  if (opts.live === true) {
    checks.push(...(await checkLive(config)));
  }
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
  // 安全基线：doctor 首次运行时可能创建数据目录/库，必须在任何 mkdir/open 之前收紧 umask。
  // 只做 umask：自检的职责是诊断，不主动 chmod 用户现有的库/备份（避免「自检改权限」的意外）。
  applySecureUmask();
  const args = process.argv.slice(2);
  const network = args.includes("--network");
  const live = args.includes("--live");
  runDoctor(process.env, { network, live })
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
      if (!live) {
        console.log("（加 --live 可检查运行中的 daemon：任务新鲜度、备份新鲜度）");
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
