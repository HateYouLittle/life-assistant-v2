import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

/**
 * docs/http-shortcuts.json 的一致性回归：这份文件是「给人手动导入」的，格式错在运行时不报错
 * （只有用户手机上导入失败才会发现），所以在这里按 HTTP Shortcuts 自己的导入校验规则钉住：
 * 根节点必须有 categories、version/compatibilityVersion 合法、id 是 UUID、变量 key 合法、
 * 占位符都能解析、**header 值必须是 ASCII**（App 的 Validation.isValidInHeaderValue 只允许
 * 0x20..0x7E，中文注释/token 会让整个文件导入失败）。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** App: Variables.VARIABLE_KEY_REGEX */
const VARIABLE_KEY_RE = /^[A-Za-z0-9_]{1,30}$/;
/** App: Variables.RAW_PLACEHOLDER_REGEX（只认 key 形态，不含 UUID 形式） */
const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]{1,30})\}\}/g;
/** App: Validation.isValidInHeaderValue（逐字符 0x20..0x7E；这里拒绝整段非 ASCII） */
const ASCII_HEADER_VALUE_RE = /^[\x20-\x7e]*$/;

/** App 的枚举字面量（HttpMethod / ShortcutExecutionType / RequestBodyType / Response*） */
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE"]);
const EXECUTION_TYPES = new Set(["app", "browser", "scripting", "trigger", "mqtt", "wol"]);
const REQUEST_BODY_TYPES = new Set(["custom_text", "form_data", "x_www_form_urlencode", "file"]);
const RESPONSE_UI_TYPES = new Set(["toast", "notification", "dialog", "window"]);
const RESPONSE_OUTPUTS = new Set(["response", "message", "none"]);
const FAILURE_OUTPUTS = new Set(["detailed", "simple", "none"]);
const VARIABLE_TYPES = new Set([
  "constant",
  "text",
  "number",
  "password",
  "select",
  "color",
  "date",
  "time",
  "slider",
  "toggle",
  "increment",
  "uuid",
  "clipboard",
  "timestamp",
]);
/** App: ImportExport.VERSION / COMPATIBILITY_VERSION（本文件按 92/90 编写） */
const APP_VERSION = 92;
const APP_COMPATIBILITY_VERSION = 90;

interface Header {
  key?: string;
  value?: string;
}
interface ResponseHandling {
  uiType?: string;
  successOutput?: string;
  failureOutput?: string;
}
interface Shortcut {
  id?: string;
  name?: string;
  method?: string;
  url?: string;
  headers?: Header[];
  bodyContent?: string;
  requestBodyType?: string;
  contentType?: string;
  executionType?: string;
  timeout?: number;
  launcherShortcut?: boolean;
  responseHandling?: ResponseHandling;
}
interface Category {
  id?: string;
  name?: string;
  layoutType?: string;
  shortcuts?: Shortcut[];
}
interface Variable {
  id?: string;
  key?: string;
  type?: string;
  title?: string;
  message?: string;
}
interface ExportFile {
  version?: number;
  compatibilityVersion?: number;
  categories?: Category[];
  variables?: Variable[];
}

const doc = JSON.parse(readFileSync("docs/http-shortcuts.json", "utf8")) as ExportFile;
const shortcuts = (doc.categories ?? []).flatMap((category) => category.shortcuts ?? []);
const variables = doc.variables ?? [];
const variableKeys = new Set(variables.map((variable) => variable.key ?? ""));

/** 收齐一个对象里所有字符串字段（用于占位符/header 校验） */
function textFields(shortcut: Shortcut): string[] {
  const fields = [shortcut.url ?? "", shortcut.bodyContent ?? ""];
  for (const header of shortcut.headers ?? []) fields.push(header.value ?? "");
  return fields;
}

