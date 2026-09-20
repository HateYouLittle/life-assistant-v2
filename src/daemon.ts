import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { getRequestListener } from "@hono/node-server";
import cron from "node-cron";
import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { loadConfig, parseProfileId, type ResolvedConfig } from "./config.js";
import { isRequestAuthorized } from "./core/auth.js";
import { openDatabase } from "./core/database.js";
import {
  allJobs,
  allTools,
  errorMessage,
  fail,
  getModules,
  initRuntime,
  type ToolContext,
} from "./core/registry.js";
import { cancelPendingDrain, createServices, drainDue, waitForDrain } from "./core/notify.js";
import { pruneCache } from "./core/settings.js";
import { logger, setLogLevel } from "./core/logger.js";
import { TZ, now } from "./time.js";
import { registerAllModules } from "./modules/index.js";
import { createStatusApp } from "./server/status.js";

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

async function buildMcpServer(
  profileId: string,
  db: DatabaseSync,
  config: ResolvedConfig,
): Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> {
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
  if (!isRequestAuthorized(config.webApiToken, req.headers.authorization)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32001,
          message: "unauthorized：/mcp 需要 Authorization: Bearer <WEB_API_TOKEN>",
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
    session.lastSeen = Date.now();
    await session.transport.handleRequest(req, res);
    return;
  }

  const rawProfile = req.headers["x-hermes-profile"];
  let profileId = "default";
  if (typeof rawProfile === "string" && rawProfile !== "") {
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

/** HTTP 入口（/mcp 走 MCP，其余走状态页）；导出以便不启动调度器即可测试 */
export function createHttpHandler(
  config: ResolvedConfig,
  db: DatabaseSync,
): (req: IncomingMessage, res: ServerResponse) => void {
  const honoListener = getRequestListener(createStatusApp(config, db).fetch);
  return (req, res) => {
    if (req.url !== undefined && isMcpPath(req.url)) {
      handleMcp(req, res, db, config).catch((e) => {
        logger.error(`MCP 请求处理失败: ${errorMessage(e)}`);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: "Internal error" },
            id: null,
          }),
        );
      });
      return;
    }
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
  const db = openDatabase(config.dbPath);
  initRuntime({ db, config, services: createServices(db, config) });
  registerAllModules();

  const httpServer = createServer(createHttpHandler(config, db));

  const busy = new Set<string>();
  async function runExclusive(name: string, fn: () => Promise<void> | void): Promise<void> {
    if (busy.has(name)) {
      logger.debug(`跳过重叠触发: ${name}`);
      return;
    }
    busy.add(name);
    try {
      await fn();
    } catch (e) {
      logger.error(`${name} 执行失败: ${errorMessage(e)}`);
    } finally {
      busy.delete(name);
    }
  }

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

  const tasks: cron.ScheduledTask[] = [];
  for (const { module, def } of allJobs()) {
    const expr = typeof def.cron === "function" ? def.cron() : def.cron;
    if (!cron.validate(expr)) throw new Error(`Job ${def.name} 的 cron 不合法: ${expr}`);
    tasks.push(
      cron.schedule(expr, () => void runExclusive(`job:${def.name}`, () => def.handler(now())), {
        timezone: TZ,
      }),
    );
    logger.info(`注册定时任务 ${module}.${def.name}: "${expr}" (${TZ})`);
  }
  tasks.push(
    cron.schedule("* * * * *", () => void runExclusive("tick", () => tickAll(now())), {
      timezone: TZ,
    }),
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

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  logger.info(`life-assistant daemon v${VERSION} 就绪: http://${config.host}:${config.port}`);
  logger.info(`MCP 端点: http://${config.host}:${config.port}/mcp  数据目录: ${config.dataDir}`);
  logger.info(
    `已注册 ${allTools().length} 个工具、${allJobs().length} 个定时任务、${getModules().length} 个模块` +
      (config.webApiToken === undefined ? "（未启用鉴权，仅回环地址）" : "（已启用 token 鉴权）"),
  );

  // onStart 是非阻塞引导（不挡启动），但必须在关库前收敛：否则 stop() 关掉数据库后
  // 它仍在写，日志会出现 "database is not open"，也可能留下半途而废的写入。
  const onStartTasks: Promise<void>[] = [];
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
    for (const task of tasks) task.stop();
    clearInterval(drainTimer);
    cancelPendingDrain();
    // 在途的 outbox 投递也有 10s 级网络超时：不等它收敛就会在关库后继续写。
    // 与 onStart 一样给个上界（这里 10s），避免停机被长时间拖住。
    await Promise.race([
      waitForDrain(),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000).unref()),
    ]);
    // 给 onStart 一点时间收尾（多为网络抓取），避免关库后仍在写
    if (onStartTasks.length > 0) {
      await Promise.race([
        Promise.allSettled(onStartTasks),
        new Promise<void>((resolve) => setTimeout(resolve, 3000).unref()),
      ]);
    }
    for (const [id, session] of [...sessions]) dropSession(id, session);
    httpServer.closeAllConnections();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    db.close();
  };

  const shutdown = (signal: string): void => {
    logger.info(`收到 ${signal}，正在关闭…`);
    void stop().then(() => {
      logger.info("已退出");
      process.exit(0);
    });
    // 兜底硬退：必须大于 stop() 内部的等待上界（drain ≤10s + onStart ≤3s + 其余收尾），
    // 否则在途投递的收敛等待会被这里提前打断，db.close() 也不会执行。
    setTimeout(() => process.exit(0), 15_000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  return { stop };
}

const isDirectRun = /daemon\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) {
  startDaemon().catch((e) => {
    logger.error(`启动失败: ${errorMessage(e)}`);
    process.exitCode = 1;
  });
}
