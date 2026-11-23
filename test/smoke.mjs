// End-to-end: the exchange runs, you can trade into it, and the scoreboard + headlines respond.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startServer } from '../serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const shotDir = process.env.SHOT_DIR;
const server = await startServer(0);
const root = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 1050 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(root);
  await page.waitForFunction(() => window.__flash?.m.t > 400, null, { timeout: 20000 });
  assert.ok(await page.locator('#ladder tr.ask').count() >= 5 && await page.locator('#ladder tr.bid').count() >= 5, 'both sides of the book are populated');
  assert.equal(await page.locator('#ladder tr.mid').count(), 1);
  const t0 = await page.evaluate(() => window.__flash.m.t);
  await page.waitForTimeout(500);
  assert.ok((await page.evaluate(() => window.__flash.m.t)) > t0, 'market clock runs');
  console.log('✓ exchange boots, ladder shows both sides, market clock runs');

  // trade into the market
  await page.click('#buyBtn');
  assert.equal(await page.evaluate(() => window.__flash.b.shares[0]), 1000);
  await page.waitForSelector('#tape tr.you', { timeout: 3000 }); // your last fill stays pinned to the tape
  assert.equal(await page.textContent('#posQ'), '1,000');
  await page.click('#flatBtn');
  assert.equal(await page.evaluate(() => window.__flash.b.shares[0]), 0);
  console.log('✓ buy 1,000 at market → position, tape, then flatten');

  // fast-forward: the scoreboard fills in
  await page.click('#ffBtn');
  await page.waitForFunction(() => window.__flash.facts);
  assert.match(await page.textContent('#factsN'), /one-minute returns/);
  const ok = await page.locator('.fact[data-ok="true"]').count();
  assert.ok(ok >= 3, `${ok}/4 stylized facts match after a simulated session`);
  console.log(`✓ fast-forward 6 hours: ${ok}/4 stylized facts match`);
  // after a fast-forward the chart window must already contain the price, and only label visible events
  await page.waitForTimeout(150);
  const chart = await page.evaluate(() => { const f = window.__flash; return { lo: f.view.lo, hi: f.view.hi, mid: f.b.mid(), labels: f.labelled, start: f.windowStart }; });
  assert.ok(chart.mid > chart.lo && chart.mid < chart.hi, `price ${chart.mid} inside the chart window ${chart.lo.toFixed(0)}–${chart.hi.toFixed(0)}`);
  assert.ok(chart.labels.every((l) => l.t >= chart.start), 'no labels for events that scrolled out of the window');
  console.log(`✓ chart window follows the price after fast-forward (${chart.labels.length} event label(s) in view)`);
  if (shotDir) await page.screenshot({ path: `${shotDir}/flash-facts.png`, fullPage: true });

  // the flash-crash recipe: pull the makers, dump 20k, let the market react
  await page.click('#pullBtn');
  assert.equal(await page.textContent('#mm'), 'pulled by you');
  await page.click('[data-q="20000"]');
  const makerQuotes = await page.evaluate(() => [...window.__flash.b.orders.values()].filter((o) => o.owner > window.__flash.m.o.nTraders).length);
  assert.equal(makerQuotes, 0, 'pulling the makers cancels their quotes at once');
  await page.click('#pauseBtn'); // freeze time so we measure only our order
  const before = await page.evaluate(() => window.__flash.b.mid());
  await page.click('#sellBtn');
  const after = await page.evaluate(() => window.__flash.b.mid());
  assert.ok(after < before * 0.997, `a 20k dump into a book without makers drops the price at once (${((after / before - 1) * 100).toFixed(2)}%)`);
  const low = await page.evaluate(() => { const f = window.__flash, t0 = f.m.prices.length; f.advance(800); return Math.min(...f.m.prices.slice(t0)); });
  assert.ok(low < before * 0.98, `and the crash keeps going (${((low / before - 1) * 100).toFixed(2)}% at the low)`);
  await page.click('#pauseBtn');
  const heads = await page.evaluate(() => window.__flash.heads.map((h) => h.title));
  assert.ok(heads.some((h) => /Market makers step away/.test(h)));
  assert.ok(heads.some((h) => /moves FLSH|empties the bids|FLASH CRASH/.test(h)), 'the dump makes the news: ' + heads.join(' | '));
  console.log(`✓ pull makers + dump 20k: ${((after / before - 1) * 100).toFixed(2)}% at once, ${((low / before - 1) * 100).toFixed(2)}% at the low; headline: "${heads.find((h) => /empties|moves|CRASH/.test(h))}"`);
  await page.click('#pullBtn');
  await page.click('#goodBtn');
  assert.ok((await page.evaluate(() => window.__flash.heads[0].title)).includes('beats earnings'));
  console.log('✓ makers return; good-news shock reprices fair value and makes a headline');

  // chart renders ink
  const inked = await page.evaluate(() => {
    const c = document.getElementById('chart'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 0; i < d.length; i += 16) if (Math.abs(d[i] - 244) + Math.abs(d[i + 1] - 228) + Math.abs(d[i + 2] - 214) > 40) n++; return n;
  });
  assert.ok(inked > 2000, `chart has ink (${inked} samples)`);
  console.log('✓ depth heatmap and price line render');
  if (shotDir) {
    await page.evaluate(() => window.__flash.advance(400));
    await page.waitForTimeout(400);
    await page.evaluate(() => scrollTo(0, 0));
    await page.screenshot({ path: `${shotDir}/flash-desk.png` });
    const ph = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await ph.goto(root); await ph.waitForFunction(() => window.__flash?.m.t > 600);
    await ph.screenshot({ path: `${shotDir}/flash-phone.png`, fullPage: true });
  }
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await phone.goto(root); await phone.waitForFunction(() => window.__flash?.m.t > 400);
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  assert.ok(overflow <= 0, `no horizontal scrolling on a phone (overflow ${overflow}px)`);
  console.log('✓ phone layout fits 390px without horizontal scrolling');
  assert.deepEqual(errors, []);
  console.log('✓ no console errors');
} catch (e) { failed = true; console.error(e); }
finally { await browser.close(); server.close(); }
process.exit(failed ? 1 : 0);
