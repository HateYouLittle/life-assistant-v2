import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import type { JobDef } from "./registry.js";
import { errorMessage } from "./registry.js";
import { logger } from "./logger.js";
import { now as localNow } from "../time.js";

/**
 * 定时任务运行记录与「停机补发」。
 *
 * 起因：node-cron 不会补发错过的触发 —— 每日简报、调休提醒、备份在 daemon 重启/升级
 * 恰好跨过触发时刻时就这么无声消失了（README 已知取舍 #13）。这里做三件事：
 *
 * 1. `job_runs` 记录：每次运行写一行（running → ok/failed/skipped），
 *    状态页与 `doctor --live` 据此判断「任务是否还在跑」；进程退出遗留的 running 行
 *    在下次启动时由 `markInterruptedJobRuns` 收敛成 failed（否则永远显示「执行中」）。
 * 2. 启动补发：只对白名单 `CATCHUP_POLICY` 里的 job 补最近一次错过的触发，
 *    且只补「距现在不超过窗口」的那次 —— 补 12 小时前的日报没有意义，还会惊扰用户。
 *    判断「上一次触发时刻」不引入 cron 库的反向求值：node-cron 只提供 validate/next，
 *    而补发只需要分钟/小时级的常见表达式，自写反向扫描足够且没有新依赖。
 * 3. 保留：`job_runs` 只增不减，随通知保留策略一起按天清理（30 天）。
 *
 * 时间口径：表里所有 `*_at` / `scheduled_for` 都是 UTC ISO（`....Z`），因此 SQL 里
 * 直接按字符串比较即时间比较。`previousFireTime` 的返回值刻意转成 UTC 再交给调用方，
 * 保证 `toISO()` 落在同一口径上 —— 若它返回 `+08:00` 的本地偏移串，与 UTC 串的
 * 字典序比较会得出错误结论（`+` 大于 `Z`）。
 */

export type JobTrigger = "cron" | "startup" | "catchup" | "manual";
export type JobRunStatus = "running" | "ok" | "failed" | "skipped";

export interface JobRunRow {
  id: number;
  job_name: string;
  module: string;
  trigger: JobTrigger;
  scheduled_for: string;
  started_at: string;
  finished_at: string | null;
  status: JobRunStatus;
  error: string | null;
}

export interface StartJobRunOptions {
  jobName: string;
  module: string;
  trigger: JobTrigger;
  /** 这次触发「本应」发生的时刻（cron 本次触发时刻 / 补发的原定时刻），UTC ISO */
  scheduledFor: string;
}

/** 进程退出遗留的 running 行收敛成 failed 时写入的原因 */
export const INTERRUPTED_RUN_ERROR = "执行中进程退出（daemon 重启）";

/**
 * 错误文本上限：job 的异常可能带很大的 JSON / 堆栈，落库并展示到看板上没有价值，
 * 只保留前 2000 字符（足够定位，又不至于把 job_runs 撑大）。
 */
const MAX_ERROR_LENGTH = 2000;

function utcNowIso(): string {
  return new Date().toISOString();
}

function trimError(error: string | undefined): string | null {
  if (error === undefined) return null;
  return error.length > MAX_ERROR_LENGTH ? error.slice(0, MAX_ERROR_LENGTH) : error;
}

/** 插入一条 status='running' 的运行记录，返回自增 id（finishJobRun 用它回填结果） */
export function startJobRun(db: DatabaseSync, opts: StartJobRunOptions): number {
  const result = db
    .prepare(
      `INSERT INTO job_runs (job_name, module, trigger, scheduled_for, started_at, status)
       VALUES (?, ?, ?, ?, ?, 'running')`,
    )
    .run(opts.jobName, opts.module, opts.trigger, opts.scheduledFor, utcNowIso());
  return Number(result.lastInsertRowid);
}

/**
 * 回填运行结果（finished_at 由这里写；耗时查询侧用 finished_at - started_at 计算，
 * 不再存一列 duration —— 冗余列会在 UPDATE 遗漏时与两个时间戳不一致）。
 */
