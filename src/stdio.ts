import { createInterface } from "node:readline";
import { loadConfig, parseProfileId } from "./config.js";
import { logger } from "./core/logger.js";

/**
 * stdio 兼容壳：把 MCP stdio JSON-RPC 转发到常驻 daemon 的 /mcp 端点。
 * daemon 未启动时，对每个请求返回结构化错误（不会崩溃退出）。
 */

const config = loadConfig(process.env);
const profile = parseProfileId(process.env.HERMES_PROFILE);
const daemonUrl = process.env.MCP_DAEMON_URL ?? `http://127.0.0.1:${config.port}`;
const endpoint = `${daemonUrl}/mcp`;

let sessionId: string | null = null;
const queue: string[] = [];
let sending = false;

interface IncomingMessage {
  id?: unknown;
  method?: string;
}

function requestHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "X-Hermes-Profile": profile,
  };
  if (sessionId !== null) headers["mcp-session-id"] = sessionId;
  return headers;
}

/**
 * daemon 重启后旧会话即作废（404 Session not found）；而壳只在响应头带 mcp-session-id
 * 时才会更新缓存，因此会永久卡在失效会话上（症状：工具全部报 daemon 返回 HTTP 404，
 * 必须重启网关才恢复）。这里重新 initialize 拿新会话并补发 initialized 通知。
 * 内部请求的响应一律不转发到 stdout，避免污染 MCP 流。
 */
async function reinitSession(): Promise<boolean> {
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "X-Hermes-Profile": profile,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "shim-initialize",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "life-assistant-stdio-shim", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const sid = res.headers.get("mcp-session-id");
    if (res.body !== null) res.body.cancel().catch(() => {});
    if (!res.ok || sid === null || sid === "") return false;
    sessionId = sid;
    await fetch(endpoint, {
      method: "POST",
      headers: { ...requestHeaders(), "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    logger.warn(`daemon 会话失效，已重新初始化: ${sid}`);
    return true;
  } catch (e) {
    logger.error(`重新初始化会话失败: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function send(raw: string): Promise<void> {
  let message: IncomingMessage = {};
  try {
    message = JSON.parse(raw) as IncomingMessage;
  } catch {
    logger.warn(`忽略非 JSON 行: ${raw.slice(0, 80)}`);
    return;
  }
  try {
    let response = await fetch(endpoint, {
      method: "POST",
      headers: requestHeaders(),
      body: raw,
      signal: AbortSignal.timeout(120_000),
    });
    // 404 = 会话不存在，该请求并未被 daemon 执行，因此重试是安全的
    if (response.status === 404) {
      if (response.body !== null) response.body.cancel().catch(() => undefined);
      sessionId = null;
      if (await reinitSession()) {
        response = await fetch(endpoint, {
          method: "POST",
          headers: requestHeaders(),
          body: raw,
          signal: AbortSignal.timeout(120_000),
        });
      }
    }
    const headerSession = response.headers.get("mcp-session-id");
    if (headerSession !== null) sessionId = headerSession;
    if (response.status === 202) return;
    if (!response.ok) {
      throw new Error(`daemon 返回 HTTP ${response.status}`);
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream")) {
      const text = await response.text();
      for (const event of text.split("\n\n")) {
        for (const line of event.split("\n")) {
          if (line.startsWith("data:")) {
            const data = line.slice(5).trim();
            if (data !== "") process.stdout.write(`${data}\n`);
          }
        }
      }
      return;
    }
    const body = await response.text();
    if (body !== "") process.stdout.write(`${body}\n`);
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    logger.error(`daemon 请求失败（请确认 daemon 已启动: ${endpoint}）: ${detail}`);
    if (message.id !== undefined && message.id !== null) {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: `life-assistant daemon 不可达（${endpoint}）：${detail}` },
        })}\n`,
      );
    }
  }
}

async function drain(): Promise<void> {
  if (sending) return;
  sending = true;
  try {
    while (queue.length > 0) {
      const line = queue.shift() as string;
      await send(line);
    }
  } finally {
    sending = false;
  }
}

const readline = createInterface({ input: process.stdin });
readline.on("line", (line: string) => {
  const trimmed = line.trim();
  if (trimmed === "") return;
  queue.push(trimmed);
  void drain();
});
readline.on("close", () => {
  // 等 in-flight 请求排空再退出，避免丢响应；5s 兜底
  const exit = (): void => process.exit(0);
  const timer = setInterval(() => {
    if (queue.length === 0 && !sending) {
      clearInterval(timer);
      exit();
    }
  }, 50);
  setTimeout(exit, 5000).unref();
});

logger.info(`life-assistant stdio 壳就绪 → ${endpoint} (profile=${profile})`);
