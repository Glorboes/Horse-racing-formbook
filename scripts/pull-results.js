#!/usr/bin/env node
'use strict';

// pull-results.js
// Pull SA race results, match them to pending predictions, auto-log outcomes,
// update head-to-head, refresh the dashboard, and auto-push.
//
// SOURCES
//   1. Live scrape of Gold Circle (goldcircle.co.za) + 4Racing (4racing.co.za).
//      Both sit behind Cloudflare; selectors live in ADAPTERS below and will
//      likely need one-time tuning against the real pages. Run with --debug to
//      dump what was fetched.
//   2. Local inbox: any *.json in data/results-inbox/ (see EXAMPLE there).
//      This path always works and is how you feed results if the live scrape
//      is blocked. Files are consumed (moved to data/results-inbox/processed/).
//
// Unmatched / renamed horses are written to data/review/unmatched-<date>.json
// instead of failing silently.
//
// Usage: node scripts/pull-results.js [--date YYYY-MM-DD] [--source live|inbox|all] [--debug] [--no-push]

const fs = require('fs');
const path = require('path');
const fb = require('./lib/formbook');
const { normalizeName, bestMatch } = require('./lib/names');
const { syncDashboard } = require('./lib/sync-dashboard');
const { autoPush } = require('./lib/autopush');

const ROOT = fb.ROOT;
const INBOX = path.join(ROOT, 'data', 'results-inbox');
const REVIEW = path.join(ROOT, 'data', 'review');

const SA_TRACKS = ['Turffontein', 'Vaal', 'Fairview', 'Scottsville', 'Greyville'];

// --------------------------------------------------------------------------
// Scrape adapters. Isolated so you can tune selectors without touching logic.
// Each adapter returns an array of normalized results:
//   { date, track, race, distance, going, finishers:[{name,finish,marginLengths,jockey}] }
// --------------------------------------------------------------------------
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-ZA,en;q=0.9',
};

const ADAPTERS = {
  goldcircle: {
    // Gold Circle covers KZN/Cape (Greyville, Scottsville, Fairview, etc.)
    resultsUrl: (date) => `https://www.goldcircle.co.za/results?date=${date}`,
    parse: (html, date, debug) => parseGeneric(html, date, debug, {
      // TUNE THESE against the live page (View Source):
      raceBlock: /<(?:div|section)[^>]*class="[^"]*race[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/gi,
      runnerRow: /<tr[^>]*>([\s\S]*?)<\/tr>/gi,
    }),
  },
  fourracing: {
    // 4Racing covers Gauteng/EC (Turffontein, Vaal, Fairview Polytrack)
    resultsUrl: (date) => `https://www.4racing.co.za/results?date=${date}`,
    parse: (html, date, debug) => parseGeneric(html, date, debug, {
      raceBlock: /<(?:div|section)[^>]*class="[^"]*race[^"]*"[^>]*>([\s\S]*?)<\/(?:div|section)>/gi,
      runnerRow: /<tr[^>]*>([\s\S]*?)<\/tr>/gi,
    }),
  },
};

