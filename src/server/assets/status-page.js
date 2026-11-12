var COLORS = ['#5eead4', '#38bdf8', '#818cf8', '#c084fc', '#f472b6'];
var REST_COLOR = '#475569';
if (
  location.search.indexOf('token=') >= 0 &&
  typeof history !== 'undefined' &&
  history.replaceState
) {
  // 凭据已落到 localStorage，立刻从地址栏抹掉：否则会留在浏览器历史、Referer 与截图里
  history.replaceState(null, '', location.pathname);
}
var drawer = document.getElementById('drawer');
var scrim = document.getElementById('scrim');
var drawerBody = document.getElementById('drawer-body');
var drawerTitle = document.getElementById('drawer-title');
var drawerSub = document.getElementById('drawer-sub');
var expMonth = null;
/* 分页累积状态：expEntries/delItems 是「已加载」的行，expTotal/delTotal 是服务端总数 */
var expEntries = [];
var expTotal = 0;
var delItems = [];
var delTotal = 0;
var holYear = null;
var drawerOpen = false;
var drawerRender = null;
var current = null;
/* 未设预算的提示文案 BUDGET_UNSET_TIP 与 src/server/budget.ts 同源（由 page-script.ts 的前导注入） */

function api(path) {
  return fetch(path, token ? { headers: { Authorization: 'Bearer ' + token } } : {}).then((r) => {
    if (!r.ok)
      throw new Error(
        r.status === 401
          ? '未授权：在地址栏给本页加上 ?token=<WEB_API_TOKEN> 刷新一次（本页会记住）'
          : 'HTTP ' + r.status,
      );
    return r.json();
  });
}
/* 备份文件大小：1.2 MB / 820 KB（不足 1 KB 也按 KB 显示，避免出现 0.0 MB） */
function mbText(bytes) {
  var n = Number(bytes);
  if (!isFinite(n) || n < 0) return '—';
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
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
  el('date-line').className = 'date';
  el('date-line').textContent = s.today.label + ' · 已运行 ' + mins(s.uptime_s);
  var alerts = s.notifications.failed + s.notifications.fallback;
  var health = el('health');
  health.className = 'pill' + (alerts > 0 ? ' bad' : s.notifications.queued > 0 ? ' warn' : '');
  health.innerHTML =
    '<i></i>' +
    (alerts > 0
      ? alerts + ' 项投递异常'
      : s.notifications.queued > 0
        ? s.notifications.queued + ' 项待投递'
        : '运行正常');
  el('stamp').textContent = s.today.time + ' 更新 · 30s 自动刷新';

  // 身份 chip：master = 家庭看板（全部 Profile），profile = 个人视图（只有自己的数据）。
  // 身份来自受鉴权保护的 /api/status，静态页 / 本身不含任何身份信息。
  var ident = s.identity || { kind: 'master' };
  var identityChip = el('identity-chip');
  if (identityChip) {
    identityChip.className = 'pill' + (ident.kind === 'profile' ? ' info' : '');
    identityChip.textContent =
      ident.kind === 'profile' ? '个人视图 · ' + ident.profile_id : '家庭看板';
    identityChip.title =
      ident.kind === 'profile'
        ? '只显示该 Profile 的日程/通知，以及家庭 + 自己个人账本的支出'
        : '家庭看板：所有 Profile 的日程/通知 + 家庭账本支出';
  }

  var exp = s.expenses;
  var whole = Math.floor(exp.month_cents / 100).toLocaleString('zh-CN');
  var dec = String(Math.round(exp.month_cents % 100)).padStart(2, '0');
  el('exp-amount').innerHTML = '¥' + whole + '<span class="dec">.' + dec + '</span>';
  var diff = exp.month_cents - exp.prev_month_cents;
  var prevLabel = exp.prev_month.slice(5).replace(/^0/, '');
  el('exp-delta').innerHTML =
    '上月（' +
    prevLabel +
    ' 月）全月 ' +
    yuan(exp.prev_month_cents) +
    ' · ' +
    (diff >= 0
      ? '本月已多出 <b>' + yuan(diff) + '</b>'
      : '比上月少 <b class="down">' + yuan(-diff) + '</b>') +
    ' · 共 ' +
    exp.count +
    ' 笔';

  var cats = exp.categories || [];
  // 堆叠条只画 Top5 + 其余合并，图例与之严格一一对应（否则条与图例对不上）
  var segs = cats
    .slice(0, 5)
    .map((c, i) => ({ label: c.category, cents: c.cents, color: COLORS[i] }));
  var restCents = cats.slice(5).reduce((a, c) => a + c.cents, 0);
  if (restCents > 0) {
    segs.push({ label: '其他 ' + (cats.length - 5) + ' 类', cents: restCents, color: REST_COLOR });
  }
  var monthCents = exp.month_cents || 1;
  el('exp-bar').innerHTML = segs.length
    ? segs
        .map(
          (s) =>
            '<span style="width:' +
            ((s.cents / monthCents) * 100).toFixed(2) +
            '%;background:' +
            s.color +
            '"></span>',
        )
        .join('')
    : '<span style="width:100%;background:rgba(255,255,255,.06)"></span>';
  el('exp-legend').innerHTML =
    segs
      .map(
        (s) =>
          '<div><i style="background:' +
          s.color +
          '"></i>' +
          esc(s.label) +
          '<b>' +
          yuan(s.cents) +
          '</b></div>',
      )
      .join('') || '<div class="muted">本月还没有记账</div>';

  var day = Number(s.today.date.slice(8, 10));
  var dim = new Date(
    Number(s.today.date.slice(0, 4)),
    Number(s.today.date.slice(5, 7)),
    0,
  ).getDate();
  // 「日均（至今）」必须只除到今天：本月合计按自然月全月含未来记账，
  // 直接用 month_cents / 日号会把提前录入的月末支出摊进「至今」。
  var spentToDate = (exp.daily || []).reduce(
    (a, d) => (d.date <= s.today.date ? a + d.cents : a),
    0,
  );
  el('exp-stats').innerHTML =
    '<div class="stat"><div class="n">' +
    yuan(Math.round(spentToDate / Math.max(1, day))) +
    '</div><div class="l">日均（至今）</div></div>' +
    '<div class="stat"><div class="n">' +
    (exp.daily || []).length +
    '</div><div class="l">记账天数</div></div>' +
    '<div class="stat"><div class="n">' +
    Math.max(0, dim - day) +
    '</div><div class="l">本月剩余天</div></div>';

  // 预算：ratio/pace/建议都由服务端算好（budgetPayload），前端只做展示，避免浏览器重算口径
  renderBudget(s.budget);

  var next = s.schedules.next || [];
  el('sch-count').innerHTML = s.schedules.active + ' <small>项</small>';
  var shown = next.slice(0, 4);
  el('sch-next').innerHTML = shown.length
    ? shown
        .map(
          (n) =>
            '<li><span class="t" title="' +
            esc(n.title) +
            '">' +
            esc(n.title) +
            '</span>' +
            '<span class="w">' +
            esc(shortWhen(n.next_local)) +
            '</span></li>',
        )
        .join('') +
      (s.schedules.active > shown.length
        ? '<li class="more">还有 ' + (s.schedules.active - shown.length) + ' 项 · 点开看全部 ›</li>'
        : '')
    : '<li class="muted">暂无待触发日程</li>';

  var hol = s.holidays.next;
  el('hol-main').innerHTML = hol
    ? esc(hol.name) + ' <small>' + hol.days + ' 天</small>'
    : '暂无数据 <small>—</small>';
  el('hol-sub').textContent = hol
    ? hol.in_progress
      ? '进行中 · ' + hol.date + '–' + hol.end + '，共 ' + hol.days + ' 天'
      : hol.date +
        ' 起' +
        (hol.days_until === 0 ? ' · 就是今天' : ' · 还有 ' + hol.days_until + ' 天')
    : '节假日数据未导入';

  el('trend-stats').innerHTML =
    '<div class="stat"><div class="n ' +
    (s.notifications.queued > 0 ? 'warn' : 'ok') +
    '">' +
    s.notifications.queued +
    '</div><div class="l">待投递</div></div>' +
    '<div class="stat"><div class="n ' +
    (alerts > 0 ? 'bad' : 'ok') +
    '">' +
    alerts +
    '</div><div class="l">失败 / 兜底</div></div>' +
    '<div class="stat"><div class="n">' +
    s.notifications.sent_24h +
    '</div><div class="l">近 24 小时</div></div>';
  el('spark').innerHTML = sparkline(s.notifications.daily || []);
  var daily = s.notifications.daily || [];
  var peak = daily.reduce((a, d) => Math.max(a, d.sent), 0);
  el('spark-cap').innerHTML = '<span>近 7 天投递</span><span>峰值 ' + peak + ' 条</span>';
  el('spark-from').textContent = daily.length ? daily[0].label : '';
  el('spark-to').textContent = daily.length ? daily[daily.length - 1].label + ' 今天' : '';

  // 定时任务：概览只回答「有没有任务在失败、最近一次跑在什么时候」，
  // 逐个任务的最近运行放进抽屉（点开才拉 /api/jobs）。
  var jobInfo = s.jobs || { total: 0, failed_24h: 0, runs: [] };
  var jobRuns = jobInfo.runs || [];
  el('job-stats').innerHTML =
    '<div class="stat"><div class="n">' +
    jobInfo.total +
    '</div><div class="l">定时任务</div></div>' +
    '<div class="stat"><div class="n ' +
    (jobInfo.failed_24h > 0 ? 'bad' : 'ok') +
    '">' +
    jobInfo.failed_24h +
    '</div><div class="l">24 小时失败</div></div>';
  /** @type {any} */
  var latestJob = null;
  jobRuns.forEach((j) => {
    if (j.last_run && (latestJob === null || j.last_run.started_at > latestJob.started_at))
      latestJob = j.last_run;
  });
  el('job-last').innerHTML = latestJob
    ? '最近运行 ' +
      jobChip(latestJob.status) +
      ' · ' +
      esc(stampShort(latestJob.started_at)) +
      (latestJob.error
        ? ' · <span class="bad">' + esc(String(latestJob.error).slice(0, 80)) + '</span>'
        : '')
    : '<span class="muted">还没有运行记录</span>';

  // 备份：最近一份 + 旁车可信状态（trusted/untrusted/missing 三态）。
  // 只读旁车、零开库，所以这里显示的是「备份成功时自校验的声明」，不是现场校验结果。
  var bk = s.backup || null;
  if (bk === null) {
    el('backup-stats').innerHTML =
      '<div class="stat"><div class="n muted">—</div><div class="l">暂无备份</div></div>';
    el('backup-last').textContent = '备份目录不可读';
  } else {
    var bkTrust = {
      trusted: ['ok', '可信'],
      untrusted: ['bad', '不可信'],
      missing: ['warn', '无校验标记'],
    }[bk.sidecar] || ['warn', '未知'];
    var bkAge =
      bk.age_hours === null
        ? '—'
        : bk.age_hours < 1
          ? '刚刚'
          : Math.round(bk.age_hours) + ' 小时前';
    el('backup-stats').innerHTML =
      '<div class="stat"><div class="n ' +
      (bk.stale ? 'warn' : 'ok') +
      '">' +
      bk.count +
      '</div><div class="l">份备份</div></div>' +
      '<div class="stat"><div class="n ' +
      bkTrust[0] +
      '">' +
      esc(bkTrust[1]) +
      '</div><div class="l">最新校验</div></div>' +
      '<div class="stat"><div class="n' +
      (bk.stale ? ' bad' : '') +
      '">' +
      esc(bkAge) +
      '</div><div class="l">最新一份</div></div>';
    el('backup-last').innerHTML = bk.latest
      ? esc(String(bk.latest.name || '')) +
        ' · ' +
        esc(mbText(bk.latest.sizeBytes)) +
        (bk.non_canonical > 0
          ? ' · <span class="warn">' + bk.non_canonical + ' 个非规范文件</span>'
          : '')
      : '<span class="muted">还没有备份</span>';
  }

  el('ops').innerHTML =
    row('Profile', esc(s.profiles.join(' · ') || '暂无')) +
    row(
      '账本',
      s.ledgers.total +
        ' 个活跃' +
        (s.ledgers.archived ? ' · ' + s.ledgers.archived + ' 个归档' : ' · 无归档'),
    ) +
    row('定时简报', '<span class="muted">' + esc(cronLabel(s.daily_brief_cron)) + '</span>') +
    row(
      '天气数据源',
      s.qweather_configured
        ? '<span class="ok">QWeather 已配置</span>'
        : '<span class="warn">QWeather 未配置</span>',
    ) +
    (s.qweather_usage
      ? row(
          '今日天气请求',
          s.qweather_usage.requests +
            ' 次 <span class="muted">（' +
            esc(s.qweather_usage.day) +
            '，含重试）</span>',
        )
      : '') +
    (s.holidays.failed.length
      ? row(
          '节假日抓取失败',
          '<span class="bad">' +
            s.holidays.failed
              .map((f) => f.year + ' 年（' + esc(String(f.error || '未知原因').slice(0, 80)) + '）')
              .join('、') +
            '</span>',
        )
      : '');
}
function shortWhen(stamp) {
  return stamp ? stamp.slice(5) : '—';
}
function row(label, value) {
  return (
    '<div class="ops-row"><span class="l">' +
    label +
    '</span><span class="v">' +
    value +
    '</span></div>'
  );
}
/* job_runs 的时间戳是 UTC 瞬间（不是业务日历日）：按浏览器本地时区显示成 MM-dd HH:mm，
     与 /api/* 里服务端本地化好的业务日期区分开；解析失败就原样截断，不猜。 */