export function finishJobRun(
  db: DatabaseSync,
  id: number,
  status: "ok" | "failed" | "skipped",
  error?: string,
): void {
  db.prepare("UPDATE job_runs SET status = ?, finished_at = ?, error = ? WHERE id = ?").run(
    status,
    utcNowIso(),
    trimError(error),
    id,
  );
}

/**
 * daemon 启动时调用：上一进程退出时仍处于 running 的行永远等不到回填，
 * 状态页会一直显示「执行中」。收敛成 failed 并写清原因（而不是删除 —— 记录本身
 * 就是「那次运行真的开始了但没结束」的证据，比如进程被 OOM kill）。
 */
export function markInterruptedJobRuns(db: DatabaseSync): number {
  const result = db
    .prepare(
      "UPDATE job_runs SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'",
    )
    .run(utcNowIso(), INTERRUPTED_RUN_ERROR);
  return Number(result.changes);
}

const JOB_RUN_COLUMNS =
  "id, job_name, module, trigger, scheduled_for, started_at, finished_at, status, error";

export interface RecentJobRunsOptions {
  limit?: number;
  jobName?: string;
}

/** 最近的运行记录（新的在前）；状态页「定时任务」抽屉与 /api/jobs 用 */
export function recentJobRuns(db: DatabaseSync, opts: RecentJobRunsOptions = {}): JobRunRow[] {
  const raw = opts.limit ?? 50;
  const limit = Number.isFinite(raw) ? Math.max(1, Math.min(Math.trunc(raw), 500)) : 50;
  if (opts.jobName !== undefined) {
    return db
      .prepare(
        `SELECT ${JOB_RUN_COLUMNS} FROM job_runs WHERE job_name = ? ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(opts.jobName, limit) as unknown as JobRunRow[];
  }
  return db
    .prepare(`SELECT ${JOB_RUN_COLUMNS} FROM job_runs ORDER BY started_at DESC, id DESC LIMIT ?`)
    .all(limit) as unknown as JobRunRow[];
}

/** 某个 job 最近一次运行（从未运行过返回 undefined） */
export function lastJobRun(db: DatabaseSync, jobName: string): JobRunRow | undefined {
  return db
    .prepare(
      `SELECT ${JOB_RUN_COLUMNS} FROM job_runs WHERE job_name = ? ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get(jobName) as unknown as JobRunRow | undefined;
}

/**
 * 启动补发白名单：`${module}.${jobName}` → 允许补发的最近小时数。
 * **不在表里的 job 一律不补发** —— 补发是「用户能感知到的副作用」，
 * 只能对确定幂等/可迟到的任务开放；数据库备份、清理类任务补跑意义有限，
 * 但同样列入是为了「错过了要知道」，窗口按各自节奏给。
 */
export const CATCHUP_POLICY: Record<string, number> = {
  // 每日简报：早晨错过 6 小时内补；再晚就当没发（补一条下午的「早报」没有意义）
  "weather.daily_brief": 6,
  // 晚报（21:00）：睡前 6 小时内仍可补
  "weather.evening_brief": 6,
  // 每日记账摘要（bookkeeping.ledger_digest，默认 21:30）：当天错过仍可补
  "bookkeeping.ledger_digest": 12,
  // 周报（bookkeeping.weekly_report，默认周日 20:00）：停机错过一天内仍可补
  "bookkeeping.weekly_report": 24,
  // 日志轮转（maintenance.log_rotate，默认 04:50）：错过一天仍可补，幂等
  "maintenance.log_rotate": 24,
  // 预警巡检每 20 分钟一次：只补最近 1 小时内的那次，更早的预警已过时
  "weather.alert_watch": 1,
  // 调休/补班提醒：与日报同一窗口
  "holiday.workday_watch": 6,
  // 节假日数据刷新：一天两次足够，12 小时内补一次
  "holiday.refresh": 12,
  // 每日备份：24 小时窗口内补一次，停机跨天也能拿到快照
  "maintenance.daily_backup": 24,
  // WAL checkpoint：同一天内补一次
  "maintenance.wal_checkpoint": 12,
  // 历史 occurrence 清理（04:30）：纯清理，补发只为让清理不因停机断档
  "schedule.occurrence_cleanup": 12,
  // 保留策略（04:50）：同上
  "notify.retention": 12,
};

/** `job_runs` 保留天数（只保留最近 30 天；更早的记录对排障已无意义） */
export const JOB_RUN_KEEP_DAYS = 30;

/**
 * 删除超过保留期的运行记录。由 notify 的 retention job 顺带调用 ——
 * 单独再起一个 cron 只会多一个可能错过的触发点。
 */
export function pruneJobRuns(
  db: DatabaseSync,
  now: number = Date.now(),
  keepDays: number = JOB_RUN_KEEP_DAYS,
): number {
  const cutoff = new Date(now - keepDays * 24 * 3600 * 1000).toISOString();
  const result = db.prepare("DELETE FROM job_runs WHERE started_at < ?").run(cutoff);
  return Number(result.changes);
}

// ── cron 反向求值 ──────────────────────────────────────────────────────────

/**
 * 解析一个 cron 字段，**复刻 node-cron 3.x 的转换语义**（而不是标准 cron）：
 *
 * 1. `*` 替换成 `min-max`（node-cron 的 convertAsterisksToRanges，星期字段是 0-6）；
 * 2. `a-b` 展开成区间内的每个整数，**端点 a>b 时交换**（range-conversion 行为）；
 * 3. 步长 `/n` 不是「从起点每 n 个」，而是**展开后保留 `value % n === 0`**
 *    （step-values-conversion 行为）：`9-18/2` → 10/12/14/16/18，`1-5/2` → 2/4；
 *    单值 `a/n` 只在 `a % n === 0` 时得到 `{a}`，否则该字段为空集（表达式永不触发）。
 *
 * 只接受能被上述流程精确表达的写法；其余（多个 `/`、多个 `*`、`1-2-3` 之类的病态写法）
 * 一律返回 null，由调用方按「宁可漏补，不猜」处理。返回值是字段内的整数集合；
 * 星期字段返回的 0 仍表示周日，由调用方映射到 luxon 的 7。
 */
function parseCronField(raw: string, min: number, max: number): Set<number> | null {
  const text = raw.trim();
  if (text === "") return null;
  // node-cron 的步长正则 `^(.+)\/(\w+)$` 作用于**整个字段**，多个 `/` 无法精确表达
  const slashCount = (text.match(/\//g) ?? []).length;
  if (slashCount > 1) return null;
  let base = text;
  let step = 1;
  if (slashCount === 1) {
    const cut = text.lastIndexOf("/");
    base = text.slice(0, cut);
    const stepRaw = text.slice(cut + 1);
    if (!/^\d+$/.test(stepRaw)) return null;
    step = Number(stepRaw);
    if (step < 1) return null;
  }
  // `*`：node-cron 只把字段里**第一个** `*` 替换成 min-max；还有剩余 `*` 则无法表达
  if (base.includes("*")) {
    base = base.replace("*", `${min}-${max}`);
    if (base.includes("*")) return null;
  }
  const expanded: number[] = [];
  for (const part of base.split(",")) {
    if (part === "") return null;
    const range = /^(\d+)-(\d+)$/.exec(part);
    let first: number;
    let last: number;
    if (range !== null) {
      first = Number(range[1]);
      last = Number(range[2]);
      // node-cron 的 range-conversion 在 a>b 时交换端点
      if (first > last) [first, last] = [last, first];
    } else if (/^\d+$/.test(part)) {
      first = Number(part);
      last = first;
    } else {
      return null;
    }
    // 越界值会被 node-cron 的 validate 拒绝（配置根本起不来）；这里同样放弃反向求值
    if (first < min || last > max) return null;
    for (let value = first; value <= last; value += 1) expanded.push(value);
  }
  // 步长：展开后按 value % n === 0 过滤（不是「从起点每 n 个」）
  const values = step === 1 ? expanded : expanded.filter((value) => value % step === 0);
  return values.length > 0 ? new Set(values) : null;
}

/**
 * 上一次（含当前分钟）触发的时刻。
 *
 * 支持的表达式：**日与月必须为 `*`**；分钟、小时、星期可任意组合（星期含 `7` 的
 * 范围/步长除外，见下）——启动补发需要覆盖 `0 20 * * 0` 这类周任务，否则
 * CATCHUP_POLICY 里的周报窗口只是一条永远算不出触发时刻的死配置。日/月非 `*` 的
 * 表达式（如 `0 9 1 * *`）仍直接返回 null 并 debug 一行：补发要的是「每天/每周这个点」
 * 的语义，遇到带月份日限制的表达式，宁可漏补，也不要把误判成「今天该跑」的通知推给用户。
 *
 * 关键：字段语义按 **node-cron 3.x 的实际转换**复刻（见 `parseCronField`），不是标准
 * cron——范围+步长是「先展开 a..b、再保留 `value % n === 0`」，如 `9-18/2` = 10/12/14/16/18、
 * `1-5/2` = 2/4；`a-b` 端点 a>b 会交换；单值 `a/n` 只在 a%n===0 时有效。照标准 cron 的
 * 「从 a 起每 n 个」实现会让补发判定与真实触发错位（漏补/多补）。
 *
 * 星期字段里 `7` 的边界（宁可漏补也不猜）：node-cron 先做**字符串级** `replace('7','0')`
 * （只替换第一处）再展开范围/步长，因此 `6-7` 实际是「0-6=每天」、`0-7` 是「0-0=仅周日」、
 * `1-7/2` 是「0,1/2=仅周日」—— 与「按 0..7 数值区间展开」并不等价。这里只在「单个值 /
 * 单值逗号列表」里接受 7（如 `7`、`5,7`，与 node-cron 语义一致）；一旦 7 出现在范围或
 * 步长（`6-7`、`0-7`、`1-7/2`…）就直接放弃反向求值。非 7 的范围/步长按上面的取模语义解析。
 *
 * 实现是从 `at` 所在分钟向前逐分钟扫描（最多 8 天，足以覆盖「每周一次」的最远间隔）：
 * 不用 cron 库的正向 next 反推，也就不依赖任何库的内部语义；典型日级表达式平均只扫几百次，
 * 启动时一次性的开销可忽略。星期判定取候选时刻在 `at` 所在时区的星期（调用方传本地 at）。
 *
 * 返回值是 **UTC** 的 DateTime（`toISO()` 形如 `...Z`），便于直接作为
 * `scheduled_for` 落库并与其它 UTC 时间戳做字符串比较。
 */
export function previousFireTime(expr: string, at: DateTime): DateTime | null {
  if (!at.isValid) return null;
  const rawParts = expr.trim().split(/\s+/);
  // 6 段（带秒）表达式：按分钟粒度补发只需丢掉秒字段，否则「能通过启动校验、却永远
  // 反查不出上次触发时刻」→ 停机错过后静默不补发（P2-19）。配置层已拒绝 6 段，
  // 这里兜住代码里新增的 job 定义；秒级触发最多差 59s，对「每天一次」的补发无影响。
  const parts = rawParts.length === 6 ? rawParts.slice(1) : rawParts;
  if (parts.length !== 5) {
    logger.debug(`补发：cron 不是 5 段，无法反向求值: "${expr}"`);
    return null;
  }
  const [minuteRaw, hourRaw, domRaw, monthRaw, dowRaw] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (domRaw !== "*" || monthRaw !== "*") {
    logger.debug(`补发：cron 的日/月不是 *，跳过反向求值: "${expr}"`);
    return null;
  }
  const minutes = parseCronField(minuteRaw, 0, 59);
  const hours = parseCronField(hourRaw, 0, 23);
  if (minutes === null || hours === null) {
    logger.debug(`补发：cron 的分钟/小时字段不受支持: "${expr}"`);
    return null;
  }
  // 星期字段：node-cron 先做字符串级 replace('7','0') 再按 0-6 展开/步长；`6-7`/`0-7`/
  // `1-7/2` 这类「范围或步长里含 7」的写法与数值区间语义不同（见文档注释），保守放弃。
  // 单值/单值列表里的 7 与 0 同义（周日），统一替换成 0 后按 0-6 的 node-cron 语义解析。
  let weekdays: Set<number> | null = null;
  if (dowRaw !== "*") {
    for (const part of dowRaw.split(",")) {
      if (/[-/]/.test(part) && part.includes("7")) {
        logger.debug(
          `补发：cron 的星期字段在范围/步长里含 7（node-cron 语义与数值区间不一致），跳过反向求值: "${expr}"`,
        );
        return null;
      }
    }
    const dowWithSevenNormalized = dowRaw
      .split(",")
      .map((part) => (/^\d+$/.test(part) && Number(part) === 7 ? "0" : part))
      .join(",");
    const dow = parseCronField(dowWithSevenNormalized, 0, 6);
    if (dow === null) {
      logger.debug(`补发：cron 的星期字段不受支持: "${expr}"`);
      return null;
    }
    weekdays = new Set([...dow].map((value) => (value === 0 ? 7 : value)));
  }

  // 含当前分钟：若 daemon 恰好在触发分钟内启动（node-cron 此时已错过今天的注册时机），
  // 这次触发对本进程而言就是「刚错过」，应当补发。重复执行由覆盖判定兜住。
  let candidate = at.set({ second: 0, millisecond: 0 });
  const maxMinutes = 8 * 24 * 60;
  for (let i = 0; i <= maxMinutes; i += 1) {
    if (i > 0) candidate = candidate.minus({ minutes: 1 });
    if (
      minutes.has(candidate.minute) &&
      hours.has(candidate.hour) &&
      (weekdays === null || weekdays.has(candidate.weekday))
    ) {
      return candidate.toUTC();
    }
  }
  logger.debug(`补发：cron "${expr}" 在 8 天内找不到触发点`);
  return null;
}

/**
 * 该 job 是否已有一次成功运行覆盖了 `scheduledFor` 这一刻：
 * 补发规划与「规划后、执行前」的二次确认共用同一判定。
 *
 * 两个条件任一成立即算覆盖：
 * - `finished_at >= scheduledFor`：最近一次成功运行发生在这次原定触发之后
 *   （典型：停机跨过触发时刻，重启后手工/cron 已经跑过）；
 * - `scheduled_for >= scheduledFor`：更晚的触发已经有了成功记录（cron 的
 *   scheduled_for 即本次原定时刻，直接比较最准）。
 */
function hasSuccessfulRunCovering(
  db: DatabaseSync,
  jobName: string,
  scheduledFor: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS hit FROM job_runs
       WHERE job_name = ? AND status = 'ok'
         AND ((finished_at IS NOT NULL AND finished_at >= ?) OR scheduled_for >= ?)
       LIMIT 1`,
    )
    .get(jobName, scheduledFor, scheduledFor) as { hit: number } | undefined;
  return row !== undefined;
}

export interface CatchupPlan {
  module: string;
  def: JobDef;
  /** 这次补发对应的「原定触发时刻」（UTC ISO），落库时写进 scheduled_for */
  scheduledFor: string;
}

function jobCronExpr(def: JobDef): string | null {
  try {
    return typeof def.cron === "function" ? def.cron() : def.cron;
  } catch (e) {
    // cron 是函数（如从 config 读取）时依赖 runtime；补发发生在 daemon 内，正常不会失败。
    // 万一失败也不能让启动补发整体崩掉 —— 记录并跳过该 job。
    logger.warn(`补发：无法求值 ${def.name} 的 cron: ${errorMessage(e)}`);
    return null;
  }
}

/**
 * 规划启动补发（纯计算，不执行任何 job）。
 *
 * 对每个有策略的 job：求上一次触发时刻 → 超出窗口跳过 → 已有成功运行覆盖则跳过。
 * 返回的列表交给 daemon 串行执行（runStartupCatchups）；拆成两步是为了让
 * 「该不该补」可以脱离副作用单独测试。
 */
export function planCatchups(
  db: DatabaseSync,
  jobs: { module: string; def: JobDef }[],
  now: DateTime,
): CatchupPlan[] {
  const plans: CatchupPlan[] = [];
  for (const { module, def } of jobs) {
    const withinHours = CATCHUP_POLICY[`${module}.${def.name}`];
    if (withinHours === undefined) continue;
    const expr = jobCronExpr(def);
    if (expr === null) continue;
    const previous = previousFireTime(expr, now);
    if (previous === null) {
      // 反向求值失败 = 这个 job 停机后永远不补发，旧实现只打 debug（日志级别 info 时
      // 完全看不见）。这里用 warn，让「日/月字段受限或写法特殊」在启动时就暴露（P2-19）。
      logger.warn(
        `启动补发无法反向求值 ${module}.${def.name} 的 cron "${expr}"（需 5 段、且日/月为 *），` +
          "该任务停机错过时不会补发",
      );
      continue;
    }
    // 超窗口：错过了太久，补发只会打扰用户（且数据已过时）
    if (now.toMillis() - previous.toMillis() > withinHours * 3600 * 1000) continue;
    const scheduledFor = previous.toISO();
    if (scheduledFor === null) continue;
    if (hasSuccessfulRunCovering(db, def.name, scheduledFor)) continue;
    plans.push({ module, def, scheduledFor });
  }
  // 稳定排序（module.name）：日志顺序与测试断言不依赖 allJobs() 的注册顺序
  return plans.sort((a, b) =>
    `${a.module}.${a.def.name}`.localeCompare(`${b.module}.${b.def.name}`),
  );
}

export interface StartupCatchupOptions {
  db: DatabaseSync;
  jobs: { module: string; def: JobDef }[];
  /** 由 daemon 注入：负责给 job 包一层 job_runs 记录（trigger='catchup'） */
  runJob: (module: string, def: JobDef, trigger: "catchup", scheduledFor: string) => Promise<void>;
  now?: DateTime;
}

/**
 * 执行启动补发：串行调用 runJob，单个失败只记日志，不中断其它 job。
 *
 * 串行而非并行：补发会写库并发布通知（outbox drain 与 cron 的 runExclusive 共用
 * 同一份「不重叠」约定），并发补发会让两条推送几乎同时发出，且日志难以对照。
 */
export async function runStartupCatchups(
  opts: StartupCatchupOptions,
): Promise<{ scheduled: number }> {
  const at = opts.now ?? localNow();
  let plans: CatchupPlan[];
  try {
    plans = planCatchups(opts.db, opts.jobs, at);
  } catch (e) {
    logger.error(`启动补发规划失败: ${errorMessage(e)}`);
    return { scheduled: 0 };
  }
  if (plans.length === 0) {
    logger.debug("启动补发：没有需要补发的任务");
    return { scheduled: 0 };
  }
  logger.info(
    `启动补发：${plans.length} 个任务（${plans
      .map((plan) => `${plan.module}.${plan.def.name}@${plan.scheduledFor}`)
      .join("、")}）`,
  );
  let scheduled = 0;
  for (const plan of plans) {
    // 规划到执行之间可能已被 cron/另一次补发跑过（同一分钟内启动的竞态），执行前再确认一次
    if (hasSuccessfulRunCovering(opts.db, plan.def.name, plan.scheduledFor)) {
      logger.debug(`启动补发跳过 ${plan.module}.${plan.def.name}：规划后已有成功运行`);
      continue;
    }
    scheduled += 1;
    try {
      await opts.runJob(plan.module, plan.def, "catchup", plan.scheduledFor);
    } catch (e) {
      logger.error(`启动补发 ${plan.module}.${plan.def.name} 失败: ${errorMessage(e)}`);
    }
  }
  return { scheduled };
}
