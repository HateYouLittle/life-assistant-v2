import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vm from "node:vm";
import { statusPage } from "../src/server/page.js";
import { createStatusApp } from "../src/server/status.js";
import { todayIso } from "../src/time.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * 看板页面脚本的整链路冒烟：把状态页里那段内联 JS 放进 vm 用最小 DOM 桩跑起来，
 * 请求打到真实的 Hono app（含 token 鉴权中间件）上。
 *
 * 起因：配了 WEB_API_TOKEN 时页面拿不到凭据（只读 localStorage、不解析 ?token=），
 * 看板只会反复提示「未授权」——这类「整屏渲染不出来」的回归，字符串断言看不出来，
 * 必须真的把脚本跑一遍。不启真实 socket 是为了不给测试进程留下 keep-alive 句柄。
 */

interface StubElement {
  innerHTML: string;
  textContent: string;
  className: string;
  dataset: Record<string, string>;
  classList: { add(): void; remove(): void };
  setAttribute(): void;
  addEventListener(): void;
  querySelectorAll(): StubElement[];
}

function stubElement(): StubElement {
  return {
    innerHTML: "",
    textContent: "",
    className: "",
    dataset: {},
    classList: { add() {}, remove() {} },
    setAttribute() {},
    addEventListener() {},
    querySelectorAll: () => [],
  };
}

async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return cond();
}

export interface PageRun {
  elements: Map<string, StubElement>;
  authHeaders: (string | undefined)[];
  stored: Map<string, string>;
  replacedUrls: string[];
}

/** 在 vm 里跑一遍真实的状态页脚本；`search` 即浏览器地址栏的查询串 */
export function runPageScript(env: TestEnv, search: string): PageRun {
  const matched = /<script>([\s\S]*)<\/script>/.exec(statusPage("2.0.0"));
  assert.ok(matched?.[1] !== undefined, "状态页应内联一段脚本");
  const app = createStatusApp(env.config, env.db);

  const elements = new Map<string, StubElement>();
  const authHeaders: (string | undefined)[] = [];
  const stored = new Map<string, string>();
  const replacedUrls: string[] = [];
  const sandbox = {
    document: {
      getElementById: (id: string): StubElement => {
        let element = elements.get(id);
        if (element === undefined) {
          element = stubElement();
          elements.set(id, element);
        }
        return element;
      },
      addEventListener() {},
    },
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    },
    location: { search, pathname: "/" },
    history: {
      replaceState: (_state: unknown, _title: unknown, url: string) => {
        replacedUrls.push(url);
      },
    },
    // 自动刷新会一直挂着，冒烟测试里不需要
    setInterval: () => 0,
    console,
    URLSearchParams,
    fetch: (path: string, init?: { headers?: Record<string, string> }) => {
      authHeaders.push(init?.headers?.Authorization);
      return app.fetch(new Request(`http://localhost${path}`, init as RequestInit));
    },
  };
  vm.runInNewContext(matched[1], sandbox);
  return { elements, authHeaders, stored, replacedUrls };
}

function seedExpense(env: TestEnv): void {
  env.db
    .prepare(
      "INSERT INTO ledgers (id, name, created_at) VALUES ('l1','家庭账本','2026-01-01T00:00:00.000Z')",
    )
    .run();
  env.db
    .prepare(
      `INSERT INTO expenses (id, ledger_id, amount_cents, category, spent_on, created_by_profile, created_at)
       VALUES ('e1','l1',1299,'餐饮',?,'default','2026-01-01T00:00:00.000Z')`,
    )
    .run(todayIso());
}

describe("看板页面脚本（vm 桩 + 真实 /api）", () => {
  it("开着 token：?token= 取凭据 → 请求带 Bearer → 渲染出真实数据 → 地址栏抹掉 token", async () => {
    const token = "t".repeat(20);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      seedExpense(env);
      const run = runPageScript(env, `?token=${token}`);
      const rendered = await waitFor(() =>
        (run.elements.get("exp-amount")?.innerHTML ?? "").includes("¥"),
      );
      assert.ok(rendered, "首屏没有渲染出金额，说明脚本在拿数据这一步就断了");

      assert.match(
        run.elements.get("exp-amount")?.innerHTML ?? "",
        /¥12<span class="dec">\.99<\/span>/,
        "金额应来自真实的 /api/status",
      );
      assert.match(run.elements.get("exp-legend")?.innerHTML ?? "", /餐饮/);
      assert.doesNotMatch(
        run.elements.get("date-line")?.textContent ?? "",
        /未授权/,
        "不该出现「未授权」提示",
      );
      assert.ok(
        run.authHeaders.length > 0 &&
          run.authHeaders.every((header) => header === `Bearer ${token}`),
        `每次 /api 调用都必须带上从 URL 得到的凭据，实际 ${JSON.stringify(run.authHeaders)}`,
      );
      assert.equal(run.stored.get("web_api_token"), token, "凭据要落 localStorage 供后续访问复用");
      assert.deepEqual(run.replacedUrls, ["/"], "地址栏里的凭据用完即抹");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未配 token：零配置直接渲染（本地默认路径不能被改坏）", async () => {
    const env = makeTestEnv();
    try {
      seedExpense(env);
      const run = runPageScript(env, "");
      const rendered = await waitFor(() =>
        (run.elements.get("exp-amount")?.innerHTML ?? "").includes("¥"),
      );
      assert.ok(rendered);
      assert.deepEqual(run.authHeaders, [undefined], "无 token 时不该凭空造凭据");
      assert.deepEqual(run.replacedUrls, [], "没有 URL 凭据就无需清理地址栏");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
