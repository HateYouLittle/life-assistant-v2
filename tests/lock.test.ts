import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  acquireDaemonLock,
  daemonLockPath,
  inspectDaemonLock,
  type ProcessStartTimeReader,
  readProcessStartTime,
} from "../src/core/lock.js";

/**
 * 单实例锁：正常获取、重复获取拒绝、stale（死 pid / 损坏文件）接管、
 * release 不误删别人刚接管的锁，以及并发启动时「接管只能有一个赢家」。
 * 全部在临时目录，绝不碰真实 DATA_DIR。
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

function readLock(path: string): {
  pid: number;
  startedAt: string;
  processStart?: string | null;
  processStartSource?: string;
  token?: string;
  hostname: string;
} {
  return JSON.parse(readFileSync(path, "utf8")) as {
    pid: number;
    startedAt: string;
    processStart?: string | null;
    processStartSource?: string;
    token?: string;
    hostname: string;
  };
}

/** 固定的「假的」进程启动时间读取器：所有 pid 都报同一个值（模拟 ps 可用） */
function fixedStartTime(value: string): ProcessStartTimeReader {
  return () => ({ value, source: "ps" });
}

/** 模拟本机读不到任何进程启动时间（ps 被沙箱拦住 / 权限不足） */
const unavailableStartTime: ProcessStartTimeReader = () => ({ source: "unavailable" });

/** 锁模块源码的 file URL：子进程用 tsx 直接加载仓库里的 TS 源码，无需构建 */
const LOCK_SOURCE_HREF = pathToFileURL(
  fileURLToPath(new URL("../src/core/lock.ts", import.meta.url)),
).href;

interface AcquireChild {
  /** 子进程完成模块加载、进入自旋等待发令（或已退出） */
  ready: Promise<void>;
  result: Promise<{ acquired: boolean; output: string }>;
}

/**
 * 起一个子进程抢锁：等 `goFile` 出现后调用真实的 `acquireDaemonLock`。
 * 拿到锁后打印 ACQUIRED 并持有 holdMs 再 release（模拟 daemon 启动成功并短暂运行）；
 * 拿不到时打印 REFUSED + 错误信息。
 */
function spawnAcquire(dir: string, goFile: string, holdMs = 300): AcquireChild {
  const code = `
(async () => {
  const { existsSync } = await import("node:fs");
  const { acquireDaemonLock } = await import(${JSON.stringify(LOCK_SOURCE_HREF)});
  console.log("READY");
  while (!existsSync(${JSON.stringify(goFile)})) {
    // 自旋等待发令，让所有子进程尽量同时进入 acquireDaemonLock
  }
  let lock;
  try {
    lock = acquireDaemonLock(${JSON.stringify(dir)});
  } catch (e) {
    console.log("REFUSED " + (e instanceof Error ? e.message : String(e)));
    process.exit(0);
  }
  console.log("ACQUIRED");
  setTimeout(() => {
    lock.release();
    process.exit(0);
  }, ${holdMs});
})();
`;
  let signalReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    signalReady = resolve;
  });
  const result = new Promise<{ acquired: boolean; output: string }>((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", "-e", code], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("READY")) signalReady();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("exit", () => {
      signalReady();
      resolve({ acquired: output.includes("ACQUIRED"), output });
    });
  });
  return { ready, result };
}

