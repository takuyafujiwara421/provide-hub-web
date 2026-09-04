/* ===========================================================================
   provide hub ─ 画面のロジック
   ---------------------------------------------------------------------------
   通信は JSONP（<script>タグ）で行う。GASのWebアプリは別オリジンにCORSヘッダを
   返せないため、fetch では読めないから。書き込みも同じ口を使う（社内利用・
   URLは長くならない範囲）。トークンは端末のlocalStorageに置く。

   画面は4つのセクション（tasks / reports / ops / news）を同時に取りに行き、
   届いた順に描く。どれか1つが遅くても他が先に出る。
   =========================================================================== */
'use strict';

var API = 'https://script.google.com/macros/s/AKfycbzWmpns4NPO-ThQQdYpqypJRs4RkvtgcP4jnZUvAuQPFZIVuJFgOq1Yqfz9gJTaac4Y2w/exec';

var S = {
  token: localStorage.getItem('hub_token') || '',
  user: JSON.parse(localStorage.getItem('hub_user') || 'null'),
  view: 'home',
  data: { tasks: null, reports: null, ops: null, news: null, members: null, storeReport: null, period: null },
  newsCat: 'docomo',
  storeRange: 'thismonth',
  storeKind: 'shoki',
  doneIds: {},      // 完了を押したタスク。司令塔の反映が追いつくまで画面から外す
  focus: { queue: [], i: 0 },
};

/* ---------- 通信 ---------- */
var _seq = 0;
function api(action, params, timeoutMs) {
  return new Promise(function (resolve, reject) {
    var cb = '_hubcb' + (++_seq) + '_' + Date.now().toString(36);
    var s = document.createElement('script');
    var done = false;
    var timer = setTimeout(function () {
      if (done) return;
      cleanup();
      reject(new Error('応答がありません（通信が不安定かもしれません）'));
    }, timeoutMs || 45000);

    function cleanup() {
      done = true;
      clearTimeout(timer);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (s.parentNode) s.parentNode.removeChild(s);
    }
    window[cb] = function (res) {
      cleanup();
      if (res && res.ok) resolve(res.data);
      else reject(new Error((res && res.error) || '不明なエラー'));
    };

    var q = new URLSearchParams();
    q.set('action', action);
    q.set('callback', cb);
    if (S.token) q.set('token', S.token);
    for (var k in (params || {})) if (params[k] !== undefined && params[k] !== null && params[k] !== '') q.set(k, params[k]);

    s.src = API + '?' + q.toString();
    s.onerror = function () { if (!done) { cleanup(); reject(new Error('サーバーに接続できません')); } };
    document.head.appendChild(s);
  });
}