// Get page HTML either via plain fetch or a real headless browser.
// Cloudflare usually blocks plain fetch from datacenters; the browser path
// (Playwright) has a much better chance. Enable with --browser (needs the
// optional "playwright" dep + a chromium install, which the GitHub Action sets up).
let _browser = null;
async function getHtml(url, useBrowser) {
  if (!useBrowser) {
    const res = await fetch(url, { headers: BROWSER_HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.text();
  }
  let pw;
  try { pw = require('playwright'); }
  catch { throw new Error('playwright not installed (run: npm i playwright && npx playwright install chromium)'); }
  if (!_browser) _browser = await pw.chromium.launch();
  const ctx = await _browser.newContext({ userAgent: BROWSER_HEADERS['User-Agent'] });
  const page = await ctx.newPage();
  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await page.waitForTimeout(2500); // let Cloudflare JS challenge settle
    return await page.content();
  } finally { await ctx.close(); }
}

async function scrape(source, date, debug, useBrowser) {
  const out = [];
  const adapter = ADAPTERS[source];
  const url = adapter.resultsUrl(date);
  try {
    const html = await getHtml(url, useBrowser);
    if (debug) fs.writeFileSync(path.join(REVIEW, `${source}-${date}.html`), html);
    const parsed = adapter.parse(html, date, debug);
    out.push(...parsed);
    console.log(`• ${source} ${date}: parsed ${parsed.length} race(s)${useBrowser ? ' [browser]' : ''}`);
  } catch (e) {
    console.log(`• ${source} ${date}: fetch failed (${e.message})${useBrowser ? '' : ' — try --browser, or use the inbox path'}`);
  }
  return out;
}

function dateRange(endDate, days) {
  const out = [];
  const end = new Date(endDate);
  for (let i = 0; i < days; i++) {
    const d = new Date(end);
    d.setDate(end.getDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Very defensive generic HTML parser. Real selectors WILL differ; this is a
// scaffold that fails soft (returns []) rather than throwing.
function parseGeneric(html, date, debug, sel) {
  const races = [];
  const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  let block;
  const re = new RegExp(sel.raceBlock.source, sel.raceBlock.flags);
  while ((block = re.exec(html))) {
    const chunk = block[1];
    const track = SA_TRACKS.find((t) => new RegExp(t, 'i').test(chunk));
    const raceNo = Number((chunk.match(/Race\s+(\d{1,2})/i) || [])[1]) || null;
    const distance = Number((chunk.match(/(\d{3,4})\s?m/i) || [])[1]) || null;
    const finishers = [];
    let row; const rre = new RegExp(sel.runnerRow.source, sel.runnerRow.flags);
    while ((row = rre.exec(chunk))) {
      const cells = (row[1].match(/<td[^>]*>([\s\S]*?)<\/td>/gi) || []).map(stripTags);
      if (cells.length < 2) continue;
      const finish = Number(cells[0]);
      const name = (cells.find((c) => /[A-Za-z]{3,}/.test(c)) || '').replace(/\(\d+\)/, '').trim();
      if (finish >= 1 && name) finishers.push({ name, finish, marginLengths: 0 });
    }
    if (track && finishers.length >= 2) races.push({ date, track, race: raceNo || 1, distance, going: null, finishers });
  }
  return races;
}

// --------------------------------------------------------------------------
// Inbox: hand-fed results (always works). data/results-inbox/*.json
// --------------------------------------------------------------------------
function readInbox() {
  fs.mkdirSync(INBOX, { recursive: true });
  const files = fs.readdirSync(INBOX).filter((f) => f.endsWith('.json'));
  const results = [];
  for (const f of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(INBOX, f), 'utf8'));
      const arr = Array.isArray(data) ? data : [data];
      arr.forEach((r) => results.push({ ...r, _file: f }));
    } catch (e) { console.log(`• skipped malformed inbox file ${f}: ${e.message}`); }
  }
  return { results, files };
}

function archiveInbox(files) {
  if (!files.length) return;
  const done = path.join(INBOX, 'processed');
  fs.mkdirSync(done, { recursive: true });
  for (const f of files) {
    try { fs.renameSync(path.join(INBOX, f), path.join(done, `${Date.now()}-${f}`)); } catch {}
  }
}

// --------------------------------------------------------------------------
// Matching: reconcile scraped/inbox horse names to the formbook + pending
// predictions. Log anything we cannot confidently match.
// --------------------------------------------------------------------------
function reconcile(book, result, review) {
  const knownKeys = Object.keys(book.horses);
  const pendingKeys = new Set();
  book.predictionsLog.filter((p) => !p.settled).forEach((p) => (p.ranked || []).forEach((r) => pendingKeys.add(normalizeName(r.name))));
  const candidateKeys = [...new Set([...knownKeys, ...pendingKeys])];

  result.finishers = result.finishers.map((f) => {
    const exact = normalizeName(f.name);
    if (candidateKeys.includes(exact) || book.horses[exact]) return { ...f, name: f.name };
    const m = bestMatch(f.name, candidateKeys, 0.85);
    if (m && m.score < 1) {
      review.push({ type: 'possible-rename', scraped: f.name, matchedTo: book.horses[m.key]?.name || m.key, score: +m.score.toFixed(2), race: `${result.track} R${result.race} ${result.date}` });
      return { ...f, name: book.horses[m.key]?.name || f.name };
    }
    if (!m) review.push({ type: 'unmatched', scraped: f.name, race: `${result.track} R${result.race} ${result.date}`, note: 'new horse — logged as-is' });
    return { ...f, name: f.name };
  });
  return result;
}

// --------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const date = opt('--date', new Date().toISOString().slice(0, 10));
  const source = opt('--source', 'all');
  const days = Math.max(1, parseInt(opt('--days', '1'), 10) || 1); // --days 180 = ~6-month backfill
  const useBrowser = args.includes('--browser');
  const debug = args.includes('--debug');
  const noPush = args.includes('--no-push');

  fs.mkdirSync(REVIEW, { recursive: true });
  const book = fb.load();
  const review = [];
  let results = [];

  if (source === 'live' || source === 'all') {
    const dates = dateRange(date, days);
    if (days > 1) console.log(`Backfilling ${days} day(s): ${dates[dates.length - 1]} → ${dates[0]}`);
    for (const d of dates) {
      results.push(...await scrape('goldcircle', d, debug, useBrowser));
      results.push(...await scrape('fourracing', d, debug, useBrowser));
    }
    if (_browser) await _browser.close();
  }
  let inboxFiles = [];
  if (source === 'inbox' || source === 'all') {
    const inbox = readInbox();
    results.push(...inbox.results);
    inboxFiles = inbox.files;
  }

  if (!results.length) {
    console.log('\nNo results found.');
    console.log('  • Live sites are Cloudflare-protected and may block automated fetches.');
    console.log('  • Drop a results file into data/results-inbox/ (see EXAMPLE.json) and re-run.');
    if (review.length) writeReview(date, review);
    return;
  }

  let logged = 0, pairs = 0;
  for (const raw of results) {
    if (!raw.finishers || raw.finishers.length < 2) continue;
    const result = reconcile(book, raw, review);
    const r = fb.logResult(book, result);
    logged++;
    pairs += r.pairsAdded;
    console.log(`  ✓ logged ${result.track} R${result.race} (${result.date}) — ${r.finishers} runners, +${r.pairsAdded} H2H pairs`);
  }

  fb.save(book);
  if (review.length) writeReview(date, review);
  archiveInbox(inboxFiles.filter((f) => results.some((r) => r._file === f)));

  const sync = syncDashboard();
  console.log(`\n✓ ${logged} race(s) logged, ${pairs} head-to-head records added.`);
  console.log(`✓ dashboard synced (${sync.predictions} cards, strike rate ${sync.strikeRate.winPct}% win / ${sync.strikeRate.placePct}% place)`);
  if (review.length) console.log(`⚠ ${review.length} name(s) need review -> data/review/unmatched-${date}.json`);

  if (!noPush) autoPush(`pull-results: ${logged} race(s) ${date}`);
}

function writeReview(date, review) {
  fs.mkdirSync(REVIEW, { recursive: true });
  fs.writeFileSync(path.join(REVIEW, `unmatched-${date}.json`), JSON.stringify(review, null, 2) + '\n');
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
