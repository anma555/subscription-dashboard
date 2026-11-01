'use strict';
// ダミーのサブスク実績データを生成する。
// 呼び出すたびに乱数シードが変わり、ベース水準・成長率・季節性・イベントの日付と強さ・
// 予告なしのスパイクがすべて変わる。seed を渡すと同じデータを再現できる。

const DAY = 86400000;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRandom(seed) {
  const rnd = mulberry32(seed);
  const uniform = (a, b) => a + (b - a) * rnd();
  const int = (a, b) => Math.floor(uniform(a, b + 1));
  const normal = () => {
    let u = 0;
    while (u === 0) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const lognormal = (sigma) => Math.exp(sigma * normal());
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  return { rnd, uniform, int, normal, lognormal, pick, chance };
}

const iso = (t) => new Date(t).toISOString().slice(0, 10);
const utc = (y, m, d) => Date.UTC(y, m, d);

// 11月の最終金曜（ブラックフライデー）
function blackFriday(year) {
  let t = utc(year, 10, 30);
  while (new Date(t).getUTCDay() !== 5) t -= DAY;
  return t;
}

function generate(options = {}) {
  const seed = Number.isInteger(options.seed) ? options.seed >>> 0 : Math.floor(Math.random() * 2 ** 32);
  const R = makeRandom(seed);
  const days = options.days || 731;
  const now = new Date();
  const end = utc(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - DAY; // 前日まで
  const start = end - (days - 1) * DAY;
  const inRange = (t) => t >= start && t <= end;
  const randomDay = (fromFrac, toFrac) => start + Math.floor(R.uniform(fromFrac, toFrac) * (days - 1)) * DAY;

  // セグメントごとのベース値（毎回 ±15〜20% ほど揺らす）
  const segs = [
    { platform: 'ios', plan: 'monthly', active: 38000, trial: 125, conv: 0.40, churn: 0.0018, direct: 0.06 },
    { platform: 'ios', plan: 'yearly', active: 21000, trial: 52, conv: 0.50, churn: 0.0007, direct: 0.10 },
    { platform: 'android', plan: 'monthly', active: 29000, trial: 105, conv: 0.34, churn: 0.0020, direct: 0.05 },
    { platform: 'android', plan: 'yearly', active: 11500, trial: 32, conv: 0.44, churn: 0.0008, direct: 0.08 },
  ].map((s) => ({
    ...s,
    active: Math.round(s.active * R.uniform(0.8, 1.2)),
    trial: s.trial * R.uniform(0.85, 1.15),
    conv: s.conv + R.uniform(-0.04, 0.04),
    churn: s.churn * R.uniform(0.85, 1.2),
    direct: s.direct * R.uniform(0.7, 1.3),
  }));

  const growth = R.uniform(0.15, 0.7); // 期間全体でのトライアル流入の伸び
  const seasonAmp = R.uniform(0.03, 0.09);
  const seasonPhase = R.uniform(0, 2 * Math.PI);
  const noise = R.uniform(0.07, 0.12);
  const basePrice = { monthly: 980, yearly: 9800 };

  // ---- イベント（画面に表示されるもの）と、その効果 ----
  const events = [];
  const effects = [];
  const addEvent = (t, label, platform, kind, effect) => {
    if (!inRange(t)) return;
    events.push({ date: iso(t), label, platform, kind });
    for (const e of [].concat(effect)) effects.push({ t, platform, ...e });
  };
  const platLabel = { ios: 'iOS', android: 'Android' };
  const firstYear = new Date(start).getUTCFullYear();
  const lastYear = new Date(end).getUTCFullYear();

  for (let y = firstYear; y <= lastYear; y++) {
    const off = R.int(30, 50);
    addEvent(blackFriday(y), `ブラックフライデー（年額${off}%OFF）`, 'all', 'campaign', [
      { type: 'trial', plan: 'yearly', peak: R.uniform(1.8, 3.4), decay: R.uniform(2, 3.5) },
      { type: 'trial', plan: 'monthly', peak: R.uniform(0.3, 0.7), decay: 2.5 },
    ]);
    if (R.chance(0.8)) {
      addEvent(utc(y, 0, 1), '新年キャンペーン', 'all', 'campaign', [
        { type: 'trial', plan: 'yearly', peak: R.uniform(0.6, 1.3), decay: 4 },
        { type: 'trial', plan: 'monthly', peak: R.uniform(0.4, 0.9), decay: 4 },
      ]);
    }
    if (R.chance(0.7)) {
      addEvent(utc(y, 6, R.int(10, 25)), '夏のセール', 'all', 'campaign', [
        { type: 'trial', plan: 'yearly', peak: R.uniform(0.8, 1.7), decay: 3 },
        { type: 'trial', plan: 'monthly', peak: R.uniform(0.2, 0.5), decay: 3 },
      ]);
    }
    addEvent(utc(y, 8, R.int(12, 20)), `iOS ${y - 1999} 対応リリース`, 'ios', 'release', { type: 'trial', peak: R.uniform(0.4, 1.4), decay: 5 });
  }

  for (let i = 0, n = R.int(1, 3); i < n; i++) {
    const p = R.pick(['ios', 'android']);
    addEvent(randomDay(0.05, 0.98), p === 'ios' ? 'App Store「Today」掲載' : 'Google Play おすすめ掲載', p, 'featured', { type: 'trial', peak: R.uniform(1.2, 2.6), decay: R.uniform(2.5, 4) });
  }
  for (let i = 0, n = R.int(0, 2); i < n; i++) {
    const p = R.pick(['ios', 'android', 'all']);
    addEvent(randomDay(0.1, 0.98), p === 'all' ? 'インフルエンサー施策' : `インフルエンサー施策（${platLabel[p]}）`, p, 'campaign', { type: 'trial', peak: R.uniform(1.4, 2.8), decay: R.uniform(1.5, 3) });
  }
  if (R.chance(0.7)) {
    addEvent(randomDay(0.05, 0.6), 'Android版リニューアル', 'android', 'release', { type: 'trial', peak: R.uniform(0.5, 1.1), decay: 6 });
  }
  for (let i = 0, n = R.int(0, 2); i < n; i++) {
    const p = R.pick(['ios', 'android']);
    const base = R.uniform(3, 6);
    addEvent(randomDay(0.1, 0.97), p === 'ios' ? 'App Store 課金障害' : 'Google Play 決済障害', p, 'incident', {
      type: 'churn', mults: [base, base * 0.75, base * 0.45, 1 + (base - 1) * 0.15],
    });
  }
  if (R.chance(0.85)) {
    addEvent(randomDay(0.3, 0.75), 'オンボーディング改善', 'all', 'product', { type: 'conv', delta: R.uniform(0.02, 0.06) });
  }
  if (R.chance(0.5)) {
    const t = randomDay(0.55, 0.92);
    const newPrice = R.pick([1080, 1100, 1200]);
    addEvent(t, `月額 ¥980→¥${newPrice.toLocaleString('en')} 改定`, 'all', 'pricing', [
      { type: 'price', plan: 'monthly', price: newPrice },
      { type: 'churnWave', plan: 'monthly', peak: R.uniform(0.5, 1.1), decay: R.uniform(6, 12) },
      { type: 'trialLevel', plan: 'monthly', factor: R.uniform(0.9, 0.97) },
    ]);
  }
  // 年額の更新期：最初のブラックフライデーの1年後に解約の波
  const firstBF = events.find((e) => e.label.startsWith('ブラックフライデー'));
  if (firstBF) {
    const t = Date.parse(firstBF.date) + 365 * DAY;
    if (inRange(t)) effects.push({ t, platform: 'all', type: 'churnWave', plan: 'yearly', peak: R.uniform(1.2, 2.4), decay: 3 });
  }
  events.sort((a, b) => (a.date < b.date ? -1 : 1));

  const applies = (e, s) => (e.platform === 'all' || e.platform === s.platform) && (!e.plan || e.plan === s.plan);

  // ---- 日次の行 ----
  const rows = [];
  for (const s of segs) {
    let active = s.active;
    const trials = [];
    for (let i = 0; i < days; i++) {
      const t = start + i * DAY;
      const frac = i / days;
      const dow = new Date(t).getUTCDay();
      const week = dow === 0 || dow === 6 ? 1.16 : dow === 2 || dow === 3 ? 0.95 : 1;
      let trialMult = 1, churnMult = 1, convDelta = 0, price = basePrice[s.plan] / (s.plan === 'yearly' ? 12 : 1);
      for (const e of effects) {
        if (!applies(e, s)) continue;
        const k = Math.round((t - e.t) / DAY);
        if (e.type === 'trial' && k >= 0 && k < 30) trialMult *= 1 + e.peak * Math.exp(-k / e.decay);
        if (e.type === 'churn' && k >= 0 && k < e.mults.length) churnMult *= e.mults[k];
        if (e.type === 'churnWave' && k >= 0 && k < 40) churnMult *= 1 + e.peak * Math.exp(-k / e.decay);
        if (e.type === 'conv' && k >= 0) convDelta += e.delta;
        if (e.type === 'price' && k >= 0) price = e.price;
        if (e.type === 'trialLevel' && k >= 0) trialMult *= e.factor;
      }
      // 予告なしの小さなスパイク（SNSでの言及など）
      if (R.chance(0.012)) trialMult *= R.uniform(1.3, 2.0);
      if (R.chance(0.006)) churnMult *= R.uniform(1.4, 2.2);

      const trend = (1 + growth * frac) * (1 + seasonAmp * Math.sin(2 * Math.PI * (i / 365) + seasonPhase));
      const trialStarts = Math.max(0, Math.round(s.trial * trend * week * trialMult * R.lognormal(noise)));
      trials.push(trialStarts);
      const src = i >= 7 ? trials[i - 7] : Math.round(s.trial * week);
      const conv = Math.min(0.9, s.conv + convDelta);
      const trialConversions = Math.round(src * conv * R.lognormal(0.07));
      const direct = Math.round(trialConversions * s.direct * R.lognormal(0.3));
      const newSubs = trialConversions + direct;
      const churned = Math.round(active * s.churn * churnMult * R.lognormal(0.12) * (1 - 0.15 * frac));
      active = active + newSubs - churned;
      rows.push({
        date: iso(t), platform: s.platform, plan: s.plan,
        new_subs: newSubs, churned, trial_starts: trialStarts, trial_conversions: trialConversions,
        active, mrr: Math.round(active * price),
      });
    }
  }
  const order = { 'ios|monthly': 0, 'ios|yearly': 1, 'android|monthly': 2, 'android|yearly': 3 };
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : order[a.platform + '|' + a.plan] - order[b.platform + '|' + b.plan]));

  return {
    meta: { seed, generatedAt: new Date().toISOString(), from: iso(start), to: iso(end), rows: rows.length },
    rows,
    events,
  };
}

module.exports = { generate };
