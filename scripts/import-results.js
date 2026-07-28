#!/usr/bin/env node
'use strict';

// import-results.js — paste a Raceform/results block into a .txt and log it.
// Turns the tab/space-separated results table into logged outcomes: updates
// form, head-to-head, jockey combos, settles matching predictions, refreshes
// the dashboard, and auto-pushes.
//
// Usage: node scripts/import-results.js <results.txt> --date 2026-07-05 --track Turffontein [--no-push]
//
// Expected block per race (columns tab- or space-separated):
//   Race <n> <name>
//    <time> <dist>m R<stake> ...
//   <AR> <finish> <LBH> <no> <Horse> <age col sex> (<draw>) <mass> <jockey> <odds> ...

const fs = require('fs');
const path = require('path');
const fb = require('./lib/formbook');
const { classify } = require('./lib/parse-racecard');
const { normalizeName } = require('./lib/names');
const { scoreRace } = require('./lib/scoring');
const { annotatePrediction } = require('./lib/multibet');
const { parseMeeting: parseFormgrids } = require('./lib/parse-formgrids');
const { syncDashboard } = require('./lib/sync-dashboard');
const { autoPush } = require('./lib/autopush');

const COLOR = 'b|ch|gr|br|bl|ro|dk|wh|gy|bay';
const SEX = 'c|f|g|h|m|r';

function parse(text, date, track) {
  const lines = text.split(/\r?\n/);
  const races = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/ /g, ' ');
    const rh = line.match(/^Race\s+(\d+)\s+(.*)$/i);
    if (rh) {
      if (cur) races.push(cur);
      const nameLine = rh[2].trim();
      // distance is usually on the next line
      const next = (lines[i + 1] || '');
      const dist = (line.match(/(\d{3,4})m/) || next.match(/(\d{3,4})m/) || [])[1];
      const cls = classify(nameLine);
      cur = { date, track, race: +rh[1], distance: dist ? +dist : null,
        classLabel: cls.label || nameLine, classType: cls.type, classRank: cls.rank,
        going: null, _rows: [] };
      continue;
    }
    // runner row
    const m = line.match(new RegExp(
      `^\\s*(\\d+)\\s+(\\d+)\\s+([\\d.]+)\\s+(\\d+)\\s+(.+?)\\s+\\((\\d+)\\)\\s+([\\d.]+)\\s+(.+?)\\s+(\\d+\\/\\d+)\\b`));
    if (m && cur) {
      let name = m[5].replace(new RegExp(`\\s+\\d+\\s+(?:${COLOR})\\s+(?:${SEX})$`, 'i'), '').trim();
      cur._rows.push({
        finish: +m[2], lbh: parseFloat(m[3]), no: +m[4], name,
        draw: +m[6], weight: parseFloat(m[7]), jockey: m[8].trim(), odds: m[9],
      });
    }
  }
  if (cur) races.push(cur);

  // convert cumulative LBH -> per-gap marginLengths (capped)
  return races.filter((r) => r._rows.length).map((r) => {
    const rows = r._rows.sort((a, b) => a.finish - b.finish);
    const finishers = rows.map((row, i) => {
      const prev = i > 0 ? rows[i - 1].lbh : 0;
      let gap = row.finish === 1 ? 0 : Math.max(0, row.lbh - prev);
      if (!isFinite(gap) || gap > 25) gap = 25; // sentinel/blowout cap
      return { name: row.name, finish: row.finish, marginLengths: +gap.toFixed(2),
        jockey: row.jockey, weight: row.weight, draw: row.draw };
    });
    const { _rows, ...meta } = r;
    return { ...meta, finishers };
  });
}

