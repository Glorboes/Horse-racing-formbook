'use strict';

const fs = require('fs');
const path = require('path');
const { load, strikeRate } = require('./formbook');

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

  fs.writeFileSync(path.join(DOCS_DATA, 'manifest.json'),
    JSON.stringify({ generated: new Date().toISOString(), count: entries.length, predictions: entries }, null, 2) + '\n');
  fs.writeFileSync(path.join(DOCS_DATA, 'strike-rate.json'), JSON.stringify(sr, null, 2) + '\n');

  return { predictions: entries.length, strikeRate: sr };
}

if (require.main === module) {
  const r = syncDashboard();
  console.log(`✓ synced ${r.predictions} prediction(s) to docs/data`);
}

module.exports = { syncDashboard };
