// FLASH — a market of 500 heterogeneous traders around one order book.
//
// Traders follow the Chiarella–Iori (2002) design: each blends three motives
// with personal weights:
//   value   — pull toward a slowly drifting fundamental value
//   trend   — extrapolate recent returns (or bet against them: weights can be negative)
//   noise   — idiosyncratic opinion
// into an expected price, then posts a limit order a random distance inside
// that expectation (marketable if it crosses the spread). Orders expire.
//
// On top of that:
//   • market makers quote both sides post-only, skew against inventory, and
//     pull out entirely when volatility spikes: that's where flash crashes come from
//   • arrivals are self-exciting: traders show up faster after big moves
//   • a ±band price limit (like limit-up/limit-down) stops prints far from
//     a slow reference price
// None of the "stylized facts" are coded in; they have to emerge.

import { OrderBook, BUY, SELL } from './book.js';

export function pcg(seed) { // small fast seeded RNG (mulberry32)
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULTS = {
  seed: 1, startPrice: 10000,           // $100.00 in ticks
  nTraders: 500, nMM: 6,
  arrivals: 4,                          // trader arrivals per step (before excitement)
  wValue: 1, wTrend: 0.6, wNoise: 1,    // spread of personal weights
  horizon: 300,                         // steps over which a trader expects mispricing to close
  noiseVol: 0.00025,                    // per-step opinion noise
  kMax: 0.012,                          // max relative distance of a limit order inside the expectation
  maxExpect: 0.02,                      // cap on any trader's expected move
  slip: 3,                              // how far through the touch an eager trader will pay
  life: [60, 600],                      // order lifetime range (steps)
  sizeMin: 60, sizeAlpha: 1.6, sizeCap: 2500,
  fundVol: 0.00025,                     // fair value drift per step (on average)
  newsVolVol: 0.5, newsMem: 0.998,       // how much, and how slowly, news intensity wanders
  mmValue: 0.5,                         // makers lean quotes halfway toward fair value: keeps calm returns unpredictable
  mmSize: 150, mmLevels: 3, mmLimit: 5000, mmPanic: 3.5, mmCooldown: 60,
  excite: 1, actCap: 5,
  band: 0.08, refSpeed: 0.003,
};

export class Market {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };
    this.o = o;
    this.rng = pcg(o.seed);
    this.nAgents = 1 + o.nTraders + o.nMM; // 0 = you
    this.book = new OrderBook({ accounts: this.nAgents });
    this.t = 0;
    this.fair = o.startPrice;
    this.newsLv = 0;
    this.logP = [Math.log(o.startPrice)]; // history for trend estimates
    // a balanced population: every trend-follower is paired with an equally strong contrarian,
    // so no session is born with a built-in momentum or mean-reversion bias
    this.traders = [];
    for (let i = 0; i < o.nTraders; i += 2) {
      const g2 = Math.abs(this.gauss()) * o.wTrend, L = 10 + Math.floor(this.rng() * 290);
      for (const sign of [1, -1]) this.traders.push({ g1: Math.abs(this.gauss()) * o.wValue, g2: sign * g2, n: Math.abs(this.gauss()) * o.wNoise, L });
    }
    this.traders.length = o.nTraders;
    const firstMM = 1 + o.nTraders;
    this.mms = Array.from({ length: o.nMM }, (_, i) => ({ id: firstMM + i, orders: [], off: 0, phase: i }));
    this._mmEnabled = true;
    this.expiry = new Map();
    this.var = 0; this.var0 = 1e-8; this.varLong = 1e-8; this.act = 1;
    this.ref = o.startPrice; this.bandSteps = 0; this.atBand = -1;
    this.prices = []; this.events = [];
    this.seedBook();
    this.calibrate();
  }

  gauss() { const u = 1 - this.rng(), v = this.rng(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  poisson(l) { let k = 0, p = Math.exp(-Math.min(l, 50)), s = p; const u = this.rng(); while (u > s && k < 200) { k++; p *= l / k; s += p; } return k; }
  size() { const o = this.o; return Math.min(o.sizeCap, Math.floor(o.sizeMin / Math.pow(1 - this.rng(), 1 / o.sizeAlpha))); }

  rest(side, price, qty, owner) {
    const r = this.book.limit(side, price, qty, owner);
    if (r.id) {
      const [a, b] = this.o.life, at = this.t + a + Math.floor(this.rng() * (b - a));
      let list = this.expiry.get(at); if (!list) this.expiry.set(at, (list = []));
      list.push(r.id);
    }
    return r;
  }

  seedBook() {
    const p0 = this.o.startPrice;
    for (let i = 0; i < 400; i++) {
      const side = i % 2 ? BUY : SELL, off = 1 + Math.floor(this.rng() * p0 * this.o.kMax);
      this.rest(side, p0 - side * off, this.size(), 1 + Math.floor(this.rng() * this.o.nTraders));
    }
  }

  calibrate() {
    let s = 0, n = 0, prev = this.book.mid();
    for (let i = 0; i < 3000; i++) { // warm up until the book is fully built, then measure calm variance
      this.step(); const m = this.book.mid(); const r = Math.log(m / prev); if (i >= 2000) { s += r * r; n++; } prev = m;
    }
    this.var0 = Math.max(1e-10, s / n);
    this.var = this.var0; this.varLong = this.var0;
    this.prices = []; this.events = []; this.bandSteps = 0; this.atBand = -1; this.t0 = this.t;
  }

  quoteMM(mm) {
    const b = this.book, o = this.o;
    for (const id of mm.orders) b.cancel(id);
    mm.orders = [];
    if (!this.mmEnabled || this.t < mm.off) return;
    const vol = Math.sqrt(this.var / this.varLong); // a spike relative to recent conditions
    if (vol > o.mmPanic) { mm.off = this.t + o.mmCooldown; return; } // pull every quote and wait it out
    const inv = b.shares[mm.id], half = Math.max(1, Math.round(1 + 1.5 * vol));
    const mid = b.mid() + o.mmValue * (this.fair - b.mid()); // makers lean their quotes toward fair value
    const skew = Math.round(Math.max(-1, Math.min(1, -inv / o.mmLimit)) * half);
    for (let l = 0; l < o.mmLevels; l++) {
      let bid = Math.floor(mid) - half - l * 3 + skew, ask = Math.ceil(mid) + half + l * 3 + skew;
      if (b.hasAsks()) bid = Math.min(bid, b.bestAsk - 1); // post-only: never cross the market
      if (b.hasBids()) ask = Math.max(ask, b.bestBid + 1);
      if (inv < o.mmLimit) { const r = b.limit(BUY, bid, o.mmSize, mm.id); if (r.id) mm.orders.push(r.id); }
      if (inv > -o.mmLimit) { const r = b.limit(SELL, ask, o.mmSize, mm.id); if (r.id) mm.orders.push(r.id); }
    }
  }

  /** Pulling the makers cancels every quote at once (not at their next requote). */
  get mmEnabled() { return this._mmEnabled; }
  set mmEnabled(on) {
    this._mmEnabled = !!on;
    if (!on) for (const mm of this.mms) { for (const id of mm.orders) this.book.cancel(id); mm.orders = []; }
  }

  get makersOut() { return !this.mmEnabled || this.mms.some((m) => this.t < m.off); }

  /** One step of market time. `userAction(book)` lets you trade inside the step. */
  step(userAction = null) {
    const b = this.book, o = this.o, rng = this.rng;
    const before = b.mid();
    this.t++;
    this.ref += o.refSpeed * (before - this.ref);
    b.band = { lo: Math.max(1, Math.floor(this.ref * (1 - o.band))), hi: Math.ceil(this.ref * (1 + o.band)) };
    const hitsBefore = b.bandHits;
    // news arrives in bursts: the intensity of fair-value moves wanders (log-AR(1)), so busy
    // stretches and quiet ones alternate, as on a real tape
    if (o.newsVolVol) this.newsLv = o.newsMem * this.newsLv + o.newsVolVol * Math.sqrt(1 - o.newsMem * o.newsMem) * this.gauss();
    this.fair *= Math.exp(o.fundVol * Math.exp(this.newsLv - o.newsVolVol * o.newsVolVol / 2) * this.gauss());

    // expire old orders
    const due = this.expiry.get(this.t);
    if (due) { for (const id of due) b.cancel(id); this.expiry.delete(this.t); }

    for (const mm of this.mms) if ((this.t + mm.phase) % 3 === 0 || !mm.orders.length) this.quoteMM(mm);

    // traders arrive, form an expectation, and post a limit order around it
    const p = b.mid(), H = this.logP, n = this.poisson(o.arrivals * this.act);
    for (let k = 0; k < n; k++) {
      const id = 1 + Math.floor(rng() * o.nTraders), a = this.traders[id - 1];
      const L = Math.min(a.L, H.length - 1);
      const trend = L > 0 ? (H[H.length - 1] - H[H.length - 1 - L]) / L : 0;
      const value = Math.log(this.fair / p) / o.horizon;
      const r = (a.g1 * value + a.g2 * trend + a.n * o.noiseVol * this.gauss()) / (a.g1 + Math.abs(a.g2) + a.n);
      const expect = p * Math.exp(Math.max(-o.maxExpect, Math.min(o.maxExpect, r * o.horizon))); // nobody expects a 15% move in a minute
      const kk = rng() * o.kMax;
      if (expect > p) {
        const price = Math.min(b.band.hi, Math.floor(expect * (1 - kk)));
        // eager buyers take what's offered near the touch and cancel the rest; patient ones rest
        if (b.hasAsks() && price >= b.bestAsk) b.ioc(BUY, Math.min(price, b.bestAsk + o.slip), this.size(), id);
        else this.rest(BUY, price, this.size(), id);
      } else {
        const price = Math.max(b.band.lo, Math.ceil(expect * (1 + kk)));
        if (b.hasBids() && price <= b.bestBid) b.ioc(SELL, Math.max(price, b.bestBid - o.slip), this.size(), id);
        else this.rest(SELL, price, this.size(), id);
      }
    }

    if (userAction) userAction(b);
    if (b.bandHits > hitsBefore) { this.bandSteps++; this.atBand = this.t; }

    // a side that's completely gone gets a token order (someone always bids eventually): a bargain
    // hunter prices 1% off whatever is still quoted on the other side
    if (!b.hasBids()) this.rest(BUY, Math.max(b.band.lo, Math.floor((b.hasAsks() ? b.bestAsk : b.mid()) * 0.99)), 200, 1 + Math.floor(rng() * o.nTraders));
    if (!b.hasAsks()) this.rest(SELL, Math.min(b.band.hi, Math.ceil((b.hasBids() ? b.bestBid : b.mid()) * 1.01)), 200, 1 + Math.floor(rng() * o.nTraders));

    const after = b.mid(), ret = Math.log(after / before);
    this.var = 0.97 * this.var + 0.03 * ret * ret;
    this.varLong = 0.9995 * this.varLong + 0.0005 * ret * ret;
    this.act = Math.min(o.actCap, Math.max(0.6, 1 + o.excite * (Math.sqrt(this.var / Math.max(this.var0, this.varLong * 0.5)) - 1)));
    H.push(Math.log(after)); if (H.length > 4000) H.splice(0, 2000);
    this.prices.push(after);
    if (this.prices.length > 200000) this.prices.splice(0, 100000);
    this.detect();
  }

  /** Flag crashes and squeezes: a > 3% move inside 150 steps. */
  detect() {
    const P = this.prices, n = P.length, W = 150;
    if (n < W || (this.events.length && this.t - this.events[this.events.length - 1].t < 400)) return;
    let hi = -Infinity, lo = Infinity, hiAt = 0, loAt = 0;
    for (let i = n - W; i < n; i++) { if (P[i] > hi) { hi = P[i]; hiAt = i; } if (P[i] < lo) { lo = P[i]; loAt = i; } }
    const now = P[n - 1];
    if (hiAt < loAt && now / hi - 1 < -0.03) this.events.push({ t: this.t, kind: 'crash', move: now / hi - 1, steps: n - 1 - hiAt });
    else if (loAt < hiAt && now / lo - 1 > 0.03) this.events.push({ t: this.t, kind: 'squeeze', move: now / lo - 1, steps: n - 1 - loAt });
  }

  returns(every = 50) {
    const out = [];
    for (let i = every; i < this.prices.length; i += every) out.push(Math.log(this.prices[i] / this.prices[i - every]));
    return out;
  }
}
