import type { DatabaseSync } from "node:sqlite";
import type { DateTime } from "luxon";
import { type ZodRawShape, z } from "zod";
import type { ResolvedConfig } from "../config.js";

/**
 * 模块注册表：核心不 import 模块内部文件；模块通过 tools/jobs/tick/onStart 四个
 * 扩展点接入，由契约测试强制（tests/registry.test.ts）。
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
  /**
   * 投递截止时刻（ISO）。到点仍未投出（典型场景：静默时段拦下的气象预警）即作废，
   * 避免把已经失效的内容补投给用户；通知本身仍保留，可由 notify.pull 兜底。
   */
  expiresAt?: string;
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
  /** 5 段 cron（Asia/Shanghai）；可用函数惰性求值（如从 config 读取） */
  cron: string | (() => string);
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

/**
 * 经注册表调用工具（非 MCP 的调用方，如 HTTP 子应用 `/api/quick/*` 用）。
 *
 * 为什么要有它：`inputSchema` 是模块对外唯一契约（MCP 侧由 SDK 按同一份 zod raw shape
 * 校验）。绕过 registry 直接 import 模块 handler，等于让每个调用方自己手写一套参数校验 ——
 * 两边迟早漂移（手机端曾漏掉长度上限、只能靠 service 兜底），新增工具也不会自动在
 * HTTP 侧可达。这里按名取 def、用同一份 schema 校验参数，再调 handler。
 *
 * 失败口径与 MCP 侧一致：未注册 / 参数不合法 / handler 抛错都返回 `fail(...)`
 * （`isError: true` 的结果，不抛异常），调用方按既有的「工具错误 → 4xx」路径处理。
 */
export async function invokeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = allTools().find((t) => t.def.name === name);
  if (tool === undefined) return fail(`工具未注册: ${name}`);
  const parsed = z.object(tool.def.inputSchema).safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return fail(`参数不合法（${name}）: ${detail}`);
  }
  try {
    return await tool.def.handler(parsed.data as Record<string, unknown>, ctx);
  } catch (e) {
    return fail(errorMessage(e));
  }
}
