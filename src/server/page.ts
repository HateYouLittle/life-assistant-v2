/**
 * 状态看板页面：单文件、零依赖（无 CDN、无构建步骤），CSS/JS 全部内联。
 * 首屏只依赖 /api/status；每张卡片可点击，点开按需拉 /api/expenses 等明细端点。
 * 数据一律由服务端序列化好（含本地时区文本），前端不做时区推算。
 */

const STYLE = `
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

  .card.trend { margin-bottom: 14px; }
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
  .monthnav { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .monthnav button {
    background: transparent; border: 1px solid var(--line); color: var(--dim); border-radius: 8px;
    padding: 4px 10px; font-size: 12px; cursor: pointer;
  }
  .monthnav button:hover { color: var(--fg); border-color: rgba(255,255,255,.2); }
  .monthnav .cur { font-weight: 600; }
  .sel { background: transparent; border: 1px solid var(--line); color: var(--fg); border-radius: 8px; padding: 4px 8px; font-size: 12px; }
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

const SCRIPT = `
  var COLORS = ['#5eead4','#38bdf8','#818cf8','#c084fc','#f472b6'];
  var REST_COLOR = '#475569';
  var token = (${resolveToken.toString()})(location.search, localStorage);
  if (location.search.indexOf('token=') >= 0 && typeof history !== 'undefined' && history.replaceState) {
    // 凭据已落到 localStorage，立刻从地址栏抹掉：否则会留在浏览器历史、Referer 与截图里
    history.replaceState(null, '', location.pathname);
  }
  var drawer = document.getElementById('drawer');
  var scrim = document.getElementById('scrim');
  var drawerBody = document.getElementById('drawer-body');
  var drawerTitle = document.getElementById('drawer-title');
  var drawerSub = document.getElementById('drawer-sub');
  var expMonth = null;
  var current = null;

  function api(path) {
    return fetch(path, token ? { headers: { Authorization: 'Bearer ' + token } } : {}).then(function (r) {
      if (!r.ok) throw new Error(r.status === 401 ? '未授权：在地址栏给本页加上 ?token=<WEB_API_TOKEN> 刷新一次（本页会记住）' : 'HTTP ' + r.status);
      return r.json();
    });
  }
  function el(id) { return document.getElementById(id); }
  function yuan(cents) {
    return '¥' + (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function esc(text) {
    return String(text === null || text === undefined ? '' : text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function mins(sec) {
    var m = Math.floor(sec / 60);
    if (m < 90) return m + ' 分钟';
    var h = Math.floor(m / 60);
    if (h < 36) return h + ' 小时';
    return Math.floor(h / 24) + ' 天';
  }
  function icon(kind) {
    return kind === 'birthday' ? '生日' : kind === 'anniversary' ? '纪念' : '待办';
  }

  /* ── 首屏 ── */
  function render(s) {
    current = s;
    el('date-line').textContent = s.today.label + ' · 已运行 ' + mins(s.uptime_s);
    var alerts = s.notifications.failed + s.notifications.fallback;
    var health = el('health');
    health.className = 'pill' + (alerts > 0 ? ' bad' : s.notifications.queued > 0 ? ' warn' : '');
    health.innerHTML = '<i></i>' + (alerts > 0 ? alerts + ' 项投递异常' : s.notifications.queued > 0 ? s.notifications.queued + ' 项待投递' : '运行正常');
    el('stamp').textContent = s.today.time + ' 更新 · 30s 自动刷新';

    var exp = s.expenses;
    var whole = Math.floor(exp.month_cents / 100).toLocaleString('zh-CN');
    var dec = String(Math.round(exp.month_cents % 100)).padStart(2, '0');
    el('exp-amount').innerHTML = '¥' + whole + '<span class="dec">.' + dec + '</span>';
    var diff = exp.month_cents - exp.prev_month_cents;
    var prevLabel = exp.prev_month.slice(5).replace(/^0/, '');
    el('exp-delta').innerHTML = '上月（' + prevLabel + ' 月）全月 ' + yuan(exp.prev_month_cents) + ' · ' +
      (diff >= 0
        ? '本月已多出 <b>' + yuan(diff) + '</b>'
        : '比上月少 <b class="down">' + yuan(-diff) + '</b>') +
      ' · 共 ' + exp.count + ' 笔';

    var cats = exp.categories || [];
    // 堆叠条只画 Top5 + 其余合并，图例与之严格一一对应（否则条与图例对不上）
    var segs = cats.slice(0, 5).map(function (c, i) {
      return { label: c.category, cents: c.cents, color: COLORS[i] };
    });
    var restCents = cats.slice(5).reduce(function (a, c) { return a + c.cents; }, 0);
    if (restCents > 0) {
      segs.push({ label: '其他 ' + (cats.length - 5) + ' 类', cents: restCents, color: REST_COLOR });
    }
    var monthCents = exp.month_cents || 1;
    el('exp-bar').innerHTML = segs.length
      ? segs.map(function (s) {
          return '<span style="width:' + ((s.cents / monthCents) * 100).toFixed(2) + '%;background:' + s.color + '"></span>';
        }).join('')
      : '<span style="width:100%;background:rgba(255,255,255,.06)"></span>';
    el('exp-legend').innerHTML = segs.map(function (s) {
      return '<div><i style="background:' + s.color + '"></i>' + esc(s.label) + '<b>' + yuan(s.cents) + '</b></div>';
    }).join('') || '<div class="muted">本月还没有记账</div>';

    var day = Number(s.today.date.slice(8, 10));
    var dim = new Date(Number(s.today.date.slice(0, 4)), Number(s.today.date.slice(5, 7)), 0).getDate();
    el('exp-stats').innerHTML =
      '<div class="stat"><div class="n">' + yuan(Math.round(exp.month_cents / Math.max(1, day))) + '</div><div class="l">日均（至今）</div></div>' +
      '<div class="stat"><div class="n">' + (exp.daily || []).length + '</div><div class="l">记账天数</div></div>' +
      '<div class="stat"><div class="n">' + Math.max(0, dim - day) + '</div><div class="l">本月剩余天</div></div>';

    var next = s.schedules.next || [];
    el('sch-count').innerHTML = s.schedules.active + ' <small>项</small>';
    var shown = next.slice(0, 4);
    el('sch-next').innerHTML = shown.length
      ? shown.map(function (n) {
          return '<li><span class="t" title="' + esc(n.title) + '">' + esc(n.title) + '</span>' +
            '<span class="w">' + esc(shortWhen(n.next_local)) + '</span></li>';
        }).join('') +
        (s.schedules.active > shown.length
          ? '<li class="more">还有 ' + (s.schedules.active - shown.length) + ' 项 · 点开看全部 ›</li>'
          : '')
      : '<li class="muted">暂无待触发日程</li>';

    var hol = s.holidays.next;
    el('hol-main').innerHTML = hol ? esc(hol.name) + ' <small>' + hol.days + ' 天</small>' : '暂无数据 <small>—</small>';
    el('hol-sub').textContent = hol
      ? hol.date + ' 起' + (hol.days_until === 0 ? ' · 就是今天' : ' · 还有 ' + hol.days_until + ' 天')
      : '节假日数据未导入';

    el('trend-stats').innerHTML =
      '<div class="stat"><div class="n ' + (s.notifications.queued > 0 ? 'warn' : 'ok') + '">' + s.notifications.queued + '</div><div class="l">待投递</div></div>' +
      '<div class="stat"><div class="n ' + (alerts > 0 ? 'bad' : 'ok') + '">' + alerts + '</div><div class="l">失败 / 兜底</div></div>' +
      '<div class="stat"><div class="n">' + s.notifications.sent_24h + '</div><div class="l">近 24 小时</div></div>';
    el('spark').innerHTML = sparkline(s.notifications.daily || []);
    var daily = s.notifications.daily || [];
    var peak = daily.reduce(function (a, d) { return Math.max(a, d.sent); }, 0);
    el('spark-cap').innerHTML = '<span>近 7 天投递</span><span>峰值 ' + peak + ' 条</span>';
    el('spark-from').textContent = daily.length ? daily[0].label : '';
    el('spark-to').textContent = daily.length ? daily[daily.length - 1].label + ' 今天' : '';

    el('ops').innerHTML =
      row('Profile', s.profiles.join(' · ') || '暂无') +
      row('账本', s.ledgers.total + ' 个活跃' + (s.ledgers.archived ? ' · ' + s.ledgers.archived + ' 个归档' : ' · 无归档')) +
      row('定时简报', '<span class="muted">每天 ' + esc(cronTime(s.daily_brief_cron)) + '</span>') +
      row('天气数据源', s.qweather_configured ? '<span class="ok">QWeather 已配置</span>' : '<span class="warn">QWeather 未配置</span>') +
      (s.holidays.failed.length
        ? row('节假日抓取失败', '<span class="bad">' + s.holidays.failed.map(function (f) { return f.year + ' 年'; }).join('、') + '</span>')
        : '');
  }
  function shortWhen(stamp) {
    return stamp ? stamp.slice(5) : '—';
  }
  function row(label, value) {
    return '<div class="ops-row"><span class="l">' + label + '</span><span class="v">' + value + '</span></div>';
  }
  /* cron 只渲染「分 时」都写死的常见形式（0 7 * * * → 07:00）；其余原样显示，不猜 */
  function cronTime(expr) {
    var raw = String(expr === null || expr === undefined ? '' : expr);
    var parts = raw.trim().split(/\\s+/);
    if (parts.length < 2 || !/^\\d+$/.test(parts[0]) || !/^\\d+$/.test(parts[1])) return raw;
    return ('0' + parts[1]).slice(-2) + ':' + ('0' + parts[0]).slice(-2);
  }
  function sparkline(daily) {
    if (!daily.length) return '';
    var max = Math.max.apply(null, daily.map(function (d) { return d.sent; }).concat([1]));
    var w = 300, h = 58, pad = 6;
    var step = daily.length > 1 ? (w - pad * 2) / (daily.length - 1) : 0;
    var pts = daily.map(function (d, i) {
      return [pad + i * step, h - 5 - (d.sent / max) * (h - 16)];
    });
    var line = pts.map(function (p) { return p[0].toFixed(1) + ',' + p[1].toFixed(1); }).join(' ');
    var area = '0,' + h + ' ' + line + ' ' + w + ',' + h;
    var last = pts[pts.length - 1];
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" style="width:100%;height:100%">' +
      '<defs><linearGradient id="sf" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0%" stop-color="#5eead4" stop-opacity=".38"/><stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>' +
      '</linearGradient></defs>' +
      '<polygon points="' + area + '" fill="url(#sf)"/>' +
      '<polyline points="' + line + '" fill="none" stroke="#5eead4" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      '<circle cx="' + last[0].toFixed(1) + '" cy="' + last[1].toFixed(1) + '" r="3.5" fill="#0a0c11" stroke="#5eead4" stroke-width="2"/>' +
      '</svg>';
  }

  function refresh() {
    return api('/api/status').then(render).catch(function (e) {
      el('date-line').textContent = e.message;
      el('date-line').className = 'date bad';
    });
  }

  /* ── 抽屉 ── */
  function openDrawer(kind, title, renderFn) {
    drawerTitle.textContent = title;
    drawerSub.textContent = '';
    drawerBody.innerHTML = '<div class="spin">加载中…</div>';
    drawer.classList.add('on');
    scrim.classList.add('on');
    drawer.setAttribute('aria-hidden', 'false');
    drawer.dataset.kind = kind;
    renderFn();
  }
  function closeDrawer() {
    drawer.classList.remove('on');
    scrim.classList.remove('on');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.dataset.kind = '';
  }
  function fail(e) {
    drawerBody.innerHTML = '<div class="empty bad">' + esc(e.message) + '</div>';
  }

  function openExpenses(month) {
    openDrawer('expenses', '支出明细', function () {
      api('/api/expenses' + (month ? '?month=' + month : '')).then(function (d) {
        expMonth = d.month;
        drawerSub.textContent = d.count + ' 笔';
        var max = Math.max.apply(null, d.categories.map(function (c) { return c.cents; }).concat([1]));
        var html = '<div class="monthnav">' +
          '<button type="button" data-month="' + shiftMonth(expMonth, -1) + '">‹ 上月</button>' +
          '<span class="cur">' + expMonth + '</span>' +
          '<button type="button" data-month="' + shiftMonth(expMonth, 1) + '">下月 ›</button>' +
          '<span class="muted" style="margin-left:auto">' + yuan(d.total_cents) + '</span></div>';

        html += '<div class="sect"><h3>分类</h3>' +
          (d.categories.length
            ? '<table><tbody>' + d.categories.map(function (c, i) {
                return '<tr><td><i style="display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:8px;background:' +
                  COLORS[i % COLORS.length] + '"></i>' + esc(c.category) + '</td>' +
                  '<td class="num muted">' + c.count + ' 笔</td>' +
                  '<td class="num">' + yuan(c.cents) + '</td>' +
                  '<td class="num muted">' + (c.share * 100).toFixed(1) + '%</td></tr>';
              }).join('') + '</tbody></table>'
            : '<div class="empty">本月没有记账</div>') + '</div>';

        if (d.daily.length) {
          var dmax = Math.max.apply(null, d.daily.map(function (x) { return x.cents; }));
          html += '<div class="sect"><h3>按天</h3><div class="bars">' +
            d.daily.map(function (x) {
              return '<div style="height:' + Math.max(4, (x.cents / dmax) * 100) + '%" title="' + x.date + ' ' + yuan(x.cents) + '"></div>';
            }).join('') + '</div>' +
            '<div class="spark-axis"><span>' + d.daily[0].date.slice(5) + '</span><span>' +
            d.daily[d.daily.length - 1].date.slice(5) + '</span></div>' +
            '<div class="muted" style="font-size:11.5px;margin-top:10px">柱高为该日金额 · ' + d.daily.length + ' 天有记账</div></div>';
        }

        if (d.ledgers.length > 1) {
          html += '<div class="sect"><h3>账本</h3><table><tbody>' + d.ledgers.map(function (l) {
            return '<tr><td>' + esc(l.ledger_name) + '</td><td class="num muted">' + l.count + ' 笔</td><td class="num">' +
              yuan(l.cents) + '</td></tr>';
          }).join('') + '</tbody></table></div>';
        }

        html += '<div class="sect"><h3>逐笔' + (d.entries_total > d.entries.length ? '（最近 ' + d.entries.length + '/' + d.entries_total + '）' : '') + '</h3>' +
          (d.entries.length
            ? '<ul class="rowlist">' + d.entries.map(function (e) {
                return '<li><div class="top"><span class="t">' + esc(e.note || e.category) + '</span>' +
                  '<span style="flex:none">' + yuan(e.amount_cents) + '</span></div>' +
                  '<div class="meta"><span>' + e.spent_on.slice(5) + '</span><span class="chip">' + esc(e.category) + '</span>' +
                  '<span>' + esc(e.ledger_name) + '</span><span>' + esc(e.created_by_profile) + '</span></div></li>';
              }).join('') + '</ul>'
            : '<div class="empty">没有记录</div>') + '</div>';

        drawerBody.innerHTML = html;
        Array.prototype.forEach.call(drawerBody.querySelectorAll('[data-month]'), function (b) {
          b.addEventListener('click', function () { openExpenses(b.getAttribute('data-month')); });
        });
      }).catch(fail);
    });
  }
  function shiftMonth(ym, delta) {
    var y = Number(ym.slice(0, 4)), m = Number(ym.slice(5, 7)) + delta;
    if (m < 1) { m = 12; y -= 1; }
    if (m > 12) { m = 1; y += 1; }
    return y + '-' + String(m).padStart(2, '0');
  }

  function openSchedules() {
    openDrawer('schedules', '日程明细', function () {
      api('/api/schedules').then(function (d) {
        drawerSub.textContent = d.items.length + ' 项';
        if (!d.items.length) { drawerBody.innerHTML = '<div class="empty">没有活跃日程</div>'; return; }
        drawerBody.innerHTML = '<ul class="rowlist">' + d.items.map(function (s) {
          var soon = s.days_until !== null && s.days_until <= 1;
          return '<li><div class="top"><span class="t">' + esc(s.title) + '</span>' +
            '<span class="chip' + (soon ? ' teal' : '') + '">' + icon(s.kind) + '</span></div>' +
            '<div class="meta"><span>' + esc(s.next_local || '未排期') + '</span>' +
            (s.remind_local ? '<span>提醒 ' + esc(s.remind_local) + '</span>' : '') +
            (s.calendar === 'lunar' ? '<span class="chip">农历</span>' : '') +
            (s.all_day ? '<span>全天</span>' : '<span>' + esc(s.time) + '</span>') +
            (s.workday_filter === 'workday' ? '<span>仅工作日</span>' : s.workday_filter === 'holiday' ? '<span>仅节假日</span>' : '') +
            (s.is_deadline ? '<span class="chip">截止</span>' : '') +
            '<span>' + esc(s.profile_id) + '</span></div>' +
            (s.note ? '<div class="meta"><span>' + esc(s.note) + '</span></div>' : '') + '</li>';
        }).join('') + '</ul>';
      }).catch(fail);
    });
  }

  function openDeliveries() {
    openDrawer('deliveries', '投递明细', function () {
      api('/api/deliveries').then(function (d) {
        var c = d.counts;
        drawerSub.textContent = c.sent_24h + ' 条 / 24h';
        var max = Math.max.apply(null, d.daily.map(function (x) { return x.sent; }).concat([1]));
        var html = '<div class="sect"><h3>近 7 天</h3><div class="bars">' +
          d.daily.map(function (x) {
            return '<div style="height:' + Math.max(4, (x.sent / max) * 100) + '%" title="' + x.date + ' ' + x.sent + ' 条">' +
              '<span>' + x.label + '</span></div>';
          }).join('') + '</div><div style="height:16px"></div>' +
          '<table><tbody>' +
          '<tr><td>待投递</td><td class="num ' + (c.queued ? 'warn' : '') + '">' + c.queued + '</td></tr>' +
          '<tr><td>失败</td><td class="num ' + (c.failed ? 'bad' : '') + '">' + c.failed + '</td></tr>' +
          '<tr><td>兜底</td><td class="num ' + (c.fallback ? 'bad' : '') + '">' + c.fallback + '</td></tr>' +
          '</tbody></table></div>';

        html += '<div class="sect"><h3>记录</h3>' + (d.items.length
          ? '<ul class="rowlist">' + d.items.map(function (i) {
              var cls = i.status === 'sent' ? 'green' : i.status === 'failed' ? 'red' : i.status === 'fallback' ? 'amber' : '';
              return '<li><div class="top"><span class="t">' + esc(i.title) + '</span>' +
                '<span class="chip ' + cls + '">' + esc(i.status) + '</span></div>' +
                '<div class="meta"><span>' + esc(i.sent_local || i.created_local) + '</span>' +
                '<span class="chip">' + esc(i.route_name) + '</span>' +
                '<span>' + esc(i.profile_id) + '</span>' +
                (i.attempts ? '<span>尝试 ' + i.attempts + ' 次</span>' : '') +
                '</div>' + (i.last_error ? '<div class="meta bad">' + esc(i.last_error.slice(0, 160)) + '</div>' : '') + '</li>';
            }).join('') + '</ul>'
          : '<div class="empty">没有投递记录</div>') + '</div>';
        drawerBody.innerHTML = html;
      }).catch(fail);
    });
  }

  function openHolidays() {
    openDrawer('holidays', '节假日明细', function () {
      api('/api/holidays').then(function (d) {
        var render = function (year) {
          api('/api/holidays?year=' + year).then(function (h) {
            drawerSub.textContent = h.year + ' 年';
            var html = '<div class="monthnav">' +
              '<select class="sel" id="hol-year">' + h.years.map(function (y) {
                return '<option' + (y === h.year ? ' selected' : '') + '>' + y + '</option>';
              }).join('') + '</select>' +
              '<span class="muted">' + h.days.filter(function (x) { return x.day_type === 'holiday'; }).length + ' 天假期 · ' +
              h.days.filter(function (x) { return x.day_type === 'workday'; }).length + ' 天调休</span></div>';
            if (h.upcoming.length) {
              html += '<div class="sect"><h3>接下来的假期</h3><table><tbody>' + h.upcoming.map(function (u) {
                return '<tr><td>' + esc(u.name) + '</td><td class="muted">' + u.date + '</td>' +
                  '<td class="num">' + (u.days_until === 0 ? '<span class="chip teal">今天</span>' : u.days_until + ' 天后') + '</td></tr>';
              }).join('') + '</tbody></table></div>';
            }
            html += '<div class="sect"><h3>' + h.year + ' 年安排</h3>' + (h.days.length
              ? '<table><thead><tr><th>日期</th><th>星期</th><th>名称</th><th class="num">类型</th></tr></thead><tbody>' +
                h.days.map(function (x) {
                  return '<tr><td>' + x.date.slice(5) + '</td><td class="muted">' + esc(x.weekday) + '</td><td>' + esc(x.name) + '</td>' +
                    '<td class="num">' + (x.day_type === 'holiday' ? '<span class="chip green">休</span>' : '<span class="chip amber">班</span>') + '</td></tr>';
                }).join('') + '</tbody></table>'
              : '<div class="empty">该年份暂无数据</div>') + '</div>';
            drawerBody.innerHTML = html;
            var sel = el('hol-year');
            if (sel) sel.addEventListener('change', function () { render(sel.value); });
          }).catch(fail);
        };
        render(d.year);
      }).catch(fail);
    });
  }

  function openSystem() {
    openDrawer('system', '系统信息', function () {
      api('/api/status').then(function (s) {
        drawerBody.innerHTML = '<div class="sect"><table><tbody>' +
          '<tr><td>名称</td><td class="num">' + esc(s.name) + ' v' + esc(s.version) + '</td></tr>' +
          '<tr><td>运行时长</td><td class="num">' + mins(s.uptime_s) + '</td></tr>' +
          '<tr><td>Profile</td><td class="num">' + esc(s.profiles.join(' · ')) + '</td></tr>' +
          '<tr><td>活跃日程</td><td class="num">' + s.schedules.active + '</td></tr>' +
          '<tr><td>账本</td><td class="num">' + s.ledgers.total + ' 活跃 / ' + s.ledgers.archived + ' 归档</td></tr>' +
          '<tr><td>定时简报</td><td class="num">' + esc(s.daily_brief_cron) + '</td></tr>' +
          '<tr><td>天气数据源</td><td class="num">' + (s.qweather_configured ? '已配置' : '未配置') + '</td></tr>' +
          '<tr><td>节假日年份</td><td class="num">' + (s.holidays.years.join('、') || '无') + '</td></tr>' +
          '</tbody></table></div>' +
          '<div class="sect"><h3>原始状态</h3><div class="muted" style="font-size:11.5px">' +
          'GET <a href="/api/status" style="color:inherit">/api/status</a> · ' +
          'GET <a href="/api/expenses" style="color:inherit">/api/expenses</a> · ' +
          'GET <a href="/api/schedules" style="color:inherit">/api/schedules</a> · ' +
          'GET <a href="/api/deliveries" style="color:inherit">/api/deliveries</a> · ' +
          'GET <a href="/api/holidays" style="color:inherit">/api/holidays</a></div></div>';
      }).catch(fail);
    });
  }

  var HANDLERS = {
    expenses: function () { openExpenses(null); },
    schedules: openSchedules,
    deliveries: openDeliveries,
    holidays: openHolidays,
    system: openSystem
  };
  var TITLES = { expenses: '支出明细', schedules: '日程明细', deliveries: '投递明细', holidays: '节假日明细', system: '系统信息' };

  document.addEventListener('click', function (ev) {
    var target = ev.target.closest('[data-drawer]');
    if (target) {
      var kind = target.getAttribute('data-drawer');
      if (HANDLERS[kind]) { HANDLERS[kind](); }
      return;
    }
    if (ev.target === scrim || ev.target.closest('#drawer-close')) closeDrawer();
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') closeDrawer();
  });

  refresh();
  setInterval(function () {
    refresh();
    var kind = drawer.dataset.kind;
    if (kind && kind !== 'expenses' && HANDLERS[kind]) HANDLERS[kind]();
    if (kind === 'expenses' && expMonth) openExpenses(expMonth);
  }, 30000);
`;

export function statusPage(version: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark" />
<title>Life Assistant v${version}</title>
<style>${STYLE}</style>
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
<script>${SCRIPT}</script>
</body>
</html>`;
}
