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
  /** 锚点下载桩：href 是 Blob objectURL，download 是文件名 */
  href: string;
  download: string;
  clicked: boolean;
  removed: boolean;
  handlers: Record<string, ((ev?: unknown) => void)[]>;
  classList: { add(): void; remove(): void };
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  closest(selector: string): StubElement | null;
  addEventListener(type: string, handler: (ev?: unknown) => void): void;
  querySelectorAll(selector: string): StubElement[];
  click(): void;
  remove(): void;
}

/** 页面脚本通过 querySelectorAll 取到的子控件；抽屉每次重渲染都会重建（runPageScript 清空） */
let renderedControls: StubElement[] = [];

function stubElement(): StubElement {
  const element: StubElement = {
    innerHTML: "",
    textContent: "",
    className: "",
    dataset: {},
    attrs: {},
    href: "",
    download: "",
    clicked: false,
    removed: false,
    handlers: {},
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
    addEventListener(type: string, handler: (ev?: unknown) => void) {
      const handlers = element.handlers[type];
      if (handlers === undefined) element.handlers[type] = [handler];
      else handlers.push(handler);
    },
    // 从 innerHTML 里解析出带 data-* 的控件：这样抽屉渲染路径注册的 click 处理器能被真实触发
    querySelectorAll(selector: string) {
      const match = /^\[data-([a-z-]+)\]$/.exec(selector);
      if (match === null) return [];
      const name = match[1] ?? "";
      const attr = `data-${name}`;
      const found: StubElement[] = [];
      const re = new RegExp(`${attr}="([^"]*)"`, "g");
      for (const hit of element.innerHTML.matchAll(re)) {
        const child = stubElement();
        child.attrs[attr] = hit[1] ?? "";
        child.dataset[name] = hit[1] ?? "";
        found.push(child);
        renderedControls.push(child);
      }
      return found;
    },
    click() {
      element.clicked = true;
    },
    remove() {
      element.removed = true;
    },
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

/**
 * 种入「当年 + 次年」节假日数据，并把当年假日设在今天。
 * 状态页默认展示「还有假期的年份」：当年假日若已全部过完，`holidayDetails` 会顺延到次年。
 * 因此种子必须相对今天生成，写死某一年会让用例随日期漂移（曾经的失败用例正是如此）。
 */
function seedHolidayYears(env: TestEnv, year: number): void {
  env.db
    .prepare(
      "INSERT INTO cn_holiday_years (year, status, source, fetched_at) VALUES (?, 'ready', 'test', '2026-01-01T00:00:00.000Z'), (?, 'ready', 'test', '2026-01-01T00:00:00.000Z')",
    )
    .run(year, year + 1);
  env.db
    .prepare(
      "INSERT INTO cn_holiday_days (date, year, day_type, name, source, updated_at) VALUES (?, ?, 'holiday', '测试节', 'test', '2026-01-01T00:00:00.000Z'), (?, ?, 'holiday', '元旦', 'test', '2026-01-01T00:00:00.000Z')",
    )
    .run(todayIso(), year, `${year + 1}-01-01`, year + 1);
}

export interface PageRun {
  elements: Map<string, StubElement>;
  authHeaders: (string | undefined)[];
  stored: Map<string, string>;
  replacedUrls: string[];
  /** 每次请求的路径与 Authorization（用于断言凭据只走头、不进 URL） */
  fetchCalls: { path: string; auth: string | undefined }[];
  /** 已触发的下载（文件名 + objectURL 指向的 Blob） */
  downloads(): { filename: string; blob: Blob | undefined }[];
  /** revoke 过的 objectURL */
  revokedUrls: string[];
  /** 派发一次点击（等价于点击带 data-drawer 的卡片），会跑真正的抽屉渲染路径 */
  clickDrawer(kind: string): void;
  /** 点击抽屉里某个 data-* 控件（如 data-export），触发页面脚本注册的 click 处理器 */
  clickControl(attr: string, value: string): void;
  /** 手动触发 30s 自动刷新回调（返回触发了几次） */
  runIntervals(): number;
  /** 手动执行 setTimeout 排队项（下载后 revoke objectURL），返回执行条数 */
  runTimeouts(): number;
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
  const fetchCalls: { path: string; auth: string | undefined }[] = [];
  const stored = new Map<string, string>();
  const replacedUrls: string[] = [];
  const objectUrls = new Map<string, Blob>();
  const revokedUrls: string[] = [];
  const anchors: StubElement[] = [];
  const timeouts: (() => void)[] = [];
  renderedControls = [];
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
      // 下载桩：a[download].click() 不真正写文件，只记录调用了什么
      createElement: (): StubElement => {
        const element = stubElement();
        anchors.push(element);
        return element;
      },
      body: {
        appendChild: (child: StubElement): StubElement => child,
        removeChild: (child: StubElement): StubElement => child,
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
    URL: {
      createObjectURL: (blob: Blob): string => {
        const url = `blob:test/${objectUrls.size + 1}`;
        objectUrls.set(url, blob);
        return url;
      },
      revokeObjectURL: (url: string): void => {
        revokedUrls.push(url);
      },
    },
    // 自动刷新会一直挂着：收集回调，由 runIntervals() 在用例里显式触发
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    },
    // 下载后的 revoke 延后一秒：收集回调，由 runTimeouts() 在用例里显式触发
    setTimeout: (fn: () => void) => {
      timeouts.push(fn);
      return timeouts.length;
    },
    console,
    URLSearchParams,
    fetch: (path: string, init?: { headers?: Record<string, string> }) => {
      const auth = init?.headers?.Authorization;
      authHeaders.push(auth);
      fetchCalls.push({ path, auth });
      return app.fetch(new Request(`http://localhost${path}`, init as RequestInit));
    },
  };
  vm.runInNewContext(matched[1], sandbox);
  return {
    elements,
    authHeaders,
    stored,
    replacedUrls,
    fetchCalls,
    revokedUrls,
    downloads() {
      return anchors
        .filter((anchor) => anchor.clicked)
        .map((anchor) => ({ filename: anchor.download, blob: objectUrls.get(anchor.href) }));
    },
    clickDrawer(kind: string) {
      const target = stubElement();
      target.dataset.drawer = kind;
      target.setAttribute("data-drawer", kind);
      for (const handler of clickHandlers) handler({ target });
    },
    clickControl(attr: string, value: string) {
      const control = renderedControls.find(
        (candidate) =>
          candidate.attrs[attr] === value && (candidate.handlers.click?.length ?? 0) > 0,
      );
      if (control === undefined) throw new Error(`没找到 ${attr}=${value} 的可点击控件`);
      for (const handler of control.handlers.click ?? []) handler();
    },
    runIntervals() {
      for (const fn of intervals) fn();
      return intervals.length;
    },
    runTimeouts() {
      const pending = timeouts.splice(0);
      for (const fn of pending) fn();
      return pending.length;
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

  it("节假日抓取失败：状态页同时显示年份与原因（README 承诺「年份与原因」）", async () => {
    const env = makeTestEnv();
    try {
      env.db
        .prepare(
          `INSERT INTO cn_holiday_years (year, status, source, fetched_at, last_attempt_at, last_error)
           VALUES (2027, 'failed', '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 'HTTP 404: not found')`,
        )
        .run();
      const run = runPageScript(env, "");
      const rendered = await waitFor(() =>
        (run.elements.get("ops")?.innerHTML ?? "").includes("节假日抓取失败"),
      );
      assert.ok(rendered, "失败年份应出现在 ops 行");
      const html = run.elements.get("ops")?.innerHTML ?? "";
      assert.match(html, /2027 年/, "显示年份");
      assert.match(html, /HTTP 404: not found/, "同时显示可操作的原因");
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

  it("支出抽屉「导出 CSV」：带 Bearer 取 /api/expenses.csv → Blob 下载 → 延后 revoke", async () => {
    const token = "t".repeat(32);
    const env = makeTestEnv({ WEB_API_TOKEN: token, HOST: "0.0.0.0" });
    try {
      seedExpense(env);
      const run = runPageScript(env, `?token=${token}`);
      run.clickDrawer("expenses");
      const rendered = await waitFor(() =>
        (run.elements.get("drawer-body")?.innerHTML ?? "").includes("导出 CSV"),
      );
      assert.ok(rendered, "支出抽屉应渲染出「导出 CSV」按钮");

      const month = todayIso().slice(0, 7);
      run.clickControl("data-export", month);
      const downloaded = await waitFor(() => run.downloads().length > 0);
      assert.ok(downloaded, "点击导出后应触发 a[download] 下载");
      const [download] = run.downloads();
      assert.ok(download !== undefined, "下载记录缺失");
      assert.equal(download.filename, `expenses-${month}.csv`, "文件名含当前月份");
      assert.ok(download.blob instanceof Blob, "下载内容应是 CSV Blob");
      const bytes = new Uint8Array(await download.blob.arrayBuffer());
      assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "CSV 带 UTF-8 BOM");
      const csvText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
      assert.match(csvText, /日期,账本,分类,金额\(元\),备注,记账人/);
      assert.match(csvText, /12\.99/, "应是真实服务端导出的数据（seedExpense 的 1299 分）");

      const csvCalls = run.fetchCalls.filter((call) => call.path.startsWith("/api/expenses.csv"));
      assert.equal(csvCalls.length, 1, "一次点击只发一次导出请求");
      assert.equal(csvCalls[0]?.auth, `Bearer ${token}`, "导出请求必须带 Bearer 凭据");
      assert.match(csvCalls[0]?.path ?? "", new RegExp(`month=${month}`));
      assert.doesNotMatch(csvCalls[0]?.path ?? "", /token=/, "凭据不得拼进 URL");

      assert.equal(run.runTimeouts(), 1, "下载后应排队一次 revoke");
      assert.match(run.revokedUrls[0] ?? "", /^blob:test\//, "revoke 的应是刚创建的 objectURL");
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
      // 动态年份：当年假日设在今天，保证当年仍有未过假日 → 默认展示当年
      const year = Number(todayIso().slice(0, 4));
      seedHolidayYears(env, year);
      const run = runPageScript(env, "");
      run.clickDrawer("holidays");
      const rendered = await waitFor(() =>
        (run.elements.get("drawer-body")?.innerHTML ?? "").includes("年安排"),
      );
      assert.ok(rendered);
      const html = run.elements.get("drawer-body")?.innerHTML ?? "";
      assert.match(html, new RegExp(`${year} 年安排`), "默认展示当年");
    } finally {
      cleanupTestEnv(env);
    }
  });

  it("30s 自动刷新不把开着的抽屉打回「加载中…」（且保留所选年份）", async () => {
    const env = makeTestEnv();
    try {
      const year = Number(todayIso().slice(0, 4));
      seedHolidayYears(env, year);
      const run = runPageScript(env, "");
      run.clickDrawer("holidays");
      await waitFor(() => (run.elements.get("drawer-body")?.innerHTML ?? "").includes("年安排"));

      assert.equal(run.runIntervals(), 1, "应有且仅有一个 30s 定时器");
      // 刷新走已保存的渲染函数：同步阶段不得把 body 换成加载中
      const html = run.elements.get("drawer-body")?.innerHTML ?? "";
      assert.doesNotMatch(html, /<div class="spin">/, "自动刷新不应把抽屉打回「加载中…」");
      assert.match(html, new RegExp(`${year} 年安排`), "刷新后仍显示所选年份");
    } finally {
      cleanupTestEnv(env);
    }
  });
});
