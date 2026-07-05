'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeName, pairKey } = require('./names');

const ROOT = path.resolve(__dirname, '..', '..');
const FORMBOOK_PATH = path.join(ROOT, 'data', 'formbook.json');

function load(p = FORMBOOK_PATH) {
  if (!fs.existsSync(p)) {
    return { meta: { version: 2, updated: null, tracks: [] }, horses: {}, headToHead: {}, predictionsLog: [] };
  }
  const fb = JSON.parse(fs.readFileSync(p, 'utf8'));
  fb.horses = fb.horses || {};
  fb.headToHead = fb.headToHead || {};
  fb.predictionsLog = fb.predictionsLog || [];
  fb.meta = fb.meta || { version: 2, tracks: [] };
  return fb;
}

function save(fb, p = FORMBOOK_PATH) {
  fb.meta = fb.meta || {};
  fb.meta.updated = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(fb, null, 2) + '\n');
  return p;
}

function ensureHorse(fb, name) {
  const key = normalizeName(name);
  if (!fb.horses[key]) {
    fb.horses[key] = { name: name.trim(), rating: null, runs: [] };
  }
  return key;
}

// ---------------------------------------------------------------------------
// Result logging + head-to-head auto-population
// ---------------------------------------------------------------------------

// A result: {
//   date, track, race, distance, going,
//   finishers: [ { name, finish, marginLengths, weight, jockey, trainer, draw } ]
// }
// marginLengths on each finisher = lengths behind the horse in front (0 for winner).
// We derive cumulative margins to compute pairwise beaten-by distances.
function logResult(fb, result) {
  const { date, track, race, distance, going } = result;
  const classLabel = result.classLabel ?? result.class ?? null;
  const classType = result.classType ?? null;
  const classRank = result.classRank ?? null;
  const finishers = [...result.finishers].sort((a, b) => a.finish - b.finish);

  // cumulative lengths behind winner
  let cum = 0;
  const enriched = finishers.map((f) => {
    cum += Number(f.marginLengths || 0);
    return { ...f, cumBehind: f.finish === 1 ? 0 : cum };
  });

  // 1) append to each horse's run history
  for (const f of enriched) {
    const key = ensureHorse(fb, f.name);
    const beaten = enriched
      .filter((o) => o.finish > f.finish)
      .map((o) => o.name);
    fb.horses[key].runs.push({
      date, track, race, distance, going,
      classLabel, classType, classRank,
      finish: f.finish,
      field: enriched.length,
      marginBehindWinner: +f.cumBehind.toFixed(2),
      beaten,
      weight: f.weight ?? null,
      jockey: f.jockey ?? null,
      trainer: f.trainer ?? null,
      draw: f.draw ?? null,
    });
    if (f.rating != null) fb.horses[key].rating = f.rating;
  }

  // 2) head-to-head for every pair sharing this race (2+ shared runners)
  let pairsAdded = 0;
  for (let i = 0; i < enriched.length; i++) {
    for (let j = i + 1; j < enriched.length; j++) {
      const a = enriched[i], b = enriched[j];
      const key = pairKey(a.name, b.name);
      const winner = a.finish < b.finish ? a.name.trim() : b.name.trim();
      const margin = +Math.abs(a.cumBehind - b.cumBehind).toFixed(2);
      fb.headToHead[key] = fb.headToHead[key] || [];
      // de-dupe: same date+track+race already recorded
      const dup = fb.headToHead[key].some(
        (m) => m.date === date && m.track === track && m.race === race
      );
      if (!dup) {
        fb.headToHead[key].push({ date, track, race, distance, going, marginLengths: margin, winner });
        pairsAdded++;
      }
    }
  }

  // 3) settle any matching prediction in the log
  const predId = result.predictionId || makePredId(date, track, race);
  const pred = fb.predictionsLog.find((p) => p.id === predId);
  if (pred && !pred.settled) {
    const winnerName = enriched.find((f) => f.finish === 1);
    const placed = enriched.filter((f) => f.finish <= 3).map((f) => normalizeName(f.name));
    const topPick = pred.ranked && pred.ranked[0];
    pred.settled = true;
    pred.result = {
      winner: winnerName ? winnerName.name.trim() : null,
      topPick: topPick ? topPick.name : null,
      topPickWon: topPick ? normalizeName(topPick.name) === normalizeName(winnerName?.name) : false,
      topPickPlaced: topPick ? placed.includes(normalizeName(topPick.name)) : false,
    };
  }

  return { pairsAdded, finishers: enriched.length };
}

function makePredId(date, track, race) {
  return `${date}-${normalizeName(track).toLowerCase().replace(/\s+/g, '-')}-r${race}`;
}

// ---------------------------------------------------------------------------
// Head-to-head queries
// ---------------------------------------------------------------------------

// Raw record between two horses from A's perspective.
function headToHeadBetween(fb, a, b) {
  const key = pairKey(a, b);
  const meetings = fb.headToHead[key] || [];
  let aWins = 0, bWins = 0;
  for (const m of meetings) {
    if (normalizeName(m.winner) === normalizeName(a)) aWins++;
    else bWins++;
  }
  return { key, meetings, aWins, bWins, total: meetings.length };
}

