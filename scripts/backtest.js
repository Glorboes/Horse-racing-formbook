#!/usr/bin/env node
'use strict';

// backtest.js — walk-forward backtest over many past meetings.
//
// THE GOLDEN RULE: process meetings in DATE ORDER, predicting each one using
// ONLY the data from meetings before it, then logging that meeting's results
// before moving on. This is what makes the strike rate/calibration honest —
// the model never sees a race's future when predicting it (no look-ahead bias).
//
// Inputs:
//   data/backtest/cards/*.pdf      — one Computaform racecard PDF per meeting
//   data/backtest/results/*.txt    — Raceform results, filename starts YYYY-MM-DD
//                                    (e.g. 2026-07-05-turffontein.txt)
//
// Usage: node scripts/backtest.js [--fresh] [--push]
//   --fresh  reset the database to empty before running (recommended for a
//            clean from-scratch backtest)
//   --push   auto-push the final state

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { parseRacecard } = require('./lib/parse-racecard');
const fb = require('./lib/formbook');
const { syncDashboard } = require('./lib/sync-dashboard');
const { autoPush } = require('./lib/autopush');

const ROOT = fb.ROOT;
const CARDS = path.join(ROOT, 'data', 'backtest', 'cards');
const RESULTS = path.join(ROOT, 'data', 'backtest', 'results');

function resetDb() {
  const meta = { version: 2, updated: null, tracks: [], note: 'Backtest rebuild.' };
  fb.save({ meta, horses: {}, headToHead: {}, predictionsLog: [] });
  for (const dir of [path.join(ROOT, 'data', 'predictions'), path.join(ROOT, 'docs', 'data', 'predictions')]) {
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
  }
  console.log('• database reset to empty');
}

async function main() {
  const args = process.argv.slice(2);
  const fresh = args.includes('--fresh');
  const push = args.includes('--push');

  if (!fs.existsSync(CARDS)) { console.error(`Put racecard PDFs in ${path.relative(ROOT, CARDS)}/`); process.exit(1); }
  if (fresh) resetDb();

  // 1) parse every card to learn its date + track, so we can order them
  const cardFiles = fs.readdirSync(CARDS).filter((f) => /\.pdf$/i.test(f) && !/EXAMPLE/i.test(f));
  const meetings = [];
  for (const f of cardFiles) {
    try {
      const { races } = await parseRacecard(path.join(CARDS, f));
      if (races.length) meetings.push({ file: path.join(CARDS, f), date: races[0].date, track: races[0].track });
    } catch (e) { console.log(`• could not parse card ${f}: ${e.message}`); }
  }
  meetings.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!meetings.length) { console.error('No parseable cards found.'); process.exit(1); }

  // 2) index results files by their date prefix
  const resultsByDate = {};
  if (fs.existsSync(RESULTS)) {
    for (const f of fs.readdirSync(RESULTS)) {
      const m = f.match(/(\d{4}-\d{2}-\d{2})/);
      if (m && /\.(txt|csv)$/i.test(f)) resultsByDate[m[1]] = path.join(RESULTS, f);
    }
  }

  console.log(`\nWalk-forward over ${meetings.length} meeting(s), ${meetings[0].date} → ${meetings[meetings.length - 1].date}\n`);

  // 3) chronological loop: predict (prior data only) THEN log results
  let predicted = 0, logged = 0;
  for (const mt of meetings) {
    console.log(`── ${mt.date}  ${mt.track || '?'} ──`);
    run(`node ${q(path.join(ROOT, 'scripts', 'predict.js'))} ${q(mt.file)} --no-push`);
    predicted++;
    const rf = resultsByDate[mt.date];
    if (rf) {
      run(`node ${q(path.join(ROOT, 'scripts', 'import-results.js'))} ${q(rf)} --date ${mt.date} --track ${q(mt.track || 'Unknown')} --no-push`);
      logged++;
    } else {
      console.log('   (no results file for this date — prediction stands unsettled)');
    }
  }

  const book = fb.load();
  const sr = fb.strikeRate(book);
  syncDashboard();
  console.log(`\n════════ BACKTEST COMPLETE ════════`);
  console.log(`meetings predicted: ${predicted} | with results: ${logged}`);
  console.log(`walk-forward TOP-PICK strike rate: ${sr.winPct}% win / ${sr.placePct}% place over ${sr.settled} settled races (${sr.scratched} scratched)`);
  console.log('calibration by score tier:');
  for (const c of fb.calibration(book)) console.log(`  ${c.tier.padEnd(9)} ${c.n} races  ${c.winPct == null ? '—' : c.winPct + '% win'}`);

  if (push) autoPush(`backtest: ${predicted} meetings, ${sr.settled} settled`);
}

function q(s) { return JSON.stringify(s); }
function run(cmd) {
  try { execSync(cmd, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] }); }
  catch (e) { console.log(`   ! step failed: ${e.message.split('\n')[0]}`); }
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
