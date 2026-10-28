import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  allJobs,
  allTools,
  fail,
  getModules,
  ok,
  okJson,
  registerModule,
  runtime,
} from "../src/core/registry.js";
import { registerAllModules } from "../src/modules/index.js";
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";

const noopHandler = () => ok("noop");

/** 抽出源码里所有指向 src/modules/** 的 import 说明符（静态 import 与动态 import()） */
function moduleImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  for (const matched of source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)) {
    const specifier = matched[1] ?? "";
    if (/\/modules\//.test(specifier)) specifiers.push(specifier);
  }
  return specifiers;
}

/**
 * 模块注册入口：`src/modules/index.ts` 只做副作用注册，不是模块内部实现，
 * 允许被 server 层 import（daemon 与各测试也是这么接入的）。模块**内部**文件
 * （`modules/<name>/**`）一律不许绕过 registry 直接 import。
 */
const MODULE_REGISTRATION_ENTRY = "../modules/index.js";

/**
 * server 层允许的「模块内部 import」白名单：文件 → 允许的说明符，逐条显式登记。
 *
 * 这些是只读的纯函数/service 读取（与 details.ts、status.ts 同性质的历史技术债），
 * 不是绕过 registry 直调 handler。新增一条必须显式登记（并同步 AGENTS.md 的例外清单），
 * 否则下面的契约扫描会变红 —— 白名单过期（说明符已不再使用）同样变红。
 */
const SERVER_MODULE_IMPORT_ALLOWLIST: Record<string, string[]> = {
  "budget.ts": ["../modules/bookkeeping/service.js"],
  "details.ts": ["../modules/bookkeeping/service.js", "../modules/schedule/service.js"],
  // P2-24：写路径已改为 registry.invokeTool（不再 import bookkeeping/schedule 的 handler）；
  // 剩下的只是 bootstrap 与「创建后回读事件时间」用的只读 service 函数。
  "quick.ts": ["../modules/bookkeeping/service.js", "../modules/schedule/service.js"],
  "status.ts": ["../modules/bookkeeping/service.js"],
};