/** 轮询锁状态，直到 pred 为真或超时；返回是否命中 */
async function waitForLockState(
  dir: string,
  pred: (state: ReturnType<typeof inspectDaemonLock>) => boolean,
  timeoutMs = 800,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred(inspectDaemonLock(dir))) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return pred(inspectDaemonLock(dir));
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
      assert.deepEqual(inspectDaemonLock(dir), { state: "locked", pid: process.pid });

      lock.release();
      assert.equal(existsSync(lock.path), false);
      assert.deepEqual(inspectDaemonLock(dir), { state: "unlocked" });
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
      assert.deepEqual(
        inspectDaemonLock(dir),
        { state: "stale", pid: stalePid },
        "死 pid 的锁属于 stale（可接管/可恢复），并回报 pid 供排障",
      );

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

  it("inspectDaemonLock 区分 unlocked / locked / stale / corrupt（restore 依赖后两者语义）", () => {
    const dir = tempDir();
    try {
      assert.deepEqual(inspectDaemonLock(dir), { state: "unlocked" });

      // 活 pid（当前进程）→ locked
      writeFileSync(
        daemonLockPath(dir),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          hostname: "h",
        }),
      );
      assert.deepEqual(inspectDaemonLock(dir), { state: "locked", pid: process.pid });

      // 死 pid → stale（崩溃残留，可安全接管/恢复）
      const stalePid = deadPid();
      writeFileSync(
        daemonLockPath(dir),
        JSON.stringify({ pid: stalePid, startedAt: "2026-01-01T00:00:00.000Z", hostname: "h" }),
      );
      assert.deepEqual(inspectDaemonLock(dir), { state: "stale", pid: stalePid });

      // 内容损坏 → corrupt（存在但读不懂，无法确认有没有实例在跑）
      writeFileSync(daemonLockPath(dir), "{not-json");
      assert.deepEqual(inspectDaemonLock(dir), { state: "corrupt" });
      writeFileSync(daemonLockPath(dir), "");
      assert.deepEqual(
        inspectDaemonLock(dir),
        { state: "corrupt" },
        "空文件（写到一半崩溃）也算损坏",
      );

      // 合法 JSON 但字段不合法 → corrupt
      writeFileSync(daemonLockPath(dir), JSON.stringify({ pid: "123" }));
      assert.deepEqual(inspectDaemonLock(dir), { state: "corrupt" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stale 接管后不残留 .stale-* 临时副本", () => {
    const dir = tempDir();
    try {
      writeFileSync(
        daemonLockPath(dir),
        JSON.stringify({ pid: deadPid(), startedAt: "2026-01-01T00:00:00.000Z", hostname: "h" }),
      );
      const lock = acquireDaemonLock(dir);
      lock.release();
      const leftovers = readdirSync(dir).filter((name) => name.includes(".stale-"));
      assert.deepEqual(leftovers, [], "接管用的临时副本必须清理干净");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("启动清理崩溃残留：只删 pid 已死的 .tmp-* 与 .stale-*，活进程的保留", () => {
    const dir = tempDir();
    try {
      const dead = deadPid();
      const leftovers = [
        `daemon.lock${".stale-"}${dead}-crashed`,
        `daemon.lock${".tmp-"}${dead}-crashed`,
        `daemon.lock${".stale-"}${process.pid}-alive`,
        `daemon.lock${".tmp-"}${process.pid}-alive`,
      ];
      for (const name of leftovers) writeFileSync(join(dir, name), "residue");
      // 非锁残留（别的文件）不该被误删
      writeFileSync(join(dir, "unrelated.txt"), "keep");

      const lock = acquireDaemonLock(dir);
      lock.release();

      const remaining = readdirSync(dir).sort();
      assert.deepEqual(
        remaining,
        [
          `daemon.lock${".stale-"}${process.pid}-alive`,
          `daemon.lock${".tmp-"}${process.pid}-alive`,
          "unrelated.txt",
        ],
        "只清理已死 pid 的锁残留（.tmp-/.stale-），活进程的临时文件与无关文件必须保留",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("并发 acquire（stale 锁）：接管只能有一个赢家，锁文件始终指向活着的持有者", async () => {
    const dir = tempDir();
    const goFile = join(dir, "go");
    try {
      // 3 轮 × 3 个进程：每轮都从「死 pid 的 stale 锁」开始，尽量让它们同时进入接管路径
      for (let trial = 0; trial < 3; trial += 1) {
        rmSync(goFile, { force: true });
        writeFileSync(
          daemonLockPath(dir),
          JSON.stringify({ pid: deadPid(), startedAt: "2026-01-01T00:00:00.000Z", hostname: "h" }),
        );
        const children = [
          spawnAcquire(dir, goFile),
          spawnAcquire(dir, goFile),
          spawnAcquire(dir, goFile),
        ];
        // 等所有子进程都加载完 tsx 并进入「等发令」自旋，再一起放行（避免把启动耗时差当成并发）
        await Promise.all(children.map((child) => child.ready));
        writeFileSync(goFile, "go");

        // 赢家持锁期间锁文件必须是「locked」而不是死 pid（双持/丢锁都会在这里暴露）
        const becameLocked = await waitForLockState(dir, (state) => state.state === "locked");
        assert.equal(becameLocked, true, `trial ${trial}: 抢锁成功后锁文件应指向存活进程`);

        const results = await Promise.all(children.map((child) => child.result));
        const winners = results.filter((result) => result.acquired);
        assert.equal(
          winners.length,
          1,
          `trial ${trial}: 并发抢锁应恰好一个成功，实际 ${winners.length}；子进程输出：${results
            .map((result) => result.output.trim().replace(/\n/g, " / "))
            .join(" | ")}`,
        );

        // 子进程都已 release：不应残留锁文件或接管副本
        assert.equal(existsSync(daemonLockPath(dir)), false, "所有持有者释放后不应残留锁文件");
        const leftovers = readdirSync(dir).filter((name) => name.includes(".stale-"));
        assert.deepEqual(leftovers, [], "并发接管也不得残留 .stale-* 临时副本");
      }
    } finally {
      rmSync(goFile, { force: true });
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

  it("pid 被复用：pid 存活但启动时间不一致 → 判定 stale 并成功接管（不要求人工删锁）", () => {
    // 场景：机器重启后残留 daemon.lock，旧 pid 被一个无关进程复用。只看 pid 存活会误判
    // 「实例在跑」并拒绝启动 —— 本用例钉的就是「启动时间不一致必须判 stale」。
    const dir = tempDir();
    const reader = fixedStartTime("2026-10-28T01:00:00.000Z");
    try {
      writeFileSync(
        daemonLockPath(dir),
        JSON.stringify({
          pid: process.pid, // 存活（就是本进程），但锁记录的是重启前那个进程的启动时间
          startedAt: "2026-01-01T00:00:00.000Z",
          processStart: "2020-01-01T00:00:00.000Z",
          processStartSource: "ps",
          token: "stale-token",
          hostname: "old-host",
        }),
      );
      assert.deepEqual(
        inspectDaemonLock(dir, { readProcessStartTime: reader }),
        { state: "stale", pid: process.pid },
        "pid 存活但启动时间不一致 = pid 复用，必须是 stale（否则 daemon 永远起不来）",
      );

      const lock = acquireDaemonLock(dir, { readProcessStartTime: reader });
      const content = readLock(lock.path);
      assert.equal(content.pid, process.pid, "接管后锁必须属于当前进程");
      assert.equal(content.processStart, "2026-10-28T01:00:00.000Z", "新锁必须记录自己的启动时间");
      assert.equal(content.processStartSource, "ps");
      assert.notEqual(content.token, "stale-token", "每次获取都要换新 token");
      lock.release();
      assert.equal(existsSync(lock.path), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("真持有者仍在：pid + 启动时间 + token 全一致 → 拒绝接管（且不是「疑似复用」措辞）", () => {
    const dir = tempDir();
    const reader = fixedStartTime("2026-10-28T01:00:00.000Z");
    try {
      const lock = acquireDaemonLock(dir, { readProcessStartTime: reader });
      const before = readFileSync(lock.path, "utf8");
      assert.deepEqual(inspectDaemonLock(dir, { readProcessStartTime: reader }), {
        state: "locked",
        pid: process.pid,
      });
      assert.throws(
        () => acquireDaemonLock(dir, { readProcessStartTime: reader }),
        (e: unknown) =>
          e instanceof Error &&
          /另一个 daemon 已在运行/.test(e.message) &&
          !/疑似 pid 复用/.test(e.message),
        "能核实是真持有者时，不该给出「疑似 pid 复用、删锁」的误导性指引",
      );
      assert.equal(readFileSync(lock.path, "utf8"), before, "拒绝接管时锁文件必须原样保留");
      const leftovers = readdirSync(dir).filter((name) => name.includes(".stale-"));
      assert.deepEqual(leftovers, [], "误拿活锁必须放回原位、不留接管副本");
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("release 用 token 兜底：pid 相同但 token 不是自己写的锁不删除", () => {
    const dir = tempDir();
    try {
      const lock = acquireDaemonLock(dir);
      const content = readLock(lock.path);
      assert.equal(typeof content.token, "string", "锁文件必须带随机 token");
      writeFileSync(lock.path, JSON.stringify({ ...content, token: "someone-else" }));
      lock.release();
      assert.equal(existsSync(lock.path), true, "token 不匹配时绝不能删除锁文件");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("取不到启动时间：保守判 locked、拒绝接管并给出「疑似 pid 复用，确认后删锁」指引", () => {
    const dir = tempDir();
    try {
      // (a) 锁里记着启动时间，但本机读不到 → 无法核实 → 保守当活
      writeFileSync(
        daemonLockPath(dir),
        JSON.stringify({
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
          processStart: "2026-10-28T01:00:00.000Z",
          processStartSource: "ps",
          token: "t1",
          hostname: "h",
        }),
      );
      assert.deepEqual(
        inspectDaemonLock(dir, { readProcessStartTime: unavailableStartTime }),
        { state: "locked", pid: process.pid },
        "无法核实启动时间时只能保守判「可能有实例在跑」",
      );
      assert.throws(
        () => acquireDaemonLock(dir, { readProcessStartTime: unavailableStartTime }),
        (e: unknown) =>
          e instanceof Error &&
          /疑似 pid 复用/.test(e.message) &&
          e.message.includes("ps -p") &&
          e.message.includes(daemonLockPath(dir)),
        "拒绝启动必须给出可执行的自救指引（确认 pid 后删锁）",
      );

      // (b) 旧版本锁根本没有 processStart 字段：同样保守当活
      writeFileSync(
        daemonLockPath(dir),
        JSON.stringify({ pid: process.pid, startedAt: "2026-01-01T00:00:00.000Z", hostname: "h" }),
      );
      assert.deepEqual(inspectDaemonLock(dir, { readProcessStartTime: unavailableStartTime }), {
        state: "locked",
        pid: process.pid,
      });
      assert.throws(
        () => acquireDaemonLock(dir, { readProcessStartTime: unavailableStartTime }),
        /疑似 pid 复用/,
      );

      // (c) 降级只影响「pid 存活」这一支：pid 已退出仍是确定性的 stale，必须能接管
      const stalePid = deadPid();
      writeFileSync(
        daemonLockPath(dir),
        JSON.stringify({
          pid: stalePid,
          startedAt: "2026-01-01T00:00:00.000Z",
          processStart: "2026-10-28T01:00:00.000Z",
          processStartSource: "ps",
          token: "t2",
          hostname: "h",
        }),
      );
      const lock = acquireDaemonLock(dir, { readProcessStartTime: unavailableStartTime });
      assert.equal(readLock(lock.path).pid, process.pid);
      assert.equal(readLock(lock.path).processStart, null, "读不到启动时间时记 null");
      assert.equal(readLock(lock.path).processStartSource, "unavailable", "降级依据要落进锁文件");
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("真实启动时间读取：锁文件记录与 readProcessStartTime 一致，且能识别伪造的启动时间", () => {
    // 这条走生产实现（macOS 用 ps、Linux 用 /proc）。本机 ps 被沙箱拦住时 readProcessStartTime
    // 返回 unavailable —— 此时断言「锁记 null + 判 locked（保守）」，两个分支都显式断言，
    // 不做静默跳过。
    const dir = tempDir();
    try {
      const reading = readProcessStartTime(process.pid);
      const lock = acquireDaemonLock(dir);
      const content = readLock(lock.path);
      if (reading.value === undefined) {
        assert.equal(content.processStart, null);
        assert.equal(content.processStartSource, "unavailable");
        assert.deepEqual(inspectDaemonLock(dir), { state: "locked", pid: process.pid });
      } else {
        assert.equal(content.processStart, reading.value, "锁记录的必须是 OS 口径的启动时间");
        assert.equal(content.processStartSource, reading.source);
        assert.deepEqual(inspectDaemonLock(dir), { state: "locked", pid: process.pid });
        lock.release();
        // 真读取器下也能识别 pid 复用：同一个存活 pid + 伪造的启动时间 → stale
        writeFileSync(
          daemonLockPath(dir),
          JSON.stringify({
            pid: process.pid,
            startedAt: "2026-01-01T00:00:00.000Z",
            processStart: "2020-01-01T00:00:00.000Z",
            processStartSource: "ps",
            token: "forged",
            hostname: "h",
          }),
        );
        assert.deepEqual(inspectDaemonLock(dir), { state: "stale", pid: process.pid });
      }
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
