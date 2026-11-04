import { readFileSync } from "node:fs";
import { UNSET_BUDGET_SUGGESTION } from "./budget.js";

/**
 * 状态看板页面的内联 CSS/JS（从 page.ts 逐字搬出，字符串内容零改动）。
 *
 * 这些内容最终以内联 `<style>`/`<script>` 注入浏览器，tsc/biome 看不见字符串内部：
 * 拆成独立模块后，tests/status-page-script-syntax.test.ts 用 `node --check` 校验语法。
 *
 * `resolveToken` 放在本文件而不是 page.ts：SCRIPT 用 `resolveToken.toString()` 内联它的
 * 函数体文本，同文件可避免 page.ts ↔ page-script.ts 的循环 import（函数体仍是逐字内联）。
 * SCRIPT 里还内联了 `UNSET_BUDGET_SUGGESTION`（JSON 序列化），因此这里 import budget.ts。
 */

export const STYLE = `
  :root {
    --bg: #0a0c11;
    --card: rgba(255,255,255,.028);
    --card-hi: rgba(255,255,255,.055);
    --line: rgba(255,255,255,.075);
    --line-soft: rgba(255,255,255,.045);
    --fg: #e9eef6;
    --dim: #8e99a8;
    --mute: #5b6575;
    --teal: #5eead4;
    --sky: #7dd3fc;
    --green: #4ade80;
    --amber: #fbbf24;
    --red: #f87171;
    --r: 16px;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 30px 20px 64px; min-height: 100vh;
    background:
      radial-gradient(820px 460px at 8% -12%, rgba(94,234,212,.075), transparent 62%),
      radial-gradient(680px 380px at 100% -6%, rgba(125,211,252,.055), transparent 58%),
      var(--bg);
    color: var(--fg);
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB",
      "Microsoft YaHei", system-ui, sans-serif;
    font-variant-numeric: tabular-nums;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 1080px; margin: 0 auto; }

  /* ── header ── */
  .head { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .brand { display: flex; align-items: center; gap: 13px; }
  .mark {
    width: 40px; height: 40px; border-radius: 12px; flex: none; display: grid; place-items: center;
    font-size: 15px; font-weight: 700; color: #04231f;
    background: linear-gradient(140deg, #5eead4, #38bdf8);
    box-shadow: 0 6px 20px -8px rgba(94,234,212,.55);
  }
  h1 { margin: 0; font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
  h1 .ver { color: var(--mute); font-weight: 500; font-size: 13px; margin-left: 4px; }
  .date { color: var(--dim); font-size: 12.5px; margin-top: 2px; }
  .head-right { display: flex; align-items: center; gap: 12px; }
  .pill {
    display: inline-flex; align-items: center; gap: 7px; padding: 6px 12px; border-radius: 999px;
    font-size: 12.5px; background: rgba(74,222,128,.08); border: 1px solid rgba(74,222,128,.22); color: #86efac;
  }
  .pill.warn { background: rgba(251,191,36,.08); border-color: rgba(251,191,36,.25); color: #fcd34d; }
  .pill.bad { background: rgba(248,113,113,.1); border-color: rgba(248,113,113,.28); color: #fca5a5; }
  .pill.info { background: rgba(125,211,252,.08); border-color: rgba(125,211,252,.25); color: #7dd3fc; }
  /* 身份 chip 在首屏数据回来前是空的：不占位避免先闪一个空胶囊（拿到 /api/status 后再显示） */
  #identity-chip:empty { display: none; }
  .pill i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; box-shadow: 0 0 0 3px rgba(255,255,255,.06); }
  .stamp { color: var(--mute); font-size: 12px; }

  /* ── cards ── */
  .card {
    position: relative; background: var(--card); border: 1px solid var(--line);
    border-radius: var(--r); padding: 20px 22px; transition: border-color .16s, background .16s, transform .16s;
  }
  .clickable { cursor: pointer; }
  .clickable:hover { border-color: rgba(255,255,255,.16); background: var(--card-hi); }
  .clickable:active { transform: translateY(1px); }
  .clickable:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; }
  .chev { margin-left: auto; color: var(--mute); font-size: 11.5px; letter-spacing: .02em; }
  .clickable:hover .chev { color: var(--teal); }
  .card-k { color: var(--dim); font-size: 12.5px; display: flex; align-items: center; gap: 8px; }
  .tag { color: var(--mute); font-size: 11px; border: 1px solid var(--line); border-radius: 6px; padding: 1px 6px; }

  .hero-group { display: grid; grid-template-columns: 1.32fr 1fr; gap: 14px; margin-bottom: 14px; }
  .side { display: grid; grid-template-rows: 1fr 1fr; gap: 14px; }
  .side .card { display: flex; flex-direction: column; justify-content: center; }

  .amount { font-size: clamp(36px, 5.2vw, 48px); font-weight: 600; letter-spacing: -.025em; line-height: 1.1; margin: 14px 0 6px; }
  .amount .dec { font-size: .55em; color: var(--dim); font-weight: 500; letter-spacing: 0; }
  .delta { font-size: 12.5px; color: var(--dim); }
  .delta b { color: var(--amber); font-weight: 600; }
  .delta .down { color: var(--green); }
  .bar { display: flex; height: 8px; border-radius: 99px; overflow: hidden; margin: 18px 0 14px; background: rgba(255,255,255,.05); gap: 2px; }
  .bar span { height: 100%; display: block; }
  .legend { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 18px; font-size: 12.5px; }
  .legend div { display: flex; align-items: center; gap: 8px; color: var(--dim); min-width: 0; }
  .legend i { width: 7px; height: 7px; border-radius: 2px; flex: none; }
  .legend b { margin-left: auto; color: var(--fg); font-weight: 500; }

  .big { font-size: 28px; font-weight: 600; letter-spacing: -.02em; margin: 10px 0 4px; line-height: 1.15; }
  .big small { font-size: 13px; color: var(--dim); font-weight: 500; margin-left: 6px; letter-spacing: 0; }
  .tiny { font-size: 12.5px; color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mini { list-style: none; margin: 10px 0 0; padding: 0; font-size: 12.5px; }
  .mini li { display: flex; align-items: center; gap: 8px; padding: 5px 0; border-top: 1px solid var(--line-soft); }
  .mini li:first-child { border-top: 0; }
  .mini .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mini .w { color: var(--dim); flex: none; }
  .mini .d { color: var(--teal); flex: none; font-size: 12px; }
  .mini li.more { color: var(--mute); font-size: 12px; }

  .card.trend, .card.jobs { margin-bottom: 14px; }
  .card.jobs .tiny { margin-top: 10px; }
  .trend-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; flex-wrap: wrap; }
  .stats { display: flex; gap: 26px; margin-top: 12px; }
  .stat .n { font-size: 22px; font-weight: 600; letter-spacing: -.02em; line-height: 1.2; }
  .stat .l { font-size: 12px; color: var(--mute); margin-top: 2px; }
  .spark { width: 100%; height: 62px; }
  .sparkwrap { flex: 1 1 240px; max-width: 360px; min-width: 190px; }
  .spark-cap { display: flex; justify-content: space-between; align-items: baseline; font-size: 11.5px; color: var(--mute); margin-bottom: 8px; }
  .spark-axis { display: flex; justify-content: space-between; font-size: 10.5px; color: var(--mute); margin-top: 5px; }
  .hero-stats { display: flex; gap: 26px; margin-top: 16px; padding-top: 13px; border-top: 1px solid var(--line-soft); }
  .ok { color: var(--green); }
  .warn { color: var(--amber); }
  .bad { color: var(--red); }

  .ops { padding: 6px 0; margin-top: 14px; }
  .ops-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 22px; border-top: 1px solid var(--line-soft); }
  .ops-row:first-child { border-top: 0; }
  .ops-row .l { color: var(--dim); font-size: 12.5px; }
  .ops-row .v { font-size: 13px; }
  .muted { color: var(--mute); }

  /* ── 预算 ── */
  .card.budget { margin-bottom: 14px; }
  .bud-item { padding: 12px 0; border-top: 1px solid var(--line-soft); }
  .bud-item:first-child { border-top: 0; padding-top: 4px; }
  .bud-item:last-child { padding-bottom: 2px; }
  .bud-head { display: flex; align-items: baseline; gap: 10px; }
  .bud-head .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .bud-head .amt { flex: none; color: var(--dim); font-size: 12.5px; }
  .prog { height: 6px; border-radius: 99px; background: rgba(255,255,255,.06); overflow: hidden; margin: 8px 0 6px; }
  .prog span { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, rgba(94,234,212,.9), rgba(56,189,248,.7)); }
  .prog.warn span { background: linear-gradient(90deg, rgba(251,191,36,.9), rgba(251,191,36,.5)); }
  .prog.over span { background: linear-gradient(90deg, rgba(248,113,113,.95), rgba(248,113,113,.55)); }
  .bud-tip { font-size: 12px; color: var(--dim); margin-top: 5px; }
  .bud-tip.warn { color: var(--amber); }
  .bud-tip.bad { color: var(--red); }
  .bud-cats { list-style: none; margin: 9px 0 0; padding: 0; font-size: 12px; }
  .bud-cats li { display: flex; align-items: center; gap: 8px; padding: 4px 0; color: var(--dim); }
  .bud-cats .c { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bud-cats .c em { font-style: normal; font-size: 11px; margin-left: 6px; }
  .bud-cats .p { flex: none; width: 84px; }
  .bud-cats .p span { display: block; height: 4px; border-radius: 99px; background: rgba(255,255,255,.07); overflow: hidden; }
  .bud-cats .p i { display: block; height: 100%; border-radius: 99px; background: var(--teal); }
  .bud-cats .p i.warn { background: var(--amber); }
  .bud-cats .p i.over { background: var(--red); }
  .bud-cats .a { flex: none; color: var(--mute); font-size: 11.5px; }
  .bud-cats li.more { color: var(--mute); font-size: 11.5px; }

  /* ── drawer ── */
  .scrim {
    position: fixed; inset: 0; background: rgba(4,6,10,.62); opacity: 0; pointer-events: none;
    transition: opacity .2s; backdrop-filter: blur(2px); z-index: 40;
  }
  .scrim.on { opacity: 1; pointer-events: auto; }
  .drawer {
    position: fixed; top: 0; right: 0; height: 100%; width: min(460px, 92vw);
    background: #0d1017; border-left: 1px solid var(--line); z-index: 50;
    transform: translateX(102%); transition: transform .24s cubic-bezier(.22,.61,.36,1);
    display: flex; flex-direction: column; box-shadow: -24px 0 60px -30px rgba(0,0,0,.8);
  }
  .drawer.on { transform: none; }
  .drawer-head {
    display: flex; align-items: center; gap: 12px; padding: 18px 20px 14px;
    border-bottom: 1px solid var(--line-soft); flex: none;
  }
  .drawer-head h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .drawer-head .sub { color: var(--mute); font-size: 12px; margin-left: auto; }
  .close {
    flex: none; width: 30px; height: 30px; border-radius: 9px; border: 1px solid var(--line);
    background: transparent; color: var(--dim); font-size: 17px; line-height: 1; cursor: pointer;
  }
  .close:hover { color: var(--fg); border-color: rgba(255,255,255,.2); }
  .drawer-body { padding: 18px 20px calc(40px + env(safe-area-inset-bottom, 0px)); overflow-y: auto; }

  .sect { margin-bottom: 22px; }
  .sect h3 { margin: 0 0 10px; font-size: 12px; font-weight: 600; color: var(--dim); letter-spacing: .04em; text-transform: uppercase; }
  table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
  th { text-align: left; color: var(--mute); font-weight: 500; font-size: 11.5px; padding: 0 0 6px; border-bottom: 1px solid var(--line); }
  td { padding: 7px 0; border-bottom: 1px solid var(--line-soft); vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  .rowlist { list-style: none; margin: 0; padding: 0; }
  .rowlist li { padding: 9px 0; border-bottom: 1px solid var(--line-soft); font-size: 12.5px; }
  .rowlist li:last-child { border-bottom: 0; }
  .rowlist .top { display: flex; align-items: baseline; gap: 8px; }
  .rowlist .top .t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rowlist .meta { color: var(--mute); font-size: 11.5px; margin-top: 3px; display: flex; gap: 10px; flex-wrap: wrap; }
  .chip { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--line); color: var(--dim); }
  .chip.teal { border-color: rgba(94,234,212,.28); color: var(--teal); }
  .chip.amber { border-color: rgba(251,191,36,.3); color: var(--amber); }
  .chip.red { border-color: rgba(248,113,113,.3); color: var(--red); }
  .chip.green { border-color: rgba(74,222,128,.28); color: var(--green); }
  .empty { color: var(--mute); font-size: 12.5px; padding: 10px 0; }
  .bars { display: flex; align-items: flex-end; gap: 6px; height: 72px; margin: 6px 0 4px; }
  .bars div { flex: 1; background: linear-gradient(180deg, rgba(94,234,212,.85), rgba(94,234,212,.15)); border-radius: 4px 4px 2px 2px; min-height: 3px; position: relative; }
  .bars div span { position: absolute; bottom: -18px; left: 0; right: 0; text-align: center; color: var(--mute); font-size: 10px; }
  /* flex-wrap：导出按钮让月份导航多一项，窄屏（抽屉 92vw）下不能横向溢出 */
  .monthnav { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
  .monthnav button {
    background: transparent; border: 1px solid var(--line); color: var(--dim); border-radius: 8px;
    padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .monthnav button:hover { color: var(--fg); border-color: rgba(255,255,255,.2); }
  .monthnav .cur { font-weight: 600; }
  .sel { background: transparent; border: 1px solid var(--line); color: var(--fg); border-radius: 8px; padding: 4px 8px; font-size: 12px; }
  /* 「加载更多」：横贯抽屉底部的一行按钮；已全部加载时保持占位（不跳版） */
  .morebtn {
    display: block; width: 100%; margin-top: 10px; padding: 8px 10px; border-radius: 9px;
    background: transparent; border: 1px solid var(--line); color: var(--dim);
    font-size: 12.5px; cursor: pointer;
  }
  .morebtn:hover:not(:disabled) { color: var(--fg); border-color: rgba(255,255,255,.2); }
  .morebtn:disabled { color: var(--mute); cursor: default; opacity: .7; }
  .spin { color: var(--mute); font-size: 12.5px; padding: 8px 0; }

  @media (max-width: 820px) {
    .hero-group { grid-template-columns: 1fr; }
    .side { grid-template-rows: none; grid-template-columns: 1fr 1fr; }
    .legend { grid-template-columns: 1fr; }
  }
  @media (max-width: 620px) {
    body { padding: 20px 14px 48px; }
    .side { grid-template-columns: 1fr; }
    .stats { gap: 18px; }
    .spark { width: 100%; }
    .drawer {
      top: auto; bottom: 0; right: 0; left: 0; width: auto; height: 84vh;
      border-left: 0; border-top: 1px solid var(--line); border-radius: 18px 18px 0 0;
      transform: translateY(102%);
    }
    .drawer.on { transform: none; }
  }
`;

