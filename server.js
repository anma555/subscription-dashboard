'use strict';
// サブスク契約ダッシュボードのローカルサーバ。
// 起動のたびにダミーデータを新しく生成する（SEED を指定すると同じデータを再現）。
const http = require('http');
const fs = require('fs');
const path = require('path');
const { generate } = require('./src/generate');

const PORT = Number(process.env.PORT) || 3000;
const seedEnv = process.env.SEED;
const data = generate(seedEnv !== undefined && seedEnv !== '' ? { seed: Number.parseInt(seedEnv, 10) } : {});
const PUBLIC = path.join(__dirname, 'public');

const COLUMNS = ['date', 'platform', 'plan', 'new_subs', 'churned', 'trial_starts', 'trial_conversions', 'active', 'mrr'];
const csvCell = (v) => (/[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v));

function filterRows(q) {
  return data.rows.filter((r) =>
    (!q.get('platform') || q.get('platform') === 'all' || r.platform === q.get('platform')) &&
    (!q.get('plan') || q.get('plan') === 'all' || r.plan === q.get('plan')) &&
    (!q.get('from') || r.date >= q.get('from')) &&
    (!q.get('to') || r.date <= q.get('to')));
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, type, body, extra = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };

  if (url.pathname === '/api/data') {
    return send(200, 'application/json; charset=utf-8', JSON.stringify(data));
  }
  if (url.pathname === '/api/meta') {
    return send(200, 'application/json; charset=utf-8', JSON.stringify({ ...data.meta, events: data.events.length }));
  }
  if (url.pathname === '/api/raw.csv') {
    const rows = filterRows(url.searchParams);
    const csv = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n';
    return send(200, 'text/csv; charset=utf-8', '﻿' + csv, {
      'Content-Disposition': `attachment; filename="subscriptions_${data.meta.seed}.csv"`,
    });
  }
  if (url.pathname === '/api/events.csv') {
    const cols = ['date', 'label', 'platform', 'kind'];
    const csv = [cols.join(','), ...data.events.map((e) => cols.map((c) => csvCell(e[c])).join(','))].join('\n') + '\n';
    return send(200, 'text/csv; charset=utf-8', '﻿' + csv, {
      'Content-Disposition': `attachment; filename="events_${data.meta.seed}.csv"`,
    });
  }

  // 静的ファイル
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return send(403, 'text/plain', 'Forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) return send(404, 'text/plain; charset=utf-8', 'Not found');
    send(200, TYPES[path.extname(file)] || 'application/octet-stream', buf);
  });
});

server.listen(PORT, () => {
  console.log(`サブスク契約ダッシュボード: http://localhost:${PORT}`);
  console.log(`ダミーデータ: seed=${data.meta.seed}  ${data.meta.from}〜${data.meta.to}  ${data.meta.rows}行 / イベント${data.events.length}件`);
  console.log(`同じデータを再現するには: SEED=${data.meta.seed} npm start`);
});
