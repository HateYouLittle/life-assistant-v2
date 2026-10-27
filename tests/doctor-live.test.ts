import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { runBackup } from "../src/core/backup.js";
import { openDatabase, SCHEMA_VERSION } from "../src/core/database.js";
import { type CheckResult, runDoctor } from "../src/doctor.js";

/**
 * `doctor --live` 的端到端测试：用本地 http server 桩代替真实 daemon
 * （daemon 的 cron/timer 会让测试进程不退出，绝不能直接启动）。
 *
 * 覆盖三件事：可达时三项检查全 ok、任务停更/备份过期时正确降级、daemon 不可达时
 * 不把「读不到 /api/*」重复报成多条失败；另外守住「无 --live 时零网络请求」。
 */

interface StubResponse {
  status?: number;
  body?: unknown;
}

type StubHandler = (auth: string | undefined) => StubResponse;
type StubRoutes = Record<string, StubResponse | StubHandler>;

interface StubServer {
  port: number;
  requests: { path: string; auth: string | undefined }[];
  close(): Promise<void>;
}

/** 监听 127.0.0.1 的随机端口；记录每次请求的路径与 Authorization，便于断言鉴权 */
function startStub(routes: StubRoutes): Promise<StubServer> {
  const requests: { path: string; auth: string | undefined }[] = [];
  const server = createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0] ?? "";
    const auth = req.headers.authorization;
    requests.push({ path, auth });
    const route = routes[path];
    const result: StubResponse =
      route === undefined
        ? { status: 404, body: { error: "not found" } }
        : typeof route === "function"
          ? route(auth)
          : route;
    res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.body ?? {}));
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolvePromise({
        port,
        requests,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

interface DoctorEnv {
  dir: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** 一次性 DATA_DIR；doctor 会自己创建/打开库，不需要 makeTestEnv 的 runtime */
function makeDoctorEnv(port: number, extra: Record<string, string> = {}): DoctorEnv {
  const dir = mkdtempSync(join(tmpdir(), "life-assistant-doctor-live-"));
  return {
    dir,
    env: { DATA_DIR: dir, HOST: "127.0.0.1", PORT: String(port), LOG_LEVEL: "error", ...extra },
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function levelOf(checks: CheckResult[], name: string): CheckResult["level"] | undefined {
  return checks.find((check) => check.name === name)?.level;
}

function detailOf(checks: CheckResult[], name: string): string {
  return checks.find((check) => check.name === name)?.detail ?? "";
}

/** `/api/jobs` 里的一条 job（lastOkAgoHours 为 null 表示从未成功） */
function jobItem(over: {
  module: string;
  name: string;
  cron: string;
  lastOkAgoHours: number | null;
}): Record<string, unknown> {
  const lastOkAt =
    over.lastOkAgoHours === null
      ? null
      : new Date(Date.now() - over.lastOkAgoHours * 3600 * 1000).toISOString();
  return {
    module: over.module,
    name: over.name,
    cron: over.cron,
    last_ok_at: lastOkAt,
    last_run:
      lastOkAt === null
        ? null
        : { status: "ok", started_at: lastOkAt, finished_at: lastOkAt, error: null },
    failed_24h: 0,
    recent_failures: [],
    recent_runs: [],
  };
}

const FRESH_JOBS = [
  jobItem({ module: "weather", name: "daily_brief", cron: "0 7 * * *", lastOkAgoHours: 2 }),
  jobItem({ module: "weather", name: "evening_brief", cron: "0 21 * * *", lastOkAgoHours: 2 }),
  jobItem({ module: "weather", name: "alert_watch", cron: "*/20 * * * *", lastOkAgoHours: 0.2 }),
  jobItem({ module: "holiday", name: "workday_watch", cron: "0 7 * * *", lastOkAgoHours: 3 }),
  jobItem({ module: "maintenance", name: "daily_backup", cron: "0 3 * * *", lastOkAgoHours: 5 }),
];

/** 写一份规范命名的备份文件，并把 mtime 拨到 ageHours 小时前 */
/**
 * 种一份备份。规范命名的备份必须是**真能打开**的库：checkLiveBackup 会做
 * verifyLatest（quick_check + schema 可读），拿假字节会让「备份新鲜度」误报成
 * 校验失败。非规范命名的夹具（迁移前快照等）保持假内容即可。
 */
function seedBackup(dir: string, over: { name?: string; ageHours?: number } = {}): void {
  const backups = join(dir, "backups");
  mkdirSync(backups, { recursive: true });
  const name = over.name ?? "life-assistant-20261020-030000.db";
  const path = join(backups, name);
  if (/^life-assistant-\d{8}-\d{6}\.db$/.test(name)) {
    const db = new DatabaseSync(path);
    try {
      db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?)").run(
        String(SCHEMA_VERSION),
      );
    } finally {
      db.close();
    }
  } else {
    writeFileSync(path, "backup-bytes");
  }
  const stamp = new Date(Date.now() - (over.ageHours ?? 1) * 3600 * 1000);
  utimesSync(path, stamp, stamp);
}

/** 种一份「内容损坏但文件名规范」的备份：模拟磁盘坏块/半截库 */
function seedCorruptBackup(dir: string): void {
  const backups = join(dir, "backups");
  mkdirSync(backups, { recursive: true });
  const path = join(backups, "life-assistant-20261020-030000.db");
  writeFileSync(path, "not-a-sqlite-db");
}

/**
 * 造一份「旁车仍可信、但库中间页已损坏」的备份：真实 backup + 可信旁车，然后覆盖中间
 * 一个 4KB 页并把旁车里的 mtime 同步成新值（首尾 4KB 指纹不变）。
 * 这是零开库口径无法识破、只有 doctor 的 deep 开库校验能抓到的形态。
 */
function seedTrustedButMiddleCorruptedBackup(dir: string, port: number): string {
  const config = loadConfig({
    DATA_DIR: dir,
    HOST: "127.0.0.1",
    PORT: String(port),
    LOG_LEVEL: "error",
  });
  const db = openDatabase(config.dbPath);
  try {
    db.exec("CREATE TABLE filler (id INTEGER PRIMARY KEY, blob BLOB)");
    const blob = Buffer.alloc(64 * 1024, 7);
    for (let i = 0; i < 4; i += 1) db.prepare("INSERT INTO filler (blob) VALUES (?)").run(blob);
  } finally {
    db.close();
  }
  const backupPath = runBackup(config);
  const buf = readFileSync(backupPath);
  const pageSize = 4096;
  const pageStart = Math.floor(Math.floor(buf.length / 2) / pageSize) * pageSize;
  for (let i = pageStart; i < pageStart + pageSize && i < buf.length; i += 1) buf[i] = 0xff;
  writeFileSync(backupPath, buf);
  const sidecarPath = `${backupPath}.verified`;
  const payload = JSON.parse(readFileSync(sidecarPath, "utf8")) as { mtimeMs: number };
  payload.mtimeMs = statSync(backupPath).mtimeMs;
  writeFileSync(sidecarPath, JSON.stringify(payload));
  return backupPath;
}

describe("doctor --live", () => {
  it("daemon 可达、任务新鲜、备份新：相关检查全部 ok，且请求带 Bearer", async () => {
    const token = "t".repeat(32);
    const stub = await startStub({
      "/healthz": { body: { ok: true, version: "2.0.0", uptime_s: 7200 } },
      "/api/status": (auth) =>
        auth === `Bearer ${token}` ? { body: { ok: true } } : { status: 401, body: {} },
      "/api/jobs": (auth) =>
        auth === `Bearer ${token}` ? { body: { items: FRESH_JOBS } } : { status: 401, body: {} },
    });
    const doctorEnv = makeDoctorEnv(stub.port, { WEB_API_TOKEN: token });
    try {
      seedBackup(doctorEnv.dir, { ageHours: 1 });
      const report = await runDoctor(doctorEnv.env, { live: true });
      assert.equal(levelOf(report.checks, "daemon 存活"), "ok");
      assert.equal(levelOf(report.checks, "只读 API"), "ok", "/api/status 必须能读");
      for (const key of [
        "weather.daily_brief",
        "weather.evening_brief",
        "weather.alert_watch",
        "holiday.workday_watch",
        "maintenance.daily_backup",
      ]) {
        assert.equal(
          levelOf(report.checks, `任务新鲜度：${key}`),
          "ok",
          `${key} 应判定为新鲜：${detailOf(report.checks, `任务新鲜度：${key}`)}`,
        );
      }
      assert.equal(levelOf(report.checks, "备份新鲜度"), "ok");
      assert.equal(report.failed, 0, "全部新鲜时不应有任何失败项");
      assert.ok(
        stub.requests.some(
          (request) => request.path === "/api/jobs" && request.auth === `Bearer ${token}`,
        ),
        `配了 WEB_API_TOKEN 时 /api/jobs 必须带 Bearer：${JSON.stringify(stub.requests)}`,
      );
    } finally {
      await stub.close();
      doctorEnv.cleanup();
    }
  });

  it("每日任务新鲜度按 cron 周期放宽：21:00 晚报到次日 09:00 不算停更（回归）", async () => {
    // 回归：阈值曾固定为「补发窗口×2」=12h，导致每天一次的任务（晚报/日报/备份）
    // 在两次触发之间的正常空档被误判为停更（如 21:00 晚报在次日 09:00 必报 fail）。
    const jobs = FRESH_JOBS.map((item) => {
      const name = item.name as string;
      const age = name === "evening_brief" ? 13 : name === "daily_brief" ? 20 : 0.2;
      return jobItem({
        module: item.module as string,
        name,
        cron: item.cron as string,
        lastOkAgoHours: age,
      });
    });
    const stub = await startStub({
      "/healthz": { body: { ok: true, version: "2.0.0", uptime_s: 60 } },
      "/api/status": { body: { ok: true } },
      "/api/jobs": { body: { items: jobs } },
    });
    const doctorEnv = makeDoctorEnv(stub.port);
    try {
      seedBackup(doctorEnv.dir, { ageHours: 1 });
      const report = await runDoctor(doctorEnv.env, { live: true });
      for (const key of ["weather.daily_brief", "weather.evening_brief"]) {
        assert.equal(
          levelOf(report.checks, `任务新鲜度：${key}`),
          "ok",
          `${key} 在日周期内的正常空档不应被判停更：${detailOf(report.checks, `任务新鲜度：${key}`)}`,
        );
        assert.match(detailOf(report.checks, `任务新鲜度：${key}`), /阈值 37 小时/);
      }
      assert.equal(report.failed, 0, "日周期空档不应有失败项");
    } finally {
      await stub.close();
      doctorEnv.cleanup();
    }
  });

  it("HOST 是通配绑定（0.0.0.0）时 live 自检走回环，而不是拿 0.0.0.0 当 URL", async () => {
    // 回归：为局域网/反代把 HOST 改成 0.0.0.0 后，doctor --live 用 http://0.0.0.0:3080
    // 连不上，还容易被误判成「daemon 挂了」。自检一律探回环。
    const stub = await startStub({
      "/healthz": { body: { ok: true, version: "2.0.0", uptime_s: 60 } },
      "/api/status": { body: { ok: true } },
      "/api/jobs": { body: { items: FRESH_JOBS } },
    });
    const doctorEnv = makeDoctorEnv(stub.port, {
      HOST: "0.0.0.0",
      WEB_API_TOKEN: "a".repeat(64),
    });
    try {
      seedBackup(doctorEnv.dir, { ageHours: 1 });
      const report = await runDoctor(doctorEnv.env, { live: true });
      assert.equal(levelOf(report.checks, "daemon 存活"), "ok");
      assert.equal(levelOf(report.checks, "只读 API"), "ok");
      assert.ok(
        stub.requests.some((request) => request.path === "/healthz"),
        `live 自检必须真的打到桩服务：${JSON.stringify(stub.requests)}`,
      );
    } finally {
      await stub.close();
      doctorEnv.cleanup();
    }
  });

  it("任务停更 → fail；缺 job / 无法反向求值 → warn；备份过期与非规范文件 → warn", async () => {
    const stub = await startStub({
      "/healthz": { body: { ok: true, version: "2.0.0", uptime_s: 60 } },
      "/api/status": { body: { ok: true } },
      "/api/jobs": {
        body: {
          items: [
            // 阈值 = max(补发窗口 6h×2, cron 日间隔 24h×1.5+1=37h)，已 40 小时没成功
            jobItem({
              module: "weather",
              name: "daily_brief",
              cron: "0 7 * * *",
              lastOkAgoHours: 40,
            }),
            // evening_brief 故意缺失（例如旧版本 daemon）
            // 升级/首次部署后 job_runs 还没有记录：只 warn（真停摆要靠「有记录但超窗」判定）
            jobItem({
              module: "weather",
              name: "alert_watch",
              cron: "*/20 * * * *",
              lastOkAgoHours: null,
            }),
            // 带「日」限制的 cron（每月 1 号）：无法反推触发时刻 → warn 而不是 fail
            // （星期限制已支持反向求值，只有日/月非 * 的表达式才是不可求值的）
            jobItem({
              module: "holiday",
              name: "workday_watch",
              cron: "0 9 1 * *",
              lastOkAgoHours: 1,
            }),
            // 阈值 = 24h × 2 = 48h，已 50 小时没成功
            jobItem({
              module: "maintenance",
              name: "daily_backup",
              cron: "0 3 * * *",
              lastOkAgoHours: 50,
            }),
          ],
        },
      },
    });
    const doctorEnv = makeDoctorEnv(stub.port);
    try {
      seedBackup(doctorEnv.dir, { ageHours: 48 });
      // 非规范命名的文件（迁移前快照/恢复留底）要单独列出
      seedBackup(doctorEnv.dir, { name: "life-assistant-pre-v3-20261001-000000.db", ageHours: 1 });

      const report = await runDoctor(doctorEnv.env, { live: true });
      assert.equal(levelOf(report.checks, "daemon 存活"), "ok");
      assert.equal(levelOf(report.checks, "任务新鲜度：weather.daily_brief"), "fail");
      assert.match(detailOf(report.checks, "任务新鲜度：weather.daily_brief"), /阈值 37 小时/);
      assert.equal(levelOf(report.checks, "任务新鲜度：maintenance.daily_backup"), "fail");
      assert.equal(
        levelOf(report.checks, "任务新鲜度：weather.evening_brief"),
        "warn",
        "daemon 没注册 evening_brief 只该警告（版本不一致），不能当成任务坏了",
      );
      assert.equal(
        levelOf(report.checks, "任务新鲜度：holiday.workday_watch"),
        "warn",
        "无法反向求值的 cron 只该警告",
      );
      assert.equal(levelOf(report.checks, "备份新鲜度"), "warn");
      assert.match(detailOf(report.checks, "备份新鲜度"), /36 小时/);
      assert.equal(levelOf(report.checks, "备份文件命名"), "warn");
      assert.match(detailOf(report.checks, "备份文件命名"), /pre-v3/);
      assert.equal(
        levelOf(report.checks, "任务新鲜度：weather.alert_watch"),
        "warn",
        "升级/首次部署第一天没有运行记录只该警告，不能报假故障",
      );
      assert.match(detailOf(report.checks, "任务新鲜度：weather.alert_watch"), /尚无成功运行记录/);
      assert.equal(report.failed, 2, "只有两个任务停更算失败");
    } finally {
      await stub.close();
      doctorEnv.cleanup();
    }
  });

  it("daemon 不可达：只报一条失败，备份检查照常执行", async () => {
    // 先占一个端口再关掉，得到一个「确定没人监听」的端口
    const reserved = await startStub({});
    const port = reserved.port;
    await reserved.close();
    const doctorEnv = makeDoctorEnv(port);
    try {
      const report = await runDoctor(doctorEnv.env, { live: true });
      assert.equal(levelOf(report.checks, "daemon 存活"), "fail");
      assert.equal(levelOf(report.checks, "任务新鲜度"), "warn");
      assert.ok(
        report.checks.some((check) => check.name === "备份新鲜度"),
        "备份检查不依赖 daemon，必须仍然执行",
      );
      assert.equal(report.failed, 1, `只应有一条失败：${JSON.stringify(report.checks)}`);
    } finally {
      doctorEnv.cleanup();
    }
  });

  it("无 --live 时完全不发网络请求（默认行为不变）", async () => {
    const stub = await startStub({ "/healthz": { body: { ok: true } } });
    const doctorEnv = makeDoctorEnv(stub.port);
    try {
      seedBackup(doctorEnv.dir, { ageHours: 1 });
      const report = await runDoctor(doctorEnv.env);
      assert.deepEqual(stub.requests, [], "默认不得访问 daemon/网络");
      assert.equal(levelOf(report.checks, "daemon 存活"), undefined);
      assert.equal(
        report.checks.some((check) => check.name === "备份新鲜度"),
        false,
        "「备份新鲜度」是 --live 的检查，默认不应出现（默认行为必须完全不变）",
      );
    } finally {
      await stub.close();
      doctorEnv.cleanup();
    }
  });

  it("最新备份损坏 → 备份新鲜度 fail，不能被很新的 mtime 骗成健康（P1-4）", async () => {
    const stub = await startStub({
      "/healthz": { body: { ok: true, version: "2.0.0", uptime_s: 60 } },
      "/api/status": { body: { ok: true } },
      "/api/jobs": { body: { items: FRESH_JOBS } },
    });
    const doctorEnv = makeDoctorEnv(stub.port);
    try {
      seedCorruptBackup(doctorEnv.dir);
      const report = await runDoctor(doctorEnv.env, { live: true });
      assert.equal(levelOf(report.checks, "备份新鲜度"), "fail");
      assert.match(detailOf(report.checks, "备份新鲜度"), /校验失败/);
    } finally {
      await stub.close();
      doctorEnv.cleanup();
    }
  });

  it("伪造旁车说「已校验通过」但库其实坏了 → 仍判 fail，并在明细里点出旁车说谎", async () => {
    const stub = await startStub({
      "/healthz": { body: { ok: true, version: "2.0.0", uptime_s: 60 } },
      "/api/status": { body: { ok: true } },
      "/api/jobs": { body: { items: FRESH_JOBS } },
    });
    const doctorEnv = makeDoctorEnv(stub.port);
    try {
      // 旁车可信（首尾指纹一致）但中间页损坏：零开库口径会信它，doctor 必须靠开库推翻
      seedTrustedButMiddleCorruptedBackup(doctorEnv.dir, stub.port);

      const report = await runDoctor(doctorEnv.env, { live: true });
      assert.equal(
        levelOf(report.checks, "备份新鲜度"),
        "fail",
        "doctor --live 必须忽略旁车结论、现场开库校验",
      );
      assert.match(detailOf(report.checks, "备份新鲜度"), /旁车/);
      assert.match(detailOf(report.checks, "备份新鲜度"), /以开库结果为准/);
    } finally {
      await stub.close();
      doctorEnv.cleanup();
    }
  });
});
