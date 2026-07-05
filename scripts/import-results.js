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

function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const noPush = args.includes('--no-push');
  const file = args.find((a) => !a.startsWith('--') && !/^\d{4}-\d\d-\d\d$/.test(a));
  const date = opt('--date', new Date().toISOString().slice(0, 10));
  const track = opt('--track', 'Turffontein');
  if (!file || !fs.existsSync(file)) { console.error('Usage: import-results.js <results.txt> --date YYYY-MM-DD --track <Track> [--no-push]'); process.exit(1); }

  const races = parse(fs.readFileSync(file, 'utf8'), date, track);
  if (!races.length) { console.error('No races parsed — check the results format.'); process.exit(1); }

  const book = fb.load();
  let logged = 0, pairs = 0, settled = 0;
  for (const r of races) {
    const out = fb.logResult(book, r);
    logged++; pairs += out.pairsAdded;
    const lg = book.predictionsLog.find((p) => p.id === fb.makePredId(r.date, r.track, r.race));
    const s = lg && lg.settled ? lg.result : null;
    if (s) settled++;
    const verdict = s ? (s.topPickScratched ? '⊘ scratched (void)' : s.topPickWon ? '✓ WON' : s.topPickPlaced ? '~ placed' : '✗ missed') : '(no prediction)';
    console.log(`  R${r.race} ${r.classLabel || ''} — winner ${r.finishers[0].name}  | pick ${s ? s.topPick : '?'} ${verdict}`);
  }
  fb.save(book);

  const sync = syncDashboard();
  console.log(`\n✓ ${logged} races logged, ${pairs} head-to-head records, ${settled} predictions settled.`);
  console.log(`✓ strike rate now ${sync.strikeRate.winPct}% win / ${sync.strikeRate.placePct}% place over ${sync.strikeRate.settled} settled.`);
  if (!noPush) autoPush(`import-results: ${track} ${date} (${logged} races)`);
}

main();
