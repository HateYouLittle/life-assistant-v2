import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import type { ZodRawShape } from "zod";
import type { ResolvedConfig } from "../config.js";

/**
 * 模块注册表：核心不 import 模块内部文件；模块通过 tools/jobs/tick/onStart 四个
 * 扩展点接入，由契约测试强制（tests/registry-contract.test.ts）。
 */

export interface NotifyBlock {
  /** 主表格：columns 为表头，rows 为行内容（字符串） */
  table?: { columns: string[]; rows: string[][] };
  /** 表格之外的补充行（逐条渲染） */
  notes?: string[];
}

export interface PublishInput {
  /** 通知种类，如 schedule.reminder / weather.brief / bookkeeping.monthly */
  kind: string;
  title: string;
  blocks: NotifyBlock;
  /** Profile 内去重键；相同键的后续发布被丢弃（返回 null） */
  dedupeKey?: string;
}

export interface PublishResult {
  id: string;
  deduped: boolean;
}

/** daemon 启动时装配，模块只依赖此接口 */
export interface Services {
  publishProfile(profileId: string, input: PublishInput): Promise<PublishResult>;
  publishGlobal(input: PublishInput): Promise<{ materialized: number }>;
}

export interface ToolContext {
  profileId: string;
  db: DatabaseSync;
  config: ResolvedConfig;
  services: Services;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  [key: string]: unknown;
}

export interface ToolDef {
  name: string;
  description: string;
  /** zod raw shape；SDK 会生成 JSON Schema */
  inputSchema: ZodRawShape;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> | ToolResult;
}

export interface JobDef {
  name: string;
  /** 5 段 cron， Asia/Shanghai */
  cron: string;
  handler(at: DateTime): Promise<void> | void;
}

export interface AssistantModule {
  name: string;
  tools?: ToolDef[];
  jobs?: JobDef[];
  /** 每分钟调用；调度器保证不重叠 */
  tick?(at: DateTime): Promise<void>;
  /** 租约/启动后的非阻塞引导 */
  onStart?(): Promise<void>;
}

const modules: AssistantModule[] = [];

/** daemon 启动时初始化一次；job/tick/onStart 无 ToolContext，通过 runtime() 取运行时 */
export interface Runtime {
  db: DatabaseSync;
  config: ResolvedConfig;
  services: Services;
}

let runtimeCtx: Runtime | null = null;

export function initRuntime(rt: Runtime): void {
  if (runtimeCtx !== null) throw new Error("runtime 已初始化，禁止重复调用");
  runtimeCtx = rt;
}

export function runtime(): Runtime {
  if (runtimeCtx === null) throw new Error("runtime 未初始化（必须在 daemon/测试启动后使用）");
  return runtimeCtx;
}

export function resetRuntimeForTests(): void {
  runtimeCtx = null;
}

export function registerModule(module: AssistantModule): void {
  if (modules.some((m) => m.name === module.name)) {
    throw new Error(`模块重复注册: ${module.name}`);
  }
  const seenTools = new Set(modules.flatMap((m) => (m.tools ?? []).map((t) => t.name)));
  for (const def of module.tools ?? []) {
    if (!/^[a-z][a-z0-9_]*$/.test(def.name)) {
      throw new Error(`工具名不合法: ${module.name}.${def.name}`);
    }
    if (seenTools.has(def.name)) {
      throw new Error(`工具名重复: ${def.name}`);
    }
    seenTools.add(def.name);
  }
  const seenJobs = new Set(modules.flatMap((m) => (m.jobs ?? []).map((j) => j.name)));
  for (const def of module.jobs ?? []) {
    if (seenJobs.has(def.name)) {
      throw new Error(`Job 名重复: ${def.name}`);
    }
    seenJobs.add(def.name);
  }
  modules.push(module);
}

export function getModules(): readonly AssistantModule[] {
  return modules;
}

export interface RegisteredTool {
  module: string;
  def: ToolDef;
}

export function allTools(): RegisteredTool[] {
  const out: RegisteredTool[] = [];
  for (const m of modules) {
    for (const def of m.tools ?? []) {
      if (!/^[a-z][a-z0-9_]*$/.test(def.name)) {
        throw new Error(`工具名不合法: ${m.name}.${def.name}`);
      }
      if (out.some((t) => t.def.name === def.name)) {
        throw new Error(`工具名重复: ${def.name}`);
      }
      out.push({ module: m.name, def });
    }
  }
  return out;
}

export function allJobs(): { module: string; def: JobDef }[] {
  const out: { module: string; def: JobDef }[] = [];
  for (const m of modules) {
    for (const def of m.jobs ?? []) {
      if (out.some((j) => j.def.name === def.name)) {
        throw new Error(`Job 名重复: ${def.name}`);
      }
      out.push({ module: m.name, def });
    }
  }
  return out;
}

export function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

export function okJson(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: "text", text: `错误：${message}` }], isError: true };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}