// ---------------------------------------------------------------------------
// Computaform results grid (tab-separated):
//   id  no  Horse  ACS  SH  Trainer  Jockey  Wgt  MR  Dr  OB  SP  FP  Len  ...
// Richer than Raceform — includes trainer + finishing lengths. Races are split
// where FP (finishing position) resets to 1; race number/track/distance are
// recovered by matching the field to that day's predictions.
// ---------------------------------------------------------------------------
function looksComputaform(text) {
  return /\bS\.800\b/i.test(text) || /\bFP\b[\t ]+Len\b/i.test(text) || /\t\d(?:b|ch|gr|br|bl|ro)[FGCHM]\t/i.test(text);
}
function cleanJockey(s) {
  return String(s || '')
    .replace(/^[#*+\s]+/, '')
    .replace(/[-+]\s*\d+(?:\.\d+)?\s*kg/gi, '')
    .replace(/\s+[-+]\d+(?:\.\d+)?\b/g, '')
    .replace(/\s+/g, ' ').trim();
}
// Fractional odds ("5-2", "7/10", "72-100") -> decimal incl. stake (a/b + 1).
function fractionToDecimal(s) {
  const m = String(s || '').trim().match(/^(\d+(?:\.\d+)?)\s*[-/]\s*(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const a = parseFloat(m[1]), b = parseFloat(m[2]);
  if (!(b > 0)) return null;
  return +(a / b + 1).toFixed(3);
}
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function buildPredIndex(date) {
  const dir = path.join(fb.ROOT, 'data', 'predictions');
  if (!fs.existsSync(dir)) return [];
  const idx = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    let p; try { p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
    if (p.date !== date) continue;
    idx.push({ race: p.race, track: p.track, distance: p.distance, going: p.going, classLabel: p.classLabel,
      names: new Set((p.ranked || []).map((r) => normalizeName(r.name))) });
  }
  return idx;
}
function matchRace(finishers, index) {
  let best = null, score = 0;
  for (const cand of index) {
    const overlap = finishers.reduce((n, f) => n + (cand.names.has(normalizeName(f.name)) ? 1 : 0), 0);
    if (overlap > score) { score = overlap; best = cand; }
  }
  return score >= 2 ? best : null;
}
function parseComputaform(text, date, fallbackTrack, index) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    if (/\bHorse\b/i.test(raw) && /\bJockey\b/i.test(raw)) continue; // header
    let c = raw.split('\t');
    if (c.length < 14) c = raw.split(/\t| {2,}/); // space fallback
    if (c.length < 14) continue;
    const horse = (c[2] || '').trim();
    const fp = parseInt(c[13], 10);
    const len = parseFloat(c[14]);
    if (!horse || !Number.isFinite(fp)) continue;
    const mr = parseInt(c[9], 10);
    const sp = (c[12] || '').trim();               // starting price (closing market)
    rows.push({ horse, fp, len: Number.isFinite(len) ? len : 0,
      jockey: cleanJockey(c[7]), trainer: (c[6] || '').trim(),
      weight: parseFloat(c[8]) || null, draw: parseInt(c[10], 10) || null,
      rating: Number.isFinite(mr) && mr > 0 ? mr : null,
      sp: sp || null, oddsDecimal: fractionToDecimal(sp),
      time: num(c[15]), s800: num(c[16]), s400: num(c[17]), sDist: num(c[18]) });
  }
  const blocks = []; let cur = null;
  for (const r of rows) { if (r.fp === 1) { if (cur) blocks.push(cur); cur = []; } if (cur) cur.push(r); }
  if (cur) blocks.push(cur);

  return blocks.map((b, i) => {
    b.sort((x, y) => x.fp - y.fp);
    const finishers = b.map((row, j) => {
      const prev = j > 0 ? b[j - 1].len : 0;
      let gap = row.fp === 1 ? 0 : Math.max(0, (row.len || 0) - (prev || 0));
      if (!isFinite(gap) || gap > 25) gap = 25;
      return { name: row.horse, finish: row.fp, marginLengths: +gap.toFixed(2),
        jockey: row.jockey, trainer: row.trainer, weight: row.weight, draw: row.draw, rating: row.rating,
        sp: row.sp, oddsDecimal: row.oddsDecimal,
        time: row.time, s800: row.s800, s400: row.s400, sDist: row.sDist };
    });
    const m = matchRace(finishers, index);
    return { date, track: m ? m.track : fallbackTrack, race: m ? m.race : (i + 1),
      distance: m ? m.distance : null, going: m ? m.going : null, classLabel: m ? m.classLabel : null, finishers };
  });
}

// ---------------------------------------------------------------------------
// Backfill prediction: for an OLD race with no live prediction, reconstruct one
// from the result grid's pre-race columns (ratings, weights, draws, jockeys) so
// it can be graded and counts toward strike rate / calibration / CLV / the 200.
// Two honesty guards:
//   - "as-of" book view: only runs and head-to-heads dated STRICTLY BEFORE the
//     race are visible, so pasting meetings out of order can't leak the future.
//   - no odds fed in: the prediction is pure-model, so the CLV test (model vs
//     the actual SP) stays a real comparison rather than a circular one.
// ---------------------------------------------------------------------------
function backfillPredict(book, race) {
  const runners = race.finishers.map((f) => ({
    name: f.name, no: null, rating: f.rating ?? null, weight: f.weight ?? null,
    draw: f.draw ?? null, jockey: f.jockey ?? null, trainer: f.trainer ?? null,
  }));
  const card = {
    date: race.date, track: race.track, race: race.race,
    distance: race.distance ?? null, going: race.going ?? null, classLabel: race.classLabel ?? null,
    runners,
  };
  const asOf = fb.bookAsOf(book, race.date);
  const { ranked, h2h } = scoreRace(asOf, card);
  const id = fb.makePredId(race.date, race.track || 'unknown', race.race);
  const comparison = ranked.map((r) => {
    const known = asOf.horses[r.key] || { runs: [] };
    const last = (known.runs || []).slice(-5).reverse().map((x) => x.finish).join('');
    return {
      no: null, name: r.name, rank: r.rank, score: r.score, rating: r.rating, draw: r.draw,
      weight: r.weight, odds: null, marketRank: null, marketDisagree: false,
      jockey: r.jockey, trainer: r.trainer, lastFive: last || '—', runsKnown: r.knownRuns, factors: r.factors,
    };
  });
  const prediction = {
    id, date: race.date, track: race.track, race: race.race, time: null,
    distance: race.distance ?? null, going: race.going ?? null, surface: null,
    classLabel: race.classLabel ?? null, generated: new Date().toISOString(), settled: false,
    marketPriced: false, backfilled: true,
    ranked, comparison, headToHead: h2h, strongest: h2h[0] ? h2h[0].name : null,
  };
  annotatePrediction(prediction); // pWin = pure model (no market fed in)
  fs.mkdirSync(path.join(fb.ROOT, 'data', 'predictions'), { recursive: true });
  fs.writeFileSync(path.join(fb.ROOT, 'data', 'predictions', `${id}.json`), JSON.stringify(prediction, null, 2) + '\n');
  const logEntry = { id, date: race.date, track: race.track, race: race.race, settled: false,
    ranked: ranked.slice(0, 4).map((r) => ({ name: r.name, score: r.score })) };
  const existing = book.predictionsLog.find((p) => p.id === id);
  if (existing) Object.assign(existing, logEntry); else book.predictionsLog.push(logEntry);
  return id;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const noPush = args.includes('--no-push');
  const noBackfill = args.includes('--no-backfill');
  const file = args.find((a) => !a.startsWith('--') && !/^\d{4}-\d\d-\d\d$/.test(a));
  const date = opt('--date', new Date().toISOString().slice(0, 10));
  const track = opt('--track', 'Turffontein');
  if (!file || !fs.existsSync(file)) { console.error('Usage: import-results.js <results.txt> --date YYYY-MM-DD --track <Track> [--no-push]'); process.exit(1); }

  const text = fs.readFileSync(file, 'utf8');
  const looksFormgrids = /Add horse to watchlist/i.test(text) || /Previous Races\s+#\s+Horse/i.test(text);
  const races = looksFormgrids
    ? parseFormgrids(text).map((r) => ({ date, track, race: r.race, distance: null, going: null, classLabel: null, finishers: r.finishers }))
    : looksComputaform(text)
      ? parseComputaform(text, date, track, buildPredIndex(date))
      : parse(text, date, track);
  if (!races.length) { console.error('No races parsed — check the results format.'); process.exit(1); }

  const book = fb.load();
  let logged = 0, pairs = 0, settled = 0, backfilled = 0;
  for (const r of races) {
    const id = fb.makePredId(r.date, r.track, r.race);
    const predPath = path.join(fb.ROOT, 'data', 'predictions', `${id}.json`);
    // No live prediction for this race? Reconstruct one (walk-forward) before grading.
    let didBackfill = false;
    if (!noBackfill && !fs.existsSync(predPath) && r.finishers.length >= 4) {
      backfillPredict(book, r); didBackfill = true; backfilled++;
    }
    const out = fb.logResult(book, r);
    logged++; pairs += out.pairsAdded;
    const lg = book.predictionsLog.find((p) => p.id === id);
    const s = lg && lg.settled ? lg.result : null;
    if (s) settled++;
    const verdict = s ? (s.topPickScratched ? '⊘ scratched (void)' : s.topPickWon ? '✓ WON' : s.topPickPlaced ? '~ placed' : '✗ missed') : '(no prediction)';
    console.log(`  ${didBackfill ? '↺' : ' '} R${r.race} ${r.classLabel || ''} — winner ${r.finishers[0].name}  | pick ${s ? s.topPick : '?'} ${verdict}`);
  }
  fb.save(book);

  const sync = syncDashboard();
  console.log(`\n✓ ${logged} races logged, ${pairs} head-to-head records, ${settled} predictions settled${backfilled ? ` (${backfilled} backfilled)` : ''}.`);
  console.log(`✓ strike rate now ${sync.strikeRate.winPct}% win / ${sync.strikeRate.placePct}% place over ${sync.strikeRate.settled} settled.`);
  const rd = sync.strikeRate.readiness;
  if (rd) console.log(`${rd.green ? '🟢 BETTING GREEN LIGHT' : '🔴 not bet-ready'} — ${rd.passed}/${rd.total} signals · ${rd.n}/${rd.target} priced races${rd.overallRoi != null ? ` · ROI ${rd.overallRoi > 0 ? '+' : ''}${rd.overallRoi}% at SP` : ''}`);
  if (!noPush) autoPush(`import-results: ${track} ${date} (${logged} races)`);
}

main();
