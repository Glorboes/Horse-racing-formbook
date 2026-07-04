'use strict';
// Headless UI smoke test: serve docs/, unlock the gate, assert all four
// required sections render. Not committed as a dependency-bearing test.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const DOCS = path.resolve(__dirname, '..', '..', 'docs');
const EXE = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const MIME = { '.html': 'text/html', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  if (p === '/') p = '/dashboard.html';
  const fp = path.join(DOCS, p);
  if (!fp.startsWith(DOCS) || !fs.existsSync(fp)) { res.writeHead(404); return res.end('nf'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'text/plain' });
  fs.createReadStream(fp).pipe(res);
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: EXE });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); // iPhone-ish
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/dashboard.html`);

  // gate visible, app hidden
  const gateShown = await page.isVisible('#gate');
  // wrong pass
  await page.fill('#pw', 'nope'); await page.click('button[type=submit]');
  await page.waitForTimeout(150);
  const errText = await page.textContent('#err');
  // correct pass
  await page.fill('#pw', 'Master0701!'); await page.click('button[type=submit]');
  await page.waitForSelector('.picker .rc', { timeout: 5000 });
  await page.waitForSelector('#race .card', { timeout: 5000 });

  const headings = await page.$$eval('section.card h2', (els) => els.map((e) => e.textContent.trim()));
  const topPick = await page.textContent('.pick.top .nm');
  const strongest = await page.textContent('.strong .nm');
  const chips = await page.$$eval('#srChips .chip', (e) => e.map((x) => x.textContent));
  await page.screenshot({ path: path.join(__dirname, '..', '..', 'docs', 'preview.png'), fullPage: true });

  console.log('gate shown initially:', gateShown);
  console.log('wrong-pass error   :', JSON.stringify(errText));
  console.log('section headings   :', headings);
  console.log('top pick           :', topPick);
  console.log('strongest (H2H)    :', strongest);
  console.log('strike chips       :', chips);
  console.log('page errors        :', errors);

  const need = ['Educated Guess', 'Comparison', 'Who Beat Who', 'Strike Rate'];
  const ok = need.every((n) => headings.some((h) => h.includes(n))) && errors.length === 0 && gateShown;
  await browser.close(); server.close();
  console.log(ok ? '\n✓ UI smoke test PASSED' : '\n✗ UI smoke test FAILED');
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
