import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as vm from "node:vm";
import { Hono } from "hono";
import { createQuickApp, quickPage } from "../src/server/quick.js";
import { cleanupTestEnv, makeTestEnv, type TestEnv } from "./helpers.js";

/**
 * /quick 手机页内联脚本的整链路冒烟：把页面里的那段 JS 放进 vm，用最小 DOM 桩跑起来，
 * 请求打到真实的 Hono app（含 token 鉴权与写 API）。
 *
 * 起因与状态页同款：字符串断言证明不了「点一下真的会记账」，而页面脚本一旦在拿
 * bootstrap / 拼请求体这一步断掉，用户看到的就是一个点不动的页面。
 */

interface StubElement {
  innerHTML: string;
  textContent: string;
  className: string;
  value: string;
  hidden: boolean;
  attrs: Record<string, string>;
  handlers: Record<string, ((ev?: unknown) => void)[]>;
  classList: { add(): void; remove(): void };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  addEventListener(type: string, handler: (ev?: unknown) => void): void;
  focus(): void;
}

interface FetchCall {
  path: string;
  auth: string | undefined;
  method: string;
  body: string | undefined;
}

export interface QuickRun {
  elements: Map<string, StubElement>;
  fetchCalls: FetchCall[];
  stored: Map<string, string>;
  replacedUrls: string[];
  /** 派发一次点击（等价于真的点这个控件），ev 用于 chip 这类靠事件委托的控件 */
  click(id: string, ev?: unknown): void;
}

function stubElement(): StubElement {
  const element: StubElement = {
    innerHTML: "",
    textContent: "",
    className: "",
    value: "",
    hidden: false,
    attrs: {},
    handlers: {},
    classList: { add() {}, remove() {} },
    setAttribute(name, value) {
      element.attrs[name] = value;
    },
    getAttribute(name) {
      return element.attrs[name] ?? null;
    },
    addEventListener(type, handler) {
      const list = element.handlers[type];
      if (list === undefined) element.handlers[type] = [handler];
      else list.push(handler);
    },
    focus() {},
  };
  return element;
}

function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      if (cond()) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return cond();
  })();
}

/** 在 vm 里跑一遍真实的 /quick 脚本；`search` 即浏览器地址栏的查询串 */
export function runQuickPage(env: TestEnv, search: string): QuickRun {
  const matched = /<script[^>]*>([\s\S]*)<\/script>/.exec(quickPage());
  assert.ok(matched?.[1] !== undefined, "快捷页应内联一段脚本");
  const app = new Hono().route("/", createQuickApp(env.config, env.db));

  const elements = new Map<string, StubElement>();
  const fetchCalls: FetchCall[] = [];
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
    location: { search, pathname: "/quick" },
    history: {
      replaceState: (_state: unknown, _title: unknown, url: string) => {
        replacedUrls.push(url);
      },
    },
    fetch: (path: string, init?: RequestInit) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      fetchCalls.push({
        path,
        auth,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return app.request(path, init);
    },
    console,
    URLSearchParams,
  };
  vm.runInNewContext(matched[1], sandbox);
  return {
    elements,
    fetchCalls,
    stored,
    replacedUrls,
    click(id, ev) {
      const handlers = elements.get(id)?.handlers.click ?? [];
      assert.ok(handlers.length > 0, `#${id} 没有绑定 click`);
      for (const handler of handlers) handler(ev);
    },
  };
}

function seedFamilyLedger(env: TestEnv): void {
  env.db
    .prepare(
      "INSERT INTO ledgers (id, name, created_at) VALUES ('l1','家庭账本','2026-01-01T00:00:00.000Z')",
    )
    .run();
}

/** 取（必要时先建）某个元素桩：脚本只在用到时才 getElementById，测试要先把它放进 map */
function field(run: QuickRun, id: string): StubElement {
  let element = run.elements.get(id);
  if (element === undefined) {
    element = stubElement();
    run.elements.set(id, element);
  }
  return element;
}

