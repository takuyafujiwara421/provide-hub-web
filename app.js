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
  data: { tasks: null, reports: null, ops: null, news: null, storeReport: null, period: null },
  newsCat: 'docomo',
  storeRange: 'thismonth',
  storeKind: 'shoki',
  doneIds: {},      // 完了を押したタスク。司令塔の反映が追いつくまで画面から外す
  focus: { queue: [], i: 0 },
};

/* ============================================================================
 * 通信
 * ★2026-09-08：ブラウザが**別のGoogleアカウントでログイン中**だと、
 *   telekids所有のこのGASが弾かれて「サーバーに接続できません」になっていた
 *   （拓矢さんのタブレットで発生。Chrome自体が別アカウントでサインインしていた）。
 *
 *   URLに `authuser` を足すとどのアカウントで開くか指定できる。
 *   弾かれたら **0 → 1 → 2 → …と順に付け替えて自動で試し直す**。
 *   一度通った指定は覚えておき、次からは最初からそれを使う。
 *   ★これで、使う人はアカウントを気にしなくてよくなる。
 * ========================================================================== */
var _seq = 0;
var AUTH_KEY = 'hub_authuser';
var AUTH_TRIES = ['', '0', '1', '2', '3'];   // '' ＝ 指定なし（ふつうはこれで通る）

function authNow() {
  try { return localStorage.getItem(AUTH_KEY) || ''; } catch (e) { return ''; }
}
function authRemember(v) {
  try { if (v) localStorage.setItem(AUTH_KEY, v); else localStorage.removeItem(AUTH_KEY); } catch (e) {}
}

function api(action, params, timeoutMs) {
  // 覚えている指定を先頭にして、残りを順に試す
  var remembered = authNow();
  var order = AUTH_TRIES.slice();
  if (remembered) {
    order = [remembered].concat(order.filter(function (x) { return x !== remembered; }));
  }
  return apiTry(action, params, timeoutMs, order, 0);
}

