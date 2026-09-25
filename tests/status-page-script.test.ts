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
  attrs: Record<string, string>;
  classList: { add(): void; remove(): void };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  closest(selector: string): StubElement | null;
  addEventListener(): void;
  querySelectorAll(): StubElement[];
}

function stubElement(): StubElement {
  const element: StubElement = {
    innerHTML: "",
    textContent: "",
    className: "",
    dataset: {},
    attrs: {},
    classList: { add() {}, remove() {} },
    setAttribute(name: string, value: string) {
      element.attrs[name] = value;
    },
    getAttribute(name: string) {
      return element.attrs[name] ?? null;
    },
    closest(selector: string) {
      return selector === "[data-drawer]" && element.dataset.drawer !== undefined ? element : null;
    },
    addEventListener() {},
    querySelectorAll: () => [],
  };
  return element;
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
  /** 派发一次点击（等价于点击带 data-drawer 的卡片），会跑真正的抽屉渲染路径 */
  clickDrawer(kind: string): void;
  /** 手动触发一次 30s 自动刷新回调（返回触发了几次） */
  runIntervals(): number;
}

/** 在 vm 里跑一遍真实的状态页脚本；`search` 即浏览器地址栏的查询串 */
export function runPageScript(env: TestEnv, search: string): PageRun {
  const matched = /<script[^>]*>([\s\S]*)<\/script>/.exec(statusPage("2.0.0"));
  assert.ok(matched?.[1] !== undefined, "状态页应内联一段脚本");
  const app = createStatusApp(env.config, env.db);

  const clickHandlers: ((ev: unknown) => void)[] = [];
  const intervals: (() => void)[] = [];
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
      addEventListener(type: string, handler: (ev: unknown) => void) {
        if (type === "click") clickHandlers.push(handler);
      },
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
    // 自动刷新会一直挂着：收集回调，由 runIntervals() 在用例里显式触发
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    },
    console,
    URLSearchParams,
    fetch: (path: string, init?: { headers?: Record<string, string> }) => {
      authHeaders.push(init?.headers?.Authorization);
      return app.fetch(new Request(`http://localhost${path}`, init as RequestInit));
    },
  };
  vm.runInNewContext(matched[1], sandbox);
  return {
    elements,
    authHeaders,
    stored,
    replacedUrls,
    clickDrawer(kind: string) {
      const target = stubElement();
      target.dataset.drawer = kind;
      target.setAttribute("data-drawer", kind);
      for (const handler of clickHandlers) handler({ target });
    },
    runIntervals() {
      for (const fn of intervals) fn();
      return intervals.length;
    },
  };
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
    const token = "t".repeat(32);
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

  it("Profile 名里的 HTML 被转义（旧库导入注入路径的回归）", async () => {
    const env = makeTestEnv();
    try {
      // 直接写库以模拟「非法 profile_id 已经落库」的现场：入口校验是第一道防线，
      // 这里守住第二道 —— 无论库里有什么，拼进 innerHTML 前必须转义。
      env.db
        .prepare("INSERT INTO profiles (id, created_at) VALUES (?, ?)")
        .run("<img src=x onerror=alert(1)>", new Date().toISOString());
      const run = runPageScript(env, "");
      const rendered = await waitFor(() =>
        (run.elements.get("ops")?.innerHTML ?? "").includes("Profile"),
      );
      assert.ok(rendered, "ops 行没有渲染出来");
      const html = run.elements.get("ops")?.innerHTML ?? "";
      assert.ok(!html.includes("<img"), `未转义的 Profile 名进了 innerHTML：${html}`);
      assert.match(html, /&lt;img/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});

describe("状态页转义（静态断言）", () => {
  it("首屏 ops 行确实走了 esc（防止有人把转义改回去）", () => {
    assert.match(statusPage("2.0.0"), /row\('Profile', esc\(/);
  });
});

describe("看板抽屉（点击委托 + 明细渲染）", () => {
  it("点击「系统信息」卡片会真的拉 /api/status 并渲染表格", async () => {
    const env = makeTestEnv();
    try {
      seedExpense(env);
      const run = runPageScript(env, "");
      await waitFor(() => (run.elements.get("ops")?.innerHTML ?? "").includes("Profile"));
      run.clickDrawer("system");
      const rendered = await waitFor(() =>
        (run.elements.get("drawer-body")?.innerHTML ?? "").includes("运行时长"),
      );
      assert.ok(rendered, `抽屉没有渲染出内容：${run.elements.get("drawer-body")?.innerHTML}`);
      assert.match(run.elements.get("drawer-body")?.innerHTML ?? "", /Profile/);
      assert.equal(run.elements.get("drawer")?.attrs["aria-hidden"], "false", "抽屉应被打开");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("明细接口 401 时抽屉显示错误提示，而不是空白", async () => {
    const env = makeTestEnv({ WEB_API_TOKEN: "t".repeat(32), HOST: "0.0.0.0" });
    try {
      // 页面没有凭据（地址栏无 token、localStorage 为空）→ 每个 /api 都是 401
      const run = runPageScript(env, "");
      run.clickDrawer("schedules");
      const rendered = await waitFor(() =>
        (run.elements.get("drawer-body")?.innerHTML ?? "").includes("未授权"),
      );
      assert.ok(rendered, `失败路径应显示错误：${run.elements.get("drawer-body")?.innerHTML}`);
      assert.match(run.elements.get("drawer-body")?.innerHTML ?? "", /empty bad/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("节假日抽屉翻年后保留所选年份（30s 自动刷新不再打回当年）", async () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          `INSERT INTO cn_holiday_years (year, status, source, fetched_at) VALUES (2026,'ready','test','2026-01-01T00:00:00.000Z'), (2027,'ready','test','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      env.db
        .prepare(
          `INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES ('2026-10-01',2026,'holiday','国庆节','test','2026-01-01T00:00:00.000Z'), ('2027-01-01',2027,'holiday','元旦','test','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      const run = runPageScript(env, "");
      run.clickDrawer("holidays");
      const rendered = await waitFor(() =>
        (run.elements.get("drawer-body")?.innerHTML ?? "").includes("年安排"),
      );
      assert.ok(rendered);
      const html = run.elements.get("drawer-body")?.innerHTML ?? "";
      assert.match(html, /2026 年安排/, "默认展示当年");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("30s 自动刷新不把开着的抽屉打回「加载中…」（且保留所选年份）", async () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          `INSERT INTO cn_holiday_years (year, status, source, fetched_at) VALUES (2026,'ready','test','2026-01-01T00:00:00.000Z'), (2027,'ready','test','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      env.db
        .prepare(
          `INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES ('2026-10-01',2026,'holiday','国庆节','test','2026-01-01T00:00:00.000Z'), ('2027-01-01',2027,'holiday','元旦','test','2026-01-01T00:00:00.000Z')`,
        )
        .run();
      const run = runPageScript(env, "");
      run.clickDrawer("holidays");
      await waitFor(() => (run.elements.get("drawer-body")?.innerHTML ?? "").includes("年安排"));

      assert.equal(run.runIntervals(), 1, "应有且仅有一个 30s 定时器");
      // 刷新走已保存的渲染函数：同步阶段不得把 body 换成加载中
      const html = run.elements.get("drawer-body")?.innerHTML ?? "";
      assert.doesNotMatch(html, /<div class="spin">/, "自动刷新不应把抽屉打回「加载中…」");
      assert.match(html, /2026 年安排/, "刷新后仍显示所选年份");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