/* ---------- 小物 ---------- */
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function toast(msg, isErr) {
  var t = $('#toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(t._tm);
  t._tm = setTimeout(function () { t.classList.add('hidden'); }, 2800);
}
function todayStr() {
  var d = new Date();
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
function plusDays(n) {
  var d = new Date(); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
/** スプシ経由で表記が揺れた日時を「8/7 15:02」の形に整える */
function fmtWhen(s) {
  var t = String(s || '');
  var m = t.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[T ](\d{1,2}):(\d{2})/);
  if (m) return Number(m[2]) + '/' + Number(m[3]) + ' ' + ('0' + m[4]).slice(-2) + ':' + m[5];
  var d = t.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (d) return Number(d[2]) + '/' + Number(d[3]);
  return t.slice(0, 16);
}

function relDate(iso) {
  if (!iso) return '';
  var diff = Math.round((new Date(iso + 'T00:00:00') - new Date(todayStr() + 'T00:00:00')) / 86400000);
  if (diff === 0) return '今日';
  if (diff === 1) return '明日';
  if (diff === -1) return '昨日';
  if (diff < 0) return (-diff) + '日超過';
  return diff + '日後';
}

/* ---------- 認証 ---------- */
function showLogin() { $('#login').classList.remove('hidden'); $('#app').classList.add('hidden'); }
function showApp() {
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#whoami').textContent = S.user ? S.user.name : '';
}

$('#loginForm').addEventListener('submit', function (ev) {
  ev.preventDefault();
  var btn = ev.target.querySelector('button');
  btn.disabled = true; btn.textContent = 'ログイン中…';
  $('#loginErr').textContent = '';
  api('login', { user: $('#loginUser').value.trim(), pin: $('#loginPin').value.trim() })
    .then(function (d) {
      S.token = d.token; S.user = d.user;
      localStorage.setItem('hub_token', d.token);
      localStorage.setItem('hub_user', JSON.stringify(d.user));
      showApp(); loadAll();
    })
    .catch(function (e) { $('#loginErr').textContent = e.message; })
    .then(function () { btn.disabled = false; btn.textContent = 'ログイン'; });
});

/* ---------- 読み込み ---------- */
function loadAll(fresh) {
  ['tasks', 'reports', 'ops', 'news'].forEach(function (sec) {
    api('hub', { section: sec, fresh: fresh ? 1 : '' })
      .then(function (r) {
        S.data[sec] = r.data;
        renderSection(sec);
      })
      .catch(function (e) {
        if (/UNAUTHORIZED|ログインが必要/.test(e.message)) { logout(); return; }
        if (sec === 'tasks') $('#todayTasks').innerHTML = '<li class="task-sub">' + esc(e.message) + '</li>';
        console.warn(sec, e.message);
      });
  });
}
function logout() {
  localStorage.removeItem('hub_token'); localStorage.removeItem('hub_user');
  S.token = ''; S.user = null; showLogin();
}

function renderSection(sec) {
  if (sec === 'tasks') { renderMode(); renderTasks(); }
  if (sec === 'reports') { renderReports(); }
  if (sec === 'ops') { renderOps(); }
  if (sec === 'news') { renderNews(); }
}

/* ---------- 稼働モード ---------- */
/**
 * 予定1件。時間・場所・説明が入っていればタップで開く。
 * 何も入っていない予定はタップしても意味がないので、開ける印（＋）を出さない。
 */
function eventItemHtml(e, extra) {
  var span = e.allDay ? '終日'
    : (e.start || '') + (e.end && e.end !== e.start ? '〜' + e.end : '');
  var detail = '';
  if (span && !e.allDay) detail += '<div class="ed-row"><b>時間</b>' + esc(span) + '</div>';
  if (e.location) detail += '<div class="ed-row"><b>場所</b>' + esc(e.location) + '</div>';
  if (e.desc) detail += '<div class="ed-row ed-desc">' + esc(e.desc) + '</div>';

  return '<li class="event-item' + (e.isOffice ? ' office' : '') + (extra ? ' ' + extra : '') +
    (detail ? ' has-detail' : '') + '">' +
    '<span class="event-time">' + esc(e.start || '終日') + '</span>' +
    '<span class="event-title">' + esc(e.title) + '</span>' +
    (detail ? '<div class="event-detail hidden">' + detail + '</div>' : '') +
    '</li>';
}

// 予定をタップで開閉（今日ぶん・明日ぶんの両方をまとめて拾う）
document.addEventListener('click', function (ev) {
  var li = ev.target.closest ? ev.target.closest('.event-item.has-detail') : null;
  if (!li) return;
  var d = li.querySelector('.event-detail');
  if (!d) return;
  d.classList.toggle('hidden');
  li.classList.toggle('open');
});

function renderMode() {
  var d = S.data.tasks; if (!d) return;
  var m = d.mode;
  var badge = $('#modeBadge');
  badge.textContent = (m.office ? '● ' : '') + m.mark + ' ' + m.label;
  badge.className = 'mode-badge' + (m.office ? ' office' : '');

  $('#daySummary').innerHTML =
    '<div class="day-title">' + esc(m.date.slice(5).replace('-', '/')) + '（' + esc(m.dow) + '）</div>' +
    '<div class="day-note">' + esc(m.label) +
    (m.office ? ' ／ 溜まったタスクを進められる日です' : ' ／ 現場中心の日です') + '</div>';

  var ev = $('#todayEvents');
  ev.innerHTML = m.events.length
    ? m.events.map(eventItemHtml).join('')
    : '<li class="task-sub">予定はありません</li>';

  // 翌日の予定（前日のうちに支度できるように、今日の下に小さく出す）
  var t = m.next;
  if (t) {
    $('#tomorrowHead').innerHTML =
      '<span class="day-next-label">明日</span>' +
      '<b>' + esc(t.date.slice(5).replace('-', '/')) + '（' + esc(t.dow) + '）</b>' +
      '<span class="day-next-mode">' + esc(t.label) + '</span>';
    $('#tomorrowEvents').innerHTML = t.events.length
      ? t.events.map(function (e) { return eventItemHtml(e, 'next'); }).join('')
      : '<li class="task-sub">予定はありません</li>';
    $('#tomorrowBlock').classList.remove('hidden');
  } else {
    $('#tomorrowBlock').classList.add('hidden');
  }

  var next = (d.nextOfficeDays || []).filter(function (o) { return o.date > m.date; }).slice(0, 3);
  $('#nextOffice').innerHTML = next.length
    ? '次にまとめて片付けられる日：' + next.map(function (o) { return '<b>' + esc(o.date.slice(5).replace('-', '/')) + ' ' + esc(o.mark) + '</b>'; }).join('、')
    : '';

  // 集中モードはオフィス日に目立たせる
  $('#btnFocus').className = m.office ? 'btn-primary btn-sm' : 'btn-ghost';
}

/* ---------- タスク ---------- */
function taskItemHtml(t) {
  var why = (t.why || []).map(function (w) {
    var hot = /超過|今日が約束|動いていない/.test(w);
    return '<span class="why-tag' + (hot ? ' hot' : '') + '">' + esc(w) + '</span>';
  }).join('');
  return '<li class="task-item" data-id="' + t.id + '">' +
    '<button class="task-check" title="完了にする">✓</button>' +
    '<div class="task-main">' +
      '<div class="task-name">' + esc(t.name) + '</div>' +
      '<div class="task-sub">' + esc(t.category || '未分類') +
        (t.notifyDate ? ' ・ ' + esc(relDate(t.notifyDate)) : '') +
        (t.next ? ' ・ 次：' + esc(t.next) : '') + '</div>' +
      (why ? '<div class="task-why">' + why + '</div>' : '') +
    '</div>' +
    '<div class="task-side"><span class="prio' + (t.priority === '高' ? ' high' : '') + '">' + esc(t.priority || '－') + '</span></div>' +
  '</li>';
}

/**
 * 完了ボタンを押したタスクを、取り直したデータからも取り除く。
 * ★司令塔（Notion）への反映は数秒〜十数秒かかる。押した直後に取り直すと
 *   まだ「進行中」で返ってくるので、これが無いとチェックしたタスクが復活する。
 */
function dropDoneTask(id) {
  var d = S.data.tasks; if (!d) return;
  ['today', 'active'].forEach(function (k) {
    if (!d[k]) return;
    d[k] = d[k].filter(function (t) { return String(t.id) !== String(id); });
  });
  if (d.stats && d.stats.active) d.stats.active = Math.max(0, d.stats.active - 1);
}

function renderTasks() {
  var d = S.data.tasks; if (!d) return;
  // 完了済みとして押されたものは、サーバー側が追いつくまで出さない
  ['today', 'active'].forEach(function (k) {
    if (d[k]) d[k] = d[k].filter(function (t) { return !S.doneIds[String(t.id)]; });
  });
  var st = d.stats;
  $('#taskStats').innerHTML =
    '<span class="stat-pill">現役 <b>' + st.active + '</b></span>' +
    '<span class="stat-pill' + (st.overdue ? ' alert' : '') + '">期限すぎ <b>' + st.overdue + '</b></span>' +
    '<span class="stat-pill">優先度高 <b>' + st.high + '</b></span>' +
    '<span class="stat-pill">止まっている <b>' + st.stale + '</b></span>';

  $('#todayTasks').innerHTML = d.today.length
    ? d.today.map(taskItemHtml).join('')
    : '<li class="task-sub">今日やるべきものはありません</li>';

  renderAllTasks();
  var cats = {};
  d.active.forEach(function (t) { if (t.category) cats[t.category] = 1; });
  $('#catList').innerHTML = Object.keys(cats).map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');
}

function renderAllTasks() {
  var d = S.data.tasks; if (!d) return;
  var f = $('#taskFilter').value;
  var list = d.active.filter(function (t) {
    if (f === 'overdue') return t.notifyDate && t.notifyDate <= todayStr();
    if (f === 'high') return t.priority === '高';
    if (f === 'stale') return (t.why || []).join().indexOf('動いていない') >= 0;
    if (f === 'desk') return t.kind === 'desk';
    if (f === 'field') return t.kind === 'field';
    return true;
  });
  $('#allTasks').innerHTML = list.length ? list.map(taskItemHtml).join('') : '<li class="task-sub">該当なし</li>';
}

// チェックで完了（一覧・今日の両方）
document.addEventListener('click', function (ev) {
  var btn = ev.target.closest('.task-check');
  if (!btn) return;
  var li = btn.closest('.task-item');
  var id = li.getAttribute('data-id');

  // 押した瞬間にチェックを入れる。司令塔への反映は数秒かかるので、待たせない
  btn.disabled = true;
  btn.classList.add('on');
  li.classList.add('done');

  api('tasks.done', { id: id }).then(function () {
    toast('完了にしました');
    // ★司令塔→Notionへの反映は数秒かかる。取り直しただけでは「まだ進行中」で
    //   返ってきて復活してしまうので、押したIDを覚えておいて画面から外し続ける。
    S.doneIds[id] = 1;
    setTimeout(function () {
      li.style.transition = 'opacity .25s, transform .25s';
      li.style.opacity = '0';
      li.style.transform = 'translateX(12px)';
      setTimeout(function () {
        li.remove();
        dropDoneTask(id);
        renderTasks();
        loadAll(true);
      }, 250);
    }, 600);
  }).catch(function (e) {
    btn.disabled = false;
    btn.classList.remove('on');
    li.classList.remove('done');
    delete S.doneIds[id];
    toast(e.message, true);
  });
});

/* ---------- 実績 ---------- */
function kpi(label, value, unit, delta) {
  var d = '';
  if (delta !== undefined && delta !== null) {
    var cls = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
    var arrow = delta > 0 ? '▲' : (delta < 0 ? '▼' : '－');
    d = '<div class="kpi-delta ' + cls + '">' + arrow + ' ' + Math.abs(delta) + '% 前月同日比</div>';
  }
  return '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div>' +
    '<div class="kpi-value">' + esc(value) + (unit ? '<span class="kpi-unit">' + esc(unit) + '</span>' : '') + '</div>' + d + '</div>';
}

function renderReports() {
  var r = S.data.reports; if (!r) return;
  $('#reportMonth').textContent = r.month + ' 時点';
  $('#reportMonth2').textContent = r.month + ' 時点';

  var n = r.nippou || {}, nk = r.nokisaki || {}, h = r.helper || {};

  // ★3区分は数える単位が違う（初期設定=件数／軒先・店内=PI）ので、
  //   ひとまとまりに並べず見出しで分ける。混ぜると足し算できる数字に見えてしまう
  var html =
    '<div class="kpi-group"><div class="kpi-group-head">初期設定</div><div class="kpi-row">' +
      kpi('件数', (n.total || 0).toLocaleString(), '件', n.diffRate) +
      kpi('稼働日数', n.days || 0, '日') +
      kpi('店舗数', n.storeCount || 0, '店') +
    '</div></div>' +
    '<div class="kpi-group"><div class="kpi-group-head">出張販売／軒先</div><div class="kpi-row">' +
      kpi('PI', nk.pi || 0, '件') +
      kpi('着座率', nk.sitRate || 0, '%') +
      kpi('成約率', nk.piRate || 0, '%') +
    '</div></div>' +
    '<div class="kpi-group"><div class="kpi-group-head">店内ヘルパー</div><div class="kpi-row">' +
      kpi('PI', h.pi || 0, '件') +
      kpi('記録数', h.records || 0, '件') +
    '</div></div>';
  $('#kpiRow').innerHTML = html;   // ホームの「今月の実績」は当月固定のまま
  if (!S.data.period) loadPeriod(S.storeRange);

  drawCharts($('#homeCharts'), r, 2);
  // ★実績画面には「推移」だけを置く。店舗別・スタッフ別は期間連動のもの(#periodTops)を
  //   出しているので、当月固定の同じグラフを並べると『変わらない数字』に見えて紛らわしい
  drawTrends($('#reportCharts'), r);

  // 数値の内訳（色に頼らず読めるようにテーブルも出す）
  var t = '<table class="tbl"><thead><tr><th>商材</th><th class="num">件数</th></tr></thead><tbody>';
  var items = n.byItem || {};
  Object.keys(items).forEach(function (k) { t += '<tr><td>' + esc(k) + '</td><td class="num">' + items[k] + '</td></tr>'; });
  t += '</tbody></table>';
  $('#reportTables').innerHTML = t;

}

/* ---------- 期間を選んで見る実績（前日／前週／前月／当月） ---------- */
/**
 * 実績画面のKPI・上位一覧を、選んだ期間で作り直す。
 * ★ホームの「今月の実績」は当月固定のまま（前月比と推移グラフはそこにある）。
 *   こちらは期間を選べるかわりに比較を持たない、と役割を分けている。
 */
function loadPeriod(range) {
  S.storeRange = range || S.storeRange;
  $('#reportMonth2').textContent = '集計中…';
  api('reports.period', { range: S.storeRange }, 90000)
    .then(function (d) { S.data.period = d; renderPeriod(d); })
    .catch(function (e) { $('#reportMonth2').textContent = e.message; });
  loadStoreReport(S.storeRange, null);
}

function renderPeriod(d) {
  var span = d.from === d.to ? d.from.slice(5).replace('-', '/')
    : d.from.slice(5).replace('-', '/') + '〜' + d.to.slice(5).replace('-', '/');
  $('#reportMonth2').textContent = d.label + '（' + span + '）';
  $('#storeRangeEcho').textContent = d.label + '（' + span + '）';

  var n = d.shoki || {}, nk = d.nokisaki || {}, h = d.helper || {};
  $('#kpiRowFull').innerHTML =
    '<div class="kpi-group"><div class="kpi-group-head">初期設定</div><div class="kpi-row">' +
      kpi('件数', (n.total || 0).toLocaleString(), '件') +
      kpi('稼働日数', n.days || 0, '日') +
      kpi('店舗数', n.storeCount || 0, '店') +
    '</div></div>' +
    '<div class="kpi-group"><div class="kpi-group-head">出張販売／軒先</div><div class="kpi-row">' +
      kpi('PI', nk.pi || 0, '件') +
      kpi('声掛け', (nk.koe || 0).toLocaleString(), '件') +
      kpi('着座率', nk.sitRate || 0, '%') +
      kpi('成約率', nk.piRate || 0, '%') +
      kpi('店舗数', nk.storeCount || 0, '店') +
    '</div></div>' +
    '<div class="kpi-group"><div class="kpi-group-head">店内ヘルパー</div><div class="kpi-row">' +
      kpi('PI', h.pi || 0, '件') +
      kpi('記録数', h.records || 0, '件') +
      kpi('店舗数', h.storeCount || 0, '店') +
    '</div></div>';

  // 上位の店舗・スタッフもこの期間で
  var root = $('#periodTops');
  root.innerHTML = '';
  function box() { var e = document.createElement('div'); e.className = 'chart-box'; root.appendChild(e); return e; }
  if (n.topStores && n.topStores.length) {
    Charts.bars(box(), { title: '店舗別 件数（初期設定）', note: d.label + ' ' + span, items: n.topStores });
  }
  if (n.topStaff && n.topStaff.length) {
    Charts.bars(box(), { title: 'スタッフ別 件数（初期設定）', note: d.label + ' ' + span, items: n.topStaff });
  }
  if (nk.topStaff && nk.topStaff.length && nk.pi) {
    Charts.bars(box(), { title: 'スタッフ別 PI（軒先）', note: d.label + ' ' + span, items: nk.topStaff });
  }
}

$$('#periodRange .seg-btn').forEach(function (b) {
  b.addEventListener('click', function () {
    $$('#periodRange .seg-btn').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    loadPeriod(b.dataset.range);
  });
});

/* ---------- 店舗別の実績（区分ごとの項目） ---------- */
function loadStoreReport(range, kind) {
  S.storeRange = range || S.storeRange;
  S.storeKind = kind || S.storeKind;
  $('#storeRangeNote').textContent = '読み込み中…';
  $('#storeReport').innerHTML = '';
  api('reports.stores', { range: S.storeRange, kind: S.storeKind }, 90000)
    .then(function (d) {
      S.data.storeReport = d;
      renderStoreReport(d);
    })
    .catch(function (e) { $('#storeRangeNote').textContent = e.message; });
}

function renderStoreReport(d) {
  var span = d.from === d.to ? d.from.slice(5).replace('-', '/')
    : d.from.slice(5).replace('-', '/') + '〜' + d.to.slice(5).replace('-', '/');
  $('#storeRangeNote').textContent =
    d.kindLabel + '／' + d.label + '（' + span + '）／ ' + d.storeCount + '店舗' +
    (d.errors && d.errors.length ? ' ※' + d.errors.join(' ') : '');

  if (!d.stores.length) { $('#storeReport').innerHTML = '<div class="task-sub">この期間の実績はありません</div>'; return; }

  // 値が入っていない項目の列は出さない（軒先は商材が11列あり、空列だらけになるため）
  var cols = d.columns.filter(function (c) { return d.totals[c.key]; });
  if (!cols.length) cols = d.columns.slice(0, 3);

  var t = '<table class="tbl stack"><thead><tr><th>店舗</th>';
  cols.forEach(function (c) { t += '<th class="num">' + esc(c.label) + '</th>'; });
  t += '<th class="num">日数</th></tr></thead><tbody>';

  d.stores.forEach(function (s) {
    t += '<tr><td data-label="店舗">' + esc(s.name) + '</td>';
    cols.forEach(function (c) {
      var v = s.values[c.key] || 0;
      // スマホの縦積みでは0の項目を出さない（項目が多いので、動いたものだけ並ぶ方が読める）
      t += '<td class="num' + (v ? '' : ' zero-cell') + '" data-label="' + esc(c.short || c.label) + '">' +
        (v ? v : '<span class="zero">－</span>') + '</td>';
    });
    t += '<td class="num muted" data-label="稼働">' + s.days + '日</td></tr>';
  });

  t += '</tbody><tfoot><tr><td>合計</td>';
  cols.forEach(function (c) { t += '<td class="num">' + (d.totals[c.key] || 0) + '</td>'; });
  t += '<td></td></tr></tfoot></table>';
  $('#storeReport').innerHTML = t;
}

$$('#storeKind .seg-btn').forEach(function (b) {
  b.addEventListener('click', function () {
    $$('#storeKind .seg-btn').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    loadStoreReport(null, b.dataset.kind);
  });
});

/** 実績画面用。日別の推移だけ（期間の選択とは別軸なのでその旨を注記する） */
function drawTrends(root, r) {
  if (!root) return;
  root.innerHTML = '';
  var n = r.nippou, nk = r.nokisaki;
  function box() { var d = document.createElement('div'); d.className = 'chart-box'; root.appendChild(d); return d; }
  if (n && n.series) {
    Charts.line(box(), { title: '初期設定 日別件数', note: '直近14日の推移（上の期間指定とは別）',
      data: n.series, unit: '件', lastPending: true });
  }
  if (nk && nk.series) {
    Charts.line(box(), { title: '出張販売／軒先 日別PI', note: '直近14日の推移（上の期間指定とは別）', data: nk.series,
      color: getComputedStyle(document.documentElement).getPropertyValue('--series-2').trim(),
      unit: '件', lastPending: true });
  }
}

function drawCharts(root, r, count) {
  if (!root) return;
  root.innerHTML = '';
  var n = r.nippou, nk = r.nokisaki;
  var boxes = [];

  function box() { var d = document.createElement('div'); d.className = 'chart-box'; root.appendChild(d); return d; }

  if (n && n.series) {
    Charts.line(box(), { title: '店舗日報 日別件数', note: '直近14日（本日はまだ集計中）',
      data: n.series, unit: '件', lastPending: true });
  }
  if (n && n.topStores) {
    Charts.bars(box(), { title: '店舗別 合計件数', note: r.month + '（上位8店舗）', items: n.topStores, unit: '' });
  }
  if (count > 2 && nk && nk.series) {
    Charts.line(box(), { title: '軒先/出張販売 日別PI', note: '直近14日（本日はまだ集計中）', data: nk.series,
      color: getComputedStyle(document.documentElement).getPropertyValue('--series-2').trim(),
      unit: '件', lastPending: true });
  }
  if (count > 2 && n && n.topStaff) {
    Charts.bars(box(), { title: 'スタッフ別 合計件数', note: r.month + '（上位8名）', items: n.topStaff });
  }
  return boxes;
}

/* ---------- 店舗・出勤 ---------- */
var CH_CLASS = { shoki: 'c-shoki', nokisaki: 'c-nokisaki', helper: 'c-helper' };
S.chTab = 'shoki';

function renderOps() {
  var o = S.data.ops; if (!o) return;
  var att = o.attendance, st = o.stores;
  var stores = st.stores || [], ch = st.channels || {}, order = st.order || ['shoki', 'nokisaki', 'helper'];

  $('#attnSummary').textContent = '本日 ' + att.staffCount + '名 / ' + att.storeCount + '店舗' +
    (att.unreported.length ? ' ・未報告 ' + att.unreported.length : '');
  $('#attnCount').textContent = att.tab + ' ／ ' + att.staffCount + '名';

  /* 3区分のサマリ */
  $('#channelSummary').innerHTML = order.map(function (k) {
    var c = ch[k]; if (!c) return '';
    return '<div class="ch-card ' + CH_CLASS[k] + '">' +
      '<div class="ch-label">' + esc(c.label) + '</div>' +
      '<div class="ch-num">' + c.storeCount + '<small>店舗</small></div>' +
      '<div class="ch-sub">' + esc(c.metric) + ' ' + c.total.toLocaleString() +
        (k === 'nokisaki' && c.chaku ? '（着座' + c.chaku + '）' : '') +
        (k === 'shoki' && c.days ? '／' + c.days + '日稼働' : '') + '</div>' +
      (c.newStores ? '<div class="ch-new">★ 今月が初めての店 ' + c.newStores + '</div>' : '') +
      '</div>';
  }).join('');

  /* 初入店の予告 */
  var fv = st.firstVisits || [];
  $('#firstVisitBanner').innerHTML = fv.length
    ? '<div class="fv-banner">★ <b>初入店の予定が' + fv.length + '件</b>：' +
        fv.slice(0, 3).map(function (f) { return esc(f.when) + ' ' + esc(f.store); }).join('、') +
        '<button class="btn-link" data-view="stores" style="margin-left:8px">詳しく →</button></div>'
    : '';
  $('#firstVisitList').innerHTML = fv.map(function (f) {
    return '<div class="fv-row">' +
      '<span class="fv-when">' + esc(f.when) + '</span>' +
      '<span class="fv-store">' + esc(f.store) + '</span>' +
      (f.date ? '<span class="fv-why">' + esc(f.date) + '</span>' : '') +
      (f.staff ? '<span class="fv-why">担当：' + esc(f.staff) + '</span>' : '') +
      '<span class="fv-why">' + esc(f.reason) + (f.source ? '（' + esc(f.source) + '）' : '') + '</span>' +
      '</div>';
  }).join('');

  /* ホームのミニ一覧は当月いちばん動いている区分から */
  var mini = (ch.shoki && ch.shoki.stores.length ? ch.shoki : (ch.nokisaki || {})).stores || [];
  $('#storeMini').innerHTML = mini.slice(0, 8).map(function (s) {
    return '<div class="store-chip">' +
      '<div class="s-name">' + esc(s.name) + (s.isNew ? ' <span class="badge new-store">初</span>' : '') + '</div>' +
      '<div class="s-num">初期設定 ' + s.value + '件 ／ 今月' + s.days + '日</div>' +
      (s.staffToday.length ? '<div class="s-staff">今日：' + esc(s.staffToday.join('、')) + '</div>' : '') +
      '</div>';
  }).join('');

  renderStoreTable();

  // ★スマホでは表を縦積みにする（td の data-label が見出し代わりになる）。
  //   横スクロールしないと出勤スタッフが見えない、という状態を作らないため
  var th2 = '<thead><tr><th>店舗</th><th>出勤スタッフ</th><th>確認</th><th>備考</th></tr></thead>';
  $('#attnTable').className = 'tbl stack';
  $('#attnTable').innerHTML = th2 + '<tbody>' + (att.rows || []).map(function (r) {
    return '<tr><td data-label="店舗">' + esc(r.store) + '</td>' +
      '<td data-label="出勤">' + (esc(r.staff) || '<span class="zero">－</span>') + '</td>' +
      '<td data-label="確認">' + (r.unreported ? '<span class="badge warn">未報告</span>' : esc(r.checks.join(' ')) || '－') + '</td>' +
      '<td data-label="備考">' + esc(r.note) + '</td></tr>';
  }).join('') + '</tbody>';
}

function renderStoreTable() {
  var o = S.data.ops; if (!o) return;
  var st = o.stores, ch = st.channels || {}, k = S.chTab;

  if (k === 'all') {
    $('#chHead').innerHTML = '3区分をまとめた一覧　<b>' + (st.stores || []).length + '</b> 店舗';
    var th = '<thead><tr><th>店舗</th><th class="num">初期設定</th><th class="num">軒先PI</th><th class="num">ヘルパーPI</th>' +
      '<th>初回稼働</th><th class="num">稼働日数</th><th>本日の担当</th></tr></thead>';
    $('#storeTable').className = 'tbl stack';
    $('#storeTable').innerHTML = th + '<tbody>' + (st.stores || []).map(function (s) {
      return '<tr><td data-label="店舗">' + esc(s.name) + '</td>' +
        '<td class="num" data-label="設定">' + s.nippou + '</td>' +
        '<td class="num" data-label="軒先">' + s.pi + '</td>' +
        '<td class="num" data-label="店内">' + s.helperPi + '</td>' +
        '<td data-label="初回">' + esc(s.first || '－') + '</td>' +
        '<td class="num" data-label="稼働">' + (s.days || 0) + '</td>' +
        '<td data-label="担当">' + (s.staffToday.length ? '<span class="badge on">' + esc(s.staffToday.join('、')) + '</span>' : '<span class="badge">－</span>') + '</td></tr>';
    }).join('') + '</tbody>';
    return;
  }

  var c = ch[k];
  if (!c) { $('#storeTable').innerHTML = ''; $('#chHead').textContent = ''; return; }
  $('#chHead').innerHTML = esc(c.label) + '　<b>' + c.storeCount + '</b> 店舗　／　' + esc(c.metric) + ' <b>' + c.total.toLocaleString() + '</b>' +
    (k === 'nokisaki' ? '　／　声掛け ' + (c.koe || 0) + '・着座 ' + (c.chaku || 0) + '（着座率 ' + (c.sitRate || 0) + '%・成約率 ' + (c.piRate || 0) + '%）' : '') +
    (c.newStores ? '　／　<span class="ch-new">今月が初めての店 ' + c.newStores + '</span>' : '');

  var th3 = '<thead><tr><th>店舗</th><th class="num">' + esc(c.metric) + '</th><th>初回稼働</th><th class="num">稼働日数</th><th>本日の担当</th></tr></thead>';
  $('#storeTable').className = 'tbl stack';
  $('#storeTable').innerHTML = th3 + '<tbody>' + c.stores.map(function (s) {
    return '<tr><td data-label="店舗">' + esc(s.name) + (s.isNew ? ' <span class="badge new-store">今月が初</span>' : '') + '</td>' +
      '<td class="num" data-label="' + esc(c.metric) + '">' + s.value + '</td>' +
      '<td data-label="初回">' + esc(s.first || '－') + '</td>' +
      '<td class="num" data-label="稼働">' + s.days + '</td>' +
      '<td data-label="担当">' + (s.staffToday.length ? '<span class="badge on">' + esc(s.staffToday.join('、')) + '</span>' : '<span class="badge">－</span>') + '</td></tr>';
  }).join('') + '</tbody>';
}

$$('#chTabs .chtab').forEach(function (b) {
  b.addEventListener('click', function () {
    $$('#chTabs .chtab').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    S.chTab = b.getAttribute('data-ch');
    renderStoreTable();
  });
});

/* 店名から初入店かどうかを調べる */
function runStoreCheck() {
  var name = $('#storeCheckInput').value.trim();
  if (!name) return;
  $('#storeCheckResult').innerHTML = '<span class="muted">調べています…</span>';
  api('stores.check', { name: name }).then(function (d) {
    var rows = [];
    for (var k in d.channels) {
      var v = d.channels[k];
      if (v.days) rows.push(esc(v.label) + '：初回 ' + esc(v.first) + '・直近 ' + esc(v.last) + '・のべ' + v.days + '日');
    }
    $('#storeCheckResult').innerHTML =
      '<div class="check-verdict' + (d.known ? '' : ' new') + '">' + esc(d.name) + ' … ' + esc(d.verdict) + '</div>' +
      (rows.length ? rows.join('<br>') : '<span class="muted">初期設定・軒先・店内ヘルパーのいずれにも記録がありません</span>');
  }).catch(function (e) { $('#storeCheckResult').innerHTML = '<span class="muted">' + esc(e.message) + '</span>'; });
}
$('#btnStoreCheck').addEventListener('click', runStoreCheck);
$('#storeCheckInput').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); runStoreCheck(); } });

