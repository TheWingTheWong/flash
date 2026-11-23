import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrderBook, BUY, SELL } from '../book.js';
import { autocorr, kurtosis, hill, aggregate, stylizedFacts, logReturns, loglogSlope, winsorize } from '../stats.js';
import { Market, pcg } from '../market.js';

const total = (arr) => arr.reduce((a, b) => a + b, 0);

test('matching: price-time priority, partial fills, resting remainder', () => {
  const b = new OrderBook({ accounts: 5 });
  b.limit(SELL, 101, 100, 1);           // first at 101
  b.limit(SELL, 101, 100, 2);           // second at 101 (behind in the queue)
  b.limit(SELL, 100, 50, 3);            // better price
  const r = b.limit(BUY, 101, 180, 4);  // takes 50@100, then 100@101 from #1, then 30@101 from #2
  assert.equal(r.filled, 180);
  assert.deepEqual(b.trades.map((t) => [t.price, t.qty, t.seller]), [[100, 50, 3], [101, 100, 1], [101, 30, 2]]);
  assert.equal(b.depth[SELL][101], 70);
  assert.equal(b.bestAsk, 101);
  const r2 = b.limit(BUY, 99, 40, 4);
  assert.equal(r2.resting, 40); assert.equal(b.bestBid, 99);
  assert.equal(b.check(), null);
});

test('market, IOC, cancel and best-price maintenance', () => {
  const b = new OrderBook({ accounts: 3 });
  const a = b.limit(BUY, 95, 10, 1), c = b.limit(BUY, 97, 10, 1);
  assert.equal(b.bestBid, 97);
  b.cancel(c.id);
  assert.equal(b.bestBid, 95, 'best bid falls back after cancel');
  assert.equal(b.market(SELL, 25, 2), 10, 'market order fills what exists');
  assert.equal(b.hasBids(), false);
  b.limit(SELL, 105, 10, 1); b.limit(SELL, 110, 10, 1);
  assert.equal(b.ioc(BUY, 106, 50, 2), 10, 'IOC stops at its limit and never rests');
  assert.equal(b.bestBid, 0);
  assert.equal(b.cancel(a.id), false, 'filled orders cannot be cancelled');
  assert.equal(b.check(), null);
});

test('circuit-breaker band stops executions outside it', () => {
  const b = new OrderBook({ accounts: 3 });
  b.limit(SELL, 100, 10, 1); b.limit(SELL, 120, 10, 1);
  b.band = { lo: 90, hi: 110 };
  assert.equal(b.market(BUY, 20, 2), 10);
  assert.equal(b.bandHits, 1);
  assert.equal(b.bestAsk, 120);
});

test('fuzz: 20k random orders keep the book consistent and conserve cash and shares', () => {
  const rng = pcg(9), b = new OrderBook({ accounts: 8 }), ids = [];
  for (let i = 0; i < 20000; i++) {
    const side = rng() < 0.5 ? BUY : SELL, owner = Math.floor(rng() * 8), u = rng();
    if (u < 0.55) { const r = b.limit(side, 1000 + Math.floor((rng() - 0.5) * 40), 1 + Math.floor(rng() * 50), owner); if (r.id) ids.push(r.id); }
    else if (u < 0.75) b.market(side, 1 + Math.floor(rng() * 80), owner);
    else if (u < 0.85) b.ioc(side, 1000 + Math.floor((rng() - 0.5) * 20), 1 + Math.floor(rng() * 60), owner);
    else if (ids.length) b.cancel(ids.splice(Math.floor(rng() * ids.length), 1)[0]);
    if (i % 997 === 0) assert.equal(b.check(), null, `step ${i}`);
  }
  assert.equal(b.check(), null);
  assert.equal(total(b.shares), 0, 'every share bought was sold');
  assert.ok(Math.abs(total(b.cash)) < 1e-6, 'every dollar paid was received');
  assert.ok(b.volume > 10000);
});

test('statistics: known answers', () => {
  const rng = pcg(4), g = () => Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
  const gauss = Array.from({ length: 50000 }, g);
  assert.ok(Math.abs(kurtosis(gauss)) < 0.1, 'Gaussian has ~0 excess kurtosis');
  assert.ok(Math.abs(autocorr(gauss, 1)) < 0.02);
  const ar = [0]; for (let i = 1; i < 50000; i++) ar.push(0.6 * ar[i - 1] + g());
  assert.ok(Math.abs(autocorr(ar, 1) - 0.6) < 0.02 && Math.abs(autocorr(ar, 2) - 0.36) < 0.03, 'AR(1) autocorrelation');
  const pareto = Array.from({ length: 50000 }, () => Math.pow(1 - rng(), -1 / 3));
  assert.ok(Math.abs(hill(pareto, 0.05) - 3) < 0.25, 'Hill recovers α = 3');
  assert.deepEqual(aggregate([1, 2, 3, 4, 5], 2), [3, 7]);
  assert.ok(Math.abs(logReturns([100, 110])[0] - Math.log(1.1)) < 1e-12);
  assert.ok(Math.abs(loglogSlope([1, 4, 16], [1, 2, 4]) - 0.5) < 1e-12, 'square-root law slope');
});

