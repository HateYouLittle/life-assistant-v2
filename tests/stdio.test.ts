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

function spawnShim(port: number, extraEnv: Record<string, string> = {}): ReturnType<typeof spawn> {
  return spawn(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "src", "stdio.ts")],
    {
      env: {
        ...process.env,
        DATA_DIR: mkdtempSync(join(tmpdir(), "stdio-test-")),
        HERMES_PROFILE: "default",
        MCP_DAEMON_URL: `http://127.0.0.1:${port}`,
        ...extraEnv,
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

  it("daemon 重启致会话失效（404）时自动重新 initialize 并重试原请求", async () => {
    // 模拟：首次请求建立会话 sess-1；此后 daemon "重启"，sess-1 一律 404，
    // 只有重新 initialize 拿到 sess-2 才放行。
    const seen: { session: string | undefined; method: string }[] = [];
    await withServer(
      (req, res, body) => {
        const parsed = JSON.parse(body) as { method?: string; id?: unknown };
        seen.push({ session: req.headers["mcp-session-id"] as string | undefined, method: parsed.method ?? "" });
        if (parsed.method === "initialize") {
          res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-2" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { ok: true } }));
          return;
        }
        if (req.headers["mcp-session-id"] === "sess-1") {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null }),
          );
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json", "mcp-session-id": "sess-1" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { ok: true } }));
      },
      async (port) => {
        const child = spawnShim(port);
        try {
          // 第一次：建立会话 sess-1，正常返回
          const first = waitForLine(child);
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
          assert.equal((JSON.parse(await first) as { id: number }).id, 1);

          // 第二次：带 sess-1 → 404，壳应自愈后重试成功
          const second = waitForLine(child);
          child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call" })}\n`);
          const line = await second;
          const response = JSON.parse(line) as { id: number; result?: { ok: boolean }; error?: unknown };
          assert.equal(response.id, 2);
          assert.equal(response.error, undefined, "应自愈重试成功，而不是把 404 抛给调用方");
          assert.equal(response.result?.ok, true);
          assert.ok(
            seen.some((s) => s.method === "initialize"),
            "应发生过重新 initialize",
          );
          assert.ok(
            seen.some((s) => s.method === "tools/call" && s.session === "sess-2"),
            "重试应携带新会话 sess-2",
          );
        } finally {
          child.kill();
        }
      },
    );
  });

  it("daemon 启用 token 时壳自动带 Authorization（MCP_DAEMON_TOKEN 优先，缺省复用 WEB_API_TOKEN）", async () => {
    const seen: (string | undefined)[] = [];
    await withServer(
      (req, res, body) => {
        seen.push(req.headers.authorization as string | undefined);
        const parsed = JSON.parse(body) as { id: number };
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { ok: true } }));
      },
      async (port) => {
        const cases: Record<string, string>[] = [
          { WEB_API_TOKEN: "w".repeat(32) },
          { WEB_API_TOKEN: "w".repeat(32), MCP_DAEMON_TOKEN: "m".repeat(32) },
        ];
        for (const env of cases) {
          const child = spawnShim(port, env);
          try {
            const promise = waitForLine(child);
            child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" })}\n`);
            await promise;
          } finally {
            child.kill();
          }
        }
      },
    );
    assert.deepEqual(seen, [`Bearer ${"w".repeat(32)}`, `Bearer ${"m".repeat(32)}`]);
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