/**
 * 页面凭据引导：`?token=` 取到的 token 落 localStorage 后复用，后续 fetch 只走
 * Authorization 头（凭据不再出现在每次请求的 URL 里）。
 *
 * 该函数会被 toString 内联进浏览器脚本，因此必须保持纯 JS 语法、不引用任何外部符号；
 * 单独导出是为了能直接单测 —— 字符串层面的「页面里有没有这行代码」断言证明不了行为。
 */
export function resolveToken(
  search: string,
  store: { getItem(key: string): string | null; setItem(key: string, value: string): void },
): string | null {
  const fromUrl = new URLSearchParams(search).get("token");
  if (fromUrl !== null && fromUrl !== "") {
    try {
      store.setItem("web_api_token", fromUrl);
    } catch {
      // 隐私模式下 storage 可能不可写；本次仍用 URL 里的凭据，不影响使用
    }
    return fromUrl;
  }
  try {
    return store.getItem("web_api_token");
  } catch {
    return null;
  }
}

/** 浏览器端脚本源文件在 assets/ 下（tsc checkJs 与 biome 覆盖）；构建时 cp 到 dist/server/assets/。 */
export const readAsset = (name: string): string =>
  readFileSync(new URL(`./assets/${name}`, import.meta.url), "utf8");

/** 前导：服务端值与 resolveToken 函数体以全局声明注入，status-page.js 直接引用。 */
const prelude = `var BUDGET_UNSET_TIP = ${JSON.stringify(UNSET_BUDGET_SUGGESTION)};
var token = (${resolveToken.toString()})(location.search, localStorage);
`;

export const SCRIPT = prelude + readAsset("shared.js") + readAsset("status-page.js");