/* ---------- メンバー ---------- */
function loadMembers() {
  if (S.data.members) return renderMembers();
  $('#memberTable').innerHTML = '<tbody><tr><td>読み込み中…</td></tr></tbody>';
  api('members.list', {}).then(function (d) { S.data.members = d; renderMembers(); })
    .catch(function (e) { $('#memberTable').innerHTML = '<tbody><tr><td>' + esc(e.message) + '</td></tr></tbody>'; });
}
function renderMembers() {
  var d = S.data.members; if (!d) return;
  $('#memberCount').textContent = d.count + '名 ／ 本日出勤 ' + d.onDutyToday + ' ／ 要フォロー ' + d.needsAttention;
  var th = '<thead><tr><th>氏名</th><th>本日</th><th class="num">日報</th><th class="num">軒先PI</th><th class="num">稼働日</th><th>最終報告</th><th>気になる点</th></tr></thead>';
  $('#memberTable').innerHTML = th + '<tbody>' + d.members.map(function (m) {
    return '<tr><td>' + esc(m.name) + '</td>' +
      '<td>' + (m.onDutyToday ? '<span class="badge on">出勤</span>' : '<span class="badge">－</span>') + '</td>' +
      '<td class="num">' + m.nippou + '</td><td class="num">' + (m.pi + m.helperPi) + '</td>' +
      '<td class="num">' + m.days + '</td><td>' + esc(m.lastReport || '－') + '</td>' +
      '<td>' + (m.alerts.length ? '<span class="badge warn">' + esc(m.alerts.join(' / ')) + '</span>' : '') + '</td></tr>';
  }).join('') + '</tbody>';
}