test('market: reproducible from its seed, and conserves cash and shares over a long run', () => {
  const a = new Market({ seed: 11 }), b = new Market({ seed: 11 });
  for (let i = 0; i < 5000; i++) { a.step(); b.step(); }
  assert.deepEqual(a.prices.slice(-50), b.prices.slice(-50));
  assert.equal(a.book.check(), null);
  assert.equal(total(a.book.shares), 0);
  assert.ok(Math.abs(total(a.book.cash)) < 1e-3);
});

test('a sell that empties the bids shows as a fall, not a rise (regression)', () => {
  const b = new OrderBook({ accounts: 3 });
  b.limit(BUY, 99, 100, 1); b.limit(BUY, 98, 100, 1); b.limit(SELL, 101, 100, 1);
  const before = b.mid();
  assert.equal(b.market(SELL, 500, 2), 200, 'the order fills only what the bids hold');
  assert.equal(b.hasBids(), false);
  assert.equal(b.mid(), 98, 'with one side gone, the price is the last trade');
  assert.ok(b.mid() < before);
});

test('pulling the market makers cancels their quotes at once', () => {
  const m = new Market({ seed: 3 });
  for (let i = 0; i < 300; i++) m.step();
  const quoted = () => [...m.book.orders.values()].filter((o) => o.owner > m.o.nTraders).length;
  assert.ok(quoted() > 0, 'makers are quoting');
  m.mmEnabled = false;
  assert.equal(quoted(), 0, 'no maker quote survives the pull');
  m.step();
  assert.equal(quoted(), 0, 'and none come back while pulled');
  assert.equal(m.book.check(), null);
});

test('stylized facts emerge across sessions (12 seeds × 6 trading hours)', () => {
  const c = { calm: 0, clusters: 0, fat: 0, powerLaw: 0, scoreboard: 0 };
  for (let seed = 2020; seed < 2032; seed++) {
    const m = new Market({ seed });
    for (let i = 0; i < 21600; i++) m.step();
    const f = stylizedFacts(m.returns(60));
    const ok = [Math.abs(f.acf1) < 0.1, f.acfAbs[0] > 0.1 && f.acfAbs[1] > 0.05, f.kurtosis > 1 && f.kurtosisAgg < f.kurtosis, f.tail >= 1.5 && f.tail <= 5];
    if (Math.abs(f.acf1Calm) < 0.1) c.calm++;
    c.clusters += ok[1]; c.fat += ok[2]; c.powerLaw += ok[3]; c.scoreboard += ok.filter(Boolean).length;
    assert.equal(m.book.check(), null);
  }
  assert.ok(c.clusters >= 11, `volatility clustering in ${c.clusters}/12 sessions`);
  assert.ok(c.fat >= 10, `fat tails that thin out under aggregation in ${c.fat}/12 sessions`);
  assert.ok(c.powerLaw >= 8, `power-law tail exponent in range in ${c.powerLaw}/12 sessions`);
  assert.ok(c.calm >= 8, `calm-market returns unpredictable in ${c.calm}/12 sessions`);
  assert.ok(c.scoreboard >= 36, `scoreboard shows ${c.scoreboard}/48 ✓`);
});

test('winsorize clips outliers without touching the bulk', () => {
  const x = [0.1, -0.2, 0.15, -0.1, 0.05, 9, -7];
  const w = winsorize(x);
  assert.deepEqual(w.slice(0, 5), x.slice(0, 5));
  assert.ok(w[5] < 1 && w[6] > -1);
});

test('the flash-crash recipe: pull the makers, dump 20,000 shares', () => {
  let sum = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const m = new Market({ seed });
    for (let i = 0; i < 2000; i++) m.step();
    m.mmEnabled = false;
    const p0 = m.book.mid();
    m.step((b) => b.market(SELL, 20000, 0));
    const instant = m.book.mid() / p0 - 1;
    let low = m.book.mid(); for (let i = 0; i < 400; i++) { m.step(); low = Math.min(low, m.book.mid()); }
    assert.ok(instant < -0.003, `seed ${seed}: the price drops at once (${(instant * 100).toFixed(2)}%)`);
    assert.ok(low / p0 - 1 < -0.025, `seed ${seed}: and keeps falling (${((low / p0 - 1) * 100).toFixed(2)}%)`);
    sum += low / p0 - 1;
  }
  assert.ok(sum / 6 < -0.035, `average drawdown ${((sum / 6) * 100).toFixed(2)}%`);
});

test('market makers cushion a 20,000-share dump', () => {
  const drop = (makers) => {
    let s = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const m = new Market({ seed });
      for (let i = 0; i < 2000; i++) m.step();
      m.mmEnabled = makers;
      const p0 = m.book.mid();
      m.step((b) => b.market(SELL, 20000, 0));
      let low = m.book.mid(); for (let i = 0; i < 400; i++) { m.step(); low = Math.min(low, m.book.mid()); }
      s += low / p0 - 1;
    }
    return s / 6;
  };
  const withMM = drop(true), without = drop(false);
  assert.ok(withMM < 0 && without < withMM, `drawdown with makers ${(withMM * 100).toFixed(2)}% vs without ${(without * 100).toFixed(2)}%`);
});
