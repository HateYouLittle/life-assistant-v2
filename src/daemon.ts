import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { DatabaseSync } from "node:sqlite";
import { getRequestListener } from "@hono/node-server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { DateTime } from "luxon";
import cron from "node-cron";
import { bindHost, loadConfig, parseProfileId, type ResolvedConfig, urlHost } from "./config.js";
import { bearerToken, resolveIdentity, tokenFingerprint } from "./core/auth.js";
import { openDatabase } from "./core/database.js";
import { createInFlightTracker, type InFlightTracker } from "./core/inflight.js";
import { createJobRunner } from "./core/job-runner.js";
import { markInterruptedJobRuns, runStartupCatchups } from "./core/jobs.js";
import { acquireDaemonLock } from "./core/lock.js";
import { logger, maskSensitiveUrl, sanitizeLogText, setLogLevel } from "./core/logger.js";
import { incCounter } from "./core/metrics.js";
import { cancelPendingDrain, createServices, drainDue, waitForDrain } from "./core/notify.js";
import {
  bumpQweatherUsage,
  readQweatherUsage,
  seedQweatherUsage,
  setQweatherUsageSink,
} from "./core/qweather.js";
import { clientAddress, FixedWindowLimiter } from "./core/ratelimit.js";
import {
  allJobs,
  allTools,
  errorMessage,
  fail,
  getModules,
  initRuntime,
  type JobDef,
  type ToolContext,
} from "./core/registry.js";
import { applySecureUmask, createRequestGuard, hardenDataDir } from "./core/security.js";
import { ensureProfile, pruneCache } from "./core/settings.js";
import { registerAllModules } from "./modules/index.js";
import { createCalendarApp } from "./server/calendar.js";
import { createOpsApp } from "./server/ops.js";
import { createQuickApp } from "./server/quick.js";
import { createStatusApp } from "./server/status.js";
import { now, TZ } from "./time.js";

const require = createRequire(import.meta.url);
const VERSION = (require("../package.json") as { version: string }).version;

interface Session {
  profileId: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  /** 最后访问时间（ms）：用于回收孤立会话 */
  lastSeen: number;
}

/** 空闲会话回收阈值；stdio 壳不会发 DELETE，只靠 TTL/上限兜底 */
const SESSION_IDLE_MS = 2 * 3600 * 1000;
const MAX_SESSIONS = 200;
/** 停机时等待在途 cron job / tick 的上限（它们可能正在发布通知） */
const JOB_SHUTDOWN_WAIT_MS = 10_000;
/** 停机时等在途 HTTP/MCP 请求收敛的上界：写工具可能发通知/写 SMTP（5~10s），取 8s */
const HTTP_SHUTDOWN_WAIT_MS = 8_000;

async function buildMcpServer(
  profileId: string,
  db: DatabaseSync,
  config: ResolvedConfig,
): Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> {
  // 会话一建立就登记 Profile：只调用 notify.pull / 天气等只读工具的 Profile 此前
  // 永远不会写 profiles 表，而每日简报/预警巡检只遍历 listProfiles()，会导致
  // 「纯 pull 型 Profile 收不到简报」以及无法把个人账本转给该 Profile。
  // 放在 buildMcpServer 而非响应之后，保证 initialize 返回时行已落库。
  ensureProfile(db, profileId);
  const server = new McpServer({ name: "life-assistant", version: VERSION });
  const services = createServices(db, config);
  for (const { def } of allTools()) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      async (args, extra) => {
        const ctx: ToolContext = {
          profileId:
            extra.sessionId !== undefined
              ? profileIdForSession(extra.sessionId, profileId)
              : profileId,
          db,
          config,
          services,
        };
        try {
          return await def.handler(args as Record<string, unknown>, ctx);
        } catch (e) {
          return fail(errorMessage(e));
        }
      },
    );
  }
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessionclosed: (sessionId) => {
      sessions.delete(sessionId);
      logger.debug(`MCP 会话关闭: ${sessionId}`);
    },
  });
  await server.connect(transport);
  return { server, transport };
}

const sessions = new Map<string, Session>();

function profileIdForSession(sessionId: string, fallback: string): string {
  return sessions.get(sessionId)?.profileId ?? fallback;
}

function dropSession(sessionId: string, session: Session): void {
  sessions.delete(sessionId);
  session.server.close().catch((e) => logger.debug(`关闭 MCP 会话失败: ${errorMessage(e)}`));
}

