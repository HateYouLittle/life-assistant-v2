import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { ResolvedConfig } from "../config.js";
import { resolveIdentity } from "../core/auth.js";
import { backupStatus } from "../core/backup.js";
import { lastJobRun } from "../core/jobs.js";
import { logger, sanitizeLogText } from "../core/logger.js";
import { incCounter, snapshotCounters } from "../core/metrics.js";
import { qweatherUsage } from "../core/qweather.js";
import { envClientAddress } from "../core/ratelimit.js";
import { allJobs } from "../core/registry.js";

/**
 * 运维端点：Prometheus 文本指标（`/metrics`）与就绪探针（`/readyz`）。
 *
 * 为什么单独一个 app 而不塞进 status.ts：这两个端点的「数据口径 + 鉴权面」和状态页
 * （个人数据看板）完全不同 —— `/metrics` 只给 master token，`/readyz` 完全不鉴权
 * （外部监控/launchd 探针不能持有凭据）。混在一起后，改看板鉴权时很容易顺手把探针
 * 也加上 token 校验，监控就静默失效了。
 *
 * 两个端点都不返回个人数据：指标只有计数/字节/时间戳，探针只有原因标识符。
 */

/**
 * WAL 超过这个字节数即判定不健康（512MB）。
 * 为什么是 512MB：正常 checkpoint 后 WAL 会回到 0 字节，长期维持数百 MB 说明 checkpoint
 * 一直被写锁挡住；此时磁盘占用与崩溃恢复时间都会失控，应当在长成故障前先被监控看见。
 */
export const READYZ_WAL_MAX_BYTES = 512 * 1024 * 1024;

/**
 * outbox 最老 `queued` 投递超过这个时长即判定不健康（30 分钟）。
 * 正常投递是秒级（drain 每 20s 一轮 + 发布后 100ms 去抖），30 分钟没有任何推进只可能是
 * 路由被停用/secret 缺失/进程假死 —— 都该让外部监控报警。
 */
export const READYZ_OUTBOX_MAX_AGE_MS = 30 * 60 * 1000;

/** `deliveries.status` 的全部取值（与 database.ts 的 CHECK 约束一致）：缺失状态也必须输出 0 行 */
const DELIVERY_STATUSES = ["queued", "sending", "sent", "failed", "fallback", "cancelled"] as const;

/**
 * 要导出的进程内计数器：与 incCounter 的调用点保持一致。
 * 未出现过的键必须补 0 —— 计数器是进程内存态（重启即归零），抓取端需要稳定的样本集合，
 * 否则 Grafana 上「指标消失」与「值为 0」分不清。
 */
const EXPORTED_COUNTERS = [
  "auth_failed_total",
  "auth_forbidden_total",
  "rate_limited_total",
] as const;

/**
 * Prometheus 文本格式的标签值转义：反斜杠、双引号、换行不转义会让抓取端直接解析失败
 * （整份响应作废，不只是这一行）。转义顺序必须是先反斜杠 —— 否则会把后面补出来的
 * 反斜杠再转义一次，产出 `\\"` 这种双倍转义。
 */
export function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/**
 * 数字字面量：NaN/Infinity 不是合法 Prometheus 样本（抓取端会判为解析错误），
 * 统一降级成 fallback。浮点固定 3 位小数，避免 toExponential 产出 `1e-7` 这种
 * 合法但人读不了的形式；整数不带小数点（时间戳/字节数）。
 */
