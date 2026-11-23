// FLASH — the "stylized facts" of financial returns, measured from scratch.

export const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;

export function autocorr(x, lag) {
  const n = x.length;
  if (n <= lag + 2) return NaN;
  const m = mean(x);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) den += (x[i] - m) ** 2;
  for (let i = lag; i < n; i++) num += (x[i] - m) * (x[i - lag] - m);
  return den ? num / den : 0;
}

/** Excess kurtosis (0 for a Gaussian; fat tails > 0). */
export function kurtosis(x) {
  const m = mean(x);
  let m2 = 0, m4 = 0;
  for (const v of x) { const d = (v - m) ** 2; m2 += d; m4 += d * d; }
  m2 /= x.length; m4 /= x.length;
  return m2 ? m4 / (m2 * m2) - 3 : 0;
}

/** Hill estimator of the tail exponent α from the largest `frac` of |x|. */
export function hill(x, frac = 0.05) {
  const a = x.map(Math.abs).filter((v) => v > 0).sort((p, q) => q - p);
  const k = Math.max(5, Math.floor(a.length * frac));
  if (a.length <= k) return NaN;
  let s = 0;
  for (let i = 0; i < k; i++) s += Math.log(a[i] / a[k]);
  return k / s;
}

/** Sum consecutive blocks of m returns (log returns aggregate by addition). */
export function aggregate(r, m) {
  const out = [];
  for (let i = 0; i + m <= r.length; i += m) { let s = 0; for (let j = 0; j < m; j++) s += r[i + j]; out.push(s); }
  return out;
}

export const logReturns = (prices) => prices.slice(1).map((p, i) => Math.log(p / prices[i]));

/** Least-squares slope of log y on log x (for impact exponents). */
export function loglogSlope(xs, ys) {
  const lx = xs.map(Math.log), ly = ys.map(Math.log), mx = mean(lx), my = mean(ly);
  let num = 0, den = 0;
  for (let i = 0; i < lx.length; i++) { num += (lx[i] - mx) * (ly[i] - my); den += (lx[i] - mx) ** 2; }
  return num / den;
}

/** Clip values beyond k robust standard deviations (median absolute deviation × 1.4826), so a few
 *  crash minutes can't dominate a correlation estimate. */
export function winsorize(x, k = 3) {
  const a = x.map(Math.abs).sort((p, q) => p - q);
  const s = (a[a.length >> 1] || 0) * 1.4826 * k;
  return s ? x.map((v) => Math.max(-s, Math.min(s, v))) : x.slice();
}

/** The scoreboard: how today's tape compares with what real markets show. */
export function stylizedFacts(returns) {
  const abs = returns.map(Math.abs);
  const acfAbs = [1, 2, 5, 10, 20].map((l) => autocorr(abs, l));
  return {
    n: returns.length,
    acf1: autocorr(returns, 1),
    acf1Calm: autocorr(winsorize(returns), 1),
    acfAbs,
    kurtosis: kurtosis(returns),
    kurtosisAgg: kurtosis(aggregate(returns, 10)),
    tail: hill(returns, 0.05),
  };
}
