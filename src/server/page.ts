import { SCRIPT, STYLE } from "./page-script.js";

/**
 * 状态看板页面：零构建、零外链（无 CDN、无构建步骤），CSS/JS 全部内联。
 * 内联的 CSS/JS 字符串本体在 page-script.ts（逐字搬出，便于 node --check 校验语法）。
 * 首屏只依赖 /api/status；每张卡片可点击，点开按需拉 /api/expenses 等明细端点。
 * 数据一律由服务端序列化好（含本地时区文本），前端不做时区推算。
 */

/**
 * 页面凭据引导：实现随 SCRIPT 一起搬到 page-script.ts（SCRIPT 用 toString() 内联它的函数体），
 * 这里只是给既有调用方（quick.ts / tests/status.test.ts）转出，保持原 import 路径可用。
 */
export { resolveToken } from "./page-script.js";

export function statusPage(version: string, nonce?: string): string {
  // nonce 由调用方（server/status.ts）每次请求生成，配合 CSP 的 script-src 'nonce-…'：
  // 即使有人往库里塞了 <img onerror=…>，注入的内联事件处理器也会被浏览器拒绝执行。
  const nonceAttr = nonce === undefined ? "" : ` nonce="${nonce}"`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Life Assistant v${version}</title>
<style${nonceAttr}>${STYLE}</style>
</head>
<body>
<div class="wrap">

  <header class="head">
    <div class="brand">
      <div class="mark">LA</div>
      <div>
        <h1>Life Assistant <span class="ver">v${version}</span></h1>
        <div class="date" id="date-line">加载中…</div>
      </div>
    </div>
    <div class="head-right">
      <span class="pill" id="identity-chip"></span>
      <span class="pill" id="health"><i></i>连接中</span>
      <span class="stamp" id="stamp"></span>
    </div>
  </header>

  <div class="hero-group">
    <section class="card clickable" data-drawer="expenses" tabindex="0" role="button" aria-label="查看支出明细">
      <div class="card-k">本月支出 <span class="chev">明细 ›</span></div>
      <div class="amount" id="exp-amount">—</div>
      <div class="delta" id="exp-delta"></div>
      <div class="bar" id="exp-bar"></div>
      <div class="legend" id="exp-legend"></div>
      <div class="hero-stats" id="exp-stats"></div>
    </section>

    <div class="side">
      <section class="card clickable" data-drawer="schedules" tabindex="0" role="button" aria-label="查看日程明细">
        <div class="card-k">活跃日程 <span class="chev">明细 ›</span></div>
        <div class="big" id="sch-count">—</div>
        <ul class="mini" id="sch-next"></ul>
      </section>
      <section class="card clickable" data-drawer="holidays" tabindex="0" role="button" aria-label="查看节假日明细">
        <div class="card-k">下一个假期 <span class="chev">明细 ›</span></div>
        <div class="big" id="hol-main">—</div>
        <div class="tiny" id="hol-sub"></div>
      </section>
    </div>
  </div>

  <section class="card budget clickable" data-drawer="budget" tabindex="0" role="button" aria-label="查看预算明细">
    <div class="card-k">预算 <span class="chev">明细 ›</span></div>
    <div id="budget-body"><div class="empty">加载中…</div></div>
  </section>

  <section class="card trend clickable" data-drawer="deliveries" tabindex="0" role="button" aria-label="查看投递明细">
    <div class="trend-top">
      <div>
        <div class="card-k">通知投递 <span class="chev">明细 ›</span></div>
        <div class="stats" id="trend-stats"></div>
      </div>
      <div class="sparkwrap">
        <div class="spark-cap" id="spark-cap"></div>
        <div class="spark" id="spark"></div>
        <div class="spark-axis"><span id="spark-from"></span><span id="spark-to"></span></div>
      </div>
    </div>
  </section>

  <section class="card jobs clickable" data-drawer="jobs" tabindex="0" role="button" aria-label="查看定时任务">
    <div class="card-k">定时任务 <span class="chev">明细 ›</span></div>
    <div class="stats" id="job-stats"></div>
    <div class="tiny" id="job-last"></div>
  </section>

  <section class="card ops clickable" data-drawer="system" tabindex="0" role="button" aria-label="查看系统信息">
    <div id="ops"></div>
  </section>

</div>

<aside class="drawer" id="drawer" aria-hidden="true" aria-label="明细面板">
  <header class="drawer-head">
    <h2 id="drawer-title">明细</h2>
    <span class="sub" id="drawer-sub"></span>
    <button type="button" class="close" id="drawer-close" aria-label="关闭">×</button>
  </header>
  <div class="drawer-body" id="drawer-body"></div>
</aside>
<div class="scrim" id="scrim"></div>
<script${nonceAttr}>${SCRIPT}</script>
</body>
</html>`;
}
