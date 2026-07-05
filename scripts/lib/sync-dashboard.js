'use strict';

const fs = require('fs');
const path = require('path');
const { load, strikeRate } = require('./formbook');
const { normalizeName } = require('./names');

const ROOT = path.resolve(__dirname, '..', '..');
const PRED_SRC = path.join(ROOT, 'data', 'predictions');
const DOCS_DATA = path.join(ROOT, 'docs', 'data');

// GitHub Pages can only serve files under docs/, so the dashboard reads its
// data from docs/data/. This copies predictions there and builds:
//   docs/data/manifest.json  -> index the dashboard fetches on load
//   docs/data/strike-rate.json
// Called after every predict / pull-results run.
function syncDashboard() {
  fs.mkdirSync(path.join(DOCS_DATA, 'predictions'), { recursive: true });

  const files = fs.existsSync(PRED_SRC)
    ? fs.readdirSync(PRED_SRC).filter((f) => f.endsWith('.json'))
    : [];

  const entries = [];
  for (const f of files) {
    const src = path.join(PRED_SRC, f);
    const dst = path.join(DOCS_DATA, 'predictions', f);
    fs.copyFileSync(src, dst);
    try {
      const p = JSON.parse(fs.readFileSync(src, 'utf8'));
      entries.push({
        file: `data/predictions/${f}`,
        id: p.id, date: p.date, track: p.track, race: p.race,
        distance: p.distance, going: p.going,
        runners: (p.ranked || []).length,
        topPick: p.ranked && p.ranked[0] ? p.ranked[0].name : null,
        settled: !!p.settled,
      });
    } catch { /* skip malformed */ }
  }
  entries.sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.race || 0) - (a.race || 0));

  const fb = load();
  const sr = strikeRate(fb);
  const horses = buildHorses(fb);

  fs.writeFileSync(path.join(DOCS_DATA, 'manifest.json'),
    JSON.stringify({ generated: new Date().toISOString(), count: entries.length, predictions: entries }, null, 2) + '\n');
  fs.writeFileSync(path.join(DOCS_DATA, 'strike-rate.json'), JSON.stringify(sr, null, 2) + '\n');
  fs.writeFileSync(path.join(DOCS_DATA, 'horses.json'),
    JSON.stringify({ generated: new Date().toISOString(), count: horses.length, horses }, null, 2) + '\n');

  return { predictions: entries.length, horses: horses.length, strikeRate: sr };
}

// Flatten the formbook into a browsable horse database + per-horse H2H summary.
function buildHorses(fb) {
  const nameByKey = Object.fromEntries(Object.entries(fb.horses).map(([k, h]) => [k, h.name]));

  // aggregate head-to-head wins/losses per horse across all pairs
  const h2hAgg = {}; // key -> { beats:Set, losesTo:Set, wins, losses }
  const bump = (k) => (h2hAgg[k] = h2hAgg[k] || { beats: new Set(), losesTo: new Set(), wins: 0, losses: 0 });
  for (const [pair, meetings] of Object.entries(fb.headToHead || {})) {
    const [a, b] = pair.split('|');
    for (const m of meetings) {
      const wk = normalizeName(m.winner);
      const lk = wk === a ? b : a;
      bump(wk).wins++; bump(wk).beats.add(nameByKey[lk] || lk);
      bump(lk).losses++; bump(lk).losesTo.add(nameByKey[wk] || wk);
    }
  }

  return Object.entries(fb.horses).map(([key, h]) => {
    const runs = h.runs || [];
    const starts = runs.length;
    const wins = runs.filter((r) => r.finish === 1).length;
    const places = runs.filter((r) => r.finish <= 3).length;
    const lastFive = [...runs].sort((a, b) => (b.date || '').localeCompare(a.date || ''))
      .slice(0, 5).map((r) => (r.finish > 9 ? '0' : r.finish)).join('');
    const agg = h2hAgg[key] || { beats: new Set(), losesTo: new Set(), wins: 0, losses: 0 };
    return {
      key, name: h.name, rating: h.rating ?? null,
      starts, wins, places,
      winPct: starts ? +((wins / starts) * 100).toFixed(0) : 0,
      placePct: starts ? +((places / starts) * 100).toFixed(0) : 0,
      lastFive: lastFive || '—',
      tracks: [...new Set(runs.map((r) => r.track).filter(Boolean))],
      runs,
      h2h: { wins: agg.wins, losses: agg.losses, beats: [...agg.beats], losesTo: [...agg.losesTo] },
    };
  }).sort((a, b) => b.starts - a.starts || a.name.localeCompare(b.name));
}

if (require.main === module) {
  const r = syncDashboard();
  console.log(`✓ synced ${r.predictions} prediction(s) to docs/data`);
}

module.exports = { syncDashboard };