/* ---------- ニュース ---------- */
var CAT_LABEL = { docomo: 'ドコモ', au: 'au/UQ', softbank: 'SB/Y!mobile', rakuten: '楽天モバイル',
                  maker: 'メーカー', industry: '業界', internal: '社内', client: 'クライアント',
                  carrier: 'キャリア' };   // carrier は4分割前のデータ用に残す

function newsItemHtml(x) {
  var isAnn = !x.source;
  // 自動抽出は本文の末尾に「（出典：…）」を付けているので、そこだけ切り離して小さく出す
  var body = x.body || '', origin = '';
  var m = body.match(/\n?（出典：(.+?)）\s*$/);
  if (m) { origin = m[1]; body = body.slice(0, m.index).trim(); }

  var meta = [x.tag ? '<span class="news-tag">' + esc(x.tag) + '</span>' : '',
              x.level === '重要' ? '<span class="news-tag">重要</span>' : '',
              x.source ? esc(x.source) : (x.author ? esc(x.author) : ''),
              origin ? esc(origin) : '',
              esc(fmtWhen(x.date))].filter(Boolean).join('<span>・</span>');
  var cls = 'news-item' + (x.level === '重要' ? ' level-important' : '');
  var inner = '<div class="news-title">' + esc(x.title) + '</div>' +
    (isAnn && body ? '<div class="ann-body">' + esc(body) + '</div>' : '') +
    '<div class="news-meta">' + meta + '</div>';
  return x.url
    ? '<a class="' + cls + '" href="' + esc(x.url) + '" target="_blank" rel="noopener">' + inner + '</a>'
    : '<div class="' + cls + '">' + inner + '</div>';
}

