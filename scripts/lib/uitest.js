'use strict';
// Headless multi-page smoke test: gate, calendar, race detail (odds/market/
// small-sample), history+calibration, database. Serves docs/ statically.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const DOCS = path.resolve(__dirname, '..', '..', 'docs');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/index.html';
  const fp = path.join(DOCS, p);
  if (!fp.startsWith(DOCS) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const browser = await chromium.launch({ executablePath: EXE });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const ok = {};

  // ---- index: gate + calendar + race list ----
  await page.goto(base + '/index.html');
  ok.gateShown = await page.isVisible('#gate');
  await page.fill('#pw', 'Master0701!'); await page.click('#gate button[type=submit]');
  await page.waitForSelector('.daybar .day', { timeout: 5000 });
  await page.waitForSelector('.racecard', { timeout: 5000 });
  ok.days = await page.$$eval('.daybar .day', (e) => e.length);
  ok.races = await page.$$eval('.racecard', (e) => e.length);
  await page.screenshot({ path: path.join(DOCS, 'preview-index.png'), fullPage: true });

  // ---- race detail: open R2 (has odds/market) ----
  await page.goto(base + '/race.html?id=2026-07-05-turffontein-r2');
  await page.waitForSelector('#race section.card', { timeout: 5000 });
  ok.raceHeadings = await page.$$eval('section.card h2', (e) => e.map((x) => x.textContent.trim()));
  ok.hasMarket = ok.raceHeadings.some((h) => /Model vs Market/i.test(h));
  await page.screenshot({ path: path.join(DOCS, 'preview-race.png'), fullPage: true });

  // ---- history: strike + calibration ----
  await page.goto(base + '/history.html');
  await page.waitForSelector('#body section.card', { timeout: 5000 });
  ok.calRows = await page.$$eval('.calrow', (e) => e.length);
  ok.hasCalibration = (await page.content()).includes('Confidence calibration');
  await page.screenshot({ path: path.join(DOCS, 'preview-history.png'), fullPage: true });

  // ---- multi ----
  await page.goto(base + '/multi.html');
  await page.waitForSelector('#body section.card', { timeout: 5000 });
  ok.multiHeadings = await page.$$eval('#body section.card h2', (e) => e.map((x) => x.textContent.trim()));
  ok.bankers = await page.$$eval('.banker', (e) => e.length);
  ok.multiCards = await page.$$eval('.multi', (e) => e.length);
  await page.click('.segbtns button:nth-child(2)'); // switch to win multis
  await page.waitForTimeout(150);
  ok.afterToggle = await page.$$eval('.multi', (e) => e.length);
  await page.screenshot({ path: path.join(DOCS, 'preview-multi.png'), fullPage: true });

  // ---- database ----
  await page.goto(base + '/horses.html');
  await page.waitForSelector('.horse', { timeout: 5000 });
  ok.horses = await page.$$eval('.horse', (e) => e.length);
  await page.click('.horse');
  await page.waitForSelector('#detail .kpi', { timeout: 5000 });
  ok.horseKpis = await page.$$eval('#detail .kpi', (e) => e.length);

  // ---- gate enforcement: fresh context should redirect race.html -> index ----
  const ctx2 = await browser.newContext();
  const p2 = await ctx2.newPage();
  await p2.goto(base + '/race.html?id=2026-07-05-turffontein-r2');
  await p2.waitForLoadState('networkidle');
  ok.gateRedirect = /index\.html$/.test(p2.url()) || p2.url().endsWith('/');
  await ctx2.close();

  await browser.close(); server.close();
  console.log(JSON.stringify(ok, null, 2));
  console.log('page errors:', errors);

  const pass = ok.gateShown && ok.days >= 1 && ok.races === 10 && ok.hasMarket &&
    ok.hasCalibration && ok.horses > 0 && ok.horseKpis >= 4 &&
    ok.bankers >= 1 && ok.multiCards >= 1 && ok.gateRedirect && errors.length === 0;
  console.log(pass ? '\n✓ ALL PAGES PASSED' : '\n✗ FAILED');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
