import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

const noopHandler = () => ok("noop");

describe("registry 契约", () => {
  it("模块重复注册抛错", () => {
    registerModule({ name: "m1", tools: [{ name: "t1", description: "", inputSchema: {}, handler: noopHandler }] });
    assert.throws(() => registerModule({ name: "m1" }), /重复注册/);
  });

  it("工具名重复或非法抛错", () => {
    registerModule({ name: "m2", tools: [{ name: "t_dup", description: "", inputSchema: {}, handler: noopHandler }] });
    assert.throws(
      () => registerModule({ name: "m3", tools: [{ name: "t_dup", description: "", inputSchema: {}, handler: noopHandler }] }),
      /工具名重复/,
    );
    assert.throws(
      () => registerModule({ name: "m4", tools: [{ name: "Bad-Name", description: "", inputSchema: {}, handler: noopHandler }] }),
      /工具名不合法/,
    );
  });

  it("job 名重复抛错", () => {
    registerModule({ name: "m5", jobs: [{ name: "j1", cron: "0 7 * * *", handler: () => {} }] });
    assert.throws(() => registerModule({ name: "m6", jobs: [{ name: "j1", cron: "0 8 * * *", handler: () => {} }] }), /Job 名重复/);
  });

  it("allTools/allJobs/getModules 汇总", () => {
    assert.ok(allTools().length >= 2);
    assert.ok(allJobs().length >= 1);
    assert.ok(getModules().length >= 3);
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
    registerModule({ name: "m7", tools: [{ name: "t_shape", description: "", inputSchema: shape, handler: noopHandler }] });
    const tool = allTools().find((t) => t.def.name === "t_shape");
    assert.ok(tool !== undefined);
  });
});
