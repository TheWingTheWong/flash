import { Market } from './market.js';
import { BUY, SELL } from './book.js';
import { stylizedFacts } from './stats.js';

const $ = (id) => document.getElementById(id);
const cv = $('chart'), ctx = cv.getContext('2d');
const qs = new URLSearchParams(location.search);
const seed = Number(qs.get('seed')) || 2020;
const m = new Market({ seed });
const b = m.book;
const P0 = b.mid();

// ------------------------------------------------------------ history ----
const COLSTEP = 4, MAXCOLS = 600, BUCKETS = 180;
const cols = [];
function sampleColumn() {
  const mid = b.mid(), span = Math.max(40, Math.round(mid * 0.06)), bucket = Math.max(1, Math.ceil((2 * span) / BUCKETS));
  const base = Math.max(1, Math.round(mid) - span);
  const bid = new Float32Array(BUCKETS), ask = new Float32Array(BUCKETS);
  for (let i = 0; i < BUCKETS; i++) {
    let sb = 0, sa = 0;
    for (let p = base + i * bucket, e = p + bucket; p < e && p <= b.maxTick; p++) { sb += b.depth[BUY][p]; sa += b.depth[SELL][p]; }
    bid[i] = sb; ask[i] = sa;
  }
  cols.push({ t: m.t, mid, base, bucket, bid, ask, makersOut: m.makersOut });
  if (cols.length > MAXCOLS) cols.shift();
}

// -------------------------------------------------------------- desk ----
const me = { cost: 0, qty: 0, marks: [] };
b.onTrade = (tr) => {
  if (tr.buyer !== 0 && tr.seller !== 0) return;
  const d = tr.buyer === 0 ? tr.qty : -tr.qty;
  if (me.qty === 0 || Math.sign(me.qty) === Math.sign(d)) me.cost += tr.price * Math.abs(d);
  else { const close = Math.min(Math.abs(d), Math.abs(me.qty)); me.cost -= (me.cost / Math.abs(me.qty)) * close; if (Math.abs(d) > Math.abs(me.qty)) me.cost = tr.price * (Math.abs(d) - Math.abs(me.qty)); }
  me.qty += d;
  if (me.qty === 0) me.cost = 0;
};
let orderSize = 1000;
const recent = { dump: null, news: null, pulled: null };
function trade(side, q) {
  const before = b.mid(), cash0 = b.cash[0];
  const filled = b.market(side, q, 0);
  if (filled > 0) me.lastFill = { t: m.t, side, q: filled, avg: Math.abs(b.cash[0] - cash0) / filled };
  if (filled > 0) {
    me.marks.push({ t: m.t, price: b.lastPrice, side, q: filled });
    if (filled >= 5000) recent.dump = { t: m.t, side, q: filled };
  }
  headlineMaybeImmediate(side, q, filled, before);
  updatePanels(); // instant feedback
  return filled;
}
function headlineMaybeImmediate(side, q, filled, before) {
  const move = b.mid() / before - 1, verb = side === BUY ? 'buy' : 'sell';
  if (filled < q) { // the book ran dry before the order was done: say so instead of failing silently
    addHeadline(`Your ${q.toLocaleString('en')}-share ${verb} order empties the ${side === BUY ? 'offers' : 'bids'}`,
      `only ${filled.toLocaleString('en')} shares found a ${side === BUY ? 'seller' : 'buyer'}; the rest was cancelled · FLSH ${pct(move)} in one go`);
  } else if (Math.abs(move) > 0.003) {
    addHeadline(`Your ${q.toLocaleString('en')}-share ${verb} order moves FLSH ${pct(move)} in one go`, `you swept ${Math.round(Math.abs(move) * 1e4)} basis points of resting orders`);
  }
}

