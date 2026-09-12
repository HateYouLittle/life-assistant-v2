import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

interface CapturedRequest {
  profile: string | undefined;
  body: string;
}

function spawnShim(port: number): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "src", "stdio.ts")],
    {
      env: {
        ...process.env,
        DATA_DIR: mkdtempSync(join(tmpdir(), "stdio-test-")),
        HERMES_PROFILE: "default",
        MCP_DAEMON_URL: `http://127.0.0.1:${port}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
}

function waitForLine(child: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("等待 stdio 响应超时")), timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      const lines = chunk.toString().split("\n").filter((l) => l.trim() !== "");
      if (lines.length > 0) {
        clearTimeout(timer);
        resolve(lines[0] as string);
      }
    });
  });
}

function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const captured: CapturedRequest[] = [];
    const server: Server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString();
        captured.push({ profile: req.headers["x-hermes-profile"] as string | undefined, body });
        handler(req, res, body);
      });
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", async () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      try {
        await fn(port);
        server.close(() => resolve());
      } catch (e) {
        server.close(() => reject(e));
      }
    });
  });
}

describe("stdio 兼容壳", () => {
  it("JSON-RPC 转发到 daemon 并回传响应，携带 profile 头与会话头", async () => {
    await withServer(
      (_req, res, body) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("mcp-session-id", "sess-42");
        const parsed = JSON.parse(body) as { id: number };
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { ok: true } }));
      },
      async (port) => {
        const child = spawnShim(port);
        try {
          const request = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
          const promise = waitForLine(child);
          child.stdin?.write(`${request}\n`);
          const line = await promise;
          const response = JSON.parse(line) as { id: number; result: { ok: boolean } };
          assert.equal(response.id, 1);
          assert.equal(response.result.ok, true);
        } finally {
          child.kill();
        }
      },
    );
  });

  it("daemon 不可达时返回结构化错误（进程不崩溃）", async () => {
    // 端口 9（discard）通常无监听，连接被拒绝
    const child = spawnShim(9);
    try {
      const request = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" });
      const promise = waitForLine(child);
      child.stdin?.write(`${request}\n`);
      const line = await promise;
      const response = JSON.parse(line) as { id: number; error: { code: number; message: string } };
      assert.equal(response.id, 7);
      assert.equal(response.error.code, -32000);
      assert.match(response.error.message, /不可达/);
    } finally {
      child.kill();
    }
  });
});