describe("registry 契约", () => {
  it("模块重复注册抛错", () => {
    registerModule({
      name: "m1",
      tools: [{ name: "t1", description: "", inputSchema: {}, handler: noopHandler }],
    });
    assert.throws(() => registerModule({ name: "m1" }), /重复注册/);
  });

  it("工具名重复或非法抛错", () => {
    registerModule({
      name: "m2",
      tools: [{ name: "t_dup", description: "", inputSchema: {}, handler: noopHandler }],
    });
    assert.throws(
      () =>
        registerModule({
          name: "m3",
          tools: [{ name: "t_dup", description: "", inputSchema: {}, handler: noopHandler }],
        }),
      /工具名重复/,
    );
    assert.throws(
      () =>
        registerModule({
          name: "m4",
          tools: [{ name: "Bad-Name", description: "", inputSchema: {}, handler: noopHandler }],
        }),
      /工具名不合法/,
    );
  });

  it("job 名重复抛错", () => {
    registerModule({ name: "m5", jobs: [{ name: "j1", cron: "0 7 * * *", handler: () => {} }] });
    assert.throws(
      () =>
        registerModule({
          name: "m6",
          jobs: [{ name: "j1", cron: "0 8 * * *", handler: () => {} }],
        }),
      /Job 名重复/,
    );
  });

  it("汇总接口读到的是真实模块（registerAllModules 之后的工具/job 清单）", () => {
    // 回归：此处曾经只断言 length >= N，而那个下限由本文件前面自己 registerModule 的
    // 测试模块满足 —— 真实模块注册整个坏掉也照样绿，且全程没人调用 registerAllModules。
    registerAllModules();
    const realModules = new Set([
      "bookkeeping",
      "holiday",
      "maintenance",
      "notify",
      "schedule",
      "weather",
    ]);
    const tools = allTools()
      .filter((t) => realModules.has(t.module))
      .map((t) => t.def.name)
      .sort();
    // 工具清单是面向 agent 的契约：改名/增删必须同步 README 与 skill/SKILL.md
    assert.deepEqual(tools, [
      "air_quality",
      "expense",
      "holiday",
      "ledger",
      "notify",
      "schedule",
      "weather",
    ]);
    const jobs = allJobs()
      .filter((j) => realModules.has(j.module))
      .map((j) => `${j.module}.${j.def.name}`)
      .sort();
    assert.deepEqual(jobs, [
      // 每晚 21:30 的每日记账摘要（LEDGER_DIGEST_CRON），取代家庭账本的逐笔回执
      "bookkeeping.ledger_digest",
      "bookkeeping.monthly_report",
      // 周日晚 20:00 的周报（WEEKLY_REPORT_CRON），本周账单 + 环比 + 预算提示
      "bookkeeping.weekly_report",
      "holiday.refresh",
      "holiday.workday_watch",
      "maintenance.daily_backup",
      // 每日 04:50 的 launchd 日志轮转（copytruncate + LOG_KEEP 份保留）
      "maintenance.log_rotate",
      // 每日 WAL checkpoint（运维加固），与备份分开登记，便于状态页分辨失败来源
      "maintenance.wal_checkpoint",
      "notify.retention",
      "schedule.occurrence_cleanup",
      "weather.alert_watch",
      "weather.daily_brief",
      // 21:00 晚报（EVENING_BRIEF_CRON），与早报成对
      "weather.evening_brief",
    ]);
    // 本文件前面注册过测试模块（m1/m2/m5…），因此只断言真实模块都在
    const moduleNames = new Set(getModules().map((m) => m.name));
    for (const name of realModules) {
      assert.ok(moduleNames.has(name), `registerAllModules 之后缺少模块 ${name}`);
    }
  });

  it("runtime 未初始化抛错，初始化后可用，可重置", () => {
    assert.throws(() => runtime(), /未初始化/);
    const env = makeTestEnv();
    try {
      assert.equal(runtime().db, env.db);
    } finally {
      cleanupTestEnv(env);
    }
    assert.throws(() => runtime(), /未初始化/);
  });

  it("工具结果形状", () => {
    assert.deepEqual(okJson({ a: 1 }).content[0], { type: "text", text: '{\n  "a": 1\n}' });
    assert.equal(fail("坏").isError, true);
  });

  it("inputSchema 是 zod raw shape（与 SDK 对接的形状约束）", () => {
    const shape = z.object({ a: z.string() }).shape;
    registerModule({
      name: "m7",
      tools: [{ name: "t_shape", description: "", inputSchema: shape, handler: noopHandler }],
    });
    const tool = allTools().find((t) => t.def.name === "t_shape");
    assert.ok(tool !== undefined);
  });

  it("工具描述里声明的互斥/默认口径必须落到 inputSchema 的 describe（agent 只看得见 schema）", () => {
    // 回归：expense 的 month 与 from/to 互斥、summary 无参默认「月初→今天」，
    // 过去只写在 handler 里（或干脆没写），schema 上看不出来 —— agent 只能照 schema 猜。
    registerAllModules();
    const shape = allTools().find((t) => t.def.name === "expense")?.def.inputSchema ?? {};
    const described = (key: string): string => {
      const field = (shape as Record<string, { description?: string } | undefined>)[key];
      return field?.description ?? "";
    };
    assert.match(described("month"), /与 from\/to 互斥/, "month 的 schema 描述要写明互斥");
    assert.match(described("from"), /与 month 互斥/);
    assert.match(described("to"), /与 month 互斥/);
  });

  it("核心不 import 模块内部（静态 import 图检查，而非仅运行时查重）", () => {
    // registry.ts 的注释声称本文件强制「核心不 import 模块内部」。运行时查重做不到这点，
    // 这里直接检查 src/core 下每个源文件的静态 import，让注释与实现一致。
    const coreDir = fileURLToPath(new URL("../src/core/", import.meta.url));
    const files = readdirSync(coreDir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 0, "应当读到 src/core 下的源文件");
    // 核心层连模块注册入口都不许 import（那是 daemon 的活）：这里不放行 index.js
    const offenders = files.flatMap((file) =>
      moduleImportSpecifiers(readFileSync(join(coreDir, file), "utf8")).map(
        (specifier) => `${file} → ${specifier}`,
      ),
    );
    assert.deepEqual(
      offenders,
      [],
      "核心文件不得 import 模块内部；模块只经 src/modules/index.ts 注册",
    );
  });

  it("server 层不得直接 import 模块内部（静态扫描 + 显式白名单）", () => {
    // P2-24：quick.ts 曾直接 import bookkeeping/schedule 的 handler 与 service，绕过 registry ——
    // 于是 inputSchema 不再是唯一契约（quick 手写一套校验）、新增工具在手机端永远不可达。
    // 这里把 core→modules 的扫描扩到 server 层：模块内部 import 必须逐条登记在白名单里。
    const serverDir = fileURLToPath(new URL("../src/server/", import.meta.url));
    const files = readdirSync(serverDir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 0, "应当读到 src/server 下的源文件");
    const offenders: string[] = [];
    for (const file of files) {
      const allowed = new Set(SERVER_MODULE_IMPORT_ALLOWLIST[file] ?? []);
      for (const specifier of moduleImportSpecifiers(readFileSync(join(serverDir, file), "utf8"))) {
        if (specifier === MODULE_REGISTRATION_ENTRY) continue; // 注册入口，不是模块内部
        if (!allowed.has(specifier)) offenders.push(`${file} → ${specifier}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "server 层不得绕过 registry 直接 import 模块内部；新例外必须显式登记白名单并同步 AGENTS.md",
    );

    // 白名单不许腐烂：登记过的文件/说明符必须真实存在且仍在使用
    for (const [file, specifiers] of Object.entries(SERVER_MODULE_IMPORT_ALLOWLIST)) {
      assert.ok(files.includes(file), `白名单登记了不存在的 server 文件：${file}`);
      const used = new Set(moduleImportSpecifiers(readFileSync(join(serverDir, file), "utf8")));
      for (const specifier of specifiers) {
        assert.ok(used.has(specifier), `白名单过期：${file} 已不再 import ${specifier}`);
      }
    }
  });

  it("契约扫描能抓住「server 直接 import 模块内部」的新违规（变异自证）", () => {
    // ① 在真实的 quick.ts 源码上插一行直调模块 index（handler 层，比 service 更深一层）：
    //    扫描必须把它判成违规，且白名单里不得有它 —— 否则这条测试只是恒绿摆设。
    const serverDir = fileURLToPath(new URL("../src/server/", import.meta.url));
    const quickSource = readFileSync(join(serverDir, "quick.ts"), "utf8");
    assert.ok(
      !quickSource.includes("modules/schedule/index.js"),
      "quick.ts 不应再 import 模块 handler（本任务就是要删掉它）",
    );
    const mutated = `${quickSource}\nimport { scheduleTool } from "../modules/schedule/index.js";\n`;
    const found = moduleImportSpecifiers(mutated);
    assert.ok(
      found.includes("../modules/schedule/index.js"),
      `变异后的直调没有被扫描抓到：${JSON.stringify(found)}`,
    );
    assert.ok(
      !(SERVER_MODULE_IMPORT_ALLOWLIST["quick.ts"] ?? []).includes("../modules/schedule/index.js"),
      "白名单不得放行模块 index（handler 层），否则违规会被静默吞掉",
    );
    // 同一变异若在 core 层，同样必须被 core 扫描抓到
    assert.deepEqual(
      moduleImportSpecifiers('import { weatherTool } from "../modules/weather/index.js";'),
      ["../modules/weather/index.js"],
    );
    // ② 注册入口是唯一放行项：只有它不算违规，模块内部 service/index 都算
    assert.deepEqual(moduleImportSpecifiers('import "../modules/index.js";'), [
      MODULE_REGISTRATION_ENTRY,
    ]);
    assert.deepEqual(
      moduleImportSpecifiers('const m = await import("../modules/weather/service.js");'),
      ["../modules/weather/service.js"],
    );
  });
});
