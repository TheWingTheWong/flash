// FLASH — a limit order book with a price-time-priority matching engine.
//
// Prices are integer ticks (1 tick = $0.01). Each price level is a FIFO queue,
// and a dense per-tick depth array gives O(1) level totals for the depth
// heatmap. Every trade moves cash and shares between accounts, so the totals
// of both are conserved exactly (a property the tests check).

export const BUY = 1, SELL = -1;

export class OrderBook {
  constructor({ maxTick = 400000, accounts = 1 } = {}) {
    this.maxTick = maxTick;
    this.depth = { [BUY]: new Float64Array(maxTick + 1), [SELL]: new Float64Array(maxTick + 1) };
    this.levels = { [BUY]: new Map(), [SELL]: new Map() };
    this.bestBid = 0;               // 0 = no bids
    this.bestAsk = maxTick + 1;     // maxTick+1 = no asks
    this.orders = new Map();        // live resting orders by id
    this.nextId = 1;
    this.cash = new Float64Array(accounts); // in ticks × shares
    this.shares = new Float64Array(accounts);
    this.volume = 0;
    this.lastPrice = 0;
    this.trades = [];               // recent trades (bounded)
    this.onTrade = null;
    this.band = null;               // { lo, hi } circuit-breaker band, in ticks; null = off
    this.bandHits = 0;
  }

  hasBids() { return this.bestBid > 0; }
  hasAsks() { return this.bestAsk <= this.maxTick; }
  mid() {
    if (this.hasBids() && this.hasAsks()) return (this.bestBid + this.bestAsk) / 2;
    // One side swept away: the last trade is the price. (Falling back to the surviving side would
    // show a sell order that empties the bids as a price *rise*.) Never trade? Use what's quoted.
    if (this.lastPrice) return this.lastPrice;
    return this.hasBids() ? this.bestBid : this.hasAsks() ? this.bestAsk : 0;
  }
  spread() { return this.hasBids() && this.hasAsks() ? this.bestAsk - this.bestBid : Infinity; }

  _trade(price, qty, buyer, seller, aggressor) {
    this.cash[buyer] -= price * qty; this.cash[seller] += price * qty;
    this.shares[buyer] += qty; this.shares[seller] -= qty;
    this.volume += qty; this.lastPrice = price;
    const tr = { price, qty, buyer, seller, aggressor };
    this.trades.push(tr);
    if (this.trades.length > 400) this.trades.splice(0, 200);
    if (this.onTrade) this.onTrade(tr);
  }

  /** Match an incoming order against the opposite side up to `limit` (inclusive). Returns remaining qty. */
  _match(side, qty, owner, limit) {
    const opp = -side;
    if (this.band) limit = side === BUY ? Math.min(limit, this.band.hi) : Math.max(limit, this.band.lo);
    while (qty > 0) {
      const best = side === BUY ? this.bestAsk : this.bestBid;
      if (side === BUY ? best > Math.min(limit, this.maxTick) : best < Math.max(limit, 1)) break;
      const lvl = this.levels[opp].get(best);
      while (qty > 0 && lvl.h < lvl.q.length) {
        const o = lvl.q[lvl.h];
        if (o.qty <= 0) { lvl.h++; continue; } // cancelled
        const fill = Math.min(qty, o.qty);
        o.qty -= fill; qty -= fill; this.depth[opp][best] -= fill;
        if (side === BUY) this._trade(best, fill, owner, o.owner, BUY);
        else this._trade(best, fill, o.owner, owner, SELL);
        if (o.qty <= 0) { lvl.h++; this.orders.delete(o.id); }
      }
      if (lvl.h >= lvl.q.length || this.depth[opp][best] <= 1e-9) { this._clearLevel(opp, best); }
    }
    return qty;
  }

  _clearLevel(side, price) {
    this.levels[side].delete(price);
    this.depth[side][price] = 0;
    if (side === BUY && price === this.bestBid) this._rescan(BUY);
    if (side === SELL && price === this.bestAsk) this._rescan(SELL);
  }

  _rescan(side) {
    if (this.levels[side].size === 0) { if (side === BUY) this.bestBid = 0; else this.bestAsk = this.maxTick + 1; return; }
    if (side === BUY) {
      let p = this.bestBid;
      while (p > 0 && this.depth[BUY][p] <= 1e-9) p--;
      // depth arrays can't see levels that only hold cancelled orders; those were cleared already
      this.bestBid = p;
    } else {
      let p = this.bestAsk;
      while (p <= this.maxTick && this.depth[SELL][p] <= 1e-9) p++;
      this.bestAsk = p;
    }
  }