function apiTry(action, params, timeoutMs, order, i) {
  return new Promise(function (resolve, reject) {
    var au = order[i];
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
      authRemember(au);            // ★通った指定を覚える
      if (res && res.ok) resolve(res.data);
      else reject(new Error((res && res.error) || '不明なエラー'));
    };

    var q = new URLSearchParams();
    q.set('action', action);
    q.set('callback', cb);
    if (S.token) q.set('token', S.token);
    for (var k in (params || {})) if (params[k] !== undefined && params[k] !== null && params[k] !== '') q.set(k, params[k]);
    if (au) q.set('authuser', au);

    s.src = API + '?' + q.toString();
    s.onerror = function () {
      if (done) return;
      cleanup();
      // ★別のアカウント指定でもう一度。全部だめなら諦める
      if (i + 1 < order.length) {
        apiTry(action, params, timeoutMs, order, i + 1).then(resolve, reject);
        return;
      }
      authRemember('');            // 覚えていた指定が効かなくなったら忘れる
      reject(new Error('サーバーに接続できません。ブラウザが別のGoogleアカウントでログインしていないか確認してください'));
    };
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
  debutLoad(fresh);
  ['tasks', 'reports', 'ops', 'news'].forEach(function (sec) {
    api('hub', { section: sec, fresh: fresh ? 1 : '' })
      .then(function (r) {
        S.data[sec] = r.data;
        renderSection(sec);
      })
      .catch(function (e) {
        if (/UNAUTHORIZED|ログインが必要/.test(e.message)) { logout(); return; }
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
  // ★2026-09-07 ホームの「今日の稼働」に続いて、上部の稼働モードのバッジも外した（拓矢さん指示）。
  //   モード自体はタスクの出し分けに今も使っているので、サーバー側の判定は残してある。
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
  // ★2026-09-07 ホームの「今日のタスク」を外し、タスクタブもMTGのToDoに置き換えた。
  //   司令塔のデータ自体は「初入店の予定」などで使い続けるので取得は残す。
  var cats = {};
  d.active.forEach(function (t) { if (t.category) cats[t.category] = 1; });
  $('#catList').innerHTML = Object.keys(cats).map(function (c) { return '<option value="' + esc(c) + '">'; }).join('');
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
  var rm = $('#reportMonth');
  if (rm) rm.textContent = r.month + ' 時点';

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
  drawCharts($('#homeCharts'), r, 2);
  // ★2026-09-09 実績タブは作り直した（RP.*）。ここからは触らない。
  //   推移グラフはホームにあるので、実績タブでは店舗別の数字に絞っている。

}

/* ---------- 期間を選んで見る実績（前日／前週／前月／当月） ---------- */
/**
 * 実績画面のKPI・上位一覧を、選んだ期間で作り直す。
 * ★ホームの「今月の実績」は当月固定のまま（前月比と推移グラフはそこにある）。
 *   こちらは期間を選べるかわりに比較を持たない、と役割を分けている。
 */
/* ============================================================
 * 実績  2026-09-09 作り直し
 * ------------------------------------------------------------
 * 拓矢さんの依頼：
 *   「実績の中で初期設定と、出張販売・店内の2つに分けて欲しい。
 *     その中でも当日実績（矢印で前日も見れる）。出勤情報から日報提出してない人も反映。
 *     もう1つは当月と前月実績を出せるように。店舗別でOK。
 *     項目は初期設定は数字がある部分は全部出して」
 *
 * ★構成
 *   ① 上の切替  … 初期設定 ／ 出張販売・店内
 *   ② 当日の実績 … ← → で日を動かす（店舗別）
 *   ③ 日報の提出状況 … その日の出勤者のうち、記録を出していない人
 *   ④ 月の実績  … 当月／前月（店舗別）
 *
 * ★「出張販売・店内」は元データが2つ（軒先ダッシュボードと店内ヘルパー）ある。
 *   数える単位が同じPIなので、この画面では**続けて2つの表**にして並べる。
 *   1つの表に混ぜると、どちらの数字か分からなくなる。
 * ============================================================ */
var RP = {
  kind: 'shoki',          // shoki / hanbai
  date: null,             // 当日実績で見ている日
  month: 'thismonth',
};

function rpToday() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }

function rpInit() {
  if (!RP.date) RP.date = rpToday();
  rpLoadDay();
  rpLoadMonth();
}

/** 見ている日を n 日動かす。
 *  ★toISOString() は UTC で返すので、JSTの0時をそのまま渡すと**1日戻る**。
 *    +9時間してから切り出すこと（2026-09-09に1回で2日戻る不具合を出した）。 */
function rpShift(n) {
  var d = new Date(RP.date + 'T00:00:00+09:00');
  d.setDate(d.getDate() + n);
  var s = new Date(d.getTime() + 9 * 3600000).toISOString().slice(0, 10);
  if (s > rpToday()) return;              // 先の日は見ない
  RP.date = s;
  rpLoadDay();
}

/* ---------- ② 当日の実績 ---------- */
function rpLoadDay() {
  var lbl = $('#rpDate');
  if (lbl) lbl.textContent = rpDateLabel(RP.date);
  var nx = $('#rpNext');
  if (nx) nx.disabled = (RP.date >= rpToday());
  $('#rpDayBody').innerHTML = '<div class="task-sub">読み込み中…</div>';
  $('#rpUnsent').innerHTML = '<div class="task-sub">読み込み中…</div>';

  var kinds = (RP.kind === 'shoki') ? ['shoki'] : ['nokisaki', 'helper'];
  Promise.all(kinds.map(function (k) {
    return api('reports.stores', { range: 'day', date: RP.date, kind: k }, 90000)
      .catch(function (e) { return { kind: k, error: e.message, stores: [], columns: [], totals: {} }; });
  })).then(function (list) {
    $('#rpDayBody').innerHTML = list.map(function (d) {
      return rpStoreTable(d, kinds.length > 1);
    }).join('');
  });

  api('nippou.status', { date: RP.date }, 120000)
    .then(function (d) { rpRenderUnsent(d); })
    .catch(function (e) { $('#rpUnsent').innerHTML = '<div class="task-sub">' + esc(e.message) + '</div>'; });
}

function rpDateLabel(s) {
  if (!s) return '';
  var d = new Date(s + 'T00:00:00+09:00');
  var w = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  return s.slice(5).replace('-', '/') + '（' + w + '）' + (s === rpToday() ? '　今日' : '');
}

/** 店舗別の表を1つ作る（当日でも月でも同じ形） */
function rpStoreTable(d, withHead) {
  if (d.error) return '<div class="task-sub">' + esc(d.kindLabel || d.kind) + '：' + esc(d.error) + '</div>';
  var head = withHead ? '<div class="rp-sub">' + esc(d.kindLabel || '') + '</div>' : '';
  if (!d.stores || !d.stores.length) {
    return head + '<div class="task-sub">この日の実績はありません</div>';
  }
  // 数字が入っている項目だけ出す（軒先は商材が11列あり、空列だらけになる）
  var cols = (d.columns || []).filter(function (c) { return d.totals[c.key]; });
  if (!cols.length) cols = (d.columns || []).slice(0, 3);

  var t = head + '<div class="table-scroll"><table class="tbl stack"><thead><tr><th>店舗</th>';
  cols.forEach(function (c) { t += '<th class="num">' + esc(c.label) + '</th>'; });
  t += '<th class="num">合計</th></tr></thead><tbody>';
  d.stores.forEach(function (s) {
    t += '<tr><td data-label="店舗">' + esc(s.name) + '</td>';
    cols.forEach(function (c) {
      var v = s.values[c.key] || 0;
      t += '<td class="num' + (v ? '' : ' zero-cell') + '" data-label="' + esc(c.short || c.label) + '">' +
        (v ? v : '<span class="zero">－</span>') + '</td>';
    });
    t += '<td class="num"><b>' + (s.total || 0) + '</b></td></tr>';
  });
  t += '</tbody><tfoot><tr><td>合計</td>';
  cols.forEach(function (c) { t += '<td class="num">' + (d.totals[c.key] || 0) + '</td>'; });
  t += '<td class="num"><b>' + (d.grandTotal || 0) + '</b></td></tr></tfoot></table></div>';
  return t;
}

/* ---------- ③ 日報の提出状況 ---------- */
function rpRenderUnsent(d) {
  var box = (RP.kind === 'shoki') ? (d.初期設定 || {}) : (d.出張販売 || {});
  var 出勤 = box.出勤 || [], 未 = box.未提出 || [];
  var echo = $('#rpUnsentEcho');
  if (echo) {
    echo.textContent = d.ok
      ? ('出勤 ' + 出勤.length + '名／未提出 ' + 未.length + '名')
      : (d.note || '');
  }
  if (!d.ok) { $('#rpUnsent').innerHTML = '<div class="task-sub">' + esc(d.note || '出勤表がありません') + '</div>'; return; }
  if (!出勤.length) { $('#rpUnsent').innerHTML = '<div class="task-sub">この日の出勤者がいません</div>'; return; }

  var h = '';
  if (!未.length) {
    h += '<div class="hb-ok">全員そろっています（' + 出勤.length + '名）</div>';
  } else {
    h += '<div class="hb-alert"><b>' + 未.length + '名</b> まだ出していません</div>';
    h += '<div class="rp-people">' + 未.map(function (p) {
      return '<div class="rp-person warn"><b>' + esc(p.name) + '</b>' +
        (p.店舗 ? '<span>' + esc(p.店舗) + '</span>' : '') +
        (p.未報告メモ ? '<span class="rp-memo">' + esc(p.未報告メモ) + '</span>' : '') + '</div>';
    }).join('') + '</div>';
  }
  // ★LINE WORKS で受け取っている人（フォームに出ないので未提出には入れない）
  var lw = box.LW || [];
  if (lw.length) {
    h += '<div class="rp-sub">LINE WORKS で受け取り（' + lw.length + '名）</div><div class="rp-people">' +
      lw.map(function (p) {
        // ★本文が届いているかまで出す。「LINE WORKSで受け取る人」と
        //   「その日ちゃんと送った人」は別のことなので、色を分ける
        return '<div class="rp-person ' + (p.本文あり ? 'lw' : 'warn') + '"><b>' + esc(p.name) + '</b>' +
          (p.店舗 ? '<span>' + esc(p.店舗) + '</span>' : '') +
          '<span class="rp-memo">' + (p.本文あり ? '届いています ' + esc(p.受信時刻 || '') : 'まだ届いていません') + '</span>' +
          '</div>';
      }).join('') + '</div>';
  }

  var 済 = box.提出済み || [];
  if (済.length) {
    h += '<div class="rp-sub">出した人（' + 済.length + '名）</div><div class="rp-people">' +
      済.map(function (p) {
        return '<div class="rp-person"><b>' + esc(p.name) + '</b>' +
          (p.店舗 ? '<span>' + esc(p.店舗) + '</span>' : '') +
          '<span class="rp-num">' + p.合計 + '</span></div>';
      }).join('') + '</div>';
  }
  var only = (d.日報のみ || []).filter(function (x) {
    return (RP.kind === 'shoki') ? x.枠 === '初期設定' : x.枠 === '出張販売';
  });
  if (only.length) {
    h += '<div class="rp-sub">出勤表に無いけれど記録がある人（' + only.length + '名）</div>' +
      '<div class="rp-people">' + only.map(function (p) {
        return '<div class="rp-person"><b>' + esc(p.name) + '</b>' +
          (p.店舗 ? '<span>' + esc(p.店舗) + '</span>' : '') + '</div>';
      }).join('') + '</div>';
  }
  $('#rpUnsent').innerHTML = h;
}

/* ---------- ④ 月の実績 ---------- */
function rpLoadMonth() {
  $('#rpMonthBody').innerHTML = '<div class="task-sub">読み込み中…</div>';
  var kinds = (RP.kind === 'shoki') ? ['shoki'] : ['nokisaki', 'helper'];
  Promise.all(kinds.map(function (k) {
    return api('reports.stores', { range: RP.month, kind: k }, 90000)
      .catch(function (e) { return { kind: k, error: e.message, stores: [], columns: [], totals: {} }; });
  })).then(function (list) {
    var span = list[0] && list[0].from
      ? list[0].from.slice(5).replace('-', '/') + '〜' + list[0].to.slice(5).replace('-', '/') : '';
    $('#rpMonthBody').innerHTML = '<div class="rp-span">' + esc(span) + '</div>' +
      list.map(function (d) { return rpStoreTable(d, kinds.length > 1); }).join('');
  });
}

/* ---------- 切替 ---------- */
$$('#rpKind .seg-btn').forEach(function (b) {
  b.addEventListener('click', function () {
    $$('#rpKind .seg-btn').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    RP.kind = b.dataset.rpkind;
    $('#rpDayTitle').textContent = '当日の実績';
    rpLoadDay(); rpLoadMonth();
  });
});
$$('#rpMonth .seg-btn').forEach(function (b) {
  b.addEventListener('click', function () {
    $$('#rpMonth .seg-btn').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    RP.month = b.dataset.rpmonth;
    rpLoadMonth();
  });
});
(function () {
  var p = $('#rpPrev'), n = $('#rpNext'), t = $('#rpToday');
  if (p) p.addEventListener('click', function () { rpShift(-1); });
  if (n) n.addEventListener('click', function () { rpShift(1); });
  if (t) t.addEventListener('click', function () { RP.date = rpToday(); rpLoadDay(); });
})();

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
  if (!S.attnDate) renderAttn(att);        // 日付を切り替えていない間は、まとめて取れた今日ぶんを使う

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

}

/* ---------- 出勤（昨日／今日／明日を矢印で行き来する） ---------- */
// ★2026-09-07 追加。今日しか見られないと「昨日どうだったか」を別の場所で探すことになる。
S.attnDate = '';                       // '' のときは今日（まとめて取れた分をそのまま使う）
function ymd(d) {
  return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
}
function attnShift(days) {
  var base = S.attnDate ? new Date(S.attnDate.replace(/-/g, '/')) : new Date();
  base.setDate(base.getDate() + days);
  attnLoad(ymd(base));
}
function attnLoad(date) {
  S.attnDate = (date === ymd(new Date())) ? '' : date;
  $('#attnTable').innerHTML = '<tbody><tr><td>読み込み中…</td></tr></tbody>';
  api('attendance.day', { date: date }).then(renderAttn)
    .catch(function (e) { $('#attnTable').innerHTML = '<tbody><tr><td>' + esc(e.message) + '</td></tr></tbody>'; });
}
function renderAttn(att) {
  if (!att) return;
  var t = ymd(new Date());
  var d = new Date(); d.setDate(d.getDate() + 1); var tm = ymd(d);
  var y = new Date(); y.setDate(y.getDate() - 1); var ys = ymd(y);
  var label = att.date === t ? '今日' : att.date === tm ? '明日' : att.date === ys ? '昨日' : '';
  var w = ['日', '月', '火', '水', '木', '金', '土'][new Date(att.date.replace(/-/g, '/')).getDay()];
  $('#attnDayLabel').textContent = att.date.slice(5).replace('-', '/') + '（' + w + '）' + (label ? ' ' + label : '');
  $('#attnToday').style.visibility = att.date === t ? 'hidden' : 'visible';
  $('#attnCount').textContent = att.rows && att.rows.length
    ? att.staffCount + '名 ／ ' + att.storeCount + '店舗'
    : (att.note || 'この日の表はまだありません');

  // ★スマホでは表を縦積みにする（td の data-label が見出し代わりになる）。
  //   横スクロールしないと出勤スタッフが見えない、という状態を作らないため
  var th2 = '<thead><tr><th>店舗</th><th>出勤スタッフ</th><th>確認</th><th>備考</th></tr></thead>';
  $('#attnTable').className = 'tbl stack';
  $('#attnTable').innerHTML = (att.rows || []).length
    ? th2 + '<tbody>' + att.rows.map(function (r) {
        return '<tr><td data-label="店舗">' + esc(r.store) + '</td>' +
          '<td data-label="出勤">' + (esc(r.staff) || '<span class="zero">－</span>') + '</td>' +
          '<td data-label="確認">' + (r.unreported ? '<span class="badge warn">未報告</span>' : esc(r.checks.join(' ')) || '－') + '</td>' +
          '<td data-label="備考">' + esc(r.note) + '</td></tr>';
      }).join('') + '</tbody>'
    : '<tbody><tr><td>' + esc(att.note || 'この日の出勤表はありません') + '</td></tr></tbody>';
}
$('#attnPrev').addEventListener('click', function () { attnShift(-1); });
$('#attnNext').addEventListener('click', function () { attnShift(1); });
$('#attnToday').addEventListener('click', function () { attnLoad(ymd(new Date())); });

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
function switchView(v, fromHash) {
  S.view = v;
  $$('.view').forEach(function (s) { s.classList.add('hidden'); });
  $('#view-' + v).classList.remove('hidden');
  $$('.tab').forEach(function (t) { t.classList.toggle('active', t.getAttribute('data-view') === v); });
  window.scrollTo({ top: 0, behavior: 'smooth' });
  // ★HB の実体はこのファイルの末尾で組み立てるので、起動直後（init から呼ばれる switchView）では
  //   まだ undefined。setTimeout でひと呼吸置き、ファイルを読み終えてから走らせる。
  //   （2026-09-04に「Cannot read properties of undefined」で読み込み中のまま止まった）
  if (v === 'tasks')  setTimeout(function () { if (!TODO.data) todoLoad(false); }, 0);
  if (v === 'hanbai') setTimeout(function () { if (!HB.data) hbLoad(); }, 0);
  if (v === 'onboard') setTimeout(function () { if (!OB.data) obLoad(); }, 0);
  if (v === 'shoki')  setTimeout(function () { if (!SK.data) skLoad(false); }, 0);
  if (v === 'reports') setTimeout(function () { if (!RP.date) rpInit(); }, 0);
  if (v === 'home')   setTimeout(function () { extRender(); }, 0);
  // ★ハッシュ由来の切り替えでは書き戻さない（戻る操作の履歴を壊してしまうため）
  if (!fromHash) setHash(v);
}

/* ----------------------------------------------------------------------------
 * ブラウザの「戻る」で画面が切り替わるようにする  2026-09-07
 * ★これまで location.hash を書くだけで、hashchange を誰も聞いていなかった。
 *   画面内の「もどる」ボタンでしか戻れず、端末の戻る操作だと URL だけ変わって
 *   中身が前のままになっていた（拓矢さん指摘）。
 *   画面の状態（どのタブか・販売スタッフの誰を開いているか）を全部ハッシュに載せ、
 *   ハッシュ→画面の一方通行にする。
 * -------------------------------------------------------------------------- */
var HASH_SELF = false;   // 自分で書いた hash か（無限ループ防止）

function setHash(h) {
  if (('#' + h) === location.hash) return;
  HASH_SELF = true;
  location.hash = h;
  setTimeout(function () { HASH_SELF = false; }, 0);
}

/** いまの画面の状態をハッシュ文字列にする */
function stateHash() {
  if (S.view === 'hanbai' && HB.picked) return 'hanbai:' + encodeURIComponent(HB.picked);
  if (S.view === 'shoki' && SK.picked) return 'shoki:' + encodeURIComponent(SK.picked);
  return S.view || 'home';
}

/** ハッシュを読んで画面をそこへ合わせる（戻る／進む／直リンクの入口） */
function applyHash() {
  var raw = (location.hash || '').replace(/^#/, '');
  if (!raw) raw = 'home';
  var i = raw.indexOf(':');
  var view = i < 0 ? raw : raw.slice(0, i);
  var sub = i < 0 ? '' : decodeURIComponent(raw.slice(i + 1));
  if (!$('#view-' + view)) return;

  if (view !== S.view) switchView(view, true);

  if (view === 'hanbai') {
    var want = sub || null;
    if (want !== HB.picked) {
      HB.picked = want;
      if (HB.data) hbRender();          // データ待ちなら hbLoad 側で描かれる
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
  if (view === 'shoki') {
    var w2 = sub || null;
    if (w2 !== SK.picked) {
      SK.picked = w2;
      if (SK.data) skRender();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }
}

window.addEventListener('hashchange', function () {
  if (HASH_SELF) return;
  applyHash();
});
document.addEventListener('click', function (ev) {
  var b = ev.target.closest('[data-view]');
  if (!b) return;
  switchView(b.getAttribute('data-view'));
});
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
$('#btnRefresh').addEventListener('click', function () {
  toast('最新に更新しています…');
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
  // ★画面の向きを端末に合わせる（2026-09-08 拓矢さん指摘「横にしても縦のまま」）
  //   ホーム画面に追加したアプリは**追加した時点のmanifestを持ち続ける**ので、
  //   manifest を直しても入れ直すまで縦固定のまま。ここで実行時に解除する。
  try {
    if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
  } catch (e) { /* 対応していない端末では何もしない */ }

  var th = localStorage.getItem('hub_theme');
  if (th) document.documentElement.setAttribute('data-theme', th);

  if (!S.token) { showLogin(); return; }
  showApp();
  loadAll();
  applyHash();

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
// ★shift-automation は無料アカウント所有なので、telekids.net でログイン中のブラウザからは
//   直接繋げない（2026-09-04に実測）。**hub のAPIに中継してもらう。**
//   秘密も hub 側にしか置かないので、この公開ファイルには何も載らない。
var HB = { data: null, tab: 'watch', picked: null, loading: false };

function hbCall(op, params) {
  return api('hanbai.' + op, params || {});
}

function hbEsc(s) { return esc(s); }
function hbPct(s) { var m = String(s).match(/-?\d+/); return m ? Number(m[0]) : null; }
/** 行の列番号をそのまま使うと必ず間違えるので、名前つきの箱に直す */
function hbS(r) {
  return { name: r[0], kubun: r[1], store: r[2], days: +r[3] || 0, koe: +r[4] || 0,
    catch: +r[5] || 0, sit: +r[6] || 0, perDay: r[7], avg: r[8], diff: r[9],
    pi: +r[10] || 0, prev: r[11], level: r[12], closer: r[13], state: r[14],
    next: r[15], updated: r[16], role: r[17] || '' };
}
/** ★2026-09-07 役割で見る数字が変わる。キャッチャー＝着座数／クローザー＝PI件数。
 *  キャッチをしないクローザーに着座を出しても意味がないため。 */
function hbIsCloser(s) { return String(s.role || '').indexOf('クローザー') >= 0; }
function hbMainLabel(s) { return hbIsCloser(s) ? 'PI（軒先／店内）' : '着座'; }

function hbLoad(fresh) {
  if (HB.loading) return;
  HB.loading = true;
  $('#hbSub').textContent = '読み込み中…';
  hbCall('get', fresh ? { fresh: 1 } : null).then(function (d) {
    HB.loading = false;
    HB.data = d;
    hbRender();
    noticeBuild();     // ★お知らせ（右上のベル）を組み直す
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
  if (HB.tab === 'watch')   el.innerHTML = hbWatch();
  if (HB.tab === 'trainee') el.innerHTML = hbTrainee();
  if (HB.tab === 'list')    el.innerHTML = hbList();
  if (HB.tab === 'add')     el.innerHTML = hbForm();
  hbBadge();
  hbBind();
}

/**
 * 連絡状況  2026-09-08
 * ★新しく入った人は、放っておくと誰も声をかけないまま辞めてしまう。
 *   「気になる人」は数字が動いた人を出すものなので、**まだ数字が無い新人は引っかからない**。
 *   だからここで「連絡が空いている人」を別に出す。
 *   誰が研修中かは、スプレッドシートの一覧S列に「研修中」と入れた人だけ。
 */
function hbTrainee() {
  var t = (HB.data && HB.data.trainee) || null;
  if (t && t['まだ']) {
    return '<div class="hb-card"><div class="hb-empty">まだ集計されていません。<br>' +
      '<span class="hb-meta">右上の更新ボタンを押すと作られます（少し時間がかかります）</span></div></div>';
  }
  if (!t || !t.people || !t.people.length) {
    return '<div class="hb-card"><div class="hb-empty">対象のスタッフがいません。</div></div>' +
      '<div class="hb-card"><div class="hb-meta">' + hbTraineeRule(t) + '</div></div>';
  }
  var h = '';
  if (t['要対応']) {
    h += '<div class="hb-alert"><b>' + t['要対応'] + '名</b> 声をかける番です</div>';
  } else {
    h += '<div class="hb-ok">全員と連絡が取れています</div>';
  }
  h += t.people.map(function (p) {
    var warn = p.warn;
    return '<div class="tr-card' + (warn ? ' warn' : '') + '" data-hbopen="' + esc(p.name) + '">' +
      '<div class="tr-top"><b>' + esc(p.name) + '</b>' +
        (p.isNew ? '<span class="tr-new">今月から</span>' : '') +
        '<span class="tr-shift">稼働 ' + p.shifts + '回</span></div>' +
      (p.alerts || []).map(function (a2) {
        return '<div class="tr-alert' + (warn ? '' : ' soft') + '">' +
          (warn ? '⚠️ ' : '') + esc(a2['文']) + '</div>';
      }).join('') +
      '<div class="tr-meta">' +
        (p.lastHeard
          ? '最後に話を聞いた：' + esc(p.lastHeard) + (p.heardBy ? '（' + esc(p.heardBy) + '）' : '')
          : '話を聞いた記録なし') +
        (p.lastWork ? '　／　最後の稼働：' + esc(p.lastWork) : '') +
      '</div>' +
      (p.heardNote ? '<div class="tr-note">' + esc(String(p.heardNote).slice(0, 90)) + '</div>' : '') +
    '</div>';
  }).join('');
  h += '<div class="hb-card"><div class="hb-meta">' + hbTraineeRule(t) +
       (t['作った時刻'] ? '<br><br>この集計を作った時刻：' + esc(t['作った時刻']) : '') +
       '</div></div>';
  return h;
}

function hbTraineeRule(t) {
  var d = (t && t['しきい値']) || {};
  var days = d['連絡が空いた日数'] || 14;
  var n = d['稼働回数'] || 3;
  var k = d['新規の節目'] || '1・3回目';
  var sv = (t && t['対象外']) || [];
  return '★声をかける目安<br>' +
    '・最後に話を聞いてから <b>' + days + '日</b>あいた<br>' +
    '・前回のあと <b>' + n + '回</b>稼働した<br>' +
    '・今月から入った人は <b>' + k + '</b>の稼働のあと' +
    (sv.length ? '<br><br>対象外（SV）：' + sv.map(esc).join('／') : '');
}

/** タブに件数を出す。0件なら出さない（数字が常にあると見なくなるため） */
function hbBadge() {
  var el = $('#hbBadge');
  if (!el) return;
  var t = (HB.data && HB.data.trainee) || null;
  var n = t ? Number(t['要対応'] || 0) : 0;
  if (!n) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = n < 10 ? ('0' + n) : String(n);
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
  // ★クローザーを上に出す（拓矢さん指示 2026-09-07）。同じ役割の中は名簿順のまま
  act.sort(function (a, b) { return (hbIsCloser(b) ? 1 : 0) - (hbIsCloser(a) ? 1 : 0); });
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
        '<div class="hb-num"><b>' + s.sit + '</b><span>' + hbMainLabel(s) + '</span></div>' +
        '<div class="hb-num"><b>' + hbEsc(s.perDay) + '</b><span>1日あたり</span></div>' +
        '<div class="hb-num"><b>' + hbEsc(s.avg || '—') + '</b><span>同じ役割の平均</span></div>' +
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
      '<div class="hb-num"><b>' + s.sit + '</b><span>' + hbMainLabel(s) + '</span></div>' +
      '<div class="hb-num"><b>' + hbEsc(s.perDay) + '</b><span>1日あたり</span></div>' +
      '<div class="hb-num"><b>' + hbEsc(s.avg || '—') + '</b><span>同じ役割の平均</span></div>' +
      '<div class="hb-num"><b>' + s.days + '</b><span>稼働日</span></div></div>' +
    // ★2026-09-07 ここで役割を切り替える。押した瞬間に保存して数字を入れ替える。
    //   キャッチャー→クローザーに変わると、見る数字が着座からPIになる。
    '<div class="hb-role" data-hbrolefor="' + hbEsc(name) + '">' +
      '<span class="hb-role-l">見る数字</span>' +
      ['キャッチャー', 'クローザー'].map(function (v) {
        var on = (hbIsCloser(s) ? 'クローザー' : 'キャッチャー') === v;
        return '<button class="hb-role-b' + (on ? ' on' : '') + '" data-hbrole="' + v + '">' +
          v + '<small>' + (v === 'クローザー' ? 'PI（軒先／店内）' : '着座') + '</small></button>';
      }).join('') +
    '</div></div>';

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

  // ★クローザーは着座ではなくPIを主役の列にする（2026-09-07）
  var closer = hbIsCloser(s);
  h += '<div class="hb-h2">月ごとの数字</div><div class="hb-card"><table class="hb-tbl">' +
    '<tr><th>月</th><th>稼働</th><th>キャッチ</th><th>' + (closer ? 'PI<small>軒先／店内</small>' : '着座') + '</th><th>1日</th>' +
    (closer ? '' : '<th>PI<small>軒先／店内</small></th>') + '</tr>';
  var cspan = closer ? 5 : 6;
  if (!ms.length) h += '<tr><td colspan="' + cspan + '" style="text-align:left;opacity:.55">まだありません</td></tr>';
  ms.forEach(function (m) {
    var main = closer ? (+m[7] || 0) : (+m[5] || 0);       // m[5]=着座 m[7]=PI
    var per = (+m[2] > 0) ? (main / +m[2]).toFixed(1) : '—';
    h += '<tr><td>' + hbEsc(m[1]) + '</td><td>' + hbEsc(m[2]) + '</td><td>' + hbEsc(m[4]) +
      '</td><td><b>' + main + '</b></td><td>' + per + '</td>' +
      (closer ? '' : '<td>' + hbEsc(m[7]) + '</td>') + '</tr>';
  });
  h += '</table></div>';

  h += '<div class="hb-h2">この人のこと（保存できます）</div><div class="hb-card hb-f">' +
    '<label>レベル</label><input id="hbLevel" value="' + hbEsc(s.level) + '" placeholder="例）キャッチのみ／クローザー可">' +
    '<label>クローザー志望</label><select id="hbCloser">' +
      ['', 'あり', 'なし', '検討中'].map(function (v) {
        return '<option' + (v === s.closer ? ' selected' : '') + '>' + v + '</option>'; }).join('') + '</select>' +
    vcLabel('hbState', '直近の状態') +
    '<textarea id="hbState" placeholder="いまどんな様子か／🎤 を押すと話した内容が入ります">' + hbEsc(s.state) + '</textarea>' +
    vcLabel('hbNext', '次にやること') +
    '<input id="hbNext" value="' + hbEsc(s.next) + '" placeholder="例）三觜さんに同行してもらう">' +
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
  h += '</div>';
  // ★タブを1つ減らしたぶん、入力欄はこの画面の中に置く（拓矢さん指示 2026-09-09）。
  //   別のタブへ飛ばすと「誰の記録か」が見えなくなるので、本人の数字の下に置く。
  h += '<div class="hb-h2">話を聞いたら記録する</div>' + hbForm(name, true);
  return h;
}

/**
 * ヒアリングの入力欄。
 * @param {string}  pre    最初に選んでおく人
 * @param {boolean} fixed  true なら対象者を選ばせない（その人の画面の中に置くとき）
 */
function hbForm(pre, fixed) {
  var names = HB.data.staff.map(function (r) { return r[0]; });
  return (fixed ? '' : '<div class="hb-h2">ヒアリングを記録する</div>') +
    '<div class="hb-card hb-f">' +
    (fixed
      ? '<input id="hbHName" type="hidden" value="' + hbEsc(pre) + '">'
      : '<label>対象者</label><select id="hbHName">' +
        names.map(function (n) {
          return '<option' + (n === pre ? ' selected' : '') + '>' + hbEsc(n) + '</option>'; }).join('') +
        '</select>') +
    '<label>日付</label><input id="hbHDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '">' +
    '<label>聞いた人</label><input id="hbHBy" value="' + hbEsc((S.user && S.user.name) || '') + '">' +
    vcLabel('hbHText', '内容') +
    '<textarea id="hbHText" placeholder="話したこと・本人が言っていたこと／🎤 を押すと話した内容が入ります"></textarea>' +
    vcLabel('hbHNext', '次の一手') +
    '<input id="hbHNext" placeholder="例）来週の二俣川で同行">' +
    '<button class="hb-go" id="hbHGo">保存する</button></div>';
}

function hbVal(id) { var e = $('#' + id); return e ? e.value : ''; }

function hbBind() {
  vcBind();                      // ★音声入力とAI整形のボタン（2026-09-08）
  $$('[data-hbopen]').forEach(function (b) {
    b.onclick = function (ev) {
      ev.stopPropagation();
      HB.picked = b.getAttribute('data-hbopen');
      setHash(stateHash());          // ★戻るで一覧へ帰れるように履歴を1つ積む
      window.scrollTo({ top: 0, behavior: 'smooth' });
      hbRender();
    };
  });
  $$('[data-hbback]').forEach(function (b) {
    b.onclick = function () {
      // 画面内の「もどる」も履歴をさかのぼる形にそろえる（端末の戻ると同じ動きになる）
      if ((location.hash || '').indexOf('#hanbai:') === 0) { history.back(); return; }
      HB.picked = null; window.scrollTo({ top: 0, behavior: 'smooth' }); hbRender();
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

  // ★役割の切り替え：押す→保存→その場で数字を入れ替える
  var roleBox = document.querySelector('[data-hbrolefor]');
  if (roleBox) {
    var who = roleBox.getAttribute('data-hbrolefor');
    roleBox.querySelectorAll('[data-hbrole]').forEach(function (btn) {
      btn.onclick = function () {
        var v = btn.getAttribute('data-hbrole');
        var row = HB.data.staff.filter(function (r) { return r[0] === who; })[0];
        if (row && (row[17] || 'キャッチャー') === v) return;      // 変わらないなら何もしない
        roleBox.querySelectorAll('[data-hbrole]').forEach(function (b) { b.disabled = true; });
        hbCall('note', { n: who, role: v }).then(function () {
          if (row) row[17] = v;
          toast(v + ' にしました。数字を入れ替えます');
          hbCall('get', { fresh: '1' }).then(function (d) { HB.data = d; hbRender('detail', who); })
            .catch(function () { hbRender('detail', who); });
        }).catch(function (e) {
          roleBox.querySelectorAll('[data-hbrole]').forEach(function (b) { b.disabled = false; });
          toast(e.message, true);
        });
      };
    });
  }

  var go = $('#hbHGo');
  if (go) go.onclick = function () {
    if (!hbVal('hbHText').trim()) return toast('内容を書いてください', true);
    go.disabled = true; go.textContent = '保存中…';
    var rec = [hbVal('hbHDate'), hbVal('hbHName'), hbVal('hbHBy'), hbVal('hbHText'), hbVal('hbHNext')];
    hbCall('hear', { d: rec[0], n: rec[1], by: rec[2], tx: rec[3], nx: rec[4] }).then(function () {
      go.disabled = false; go.textContent = '保存する';
      HB.data.hearings.push(rec);
      HB.picked = rec[1];
      // ★連絡状況にも即反映されるよう、その人の記録を上書きしておく（サーバー側も同時に更新済み）
      var tp = ((HB.data.trainee || {}).people || []);
      tp.forEach(function (x) {
        if (x.name !== rec[1]) return;
        x.lastHeard = rec[0]; x.heardBy = rec[2]; x.heardNote = rec[3];
        x.warn = false; x.alerts = []; x.days = 0; x.sinceShifts = 0;
      });
      if (HB.data.trainee) {
        HB.data.trainee['要対応'] = tp.filter(function (x) { return x.warn; }).length;
      }
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

/* ============================================================================
 * 新人受け入れ（11項目のチェックリスト）  2026-09-04
 * ----------------------------------------------------------------------------
 * ★元データは名簿スプシの「新人スタッフ案内管理」タブそのもの。
 *   拓矢さんが普段見ている表を正とする（二重管理は必ずズレる）。
 * ★「済」以外の文字（例「9/9勤務開始」「依頼済（未確認）」）は**消さずに残す**。
 *   現場のメモが情報として効いているので、チェックを外しただけで消してはいけない。
 * ============================================================================ */
var OB = { data: null, picked: null, loading: false };

function obLoad(fresh) {
  if (OB.loading) return;
  OB.loading = true;
  $('#obSub').textContent = '読み込み中…';
  api('onboard.get', {}).then(function (d) {
    OB.loading = false; OB.data = d; obRender();
  }).catch(function (e) {
    OB.loading = false;
    $('#obSub').textContent = '読み込めませんでした';
    $('#obBody').innerHTML = '<div class="hb-card"><div class="hb-empty">' + esc(e.message) + '</div></div>';
  });
}

function obRender() {
  var d = OB.data; if (!d) return;
  var nokori = d.people.filter(function (p) { return p.done < p.total; }).length;
  $('#obSub').textContent = d.people.length + '名　·　受け入れ途中 ' + nokori + '名　·　項目 ' + d.tasks.length + '個';
  $('#obBody').innerHTML = OB.picked ? obDetail(OB.picked) : obList();
  obBind();
}

function obList() {
  var d = OB.data;
  var yet = d.people.filter(function (p) { return p.done < p.total; });
  var fin = d.people.filter(function (p) { return p.done >= p.total; });
  var card = function (p) {
    var pc = Math.round(p.done / p.total * 100);
    var rest = p.states.filter(function (s) { return !s.done; })
      .map(function (s) { return (d.tasks.filter(function (t) { return t.col === s.col; })[0] || {}).name; });
    return '<div class="hb-card tap" data-ob="' + esc(p.name) + '">' +
      '<div class="hb-row"><div><div class="hb-name">' + esc(p.name) + '</div>' +
      '<div class="hb-meta">' + esc(p.kubun || '区分なし') + '</div></div>' +
      '<span class="ob-count ' + (pc === 100 ? 'full' : (pc < 50 ? 'few' : '')) + '">' +
        p.done + ' / ' + p.total + '</span></div>' +
      '<div class="ob-prog ' + (pc === 100 ? 'full' : '') + '"><i style="width:' + pc + '%"></i></div>' +
      (rest.length ? '<div class="ob-rest">残り：' + esc(rest.slice(0, 4).join('、')) +
        (rest.length > 4 ? ' ほか' + (rest.length - 4) + '件' : '') + '</div>' : '') +
      '</div>';
  };
  var h = '';
  if (yet.length) h += '<div class="hb-h2">受け入れ途中（' + yet.length + '名）</div>' + yet.map(card).join('');
  else h += '<div class="hb-card"><div class="hb-empty">受け入れ途中の人はいません。</div></div>';
  if (fin.length) h += '<div class="hb-h2">完了（' + fin.length + '名）</div>' + fin.map(card).join('');
  return h;
}

function obDetail(name) {
  var d = OB.data;
  var p = d.people.filter(function (x) { return x.name === name; })[0];
  if (!p) return '<div class="hb-card"><div class="hb-empty">見つかりません</div></div>';
  var pc = Math.round(p.done / p.total * 100);
  var h = '<div style="margin-bottom:12px"><button class="hb-ghost" data-obback="1">← もどる</button></div>';
  // ★区分は「販売/キャッチャー」のように部品をつないだ形。**複数選べる**ようにする
  //   （2026-09-07 拓矢さん指示：「初期設定、軒先、キャッチャーとか色々あるのをリストにして複数選択」）
  var sel = '<button class="ob-kubun-btn" id="obKubunBtn">' +
    esc(p.kubun || '区分を選ぶ') + ' <span class="ob-caret">▾</span></button>' +
    '<div class="ob-kubun-box" id="obKubunBox" hidden>' +
      obKubunChips(d.kubunParts || [], p.kubun) +
      '<div class="ob-kubun-foot">' +
        '<span class="ob-kubun-prev" id="obKubunPrev"></span>' +
        '<button class="ob-kubun-save" id="obKubunSave">保存</button>' +
      '</div>' +
    '</div>';

  h += '<div class="hb-card"><div class="hb-row"><div>' +
    '<div class="hb-name" style="font-size:21px">' + esc(p.name) + '</div>' +
    '<div class="hb-meta">' + sel + '</div></div>' +
    '<span class="ob-count ' + (pc === 100 ? 'full' : (pc < 50 ? 'few' : '')) + '">' + p.done + ' / ' + p.total + '</span></div>' +
    '<div class="ob-prog ' + (pc === 100 ? 'full' : '') + '"><i style="width:' + pc + '%"></i></div></div>';

  // ★連絡先はここで入れられる（名簿＝緊急連絡先タブに直接書く）。2026-09-07 拓矢さん指示
  h += '<div class="hb-h2">緊急連絡先</div><div class="hb-card">' +
    (p.inRoster
      ? '<div class="ob-contact">' +
          '<label class="ob-f"><span>電話番号</span>' +
            '<input id="obTel" type="tel" inputmode="tel" value="' + esc(p.tel || '') + '" placeholder="090-0000-0000"></label>' +
          '<label class="ob-f"><span>メールアドレス</span>' +
            '<input id="obMail" type="email" inputmode="email" value="' + esc(p.mail || '') + '" placeholder="example@provide-biz.com"></label>' +
          '<button class="btn-primary btn-sm" id="obContactSave">保存</button>' +
          '<div class="ob-f-note">名簿（緊急連絡先）にそのまま書き込みます。出勤確認・交通費もここを見ています。</div>' +
        '</div>'
      : '<div class="hb-meta">この方は名簿（緊急連絡先）に登録がありません。<br>' +
        '★ハブからは名簿に行を足しません（出勤確認・交通費が見ている表なので）。先に名簿へ追加してください。</div>') +
  '</div>';

  h += '<div class="hb-h2">やること</div><div class="hb-card">';
  p.states.forEach(function (s) {
    var t = d.tasks.filter(function (x) { return x.col === s.col; })[0] || { name: '?' };
    // 3つの状態。★対象外はスプシ側でグレーに塗る（拓矢さんが普段見ている表と同じ見た目にするため）
    var cur = s.skip ? 'skip' : (s.done ? 'done' : 'open');
    var memo = (cur === 'open' && s.value) ? '<div class="memo">' + esc(s.value) + '</div>' : '';
    var btn = function (mode, label) {
      return '<button class="ob-st ob-st-' + mode + (cur === mode ? ' on' : '') +
        '" data-obset="' + s.col + '" data-obmode="' + mode + '">' + label + '</button>';
    };
    h += '<div class="ob-task ob-task-' + cur + '">' +
      '<div class="tt">' + esc(t.name) + memo + '</div>' +
      '<div class="ob-sw">' + btn('open', '未') + btn('done', '済') + btn('skip', '対象外') + '</div>' +
    '</div>';
  });
  h += '</div>';
  h += '<div class="hb-card"><div class="hb-meta">' +
       '「済」＝終わった／「対象外」＝この人には要らない項目（表ではグレーになります）。<br>' +
       'すべてが済か対象外になると、この人は一覧から消えます。' +
       'メモ（例「9/9勤務開始」）は「済」にするまで残ります。</div></div>';
  return h;
}

function obBind() {
  $$('[data-ob]').forEach(function (b) {
    b.onclick = function () { OB.picked = b.getAttribute('data-ob');
      window.scrollTo({ top: 0, behavior: 'smooth' }); obRender(); };
  });
  $$('[data-obback]').forEach(function (b) {
    b.onclick = function () { OB.picked = null; window.scrollTo({ top: 0, behavior: 'smooth' }); obRender(); };
  });
  $$('[data-obset]').forEach(function (b) {
    b.onclick = function () {
      if (b.classList.contains('on')) return;      // すでにその状態
      var col = Number(b.getAttribute('data-obset'));
      var mode = b.getAttribute('data-obmode');
      b.disabled = true;
      api('onboard.set', { name: OB.picked, col: col, mode: mode }).then(function () {
        var p = OB.data.people.filter(function (x) { return x.name === OB.picked; })[0];
        var s = p.states.filter(function (x) { return x.col === col; })[0];
        s.skip = (mode === 'skip');
        s.done = (mode !== 'open');                 // 対象外も「終わっている」扱い
        s.value = (mode === 'done') ? '済' : '';
        p.done = p.states.filter(function (x) { return x.done; }).length;
        p.open = p.states.filter(function (x) { return !x.done; }).length;
        obRender();
        toast(mode === 'done' ? '済にしました' : (mode === 'skip' ? '対象外にしました' : '未に戻しました'));
      }).catch(function (e) { b.disabled = false; toast(e.message, true); });
    };
  });
  var cs = $('#obContactSave');
  if (cs) cs.onclick = function () {
    cs.disabled = true; cs.textContent = '保存中…';
    api('onboard.contact', { name: OB.picked, tel: $('#obTel').value, mail: $('#obMail').value })
      .then(function (r) {
        cs.disabled = false; cs.textContent = '保存';
        if (r && r.ok === false) { toast(r.message || '保存できませんでした', true); return; }
        var p = OB.data.people.filter(function (x) { return x.name === OB.picked; })[0];
        if (p) { p.tel = $('#obTel').value; p.mail = $('#obMail').value; }
        toast('名簿に書きました');
      })
      .catch(function (e) { cs.disabled = false; cs.textContent = '保存'; toast(e.message, true); });
  };

  obKubunBind(function (v, done) {
    api('onboard.kubun', { name: OB.picked, kubun: v }).then(function () {
      var p = OB.data.people.filter(function (x) { return x.name === OB.picked; })[0];
      if (p) p.kubun = v;
      done(); obRender(); toast('区分を変えました');
    }).catch(function (e) { done(); toast(e.message, true); });
  });
}

/* ---- 区分の複数選択（個別画面と新人追加で同じ部品を使う） ---- */

/** 部品をチップで並べる。いま入っている区分にあたるものは最初からオンにする */
function obKubunChips(parts, current) {
  var on = obSplitKubun(current || '');
  var all = parts.slice();
  // いま入っている部品が候補に無ければ足す（勝手に消さない）
  on.forEach(function (x) { if (all.indexOf(x) < 0) all.unshift(x); });
  return '<div class="ob-chips">' + all.map(function (k) {
    return '<button class="ob-chip' + (on.indexOf(k) >= 0 ? ' on' : '') +
      '" data-kubun="' + esc(k) + '">' + esc(k) + '</button>';
  }).join('') + '</div>';
}

/** スラッシュで割る。カッコの中は割らない（サーバー側と同じ規則） */
function obSplitKubun(text) {
  var s = String(text || ''), out = [], buf = '', depth = 0;
  for (var i = 0; i < s.length; i++) {
    var ch = s.charAt(i);
    if (ch === '(' || ch === '（') depth++;
    if (ch === ')' || ch === '）') depth = Math.max(0, depth - 1);
    if ((ch === '/' || ch === '／') && depth === 0) { out.push(buf.trim()); buf = ''; continue; }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out.filter(function (x) { return x; });
}

/** 選んだ部品をつなぐ。並びは画面に出ている順（毎回同じ形になる） */
function obKubunValue() {
  return $$('#obKubunBox .ob-chip.on').map(function (b) {
    return b.getAttribute('data-kubun');
  }).join('/');
}

function obKubunPreview() {
  var v = obKubunValue();
  var el = $('#obKubunPrev');
  if (el) el.textContent = v || '（区分なし）';
  return v;
}

/** onSave(value, done) … done() を呼ぶと保存中の表示を戻す */
function obKubunBind(onSave) {
  var btn = $('#obKubunBtn'), box = $('#obKubunBox');
  if (!btn || !box) return;
  btn.onclick = function () { box.hidden = !box.hidden; obKubunPreview(); };
  $$('#obKubunBox .ob-chip').forEach(function (c) {
    c.onclick = function () { c.classList.toggle('on'); obKubunPreview(); };
  });
  var save = $('#obKubunSave');
  if (save) save.onclick = function () {
    var v = obKubunValue();
    save.disabled = true; save.textContent = '保存中…';
    onSave(v, function () { save.disabled = false; save.textContent = '保存'; box.hidden = true; });
  };
  obKubunPreview();
}

$('#obReload').addEventListener('click', function () { OB.picked = null; OB.data = null; obLoad(); });
// ★新人の追加は入力欄つきの画面にした（区分を複数選べるようにするため。2026-09-07）
$('#obAddBtn').addEventListener('click', function () {
  var d = OB.data || {};
  OB.picked = null;
  $('#obBody').innerHTML =
    '<div style="margin-bottom:12px"><button class="hb-ghost" data-obback="1">← もどる</button></div>' +
    '<div class="hb-card">' +
      '<div class="hb-h2" style="margin-top:0">新人を追加</div>' +
      '<label class="ob-f"><span>氏名（フルネーム）</span>' +
        '<input id="obNewName" type="text" placeholder="例：山田 太郎" autocomplete="off"></label>' +
      '<label class="ob-f"><span>区分（あてはまるものを全部）</span></label>' +
      '<button class="ob-kubun-btn" id="obKubunBtn">区分を選ぶ <span class="ob-caret">▾</span></button>' +
      '<div class="ob-kubun-box" id="obKubunBox">' +
        obKubunChips(d.kubunParts || [], '') +
        '<div class="ob-kubun-foot"><span class="ob-kubun-prev" id="obKubunPrev"></span></div>' +
      '</div>' +
      '<div class="ob-f-note">受け入れの11項目は「未」で始まります。あとから1つずつ変えられます。</div>' +
      '<button class="btn-primary" id="obNewSave" style="margin-top:12px">追加する</button>' +
    '</div>';
  obBind();
  obKubunBind(function () { });         // チップの開閉・プレビューだけ使う
  $('#obKubunBox').hidden = false;
  var save = $('#obNewSave');
  save.onclick = function () {
    var name = ($('#obNewName').value || '').trim();
    if (!name) { toast('氏名を入れてください', true); return; }
    save.disabled = true; save.textContent = '登録しています…';
    api('onboard.add', { name: name, kubun: obKubunValue() }).then(function (r) {
      OB.data = null; OB.picked = null; obLoad();
      toast(r['既にいる'] ? 'すでに登録されています' : '追加しました');
    }).catch(function (e) {
      save.disabled = false; save.textContent = '追加する'; toast(e.message, true);
    });
  };
});


/* ============================================================================
 * まもなく初稼働のスタッフ  2026-09-07
 * ★拓矢さん指示「ホームに明日初稼働の方の枠を作りたい」。
 *   初日の人は、誰かが前日までに気づいていないと、何も知らないまま現場に立つ。
 *   明日だけだと土日をまたいだときに見落とすので、**1週間先まで**出して
 *   今日・明日を先頭に並べる。該当が無い週はカードごと出さない（空枠は読み飛ばされる）。
 * ========================================================================== */
function debutLoad(fresh) {
  api('debut.get', { days: 7, fresh: fresh ? 1 : '' })
    .then(function (d) { renderDebut(d); S.data.debut = (d && d.people) || []; noticeBuild(); })
    .catch(function (e) { console.warn('初稼働', e.message); });
}

function renderDebut(d) {
  renderShiftLinks((d && d.links) || []);
  var card = $('#debutCard');
  if (!card) return;
  var list = (d && d.people) || [];
  if (!list.length) { card.hidden = true; return; }
  card.hidden = false;
  $('#debutSub').textContent = list.length + '名';
  $('#debutBody').innerHTML = list.map(function (p) {
    var soon = p.いつ === '今日' || p.いつ === '明日';
    return '<div class="debut-row' + (soon ? ' soon' : '') + '" data-debut="' + esc(p.氏名) + '">' +
      '<div class="debut-when">' + esc(p.いつ) + '</div>' +
      '<div class="debut-main"><b>' + esc(p.氏名) + '</b>' +
        (p.枠 ? '<span class="debut-place">' + esc(p.枠) + '</span>' : '') + '</div>' +
      '<button class="btn-link" data-view="onboard">受け入れ →</button>' +
      '<button class="debut-x" title="初日ではない人として今後出さない">対象外</button>' +
      '<div class="debut-ask" hidden>' +
        '<span><b>' + esc(p.氏名) + '</b>さんを「初日ではない」として今後この欄に出しません。<br>' +
        '★ 出勤の予定そのものは消えません。取り消したいときは声をかけてください。</span>' +
        '<span class="debut-ask-b">' +
          '<button class="debut-yes">対象外にする</button>' +
          '<button class="debut-no">やめる</button>' +
        '</span>' +
      '</div>' +
    '</div>';
  }).join('');
  debutBind();
}

/** 押し間違いで消えないよう、確認を1枚はさむ（★拓矢さん指示 2026-09-07） */
function debutBind() {
  $$('#debutBody .debut-row').forEach(function (row) {
    var name = row.getAttribute('data-debut');
    var ask = row.querySelector('.debut-ask');
    row.querySelector('.debut-x').onclick = function () { ask.hidden = false; row.classList.add('asking'); };
    row.querySelector('.debut-no').onclick = function () { ask.hidden = true; row.classList.remove('asking'); };
    row.querySelector('.debut-yes').onclick = function () {
      var b = row.querySelector('.debut-yes');
      b.disabled = true; b.textContent = '外しています…';
      api('debut.skip', { name: name })
        .then(function () { debutLoad(true); })
        .catch(function (e) { b.disabled = false; b.textContent = '対象外にする'; toast(e.message, true); });
    };
  });
}

/** シフト表（今月・来月）へのリンク。ファイルは毎月作り直されるのでURLは毎回サーバーから受け取る */
function renderShiftLinks(links) {
  var el = $('#shiftLinks');
  if (!el) return;
  var use = links.filter(function (l) { return l.url; });
  el.innerHTML = use.map(function (l) {
    return '<a class="btn-link" href="' + esc(l.url) + '" target="_blank" rel="noopener">' +
      esc(l.区分) + 'シフト（' + esc(l.月) + '） →</a>';
  }).join('');
}

/* ============================================================================
 * MTGで決まったこと（ToDo台帳）  2026-09-07
 * ★拓矢さん指示「タスクはMTGの議事録にある内容のみで。チェック入れたら消えるように、
 *   翌週のアジェンダにも完了したものは表示されないように」。
 *   台帳（スプレッドシート）が1つの事実で、ここと火曜のアジェンダが同じものを見る。
 *   チェックした直後だけは「今日やったこと」として残す（押し間違いを戻せるように）。
 * ========================================================================== */
var TODO = { data: null, loading: false };

function todoLoad(sync) {
  if (TODO.loading) return;
  TODO.loading = true;
  var b = $('#btnTodoSync');
  if (sync && b) { b.disabled = true; b.textContent = '取り込み中…'; }
  api('todo.get', { sync: sync ? 1 : '' })
    .then(function (d) { TODO.data = d; renderTodo(); })
    .catch(function (e) { toast(e.message, true); })
    .then(function () {
      TODO.loading = false;
      if (b) { b.disabled = false; b.textContent = '議事録を取り込む'; }
    });
}

function todoRowHtml(t, done) {
  return '<div class="todo-row' + (done ? ' done' : '') + '" data-todo="' + esc(t.id) + '">' +
    '<button class="todo-check" aria-label="完了にする">' + (done ? '✓' : '') + '</button>' +
    '<div class="todo-main">' +
      '<div class="todo-title">' + esc(t.title) + '</div>' +
      (t.detail ? '<div class="todo-detail">' + esc(t.detail) + '</div>' : '') +
      '<div class="todo-meta">' +
        (t.who ? '<span class="todo-who">' + esc(t.who) + '</span>' : '') +
        '<span>' + esc(t.date) + ' のMTG</span>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderTodo() {
  var d = TODO.data; if (!d) return;
  var open = d.open || [], just = d.justDone || [];
  $('#todoSub').textContent = open.length ? '残り ' + open.length + '件' : 'すべて完了';
  var sheet = $('#todoSheet'); if (sheet && d.ssUrl) sheet.href = d.ssUrl;

  var html = open.length
    ? open.map(function (t) { return todoRowHtml(t, false); }).join('')
    : '<div class="todo-empty">残っているものはありません。<br>' +
      '<span class="muted">新しい議事録が出たら「議事録を取り込む」で追加されます。</span></div>';
  if (just.length) {
    html += '<div class="todo-donehead">今日おわらせたもの（' + just.length + '）</div>' +
      just.map(function (t) { return todoRowHtml(t, true); }).join('');
  }
  $('#todoBody').innerHTML = html;
  todoBind();
}

function todoBind() {
  $$('#todoBody .todo-row').forEach(function (row) {
    row.querySelector('.todo-check').onclick = function () {
      var id = row.getAttribute('data-todo');
      var wasDone = row.classList.contains('done');
      row.classList.add('busy');
      api('todo.done', { id: id, off: wasDone ? 1 : '' })
        .then(function () { todoLoad(false); })
        .catch(function (e) { row.classList.remove('busy'); toast(e.message, true); });
    };
  });
}

(function () {
  var b = $('#btnTodoSync');
  if (b) b.addEventListener('click', function () { todoLoad(true); });
})();

/* ============================================================================
 * お知らせ（右上のベル）  2026-09-08
 * ★拓矢さん指示：「期限を過ぎて連絡を取った形跡が無い場合は、
 *   右上の通知マークのところにお知らせが届くようにしてください」
 *
 * ★どこかのタブを開かないと気づけない、では意味がない。
 *   どの画面にいても目に入るように、右上に件数を出す。
 * ========================================================================== */
var NOTICE = { items: [] };

/** 集まったデータからお知らせを組み立てる。増やすときはここに足す */
function noticeBuild() {
  var out = [];

  // ① 声をかける番のスタッフ
  var t = (HB.data && HB.data.trainee) || null;
  if (t && t['要対応']) {
    (t.people || []).filter(function (p) { return p.warn; }).forEach(function (p) {
      out.push({
        kind: 'comm',
        title: p.name + ' さんに声をかける番です',
        body: (p.alerts || []).map(function (a) { return a['文']; }).join('／'),
        go: 'hanbai', tab: 'trainee', who: p.name,
      });
    });
  }

  // ② まもなく初稼働（ホームにも出しているが、見落とすと当日になる）
  var d = (S.data && S.data.debut) || null;
  if (d && d.length) {
    d.forEach(function (p) {
      if (p['いつ'] !== '今日' && p['いつ'] !== '明日') return;
      out.push({
        kind: 'debut',
        title: p['氏名'] + ' さんが ' + p['いつ'] + ' 初稼働です',
        body: (p['枠'] || '') + '　受け入れの準備を確認してください',
        go: 'home',
      });
    });
  }

  NOTICE.items = out;
  noticeBell();
}

function noticeBell() {
  var el = $('#bellN');
  if (!el) return;
  var n = NOTICE.items.length;
  if (!n) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = n < 100 ? String(n) : '99+';
}

function noticeRender() {
  var box = $('#noticeBody');
  if (!box) return;
  if (!NOTICE.items.length) {
    box.innerHTML = '<div class="notice-empty">いまお知らせはありません</div>';
    return;
  }
  box.innerHTML = NOTICE.items.map(function (it, i) {
    return '<div class="notice-row" data-nt="' + i + '">' +
      '<div class="notice-t">' + esc(it.title) + '</div>' +
      (it.body ? '<div class="notice-b">' + esc(it.body) + '</div>' : '') +
    '</div>';
  }).join('');
  $$('#noticeBody .notice-row').forEach(function (r) {
    r.onclick = function () {
      var it = NOTICE.items[Number(r.getAttribute('data-nt'))];
      if (!it) return;
      $('#noticeBox').hidden = true;
      if (it.go === 'hanbai') {
        switchView('hanbai');
        HB.tab = it.tab || 'trainee';
        HB.picked = null;
        $$('#hbTabs .hb-tab').forEach(function (x) {
          x.classList.toggle('active', x.getAttribute('data-hb') === HB.tab); });
        if (HB.data) hbRender();
      } else {
        switchView(it.go || 'home');
      }
    };
  });
}

(function () {
  var b = $('#btnBell');
  if (b) b.addEventListener('click', function () {
    var box = $('#noticeBox');
    if (!box) return;
    box.hidden = !box.hidden;
    if (!box.hidden) { noticeRender(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  });
  var x = $('#noticeX');
  if (x) x.addEventListener('click', function () { $('#noticeBox').hidden = true; });
})();

/* ============================================================
 * 音声入力とAI整形  2026-09-08
 * ------------------------------------------------------------
 * 拓矢さんの依頼：
 *   「直近の状況の入力を音声でできた方が楽。ただ音声は誤字や変換ミスが出るので、
 *     それをAIが修正して反映まで自動化したい。文字入力と音声入力の両方できるのがベスト」
 *
 * ★2つの入り口を用意した（どちらか片方しか使えない端末があるため）
 *   ① 🎤 話す … ブラウザの音声認識。押している間だけ拾い、止めると自動でAIが整える
 *   ② ✨ 整える … 手で打った文・スマホのキーボードのマイクで入れた文を、押したときだけ整える
 *
 *   ①が使えない端末（LINE WORKS内のブラウザなど）でも、
 *   **キーボードのマイクで入れて②を押せば同じことができる**。だから②を必ず出す。
 *
 * ★勝手に書き換えない
 *   整えたあとは必ず「元に戻す」を出す。AIが直した結果が気に入らないときに、
 *   打ち直しにならないようにするため。
 * ============================================================ */
var VC = {
  rec: null,          // いま録音中の SpeechRecognition
  target: null,       // 録音先の入力欄
  base: '',           // 録音を始めた時点の文（確定ぶんを足していく土台）
  before: {},         // 整える前の文（元に戻す用）。キーは入力欄のid
};

/** この端末で音声認識が使えるか */
function vcCanSpeak() {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
}

/**
 * 入力欄の上に「🎤 話す」「✨ 整える」を付ける。
 * @param {string} id     入力欄のid
 * @param {string} label  ラベルの文字
 */
function vcLabel(id, label) {
  return '<div class="vc-row"><label for="' + id + '">' + label + '</label>' +
    '<div class="vc-btns">' +
      (vcCanSpeak() ? '<button type="button" class="vc-b" data-vcmic="' + id + '">🎤 話す</button>' : '') +
      '<button type="button" class="vc-b" data-vctidy="' + id + '">✨ 整える</button>' +
    '</div></div>';
}

/** 表記を合わせたい氏名（名簿の表記）を渡す。★一覧に無い名前は置き換えさせない */
function vcNames() {
  try {
    return (HB.data && HB.data.staff ? HB.data.staff : []).map(function (r) { return r[0]; })
      .filter(Boolean).join(',');
  } catch (e) { return ''; }
}

/** 録音を止める（画面の見た目も戻す） */
function vcStop() {
  if (VC.stopNow) { VC.stopNow(); VC.stopNow = null; return; }
  if (VC.rec) { try { VC.rec.stop(); } catch (e) {} }
}

/** マイクを押したとき */
function vcMic(id, btn) {
  var el = $('#' + id);
  if (!el) return;

  // 押し直し＝止める
  if (VC.rec && VC.target === el) { vcStop(); return; }
  vcStop();

  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  var rec = new SR();
  rec.lang = 'ja-JP';
  // ★continuous は false（2026-09-08）。
  //   true にすると Android の Chrome が**同じ確定文を何度も返す**ため、
  //   「そしたらそしたら 最近そしたら 最近そしたら…」と際限なく増える（実機で確認）。
  //   1発話ごとに区切り、下の onend で自分で再開する形にすれば重ならない。
  rec.continuous = false;
  rec.interimResults = true;      // 話している途中も出す（止まって見えないように）

  VC.rec = rec; VC.target = el;
  VC.base = el.value ? el.value.replace(/\s+$/, '') + '\n' : '';

  var live = vcLiveBox(el);
  btn.classList.add('on'); btn.textContent = '■ 止める';

  var parts = [];                 // 確定した文をためる
  var stopped = false;            // 「止める」を押したか
  var got = false;                // 一度でも文字になったか

  rec.onresult = function (ev) {
    var interim = '';
    for (var i = 0; i < ev.results.length; i++) {
      var t = ev.results[i][0].transcript;
      if (!ev.results[i].isFinal) { interim += t; continue; }
      // ★同じ確定文が続けて来たら捨てる（Androidの二重返しへの二段目の守り）
      if (parts[parts.length - 1] === t) continue;
      parts.push(t);
      got = true;
    }
    el.value = VC.base + parts.join('') + interim;
    if (live) live.textContent = interim ? '…' + interim : '';
    el.scrollTop = el.scrollHeight;
  };

  rec.onerror = function (ev) {
    if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
      stopped = true;
      toast('マイクが使えません。ブラウザの設定で許可してください', true);
    } else if (ev.error !== 'aborted' && ev.error !== 'no-speech') {
      stopped = true;
      toast('音声認識が止まりました（' + ev.error + '）', true);
    }
    // no-speech / aborted は黙って続ける（下の onend が再開する）
  };

  rec.onend = function () {
    // ★止めるまでは自分で再開する。continuous=false の代わり
    if (!stopped) {
      try { rec.start(); return; } catch (e) { /* 再開できなければ終わる */ }
    }
    VC.rec = null; VC.target = null;
    btn.classList.remove('on'); btn.textContent = '🎤 話す';
    if (live) live.remove();
    if (got) toast('文字にしました。おかしいところは直してください');
  };

  // 「止める」を押したときに再開させないための入口
  VC.stopNow = function () { stopped = true; try { rec.stop(); } catch (e) {} };

  try { rec.start(); } catch (e) { stopped = true; toast('マイクを開けませんでした', true); rec.onend(); }
}

/** 話している途中の文を出す小さな行 */
function vcLiveBox(el) {
  var d = document.createElement('div');
  d.className = 'vc-live';
  el.parentNode.insertBefore(d, el.nextSibling);
  return d;
}

/**
 * AIに整えてもらう。
 * @param {boolean} auto  音声の後の自動実行か（トーストの出し方を変える）
 */
function vcTidy(id, btn, auto) {
  var el = $('#' + id);
  if (!el) return;
  var text = String(el.value || '').trim();
  if (!text) { if (!auto) toast('先に入力してください', true); return; }

  var b = btn || document.querySelector('[data-vctidy="' + id + '"]');
  if (b) { b.disabled = true; b.textContent = '整えています…'; }

  // ★45秒で諦める。AIが混んでいるときに「整えています…」のまま固まらせない
  api('ai.tidy', { text: text, names: vcNames() }, 45000).then(function (d) {
    if (b) { b.disabled = false; b.textContent = '✨ 整える'; }
    if (!d || !d.text) { toast('整えられませんでした', true); return; }
    if (d.text === text) { toast('直すところはありませんでした'); return; }
    VC.before[id] = text;
    el.value = d.text;
    vcUndoBar(el, id);
    toast(auto ? '文字にして整えました' : '整えました');
  }).catch(function (e) {
    if (b) { b.disabled = false; b.textContent = '✨ 整える'; }
    toast(e.message || '整えられませんでした', true);
  });
}

/** 「元に戻す」の行を出す。★AIの直しが気に入らないとき打ち直しにならないように */
function vcUndoBar(el, id) {
  var old = el.parentNode.querySelector('[data-vcundo="' + id + '"]');
  if (old) old.remove();
  var d = document.createElement('div');
  d.className = 'vc-undo';
  d.setAttribute('data-vcundo', id);
  d.innerHTML = '<span>AIが整えました</span><button type="button">元に戻す</button>';
  d.querySelector('button').onclick = function () {
    if (VC.before[id] != null) el.value = VC.before[id];
    d.remove();
  };
  el.parentNode.insertBefore(d, el.nextSibling);
}

/** 画面を描き直すたびに呼ぶ（ボタンにイベントを付け直す） */
function vcBind() {
  $$('[data-vcmic]').forEach(function (b) {
    b.onclick = function () { vcMic(b.getAttribute('data-vcmic'), b); };
  });
  $$('[data-vctidy]').forEach(function (b) {
    b.onclick = function () { vcTidy(b.getAttribute('data-vctidy'), b, false); };
  });
}

/* ============================================================
 * 初期設定スタッフ  2026-09-08
 * ------------------------------------------------------------
 * 拓矢さんの依頼：
 *   「近況確認は販売スタッフだけじゃなく初期設定スタッフの方も必要。別タブで作って、
 *     近況確認と、個別で見た時に実績の確認だけできるように。1日平均設定台数も。
 *     ＋日報の備考欄に記入があれば気になる人のところに上げて」
 *
 * ★数字は日報（Form）から。名前は名簿のフルネームに寄せてある。
 *   ヒアリングの記録は販売スタッフと同じ置き場（Driveの非公開JSON）を見ている。
 * ============================================================ */
var SK = { data: null, tab: 'watch', picked: null };

function skLoad(fresh) {
  var sub = $('#skSub');
  if (sub) sub.textContent = fresh ? '作り直しています…（30秒ほど）' : '読み込み中…';
  var params = fresh ? { fresh: '1' } : {};
  api('shoki.get', params, fresh ? 180000 : 45000).then(function (d) {
    SK.data = d;
    skRender();
  }).catch(function (e) {
    if (sub) sub.textContent = '読み込めませんでした：' + (e.message || '');
  });
}

function skEsc(s) { return esc(String(s === null || s === undefined ? '' : s)); }

function skRender() {
  var d = SK.data, body = $('#skBody'), sub = $('#skSub');
  if (!d || !body) return;
  if (sub) {
    sub.textContent = (d.staff || []).length + '名　' + (d.対象月 || '') +
      '　更新 ' + (d.作った時刻 || '');
  }
  var b = $('#skBadge');
  if (b) {
    var n = (d.連絡 || {}).要対応 || 0;
    b.hidden = !n; b.textContent = n;
  }
  if (SK.picked) { body.innerHTML = skDetail(SK.picked); return skBind(); }
  if (SK.tab === 'watch') body.innerHTML = skWatch();
  else if (SK.tab === 'comm') body.innerHTML = skComm();
  else body.innerHTML = skList();
  skBind();
}

/** 気になる人＝日報の備考に書き込みがあった人（直近30日） */
function skWatch() {
  var rows = (SK.data.気になる || []);
  if (!rows.length) {
    return '<div class="hb-card"><div class="hb-empty">直近30日で、日報の備考に書き込みはありません</div></div>';
  }
  var h = '<div class="hb-note">日報の「その他」欄に書き込みがあったものです。' +
    '本人が伝えたいことなので、拾って返すと効きます。</div>';
  rows.forEach(function (r) {
    h += '<div class="hb-card sk-biko" data-skopen="' + skEsc(r.氏名) + '">' +
      '<div class="sk-biko-h">' + skEsc(r.日付) + '　<b>' + skEsc(r.氏名) + '</b>' +
      (r.店舗 ? '　<span class="sk-store">' + skEsc(r.店舗) + '</span>' : '') + '</div>' +
      '<div class="sk-biko-b">' + skEsc(r.本文) + '</div></div>';
  });
  return h;
}

/** 連絡状況 */
function skComm() {
  var c = SK.data.連絡 || {};
  var ps = c.people || [];
  if (!ps.length) {
    return '<div class="hb-card"><div class="hb-empty">対象のスタッフがいません</div></div>';
  }
  var todo = ps.filter(function (p) { return p.要対応; });
  var ok = ps.filter(function (p) { return !p.要対応; });

  var h = todo.length
    ? '<div class="hb-alert"><b>' + todo.length + '名</b> 声をかける番です</div>'
    : '<div class="hb-ok">全員と連絡が取れています</div>';
  todo.forEach(function (p) { h += skCommCard(p, true); });
  if (ok.length) {
    h += '<div class="hb-h2">連絡できている（' + ok.length + '名）</div>';
    ok.forEach(function (p) { h += skCommCard(p, false); });
  }
  h += '<div class="hb-card"><div class="hb-meta">' + skEsc(c.ルール || '') +
       (SK.data.作った時刻 ? '<br><br>この集計を作った時刻：' + skEsc(SK.data.作った時刻) : '') +
       '</div></div>';
  return h;
}

/** ★クラス名は販売スタッフ側（hbTrainee）と同じものを使う。
 *   別名にすると CSS が当たらず、暗くしたときに枠や色が出ない（2026-09-09に実際に起きた）。 */
function skCommCard(p, warn) {
  return '<div class="tr-card' + (warn ? ' warn' : '') + '" data-skopen="' + skEsc(p.name) + '">' +
    '<div class="tr-top"><b>' + skEsc(p.name) + '</b>' +
    (p.新規 ? '<span class="tr-new">新しい人</span>' : '') +
    '<span class="tr-shift">今月' + p.月稼働日 + '日／のべ' + p.のべ日数 + '日</span></div>' +
    (p.理由 || []).map(function (r) {
      return '<div class="tr-alert' + (warn ? '' : ' soft') + '">' +
        (warn ? '⚠️ ' : '') + skEsc(r) + '</div>';
    }).join('') +
    // ★記録が無い人は理由の方に同じ文が出るので、ここは出さない（二重に見える）
    (p.lastHeard
      ? '<div class="tr-meta">最後に話を聞いた：' + skEsc(p.lastHeard) + '（' + p.経過日 + '日前' +
        (p.heardBy ? '・' + skEsc(p.heardBy) : '') + '）' +
        (p.最終 ? '　／　最後の稼働：' + skEsc(p.最終) : '') + '</div>'
      : (p.最終 ? '<div class="tr-meta">最後の稼働：' + skEsc(p.最終) + '</div>' : '')) +
    (p.heardNote ? '<div class="tr-note">' + skEsc(String(p.heardNote).slice(0, 90)) + '</div>' : '') +
    '</div>';
}

/** スタッフ一覧 */
function skList() {
  var ss = SK.data.staff || [];
  var h = '<div class="hb-card"><table class="hb-tbl sk-tbl">' +
    '<tr><th style="text-align:left">名前</th><th>今月</th><th>設定</th><th>1日</th><th>のべ</th></tr>';
  ss.forEach(function (p) {
    h += '<tr data-skopen="' + skEsc(p.name) + '"><td style="text-align:left">' + skEsc(p.name) +
      (p.名簿にある ? '' : '<span class="sk-nomeibo">名簿外</span>') + '</td>' +
      '<td>' + p.月稼働日 + '</td><td>' + p.月設定 + '</td>' +
      '<td><b>' + p.設定1日 + '</b></td><td>' + p.のべ日数 + '</td></tr>';
  });
  return h + '</table></div>';
}

/** 個別 */
function skDetail(name) {
  var p = (SK.data.staff || []).filter(function (x) { return x.name === name; })[0];
  if (!p) return '<div class="hb-card"><div class="hb-empty">見つかりません</div></div>';
  var ms = (SK.data.months || {})[name] || [];
  var comm = ((SK.data.連絡 || {}).people || []).filter(function (x) { return x.name === name; })[0];

  var h = '<button class="hb-ghost" id="skBack">← もどる</button>' +
    '<div class="hb-h1">' + skEsc(name) + '</div>' +
    '<div class="hb-card sk-sum">' +
      '<div><span>今月の稼働</span><b>' + p.月稼働日 + '<small>日</small></b></div>' +
      '<div><span>今月の設定</span><b>' + p.月設定 + '<small>件</small></b></div>' +
      '<div><span>1日平均</span><b>' + p.設定1日 + '<small>件</small></b></div>' +
      '<div><span>のべ稼働</span><b>' + p.のべ日数 + '<small>日</small></b></div>' +
    '</div>' +
    '<div class="hb-meta">初回 ' + skEsc(p.初回) + '　最終 ' + skEsc(p.最終) +
    (p.よく行く店 ? '　よく行く店：' + skEsc(p.よく行く店) : '') + '</div>';

  if (comm) {
    h += '<div class="tr-card' + (comm.要対応 ? ' warn' : '') + '" style="margin-top:12px">' +
      '<div class="tr-top"><b>連絡状況</b></div>' +
      (comm.理由 || []).map(function (r) {
        return '<div class="tr-alert' + (comm.要対応 ? '' : ' soft') + '">' +
          (comm.要対応 ? '⚠️ ' : '') + skEsc(r) + '</div>';
      }).join('') +
      (comm.lastHeard
        ? '<div class="tr-meta">最後に話を聞いた：' + skEsc(comm.lastHeard) +
          '（' + comm.経過日 + '日前）</div>'
        : '') +
      '</div>';
  }

  h += '<div class="hb-h2">月ごとの数字</div><div class="hb-card"><table class="hb-tbl">' +
    '<tr><th>月</th><th>稼働</th><th>設定</th><th>操作</th><th>その他</th><th>設定/日</th></tr>';
  if (!ms.length) h += '<tr><td colspan="6" style="text-align:left;opacity:.55">まだありません</td></tr>';
  ms.forEach(function (m) {
    var other = (m.合計 || 0) - (m.shoki || 0) - (m.sousa || 0);
    h += '<tr><td>' + skEsc(m.月) + '</td><td>' + m.稼働日 + '</td>' +
      '<td><b>' + m.shoki + '</b></td><td>' + m.sousa + '</td><td>' + other + '</td>' +
      '<td>' + m.設定1日 + '</td></tr>';
  });
  h += '</table></div>';

  var bikos = (SK.data.気になる || []).filter(function (x) { return x.氏名 === name; });
  if (bikos.length) {
    h += '<div class="hb-h2">日報に書いてくれたこと（直近30日）</div><div class="hb-card">';
    bikos.forEach(function (b) {
      h += '<div class="hb-hear"><div class="h">' + skEsc(b.日付) +
        (b.店舗 ? '　' + skEsc(b.店舗) : '') + '</div><div>' + skEsc(b.本文) + '</div></div>';
    });
    h += '</div>';
  }

  // ヒアリングを足す（販売スタッフと同じ置き場に入る）
  h += '<div class="hb-h2">話を聞いたら記録する</div><div class="hb-card hb-f">' +
    '<label>日付</label><input id="skHDate" type="date" value="' + new Date().toISOString().slice(0, 10) + '">' +
    '<label>聞いた人</label><input id="skHBy" value="' + skEsc((S.user && S.user.name) || '') + '">' +
    vcLabel('skHText', '内容') +
    '<textarea id="skHText" placeholder="話したこと・本人が言っていたこと／🎤 を押すと話した内容が入ります"></textarea>' +
    vcLabel('skHNext', '次の一手') +
    '<input id="skHNext" placeholder="例）来月のシフトを一緒に見る">' +
    '<button class="hb-go" id="skHGo" data-skfor="' + skEsc(name) + '">保存する</button></div>';
  return h;
}

function skBind() {
  vcBind();
  $$('[data-skopen]').forEach(function (el) {
    el.onclick = function (ev) {
      ev.stopPropagation();
      SK.picked = el.getAttribute('data-skopen');
      setHash(stateHash());          // ★戻るで一覧へ帰れるように履歴を1つ積む
      window.scrollTo({ top: 0, behavior: 'smooth' });
      skRender();
    };
  });
  var back = $('#skBack');
  if (back) back.onclick = function () { SK.picked = null; setHash('shoki'); skRender(); };

  var go = $('#skHGo');
  if (go) go.onclick = function () {
    var who = go.getAttribute('data-skfor');
    var tx = ($('#skHText') || {}).value || '';
    if (!tx.trim()) return toast('内容を書いてください', true);
    go.disabled = true; go.textContent = '保存中…';
    api('hanbai.hear', {
      d: ($('#skHDate') || {}).value || '', n: who,
      by: ($('#skHBy') || {}).value || '', tx: tx,
      nx: ($('#skHNext') || {}).value || '',
    }, 60000).then(function () {
      go.disabled = false; go.textContent = '保存する';
      toast('記録しました。連絡状況に反映されます');
      $('#skHText').value = ''; $('#skHNext').value = '';
    }).catch(function (e) {
      go.disabled = false; go.textContent = '保存する'; toast(e.message, true);
    });
  };
}

$$('#skTabs .hb-tab').forEach(function (b) {
  b.addEventListener('click', function () {
    $$('#skTabs .hb-tab').forEach(function (x) { x.classList.remove('active'); });
    b.classList.add('active');
    SK.tab = b.getAttribute('data-sk');
    SK.picked = null;
    skRender();
  });
});
(function () {
  var r = $('#skReload');
  if (r) r.addEventListener('click', function () { skLoad(true); });
})();

/* ============================================================
 * よく使う外部の画面  2026-09-09
 * ------------------------------------------------------------
 * 拓矢さんの困りごと：
 *   「交通費申請もアプリで保存したいんだけどWORKS以外だと開けないのなんとかして」
 *
 * ★なぜ開けないか
 *   GASのウェブアプリは、**ブラウザがログイン中のGoogleアカウント**で開こうとする。
 *   telekids で作った画面を、個人のGmailでログイン中のChromeから開くと
 *   「現在、ファイルを開くことができません」になる。URLは誰でも開ける設定なのに、
 *   ログインしていることが逆に邪魔をする。
 *
 * ★hub は正しい authuser を知っている
 *   API を叩くときに 0→1→2→3 と試して、通った番号を覚えてある（AUTH_KEY）。
 *   その番号を付けて開けば、同じアカウントで開くので弾かれない。
 *
 * ★ここに足せば「アプリの中から開く」形になり、ホーム画面に別のアイコンを
 *   増やさなくて済む（拓矢さんの「アプリで保存したい」への答え）。
 * ============================================================ */
var EXT_LINKS = [
  { name: '交通費の申請', note: '回数を入れてPDFを作る',
    url: 'https://script.google.com/macros/s/AKfycbzPMoex467wNQT09b6ZtxnCKssvK0xqsOfnyVgYttBLqJFINMqDPXzq6VaJhclAWyk6OQ/exec' },
];

function extRender() {
  var root = $('#extLinks');
  if (!root) return;
  var au = authNow();
  root.innerHTML = EXT_LINKS.map(function (l) {
    var u = l.url + (au ? (l.url.indexOf('?') >= 0 ? '&' : '?') + 'authuser=' + encodeURIComponent(au) : '');
    return '<a class="ext-link" href="' + esc(u) + '" target="_blank" rel="noopener">' +
      '<span class="ext-name">' + esc(l.name) + '</span>' +
      '<span class="ext-note">' + esc(l.note) + '</span>' +
      '<span class="ext-go">開く →</span></a>';
  }).join('');
}