// ---------------------------------------------------------- headlines ----
const heads = [];
let seenEvents = 0;
const clock = (t) => { const s = 9 * 3600 + 30 * 60 + t; const h = Math.floor(s / 3600) % 24, mi = Math.floor(s / 60) % 60, se = s % 60; return `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}:${String(se).padStart(2, '0')}`; };
const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
const dur = (s) => (s < 90 ? `${s} seconds` : `${Math.round(s / 60)} minutes`);
function addHeadline(title, sub) {
  heads.unshift({ title, sub, t: m.t });
  if (heads.length > 8) heads.pop();
  $('heads').innerHTML = heads.map((h) => `<li><b>${h.title}</b><span>${clock(h.t)} · ${h.sub}</span></li>`).join('');
}
function checkEvents() {
  while (seenEvents < m.events.length) {
    const e = m.events[seenEvents++];
    const down = e.kind === 'crash';
    let why;
    if (!m.mmEnabled || (cols.length && cols[cols.length - 1].makersOut)) why = 'as market makers pull their quotes and the book thins out';
    else if (recent.dump && e.t - recent.dump.t < 400 && (recent.dump.side === SELL) === down) why = `after a ${recent.dump.q.toLocaleString('en')}-share ${down ? 'sell' : 'buy'} order hits the book`;
    else if (recent.news && e.t - recent.news.t < 600 && recent.news.good !== down) why = down ? 'as traders digest the bad news' : 'as traders chase the good news';
    else why = down ? 'as trend-followers pile on and bids evaporate' : 'as trend-followers chase the move and offers vanish';
    addHeadline(`${down ? 'FLASH CRASH: FLSH plunges' : 'SQUEEZE: FLSH rips'} ${pct(e.move)} in ${dur(e.steps)}`, why);
  }
}

// -------------------------------------------------------------- facts ----
const FACTS = [
  { key: 'acf1', title: 'Returns are unpredictable', real: 'Real markets: ≈ 0, so the last minute says nothing about the next. Flash’s weakest fact: calm trading passes, but a crash and its rebound can push the raw number past ±0.1.', fmt: (f) => `${f.acf1.toFixed(3)} <small>calm ${f.acf1Calm.toFixed(2)}</small>`, ok: (f) => Math.abs(f.acf1) < 0.1, what: 'autocorrelation of 1-minute returns (calm = with crash minutes clipped)' },
  { key: 'acfAbs', title: 'Volatility clusters', real: 'Real markets: clearly positive, decaying slowly. Wild minutes follow wild minutes.', fmt: (f) => f.acfAbs[0].toFixed(2), ok: (f) => f.acfAbs[0] > 0.1, what: 'autocorrelation of |returns|' },
  { key: 'kurt', title: 'Fat tails that fade with time', real: 'Real markets: far above 0 (a bell curve) at short horizons, shrinking at longer ones.', fmt: (f) => `${f.kurtosis.toFixed(1)} → ${f.kurtosisAgg.toFixed(1)}`, ok: (f) => f.kurtosis > 1 && f.kurtosisAgg < f.kurtosis, what: 'excess kurtosis, 1 min → 10 min' },
  { key: 'tail', title: 'Extreme moves follow a power law', real: 'Real markets: α ≈ 3, the “inverse cubic law”. A bell curve would give α → ∞.', fmt: (f) => `α = ${f.tail.toFixed(2)}`, ok: (f) => f.tail >= 1.5 && f.tail <= 5, what: 'Hill tail exponent' },
];
let facts = null;
function updateFacts() {
  const r = m.returns(60);
  if (r.length < 60) {
    $('factsN').textContent = `collecting… ${r.length}/60 minutes`;
    $('facts').innerHTML = FACTS.map((F) => `<div class="fact"><h3>${F.title}<span class="mark wait">pending</span></h3><div class="val">—</div><p>${F.real}</p></div>`).join('');
    facts = null;
    return;
  }
  facts = stylizedFacts(r);
  $('factsN').textContent = `${r.length.toLocaleString('en')} one-minute returns`;
  $('facts').innerHTML = FACTS.map((F) => {
    const ok = F.ok(facts);
    return `<div class="fact" data-fact="${F.key}" data-ok="${ok}"><h3>${F.title}<span class="mark ${ok ? 'yes' : 'no'}">${ok ? '✓ matches' : '✗ not yet'}</span></h3><div class="val num">${F.fmt(facts)}</div><p>${F.what}. ${F.real}</p></div>`;
  }).join('');
}

// -------------------------------------------------------------- chart ----
const heat = document.createElement('canvas'); heat.width = MAXCOLS; heat.height = 240;
const hctx = heat.getContext('2d'), himg = hctx.createImageData(MAXCOLS, 240);
const PAPER = [244, 228, 214], BID = [31, 79, 143], ASK = [176, 53, 43];
let view = { lo: P0 * 0.97, hi: P0 * 1.03 };
const labelled = []; // event labels drawn in the last frame (for tests)

