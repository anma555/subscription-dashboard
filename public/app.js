'use strict';
/* global d3 */
// サブスク契約ダッシュボード：/api/data のダミーデータを集計して描画する。

const DAYS = { '30d': 30, '90d': 90, '180d': 180, '365d': 365 };
const LABEL = { '30d': '直近30日', '90d': '直近90日', '180d': '直近180日', '365d': '直近1年', all: '全期間' };
const SEGS = [
  { pf: 'ios', pl: 'monthly', name: 'iOS · 月額', color: 'var(--c1)' },
  { pf: 'ios', pl: 'yearly', name: 'iOS · 年額', color: 'var(--c2)' },
  { pf: 'android', pl: 'monthly', name: 'Android · 月額', color: 'var(--c3)' },
  { pf: 'android', pl: 'yearly', name: 'Android · 年額', color: 'var(--c4)' },
];
const PF_LABEL = { ios: 'iOS', android: 'Android', all: 'すべて' };
const PL_LABEL = { monthly: '月額', yearly: '年額', all: 'すべて' };
const DEFAULTS = { period: '90d', platform: 'all', plan: 'all' };

const state = {
  ...DEFAULTS,
  view: 'dashboard',
  data: null,
  series: null, // key "platform|plan" → 日付順の行（'all' を含む）
  raw: { mode: 'daily', sortKey: 'date', sortDir: 1, page: 0, size: 100, q: '' },
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const fmt = {
  int: d3.format(','), signed: d3.format('+,'), dec: d3.format(',.1f'),
  chg: d3.format('+.1%'), pct: d3.format('.1%'), pct2: d3.format('.2%'),
  pt1: d3.format('+.1f'), pt2: d3.format('+.2f'),
};
const fDay = d3.utcFormat('%Y/%-m/%-d');
const fShort = d3.utcFormat('%-m/%-d');
const man = (v) => '¥' + fmt.int(Math.round(v / 10000)) + '万';
const parseDay = (s) => new Date(s + 'T00:00:00Z');

// ---------- 集計 ----------
function buildSeries(rows) {
  const fields = ['new_subs', 'churned', 'trial_starts', 'trial_conversions', 'active', 'mrr'];
  const m = new Map();
  for (const r of rows) {
    for (const platform of [r.platform, 'all']) {
      for (const plan of [r.plan, 'all']) {
        const key = platform + '|' + plan;
        if (!m.has(key)) m.set(key, new Map());
        const byDate = m.get(key);
        let o = byDate.get(r.date);
        if (!o) {
          o = { date: r.date, d: parseDay(r.date), platform, plan };
          for (const f of fields) o[f] = 0;
          byDate.set(r.date, o);
        }
        for (const f of fields) o[f] += r[f];
      }
    }
  }
  const out = {};
  for (const [key, byDate] of m) out[key] = [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  return out;
}

const dashPeriod = () => (DAYS[state.period] ? state.period : '365d');
const windowRows = (pf, pl) => {
  const all = state.series[pf + '|' + pl];
  return all ? all.slice(-DAYS[dashPeriod()]) : [];
};

const kpiCache = new Map();
function kpis(period, pf, pl) {
  const key = [period, pf, pl].join('|');
  if (kpiCache.has(key)) return kpiCache.get(key);
  const rows = state.series[pf + '|' + pl];
  const n = DAYS[period];
  const stats = (rs, before) => {
    const sum = (f) => rs.reduce((s, r) => s + r[f], 0);
    const last = rs[rs.length - 1];
    return {
      active: last.active, mrr: last.mrr,
      startActive: before ? before.active : rs[0].active - rs[0].new_subs + rs[0].churned,
      startMrr: before ? before.mrr : rs[0].mrr,
      new_subs: sum('new_subs'), churned: sum('churned'),
      trial_starts: sum('trial_starts'), trial_conversions: sum('trial_conversions'),
      churn_rate: sum('churned') / (sum('active') / rs.length) * 30 / rs.length,
    };
  };
  const cur = stats(rows.slice(-n), rows[rows.length - n - 1]);
  const prevRows = rows.slice(Math.max(0, rows.length - 2 * n), rows.length - n);
  const prev = prevRows.length ? stats(prevRows, rows[rows.length - 2 * n - 1]) : null;
  const conv = cur.trial_conversions / cur.trial_starts;
  const convPrev = prev ? prev.trial_conversions / prev.trial_starts : NaN;
  const totalMrr = state.series['all|all'][state.series['all|all'].length - 1].mrr;
  const r = {
    active: cur.active, active_chg: cur.active / cur.startActive - 1, net_adds: cur.active - cur.startActive,
    new_subs: cur.new_subs, new_chg: prev ? cur.new_subs / prev.new_subs - 1 : NaN, new_per_day: cur.new_subs / n,
    churned: cur.churned, churn_chg: prev ? cur.churned / prev.churned - 1 : NaN,
    churn_rate: cur.churn_rate, churn_rate_diff_pt: prev ? (cur.churn_rate - prev.churn_rate) * 100 : NaN,
    mrr: cur.mrr, mrr_man: Math.round(cur.mrr / 10000), mrr_chg: cur.mrr / cur.startMrr - 1, arpu: Math.round(cur.mrr / cur.active),
    mrr_share: cur.mrr / totalMrr,
    trial_starts: cur.trial_starts, trial_conversions: cur.trial_conversions,
    conv_rate: conv, conv_rate_diff_pt: (conv - convPrev) * 100,
  };
  kpiCache.set(key, r);
  return r;
}

const weekly = () => DAYS[dashPeriod()] > 90;
function bucket(rs) {
  if (!weekly()) return rs.map((r) => ({ ...r, end: r.d }));
  const out = [];
  for (const r of rs) {
    const k = +d3.utcMonday.floor(r.d);
    let b = out[out.length - 1];
    if (!b || +b.d !== k) {
      b = { d: new Date(k), end: r.d, new_subs: 0, churned: 0, trial_starts: 0, trial_conversions: 0 };
      out.push(b);
    }
    b.end = r.d;
    b.new_subs += r.new_subs; b.churned += r.churned;
    b.trial_starts += r.trial_starts; b.trial_conversions += r.trial_conversions;
    b.active = r.active; b.mrr = r.mrr;
  }
  return out;
}
const bucketTitle = (b) => (weekly() && +b.end !== +b.d ? fShort(b.d) + '〜' + fShort(b.end) + 'の週' : fDay(b.d));

const eventMatches = (e) => state.platform === 'all' || e.platform === 'all' || e.platform === state.platform;
function eventsIn(from, to) {
  return state.data.events
    .map((e) => ({ ...e, d: parseDay(e.date) }))
    .filter((e) => e.d >= from && e.d <= to && eventMatches(e))
    .map((e, i) => ({ ...e, n: i + 1 }));
}

// ---------- 描画ヘルパー ----------
function makeSvg(el, h) {
  el.replaceChildren();
  const w = Math.max(260, Math.round(el.clientWidth || 600));
  const s = d3.select(el).append('svg').attr('class', 'sx-svg').attr('width', '100%').attr('viewBox', `0 0 ${w} ${h}`);
  return { s, w };
}
function textWidth(s, strs) {
  const g = s.append('g');
  let m = 0;
  for (const t of strs) m = Math.max(m, g.append('text').attr('class', 'sx-tick').text(t).node().getComputedTextLength());
  g.remove();
  return m;
}
function yAxis(s, y, ticks, f, ml, w) {
  const g = s.append('g');
  for (const t of ticks) {
    g.append('line').attr('x1', ml).attr('x2', w).attr('y1', y(t)).attr('y2', y(t)).style('stroke', 'var(--grid)');
    g.append('text').attr('class', 'sx-tick').attr('x', ml - 8).attr('y', y(t)).attr('dy', '0.32em').attr('text-anchor', 'end').text(f(t));
  }
}
function xLabels(s, items, y, w) {
  const g = s.append('g');
  let lastRight = -Infinity;
  for (const it of items) {
    const t = g.append('text').attr('class', 'sx-tick').attr('x', it.x).attr('y', y).attr('text-anchor', 'middle').text(it.text);
    const tw = t.node().getComputedTextLength();
    if (it.x - tw / 2 < 0 || it.x + tw / 2 > w || it.x - tw / 2 < lastRight + 10) t.remove();
    else lastRight = it.x + tw / 2;
  }
}
function eventMarkers(s, evs, xOf, top, bottomY) {
  for (const e of evs) {
    const ex = xOf(e);
    s.append('line').attr('x1', ex).attr('x2', ex).attr('y1', top - 4).attr('y2', bottomY)
      .style('stroke', 'var(--ref)').attr('stroke-dasharray', '3 3');
    s.append('circle').attr('cx', ex).attr('cy', 10).attr('r', 9).style('fill', 'var(--panel)').style('stroke', 'var(--ref)');
    s.append('text').attr('class', 'sx-evnum').attr('x', ex).attr('y', 10).attr('dy', '0.35em').attr('text-anchor', 'middle').text(e.n);
  }
}
function makeTip(el) {
  const t = document.createElement('div');
  t.className = 'sx-tip';
  t.hidden = true;
  el.append(t);
  return t;
}
function showTip(el, t, x, y, head, lines, evs) {
  t.replaceChildren();
  const h = document.createElement('div');
  h.className = 'sx-tip-h';
  h.textContent = head;
  t.append(h);
  for (const e of evs || []) {
    const d = document.createElement('div');
    d.className = 'sx-tip-ev';
    d.textContent = e.n + '. ' + e.label;
    t.append(d);
  }
  for (const l of lines) {
    const r = document.createElement('div');
    r.className = 'sx-tip-r';
    const sw = document.createElement('i');
    sw.style.background = l.color || 'transparent';
    const a = document.createElement('span');
    a.textContent = l.name;
    const b = document.createElement('b');
    b.textContent = l.value;
    r.append(sw, a, b);
    t.append(r);
  }
  t.hidden = false;
  const W = el.clientWidth;
  const tw = t.offsetWidth;
  let left = x + 16;
  if (left + tw > W) left = x - tw - 16;
  t.style.left = Math.max(0, Math.min(left, W - tw)) + 'px';
  t.style.top = Math.max(0, y) + 'px';
}

// ---------- グラフ ----------
function drawMrr(el) {
  const rs = windowRows(state.platform, state.plan);
  const H = 300, top = 26, bottom = 26;
  const { s, w } = makeSvg(el, H);
  const lo = d3.min(rs, (r) => r.mrr), hi = d3.max(rs, (r) => r.mrr);
  const pad = (hi - lo) * 0.12 || hi * 0.05;
  const y = d3.scaleLinear([lo - pad, hi + pad], [H - bottom, top]).nice(5);
  const ticks = y.ticks(5);
  const ml = textWidth(s, ticks.map(man)) + 14, mr = 8;
  const x = d3.scaleUtc(d3.extent(rs, (r) => r.d), [ml, w - mr]);
  yAxis(s, y, ticks, man, ml, w);
  const fx = DAYS[dashPeriod()] > 180 ? d3.utcFormat('%Y/%-m') : fShort;
  xLabels(s, x.ticks(Math.max(2, Math.floor((w - ml) / 90))).map((d) => ({ x: x(d), text: fx(d) })), H - 6, w);

  const evs = eventsIn(rs[0].d, rs[rs.length - 1].d);
  eventMarkers(s, evs, (e) => x(e.d), top, H - bottom);

  const grad = s.append('defs').append('linearGradient').attr('id', 'sx-mrr-grad').attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
  [[0, .26], [.25, .16], [.5, .08], [.75, .03], [1, 0]].forEach(([o, a]) => grad.append('stop').attr('offset', o).attr('style', `stop-color:var(--c1);stop-opacity:${a}`));
  s.append('path').datum(rs).attr('fill', 'url(#sx-mrr-grad)').attr('d', d3.area().x((r) => x(r.d)).y0(H - bottom).y1((r) => y(r.mrr)));
  s.append('path').datum(rs).style('fill', 'none').style('stroke', 'var(--c1)').attr('stroke-width', 2)
    .attr('stroke-linejoin', 'round').attr('stroke-linecap', 'round').attr('d', d3.line().x((r) => x(r.d)).y((r) => y(r.mrr)));
  const last = rs[rs.length - 1];
  s.append('circle').attr('cx', x(last.d)).attr('cy', y(last.mrr)).attr('r', 4).style('fill', 'var(--c1)').style('stroke', 'var(--panel)').attr('stroke-width', 2);

  const rule = s.append('line').attr('y1', top).attr('y2', H - bottom).style('stroke', 'var(--axis)').attr('opacity', 0);
  const dot = s.append('circle').attr('r', 4).style('fill', 'var(--c1)').style('stroke', 'var(--panel)').attr('stroke-width', 2).attr('opacity', 0);
  const t = makeTip(el);
  const bis = d3.bisector((r) => r.d).center;
  s.append('rect').attr('x', ml).attr('y', 0).attr('width', w - ml - mr).attr('height', H).attr('fill', 'transparent')
    .on('pointermove', (ev) => {
      const [mx] = d3.pointer(ev);
      const r = rs[bis(rs, x.invert(mx))];
      const px = x(r.d), py = y(r.mrr), k = el.clientWidth / w;
      rule.attr('x1', px).attr('x2', px).attr('opacity', 1);
      dot.attr('cx', px).attr('cy', py).attr('opacity', 1);
      showTip(el, t, px * k, py * k - 30, fDay(r.d), [
        { name: 'MRR', value: '¥' + fmt.int(r.mrr), color: 'var(--c1)' },
        { name: '有効サブスク', value: fmt.int(r.active) + ' 件' },
        { name: '新規 / 解約', value: fmt.int(r.new_subs) + ' / ' + fmt.int(r.churned) },
      ], evs.filter((e) => +e.d === +r.d));
    })
    .on('pointerleave', () => { t.hidden = true; rule.attr('opacity', 0); dot.attr('opacity', 0); });

  const ol = $('#event-list');
  ol.replaceChildren();
  for (const e of evs) {
    const li = document.createElement('li');
    const n = document.createElement('span'); n.className = 'sx-evbadge'; n.textContent = e.n;
    const d = document.createElement('span'); d.textContent = fDay(e.d);
    const l = document.createElement('span'); l.className = 'sx-evlabel'; l.textContent = e.label;
    li.append(n, d, l);
    ol.append(li);
  }
}

function drawBand(el, opts) {
  const rs = windowRows(state.platform, state.plan);
  const bs = bucket(rs);
  const H = 260, top = opts.events ? 26 : 10, bottom = 24;
  const { s, w } = makeSvg(el, H);
  const y = d3.scaleLinear(opts.domain(bs), [H - bottom, top]).nice(5);
  const ticks = y.ticks(5);
  const fy = (v) => fmt.int(Math.abs(v));
  const ml = textWidth(s, ticks.map(fy)) + 14, mr = 4;
  const x = d3.scaleBand(bs.map((b) => +b.d), [ml, w - mr]).paddingInner(bs.length > 60 ? 0.15 : 0.25);
  const bw = Math.min(32, x.bandwidth());
  const off = (x.bandwidth() - bw) / 2;
  yAxis(s, y, ticks, fy, ml, w);
  const step = Math.max(1, Math.ceil(64 / x.step()));
  xLabels(s, bs.filter((_, i) => i % step === 0).map((b) => ({ x: x(+b.d) + x.bandwidth() / 2, text: fShort(b.d) })), H - 4, w);

  let evs = [];
  if (opts.events) {
    evs = eventsIn(rs[0].d, rs[rs.length - 1].d).map((e) => ({ ...e, b: bs.find((b) => e.d >= b.d && e.d <= b.end) })).filter((e) => e.b);
    eventMarkers(s, evs, (e) => x(+e.b.d) + x.bandwidth() / 2, top, H - bottom);
  }
  const rx = Math.min(3, bw / 2);
  const groups = opts.series.map((ser) =>
    s.append('g').selectAll('rect').data(bs).join('rect')
      .attr('x', (b) => x(+b.d) + off).attr('width', bw)
      .attr('y', (b) => Math.min(y(0), y(ser.v(b))))
      .attr('height', (b) => Math.abs(y(ser.v(b)) - y(0)))
      .attr('rx', rx).style('fill', ser.color));
  if (y.domain()[0] < 0) s.append('line').attr('x1', ml).attr('x2', w).attr('y1', y(0)).attr('y2', y(0)).style('stroke', 'var(--axis)');

  const t = makeTip(el);
  s.append('rect').attr('x', ml).attr('y', 0).attr('width', w - ml - mr).attr('height', H).attr('fill', 'transparent')
    .on('pointermove', (ev) => {
      const [mx] = d3.pointer(ev);
      const i = Math.max(0, Math.min(bs.length - 1, Math.floor((mx - ml) / x.step())));
      const b = bs[i];
      groups.forEach((g) => g.attr('opacity', (d) => (d === b ? 1 : 0.45)));
      showTip(el, t, (x(+b.d) + x.bandwidth() / 2) * (el.clientWidth / w), 20, bucketTitle(b), opts.tip(b), evs.filter((e) => e.b === b));
    })
    .on('pointerleave', () => { t.hidden = true; groups.forEach((g) => g.attr('opacity', 1)); });
}

function drawMix(el) {
  const segs = SEGS.filter((sg) => (state.platform === 'all' || state.platform === sg.pf) && (state.plan === 'all' || state.plan === sg.pl))
    .map((sg) => ({ ...sg, key: sg.pf + '|' + sg.pl }));
  const lists = segs.map((sg) => windowRows(sg.pf, sg.pl));
  const table = lists[0].map((r, i) => {
    const o = { d: r.d };
    segs.forEach((sg, j) => { o[sg.key] = lists[j][i].active; });
    return o;
  });
  const stack = d3.stack().keys(segs.map((sg) => sg.key))(table);
  const H = 260, top = 10, bottom = 24;
  const { s, w } = makeSvg(el, H);
  const y = d3.scaleLinear([0, d3.max(stack[stack.length - 1], (d) => d[1]) * 1.05], [H - bottom, top]).nice(5);
  const ticks = y.ticks(5);
  const ml = textWidth(s, ticks.map(fmt.int)) + 14, mr = 8;
  const x = d3.scaleUtc(d3.extent(table, (r) => r.d), [ml, w - mr]);
  yAxis(s, y, ticks, fmt.int, ml, w);
  const fx = DAYS[dashPeriod()] > 180 ? d3.utcFormat('%Y/%-m') : fShort;
  xLabels(s, x.ticks(Math.max(2, Math.floor((w - ml) / 80))).map((d) => ({ x: x(d), text: fx(d) })), H - 4, w);
  s.append('g').selectAll('path').data(stack).join('path')
    .style('fill', (d, i) => segs[i].color).attr('fill-opacity', 0.85)
    .style('stroke', 'var(--panel)').attr('stroke-width', 1)
    .attr('d', d3.area().x((d) => x(d.data.d)).y0((d) => y(d[0])).y1((d) => y(d[1])));

  const rule = s.append('line').attr('y1', top).attr('y2', H - bottom).style('stroke', 'var(--axis)').attr('opacity', 0);
  const t = makeTip(el);
  const bis = d3.bisector((r) => r.d).center;
  s.append('rect').attr('x', ml).attr('y', 0).attr('width', w - ml - mr).attr('height', H).attr('fill', 'transparent')
    .on('pointermove', (ev) => {
      const [mx] = d3.pointer(ev);
      const r = table[bis(table, x.invert(mx))];
      const px = x(r.d);
      rule.attr('x1', px).attr('x2', px).attr('opacity', 1);
      const lines = segs.slice().reverse().map((sg) => ({ name: sg.name, value: fmt.int(r[sg.key]), color: sg.color }));
      if (segs.length > 1) lines.push({ name: '合計', value: fmt.int(segs.reduce((a, sg) => a + r[sg.key], 0)) });
      showTip(el, t, px * (el.clientWidth / w), 16, fDay(r.d), lines);
    })
    .on('pointerleave', () => { t.hidden = true; rule.attr('opacity', 0); });
}

function drawSegTable() {
  const tb = $('#seg-table');
  tb.replaceChildren();
  const period = dashPeriod();
  const segs = SEGS.filter((sg) => (state.platform === 'all' || state.platform === sg.pf) && (state.plan === 'all' || state.plan === sg.pl));
  const rows = segs.map((sg) => ({ ...kpis(period, sg.pf, sg.pl), name: sg.name, color: sg.color }));
  if (rows.length > 1) {
    const name = state.platform === 'all' && state.plan === 'all' ? '合計'
      : state.platform === 'all' ? PL_LABEL[state.plan] + '（全OS）' : PF_LABEL[state.platform] + '（全プラン）';
    rows.push({ ...kpis(period, state.platform, state.plan), name, total: true });
  }
  const maxShare = d3.max(rows.filter((r) => !r.total), (r) => r.mrr_share) || 1;
  for (const r of rows) {
    const tr = document.createElement('tr');
    if (r.total) tr.className = 'is-total';
    const td = (text) => { const c = document.createElement('td'); c.textContent = text; tr.append(c); return c; };
    const first = document.createElement('td');
    const nm = document.createElement('span'); nm.className = 'sx-segname';
    if (r.color) { const sw = document.createElement('i'); sw.className = 'sx-sw'; sw.style.background = r.color; nm.append(sw); }
    nm.append(r.name);
    first.append(nm);
    tr.append(first);
    td(fmt.int(r.active)); td(fmt.int(r.new_subs)); td(fmt.int(r.churned)); td(fmt.pct2(r.churn_rate)); td(fmt.int(r.mrr_man));
    const share = td('');
    if (!r.total) {
      const bar = document.createElement('span'); bar.className = 'sx-bar';
      bar.style.width = Math.round((r.mrr_share / maxShare) * 48) + 'px';
      share.append(bar);
    }
    share.append(fmt.pct(r.mrr_share));
    td(fmt.pct(r.conv_rate));
    tb.append(tr);
  }
}

function renderDashboard() {
  const k = kpis(dashPeriod(), state.platform, state.plan);
  for (const el of $$('[data-kpi]')) {
    const v = k[el.dataset.kpi];
    el.classList.remove('is-good', 'is-bad');
    if (v == null || !Number.isFinite(v)) { el.textContent = '—'; continue; }
    el.textContent = fmt[el.dataset.fmt || 'int'](v);
    const good = el.dataset.good;
    if (good && Math.abs(v) > 1e-9) el.classList.add((v > 0) === (good === 'up') ? 'is-good' : 'is-bad');
  }
  $('#lede-mrr').textContent = man(k.mrr);
  $('#lede-mrr-chg').textContent = fmt.chg(k.mrr_chg);
  $('#lede-new').textContent = fmt.int(k.new_subs);
  $('#lede-churn').textContent = fmt.int(k.churned);
  $('#lede-net').textContent = fmt.signed(k.net_adds);
  $$('[data-grain]').forEach((el) => { el.textContent = weekly() ? '週次' : '日次'; });
  $$('#mix-legend li[data-seg]').forEach((li) => {
    const [pf, pl] = li.dataset.seg.split('|');
    li.hidden = !((state.platform === 'all' || state.platform === pf) && (state.plan === 'all' || state.plan === pl));
  });

  drawMrr($('#mrr-chart'));
  drawBand($('#flow-chart'), {
    events: true,
    domain: (bs) => [-d3.max(bs, (b) => b.churned) * 1.1, d3.max(bs, (b) => b.new_subs) * 1.05],
    series: [{ v: (b) => b.new_subs, color: 'var(--c1)' }, { v: (b) => -b.churned, color: 'var(--critical)' }],
    tip: (b) => [
      { name: '新規', value: fmt.int(b.new_subs), color: 'var(--c1)' },
      { name: '解約', value: fmt.int(b.churned), color: 'var(--critical)' },
      { name: '純増', value: fmt.signed(b.new_subs - b.churned) },
    ],
  });
  drawBand($('#trial-chart'), {
    events: false,
    domain: (bs) => [0, d3.max(bs, (b) => b.trial_starts) * 1.05],
    series: [{ v: (b) => b.trial_starts, color: 'var(--bar-muted)' }, { v: (b) => b.trial_conversions, color: 'var(--c2)' }],
    tip: (b) => [
      { name: 'トライアル開始', value: fmt.int(b.trial_starts), color: 'var(--bar-muted)' },
      { name: '有料転換', value: fmt.int(b.trial_conversions), color: 'var(--c2)' },
      { name: '転換率', value: fmt.pct(b.trial_conversions / b.trial_starts) },
    ],
  });
  drawMix($('#mix-chart'));
  drawSegTable();
}

// ---------- 生データ ----------
const RAW_COLS = {
  daily: [
    { key: 'date', label: '日付', text: true },
    { key: 'platform', label: 'OS', text: true, show: (v) => PF_LABEL[v] },
    { key: 'plan', label: 'プラン', text: true, show: (v) => PL_LABEL[v] },
    { key: 'new_subs', label: '新規' },
    { key: 'churned', label: '解約' },
    { key: 'trial_starts', label: 'トライアル開始' },
    { key: 'trial_conversions', label: '有料転換' },
    { key: 'active', label: '有効サブスク' },
    { key: 'mrr', label: 'MRR（円）' },
  ],
  events: [
    { key: 'date', label: '日付', text: true },
    { key: 'label', label: 'イベント', text: true },
    { key: 'platform', label: '対象OS', text: true, show: (v) => PF_LABEL[v] },
    { key: 'kind', label: '種類', text: true },
  ],
};

function rawRows() {
  const { mode, q } = state.raw;
  const lastDate = state.data.meta.to;
  const from = DAYS[state.period] ? d3.utcFormat('%Y-%m-%d')(d3.utcDay.offset(parseDay(lastDate), -(DAYS[state.period] - 1))) : '';
  let rows = mode === 'daily' ? state.data.rows : state.data.events;
  rows = rows.filter((r) =>
    (!from || r.date >= from) &&
    (mode === 'events' ? eventMatches(r) : (state.platform === 'all' || r.platform === state.platform) && (state.plan === 'all' || r.plan === state.plan)) &&
    (!q || r.date.includes(q) || (r.label && r.label.includes(q))));
  const { sortKey, sortDir } = state.raw;
  return rows.slice().sort((a, b) => {
    const x = a[sortKey], y = b[sortKey];
    return (x < y ? -1 : x > y ? 1 : 0) * sortDir;
  });
}

function renderRaw() {
  const cols = RAW_COLS[state.raw.mode];
  if (!cols.some((c) => c.key === state.raw.sortKey)) { state.raw.sortKey = 'date'; state.raw.sortDir = 1; }
  $$('#raw-mode button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === state.raw.mode)));
  $('#raw-search').placeholder = state.raw.mode === 'daily' ? '例 2026-08' : '例 障害';

  const head = document.createElement('tr');
  for (const c of cols) {
    const th = document.createElement('th');
    if (c.text) th.className = 'is-text';
    if (c.key === state.raw.sortKey) th.setAttribute('aria-sort', state.raw.sortDir > 0 ? 'ascending' : 'descending');
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = c.label + (c.key === state.raw.sortKey ? (state.raw.sortDir > 0 ? ' ↑' : ' ↓') : '');
    b.addEventListener('click', () => {
      if (state.raw.sortKey === c.key) state.raw.sortDir *= -1;
      else { state.raw.sortKey = c.key; state.raw.sortDir = c.text ? 1 : -1; }
      state.raw.page = 0;
      renderRaw();
    });
    th.append(b);
    head.append(th);
  }
  $('#raw-thead').replaceChildren(head);

  const rows = rawRows();
  const size = state.raw.size;
  const pages = Math.max(1, Math.ceil(rows.length / size));
  state.raw.page = Math.min(state.raw.page, pages - 1);
  const slice = rows.slice(state.raw.page * size, (state.raw.page + 1) * size);
  const frag = document.createDocumentFragment();
  for (const r of slice) {
    const tr = document.createElement('tr');
    for (const c of cols) {
      const td = document.createElement('td');
      if (c.text) td.className = 'is-text';
      const v = r[c.key];
      td.textContent = c.show ? c.show(v) : typeof v === 'number' ? fmt.int(v) : v;
      tr.append(td);
    }
    frag.append(tr);
  }
  $('#raw-tbody').replaceChildren(frag);

  const filters = [LABEL[state.period]];
  if (state.platform !== 'all') filters.push(PF_LABEL[state.platform]);
  if (state.plan !== 'all' && state.raw.mode === 'daily') filters.push(PL_LABEL[state.plan]);
  const total = state.raw.mode === 'daily' ? state.data.rows.length : state.data.events.length;
  $('#raw-count').textContent = `${fmt.int(rows.length)} 行（全 ${fmt.int(total)} 行中）・ ${filters.join(' / ')}${state.raw.q ? ` ・ 「${state.raw.q}」を含む` : ''}`;
  $('#raw-page').textContent = `${state.raw.page + 1} / ${pages} ページ`;
  $('#raw-prev').disabled = state.raw.page === 0;
  $('#raw-next').disabled = state.raw.page >= pages - 1;
}

function downloadCsv() {
  const cols = RAW_COLS[state.raw.mode];
  const cell = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));
  const lines = [cols.map((c) => c.key).join(','), ...rawRows().map((r) => cols.map((c) => cell(r[c.key])).join(','))];
  const blob = new Blob(['﻿' + lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.raw.mode === 'daily' ? 'subscriptions' : 'events'}_seed${state.data.meta.seed}_${state.period}_${state.platform}_${state.plan}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- 全体 ----------
function render() {
  if (!state.data) return;
  if (state.view === 'dashboard' && !DAYS[state.period]) state.period = '365d';
  $$('.sx-seg[data-param]').forEach((g) => {
    g.querySelectorAll('button[data-value]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === state[g.dataset.param])));
  });
  $$('[data-raw-only]').forEach((b) => { b.hidden = state.view !== 'raw'; });
  $$('.sx-tabs a').forEach((a) => (a.dataset.view === state.view ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  $('#view-dashboard').hidden = state.view !== 'dashboard';
  $('#view-raw').hidden = state.view !== 'raw';

  $$('[data-period-label]').forEach((el) => { el.textContent = LABEL[state.view === 'raw' ? state.period : dashPeriod()]; });
  const rs = windowRows('all', 'all');
  const rawFrom = state.view === 'raw' && !DAYS[state.period] ? parseDay(state.data.meta.from) : rs[0].d;
  $('#range').textContent = fDay(rawFrom) + ' 〜 ' + fDay(rs[rs.length - 1].d);

  if (state.view === 'dashboard') renderDashboard();
  else renderRaw();
}

function setParam(name, value) {
  state[name] = value;
  state.raw.page = 0;
  render();
}

function routeFromHash() {
  state.view = location.hash === '#raw' ? 'raw' : 'dashboard';
  render();
}

async function init() {
  $$('.sx-seg[data-param]').forEach((g) => g.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (b) setParam(g.dataset.param, b.dataset.value);
  }));
  $('#reset').addEventListener('click', () => { Object.assign(state, DEFAULTS); state.raw.page = 0; render(); });
  $('#raw-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-value]');
    if (!b) return;
    state.raw.mode = b.dataset.value;
    state.raw.page = 0;
    renderRaw();
  });
  $('#raw-search').addEventListener('input', (e) => { state.raw.q = e.target.value.trim(); state.raw.page = 0; renderRaw(); });
  $('#raw-size').addEventListener('change', (e) => { state.raw.size = Number(e.target.value); state.raw.page = 0; renderRaw(); });
  $('#raw-prev').addEventListener('click', () => { state.raw.page -= 1; renderRaw(); });
  $('#raw-next').addEventListener('click', () => { state.raw.page += 1; renderRaw(); });
  $('#raw-download').addEventListener('click', downloadCsv);
  window.addEventListener('hashchange', routeFromHash);
  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(() => state.view === 'dashboard' && renderDashboard(), 150); });

  try {
    const res = await fetch('/api/data', { cache: 'no-store' });
    if (!res.ok) throw new Error(res.statusText);
    state.data = await res.json();
  } catch (err) {
    $('#error').hidden = false;
    return;
  }
  state.series = buildSeries(state.data.rows);
  const m = state.data.meta;
  $('#seed').textContent = m.seed;
  $('#asof').textContent = fDay(parseDay(m.to));
  $('#generated').textContent = new Date(m.generatedAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' });
  routeFromHash();
}

init();