  /** Limit order: matches what it can, rests the rest. Returns { id, filled, resting }. */
  limit(side, price, qty, owner) {
    price = Math.max(1, Math.min(this.maxTick, Math.round(price)));
    qty = Math.floor(qty);
    if (qty <= 0) return { id: 0, filled: 0, resting: 0 };
    const left = this._match(side, qty, owner, price);
    if (left <= 0) return { id: 0, filled: qty, resting: 0 };
    const id = this.nextId++;
    const o = { id, side, price, qty: left, owner };
    let lvl = this.levels[side].get(price);
    if (!lvl) { lvl = { q: [], h: 0 }; this.levels[side].set(price, lvl); }
    if (lvl.h > 64 && lvl.h * 2 > lvl.q.length) { lvl.q = lvl.q.slice(lvl.h); lvl.h = 0; } // compact
    lvl.q.push(o);
    this.depth[side][price] += left;
    this.orders.set(id, o);
    if (side === BUY && price > this.bestBid) this.bestBid = price;
    if (side === SELL && price < this.bestAsk) this.bestAsk = price;
    return { id, filled: qty - left, resting: left };
  }

  /** Immediate-or-cancel: take liquidity up to `price`, never rest. Returns filled qty. */
  ioc(side, price, qty, owner) {
    qty = Math.floor(qty);
    if (qty <= 0) return 0;
    return qty - this._match(side, qty, owner, Math.round(price));
  }

  /** Market order: sweeps the book until filled or the book runs dry. Returns filled qty. */
  market(side, qty, owner) {
    qty = Math.floor(qty);
    if (qty <= 0) return 0;
    const left = this._match(side, qty, owner, side === BUY ? this.maxTick : 1);
    if (left > 0 && this.band) this.bandHits++; // ran into the circuit breaker (or an empty book)
    return qty - left;
  }

  cancel(id) {
    const o = this.orders.get(id);
    if (!o) return false;
    this.orders.delete(id);
    this.depth[o.side][o.price] -= o.qty;
    o.qty = 0;
    if (this.depth[o.side][o.price] <= 1e-9) this._clearLevel(o.side, o.price);
    return true;
  }

  /** Total resting volume within `ticks` of the best price on a side. */
  liquidity(side, ticks) {
    let s = 0;
    if (side === BUY) for (let p = this.bestBid; p > Math.max(0, this.bestBid - ticks); p--) s += this.depth[BUY][p];
    else for (let p = this.bestAsk; p < Math.min(this.maxTick + 1, this.bestAsk + ticks); p++) s += this.depth[SELL][p];
    return s;
  }

  /** Top-of-book ladder: [{price, qty}] best first. */
  ladder(side, n) {
    const out = [];
    if (side === BUY) for (let p = this.bestBid; p > 0 && out.length < n; p--) { if (this.depth[BUY][p] > 0) out.push({ price: p, qty: this.depth[BUY][p] }); if (this.bestBid - p > 5000) break; }
    else for (let p = this.bestAsk; p <= this.maxTick && out.length < n; p++) { if (this.depth[SELL][p] > 0) out.push({ price: p, qty: this.depth[SELL][p] }); if (p - this.bestAsk > 5000) break; }
    return out;
  }

  /** Internal consistency check used by tests: depth arrays agree with queues, book not crossed. */
  check() {
    for (const side of [BUY, SELL]) for (const [p, lvl] of this.levels[side]) {
      let s = 0; for (let i = lvl.h; i < lvl.q.length; i++) s += Math.max(0, lvl.q[i].qty);
      if (Math.abs(s - this.depth[side][p]) > 1e-6) return `depth mismatch at ${side}@${p}: ${s} vs ${this.depth[side][p]}`;
      if (s <= 0) return `empty level kept at ${side}@${p}`;
    }
    if (this.hasBids() && this.hasAsks() && this.bestBid >= this.bestAsk) return `crossed book ${this.bestBid} >= ${this.bestAsk}`;
    if (this.hasBids() && this.depth[BUY][this.bestBid] <= 0) return 'bestBid points at empty level';
    if (this.hasAsks() && this.depth[SELL][this.bestAsk] <= 0) return 'bestAsk points at empty level';
    return null;
  }
}
