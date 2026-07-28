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

  const predId = result.predictionId || makePredId(date, track, race);
  // winning margin = how far the runner-up finished behind the winner
  const runnerUp = enriched.find((f) => f.finish === 2);
  const winMargin = runnerUp ? +runnerUp.cumBehind.toFixed(2) : null;

  // Results feeds (e.g. Raceform) give the jockey but not the trainer. The
  // racecard we predicted from DOES have trainers, so cross-fill from it.
  const cardTrainer = {};
  const cardJockey = {};
  let predFile = null;
  try {
    const pf = path.join(ROOT, 'data', 'predictions', `${predId}.json`);
    if (fs.existsSync(pf)) {
      predFile = JSON.parse(fs.readFileSync(pf, 'utf8'));
      for (const r of predFile.ranked || []) {
        const k = normalizeName(r.name);
        if (r.trainer) cardTrainer[k] = r.trainer;
        if (r.jockey) cardJockey[k] = r.jockey;
      }
    }
  } catch { /* no card — fine */ }

  // 1) append to each horse's run history
  for (const f of enriched) {
    const key = ensureHorse(fb, f.name);
    const beaten = enriched
      .filter((o) => o.finish > f.finish)
      .map((o) => o.name);
    const jockey = f.jockey ?? cardJockey[key] ?? null;
    const trainer = f.trainer ?? cardTrainer[key] ?? null;
    const run = {
      date, track, race, distance, going,
      classLabel, classType, classRank,
      finish: f.finish,
      field: enriched.length,
      marginBehindWinner: +f.cumBehind.toFixed(2),
      wonBy: f.finish === 1 ? winMargin : null, // lengths the winner won by
      beaten,
      weight: f.weight ?? null,
      jockey,
      trainer,
      draw: f.draw ?? null,
      sp: f.sp ?? null,
      oddsDecimal: f.oddsDecimal ?? null,
      time: f.time ?? null,        // finishing time (s)
      s800: f.s800 ?? null,        // sectional splits — raw, for future speed figures
      s400: f.s400 ?? null,
      sDist: f.sDist ?? null,
    };
    // idempotent: re-importing the same meeting updates the run in place
    // (backfilling new fields like SP/sectionals) instead of duplicating it.
    const existing = fb.horses[key].runs.find((r) => r.date === date && r.track === track && r.race === race);
    if (existing) { for (const [k, v] of Object.entries(run)) if (v != null) existing[k] = v; }
    else fb.horses[key].runs.push(run);
    if (trainer && !fb.horses[key].trainer) fb.horses[key].trainer = trainer; // remember stable
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
  const pred = fb.predictionsLog.find((p) => p.id === predId);
  if (pred && !pred.settled) {
    const winnerName = enriched.find((f) => f.finish === 1);
    const finKeys = enriched.map((f) => normalizeName(f.name));
    const placed = enriched.filter((f) => f.finish <= 3).map((f) => normalizeName(f.name));
    // Graded pick = the "most likely to win" we headline (highest win probability),
    // not the raw model-score top. Falls back to score-top if no probabilities.
    let pick = null;
    if (predFile && predFile.ranked && predFile.ranked.length) {
      pick = predFile.ranked.reduce((a, b) => ((b.pWin || 0) > (a.pWin || 0) ? b : a), predFile.ranked[0]);
    } else if (pred.ranked && pred.ranked[0]) {
      pick = pred.ranked[0];
    }
    const pickKey = pick ? normalizeName(pick.name) : null;
    const scratched = pickKey ? !finKeys.includes(pickKey) : false; // pick withdrawn after the card
    pred.settled = true;
    pred.result = {
      winner: winnerName ? winnerName.name.trim() : null,
      topPick: pick ? pick.name : null,
      pickPWin: pick && pick.pWin != null ? +(+pick.pWin).toFixed(4) : null,
      pickScore: pick && pick.score != null ? pick.score : null,
      topPickScratched: scratched,
      topPickWon: !scratched && pickKey ? pickKey === normalizeName(winnerName?.name) : false,
      topPickPlaced: !scratched && pickKey ? placed.includes(pickKey) : false,
    };
  }

  // Closing-line value: compare each runner's model win probability to the
  // probability implied by its actual starting price (the "closing line"), the
  // sharpest read the market ever offers. Runs whenever we have both a priced
  // result and the prediction file — including on re-import — so it backfills.
  if (pred && predFile && predFile.ranked && predFile.ranked.length) {
    const priced = enriched.filter((f) => f.oddsDecimal > 0);
    const rawSum = priced.reduce((s, f) => s + 1 / (f.oddsDecimal + 1), 0);
    if (priced.length >= 4 && rawSum > 0) {
      const closeByKey = {};
      for (const f of priced) closeByKey[normalizeName(f.name)] = (1 / (f.oddsDecimal + 1)) / rawSum; // overround removed
      const value = [];
      for (const r of predFile.ranked) {
        const k = normalizeName(r.name);
        const pc = closeByKey[k];
        if (pc == null || r.pWin == null) continue;
        const fin = enriched.find((f) => normalizeName(f.name) === k);
        value.push({
          name: r.name,
          pModel: +(+r.pWin).toFixed(4),
          pClose: +pc.toFixed(4),
          edge: +(r.pWin - pc).toFixed(4),
          won: fin ? fin.finish === 1 : false,
          placed: fin ? fin.finish <= 3 : false,
        });
      }
      if (value.length) { pred.result = pred.result || {}; pred.result.value = value; }
    }
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
  const allSettled = fb.predictionsLog.filter((p) => p.settled && p.result);
  const scratched = allSettled.filter((p) => p.result.topPickScratched).length;
  const settled = allSettled.filter((p) => !p.result.topPickScratched); // top pick actually ran
  const n = settled.length;
  const wins = settled.filter((p) => p.result.topPickWon).length;
  const places = settled.filter((p) => p.result.topPickPlaced).length;
  return {
    settled: n,
    scratched,
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

// Strike rate for a jockey across every logged run.
function jockeyRecord(fb, jockey) {
  if (!jockey) return null;
  const j = String(jockey).trim().toLowerCase();
  let starts = 0, wins = 0, places = 0;
  for (const h of Object.values(fb.horses)) {
    for (const r of h.runs || []) {
      if ((r.jockey || '').trim().toLowerCase() === j) { starts++; if (r.finish === 1) wins++; if (r.finish <= 3) places++; }
    }
  }
  if (!starts) return null;
  return { starts, wins, places, winPct: +((wins / starts) * 100).toFixed(0), placePct: +((places / starts) * 100).toFixed(0), record: `${wins}-${starts}` };
}

// Strike rate for a trainer across every logged run.
function trainerRecord(fb, trainer) {
  if (!trainer) return null;
  const t = String(trainer).trim().toLowerCase();
  let starts = 0, wins = 0, places = 0;
  for (const h of Object.values(fb.horses)) {
    for (const r of h.runs || []) {
      if ((r.trainer || '').trim().toLowerCase() === t) { starts++; if (r.finish === 1) wins++; if (r.finish <= 3) places++; }
    }
  }
  if (!starts) return null;
  return { starts, wins, places, winPct: +((wins / starts) * 100).toFixed(0), record: `${wins}-${starts}` };
}

// This horse's record specifically when ridden by this jockey (the partnership).
function horseJockeyRecord(fb, horseKey, jockey) {
  if (!jockey || !fb.horses[horseKey]) return null;
  const j = String(jockey).trim().toLowerCase();
  const runs = (fb.horses[horseKey].runs || []).filter((r) => (r.jockey || '').trim().toLowerCase() === j);
  if (!runs.length) return { starts: 0, wins: 0, places: 0, newPartnership: true };
  const wins = runs.filter((r) => r.finish === 1).length;
  const places = runs.filter((r) => r.finish <= 3).length;
  return { starts: runs.length, wins, places, newPartnership: false, record: `${wins}-${runs.length}` };
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
// Probability calibration: group the graded pick by its stated win probability,
// then compare the AVERAGE predicted probability (expected) to the ACTUAL win
// rate. A well-calibrated model has expected ≈ actual in every band.
function calibration(fb) {
  const tiers = [
    { label: '40%+', min: 0.40, max: Infinity },
    { label: '25–40%', min: 0.25, max: 0.40 },
    { label: '15–25%', min: 0.15, max: 0.25 },
    { label: 'under 15%', min: -Infinity, max: 0.15 },
  ].map((t) => ({ ...t, n: 0, wins: 0, sumP: 0 }));
  for (const p of fb.predictionsLog) {
    if (!p.settled || !p.result || p.result.topPickScratched) continue;
    const pw = p.result.pickPWin;
    if (pw == null) continue;
    const tier = tiers.find((t) => pw >= t.min && pw < t.max);
    if (!tier) continue;
    tier.n++; tier.sumP += pw; if (p.result.topPickWon) tier.wins++;
  }
  return tiers.map((t) => ({
    tier: t.label, n: t.n, wins: t.wins,
    expectedPct: t.n ? +((t.sumP / t.n) * 100).toFixed(0) : null, // avg predicted
    winPct: t.n ? +((t.wins / t.n) * 100).toFixed(0) : null,       // actual
  }));
}

// ---------------------------------------------------------------------------
// Closing Line Value (CLV): the honest edge test. For every priced runner in a
// settled race we stored the model probability and the probability implied by
// its starting price. If the model consistently rates horses above their
// closing price AND they win at the model's rate, there is a real edge — the
// single best predictor of long-run profitability, measured with no bet placed.
// ---------------------------------------------------------------------------
function closingLineValue(fb) {
  const rows = [];
  const picks = [];
  for (const p of fb.predictionsLog) {
    if (!p.settled || !p.result || !Array.isArray(p.result.value) || !p.result.value.length) continue;
    for (const v of p.result.value) rows.push(v);
    picks.push(p.result.value.reduce((a, b) => (b.pModel > a.pModel ? b : a))); // model's top pick
  }
  const buckets = [
    { label: 'model +10pts', min: 0.10, max: Infinity },
    { label: 'model +3–10pts', min: 0.03, max: 0.10 },
    { label: 'agree (±3pts)', min: -0.03, max: 0.03 },
    { label: 'model −3pts+', min: -Infinity, max: -0.03 },
  ].map((b) => ({ ...b, n: 0, wins: 0, sumModel: 0, sumClose: 0 }));
  for (const v of rows) {
    const b = buckets.find((x) => v.edge >= x.min && v.edge < x.max);
    if (!b) continue;
    b.n++; if (v.won) b.wins++; b.sumModel += v.pModel; b.sumClose += v.pClose;
  }
  const beat = picks.filter((t) => t.edge > 0);
  const pctOr = (num, den) => (den ? +((num / den) * 100).toFixed(0) : null);
  return {
    racesWithPrice: picks.length,
    runnersWithPrice: rows.length,
    pickAvgModelPct: pctOr(picks.reduce((s, t) => s + t.pModel, 0), picks.length),
    pickAvgClosePct: pctOr(picks.reduce((s, t) => s + t.pClose, 0), picks.length),
    pickWinPct: pctOr(picks.filter((t) => t.won).length, picks.length),
    beatClosePicks: beat.length,
    beatCloseWinPct: pctOr(beat.filter((t) => t.won).length, beat.length),
    buckets: buckets.map((b) => ({
      label: b.label, n: b.n,
      avgModelPct: pctOr(b.sumModel, b.n),
      avgClosePct: pctOr(b.sumClose, b.n),
      winPct: pctOr(b.wins, b.n),
    })),
  };
}

module.exports = {
  FORMBOOK_PATH, ROOT,
  load, save, ensureHorse,
  logResult, makePredId,
  headToHeadBetween, strongestByHeadToHead,
  strikeRate, comboRecord, jockeyRecord, trainerRecord, horseJockeyRecord, lastRunBefore, calibration,
  closingLineValue,
};
