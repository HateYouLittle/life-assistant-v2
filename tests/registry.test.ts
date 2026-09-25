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
import { cleanupTestEnv, makeTestEnv } from "./helpers.js";
import { registerAllModules } from "../src/modules/index.js";

const noopHandler = () => ok("noop");

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
    const realModules = new Set(["bookkeeping", "holiday", "notify", "schedule", "weather"]);
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
      "bookkeeping.monthly_report",
      "holiday.refresh",
      "holiday.workday_watch",
      "notify.retention",
      "schedule.occurrence_cleanup",
      "weather.alert_watch",
      "weather.daily_brief",
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

  it("核心不 import 模块内部（静态 import 图检查，而非仅运行时查重）", () => {
    // registry.ts 的注释声称本文件强制「核心不 import 模块内部」。运行时查重做不到这点，
    // 这里直接检查 src/core 下每个源文件的静态 import，让注释与实现一致。
    const coreDir = fileURLToPath(new URL("../src/core/", import.meta.url));
    const files = readdirSync(coreDir).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 0, "应当读到 src/core 下的源文件");
    const dynamicImport = /import\(\s*["'][^"']*\/modules\//;
    const staticImport = /from\s+["'][^"']*\/modules\//;
    const offenders = files.filter((file) => {
      const source = readFileSync(join(coreDir, file), "utf8");
      return staticImport.test(source) || dynamicImport.test(source);
    });
    assert.deepEqual(
      offenders,
      [],
      "核心文件不得 import 模块内部；模块只经 src/modules/index.ts 注册",
    );
  });
});