function renderNews() {
  var d = S.data.news; if (!d) return;
  var cats = d.categories || {};
  var rows = cats[S.newsCat] || [];
  $('#newsBody').innerHTML = rows.map(newsItemHtml).join('');

  // 詳細ビュー用のタグ一覧
  var sel = $('#newsTagFilter');
  if (!sel.options.length) {
    sel.innerHTML = '<option value="">すべて</option>' +
      Object.keys(CAT_LABEL).map(function (c) { return '<option value="cat:' + c + '">' + CAT_LABEL[c] + '</option>'; }).join('');
  }
  renderNewsFull();
}

function renderNewsFull() {
  var d = S.data.news; if (!d) return;
  var v = $('#newsTagFilter').value;
  var cats = d.categories || {};
  var out = [];
  Object.keys(cats).forEach(function (c) {
    if (v && v !== 'cat:' + c) return;
    out.push('<h3 style="font-size:14px;margin:16px 0 6px">' + (CAT_LABEL[c] || c) + '</h3>');
    out.push((cats[c] || []).map(newsItemHtml).join(''));
  });
  $('#newsFull').innerHTML = out.join('');
}

// カテゴリを選んだら、その分野の記事をサーバーから多めに取り直す
function loadNewsCategory(cat) {
  api('news.list', { category: cat, limit: 30 }).then(function (d) {
    S.data.news.categories[cat] = d.rows || [];
    renderNews();
  }).catch(function () { });
}

