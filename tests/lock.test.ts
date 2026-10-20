import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { acquireDaemonLock, daemonLockPath, isDaemonLocked } from "../src/core/lock.js";

/**
 * 单实例锁：正常获取、重复获取拒绝、stale（死 pid / 损坏文件）接管、
 * release 不误删别人刚接管的锁。全部在临时目录，绝不碰真实 DATA_DIR。
 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "la-lock-"));
}

/** 取一个「确实已退出」的 pid：起一个立刻退出的子进程，用它报告出来的 pid */
function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.pid > 0, "spawnSync 应返回子进程 pid");
  return result.pid;
}

function readLock(path: string): { pid: number; startedAt: string; hostname: string } {
  return JSON.parse(readFileSync(path, "utf8")) as {
    pid: number;
    startedAt: string;
    hostname: string;
  };
}

describe("daemon 单实例锁", () => {
  it("正常获取：写入 pid/startedAt/hostname，release 后文件消失", () => {
    const dir = tempDir();
    try {
      const lock = acquireDaemonLock(dir);
      assert.equal(lock.path, daemonLockPath(dir));
      const content = readLock(lock.path);
      assert.equal(content.pid, process.pid);
      assert.match(content.startedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      assert.equal(typeof content.hostname, "string");
      assert.notEqual(content.hostname, "");
      assert.deepEqual(isDaemonLocked(dir), { locked: true, pid: process.pid });

      lock.release();
      assert.equal(existsSync(lock.path), false);
      assert.deepEqual(isDaemonLocked(dir), { locked: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("重复获取：第二只 daemon 抛中文错误并带上活着进程的 pid/启动时间/锁路径", () => {
    const dir = tempDir();
    try {
      const lock = acquireDaemonLock(dir);
      const startedAt = readLock(lock.path).startedAt;
      assert.throws(
        () => acquireDaemonLock(dir),
        (e: unknown) =>
          e instanceof Error &&
          /另一个 daemon 已在运行/.test(e.message) &&
          e.message.includes(`pid=${process.pid}`) &&
          e.message.includes(startedAt) &&
          e.message.includes(lock.path),
        "错误必须指向正在运行的那只 daemon，用户才能据此停掉它",
      );
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stale 接管：锁里的 pid 已不存在时接管并重写为当前进程", () => {
    const dir = tempDir();
    try {
      const stalePid = deadPid();
      writeFileSync(
        daemonLockPath(dir),
        JSON.stringify({
          pid: stalePid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "old-host",
        }),
      );
      const before = isDaemonLocked(dir);
      assert.equal(before.locked, false, "死 pid 的锁不算被占用");
      assert.equal(before.pid, stalePid, "仍回报 stale pid 供排障");

      const lock = acquireDaemonLock(dir);
      const content = readLock(lock.path);
      assert.equal(content.pid, process.pid, "接管后锁必须属于当前进程");
      lock.release();
      assert.equal(existsSync(lock.path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stale 接管：锁文件内容损坏时接管而不是永久拒绝启动", () => {
    const dir = tempDir();
    try {
      writeFileSync(daemonLockPath(dir), "{not-json");
      const lock = acquireDaemonLock(dir);
      assert.equal(readLock(lock.path).pid, process.pid);
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release 不误删别人的锁：锁文件 pid 不是自己时保留", () => {
    const dir = tempDir();
    try {
      const lock = acquireDaemonLock(dir);
      // 模拟「本进程的锁已被新 daemon 接管」：内容换成别的 pid
      writeFileSync(
        lock.path,
        JSON.stringify({
          pid: process.pid + 1,
          startedAt: "2026-01-02T00:00:00.000Z",
          hostname: "other-host",
        }),
      );
      lock.release();
      assert.equal(existsSync(lock.path), true, "pid 不匹配时绝不能删除锁文件");
      assert.equal(readLock(lock.path).pid, process.pid + 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("isDaemonLocked：无锁/死 pid/损坏文件都返回 false（不阻塞恢复）", () => {
    const dir = tempDir();
    try {
      assert.deepEqual(isDaemonLocked(dir), { locked: false });
      writeFileSync(
        daemonLockPath(dir),
        JSON.stringify({ pid: deadPid(), startedAt: "2026-01-01T00:00:00.000Z", hostname: "h" }),
      );
      const dead = isDaemonLocked(dir);
      assert.equal(dead.locked, false);
      assert.equal(typeof dead.pid, "number", "仍应回报 stale pid 供排障");
      writeFileSync(daemonLockPath(dir), "garbage");
      assert.equal(isDaemonLocked(dir).locked, false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("dataDir 不存在时自动创建后再落锁", () => {
    const root = tempDir();
    const dir = join(root, "nested", "data");
    try {
      const lock = acquireDaemonLock(dir);
      assert.equal(existsSync(lock.path), true);
      lock.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