/** chip 桩：事件委托只用到 getAttribute('data-cat') / getAttribute('data-when') */
function chip(attr: string, value: string): { getAttribute(name: string): string | null } {
  return { getAttribute: (name: string) => (name === attr ? value : null) };
}

describe("/quick 页面结构", () => {
  it("渲染出「记一笔 / 设提醒」两个大按钮，且没有任何外链资源（零构建 + CSP）", () => {
    const html = quickPage("test-nonce");
    assert.match(html, /id="btn-expense"[^>]*>记一笔/);
    assert.match(html, /id="btn-schedule"[^>]*>设提醒/);
    assert.match(html, /id="panel-expense"/);
    assert.match(html, /id="panel-schedule"/);
    assert.match(html, /添加到主屏幕/);
    assert.match(html, /nonce="test-nonce"/);
    assert.doesNotMatch(html, /<script[^>]+src=/);
    assert.doesNotMatch(html, /<link[^>]+href="http/);
  });
});

describe("/quick 页面脚本（vm 桩 + 真实 /api）", () => {
  it("?token= 引导：写 localStorage、抹掉地址栏 token，但保留预填参数", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      seedFamilyLedger(env);
      const run = runQuickPage(env, `?token=${token}&type=expense&amount=20&category=餐饮`);
      const rendered = await waitFor(() =>
        (run.elements.get("summary")?.textContent ?? "").includes("本月已花"),
      );
      assert.ok(rendered, `首屏没有渲染出概况：${run.elements.get("summary")?.textContent}`);
      assert.equal(run.stored.get("web_api_token"), token, "凭据要落 localStorage 供后续复用");
      assert.deepEqual(
        run.replacedUrls,
        ["/quick?type=expense&amount=20&category=%E9%A4%90%E9%A5%AE"],
        "地址栏只该抹掉 token，预填参数必须保留（NFC/小布指令靠它）",
      );
      assert.equal(run.elements.get("amount")?.value, "20", "?amount= 应预填金额");
      assert.equal(run.elements.get("category")?.value, "餐饮", "?category= 应预填分类");
      assert.equal(run.elements.get("token-hint")?.hidden, true, "授权成功不该再显示引导");
      assert.equal(run.fetchCalls[0]?.auth, `Bearer ${token}`, "bootstrap 要带 Bearer");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("填金额 + 点分类 chip → POST /api/quick/expenses → toast 回执 + 「再记一笔」", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      seedFamilyLedger(env);
      const run = runQuickPage(env, `?token=${token}`);
      const ready = await waitFor(() =>
        (run.elements.get("summary")?.textContent ?? "").includes("本月已花"),
      );
      assert.ok(ready, "bootstrap 没有返回，后面的事件断言都会失真");

      field(run, "amount").value = "20";
      run.click("cat-chips", { target: chip("data-cat", "餐饮") });
      assert.equal(run.elements.get("category")?.value, "餐饮", "点 chip 应写回分类输入框");

      run.click("submit-expense");
      const done = await waitFor(() =>
        (run.elements.get("toast")?.textContent ?? "").includes("已记账"),
      );
      assert.ok(done, `没有成功回执：${run.elements.get("toast")?.textContent}`);

      const post = run.fetchCalls.find((call) => call.path === "/api/quick/expenses");
      assert.ok(post !== undefined, "没有发出记账请求");
      assert.equal(post.method, "POST");
      assert.equal(post.auth, `Bearer ${token}`, "写请求必须带 Bearer，凭据不进 URL");
      const payload = JSON.parse(post.body ?? "{}") as Record<string, unknown>;
      assert.equal(payload.amount, 20);
      assert.equal(payload.ledger_id, "l1", "唯一可见账本应作为默认账本带上");
      assert.equal(payload.category, "餐饮");
      assert.equal(typeof payload.request_id, "string", "必须带幂等键，网络重试不重复记账");
      assert.ok((payload.request_id as string).length > 0);

      const rows = env.db.prepare("SELECT * FROM expenses").all() as {
        amount_cents: number;
        category: string;
        created_by_profile: string;
      }[];
      assert.equal(rows.length, 1, "页面点击应真的落库一行");
      assert.equal(rows[0]?.amount_cents, 2000);
      assert.equal(rows[0]?.category, "餐饮");
      assert.equal(rows[0]?.created_by_profile, "default");
      assert.equal(run.elements.get("amount")?.value, "", "成功后金额清空，方便再记一笔");
      assert.equal(run.elements.get("again")?.hidden, false, "成功后要给出「再记一笔」");

      run.click("again");
      assert.equal(run.elements.get("again")?.hidden, true);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("非法金额在客户端就被拦下：给提示且不发请求", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      seedFamilyLedger(env);
      const run = runQuickPage(env, `?token=${token}`);
      await waitFor(() => (run.elements.get("summary")?.textContent ?? "").includes("本月已花"));

      field(run, "amount").value = "0";
      run.click("submit-expense");
      assert.match(run.elements.get("toast")?.textContent ?? "", /请输入正确的金额/);
      assert.equal(
        run.fetchCalls.filter((call) => call.path === "/api/quick/expenses").length,
        0,
        "金额不合法不该打服务端",
      );
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("设提醒：标题 + datetime-local → POST /api/quick/schedules（date/time 拆分）", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      const run = runQuickPage(env, `?token=${token}`);
      await waitFor(() => (run.elements.get("summary")?.textContent ?? "").includes("本月已花"));

      field(run, "title").value = "交房租";
      field(run, "when").value = "2026-11-01T09:00";
      run.click("submit-schedule");
      const done = await waitFor(() =>
        (run.elements.get("toast")?.textContent ?? "").includes("已设提醒"),
      );
      assert.ok(done, `没有成功回执：${run.elements.get("toast")?.textContent}`);

      const post = run.fetchCalls.find((call) => call.path === "/api/quick/schedules");
      assert.ok(post !== undefined);
      const payload = JSON.parse(post.body ?? "{}") as Record<string, unknown>;
      assert.equal(payload.title, "交房租");
      assert.equal(payload.date, "2026-11-01");
      assert.equal(payload.time, "09:00");
      assert.equal(typeof payload.request_id, "string");

      const rows = env.db.prepare("SELECT title, start_date, time FROM schedules").all() as {
        title: string;
        start_date: string;
        time: string;
      }[];
      assert.equal(rows.length, 1);
      // node:sqlite 返回 null 原型对象，逐字段比较
      assert.equal(rows[0]?.title, "交房租");
      assert.equal(rows[0]?.start_date, "2026-11-01");
      assert.equal(rows[0]?.time, "09:00");
      assert.match(run.elements.get("toast")?.textContent ?? "", /2026-11-01 09:00/);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("?type=schedule&title=… 直接进提醒面板并预填标题", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      const run = runQuickPage(env, `?token=${token}&type=schedule&title=交房租`);
      assert.equal(run.elements.get("title")?.value, "交房租");
      assert.equal(run.elements.get("panel-schedule")?.hidden, false, "应切到提醒面板");
      assert.equal(run.elements.get("panel-expense")?.hidden, true);
      // 两个大按钮都要能切换面板
      run.click("btn-expense");
      assert.equal(run.elements.get("panel-expense")?.hidden, false);
      run.click("btn-schedule");
      assert.equal(run.elements.get("panel-schedule")?.hidden, false);
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("未带 token：显示 token 引导而不是静默空白", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      const run = runQuickPage(env, "");
      const shown = await waitFor(() => run.elements.get("token-hint")?.hidden === false);
      assert.ok(shown, "401 时应显示 token 引导");
      assert.match(run.elements.get("toast")?.textContent ?? "", /未授权/);
    } finally {
      cleanupTestEnv(env);
    }
  });
});