function num(value: number, fallback = 0): string {
  if (!Number.isFinite(value)) return String(fallback);
  return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

/** 文件字节数；文件不存在（尚无 WAL / 库文件被移走）按 0，不能让 stat 抛错打断整个抓取 */
function fileBytes(path: string): number {
  return statSync(path, { throwIfNoEntry: false })?.size ?? 0;
}

function count(db: DatabaseSync, sql: string): number {
  return (db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0;
}

/** 各 job 最近一次成功运行的时刻（Unix 秒）；从未成功返回 0 */
function lastSuccessSeconds(db: DatabaseSync, jobName: string): number {
  // 先用 lastJobRun 取「最近一次运行」：它恰好成功时省掉第二次查询。
  // 但「最近一次失败」不等于「从未成功」—— 只按 lastJobRun 的 status 判定，会让
  // 昨天成功、今天失败的 job 显示成 0，监控于是误报「从未成功」并掩盖真实故障点。
  const latest = lastJobRun(db, jobName);
  const okRow: { started_at: string; finished_at: string | null } | undefined =
    latest?.status === "ok"
      ? latest
      : (db
          .prepare(
            `SELECT started_at, finished_at FROM job_runs
             WHERE job_name = ? AND status = 'ok'
             ORDER BY started_at DESC, id DESC LIMIT 1`,
          )
          .get(jobName) as { started_at: string; finished_at: string | null } | undefined);
  if (okRow === undefined) return 0;
  // 成功时刻取 finished_at（「跑完并成功」才算成功）；老记录缺 finished_at 时退回 started_at
  const at = Date.parse(okRow.finished_at ?? okRow.started_at);
  return Number.isFinite(at) ? Math.floor(at / 1000) : 0;
}

/** 渲染 Prometheus 文本（version=0.0.4）。nowMs 由调用方注入，便于测试钉死时间口径 */
function metricsText(config: ResolvedConfig, db: DatabaseSync, nowMs: number): string {
  const lines: string[] = [];
  const gauge = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${num(value)}`);
  };
  const counter = (name: string, help: string, value: number): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} counter`, `${name} ${num(value)}`);
  };

  // up 恒为 1：能渲染出这份响应就说明进程活着；「库还能不能写」由 /readyz 回答
  gauge("life_assistant_up", "进程存活（1=存活；进程内计数器重启后归零）", 1);

  const counters = snapshotCounters();
  for (const key of EXPORTED_COUNTERS) {
    counter(`life_assistant_${key}`, `进程内累计计数 ${key}`, counters[key] ?? 0);
  }

  const deliveryRows = db
    .prepare("SELECT status, COUNT(*) AS n FROM deliveries GROUP BY status")
    .all() as { status: string; n: number }[];
  const deliveryCounts = new Map<string, number>(
    deliveryRows.map((row): [string, number] => [row.status, row.n]),
  );
  lines.push(
    "# HELP life_assistant_deliveries outbox 投递数（按状态）",
    "# TYPE life_assistant_deliveries gauge",
  );
  for (const status of DELIVERY_STATUSES) {
    lines.push(
      `life_assistant_deliveries{status="${status}"} ${num(deliveryCounts.get(status) ?? 0)}`,
    );
  }

  // 最老待投递：只算 queued/failed（sending 是在途、sent/cancelled 是终态）。
  // 时间戳可能被手工改库写坏：解析失败或落在未来一律按 0，宁可少报积压也不误报。
  const oldestRow = db
    .prepare("SELECT MIN(created_at) AS oldest FROM deliveries WHERE status IN ('queued','failed')")
    .get() as { oldest: string | null } | undefined;
  const oldestMs = oldestRow?.oldest == null ? Number.NaN : Date.parse(oldestRow.oldest);
  gauge(
    "life_assistant_outbox_oldest_pending_seconds",
    "最老的 queued/failed 投递距今秒数（无待投为 0）",
    Number.isFinite(oldestMs) ? Math.max(0, (nowMs - oldestMs) / 1000) : 0,
  );

  // 通知总行数：保留策略会按天删行，因此不是单调递增的 counter，按 gauge 导出
  gauge(
    "life_assistant_notifications_total",
    "通知总行数（保留策略会删行，故为 gauge）",
    count(db, "SELECT COUNT(*) AS n FROM notifications"),
  );

  // 每个注册 job 一行（未运行的 job 也要有样本，否则「任务消失」看不出来）
  lines.push(
    "# HELP life_assistant_job_last_success_timestamp_seconds 各 job 最近一次成功运行的完成时刻（Unix 秒；从未成功为 0）",
    "# TYPE life_assistant_job_last_success_timestamp_seconds gauge",
  );
  for (const { module, def } of allJobs()) {
    const job = escapeLabelValue(`${module}.${def.name}`);
    lines.push(
      `life_assistant_job_last_success_timestamp_seconds{job="${job}"} ${num(lastSuccessSeconds(db, def.name))}`,
    );
  }

  // 无备份为 -1（而不是 0）：0 会被误读成「刚刚备份过」，-1 在图上能一眼看出缺失
  const backup = backupStatus(config, nowMs);
  gauge(
    "life_assistant_backup_latest_age_seconds",
    "最新规范备份距今秒数（无备份为 -1）",
    backup.ageHours === null ? -1 : backup.ageHours * 3600,
  );
  // 零开库口径：读备份成功时写的 <name>.verified 旁车。1=最新备份有可信校验，
  // 0=没有/不可信（深度校验以 doctor --live 的开库结果为准）
  const backupVerify = backupStatus(config, nowMs, { sidecar: true });
  gauge(
    "life_assistant_backup_latest_verified",
    "最新规范备份是否有可信的校验旁车（1=有，0=无/不可信；深度校验见 doctor --live）",
    backupVerify.latestVerified === true ? 1 : 0,
  );

  gauge("life_assistant_db_bytes", "主库文件字节数", fileBytes(config.dbPath));
  // SQLite 的 WAL 文件名就是主库路径加 -wal 后缀；无 WAL（已 checkpoint/非 WAL 模式）为 0
  gauge(
    "life_assistant_wal_bytes",
    "WAL 文件字节数（无 WAL 为 0）",
    fileBytes(`${config.dbPath}-wal`),
  );

  // 当日上游请求数（含重试）：官方自 2027-02-01 起限制 API KEY 日请求量，用量必须可见
  gauge(
    "life_assistant_qweather_requests_today",
    "当日 QWeather 上游请求数（按本地日历日，重启后从库读回）",
    qweatherUsage().requests,
  );

  // 文本格式要求以换行结尾，否则最后一个样本可能被抓取端截断
  return `${lines.join("\n")}\n`;
}

