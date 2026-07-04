#!/usr/bin/env node
'use strict';

// log-result.js — the existing manual result workflow, preserved.
// Feed one result file (JSON) and it logs runs, updates head-to-head, settles
// the matching prediction, refreshes the dashboard, and auto-pushes.
//
// Usage: node scripts/log-result.js <result.json> [--no-push]
// result.json shape:
// {
//   "date":"2026-07-05","track":"Turffontein","race":5,"distance":1600,"going":"Good",
//   "finishers":[
//     {"name":"El Barb","finish":1,"marginLengths":0},
//     {"name":"Silver Host","finish":2,"marginLengths":1.5},
//     {"name":"Night Watch","finish":3,"marginLengths":0.75}
//   ]
// }

const fs = require('fs');
const path = require('path');
const fb = require('./lib/formbook');
const { syncDashboard } = require('./lib/sync-dashboard');
const { autoPush } = require('./lib/autopush');

function main() {
  const args = process.argv.slice(2);
  const noPush = args.includes('--no-push');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file || !fs.existsSync(file)) {
    console.error('Usage: node scripts/log-result.js <result.json> [--no-push]');
    process.exit(1);
  }
  const book = fb.load();
  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  const arr = Array.isArray(result) ? result : [result];

  let logged = 0, pairs = 0;
  for (const r of arr) {
    const out = fb.logResult(book, r);
    logged++; pairs += out.pairsAdded;
    console.log(`✓ logged ${r.track} R${r.race} (${r.date}) — +${out.pairsAdded} H2H pairs`);
  }
  fb.save(book);

  const sync = syncDashboard();
  console.log(`✓ ${logged} race(s), ${pairs} H2H records. Strike rate ${sync.strikeRate.winPct}% win / ${sync.strikeRate.placePct}% place.`);
  if (!noPush) autoPush(`log-result: ${arr.map((r) => `${r.track} R${r.race}`).join(', ')}`);
}

main();