/* ---------- 集中モード ---------- */
function openFocus() {
  var d = S.data.tasks;
  if (!d) return toast('タスクを読み込み中です', true);
  S.focus.queue = d.active.slice(0, 20);
  S.focus.i = 0;
  if (!S.focus.queue.length) return toast('進めるタスクがありません');
  $('#focus').classList.remove('hidden');
  renderFocus();
}
function renderFocus() {
  var f = S.focus, t = f.queue[f.i];
  if (!t) {
    $('#focusName').textContent = 'お疲れさまでした';
    $('#focusMeta').innerHTML = ''; $('#focusNext').textContent = '';
    $('#focusCount').textContent = '';
    $('#focusBar').style.width = '100%';
    return;
  }
  $('#focusCount').textContent = (f.i + 1) + ' / ' + f.queue.length;
  $('#focusBar').style.width = (f.i / f.queue.length * 100) + '%';
  $('#focusName').textContent = t.name;
  $('#focusMeta').innerHTML = [
    t.category ? '<span>' + esc(t.category) + '</span>' : '',
    t.priority ? '<span>優先度 ' + esc(t.priority) + '</span>' : '',
    t.notifyDate ? '<span>' + esc(relDate(t.notifyDate)) + '</span>' : '',
  ].join('');
  $('#focusNext').textContent = t.next ? '次の一手：' + t.next : (t.last ? '前回：' + t.last : '');
}
function focusAdvance() { S.focus.i++; renderFocus(); }
function focusAction(kind) {
  var t = S.focus.queue[S.focus.i];
  if (!t) return;
  if (kind === 'done') {
    api('tasks.done', { id: t.id }).then(function () { toast('完了にしました'); }).catch(function (e) { toast(e.message, true); });
  } else if (kind === 'snooze') {
    api('tasks.snooze', { id: t.id, days: 3 }).then(function () { toast('3日後に回しました'); }).catch(function (e) { toast(e.message, true); });
  }
  focusAdvance();
}
$('#fbDone').addEventListener('click', function () { focusAction('done'); });
$('#fbSnooze').addEventListener('click', function () { focusAction('snooze'); });
$('#fbSkip').addEventListener('click', focusAdvance);
$('#focusClose').addEventListener('click', function () {
  $('#focus').classList.add('hidden');
  loadAll(true);
});
document.addEventListener('keydown', function (ev) {
  if ($('#focus').classList.contains('hidden')) return;
  if (ev.key === '1') focusAction('done');
  else if (ev.key === '2') focusAction('snooze');
  else if (ev.key === 'ArrowRight') focusAdvance();
  else if (ev.key === 'Escape') $('#focusClose').click();
});

/* ---------- タスク追加 ---------- */
function openAdd() {
  $('#addSheet').classList.remove('hidden');
  setTimeout(function () { $('#fName').focus(); }, 50);
}
$('#fab').addEventListener('click', openAdd);
$('#btnAddTop').addEventListener('click', openAdd);
$('#btnAddTask').addEventListener('click', openAdd);
$('#addClose').addEventListener('click', function () { $('#addSheet').classList.add('hidden'); });
$('#addSheet').addEventListener('click', function (ev) { if (ev.target.id === 'addSheet') $('#addSheet').classList.add('hidden'); });

$$('#notifyChips .chip').forEach(function (c) {
  c.addEventListener('click', function () {
    $$('#notifyChips .chip').forEach(function (x) { x.classList.remove('on'); });
    c.classList.add('on');
    var d = c.getAttribute('data-d');
    $('#fNotify').value = d === '' ? '' : plusDays(Number(d));
  });
});

$('#addForm').addEventListener('submit', function (ev) {
  ev.preventDefault();
  var btn = $('#addSubmit');
  btn.disabled = true; btn.textContent = '追加中…';
  api('tasks.add', {
    name: $('#fName').value.trim(),
    category: $('#fCat').value.trim(),
    priority: $('#fPrio').value,
    next: $('#fNext').value.trim(),
    notifyDate: $('#fNotify').value,
  }).then(function () {
    toast('追加しました');
    $('#addForm').reset();
    $$('#notifyChips .chip').forEach(function (x) { x.classList.remove('on'); });
    $('#addSheet').classList.add('hidden');
    loadAll(true);
  }).catch(function (e) { toast(e.message, true); })
    .then(function () { btn.disabled = false; btn.textContent = '追加する'; });
});

/* ---------- 社内トピックスの取り込み ---------- */
$('#btnTopics').addEventListener('click', function () {
  var b = $('#btnTopics');
  b.disabled = true; b.textContent = '取り込み中…';
  toast('LINE WORKSと議事録から拾っています（1分ほどかかります）');
  // AIを通すので30秒を超えることがある。返事が来なくても処理は続くので、待ってから読み直す
  api('topics.refresh', {}, 120000)
    .then(function (r) {
      toast('社内' + r.internal + '件・クライアント' + r.client + '件を取り込みました');
      return api('hub', { section: 'news', fresh: 1 });
    })
    .catch(function () {
      toast('取り込みに時間がかかっています。結果を読み直します');
      return new Promise(function (res) { setTimeout(res, 8000); })
        .then(function () { return api('hub', { section: 'news', fresh: 1 }); });
    })
    .then(function (r) { if (r) { S.data.news = r.data; renderNews(); } })
    .catch(function (e) { toast(e.message, true); })
    .then(function () { b.disabled = false; b.textContent = '社内を取り込む'; });
});

/* ---------- お知らせ投稿 ---------- */
$('#btnPost').addEventListener('click', function () { $('#postSheet').classList.remove('hidden'); });
$('#postClose').addEventListener('click', function () { $('#postSheet').classList.add('hidden'); });
$('#postForm').addEventListener('submit', function (ev) {
  ev.preventDefault();
  api('news.add', {
    category: $('#pCat').value, title: $('#pTitle').value.trim(),
    body: $('#pBody').value.trim(), level: $('#pLevel').value, link: $('#pLink').value.trim(),
  }).then(function () {
    toast('投稿しました');
    $('#postForm').reset();
    $('#postSheet').classList.add('hidden');
    api('hub', { section: 'news', fresh: 1 }).then(function (r) { S.data.news = r.data; renderNews(); });
  }).catch(function (e) { toast(e.message, true); });
});

/* ---------- ビュー切替 ---------- */
function switchView(v) {
  S.view = v;
  $$('.view').forEach(function (s) { s.classList.add('hidden'); });
  $('#view-' + v).classList.remove('hidden');
  $$('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-view') === v); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (v === 'members') loadMembers();
  if (v === 'hanbai' && !HB.data) hbLoad();   // 開いたときだけ取りに行く（起動を重くしない）
  location.hash = v;
}
document.addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-view]');
  if (!b) return;
  switchView(b.getAttribute('data-view'));
});
$('#taskFilter').addEventListener('change', renderAllTasks);
$('#newsTagFilter').addEventListener('change', renderNewsFull);
$$('#newsTabs .ntab').forEach(function (b) {
  b.addEventListener('click', function () {
    $$('#newsTabs .ntab').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    S.newsCat = b.getAttribute('data-cat');
    renderNews();
    if ((S.data.news.categories[S.newsCat] || []).length <= 6) loadNewsCategory(S.newsCat);
  });
});
$('#btnFocus').addEventListener('click', openFocus);
$('#btnRefresh').addEventListener('click', function () {
  toast('最新に更新しています…');
  S.data.members = null;
  loadAll(true);
});
$('#btnTheme').addEventListener('click', function () {
  var cur = document.documentElement.getAttribute('data-theme');
  var next = cur === 'dark' ? 'light' : (cur === 'light' ? '' : 'dark');
  if (next) document.documentElement.setAttribute('data-theme', next);
  else document.documentElement.removeAttribute('data-theme');
  localStorage.setItem('hub_theme', next);
});

/* ---------- 起動 ---------- */
(function init() {
  var th = localStorage.getItem('hub_theme');
  if (th) document.documentElement.setAttribute('data-theme', th);

  if (!S.token) { showLogin(); return; }
  showApp();
  loadAll();
  var h = (location.hash || '').replace('#', '');
  if (h && $('#view-' + h)) switchView(h);

  // 画面を開きっぱなしにしても数字が古くならないように
  setInterval(function () { if (!document.hidden) loadAll(); }, 10 * 60 * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) loadAll(); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { });
})();

/* ============================================================================
 * 販売スタッフ（稼働・ヒアリング）  2026-09-04
 * ----------------------------------------------------------------------------
 * ★データの持ち主は shift-automation 側のWebアプリ。hub のAPIとは別物なので、
 *   専用の呼び出し関数を用意する（api() は hub のAPIを叩く作りのため流用できない）。
 * ★秘密は一切ここに書かない。**hubのログイン証(S.token)をそのまま渡し**、
 *   向こう側が hub に「この証は本物か」を問い合わせて判定する。
 *   だからこのファイルが公開されても、何も漏れない。
 * ============================================================================ */
