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

async function send(raw: string): Promise<void> {
  let message: IncomingMessage = {};
  try {
    message = JSON.parse(raw) as IncomingMessage;
  } catch {
    logger.warn(`忽略非 JSON 行: ${raw.slice(0, 80)}`);
    return;
  }
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "X-Hermes-Profile": profile,
    };
    if (sessionId !== null) headers["mcp-session-id"] = sessionId;
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: raw,
      signal: AbortSignal.timeout(120_000),
    });
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
  process.exit(0);
});

logger.info(`life-assistant stdio 壳就绪 → ${endpoint} (profile=${profile})`);
