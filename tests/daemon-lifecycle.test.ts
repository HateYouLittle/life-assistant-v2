import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { startDaemon } from "../src/daemon.js";
import { resetRuntimeForTests } from "../src/core/registry.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

/**
 * 守护进程生命周期回归。
 *
 * 起因：旧实现先注册 cron 与 20s drain 定时器、再 listen()，而启动失败的兜底只设
 * process.exitCode。端口被占（systemd Restart=always 重启的常见情形）时进程不会退出，
 * 残留实例继续 drain 同一个 outbox —— recoverStaleSending 会把在跑实例在途的 sending
 * 复位重投，同一条通知被推送两次。
 *
 * 这里断言「启动失败即拒绝、且不留下信号监听」；定时器顺序由 daemon.ts 的监听前置保证。
 */

describe("daemon 生命周期", () => {
  it("端口被占用：startDaemon 直接拒绝，且不注册信号监听", async () => {
    const env = makeTestEnv();
    const blocker = createServer(() => {});
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const port = (blocker.address() as AddressInfo).port;
    const sigintBefore = process.listenerCount("SIGINT");
    const sigtermBefore = process.listenerCount("SIGTERM");
    try {
      // startDaemon 会自己 initRuntime；本进程里 makeTestEnv 已经初始化过，先重置
      resetRuntimeForTests();
      await assert.rejects(
        startDaemon({
          DATA_DIR: env.dir,
          PORT: String(port),
          HOST: "127.0.0.1",
          LOG_LEVEL: "error",
        }),
        /EADDRINUSE|address already in use|listen/i,
      );
      assert.equal(
        process.listenerCount("SIGINT"),
        sigintBefore,
        "启动失败不该留下 SIGINT 监听（它会让进程挂着不退）",
      );
      assert.equal(process.listenerCount("SIGTERM"), sigtermBefore, "同上");
    } finally {
      blocker.close();
      resetRuntimeForTests();
      cleanupTestEnv(env);
    }
  });
});
