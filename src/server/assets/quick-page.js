if (
  location.search.indexOf('token=') >= 0 &&
  typeof history !== 'undefined' &&
  history.replaceState
) {
  // 只抹 token，保留 type/amount/category/title/profile 等预填参数
  history.replaceState(null, '', location.pathname + stripTokenParam(location.search));
}
var qs = new URLSearchParams(location.search);
var profileParam = qs.get('profile') || '';
var prefill = {
  type: qs.get('type') || '',
  amount: qs.get('amount') || '',
  category: qs.get('category') || '',
  title: qs.get('title') || '',
};
var boot = null;

function toast(msg, kind) {
  var box = el('toast');
  box.textContent = msg;
  box.className = 'toast ' + (kind || '');
}
/* 幂等键：同一次提交在网络抖动后重试不会重复记账（服务端按 client_token 去重） */
function newRequestId() {
  return 'quick-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
function api(path, init) {
  var opts = init || {};
  var headers = opts.headers || {};
  if (token) headers.Authorization = 'Bearer ' + token;
  opts.headers = headers;
  return fetch(path, opts).then(function (r) {
    return r
      .json()
      .catch(function () {
        return {};
      })
      .then(function (body) {
        if (!r.ok) throw new Error(body && body.error ? body.error : 'HTTP ' + r.status);
        return body;
      });
  });
}
function showPanel(mode) {
  el('panel-expense').hidden = mode !== 'expense';
  el('panel-schedule').hidden = mode !== 'schedule';
  el('btn-expense').className = 'big-btn' + (mode === 'expense' ? ' on' : '');
  el('btn-schedule').className = 'big-btn' + (mode === 'schedule' ? ' on' : '');
}
function pad2(n) {
  return (n < 10 ? '0' : '') + n;
}
function localDateTime(d, hhmm) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + 'T' + hhmm;
}
function fillWhen(kind) {
  var now = new Date();
  var when = new Date(now.getTime());
  var hhmm = kind === 'tomorrow' ? '09:00' : '20:00';
  // 「今晚 20:00」在 20:00 之后点已经没有意义：顺延到明天，而不是设一个已过去的提醒
  if (kind !== 'tomorrow' && now.getHours() * 60 + now.getMinutes() >= 20 * 60) {
    when.setDate(when.getDate() + 1);
  }
  el('when').value = localDateTime(when, hhmm);
}

function render(b) {
  boot = b;
  var ledgers = b.ledgers || [];
  el('ledger').innerHTML = ledgers.length
    ? ledgers
        .map(function (l) {
          return (
            '<option value="' +
            esc(l.id) +
            '"' +
            (l.id === b.default_ledger_id ? ' selected' : '') +
            '>' +
            esc(l.name) +
            '</option>'
          );
        })
        .join('')
    : '<option value="">（没有可用账本，请先在 Hermes 里建一个）</option>';
  el('cat-chips').innerHTML = (b.recent_categories || [])
    .map(function (cat) {
      return (
        '<button type="button" class="chip" data-cat="' + esc(cat) + '">' + esc(cat) + '</button>'
      );
    })
    .join('');
  var today = b.today ? b.today.date + ' ' + b.today.weekday + ' · ' : '';
  el('summary').textContent =
    today + '本月已花 ' + yuan(b.month_cents) + ' · ' + b.active_schedules + ' 项提醒进行中';
  el('token-hint').hidden = true;
}
function refresh() {
  var path =
    '/api/quick/bootstrap' + (profileParam ? '?profile=' + encodeURIComponent(profileParam) : '');
  api(path)
    .then(render)
    .catch(function (e) {
      el('token-hint').hidden = false;
      el('summary').textContent = '未连接';
      toast(e.message, 'bad');
    });
}

function submitExpense() {
  var raw = el('amount').value;
  var amount = Number(raw);
  if (raw === '' || !isFinite(amount) || amount <= 0) {
    toast('请输入正确的金额', 'bad');
    return;
  }
  var payload = { amount: amount, request_id: newRequestId() };
  var ledger = el('ledger').value;
  if (ledger) payload.ledger_id = ledger;
  else if (boot && boot.default_ledger_id) payload.ledger_id = boot.default_ledger_id;
  if (el('category').value) payload.category = el('category').value;
  if (el('note').value) payload.note = el('note').value;
  if (profileParam) payload.profile = profileParam;
  api('/api/quick/expenses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(function (d) {
      var extra = d['已存在'] ? '（重复提交，未重复记账）' : '';
      toast(
        '已记账 ' +
          yuan(Math.round(amount * 100)) +
          ' · ' +
          d.category +
          ' · ' +
          d.ledger_name +
          extra,
        'ok',
      );
      el('amount').value = '';
      el('note').value = '';
      el('again').hidden = false;
    })
    .catch(function (e) {
      toast('记账失败：' + e.message, 'bad');
    });
}

function submitSchedule() {
  var title = el('title').value.trim();
  if (title === '') {
    toast('请输入提醒内容', 'bad');
    return;
  }
  var payload = { title: title, request_id: newRequestId() };
  var when = el('when').value;
  // datetime-local 的值是本地时间文本 YYYY-MM-DDTHH:MM，拆成 date + time 传（服务端按时区解释）
  if (when && when.length >= 16) {
    payload.date = when.slice(0, 10);
    payload.time = when.slice(11, 16);
  }
  if (el('note-schedule').value) payload.note = el('note-schedule').value;
  if (profileParam) payload.profile = profileParam;
  api('/api/quick/schedules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then(function (d) {
      var extra = d['已存在'] ? '（重复提交，未重复创建）' : '';
      toast('已设提醒 ' + (d['事件时间'] || '') + extra, 'ok');
      el('title').value = '';
      el('note-schedule').value = '';
    })
    .catch(function (e) {
      toast('设置失败：' + e.message, 'bad');
    });
}

el('btn-expense').addEventListener('click', function () {
  showPanel('expense');
});
el('btn-schedule').addEventListener('click', function () {
  showPanel('schedule');
});
el('cat-chips').addEventListener('click', function (/** @type {any} */ ev) {
  var target = ev && ev.target;
  var cat = target && target.getAttribute ? target.getAttribute('data-cat') : null;
  if (cat) el('category').value = cat;
});
el('when-chips').addEventListener('click', function (/** @type {any} */ ev) {
  var target = ev && ev.target;
  var kind = target && target.getAttribute ? target.getAttribute('data-when') : null;
  if (kind) fillWhen(kind);
});
el('submit-expense').addEventListener('click', submitExpense);
el('submit-schedule').addEventListener('click', submitSchedule);
el('again').addEventListener('click', function () {
  el('again').hidden = true;
  if (typeof el('amount').focus === 'function') el('amount').focus();
});

// 预填（小布指令 / NFC：/quick?type=expense&amount=20&category=餐饮）
if (prefill.amount) el('amount').value = prefill.amount;
if (prefill.category) el('category').value = prefill.category;
if (prefill.title) el('title').value = prefill.title;
if (!el('when').value) fillWhen('tomorrow');
if (prefill.type === 'schedule') showPanel('schedule');
refresh();