/** 回收空闲/超量会话（daemon 每 20s 调用；导出以便测试） */
export function sweepSessions(nowMs: number = Date.now()): number {
  let removed = 0;
  for (const [id, session] of sessions) {
    if (nowMs - session.lastSeen > SESSION_IDLE_MS) {
      dropSession(id, session);
      removed += 1;
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].lastSeen - b[1].lastSeen);
    for (const [id, session] of oldest.slice(0, sessions.size - MAX_SESSIONS)) {
      dropSession(id, session);
      removed += 1;
    }
  }
  if (removed > 0) logger.debug(`回收 MCP 会话 ${removed} 个，当前 ${sessions.size} 个`);
  return removed;
}

async function handleMcp(
  req: IncomingMessage,
  res: ServerResponse,
  db: DatabaseSync,
  config: ResolvedConfig,
): Promise<void> {
  // 只接受 Authorization: Bearer。/mcp 不接受 ?token= —— URL 会进入访问日志、
  // 浏览器历史与 Referer，凭据不应出现在那里（状态页仍支持 ?token= 首次引导）。
  //
  // 身份解析：配了 PROFILE_TOKENS_JSON 时，Profile token 直接绑定该 Profile
  // （不再信任 X-Hermes-Profile 自报）；master token 仍可按头切换（看板/运维/兼容旧部署）。
  const identity = resolveIdentity({
    masterToken: config.webApiToken,
    profileTokens: config.profileTokens,
    authorization: req.headers.authorization,
  });
  if (identity === null) {
    incCounter("auth_failed_total");
    // 来源在 TRUST_PROXY=1 时取自 X-Forwarded-For：净化+截断后再落单行日志。
    logger.warn(
      `鉴权失败: /mcp from ${sanitizeLogText(clientAddress(req, config.trustProxy), 100)}（master/Profile token 均不匹配）`,
    );
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "unauthorized：/mcp 需要 Authorization: Bearer <Profile token 或 WEB_API_TOKEN>",
        },
        id: null,
      }),
    );
    return;
  }

  const headerSession = req.headers["mcp-session-id"];
  if (typeof headerSession === "string" && headerSession !== "") {
    const session = sessions.get(headerSession);
    if (session === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "Session not found（daemon 可能已重启或会话已回收，请重新 initialize）",
          },
          id: null,
        }),
      );
      return;
    }
    // 会话 id 是随机 UUID，但仍要校验身份与创建会话时的 Profile 一致：
    // 否则拿到别人会话 id 的 Profile token 可以借道读写他人数据。
    if (identity.kind === "profile" && identity.profileId !== session.profileId) {
      incCounter("auth_failed_total");
      // session id 来自请求头（理论上可控文本）：净化+截断后再拼日志。
      logger.warn(
        `鉴权失败: /mcp 会话 ${sanitizeLogText(headerSession, 80)} 属于 ${session.profileId}，但当前 token 绑定 ${identity.profileId}`,
      );
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: {
            code: -32001,
            message: "forbidden：会话与 token 所属 Profile 不一致，请重新 initialize",
          },
          id: null,
        }),
      );
      return;
    }
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res);
    return;
  }

  const rawProfile = req.headers["x-hermes-profile"];
  let profileId = "default";
  if (identity.kind === "profile") {
    // Profile token 是强绑定：忽略（并记 debug）调用方自报的头，避免越权。
    profileId = identity.profileId;
    if (typeof rawProfile === "string" && rawProfile !== "" && rawProfile !== profileId) {
      // 自报头同样是请求可控文本：debug 日志也净化，避免控制字符/超长内容进日志。
      logger.debug(
        `Profile token 绑定 ${identity.profileId}，忽略 X-Hermes-Profile=${sanitizeLogText(rawProfile, 80)}`,
      );
    }
  } else if (typeof rawProfile === "string" && rawProfile !== "") {
    try {
      profileId = parseProfileId(rawProfile, "X-Hermes-Profile");
    } catch (e) {
      // 客户端头非法属于请求错误（400），不应落到 500 被当成服务端故障
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32602, message: `invalid params: ${errorMessage(e)}` },
          id: null,
        }),
      );
      return;
    }
  }
  const { server, transport } = await buildMcpServer(profileId, db, config);
  await transport.handleRequest(req, res);
  const sessionId = transport.sessionId;
  if (typeof sessionId === "string" && sessionId !== "") {
    sessions.set(sessionId, { profileId, server, transport, lastSeen: Date.now() });
    logger.info(`MCP 会话建立: ${sessionId} (profile=${profileId})`);
    sweepSessions();
    return;
  }
  // 未建立会话（典型：缺 mcp-session-id 的非 initialize 请求，被 transport 直接拒绝）：
  // 这个 server/transport 没有任何地方持有它，必须就地释放，否则每次这类请求都会泄漏一份。
  await server.close().catch((e) => logger.debug(`关闭未建立的 MCP 会话失败: ${errorMessage(e)}`));
}