function stampShort(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  if (isNaN(d.getTime())) return String(iso).slice(0, 16).replace('T', ' ');
  return (
    ('0' + (d.getMonth() + 1)).slice(-2) +
    '-' +
    ('0' + d.getDate()).slice(-2) +
    ' ' +
    ('0' + d.getHours()).slice(-2) +
    ':' +
    ('0' + d.getMinutes()).slice(-2)
  );
}
function jobStatusLabel(status) {
  return status === 'ok'
    ? '成功'
    : status === 'failed'
      ? '失败'
      : status === 'skipped'
        ? '跳过'
        : status === 'running'
          ? '执行中'
          : String(status);
}
function jobChip(status) {
  var cls =
    status === 'ok'
      ? ' green'
      : status === 'failed'
        ? ' red'
        : status === 'skipped'
          ? ' amber'
          : '';
  return '<span class="chip' + cls + '">' + esc(jobStatusLabel(status)) + '</span>';
}

/* ── 预算（服务端已算好 ratio/pace/suggestion；这里只决定颜色与排版） ── */
function budLevel(line) {
  if (!line) return '';
  if (line.ratio >= 1) return ' over';
  if (line.pace > 1.1) return ' warn';
  return '';
}
function budBar(line) {
  var pct = Math.max(0, Math.min(100, (line.ratio || 0) * 100));
  return (
    '<div class="prog' +
    budLevel(line) +
    '"><span style="width:' +
    pct.toFixed(1) +
    '%"></span></div>'
  );
}
function budTip(line) {
  var cls = line.ratio >= 1 ? ' bad' : line.pace > 1.1 ? ' warn' : '';
  return '<div class="bud-tip' + cls + '">' + esc(line.suggestion) + '</div>';
}
function budCatLevel(cat) {
  return cat.ratio >= 1 ? 'over' : cat.pace > 1.1 ? 'warn' : '';
}
function renderBudget(budget) {
  var body = el('budget-body');
  if (!body) return;
  var ledgers = (budget && budget.ledgers) || [];
  if (!ledgers.length) {
    body.innerHTML = '<div class="empty">还没有家庭账本</div>';
    return;
  }
  body.innerHTML = ledgers
    .map((l) => {
      var html = '<div class="bud-item">';
      if (l.total) {
        html +=
          '<div class="bud-head"><span class="t">' +
          esc(l.ledger_name) +
          '</span>' +
          '<span class="amt">' +
          yuan(l.total.spent_cents) +
          ' / ' +
          yuan(l.total.budget_cents) +
          '</span></div>' +
          budBar(l.total) +
          budTip(l.total);
      } else {
        html +=
          '<div class="bud-head"><span class="t">' +
          esc(l.ledger_name) +
          '</span>' +
          '<span class="chip">' +
          (l.has_budget ? '仅分类预算' : '未设预算') +
          '</span></div>' +
          (l.has_budget ? '' : '<div class="bud-tip">' + esc(BUDGET_UNSET_TIP) + '</div>');
      }
      var cats = l.categories || [];
      if (cats.length) {
        html +=
          '<ul class="bud-cats">' +
          cats
            .slice(0, 6)
            .map((c) => {
              var pct = Math.max(0, Math.min(100, (c.ratio || 0) * 100));
              // 只有「超支 / 花速过快」才把整句建议塞进卡片；正常行保持简洁（完整建议在抽屉里）
              var advice =
                c.ratio >= 1 || c.pace > 1.1
                  ? '<em class="' +
                    (c.ratio >= 1 ? 'bad' : 'warn') +
                    '">' +
                    esc(c.suggestion) +
                    '</em>'
                  : '';
              return (
                '<li><span class="c">' +
                esc(c.category) +
                advice +
                '</span>' +
                '<span class="p"><span><i class="' +
                budCatLevel(c) +
                '" style="width:' +
                pct.toFixed(1) +
                '%"></i></span></span>' +
                '<span class="a">' +
                yuan(c.spent_cents) +
                ' / ' +
                yuan(c.budget_cents) +
                '</span></li>'
              );
            })
            .join('') +
          (cats.length > 6 ? '<li class="more">+' + (cats.length - 6) + ' 项</li>' : '') +
          '</ul>';
      }
      return html + '</div>';
    })
    .join('');
}
function remainingText(cents) {
  return cents < 0 ? '超支 ' + yuan(-cents) : yuan(cents);
}
/* cron 只渲染「分 时」都写死的常见形式（0 7 * * * → 07:00）；其余原样显示，不猜 */
function cronTime(expr) {
  var raw = String(expr === null || expr === undefined ? '' : expr);
  var parts = raw.trim().split(/\s+/);
  if (parts.length < 2 || !/^\d+$/.test(parts[0]) || !/^\d+$/.test(parts[1])) return raw;
  return ('0' + parts[1]).slice(-2) + ':' + ('0' + parts[0]).slice(-2);
}
function isDailyCron(expr) {
  var parts = String(expr === null || expr === undefined ? '' : expr)
    .trim()
    .split(/\s+/);
  return parts.length === 5 && parts[2] === '*' && parts[3] === '*' && parts[4] === '*';
}
function cronLabel(expr) {
  var raw = String(expr === null || expr === undefined ? '' : expr);
  if (!isDailyCron(raw)) return raw;
  var time = cronTime(raw);
  return time === raw ? raw : '每天 ' + time;
}
function sparkline(daily) {
  if (!daily.length) return '';
  var max = Math.max.apply(null, daily.map((d) => d.sent).concat([1]));
  var w = 300,
    h = 58,
    pad = 6;
  var step = daily.length > 1 ? (w - pad * 2) / (daily.length - 1) : 0;
  var pts = daily.map((d, i) => [pad + i * step, h - 5 - (d.sent / max) * (h - 16)]);
  var line = pts.map((p) => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  var area = '0,' + h + ' ' + line + ' ' + w + ',' + h;
  var last = pts[pts.length - 1];
  return (
    '<svg viewBox="0 0 ' +
    w +
    ' ' +
    h +
    '" preserveAspectRatio="none" style="width:100%;height:100%">' +
    '<defs><linearGradient id="sf" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0%" stop-color="#5eead4" stop-opacity=".38"/><stop offset="100%" stop-color="#5eead4" stop-opacity="0"/>' +
    '</linearGradient></defs>' +
    '<polygon points="' +
    area +
    '" fill="url(#sf)"/>' +
    '<polyline points="' +
    line +
    '" fill="none" stroke="#5eead4" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
    '<circle cx="' +
    last[0].toFixed(1) +
    '" cy="' +
    last[1].toFixed(1) +
    '" r="3.5" fill="#0a0c11" stroke="#5eead4" stroke-width="2"/>' +
    '</svg>'
  );
}

function refresh() {
  return api('/api/status')
    .then(render)
    .catch((e) => {
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
  drawerOpen = true;
  drawerRender = renderFn;
  renderFn();
}
function closeDrawer() {
  drawer.classList.remove('on');
  scrim.classList.remove('on');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.dataset.kind = '';
  drawerOpen = false;
  drawerRender = null;
}
function fail(e) {
  drawerBody.innerHTML = '<div class="empty bad">' + esc(e.message) + '</div>';
}

/* ── 分页（加载更多） ──
     逐笔/投递行渲染在首屏与续页共用，避免两处转义或字段漂移；
     分页状态（has_more/next_offset）全部来自服务端，前端不自己算「还有没有下一页」。 */
function expenseRow(e) {
  return (
    '<li><div class="top"><span class="t">' +
    esc(e.note || e.category) +
    '</span>' +
    '<span style="flex:none">' +
    yuan(e.amount_cents) +
    '</span></div>' +
    '<div class="meta"><span>' +
    esc(e.spent_on.slice(5)) +
    '</span><span class="chip">' +
    esc(e.category) +
    '</span>' +
    '<span>' +
    esc(e.ledger_name) +
    '</span><span>' +
    esc(e.created_by_profile) +
    '</span></div></li>'
  );
}
function deliveryRow(i) {
  var cls =
    i.status === 'sent'
      ? 'green'
      : i.status === 'failed'
        ? 'red'
        : i.status === 'fallback'
          ? 'amber'
          : '';
  return (
    '<li><div class="top"><span class="t">' +
    esc(i.title) +
    '</span>' +
    '<span class="chip ' +
    cls +
    '">' +
    esc(i.status) +
    '</span></div>' +
    '<div class="meta"><span>' +
    esc(i.sent_local || i.created_local) +
    '</span>' +
    '<span class="chip">' +
    esc(i.route_name) +
    '</span>' +
    '<span>' +
    esc(i.profile_id) +
    '</span>' +
    (i.attempts ? '<span>尝试 ' + i.attempts + ' 次</span>' : '') +
    '</div>' +
    (i.last_error ? '<div class="meta bad">' + esc(i.last_error.slice(0, 160)) + '</div>' : '') +
    '</li>'
  );
}
function pagedTitle(label, loaded, total) {
  return label + (total > loaded ? '（已显示 ' + loaded + '/' + total + '）' : '');
}
function moreButton(id, kind, payload, loaded, total) {
  if (
    payload.has_more === true &&
    payload.next_offset !== null &&
    payload.next_offset !== undefined
  ) {
    return (
      '<button type="button" class="morebtn" id="' +
      id +
      '" data-load-more="' +
      kind +
      '" data-next-offset="' +
      payload.next_offset +
      '">加载更多（已显示 ' +
      loaded +
      '/' +
      total +
      '）</button>'
    );
  }
  // 没有下一页（含首屏就装得下）：文案明确说「已全部加载」，按钮禁用避免无意义点击
  return (
    '<button type="button" class="morebtn" id="' +
    id +
    '" data-load-more="' +
    kind +
    '" disabled="disabled">已全部加载</button>'
  );
}
function setMoreState(btn, hasMore, nextOffset, loaded, total) {
  if (hasMore === true && nextOffset !== null && nextOffset !== undefined) {
    btn.setAttribute('data-next-offset', String(nextOffset));
    btn.textContent = '加载更多（已显示 ' + loaded + '/' + total + '）';
    btn.disabled = false;
  } else {
    btn.textContent = '已全部加载';
    btn.disabled = true;
    btn.setAttribute('disabled', 'disabled');
  }
}
function bindLoadMore() {
  Array.prototype.forEach.call(drawerBody.querySelectorAll('[data-load-more]'), (btn) => {
    btn.addEventListener('click', () => {
      loadMore(btn);
    });
  });
}
function loadMore(btn) {
  var kind = btn.getAttribute('data-load-more');
  var raw = btn.getAttribute('data-next-offset');
  if (raw === null) return; // 「已全部加载」：没有下一页
  var offset = Number(raw);
  if (!isFinite(offset) || offset <= 0) return;
  // 续页参数由服务端的 next_offset 提供；limit 与首屏一致，否则页边界会错位
  var path =
    kind === 'expenses'
      ? '/api/expenses?month=' + encodeURIComponent(expMonth || '') + '&limit=50&offset=' + offset
      : '/api/deliveries?limit=60&offset=' + offset;
  btn.disabled = true;
  btn.textContent = '加载中…';
  api(path)
    .then((d) => {
      if (kind === 'expenses') {
        var fresh = d.entries || [];
        expEntries = expEntries.concat(fresh);
        expTotal = d.entries_total;
        var list = el('exp-entries');
        if (list) list.innerHTML += fresh.map(expenseRow).join('');
        var title = el('exp-entries-title');
        if (title) title.textContent = pagedTitle('逐笔', expEntries.length, expTotal);
        setMoreState(btn, d.has_more, d.next_offset, expEntries.length, expTotal);
      } else {
        var freshItems = d.items || [];
        delItems = delItems.concat(freshItems);
        delTotal = d.items_total;
        var itemList = el('del-entries');
        if (itemList) itemList.innerHTML += freshItems.map(deliveryRow).join('');
        var itemTitle = el('del-entries-title');
        if (itemTitle) itemTitle.textContent = pagedTitle('记录', delItems.length, delTotal);
        setMoreState(btn, d.has_more, d.next_offset, delItems.length, delTotal);
      }
    })
    .catch((e) => {
      // 失败时保留当前页并恢复按钮：不能让一次网络抖动把已加载内容清空
      btn.disabled = false;
      if (kind === 'expenses') setMoreState(btn, true, Number(raw), expEntries.length, expTotal);
      else setMoreState(btn, true, Number(raw), delItems.length, delTotal);
      drawerSub.textContent = '加载更多失败：' + e.message;
    });
}

function openExpenses(month) {
  openDrawer('expenses', '支出明细', () => {
    var query = '/api/expenses?limit=50' + (month ? '&month=' + encodeURIComponent(month) : '');
    api(query).then(renderExpenses).catch(fail);
  });
}
function renderExpenses(d) {
  expMonth = d.month;
  expEntries = d.entries || [];
  expTotal = d.entries_total;
  drawerSub.textContent = d.count + ' 笔';
  // biome-ignore format: tests/expense-export.test.ts 按单行文本断言导出按钮跟随所选月份
  var exportButton = '<button type="button" data-export="' + expMonth + '">导出 CSV</button>';
  var html =
    '<div class="monthnav">' +
    '<button type="button" data-month="' +
    shiftMonth(expMonth, -1) +
    '">‹ 上月</button>' +
    '<span class="cur">' +
    expMonth +
    '</span>' +
    '<button type="button" data-month="' +
    shiftMonth(expMonth, 1) +
    '">下月 ›</button>' +
    exportButton +
    '<span class="muted" style="margin-left:auto">' +
    yuan(d.total_cents) +
    '</span></div>';

  html +=
    '<div class="sect"><h3>分类</h3>' +
    (d.categories.length
      ? '<table><tbody>' +
        d.categories
          .map(
            (c, i) =>
              '<tr><td><i style="display:inline-block;width:7px;height:7px;border-radius:2px;margin-right:8px;background:' +
              COLORS[i % COLORS.length] +
              '"></i>' +
              esc(c.category) +
              '</td>' +
              '<td class="num muted">' +
              c.count +
              ' 笔</td>' +
              '<td class="num">' +
              yuan(c.cents) +
              '</td>' +
              '<td class="num muted">' +
              (c.share * 100).toFixed(1) +
              '%</td></tr>',
          )
          .join('') +
        '</tbody></table>'
      : '<div class="empty">本月没有记账</div>') +
    '</div>';

  if (d.daily.length) {
    var dmax = Math.max.apply(
      null,
      d.daily.map((x) => x.cents),
    );
    html +=
      '<div class="sect"><h3>按天</h3><div class="bars">' +
      d.daily
        .map(
          (x) =>
            '<div style="height:' +
            Math.max(4, (x.cents / dmax) * 100) +
            '%" title="' +
            esc(x.date) +
            ' ' +
            yuan(x.cents) +
            '"></div>',
        )
        .join('') +
      '</div>' +
      '<div class="spark-axis"><span>' +
      esc(d.daily[0].date.slice(5)) +
      '</span><span>' +
      esc(d.daily[d.daily.length - 1].date.slice(5)) +
      '</span></div>' +
      '<div class="muted" style="font-size:11.5px;margin-top:10px">柱高为该日金额 · ' +
      d.daily.length +
      ' 天有记账</div></div>';
  }

  if (d.ledgers.length > 1) {
    html +=
      '<div class="sect"><h3>账本</h3><table><tbody>' +
      d.ledgers
        .map(
          (l) =>
            '<tr><td>' +
            esc(l.ledger_name) +
            '</td><td class="num muted">' +
            l.count +
            ' 笔</td><td class="num">' +
            yuan(l.cents) +
            '</td></tr>',
        )
        .join('') +
      '</tbody></table></div>';
  }

  // 逐笔行先渲染到独立容器：续页只追加这个 <ul>，不必整抽屉重绘（保留滚动位置）
  html +=
    '<div class="sect"><h3 id="exp-entries-title">' +
    pagedTitle('逐笔', expEntries.length, expTotal) +
    '</h3>' +
    '<ul class="rowlist" id="exp-entries"></ul>' +
    (expTotal === 0 ? '<div class="empty">没有记录</div>' : '') +
    moreButton('exp-more', 'expenses', d, expEntries.length, expTotal) +
    '</div>';

  drawerBody.innerHTML = html;
  var list = el('exp-entries');
  if (list) list.innerHTML = expEntries.map(expenseRow).join('');
  Array.prototype.forEach.call(drawerBody.querySelectorAll('[data-month]'), (b) => {
    b.addEventListener('click', () => {
      openExpenses(b.getAttribute('data-month'));
    });
  });
  Array.prototype.forEach.call(drawerBody.querySelectorAll('[data-export]'), (b) => {
    b.addEventListener('click', () => {
      downloadCsv(b.getAttribute('data-export'));
    });
  });
  bindLoadMore();
}
/* 导出当月 CSV：凭据只走 Authorization 头（绝不进 URL）；Blob + a[download] 触发下载，
     revoke 延后一秒，避免部分浏览器在下载真正开始前就把 objectURL 失效。 */
function downloadCsv(month) {
  // biome-ignore format: tests/expense-export.test.ts 按单行文本断言「按月拼 URL、凭据只走头」
  fetch('/api/expenses.csv?month=' + encodeURIComponent(month), token ? { headers: { Authorization: 'Bearer ' + token } } : {})
    .then((r) => {
      if (!r.ok)
        throw new Error(
          r.status === 401
            ? '未授权：在地址栏给本页加上 ?token=<WEB_API_TOKEN> 刷新一次（本页会记住）'
            : 'HTTP ' + r.status,
        );
      return r.blob();
    })
    .then((blob) => {
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'expenses-' + month + '.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
    })
    .catch((e) => {
      drawerSub.textContent = '导出失败：' + e.message;
    });
}
function shiftMonth(ym, delta) {
  var y = Number(ym.slice(0, 4)),
    m = Number(ym.slice(5, 7)) + delta;
  if (m < 1) {
    m = 12;
    y -= 1;
  }
  if (m > 12) {
    m = 1;
    y += 1;
  }
  return y + '-' + String(m).padStart(2, '0');
}

function openSchedules() {
  openDrawer('schedules', '日程明细', () => {
    api('/api/schedules')
      .then((d) => {
        drawerSub.textContent = d.items.length + ' 项';
        if (!d.items.length) {
          drawerBody.innerHTML = '<div class="empty">没有活跃日程</div>';
          return;
        }
        drawerBody.innerHTML =
          '<ul class="rowlist">' +
          d.items
            .map((s) => {
              var soon = s.days_until !== null && s.days_until <= 1;
              return (
                '<li><div class="top"><span class="t">' +
                esc(s.title) +
                '</span>' +
                '<span class="chip' +
                (soon ? ' teal' : '') +
                '">' +
                icon(s.kind) +
                '</span></div>' +
                '<div class="meta"><span>' +
                esc(s.next_local || '未排期') +
                '</span>' +
                (s.remind_local ? '<span>提醒 ' + esc(s.remind_local) + '</span>' : '') +
                (s.calendar === 'lunar' ? '<span class="chip">农历</span>' : '') +
                (s.all_day ? '<span>全天</span>' : '<span>' + esc(s.time) + '</span>') +
                (s.workday_filter === 'workday'
                  ? '<span>仅工作日</span>'
                  : s.workday_filter === 'holiday'
                    ? '<span>仅节假日</span>'
                    : '') +
                (s.is_deadline ? '<span class="chip">截止</span>' : '') +
                '<span>' +
                esc(s.profile_id) +
                '</span></div>' +
                (s.note ? '<div class="meta"><span>' + esc(s.note) + '</span></div>' : '') +
                '</li>'
              );
            })
            .join('') +
          '</ul>';
      })
      .catch(fail);
  });
}

function openDeliveries() {
  openDrawer('deliveries', '投递明细', () => {
    api('/api/deliveries?limit=60').then(renderDeliveries).catch(fail);
  });
}
function renderDeliveries(d) {
  delItems = d.items || [];
  delTotal = d.items_total;
  var c = d.counts;
  drawerSub.textContent = c.sent_24h + ' 条 / 24h';
  var max = Math.max.apply(null, d.daily.map((x) => x.sent).concat([1]));
  var html =
    '<div class="sect"><h3>近 7 天</h3><div class="bars">' +
    d.daily
      .map(
        (x) =>
          '<div style="height:' +
          Math.max(4, (x.sent / max) * 100) +
          '%" title="' +
          esc(x.date) +
          ' ' +
          x.sent +
          ' 条">' +
          '<span>' +
          esc(x.label) +
          '</span></div>',
      )
      .join('') +
    '</div><div style="height:16px"></div>' +
    '<table><tbody>' +
    '<tr><td>待投递</td><td class="num ' +
    (c.queued ? 'warn' : '') +
    '">' +
    c.queued +
    '</td></tr>' +
    '<tr><td>失败</td><td class="num ' +
    (c.failed ? 'bad' : '') +
    '">' +
    c.failed +
    '</td></tr>' +
    '<tr><td>兜底</td><td class="num ' +
    (c.fallback ? 'bad' : '') +
    '">' +
    c.fallback +
    '</td></tr>' +
    '</tbody></table></div>';

  html +=
    '<div class="sect"><h3 id="del-entries-title">' +
    pagedTitle('记录', delItems.length, delTotal) +
    '</h3>' +
    '<ul class="rowlist" id="del-entries"></ul>' +
    (delTotal === 0 ? '<div class="empty">没有投递记录</div>' : '') +
    moreButton('del-more', 'deliveries', d, delItems.length, delTotal) +
    '</div>';
  drawerBody.innerHTML = html;
  var list = el('del-entries');
  if (list) list.innerHTML = delItems.map(deliveryRow).join('');
  bindLoadMore();
}

function openHolidays() {
  openDrawer('holidays', '节假日明细', () => {
    api('/api/holidays')
      .then((d) => {
        var render = (year) => {
          holYear = year;
          api('/api/holidays?year=' + year)
            .then((h) => {
              drawerSub.textContent = h.year + ' 年';
              var html =
                '<div class="monthnav">' +
                '<select class="sel" id="hol-year">' +
                h.years
                  .map(
                    (y) =>
                      '<option' + (y === h.year ? ' selected' : '') + '>' + esc(y) + '</option>',
                  )
                  .join('') +
                '</select>' +
                '<span class="muted">' +
                h.days.filter((x) => x.day_type === 'holiday').length +
                ' 天假期 · ' +
                h.days.filter((x) => x.day_type === 'workday').length +
                ' 天调休</span></div>';
              if (h.upcoming.length) {
                html +=
                  '<div class="sect"><h3>接下来的假期</h3><table><tbody>' +
                  h.upcoming
                    .map(
                      (u) =>
                        '<tr><td>' +
                        esc(u.name) +
                        '</td><td class="muted">' +
                        esc(u.date) +
                        '</td>' +
                        '<td class="num">' +
                        (u.in_progress
                          ? '<span class="chip teal">进行中</span>'
                          : u.days_until === 0
                            ? '<span class="chip teal">今天</span>'
                            : u.days_until + ' 天后') +
                        '</td></tr>',
                    )
                    .join('') +
                  '</tbody></table></div>';
              }
              html +=
                '<div class="sect"><h3>' +
                h.year +
                ' 年安排</h3>' +
                (h.days.length
                  ? '<table><thead><tr><th>日期</th><th>星期</th><th>名称</th><th class="num">类型</th></tr></thead><tbody>' +
                    h.days
                      .map(
                        (x) =>
                          '<tr><td>' +
                          esc(x.date.slice(5)) +
                          '</td><td class="muted">' +
                          esc(x.weekday) +
                          '</td><td>' +
                          esc(x.name) +
                          '</td>' +
                          '<td class="num">' +
                          (x.day_type === 'holiday'
                            ? '<span class="chip green">休</span>'
                            : '<span class="chip amber">班</span>') +
                          '</td></tr>',
                      )
                      .join('') +
                    '</tbody></table>'
                  : '<div class="empty">该年份暂无数据</div>') +
                '</div>';
              drawerBody.innerHTML = html;
              /** @type {any} */
              var sel = el('hol-year');
              if (sel)
                sel.addEventListener('change', () => {
                  render(sel.value);
                });
            })
            .catch(fail);
        };
        render(holYear || d.year);
      })
      .catch(fail);
  });
}

function openJobs() {
  openDrawer('jobs', '定时任务', () => {
    api('/api/jobs')
      .then((d) => {
        var items = d.items || [];
        drawerSub.textContent = items.length + ' 个任务';
        if (!items.length) {
          drawerBody.innerHTML = '<div class="empty">没有注册定时任务</div>';
          return;
        }
        drawerBody.innerHTML =
          '<div class="sect"><h3>任务与最近运行</h3><ul class="rowlist">' +
          items
            .map((j) => {
              var r = j.last_run;
              // 每个 job 展开最近 3 次运行：只看「最近一次」分不清「偶发失败」还是「一直失败」
              var recent = (j.recent_runs || [])
                .slice(0, 3)
                .map((x) => jobChip(x.status) + ' ' + esc(stampShort(x.started_at)));
              return (
                '<li><div class="top"><span class="t">' +
                esc(j.module + '.' + j.name) +
                '</span>' +
                (r ? jobChip(r.status) : '<span class="chip">未运行</span>') +
                '</div>' +
                '<div class="meta"><span>' +
                esc(j.cron) +
                '</span>' +
                (j.next_run_hint ? '<span>' + esc(j.next_run_hint) + '</span>' : '') +
                '<span>最近成功 ' +
                (j.last_ok_at ? esc(stampShort(j.last_ok_at)) : '从未') +
                '</span>' +
                (j.failed_24h > 0
                  ? '<span class="bad">24h 失败 ' + j.failed_24h + ' 次</span>'
                  : '') +
                '</div>' +
                (recent.length ? '<div class="meta">' + recent.join(' · ') + '</div>' : '') +
                (r && r.error
                  ? '<div class="meta bad">' + esc(String(r.error).slice(0, 160)) + '</div>'
                  : '') +
                '</li>'
              );
            })
            .join('') +
          '</ul></div>';
      })
      .catch(fail);
  });
}

function openBudget() {
  openDrawer('budget', '预算明细', () => {
    api('/api/budget')
      .then((d) => {
        var ledgers = d.ledgers || [];
        drawerSub.textContent = d.month;
        if (!ledgers.length) {
          drawerBody.innerHTML = '<div class="empty">还没有家庭账本</div>';
          return;
        }
        drawerBody.innerHTML = ledgers
          .map((l) => {
            var html = '<div class="sect"><h3>' + esc(l.ledger_name) + '</h3>';
            if (l.total) {
              html +=
                '<div class="bud-head"><span class="t">总额</span><span class="amt">' +
                yuan(l.total.spent_cents) +
                ' / ' +
                yuan(l.total.budget_cents) +
                '</span></div>' +
                budBar(l.total) +
                budTip(l.total);
            } else {
              html +=
                '<div class="bud-tip">' +
                (l.has_budget ? '未设总额预算（仅有分类预算）' : esc(BUDGET_UNSET_TIP)) +
                '</div>';
            }
            var cats = l.categories || [];
            if (cats.length) {
              html +=
                '<table><thead><tr><th>分类</th><th class="num">已用 / 预算</th><th class="num">剩余</th></tr></thead><tbody>' +
                cats
                  .map((c) => {
                    var cls = c.ratio >= 1 ? 'bad' : c.pace > 1.1 ? 'warn' : 'muted';
                    return (
                      '<tr><td>' +
                      esc(c.category) +
                      '</td>' +
                      '<td class="num">' +
                      yuan(c.spent_cents) +
                      ' / ' +
                      yuan(c.budget_cents) +
                      '</td>' +
                      '<td class="num ' +
                      (c.remaining_cents < 0 ? 'bad' : '') +
                      '">' +
                      remainingText(c.remaining_cents) +
                      '</td></tr>' +
                      '<tr><td colspan="3" class="' +
                      cls +
                      '" style="padding-top:0">' +
                      esc(c.suggestion) +
                      '</td></tr>'
                    );
                  })
                  .join('') +
                '</tbody></table>';
            }
            return html + '</div>';
          })
          .join('');
      })
      .catch(fail);
  });
}

function openSystem() {
  openDrawer('system', '系统信息', () => {
    api('/api/status')
      .then((s) => {
        drawerBody.innerHTML =
          '<div class="sect"><table><tbody>' +
          '<tr><td>名称</td><td class="num">' +
          esc(s.name) +
          ' v' +
          esc(s.version) +
          '</td></tr>' +
          '<tr><td>运行时长</td><td class="num">' +
          mins(s.uptime_s) +
          '</td></tr>' +
          '<tr><td>Profile</td><td class="num">' +
          esc(s.profiles.join(' · ')) +
          '</td></tr>' +
          '<tr><td>活跃日程</td><td class="num">' +
          s.schedules.active +
          '</td></tr>' +
          '<tr><td>账本</td><td class="num">' +
          s.ledgers.total +
          ' 活跃 / ' +
          s.ledgers.archived +
          ' 归档</td></tr>' +
          '<tr><td>定时简报</td><td class="num">' +
          esc(s.daily_brief_cron) +
          '</td></tr>' +
          '<tr><td>天气数据源</td><td class="num">' +
          (s.qweather_configured ? '已配置' : '未配置') +
          '</td></tr>' +
          '<tr><td>节假日年份</td><td class="num">' +
          (s.holidays.years.join('、') || '无') +
          '</td></tr>' +
          '</tbody></table></div>' +
          '<div class="sect"><h3>原始状态</h3><div class="muted" style="font-size:11.5px">' +
          'GET <a href="#" data-api="/api/status" style="color:inherit">/api/status</a> · ' +
          'GET <a href="#" data-api="/api/expenses" style="color:inherit">/api/expenses</a> · ' +
          'GET <a href="#" data-api="/api/budget" style="color:inherit">/api/budget</a> · ' +
          'GET <a href="#" data-api="/api/schedules" style="color:inherit">/api/schedules</a> · ' +
          'GET <a href="#" data-api="/api/deliveries" style="color:inherit">/api/deliveries</a> · ' +
          'GET <a href="#" data-api="/api/holidays" style="color:inherit">/api/holidays</a> · ' +
          'GET <a href="#" data-api="/api/jobs" style="color:inherit">/api/jobs</a></div></div>';
      })
      .catch(fail);
  });
}

var HANDLERS = {
  expenses: () => {
    openExpenses(null);
  },
  schedules: openSchedules,
  deliveries: openDeliveries,
  holidays: openHolidays,
  jobs: openJobs,
  budget: openBudget,
  system: openSystem,
};
var TITLES = {
  expenses: '支出明细',
  schedules: '日程明细',
  deliveries: '投递明细',
  holidays: '节假日明细',
  jobs: '定时任务',
  budget: '预算明细',
  system: '系统信息',
};

document.addEventListener('click', (/** @type {any} */ ev) => {
  // 原始状态链接不能直接用 href：普通导航不会带 Authorization 头，配了 token
  // 必然 401。改为走页面已有的 api()（带 Bearer）并把 JSON 渲染在抽屉里。
  var raw = ev.target.closest('[data-api]');
  if (raw) {
    if (typeof ev.preventDefault === 'function') ev.preventDefault();
    var path = raw.getAttribute('data-api');
    drawerSub.textContent = path;
    drawerBody.innerHTML = '<div class="spin">加载中…</div>';
    api(path)
      .then((d) => {
        drawerBody.innerHTML =
          '<pre style="white-space:pre-wrap;word-break:break-word;font-size:11.5px;margin:0">' +
          esc(JSON.stringify(d, null, 2)) +
          '</pre>';
      })
      .catch(fail);
    return;
  }
  var target = ev.target.closest('[data-drawer]');
  if (target) {
    var kind = target.getAttribute('data-drawer');
    if (HANDLERS[kind]) {
      HANDLERS[kind]();
    }
    return;
  }
  if (ev.target === scrim || ev.target.closest('#drawer-close')) closeDrawer();
});
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') closeDrawer();
});

refresh();
setInterval(() => {
  refresh();
  // 只刷新「开着的那张抽屉」：关着时不重跑渲染函数（会白拉一次接口）。
  // 必须走已保存的渲染函数，而不是 HANDLERS[kind]——后者会重走 openDrawer，
  // 把 body 打回「加载中…」、丢掉列表滚动位置（所选的月/年由 expMonth/holYear 保留）。
  if (!drawerOpen || drawerRender === null) return;
  drawerRender();
}, 30000);
