#!/usr/bin/env node
'use strict';

// predict <racecard.pdf|.json|.txt> [--no-push]
// Outputs ranked picks with reasoning + comparison table + head-to-head
// strongest ranking, and writes data/predictions/<id>.json for the dashboard.

const fs = require('fs');
const path = require('path');
const fb = require('./lib/formbook');
const { parseRacecard } = require('./lib/parse-racecard');
const { scoreRace } = require('./lib/scoring');
const { syncDashboard } = require('./lib/sync-dashboard');
const { autoPush } = require('./lib/autopush');

async function main() {
  const args = process.argv.slice(2);
  const noPush = args.includes('--no-push');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('Usage: predict <racecard.pdf|.json|.txt> [--no-push]');
    process.exit(1);
  }
  if (!fs.existsSync(file)) { console.error(`File not found: ${file}`); process.exit(1); }

  const book = fb.load();
  const { races, review } = await parseRacecard(file);
  if (review) console.log(`ℹ parsed ${races.length} race(s); review copy at ${path.relative(process.cwd(), review)}\n`);
  if (!races.length) { console.error('No races parsed.'); process.exit(1); }

  fs.mkdirSync(path.join(fb.ROOT, 'data', 'predictions'), { recursive: true });
  const written = [];
  for (const race of races) written.push(processRace(book, race));
  fb.save(book);

  const sync = syncDashboard();
  const meta = races[0];
  console.log(`\n✓ wrote ${written.length} prediction(s) for ${meta.track || 'card'} ${meta.date}  |  dashboard synced (${sync.predictions} cards)`);

  if (!noPush) autoPush(`predict: ${meta.track || 'race'} — ${written.length} race(s) ${meta.date}`);
}

// Score one race, write its prediction JSON, log it for strike-rate tracking.
function processRace(book, race) {
  const { ranked, h2h } = scoreRace(book, race);
  const id = fb.makePredId(race.date, race.track || 'unknown', race.race);

  const comparison = ranked.map((r) => {
    const known = book.horses[r.key] || { runs: [] };
    const last = (known.runs || []).slice(-5).reverse().map((x) => x.finish).join('');
    return {
      no: race.runners.find((x) => x.name.trim() === r.name)?.no ?? null,
      name: r.name, rank: r.rank, score: r.score,
      rating: r.rating, draw: r.draw, weight: r.weight,
      odds: r.odds, marketRank: r.marketRank ?? null, marketDisagree: !!r.marketDisagree,
      jockey: r.jockey, trainer: r.trainer,
      lastFive: last || '—', runsKnown: r.knownRuns, factors: r.factors,
    };
  });

  const prediction = {
    id, date: race.date, track: race.track, race: race.race, time: race.time || null,
    distance: race.distance, going: race.going, surface: race.surface || null,
    classLabel: race.classLabel || null,
    generated: new Date().toISOString(), settled: false,
    marketPriced: ranked.some((r) => r.marketRank != null),
    ranked, comparison, headToHead: h2h, strongest: h2h[0] ? h2h[0].name : null,
  };

  fs.writeFileSync(path.join(fb.ROOT, 'data', 'predictions', `${id}.json`), JSON.stringify(prediction, null, 2) + '\n');

  const existing = book.predictionsLog.find((p) => p.id === id);
  const logEntry = { id, date: race.date, track: race.track, race: race.race, settled: false,
    ranked: ranked.slice(0, 4).map((r) => ({ name: r.name, score: r.score })) };
  if (existing) Object.assign(existing, logEntry);
  else book.predictionsLog.push(logEntry);

  printReport(prediction);
  return id;
}

function printReport(p) {
  const line = '─'.repeat(64);
  console.log(`\n${line}\n  ${p.track || 'Unknown'}  •  Race ${p.race}  •  ${p.distance || '?'}m  •  ${p.going || 'going n/a'}  •  ${p.date}\n${line}`);
  console.log('\n  RANKED PICKS');
  p.ranked.forEach((r) => {
    const tag = r.rank === 1 ? '★' : ` ${r.rank}`;
    console.log(`  ${tag}  ${r.name.padEnd(22)} ${String(r.score).padStart(5)}  ${r.h2h && (r.h2h.wins||r.h2h.losses) ? `(H2H ${r.h2h.record})` : ''}`);
    r.reasoning.forEach((n) => console.log(`        · ${n}`));
  });
  console.log('\n  STRONGEST BY HEAD-TO-HEAD (this field)');
  p.headToHead.forEach((t, i) => {
    if (t.meetings === 0 && i > 0) return;
    console.log(`   ${i === 0 ? '➤' : ' '} ${t.name.padEnd(22)} ${t.record.padStart(5)}  pts ${t.points}${t.beats.length ? '  beat: ' + [...new Set(t.beats)].join(', ') : ''}`);
  });
  console.log('');
}

main().catch((e) => { console.error('✗', e.message); process.exit(1); });