function isMcpPath(url: string): boolean {
  return url === "/mcp" || url.startsWith("/mcp?") || url.startsWith("/mcp/");
}

/**
 * 探针豁免限流的路径判定：只认**精确路径**（允许带 query）。
 *
 * 为什么不能用前缀：`req.url` 是原始请求行，`/healthz/../api/status` 或 `%2e%2e`
 * 形态在 Hono 侧会被归一化到真实业务路由，但前缀匹配仍会把它当成探针而整段跳过
 * 限流（Round4 终审实测可无限打 `/api/*` 并放大鉴权失败日志）。`/healthzzz`
 * 这类只多花一次 404 的旧观察也一并收紧。
 */
function isProbeExemptPath(url: string): boolean {
  const queryAt = url.indexOf("?");
  const pathname = queryAt < 0 ? url : url.slice(0, queryAt);
  return pathname === "/healthz" || pathname === "/readyz";
}

/** HTTP 入口（/mcp 走 MCP，其余走状态页）；导出以便不启动调度器即可测试 */
export interface HttpHandlerHooks {
  /**
   * 在途请求追踪（P2-8）。MCP 请求按 **handler Promise** 计（工具执行本身），
   * 其余请求按响应结束/连接关闭计 —— MCP 的 SSE 长连接不参与，避免停机白等。
   */
  inFlight?: InFlightTracker;
  /**
   * 停机拒绝新请求。由 daemon 的 server 包装层在 `inflight.closed` 时返回 true 后处理，
   * 这里只在入口再兜一次（防止测试直接调 handler 时漏判）。
   */
}

