import { z } from "zod";
import { fail, type ToolContext, type ToolResult } from "./registry.js";

/** 缺少 action（仅开启 view 别名时使用） */
export const MISSING_ACTION_MESSAGE = "缺少 action（或兼容别名 view）";

export function unknownFieldMessage(field: string, action: string): string {
  return `未知字段: ${field}（action=${action} 不接受）`;
}

export function unknownActionMessage(action: unknown): string {
  return `未知 action: ${String(action)}`;
}

function conflictMessage(action: string, view: string, group?: string): string {
  return group === undefined
    ? `action 与 view 冲突: action=${action}, view=${view}`
    : `action 与 view 冲突: action=${action}（${group}）, view=${view}`;
}

/**
 * 返回第一个不在白名单内的字段名；全部合法返回 null。
 * 值为 undefined 的键视为未传；`action` 与 skip 中的键不属于「字段」。
 */
export function findUnknownField(
  args: Record<string, unknown>,
  allowed: readonly string[],
  skip: readonly string[] = ["action"],
): string | null {
  for (const key of Object.keys(args)) {
    if (skip.includes(key) || args[key] === undefined) continue;
    if (!allowed.includes(key)) return key;
  }
  return null;
}

export interface ActionSpec {
  /** 该 action 接受的字段白名单；省略 = 不做未知字段校验 */
  fields?: readonly string[];
  /** 必填项：缺失或纯空白字符串时返回 message（空串等同缺失），按顺序取第一条 */
  requires?: readonly { field: string; message: string }[];
  /** 分组：view 别名按分组匹配；省略 = 自身名 */
  group?: string;
  handler(args: Record<string, unknown>, ctx: ToolContext): ToolResult | Promise<ToolResult>;
}

export interface ActionToolOptions<A extends string> {
  actions: Record<A, ActionSpec>;
  /** 开启 `view` 兼容别名 */
  viewAlias?: boolean;
  /** 冲突文案是否带 （group） 段 */
  conflictShowsGroup?: boolean;
}

export function defineActionTool<A extends string>(opts: ActionToolOptions<A>) {
  const { actions, viewAlias = false, conflictShowsGroup = false } = opts;
  const actionNames = Object.keys(actions) as [A, ...A[]];
  const isAction = (value: string): value is A => Object.hasOwn(actions, value);
  const groupOf = (name: A): string => actions[name].group ?? name;

  const groups = new Set<string>();
  for (const name of actionNames) {
    const group = groupOf(name);
    if (!isAction(group)) {
      throw new Error(`action "${name}" 的 group "${group}" 不是已声明的 action 名`);
    }
    groups.add(group);
  }

  function resolve(args: Record<string, unknown>): { action: A } | { error: string } {
    const action = typeof args.action === "string" ? args.action : undefined;
    const view = viewAlias && typeof args.view === "string" ? args.view : undefined;
    if (action !== undefined && !isAction(action)) {
      return { error: unknownActionMessage(action) };
    }
    if (view !== undefined && !groups.has(view)) return { error: unknownActionMessage(view) };
    if (action !== undefined && view !== undefined) {
      const group = groupOf(action as A);
      if (group !== view) {
        return {
          error: conflictMessage(action, view, conflictShowsGroup ? group : undefined),
        };
      }
      return { action: action as A };
    }
    if (action !== undefined) return { action: action as A };
    if (view !== undefined) return { action: view as A };
    return { error: viewAlias ? MISSING_ACTION_MESSAGE : unknownActionMessage(args.action) };
  }

  function handler(
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): ToolResult | Promise<ToolResult> {
    const resolved = resolve(args);
    if ("error" in resolved) return fail(resolved.error);
    const action = resolved.action;
    const spec = actions[action];
    if (spec.fields !== undefined) {
      const unknown = findUnknownField(
        args,
        spec.fields,
        viewAlias ? ["action", "view"] : ["action"],
      );
      if (unknown !== null) return fail(unknownFieldMessage(unknown, action));
    }
    for (const rule of spec.requires ?? []) {
      const value = args[rule.field];
      if (value === undefined || (typeof value === "string" && value.trim() === "")) {
        return fail(rule.message);
      }
    }
    return spec.handler(args, ctx);
  }

  return {
    actionNames,
    actionEnum: () => z.enum(actionNames),
    resolve,
    handler,
  };
}
