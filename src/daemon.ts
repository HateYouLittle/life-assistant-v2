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
import { createServices, drainDue } from "./core/notify.js";
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
}

async function buildMcpServer(profileId: string, db: DatabaseSync, config: ResolvedConfig): Promise<{ server: McpServer; transport: StreamableHTTPServerTransport }> {
  const server = new McpServer({ name: "life-assistant", version: VERSION });
  const services = createServices(db, config);
  for (const { def } of allTools()) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.inputSchema }, async (args, extra) => {
      const ctx: ToolContext = {
        profileId: extra.sessionId !== undefined ? profileIdForSession(extra.sessionId, profileId) : profileId,
        db,
        config,
        services,
      };
      try {
        return await def.handler(args as Record<string, unknown>, ctx);
      } catch (e) {
        return fail(errorMessage(e));
      }
    });
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

async function handleMcp(req: IncomingMessage, res: ServerResponse, db: DatabaseSync, config: ResolvedConfig): Promise<void> {
  const headerSession = req.headers["mcp-session-id"];
  if (typeof headerSession === "string" && headerSession !== "") {
    const session = sessions.get(headerSession);
    if (session === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Session not found（daemon 可能已重启，请重新 initialize）" },
          id: null,
        }),
      );
      return;
    }
    await session.transport.handleRequest(req, res);
    return;
  }

  const rawProfile = req.headers["x-hermes-profile"];
  const profileId = typeof rawProfile === "string" && rawProfile !== "" ? parseProfileId(rawProfile, "X-Hermes-Profile") : "default";
  const { server, transport } = await buildMcpServer(profileId, db, config);
  await transport.handleRequest(req, res);
  const sessionId = transport.sessionId;
  if (typeof sessionId === "string" && sessionId !== "") {
    sessions.set(sessionId, { profileId, server, transport });
    logger.info(`MCP 会话建立: ${sessionId} (profile=${profileId})`);
  }
}

function isMcpPath(url: string): boolean {
  return url === "/mcp" || url.startsWith("/mcp?") || url.startsWith("/mcp/");
}

export async function startDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadConfig(env);
  setLogLevel(config.logLevel);
  mkdirSync(config.dataDir, { recursive: true });
  const db = openDatabase(config.dbPath);
  registerAllModules();
  initRuntime({ db, config, services: createServices(db, config) });

  const honoListener = getRequestListener(createStatusApp(config, db).fetch);
  const httpServer = createServer((req, res) => {
    if (req.url !== undefined && isMcpPath(req.url)) {
      handleMcp(req, res, db, config).catch((e) => {
        logger.error(`MCP 请求处理失败: ${errorMessage(e)}`);
        if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }));
      });
      return;
    }
    honoListener(req, res);
  });

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
    tasks.push(
      cron.schedule(def.cron, () => void runExclusive(`job:${def.name}`, () => def.handler(now())), { timezone: TZ }),
    );
    logger.info(`注册定时任务 ${module}.${def.name}: "${def.cron}" (${TZ})`);
  }
  tasks.push(cron.schedule("* * * * *", () => void runExclusive("tick", () => tickAll(now())), { timezone: TZ }));
  const drainTimer = setInterval(() => {
    void drainDue(db, config).catch((e) => logger.error(`outbox drain 失败: ${errorMessage(e)}`));
  }, 20_000);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, () => resolve());
  });

  logger.info(`life-assistant daemon v${VERSION} 就绪: http://${config.host}:${config.port}`);
  logger.info(`MCP 端点: http://${config.host}:${config.port}/mcp  数据目录: ${config.dataDir}`);
  logger.info(`已注册 ${allTools().length} 个工具、${allJobs().length} 个定时任务、${getModules().length} 个模块`);

  for (const module of getModules()) {
    if (module.onStart === undefined) continue;
    module
      .onStart()
      .then(() => logger.debug(`模块 ${module.name} onStart 完成`))
      .catch((e) => logger.error(`模块 ${module.name} onStart 失败: ${errorMessage(e)}`));
  }

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭…`);
    for (const task of tasks) task.stop();
    clearInterval(drainTimer);
    httpServer.close(() => {
      db.close();
      logger.info("已退出");
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const isDirectRun = /daemon\.(?:ts|js)$/.test(process.argv[1]?.replace(/\\/g, "/") ?? "");
if (isDirectRun) {
  startDaemon().catch((e) => {
    logger.error(`启动失败: ${errorMessage(e)}`);
    process.exitCode = 1;
  });
}