export function createHttpHandler(
  config: ResolvedConfig,
  db: DatabaseSync,
  hooks: HttpHandlerHooks = {},
): (req: IncomingMessage, res: ServerResponse) => void {
  // 手机入口（/quick、/api/quick/*）、日历订阅（/calendar.ics）与运维端点（/metrics、/readyz）
  // 都是独立子应用，挂在同一个 Hono 上：共享 createHttpHandler 的 Host/Origin 守卫与限流。
  const app = createStatusApp(config, db)
    .route("/", createQuickApp(config, db))
    .route("/", createCalendarApp(config, db))
    .route("/", createOpsApp(config, db));
  const honoListener = getRequestListener(app.fetch);
  // Host/Origin 守卫：状态页与 /mcp 都没有 CSRF token，浏览器跨站请求（含 DNS rebinding：
  // 攻击者把域名解析到 127.0.0.1）会带着伪造 Host 直接读写个人数据。没有 Origin 的
  // 非浏览器客户端（Hermes/CLI/curl）照常放行。
  const guard = createRequestGuard(config);
  // 固定窗口限流：公网（经 Lucky 反代）暴露后的兜底，避免一个来源把服务打满。
  // 双层计数：
  // - IP 桶对**每个**请求都计数：未鉴权 / 无效凭据 / 伪造 Bearer 都只能落在这里，
  //   不能靠轮换 token 换桶（旧实现直接按任意 Bearer 指纹分桶，伪 token 即可绕过）；
  // - 鉴权通过且带 Bearer 时才额外按 token 指纹计一层：同一人跨 IP 共用一个身份桶，
  //   不同人互不牵连。
  // /healthz 与 /readyz 不参与限流；/metrics 与业务接口同口径仍受限。
  const limiter = new FixedWindowLimiter(config.rateLimitPerMinute, 60_000);
  return (req, res) => {
    const verdict = guard(req);
    if (!verdict.ok) {
      res.writeHead(verdict.status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: verdict.body }));
      return;
    }
    const url = req.url ?? "/";
    // 探针豁免限流：/healthz 给 systemd/uptime，/readyz 给外部监控（高频轮询），
    // 被 429 会误判成「服务不健康」。/metrics 带凭据且较重，仍参与限流。
    // 只按**精确路径**豁免：`/healthz/../api/status` 这类原始 URL 会被 Hono/URL 归一化
    // 成真实业务路由，用前缀匹配会让它整段跳过限流（公网可无限打 /api/*、刷鉴权失败日志）。
    if (config.rateLimitPerMinute > 0 && !isProbeExemptPath(url)) {
      const ipDecision = limiter.take(`ip:${clientAddress(req, config.trustProxy)}`);
      const presented = bearerToken(req.headers.authorization);
      // query token 不参与限流：它只用于状态页首次引导，且会进 URL/日志。
      const identity =
        presented === undefined
          ? null
          : resolveIdentity({
              masterToken: config.webApiToken,
              profileTokens: config.profileTokens,
              authorization: req.headers.authorization,
            });
      const tokenDecision =
        presented === undefined || identity === null
          ? { allowed: true, retryAfterMs: 0 }
          : limiter.take(`t:${tokenFingerprint(presented)}`);
      const denied = !ipDecision.allowed
        ? ipDecision
        : !tokenDecision.allowed
          ? tokenDecision
          : null;
      if (denied !== null) {
        incCounter("rate_limited_total");
        // URL 里可能有 `?token=`（状态页引导）/`?sig=`（日历订阅）：日志前打码，
        // 别让凭据因为「被限流」而原文落盘；来源同样可能来自 XFF，净化后落单行。
        logger.warn(
          `请求过于频繁，已限流: ${req.method ?? ""} ${maskSensitiveUrl(url)} from ${sanitizeLogText(clientAddress(req, config.trustProxy), 100)}`,
        );
        res.writeHead(429, {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(Math.max(1, Math.ceil(denied.retryAfterMs / 1000))),
        });
        res.end(JSON.stringify({ ok: false, error: "too many requests" }));
        return;
      }
    }
    if (req.url !== undefined && isMcpPath(req.url)) {
      // MCP 按 handler Promise 追踪（工具执行真正结束才算完），不跟 SSE socket 走
      const done = hooks.inFlight?.begin();
      handleMcp(req, res, db, config)
        .catch((e) => {
          logger.error(`MCP 请求处理失败: ${errorMessage(e)}`);
          if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              error: { code: -32603, message: "Internal error" },
              id: null,
            }),
          );
        })
        .finally(() => done?.());
      return;
    }
    // 其余（状态页/quick/api/metrics/readyz）都是短响应：按响应结束/连接关闭计
    const done = hooks.inFlight?.begin();
    if (done !== undefined) res.once("close", done);
    honoListener(req, res);
  };
}

export interface DaemonHandle {
  /** 停止调度与投递、关闭 HTTP 与数据库（内嵌启动/测试用） */
  stop(): Promise<void>;
}