// Given a field of horse names, rank them "strongest by head-to-head".
// Score model:
//   - each recorded win vs a rival in the field = +1 (recency-weighted)
//   - each loss = -1 (recency-weighted)
//   - margin acts as a small confidence multiplier
// Returns [{ name, key, points, wins, losses, meetings, beats: [...], record }]
function strongestByHeadToHead(fb, field, opts = {}) {
  const halfLifeDays = opts.halfLifeDays || 365;
  const now = opts.asOf ? new Date(opts.asOf) : new Date();
  const keys = field.map(normalizeName);

  const table = field.map((name) => ({
    name: name.trim(),
    key: normalizeName(name),
    points: 0,
    wins: 0,
    losses: 0,
    meetings: 0,
    beats: [],
    losesTo: [],
  }));
  const byKey = Object.fromEntries(table.map((t) => [t.key, t]));

  for (let i = 0; i < field.length; i++) {
    for (let j = i + 1; j < field.length; j++) {
      const a = field[i], b = field[j];
      const { meetings } = headToHeadBetween(fb, a, b);
      for (const m of meetings) {
        const ageDays = Math.max(0, (now - new Date(m.date)) / 86400000);
        const recency = Math.pow(0.5, ageDays / halfLifeDays); // 1 -> 0
        const marginW = 1 + Math.min(1, (m.marginLengths || 0) / 10); // up to 2x
        const w = recency * marginW;
        const winKey = normalizeName(m.winner);
        const loseKey = winKey === normalizeName(a) ? normalizeName(b) : normalizeName(a);
        if (byKey[winKey]) {
          byKey[winKey].points += w;
          byKey[winKey].wins += 1;
          byKey[winKey].meetings += 1;
          byKey[winKey].beats.push(byKey[loseKey] ? byKey[loseKey].name : m.winner);
        }
        if (byKey[loseKey]) {
          byKey[loseKey].points -= w;
          byKey[loseKey].losses += 1;
          byKey[loseKey].meetings += 1;
          byKey[loseKey].losesTo.push(byKey[winKey] ? byKey[winKey].name : m.winner);
        }
      }
    }
  }

  for (const t of table) {
    t.points = +t.points.toFixed(3);
    t.record = `${t.wins}-${t.losses}`;
  }
  table.sort((x, y) => y.points - x.points || y.wins - x.wins || x.losses - y.losses);
  return table;
}

// ---------------------------------------------------------------------------
// Strike rate over settled predictions
// ---------------------------------------------------------------------------
function strikeRate(fb) {
  const settled = fb.predictionsLog.filter((p) => p.settled && p.result);
  const n = settled.length;
  const wins = settled.filter((p) => p.result.topPickWon).length;
  const places = settled.filter((p) => p.result.topPickPlaced).length;
  return {
    settled: n,
    topPickWins: wins,
    topPickPlaces: places,
    winPct: n ? +((wins / n) * 100).toFixed(1) : 0,
    placePct: n ? +((places / n) * 100).toFixed(1) : 0,
    history: settled
      .slice(-40)
      .map((p) => ({ id: p.id, date: p.date, track: p.track, race: p.race, won: p.result.topPickWon, placed: p.result.topPickPlaced })),
  };
}

// ---------------------------------------------------------------------------
// Jockey/trainer combo strike rate (across all logged runs)
// ---------------------------------------------------------------------------
function comboRecord(fb, jockey, trainer) {
  if (!jockey || !trainer) return null;
  const j = String(jockey).trim().toLowerCase(), t = String(trainer).trim().toLowerCase();
  let starts = 0, wins = 0, places = 0;
  for (const h of Object.values(fb.horses)) {
    for (const r of h.runs || []) {
      if ((r.jockey || '').trim().toLowerCase() === j && (r.trainer || '').trim().toLowerCase() === t) {
        starts++; if (r.finish === 1) wins++; if (r.finish <= 3) places++;
      }
    }
  }
  if (!starts) return null;
  return { starts, wins, places, winPct: +((wins / starts) * 100).toFixed(0), record: `${wins}-${starts}` };
}

// Most recent run for a horse strictly before `beforeDate` (for class movement)
function lastRunBefore(fb, horseKey, beforeDate) {
  const runs = (fb.horses[horseKey] && fb.horses[horseKey].runs) || [];
  const prior = runs.filter((r) => !beforeDate || (r.date || '') < beforeDate)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return prior[0] || null;
}

// ---------------------------------------------------------------------------
// Confidence calibration: actual win rate of the top pick by score tier
// ---------------------------------------------------------------------------
function calibration(fb) {
  const tiers = [
    { key: 'high', label: '70+', min: 70, max: Infinity },
    { key: 'mid', label: '55–70', min: 55, max: 70 },
    { key: 'low', label: 'below 55', min: -Infinity, max: 55 },
  ].map((t) => ({ ...t, n: 0, wins: 0, places: 0 }));
  for (const p of fb.predictionsLog) {
    if (!p.settled || !p.result || !p.ranked || !p.ranked[0]) continue;
    const score = p.ranked[0].score;
    const tier = tiers.find((t) => score >= t.min && score < t.max);
    if (!tier) continue;
    tier.n++; if (p.result.topPickWon) tier.wins++; if (p.result.topPickPlaced) tier.places++;
  }
  return tiers.map((t) => ({
    tier: t.label, n: t.n, wins: t.wins, places: t.places,
    winPct: t.n ? +((t.wins / t.n) * 100).toFixed(0) : null,
    placePct: t.n ? +((t.places / t.n) * 100).toFixed(0) : null,
  }));
}

module.exports = {
  FORMBOOK_PATH, ROOT,
  load, save, ensureHorse,
  logResult, makePredId,
  headToHeadBetween, strongestByHeadToHead,
  strikeRate, comboRecord, lastRunBefore, calibration,
};