/**
 * 可写探针：`BEGIN IMMEDIATE` 会真正申请写锁（`BEGIN` 只拿读事务，磁盘只读/库被别进程
 * 独占时照样"成功"），失败即「现在写不进去」。必须 ROLLBACK：留下一个开着的事务会让
 * 后续所有写请求撞上 "cannot start a transaction within a transaction"。
 */
function probeWritable(db: DatabaseSync): boolean {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch {
    return false;
  }
  try {
    db.exec("ROLLBACK");
    return true;
  } catch {
    // BEGIN 成功但 ROLLBACK 失败说明连接已损坏：不能留下脏事务，直接判定不健康
    return false;
  }
}

/** 最老 `queued` 投递的创建时刻（毫秒）；没有 queued 或时间戳不可解析返回 null（不误报卡住） */
function oldestQueuedMs(db: DatabaseSync): number | null {
  try {
    const row = db
      .prepare("SELECT MIN(created_at) AS oldest FROM deliveries WHERE status = 'queued'")
      .get() as { oldest: string | null } | undefined;
    if (row?.oldest == null) return null;
    const at = Date.parse(row.oldest);
    return Number.isFinite(at) ? at : null;
  } catch {
    // 探针绝不能因为一次查询异常变成 500（外部监控只会看到「探针坏了」）：
    // 读不出来就当作无法判定，库整体不可用的情况由可写探针兜住
    return null;
  }
}

/** 就绪判定的全部原因标识符（只给标识符，不带任何个人数据/计数，可安全暴露给外部监控） */
function readinessReasons(config: ResolvedConfig, db: DatabaseSync, nowMs: number): string[] {
  const reasons: string[] = [];
  const writable = probeWritable(db);
  if (!writable) reasons.push("db_not_writable");
  if (fileBytes(`${config.dbPath}-wal`) > READYZ_WAL_MAX_BYTES) reasons.push("wal_too_large");
  // 库写不进去时再查 outbox 只会撞同一个错误；db_not_writable 已经足够说明问题
  if (writable) {
    const oldest = oldestQueuedMs(db);
    if (oldest !== null && nowMs - oldest > READYZ_OUTBOX_MAX_AGE_MS)
      reasons.push("outbox_stalled");
  }
  return reasons;
}

export function createOpsApp(config: ResolvedConfig, db: DatabaseSync): Hono {
  const app = new Hono();

  // no-store 逐路由设置，而不用 app.use("*")：本 app 会被 .route("/", …) 挂到根路径上，
  // 一个 "*" 中间件在 Hono 里会以 "/*" 合并进父路由，从而顺带作用于**同级的其它 app**
  // （挂载顺序一变，状态页就凭空多出 no-store）。两个端点都是实时结论：被缓存住的
  // 探针/指标比没有更危险（监控看到的是几分钟前的旧状态）。
  const NO_STORE = { "Cache-Control": "no-store" } as const;

  app.get("/metrics", (c) => {
    // 只认 Authorization 头，不接受 ?token=：抓取端（Prometheus/Uptime Kuma）用 header，
    // 而 URL 里的凭据会进反代/网关访问日志 —— 运维面不该为了便利泄漏 token。
    const identity = resolveIdentity({
      masterToken: config.webApiToken,
      profileTokens: config.profileTokens,
      authorization: c.req.header("Authorization"),
    });
    if (identity === null) {
      // 与状态页/quick/calendar 同一口径：鉴权失败既计数也写 warn 日志。
      // 公网暴露后 /metrics 是扫描目标之一，只有计数器而没有日志会丢掉「谁在试」的线索。
      incCounter("auth_failed_total");
      // 来源可能来自 X-Forwarded-For（TRUST_PROXY=1），净化+截断后再落单行日志。
      logger.warn(
        `鉴权失败: /metrics from ${sanitizeLogText(envClientAddress(c.env, config.trustProxy), 100)}`,
      );
      return c.json({ error: "unauthorized" }, 401, NO_STORE);
    }
    if (identity.kind === "profile") {
      incCounter("auth_forbidden_total");
      return c.json(
        { error: "forbidden", message: "指标仅 master token 可访问（WEB_API_TOKEN）" },
        403,
        NO_STORE,
      );
    }
    return c.body(metricsText(config, db, Date.now()), 200, {
      ...NO_STORE,
      "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    });
  });

  // 就绪探针：不鉴权（外部监控不该持有 token），也只回答健康与否 ——
  // 不返回计数/年龄/库路径，避免把个人数据或主机细节暴露给无凭据的调用方。
  app.get("/readyz", (c) => {
    const reasons = readinessReasons(config, db, Date.now());
    if (reasons.length === 0) return c.json({ ok: true }, 200, NO_STORE);
    return c.json({ ok: false, reasons }, 503, NO_STORE);
  });

  return app;
}