function drawChart() {
  const dpr = Math.min(2, devicePixelRatio || 1), r = cv.getBoundingClientRect();
  if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
  const W = cv.width, H = cv.height, padR = 64 * dpr, padB = 22 * dpr, plotW = W - padR, plotH = H - padB;
  // follow the price: target window = visible range, at least ±1.5%
  let lo = Infinity, hi = -Infinity;
  for (const c of cols) { lo = Math.min(lo, c.mid); hi = Math.max(hi, c.mid); }
  const now = b.mid(); lo = Math.min(lo, now); hi = Math.max(hi, now);
  const mid = (lo + hi) / 2, half = Math.max(mid * 0.015, (hi - lo) / 2 * 1.35);
  const tLo = mid - half, tHi = mid + half, pad = (tHi - tLo) * 0.04;
  // ease toward the target, but never let the price line leave the plot (e.g. after a fast-forward)
  if (lo < view.lo + pad || hi > view.hi - pad || view.hi - view.lo > 3 * (tHi - tLo)) { view.lo = tLo; view.hi = tHi; }
  else { view.lo += 0.15 * (tLo - view.lo); view.hi += 0.15 * (tHi - view.hi); }
  const HH = heat.height, yOf = (p) => plotH * (1 - (p - view.lo) / (view.hi - view.lo));

  // heatmap: one pixel column per history column, rows mapped to price
  const data = himg.data, n = cols.length, x0 = MAXCOLS - n;
  const scale = 2600;
  for (let x = 0; x < MAXCOLS; x++) {
    const c = x >= x0 ? cols[x - x0] : null;
    for (let y = 0; y < HH; y++) {
      const o = (y * MAXCOLS + x) * 4;
      let col = PAPER, v = 0;
      if (c) {
        const price = view.hi - ((y + 0.5) / HH) * (view.hi - view.lo);
        const i = Math.floor((price - c.base) / c.bucket);
        if (i >= 0 && i < BUCKETS) {
          const bd = c.bid[i], ad = c.ask[i];
          if (bd > ad) { v = Math.min(1, Math.sqrt(bd / scale)); col = BID; } else if (ad > 0) { v = Math.min(1, Math.sqrt(ad / scale)); col = ASK; }
        }
      }
      const a = v * 0.85;
      data[o] = PAPER[0] + (col[0] - PAPER[0]) * a; data[o + 1] = PAPER[1] + (col[1] - PAPER[1]) * a; data[o + 2] = PAPER[2] + (col[2] - PAPER[2]) * a; data[o + 3] = 255;
    }
  }
  hctx.putImageData(himg, 0, 0);
  ctx.fillStyle = '#f4e4d6'; ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(heat, 0, 0, MAXCOLS, HH, 0, 0, plotW, plotH);

  // grid + price axis
  ctx.font = `${11 * dpr}px "Plex Mono", monospace`; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const stepP = niceStep((view.hi - view.lo) / 6);
  for (let p = Math.ceil(view.lo / stepP) * stepP; p < view.hi; p += stepP) {
    const y = yOf(p);
    ctx.strokeStyle = '#2a201b22'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillStyle = '#5d4f45'; ctx.fillText((p / 100).toFixed(2), plotW + 8 * dpr, y);
  }
  // time axis
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'; ctx.fillStyle = '#8d7a6c';
  const colW = plotW / MAXCOLS;
  for (let i = 0; i < n; i++) if (cols[i].t % 600 < COLSTEP) { const x = (x0 + i + 0.5) * colW; ctx.fillRect(x, plotH, 1, 4 * dpr); ctx.fillText(clock(cols[i].t).slice(0, 5), x, plotH + 6 * dpr); }
  // makers-out shading strip
  for (let i = 0; i < n; i++) if (cols[i].makersOut) { ctx.fillStyle = '#b0352b55'; ctx.fillRect((x0 + i) * colW, plotH - 4 * dpr, Math.ceil(colW), 4 * dpr); }
  // events
  const t0 = n ? cols[0].t : Infinity, colAt = (t) => (t < t0 ? -1 : cols.findIndex((c) => c.t >= t));
  labelled.length = 0;
  let lastX = -Infinity, row = 0;
  for (const e of m.events) {
    const idx = colAt(e.t);
    if (idx < 0) continue; // scrolled out of the window
    const x = (x0 + idx + 0.5) * colW;
    row = x - lastX < 130 * dpr ? row + 1 : 0; lastX = x;
    ctx.strokeStyle = '#211a16'; ctx.setLineDash([3 * dpr, 4 * dpr]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, plotH); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#211a16'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.font = `italic ${15 * dpr}px "Instrument Serif", serif`;
    const label = `${e.kind === 'crash' ? 'crash' : 'squeeze'} ${pct(e.move)}`, tw = ctx.measureText(label).width;
    const lx = x + 5 * dpr + tw > plotW ? x - 5 * dpr - tw : x + 5 * dpr; // keep labels inside the plot
    ctx.fillText(label, lx, (6 + row * 18) * dpr);
    labelled.push({ t: e.t, x: lx, row });
    ctx.font = `${11 * dpr}px "Plex Mono", monospace`;
  }
  // price line
  ctx.strokeStyle = '#211a16'; ctx.lineWidth = 2 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  cols.forEach((c, i) => { const x = (x0 + i + 0.5) * colW, y = yOf(c.mid); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
  // your trades
  for (const mk of me.marks) {
    const idx = colAt(mk.t); if (idx < 0) continue;
    const x = (x0 + idx + 0.5) * colW, y = yOf(mk.price), s = (5 + Math.min(6, Math.log10(mk.q))) * dpr;
    ctx.fillStyle = mk.side === BUY ? '#1d6b45' : '#b0352b'; ctx.beginPath();
    if (mk.side === BUY) { ctx.moveTo(x, y - s); ctx.lineTo(x - s, y + s * 0.6); ctx.lineTo(x + s, y + s * 0.6); } else { ctx.moveTo(x, y + s); ctx.lineTo(x - s, y - s * 0.6); ctx.lineTo(x + s, y - s * 0.6); }
    ctx.fill();
  }
  // last price tag
  const yl = yOf(b.mid());
  ctx.fillStyle = '#211a16'; ctx.fillRect(plotW, yl - 9 * dpr, padR, 18 * dpr);
  ctx.fillStyle = '#f4e4d6'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.font = `600 ${11 * dpr}px "Plex Mono", monospace`;
  ctx.fillText((b.mid() / 100).toFixed(2), plotW + 8 * dpr, yl);
}
function niceStep(x) { const e = Math.pow(10, Math.floor(Math.log10(x))), f = x / e; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * e; }

// ----------------------------------------------------------- panels ----
function updatePanels() {
  const mid = b.mid(), chg = mid / P0 - 1;
  $('px').textContent = (mid / 100).toFixed(2);
  $('chg').textContent = pct(chg); $('chg').className = `chg num v ${chg >= 0 ? 'up' : 'down'}`;
  $('spread').textContent = isFinite(b.spread()) ? `${b.spread()}¢` : 'one-sided';
  $('vol').textContent = Math.round(b.volume).toLocaleString('en');
  const out = m.makersOut;
  $('mm').textContent = !m.mmEnabled ? 'pulled by you' : out ? 'withdrawn' : 'quoting';
  $('mm').className = `flag ${out ? 'bad' : 'ok'}`;
  $('clock').textContent = clock(m.t);
  $('actLbl').textContent = `trader activity ${m.act.toFixed(1)}× normal`;
  // ladder
  const asks = b.ladder(SELL, 10).reverse(), bids = b.ladder(BUY, 10);
  const mx = Math.max(1, ...asks.map((l) => l.qty), ...bids.map((l) => l.qty));
  $('ladder').innerHTML =
    asks.map((l) => `<tr class="ask"><td class="q"></td><td class="p">${(l.price / 100).toFixed(2)}</td><td class="q r"><span class="bar" style="width:${(l.qty / mx) * 100}%"></span>${Math.round(l.qty).toLocaleString('en')}</td></tr>`).join('') +
    `<tr class="mid"><td colspan="3">spread ${isFinite(b.spread()) ? b.spread() + '¢' : '—'} · mid ${(mid / 100).toFixed(3)}</td></tr>` +
    bids.map((l) => `<tr class="bid"><td class="q l"><span class="bar" style="width:${(l.qty / mx) * 100}%"></span>${Math.round(l.qty).toLocaleString('en')}</td><td class="p">${(l.price / 100).toFixed(2)}</td><td class="q"></td></tr>`).join('');
  // tape
  const lf = me.lastFill && m.t - me.lastFill.t < 1800 ? me.lastFill : null;
  $('tape').innerHTML = (lf ? `<tr class="you"><td class="${lf.side === BUY ? 'b' : 's'}">${lf.side === BUY ? '▲' : '▼'}</td><td>${(lf.avg / 100).toFixed(2)} avg</td><td style="text-align:right">${lf.q.toLocaleString('en')}</td><td style="text-align:right">you, ${clock(lf.t)}</td></tr>` : '') + b.trades.slice(lf ? -11 : -12).reverse().map((t) => `<tr class="${t.buyer === 0 || t.seller === 0 ? 'you' : ''}"><td class="${t.aggressor === BUY ? 'b' : 's'}">${t.aggressor === BUY ? '▲' : '▼'}</td><td>${(t.price / 100).toFixed(2)}</td><td style="text-align:right">${t.qty.toLocaleString('en')}</td><td style="text-align:right;color:#8d7a6c">${t.buyer === 0 || t.seller === 0 ? 'you' : ''}</td></tr>`).join('');
  // desk
  const pos = b.shares[0], pnl = (b.cash[0] + pos * mid) / 100;
  $('posQ').textContent = pos.toLocaleString('en');
  $('posAvg').textContent = me.qty ? (me.cost / Math.abs(me.qty) / 100).toFixed(2) : '—';
  $('posPnl').textContent = `${pnl < 0 ? '−' : ''}$${Math.abs(pnl).toLocaleString('en', { maximumFractionDigits: 0 })}`;
  $('posPnl').style.color = pnl < 0 ? 'var(--down)' : pnl > 0 ? 'var(--up)' : '';
}

// ---------------------------------------------------------- controls ----
const SPEEDS = [1, 2, 4, 16];
let speed = 1, paused = false; // index into SPEEDS
document.querySelectorAll('#sizes button').forEach((btn) => (btn.onclick = () => {
  orderSize = +btn.dataset.q;
  document.querySelectorAll('#sizes button').forEach((x) => x.classList.toggle('on', x === btn));
}));
$('buyBtn').onclick = () => trade(BUY, orderSize);
$('sellBtn').onclick = () => trade(SELL, orderSize);
$('flatBtn').onclick = () => { const q = b.shares[0]; if (q) trade(q > 0 ? SELL : BUY, Math.abs(q)); };
$('pullBtn').onclick = () => {
  m.mmEnabled = !m.mmEnabled;
  $('pullBtn').classList.toggle('on', !m.mmEnabled);
  $('pullBtn').textContent = m.mmEnabled ? 'Pull the market makers' : 'Bring makers back';
  if (!m.mmEnabled) { recent.pulled = m.t; addHeadline('Market makers step away from FLSH', 'liquidity providers cancel every quote; the order book is now only as deep as the traders make it'); }
  else addHeadline('Market makers return to FLSH', 'quotes reappear on both sides and spreads narrow');
  updatePanels();
};
const news = (good) => { m.fair *= good ? 1.04 : 0.96; recent.news = { t: m.t, good }; addHeadline(good ? 'FLSH beats earnings: fair value rises 4%' : 'FLSH misses earnings: fair value falls 4%', 'value-minded traders re-price their orders; watch how fast the market finds the new level'); };
$('goodBtn').onclick = () => news(true);
$('badBtn').onclick = () => news(false);
$('pauseBtn').onclick = () => { paused = !paused; $('pauseBtn').textContent = paused ? 'Resume' : 'Pause'; $('pauseBtn').classList.toggle('on', paused); };
$('speedBtn').onclick = () => { speed = (speed + 1) % SPEEDS.length; $('speedBtn').textContent = `Speed ${SPEEDS[speed]}×`; };
$('ffBtn').onclick = () => { advance(6 * 3600); updateFacts(); updatePanels(); };
$('newBtn').onclick = () => { const u = new URL(location.href); u.searchParams.set('seed', (Math.random() * 1e6) | 0); location.href = u.toString(); };
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'b') trade(BUY, orderSize);
  else if (e.key === 's') trade(SELL, orderSize);
  else if (e.key === ' ') { e.preventDefault(); $('pauseBtn').click(); }
});

// -------------------------------------------------------------- loop ----
function advance(steps) {
  for (let i = 0; i < steps; i++) {
    m.step();
    if (m.t % COLSTEP === 0) sampleColumn();
    if (m.events.length > seenEvents) checkEvents();
  }
}
let frameNo = 0;
function frame() {
  requestAnimationFrame(frame);
  if (!paused) advance(4 * SPEEDS[speed]);
  frameNo++;
  drawChart();
  if (frameNo % 3 === 0) updatePanels();
  if (frameNo % 30 === 0) updateFacts();
}
for (let i = 0; i < MAXCOLS * COLSTEP; i++) { m.step(); if (m.t % COLSTEP === 0) sampleColumn(); } // 40 minutes of history so the chart opens full
updateFacts(); updatePanels();
$('seedLbl').textContent = `session ${seed}`;
requestAnimationFrame(frame);

window.__flash = {
  m, b, me, heads, trade, advance,
  get facts() { return facts; }, get cols() { return cols.length; }, get view() { return view; },
  get labelled() { return labelled.slice(); }, get windowStart() { return cols.length ? cols[0].t : 0; },
  pull: () => $('pullBtn').click(), news,
};