export async function startDaemon(env: NodeJS.ProcessEnv = process.env): Promise<DaemonHandle> {
  const config = loadConfig(env);
  setLogLevel(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true });
  // 单实例锁必须在任何写库动作之前：两个 daemon 同时跑会让 outbox 重复投递、定时任务
  // 重复触发。历史上只靠「端口被占」兜底，但占端口之前的窗口已经能写库。
  const lock = acquireDaemonLock(config.dataDir);
  // 数据目录与库文件在写之前收紧权限：默认 umask 022 会留下 0644 的库/备份，
  // 同机其它用户可读个人账目与通知正文。
  applySecureUmask();
  let db: DatabaseSync;
  try {
    hardenDataDir(config.dataDir, config.dbPath, config.backupDir);
    // 老库升级 schema 前先 VACUUM 一份 pre-v 快照；备份失败宁可不启动（见 core/database）
    db = openDatabase(config.dbPath, { backupDir: config.backupDir });
  } catch (e) {
    lock.release();
    throw e;
  }
  // 上次进程退出时仍处于 running 的记录一律标 failed，否则状态页会永远显示「运行中」
  const interruptedRuns = markInterruptedJobRuns(db);
  if (interruptedRuns > 0) logger.warn(`已把 ${interruptedRuns} 条中断的 job 运行记录标记为失败`);
  // QWeather 用量计量：先把今天的计数读回内存（重启不清零），之后每次出网自增并落库
  seedQweatherUsage(readQweatherUsage(db));
  setQweatherUsageSink((day) => bumpQweatherUsage(db, day));
  initRuntime({ db, config, services: createServices(db, config) });
  registerAllModules();

  // 在途 HTTP/MCP 请求追踪（P2-8）：停机时先拒绝新请求、再等在途收敛，最后才关库。
  // `httpServer.close()` 只停止 accept，keep-alive 上的 MCP 长连接仍能发新请求。
  const inFlightHttp = createInFlightTracker();
  const requestHandler = createHttpHandler(config, db, { inFlight: inFlightHttp });
  const httpServer = createServer((req, res) => {
    if (inFlightHttp.closed) {
      // 停机窗口内的新请求直接 503，并明确 Connection: close，让客户端重试到新实例
      res.writeHead(503, {
        "Content-Type": "application/json; charset=utf-8",
        Connection: "close",
      });
      res.end(JSON.stringify({ ok: false, error: "shutting down" }));
      return;
    }
    try {
      requestHandler(req, res);
    } catch (e) {
      logger.error(`请求处理异常: ${errorMessage(e)}`);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "internal error" }));
    }
  });

  // job 互斥执行 + 运行记录：见 core/job-runner.ts（P1-3 修 busy 泄漏）。
  // inFlightJobs 是停机时等待收敛的在途 Promise（按 name 存）。
  const jobRunner = createJobRunner(db, { timeoutMs: config.jobTimeoutMs });
  const inFlightJobs = jobRunner.inFlight;
  async function tickAll(at: DateTime): Promise<void> {
    for (const module of getModules()) {
      if (module.tick === undefined) continue;
      try {
        await module.tick(at);
      } catch (e) {
        logger.error(`模块 ${module.name} tick 失败: ${errorMessage(e)}`);
      }
    }
  }

  // 先把所有 cron 表达式校验完（纯计算，不注册定时器）：配置错误必须在监听之前暴露。
  let jobSpecs: { module: string; def: JobDef; expr: string }[];
  try {
    jobSpecs = allJobs().map(({ module, def }) => {
      const expr = typeof def.cron === "function" ? def.cron() : def.cron;
      if (!cron.validate(expr)) throw new Error(`Job ${def.name} 的 cron 不合法: ${expr}`);
      return { module, def, expr };
    });
  } catch (e) {
    // 配置错误不该留下孤儿锁：调用方会 exit，但锁文件里的 pid 仍指向本进程
    db.close();
    lock.release();
    throw e;
  }

  // 监听成功之前不得装配任何定时器（信号处理同理）：端口被占 —— systemd Restart=always
  // 重启时的常见情形 —— 会让旧实现留下一个「启动失败但不退出」的僵尸实例，它的 20s drain
  // 会把在跑实例正处于 sending 的投递复位重投（recoverStaleSending），同一条通知推两次。
  // listen 用主机必须剥掉 IPv6 方括号（`[::1]` → `::1`），否则 Node 解析失败拒绝启动
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, bindHost(config.host), () => resolve());
  }).catch((e: unknown) => {
    db.close();
    lock.release();
    throw e;
  });

  /**
   * node-cron 会把回调里抛出的同步异常吞掉（emit('task-failed')，没人监听就彻底静默，
   * 见 node_modules/node-cron/src/task.js）。jobRunner.run 已经不会向调用方抛出，
   * 这里再挂一个监听作为最后一道兜底：任何漏网异常至少进日志，而不是零痕迹。
   */
  const watchCronTask = (task: cron.ScheduledTask, label: string): cron.ScheduledTask => {
    task.on("task-failed", (e: unknown) => {
      logger.error(`定时任务 ${label} 触发异常: ${errorMessage(e)}`);
    });
    return task;
  };

  const tasks: cron.ScheduledTask[] = [];
  for (const { module, def, expr } of jobSpecs) {
    const task = cron.schedule(
      expr,
      () => {
        const at = now();
        void jobRunner.run(`job:${def.name}`, () => def.handler(at), {
          module,
          jobName: def.name,
          trigger: "cron",
          // job_runs 的时间口径是 UTC ISO（字符串比较即时间比较）：本地 +08:00 偏移串
          // 与 Z 串做字典序会得出错误结论，必须显式转 UTC。
          scheduledFor: at.toUTC().toISO() ?? "",
        });
      },
      { timezone: TZ },
    );
    tasks.push(watchCronTask(task, `${module}.${def.name}`));
    logger.info(`注册定时任务 ${module}.${def.name}: "${expr}" (${TZ})`);
  }
  tasks.push(
    watchCronTask(
      cron.schedule("* * * * *", () => void jobRunner.run("tick", () => tickAll(now())), {
        timezone: TZ,
      }),
      "tick",
    ),
  );
  const drainTimer = setInterval(() => {
    void drainDue(db, config).catch((e) => logger.error(`outbox drain 失败: ${errorMessage(e)}`));
    try {
      const pruned = pruneCache(db);
      if (pruned > 0) logger.debug(`清理过期缓存 ${pruned} 条`);
    } catch (e) {
      logger.warn(`清理缓存失败: ${errorMessage(e)}`);
    }
    sweepSessions();
  }, 20_000);

  logger.info(
    `life-assistant daemon v${VERSION} 就绪: http://${urlHost(config.host)}:${config.port}`,
  );
  logger.info(
    `MCP 端点: http://${urlHost(config.host)}:${config.port}/mcp  数据目录: ${config.dataDir}`,
  );
  logger.info(
    `已注册 ${allTools().length} 个工具、${allJobs().length} 个定时任务、${getModules().length} 个模块` +
      (config.webApiToken === undefined ? "（未启用鉴权，仅回环地址）" : "（已启用 token 鉴权）"),
  );

  // onStart 是非阻塞引导（不挡启动），但必须在关库前收敛：否则 stop() 关掉数据库后
  // 它仍在写，日志会出现 "database is not open"，也可能留下半途而废的写入。
  const onStartTasks: Promise<void>[] = [];
  // 启动补发：停机期间错过的「每天必须发生一次」的 job（早报/晚报/补班/备份…）在这里
  // 补跑一次。是否该补由 core/jobs 的策略表 + 上一次成功运行记录决定；job 自身的
  // dedupeKey 保证同一天不会推两遍。非阻塞，与 onStart 一起在停机时收敛。
  onStartTasks.push(
    runStartupCatchups({
      db,
      jobs: allJobs(),
      runJob: (module, def, trigger, scheduledFor) =>
        // 补发时把该次「原本应触发」的时刻传给 handler（而不是 now()）：
        // 晚报/摘要/周报等按时刻取业务日期的 job 才能补对那一天的班。
        jobRunner.run(
          `job:${def.name}`,
          () => {
            const at = DateTime.fromISO(scheduledFor, { zone: "utc" }).setZone(TZ);
            return def.handler(at.isValid ? at : now());
          },
          {
            module,
            jobName: def.name,
            trigger,
            scheduledFor,
          },
        ),
    }).then(
      // 汇总日志由 core/jobs 的 runStartupCatchups 统一输出（区分尝试/成功/跳过/失败）
      () => undefined,
      (e: unknown) => logger.error(`启动补发失败: ${errorMessage(e)}`),
    ),
  );
  for (const module of getModules()) {
    if (module.onStart === undefined) continue;
    onStartTasks.push(
      Promise.resolve()
        .then(() => module.onStart?.())
        .then(() => logger.debug(`模块 ${module.name} onStart 完成`))
        .catch((e) => logger.error(`模块 ${module.name} onStart 失败: ${errorMessage(e)}`)),
    );
  }

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      // 先拒绝新请求（含 keep-alive 连接上的新请求），再停定时器
      inFlightHttp.close();
      for (const task of tasks) task.stop();
      clearInterval(drainTimer);
      // 先停止接受新连接（已建立的在途请求继续处理），避免更长的 job/drain 等待期间
      // 又冒出新请求写库。最后用 closeAllConnections 强制收敛。
      const serverClosed = new Promise<void>((resolve) => httpServer.close(() => resolve()));
      // 先等 onStart / 启动补发收敛：它们可能在等待期间才把 job 放进 inFlightJobs。
      // 若先等 inFlightJobs 再等 onStart，补发刚启动的 job（如 daily_backup 的 VACUUM）
      // 会落在两次等待之间的缝隙里，db.close() 之后仍在写库。
      if (onStartTasks.length > 0) {
        await Promise.race([
          Promise.allSettled(onStartTasks),
          new Promise<void>((resolve) => setTimeout(resolve, 3000).unref()),
        ]);
      }
      // 再等 cron job / tick 收敛：它们可能在 await 网络后发布通知并触发新一轮 drain。
      // 停止定时器后不会再有新 job 启动；循环是为了兜住「等待期间刚好进入 finally」的窗口。
      const jobDeadline = Date.now() + JOB_SHUTDOWN_WAIT_MS;
      while (inFlightJobs.size > 0 && Date.now() < jobDeadline) {
        await Promise.race([
          Promise.allSettled([...inFlightJobs.values()]),
          new Promise<void>((resolve) =>
            setTimeout(resolve, Math.min(250, Math.max(0, jobDeadline - Date.now()))).unref(),
          ),
        ]);
      }
      // 超时僵尸：已从 inFlight 摘掉、但 handler 仍在后台跑。给 2s grace 让它们收敛，
      // 收不回就 warn 后继续关库 —— 迟到写入会撞 "database is not open"（job-runner 里
      // 已被 catch 成 warn），但不能让停机无限等一个挂死 handler。
      if (jobRunner.zombies.size > 0) {
        const names = [...jobRunner.zombies.keys()].join(", ");
        logger.warn(
          `停机时仍有 ${jobRunner.zombies.size} 个超时任务在后台运行（${names}），最多再等 2s`,
        );
        await Promise.race([
          Promise.allSettled([...jobRunner.zombies.values()]),
          // 这里**不能** unref：停机时事件循环很可能只剩这一个 handle，unref 后这个
          // race 可能永远不 resolve，后面的 cancelPendingDrain/db.close() 就都被跳过
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
        if (jobRunner.zombies.size > 0) {
          logger.warn(
            `仍有 ${jobRunner.zombies.size} 个超时任务未收敛（${[...jobRunner.zombies.keys()].join(", ")}），继续关库`,
          );
        }
      }
      // 在途 HTTP/MCP 请求：写工具可能正在处理（甚至正在 await 外部服务），直接
      // db.close() 会让客户端 500、重试还可能重复写。给一个有界等待（3s），收不回的
      // 长连接由后面的 closeAllConnections 强制收敛，只 warn 不阻塞停机。
      const leftHttp = await inFlightHttp.waitForIdle(HTTP_SHUTDOWN_WAIT_MS);
      if (leftHttp > 0) {
        logger.warn(
          `停机时仍有 ${leftHttp} 个在途 HTTP/MCP 请求未收敛（最多等 ${HTTP_SHUTDOWN_WAIT_MS}ms），继续关库`,
        );
      }
      // job 可能刚刚通过 publish 排了一个 100ms drain；在关库前把它取消掉。
      // 已落库但未投出的行留着，下次启动会由 outbox 继续投递（不丢）。
      cancelPendingDrain();
      // 在途的 outbox 投递也有 10s 级网络超时：不等它收敛就会在关库后继续写。
      // 与 onStart 一样给个上界（这里 10s），避免停机被长时间拖住。
      await Promise.race([
        waitForDrain(),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref()),
      ]);
      // onStart 理论上也可能发布；关库前再清一次可能新排的 drain（未投出的行留待下次启动）。
      cancelPendingDrain();
      for (const [id, session] of [...sessions]) dropSession(id, session);
      httpServer.closeAllConnections();
      await serverClosed;
      db.close();
    } finally {
      // 无论收尾是否失败都要摘掉信号监听：否则同进程内多次 startDaemon/stop
      // 会不断累积监听器（测试里尤其明显）。
      lock.release();
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    }
  };

  const shutdown = (signal: string): void => {
    logger.info(`收到 ${signal}，正在关闭…`);
    // stop() 里 db.close() 等步骤失败会 reject：必须接住，否则变成 unhandled rejection
    // 且进程按退出码 0 结束（丢掉了"关库失败"这个信号）。
    void stop()
      .then(() => {
        logger.info("已退出");
        process.exit(0);
      })
      .catch((e: unknown) => {
        logger.error(`关闭失败: ${errorMessage(e)}`);
        process.exit(1);
      });
    // 兜底硬退：必须大于 stop() 内部的等待上界（job ≤10s + drain ≤10s + onStart ≤3s + 其余收尾），
    // 否则在途投递/job 的收敛等待会被这里提前打断，db.close() 也不会执行。
    setTimeout(() => process.exit(0), 30_000).unref();
  };
  const onSigint = (): void => shutdown("SIGINT");
  const onSigterm = (): void => shutdown("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);

  return { stop };
}

const isDirectRun = /daemon\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) {
  startDaemon().catch((e) => {
    logger.error(`启动失败: ${errorMessage(e)}`);
    process.exitCode = 1;
  });
}
