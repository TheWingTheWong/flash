// Takes the README screenshot (docs/screenshot.png) with Playwright: `node scripts/screenshot.mjs`
import { createRequire } from "node:module";
import { startServer } from "../serve.mjs";

const { chromium } = createRequire(import.meta.url)("playwright");
const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch();
const out = new URL("../docs/screenshot.png", import.meta.url).pathname;
try {
  const page = await browser.newPage({ viewport: { width: 1320, height: 1000 }, deviceScaleFactor: 2 });
  // The page runs in real time, so each take differs. Keep the first take whose story matches the
  // README: the dump is followed by a labelled flash crash, not a squeeze.
  for (let take = 0; take < 8; take++) {
    await page.goto(`${base}?seed=${2020 + take}`);
    await page.waitForFunction(() => window.__flash?.m.t > 2000);
    await page.click("#pauseBtn");
    await page.click("#pullBtn");
    await page.click('[data-q="20000"]');
    await page.click("#sellBtn");
    await page.evaluate(() => window.__flash.advance(500));
    await page.click("#pullBtn"); // makers come back
    await page.evaluate(() => window.__flash.advance(700));
    await page.click("#pauseBtn"); // live again
    await page.waitForTimeout(600); // let the chart window settle
    const labels = await page.evaluate(() => window.__flash.heads.map((h) => h.title).join(" | "));
    if (/FLASH CRASH/.test(labels) && !/SQUEEZE/.test(labels)) break;
  }
  await page.screenshot({ path: out });
  console.log("wrote", out);
} finally { await browser.close(); server.close(); }