// ★本番の窓口URLとは別のデプロイを使う。ここは公開リポジトリに載るので、
//   書き込み系まで通る本番URLを外に出さないため（合言葉が無ければどちらも弾かれるが、
//   そもそも在り処を知らせない方がよい）
var HB_API = 'https://script.google.com/macros/s/AKfycbyPH5RnBVwC_GmADmgseF3FX_vBohTlg12qHwmuOvKROezKHbrEUbJcoS6e_pEJKog-Ug/exec';
var HB = { data: null, tab: 'watch', picked: null, loading: false };

function hbCall(op, params) {
  return new Promise(function (resolve, reject) {
    var cb = 'hbcb_' + Math.random().toString(36).slice(2);
    var s = document.createElement('script'), done = false;
    var timer = setTimeout(function () {
      if (!done) { cleanup(); reject(new Error('時間内に応答がありませんでした')); }
    }, 45000);
    function cleanup() {
      done = true; clearTimeout(timer);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      if (s.parentNode) s.parentNode.removeChild(s);
    }
    window[cb] = function (res) {
      cleanup();
      if (res && res.ok) resolve(res.data === undefined ? res : res.data);
      else reject(new Error((res && res.error) || '不明なエラー'));
    };
    var q = new URLSearchParams();
    q.set('hub', op);
    q.set('callback', cb);
    q.set('t', S.token || '');
    for (var k in (params || {})) if (params[k] !== undefined && params[k] !== null) q.set(k, params[k]);
    s.src = HB_API + '?' + q.toString();
    s.onerror = function () { if (!done) { cleanup(); reject(new Error('サーバーに接続できません')); } };
    document.head.appendChild(s);
  });
}

function hbEsc(s) { return esc(s); }
function hbPct(s) { var m = String(s).match(/-?\d+/); return m ? Number(m[0]) : null; }
/** 行の列番号をそのまま使うと必ず間違えるので、名前つきの箱に直す */
function hbS(r) {
  return { name: r[0], kubun: r[1], store: r[2], days: +r[3] || 0, koe: +r[4] || 0,
    catch: +r[5] || 0, sit: +r[6] || 0, perDay: r[7], avg: r[8], diff: r[9],
    pi: +r[10] || 0, prev: r[11], level: r[12], closer: r[13], state: r[14],
    next: r[15], updated: r[16] };
}

function hbLoad(fresh) {
  if (HB.loading) return;
  HB.loading = true;
  $('#hbSub').textContent = '読み込み中…';
  hbCall('get', fresh ? { fresh: 1 } : null).then(function (d) {
    HB.loading = false;
    HB.data = d;
    hbRender();
  }).catch(function (e) {
    HB.loading = false;
    $('#hbSub').textContent = '読み込めませんでした';
    $('#hbBody').innerHTML = '<div class="hb-card"><div class="hb-empty">' +
      hbEsc(e.message) + '</div></div>';
  });
}

function hbRender() {
  var d = HB.data;
  if (!d) return;
  $('#hbSub').textContent = (d.対象月 ? d.対象月 + ' の数字　·　' : '') + 'スタッフ ' + d.staff.length + '名';
  var el = $('#hbBody');
  if (HB.picked) { el.innerHTML = hbDetail(HB.picked); return hbBind(); }
  if (HB.tab === 'watch') el.innerHTML = hbWatch();
  if (HB.tab === 'list')  el.innerHTML = hbList();
  if (HB.tab === 'add')   el.innerHTML = hbForm();
  hbBind();
}

function hbWatch() {
  var f = HB.data.findings;
  if (!f.length) return '<div class="hb-card"><div class="hb-empty">' +
    'いま大きく上振れ・下振れしている人はいません。</div></div>';
  return f.map(function (x) {
    var cls = /上振れ|伸びた/.test(x[0]) ? 'up' : 'down';
    return '<div class="hb-card"><div class="hb-find ' + cls + '">' +
      '<div class="t">' + hbEsc(x[0]) + '　' + hbEsc(x[1]) + '</div>' +
      '<div class="d">' + hbEsc(x[2]) + '</div>' +
      '<div class="d"><b>' + hbEsc(x[3]) + '</b>　（' + hbEsc(x[4]) + '　' + hbEsc(x[5]) + '）</div>' +
      '<div class="a">' + hbEsc(x[6]) + '</div></div>' +
      '<div style="margin-top:10px"><button class="hb-ghost" data-hbopen="' + hbEsc(x[1]) +
      '">この人を見る</button></div></div>';
  }).join('');
}