describe("HTTP Shortcuts 导出文件", () => {
  it("是可解析的 JSON，且满足 App 的导入前置条件（categories / version / compatibilityVersion）", () => {
    assert.ok(
      Array.isArray(doc.categories),
      "根节点必须有 categories（否则 App 直接 InvalidFile）",
    );
    assert.ok((doc.categories ?? []).length > 0, "至少要有一个分类");
    assert.equal(typeof doc.version, "number");
    assert.ok((doc.version ?? 0) > 1, "version 必须 > 1");
    assert.equal(doc.compatibilityVersion, APP_COMPATIBILITY_VERSION);
    // version 高于旧版 App 时由 compatibilityVersion 兜底；两者都不能超过当前 App 版本
    assert.ok((doc.version ?? 0) <= APP_VERSION);
    assert.ok((doc.compatibilityVersion ?? 0) <= APP_VERSION);
    for (const category of doc.categories ?? []) {
      assert.ok((category.name ?? "").trim() !== "", "分类名不能为空");
      assert.match(category.id ?? "", UUID_RE, "分类 id 必须是 UUID（App 只认 UUID 或整数）");
    }
  });

  it("包含「记一笔」「设提醒」两个快捷方式，指向 /api/quick/*", () => {
    assert.deepEqual(
      shortcuts.map((shortcut) => shortcut.name),
      ["记一笔", "设提醒"],
    );
    const byName = new Map(shortcuts.map((shortcut) => [shortcut.name ?? "", shortcut]));
    const expense = byName.get("记一笔");
    const schedule = byName.get("设提醒");
    assert.ok(expense !== undefined && schedule !== undefined);
    assert.equal(expense.url, "https://life.example.com/api/quick/expenses");
    assert.equal(schedule.url, "https://life.example.com/api/quick/schedules");
    for (const shortcut of shortcuts) {
      assert.equal(shortcut.method, "POST");
      assert.ok(HTTP_METHODS.has(shortcut.method ?? ""), "method 必须是 App 的枚举字面量");
      assert.ok(EXECUTION_TYPES.has(shortcut.executionType ?? ""), "executionType 非法");
      assert.ok(REQUEST_BODY_TYPES.has(shortcut.requestBodyType ?? ""), "requestBodyType 非法");
      assert.equal(shortcut.requestBodyType, "custom_text", "JSON body 必须走 custom_text");
      assert.equal(shortcut.contentType, "application/json", "否则服务端按 text/plain 收不到 JSON");
      assert.equal(shortcut.executionType, "app");
      assert.equal(shortcut.launcherShortcut, true, "要能加到主屏幕");
      assert.equal(typeof shortcut.timeout, "number");
      // 响应处理：成功弹 toast 显示回执 JSON，失败显示 HTTP 状态与错误说明
      const handling = shortcut.responseHandling;
      assert.ok(handling !== undefined, `${shortcut.name} 应显式给出 responseHandling`);
      assert.ok(RESPONSE_UI_TYPES.has(handling.uiType ?? ""), "responseHandling.uiType 非法");
      assert.ok(RESPONSE_OUTPUTS.has(handling.successOutput ?? ""), "successOutput 非法");
      assert.ok(FAILURE_OUTPUTS.has(handling.failureOutput ?? ""), "failureOutput 非法");
    }
  });

  it("header 只放 Authorization Bearer，且值必须是 ASCII 可见字符", () => {
    for (const shortcut of shortcuts) {
      const headers = shortcut.headers ?? [];
      assert.equal(headers.length, 1, `${shortcut.name} 只应该有 Authorization 一个 header`);
      const header = headers[0];
      assert.ok(header !== undefined);
      assert.equal(header.key, "Authorization");
      assert.match(header.key ?? "", /^[\x21-\x7e]+$/, "header 名必须是可见 ASCII");
      const value = header.value ?? "";
      assert.match(
        value,
        ASCII_HEADER_VALUE_RE,
        `${shortcut.name} 的 header 值含非 ASCII 字符：App 的导入校验会直接拒绝整个文件`,
      );
      assert.match(value, /^Bearer \S+$/, "必须是 Bearer 形式");
      assert.ok(
        value.includes("PASTE_YOUR_PROFILE_TOKEN_HERE"),
        "占位符必须显眼，避免用户原样导入后误以为是可用 token",
      );
    }
  });

  it("变量声明合法，且正文/URL 里的占位符都能解析到已声明的变量", () => {
    assert.ok(variables.length > 0, "至少要声明 request_id 与输入变量");
    for (const variable of variables) {
      assert.match(variable.key ?? "", VARIABLE_KEY_RE, `变量 key 非法: ${variable.key}`);
      assert.match(variable.id ?? "", UUID_RE, "变量 id 必须是 UUID");
      assert.ok(VARIABLE_TYPES.has(variable.type ?? ""), `变量类型非法: ${variable.type}`);
    }
    // 占位符必须都有声明（App 里未声明的 {{x}} 会原样发出去，服务端拿到的是字面量）
    for (const shortcut of shortcuts) {
      for (const text of textFields(shortcut)) {
        for (const match of text.matchAll(PLACEHOLDER_RE)) {
          assert.ok(
            variableKeys.has(match[1] ?? ""),
            `${shortcut.name} 用了未声明的变量 {{${match[1]}}}（可用: ${[...variableKeys].join(", ")}）`,
          );
        }
      }
    }
    // 反过来：声明了却没用到的变量会让 App 每次执行都白问一遍
    for (const key of variableKeys) {
      const used = shortcuts.some((shortcut) =>
        textFields(shortcut).some((text) => text.includes(`{{${key}}}`)),
      );
      assert.ok(used, `变量 ${key} 声明了但没被任何快捷方式使用`);
    }
    assert.equal(variables.find((variable) => variable.key === "request_id")?.type, "uuid");
  });

  it("body 模板替换变量后是合法 JSON，且带 request_id 幂等键", () => {
    const samples: Record<string, string> = {
      amount: "20.5",
      title: "交房租",
      request_id: "11111111-1111-4111-8111-111111111111",
    };
    for (const shortcut of shortcuts) {
      const body = (shortcut.bodyContent ?? "").replace(PLACEHOLDER_RE, (_, key: string) => {
        const value = samples[key];
        assert.ok(value !== undefined, `缺少变量 ${key} 的示例值`);
        return value;
      });
      const parsed = JSON.parse(body) as Record<string, unknown>;
      assert.equal(parsed.request_id, samples.request_id, "body 必须带 request_id（服务端幂等键）");
      if (shortcut.name === "记一笔") assert.equal(parsed.amount, "20.5");
      if (shortcut.name === "设提醒") assert.equal(parsed.title, "交房租");
      // 服务端字段名以 /api/quick/* 的入参为准：多余/拼错的键会被忽略，等于没传
      const allowed =
        shortcut.name === "记一笔"
          ? new Set([
              "amount",
              "ledger_id",
              "category",
              "note",
              "spent_on",
              "request_id",
              "profile",
            ])
          : new Set([
              "title",
              "date",
              "time",
              "note",
              "all_day",
              "remind_offsets",
              "request_id",
              "profile",
            ]);
      for (const key of Object.keys(parsed)) {
        assert.ok(allowed.has(key), `${shortcut.name} 的 body 含服务端不认识的键: ${key}`);
      }
    }
  });

  it("配套说明文档存在，且写明必改的两处占位符", () => {
    const readme = readFileSync("docs/http-shortcuts.md", "utf8");
    for (const needle of [
      "Import from File",
      "PASTE_YOUR_PROFILE_TOKEN_HERE",
      "life.example.com",
      "http-shortcuts.json",
    ]) {
      assert.ok(readme.includes(needle), `docs/http-shortcuts.md 应提到 ${needle}`);
    }
  });
});
