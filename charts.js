/* ===========================================================================
   provide hub ─ グラフ描画（ライブラリなし・インラインSVG）
   ・外部CDNを読まないので、社内ネットワークやオフラインでも同じ絵が出る
   ・色は1系列ごとに固定。系列が増えても色を使い回さない
   ・線/棒どちらもホバーで数値を出す（画面上で数字を読めることを優先）
   =========================================================================== */
(function (global) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';
  function el(name, attrs) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }
  function mmdd(iso) { return iso ? Number(iso.slice(5, 7)) + '/' + Number(iso.slice(8, 10)) : ''; }

  /** 目盛りの上限を「きりのいい数」に丸める */
  function niceMax(v) {
    if (v <= 0) return 1;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }

  /* -------------------------------------------------------------------------
     折れ線（時系列）。1系列専用＝凡例は置かず、見出しが系列名を兼ねる。
     ------------------------------------------------------------------------- */
  function lineChart(box, opt) {
    var data = opt.data || [];
    var W = 640, H = 190, P = { t: 14, r: 14, b: 26, l: 38 };
    var color = opt.color || cssVar('--series-1');

    box.innerHTML = '';
    if (opt.title) { var t = document.createElement('div'); t.className = 'chart-title'; t.textContent = opt.title; box.appendChild(t); }
    if (opt.note) { var n = document.createElement('div'); n.className = 'chart-note'; n.textContent = opt.note; box.appendChild(n); }
    if (!data.length) { box.appendChild(emptyNote_()); return; }

    var max = niceMax(Math.max.apply(null, data.map(function (d) { return d.value; })) || 1);
    var innerW = W - P.l - P.r, innerH = H - P.t - P.b;
    var x = function (i) { return P.l + (data.length === 1 ? innerW / 2 : innerW * i / (data.length - 1)); };
    var y = function (v) { return P.t + innerH - innerH * (v / max); };

    var svg = el('svg', { class: 'chart', viewBox: '0 0 ' + W + ' ' + H, role: 'img',
      'aria-label': (opt.title || '推移') + 'のグラフ' });

    // 目盛り（控えめに3本）
    [0, 0.5, 1].forEach(function (r) {
      var v = max * r, yy = y(v);
      svg.appendChild(el('line', { x1: P.l, x2: W - P.r, y1: yy, y2: yy, stroke: cssVar('--grid'), 'stroke-width': 1 }));
      var lb = el('text', { x: P.l - 6, y: yy + 4, 'text-anchor': 'end', fill: cssVar('--muted'), 'font-size': 11 });
      lb.textContent = String(Math.round(v));
      svg.appendChild(lb);
    });

    // 面（薄く）＋ 線
    var dLine = data.map(function (d, i) { return (i ? 'L' : 'M') + x(i) + ' ' + y(d.value); }).join(' ');
    svg.appendChild(el('path', {
      d: dLine + ' L' + x(data.length - 1) + ' ' + y(0) + ' L' + x(0) + ' ' + y(0) + ' Z',
      fill: color, opacity: .10,
    }));
    svg.appendChild(el('path', { d: dLine, fill: 'none', stroke: color, 'stroke-width': 2,
      'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    // 点（8px以上・面に埋もれないよう地色のリングを付ける）
    // 最終日はまだ入力が締まっていないことが多いので、中を抜いて「確定していない」と分かるようにする
    data.forEach(function (d, i) {
      var isLast = (i === data.length - 1);
      if (d.value === 0 && !isLast) return;
      svg.appendChild(el('circle', {
        cx: x(i), cy: y(d.value), r: 4,
        fill: (isLast && opt.lastPending) ? cssVar('--surface-1') : color,
        stroke: (isLast && opt.lastPending) ? color : cssVar('--surface-1'),
        'stroke-width': 2,
      }));
    });

    // 直近の値だけ数字を出す（全点に数字は置かない）
    var lastIdx = data.length - 1;
    var lbl = el('text', { x: x(lastIdx), y: y(data[lastIdx].value) - 10, 'text-anchor': 'end',
      fill: cssVar('--text-1'), 'font-size': 12, 'font-weight': 700 });
    lbl.textContent = String(data[lastIdx].value);
    svg.appendChild(lbl);

    // 日付ラベル（両端＋中央）
    [0, Math.floor(lastIdx / 2), lastIdx].forEach(function (i) {
      var tx = el('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : (i === lastIdx ? 'end' : 'middle'),
        fill: cssVar('--muted'), 'font-size': 11 });
      tx.textContent = mmdd(data[i].date);
      svg.appendChild(tx);
    });

    // ホバー：縦線＋吹き出し
    var cross = el('line', { y1: P.t, y2: P.t + innerH, stroke: cssVar('--axis'), 'stroke-width': 1, opacity: 0 });
    svg.appendChild(cross);
    var hit = el('rect', { x: P.l, y: P.t, width: innerW, height: innerH, fill: 'transparent' });
    svg.appendChild(hit);
    box.appendChild(svg);

    var tip = tooltip_(box);
    hit.addEventListener('mousemove', function (ev) {
      var r = svg.getBoundingClientRect();
      var px = (ev.clientX - r.left) / r.width * W;
      var i = Math.round((px - P.l) / (innerW || 1) * (data.length - 1));
      i = Math.max(0, Math.min(data.length - 1, i));
      cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('opacity', .5);
      tip.show(ev, mmdd(data[i].date) + '　<b>' + data[i].value + '</b>' + (opt.unit || ''));
    });
    hit.addEventListener('mouseleave', function () { cross.setAttribute('opacity', 0); tip.hide(); });
  }

  /* -------------------------------------------------------------------------
     横棒（順位）。名前と数値をその場に置くので、色に意味を持たせない。
     ------------------------------------------------------------------------- */
  function barList(box, opt) {
    var items = (opt.items || []).filter(function (i) { return i.value > 0 || opt.keepZero; });
    box.innerHTML = '';
    if (opt.title) { var t = document.createElement('div'); t.className = 'chart-title'; t.textContent = opt.title; box.appendChild(t); }
    if (opt.note) { var n = document.createElement('div'); n.className = 'chart-note'; n.textContent = opt.note; box.appendChild(n); }
    if (!items.length) { box.appendChild(emptyNote_()); return; }

    var max = Math.max.apply(null, items.map(function (i) { return i.value; })) || 1;
    var wrap = document.createElement('div');
    wrap.className = 'bar-row';
    items.slice(0, opt.limit || 8).forEach(function (it) {
      var line = document.createElement('div');
      line.className = 'bar-line';
      var name = document.createElement('div');
      name.className = 'bar-name'; name.textContent = it.name; name.title = it.name;
      var track = document.createElement('div');
      track.className = 'bar-track';
      var fill = document.createElement('div');
      fill.className = 'bar-fill';
      fill.style.width = Math.max(2, it.value / max * 100) + '%';
      if (opt.color) fill.style.background = opt.color;
      track.appendChild(fill);
      var val = document.createElement('div');
      val.className = 'bar-val'; val.textContent = it.value + (opt.unit || '');
      line.appendChild(name); line.appendChild(track); line.appendChild(val);
      wrap.appendChild(line);
    });
    box.appendChild(wrap);
  }

  /* ---------- 小物 ---------- */
  function emptyNote_() {
    var d = document.createElement('div');
    d.className = 'chart-note';
    d.textContent = 'この期間のデータはまだありません';
    return d;
  }

  function tooltip_(box) {
    var tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;z-index:70;pointer-events:none;background:var(--text-1);color:var(--surface-1);' +
      'padding:5px 10px;border-radius:8px;font-size:12px;white-space:nowrap;display:none;box-shadow:var(--shadow)';
    document.body.appendChild(tip);
    return {
      show: function (ev, html) {
        tip.innerHTML = html;
        tip.style.display = 'block';
        tip.style.left = Math.min(ev.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px';
        tip.style.top = (ev.clientY - 34) + 'px';
      },
      hide: function () { tip.style.display = 'none'; },
    };
  }

  global.Charts = { line: lineChart, bars: barList };
})(window);