function hbList() {
  var all = HB.data.staff.map(hbS);
  var act = all.filter(function (s) { return s.days > 0; });
  var zero = all.filter(function (s) { return s.days === 0; });
  var max = Math.max.apply(null, act.map(function (s) { return s.sit; }).concat([1]));
  var h = '<div class="hb-f" style="margin-bottom:10px">' +
    '<input id="hbQ" placeholder="名前でしぼる" autocomplete="off"></div><div id="hbCards">';
  h += act.map(function (s) {
    var d = hbPct(s.diff);
    var pill = d === null ? '<span class="hb-pill flat">比較なし</span>'
      : '<span class="hb-pill ' + (d >= 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + d + '%</span>';
    return '<div class="hb-card tap" data-hbopen="' + hbEsc(s.name) + '">' +
      '<div class="hb-row"><div><div class="hb-name">' + hbEsc(s.name) + '</div>' +
      '<div class="hb-meta">' + hbEsc(s.store || '—') + (s.kubun ? '　·　' + hbEsc(s.kubun) : '') +
      '</div></div>' + pill + '</div>' +
      '<div class="hb-nums">' +
        '<div class="hb-num"><b>' + s.sit + '</b><span>着座</span></div>' +
        '<div class="hb-num"><b>' + hbEsc(s.perDay) + '</b><span>1日あたり</span></div>' +
        '<div class="hb-num"><b>' + hbEsc(s.avg || '—') + '</b><span>同じ店の平均</span></div>' +
        '<div class="hb-num"><b>' + s.days + '</b><span>稼働日</span></div></div>' +
      '<div class="hb-bar"><i style="width:' + Math.round(s.sit / max * 100) + '%"></i></div></div>';
  }).join('');
  h += '</div>';
  if (zero.length) h += '<div class="hb-h2">今月の稼働なし（' + zero.length + '名）</div>' +
    '<div class="hb-card"><div class="hb-meta">' +
    zero.map(function (s) { return hbEsc(s.name); }).join('　·　') + '</div></div>';
  return h;
}

function hbDetail(name) {
  var row = HB.data.staff.filter(function (r) { return r[0] === name; })[0] || [name];
  var s = hbS(row);
  var ms = HB.data.months.filter(function (r) { return r[0] === name; });
  var fs = HB.data.findings.filter(function (r) { return r[1] === name; });
  var hs = HB.data.hearings.filter(function (r) { return r[1] === name; }).reverse();
  var d = hbPct(s.diff);
  var h = '<div style="margin-bottom:12px"><button class="hb-ghost" data-hbback="1">← もどる</button></div>';
  h += '<div class="hb-card"><div class="hb-row"><div>' +
    '<div class="hb-name" style="font-size:21px">' + hbEsc(name) + '</div>' +
    '<div class="hb-meta">' + hbEsc(s.store || '—') + (s.kubun ? '　·　' + hbEsc(s.kubun) : '') + '</div></div>' +
    (d === null ? '<span class="hb-pill flat">比較なし</span>'
                : '<span class="hb-pill ' + (d >= 0 ? 'up' : 'down') + '">' + (d > 0 ? '+' : '') + d + '%</span>') +
    '</div><div class="hb-nums">' +
      '<div class="hb-num"><b>' + s.sit + '</b><span>着座</span></div>' +
      '<div class="hb-num"><b>' + hbEsc(s.perDay) + '</b><span>1日あたり</span></div>' +
      '<div class="hb-num"><b>' + hbEsc(s.avg || '—') + '</b><span>同じ店の平均</span></div>' +
      '<div class="hb-num"><b>' + s.days + '</b><span>稼働日</span></div></div></div>';

  if (fs.length) {
    h += '<div class="hb-h2">気になっていること</div>';
    fs.forEach(function (x) {
      var cls = /上振れ|伸びた/.test(x[0]) ? 'up' : 'down';
      h += '<div class="hb-card"><div class="hb-find ' + cls + '">' +
        '<div class="t">' + hbEsc(x[0]) + '</div>' +
        '<div class="d">' + hbEsc(x[2]) + '　<b>' + hbEsc(x[3]) + '</b>（' + hbEsc(x[4]) + '）</div>' +
        '<div class="a">' + hbEsc(x[6]) + '</div></div></div>';
    });
  }

  h += '<div class="hb-h2">月ごとの数字</div><div class="hb-card"><table class="hb-tbl">' +
    '<tr><th>月</th><th>稼働</th><th>キャッチ</th><th>着座</th><th>1日</th><th>PI</th></tr>';
  if (!ms.length) h += '<tr><td colspan="6" style="text-align:left;opacity:.55">まだありません</td></tr>';
  ms.forEach(function (m) {
    var per = (+m[2] > 0) ? (+m[5] / +m[2]).toFixed(1) : '—';
    h += '<tr><td>' + hbEsc(m[1]) + '</td><td>' + hbEsc(m[2]) + '</td><td>' + hbEsc(m[4]) +
      '</td><td><b>' + hbEsc(m[5]) + '</b></td><td>' + per + '</td><td>' + hbEsc(m[7]) + '</td></tr>';
  });
  h += '</table></div>';

  h += '<div class="hb-h2">この人のこと（保存できます）</div><div class="hb-card hb-f">' +
    '<label>レベル</label><input id="hbLevel" value="' + hbEsc(s.level) + '" placeholder="例）キャッチのみ／クローザー可">' +
    '<label>クローザー志望</label><select id="hbCloser">' +
      ['', 'あり', 'なし', '検討中'].map(function (v) {
        return '<option' + (v === s.closer ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select>' +
    '<label>直近の状態</label><textarea id="hbState" placeholder="いまどんな様子か">' + hbEsc(s.state) + '</textarea>' +
    '<label>次にやること</label><input id="hbNext" value="' + hbEsc(s.next) + '" placeholder="例）三觜さんに同行してもらう">' +
    '<button class="hb-go" data-hbsave="' + hbEsc(name) + '">保存する</button>' +
    (s.updated ? '<div class="hb-meta" style="margin-top:8px">最終更新 ' + hbEsc(s.updated) + '</div>' : '') +
    '</div>';

  h += '<div class="hb-h2">ヒアリングの記録</div><div class="hb-card">';
  if (!hs.length) h += '<div class="hb-empty" style="padding:6px 0">まだありません</div>';
  else hs.forEach(function (r) {
    h += '<div class="hb-hear"><div class="h">' + hbEsc(r[0]) +
      (r[2] ? '　聞いた人 ' + hbEsc(r[2]) : '') + '</div><div>' + hbEsc(r[3]) + '</div>' +
      (r[4] ? '<div class="n">→ ' + hbEsc(r[4]) + '</div>' : '') + '</div>';
  });
  h += '<div style="margin-top:12px"><button class="hb-ghost" data-hbadd="' + hbEsc(name) +
    '">記録を足す</button></div></div>';
  return h;
}

function hbForm(pre) {
  var names = HB.data.staff.map(function (r) { return r[0]; });
  return '<div class="hb-h2">ヒアリングを記録する</div><div class="hb-card hb-f">' +
    '<label>対象者</label><select id="hbHName">' +
      names.map(function (n) {
        return '<option' + (n === pre ? ' selected' : '') + '>' + hbEsc(n) + '</option>'; }).join('') + '</select>' +
    '<label>日付</label><input id="hbHDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '">' +
    '<label>聞いた人</label><input id="hbHBy" value="' + hbEsc((S.user && S.user.name) || '') + '">' +
    '<label>内容</label><textarea id="hbHText" placeholder="話したこと・本人が言っていたこと"></textarea>' +
    '<label>次の一手</label><input id="hbHNext" placeholder="例）来週の二俣川で同行">' +
    '<button class="hb-go" id="hbHGo">保存する</button></div>';
}

function hbVal(id) { var e = $('#' + id); return e ? e.value : ''; }

function hbBind() {
  $$('[data-hbopen]').forEach(function (b) {
    b.onclick = function (ev) {
      ev.stopPropagation();
      HB.picked = b.getAttribute('data-hbopen');
      window.scrollTo({ top: 0, behavior: 'smooth' });
      hbRender();
    };
  });
  $$('[data-hbback]').forEach(function (b) {
    b.onclick = function () { HB.picked = null; window.scrollTo({ top: 0, behavior: 'smooth' }); hbRender(); };
  });
  $$('[data-hbadd]').forEach(function (b) {
    b.onclick = function () {
      var n = b.getAttribute('data-hbadd');
      HB.picked = null; HB.tab = 'add';
      $$('#hbTabs .hb-tab').forEach(function (x) {
        x.classList.toggle('active', x.getAttribute('data-hb') === 'add'); });
      $('#hbBody').innerHTML = hbForm(n);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      hbBind();
    };
  });

  var q = $('#hbQ');
  if (q) q.oninput = function () {
    var v = q.value.trim();
    $$('#hbCards .hb-card').forEach(function (c) {
      c.style.display = (!v || c.getAttribute('data-hbopen').indexOf(v) >= 0) ? '' : 'none';
    });
  };

  var save = document.querySelector('[data-hbsave]');
  if (save) save.onclick = function () {
    var name = save.getAttribute('data-hbsave');
    save.disabled = true; save.textContent = '保存中…';
    var v = { lv: hbVal('hbLevel'), cl: hbVal('hbCloser'), st: hbVal('hbState'), nx: hbVal('hbNext') };
    hbCall('note', { n: name, lv: v.lv, cl: v.cl, st: v.st, nx: v.nx }).then(function () {
      save.disabled = false; save.textContent = '保存する';
      var row = HB.data.staff.filter(function (r) { return r[0] === name; })[0];
      if (row) { row[12] = v.lv; row[13] = v.cl; row[14] = v.st; row[15] = v.nx; }
      toast('保存しました');
    }).catch(function (e) {
      save.disabled = false; save.textContent = '保存する'; toast(e.message, true);
    });
  };

  var go = $('#hbHGo');
  if (go) go.onclick = function () {
    if (!hbVal('hbHText').trim()) return toast('内容を書いてください', true);
    go.disabled = true; go.textContent = '保存中…';
    var rec = [hbVal('hbHDate'), hbVal('hbHName'), hbVal('hbHBy'), hbVal('hbHText'), hbVal('hbHNext')];
    hbCall('hear', { d: rec[0], n: rec[1], by: rec[2], tx: rec[3], nx: rec[4] }).then(function () {
      go.disabled = false; go.textContent = '保存する';
      HB.data.hearings.push(rec);
      HB.picked = rec[1];
      window.scrollTo({ top: 0, behavior: 'smooth' });
      hbRender();
      toast('記録しました');
    }).catch(function (e) {
      go.disabled = false; go.textContent = '保存する'; toast(e.message, true);
    });
  };
}

$$('#hbTabs .hb-tab').forEach(function (b) {
  b.addEventListener('click', function () {
    $$('#hbTabs .hb-tab').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    HB.tab = b.getAttribute('data-hb');
    HB.picked = null;
    hbRender();
  });
});
$('#hbReload').addEventListener('click', function () { HB.picked = null; hbLoad(true); });
