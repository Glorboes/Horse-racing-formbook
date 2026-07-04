'use strict';

const { normalizeName } = require('./names');
const { strongestByHeadToHead } = require('./formbook');

// ---------------------------------------------------------------------------
// Weighting. Tune here. The 8 base factors are the existing system; the two
// new contributors (headToHead, recencyMargin) are additive on top.
// ---------------------------------------------------------------------------
const WEIGHTS = {
  form: 18,          // 1. recent finishing positions
  rating: 16,        // 2. merit / class rating
  distance: 10,      // 3. proven at today's distance
  going: 8,          // 4. suited to today's going/surface
  draw: 6,           // 5. barrier draw
  jockey: 6,         // 6. jockey strike
  trainer: 6,        // 7. trainer strike
  weight: 6,         // 8. weight carried
  headToHead: 12,    // NEW: H2H vs today's actual field
  recencyMargin: 12, // NEW: recency-weighted winning/beaten margins
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// recent form score from last N finishes (1st best). Recency weighted.
function formScore(runs, limit = 6) {
  const recent = runs.slice(-limit).reverse();
  if (!recent.length) return 0.4; // unknown -> neutral-ish
  let num = 0, den = 0;
  recent.forEach((r, i) => {
    const w = Math.pow(0.75, i); // most recent weighs most
    const field = r.field || 12;
    const posScore = clamp01(1 - (r.finish - 1) / Math.max(1, field - 1));
    num += w * posScore;
    den += w;
  });
  return den ? num / den : 0.4;
}

// recency-weighted margin score: rewards winning/finishing close, decays with age.
function recencyMarginScore(runs, asOf, halfLifeDays = 200) {
  const now = asOf ? new Date(asOf) : new Date();
  if (!runs.length) return 0.4;
  let num = 0, den = 0;
  for (const r of runs) {
    const ageDays = Math.max(0, (now - new Date(r.date)) / 86400000);
    const rec = Math.pow(0.5, ageDays / halfLifeDays);
    // won -> margin ahead is unknown here, treat win as +full; else penalise by lengths behind
    const behind = r.finish === 1 ? -1.0 : Number(r.marginBehindWinner || 0); // negative = in front
    const m = clamp01(1 - behind / 12); // within ~12 lengths mapped to [0,1]
    num += rec * m;
    den += rec;
  }
  return den ? num / den : 0.4;
}

function distanceScore(runs, dist) {
  if (!dist || !runs.length) return 0.5;
  const near = runs.filter((r) => Math.abs((r.distance || 0) - dist) <= 200);
  if (!near.length) return 0.4;
  const avg = near.reduce((s, r) => s + clamp01(1 - (r.finish - 1) / Math.max(1, (r.field || 12) - 1)), 0) / near.length;
  return 0.35 + 0.65 * avg;
}

function goingScore(runs, going) {
  if (!going || !runs.length) return 0.5;
  const g = String(going).toLowerCase();
  const same = runs.filter((r) => String(r.going || '').toLowerCase().includes(g.split(' ')[0]));
  if (!same.length) return 0.45;
  const avg = same.reduce((s, r) => s + clamp01(1 - (r.finish - 1) / Math.max(1, (r.field || 12) - 1)), 0) / same.length;
  return 0.35 + 0.65 * avg;
}

function ratingScore(rating, field) {
  const ratings = field.map((h) => h.rating).filter((r) => r != null);
  if (rating == null || ratings.length < 2) return 0.5;
  const lo = Math.min(...ratings), hi = Math.max(...ratings);
  if (hi === lo) return 0.5;
  return clamp01((rating - lo) / (hi - lo));
}

function drawScore(draw, fieldSize) {
  if (draw == null || !fieldSize) return 0.5;
  // mild inside-draw preference (SA turf); soft curve
  return clamp01(1 - (draw - 1) / Math.max(1, fieldSize) * 0.5);
}

function weightScore(weight, field) {
  const ws = field.map((h) => h.weight).filter((w) => w != null);
  if (weight == null || ws.length < 2) return 0.5;
  const lo = Math.min(...ws), hi = Math.max(...ws);
  if (hi === lo) return 0.5;
  return clamp01(1 - (weight - lo) / (hi - lo)); // lighter = better, mildly
}

// jockey/trainer strike from horse's own runs (proxy if no global table)
function connectionScore(runs, key) {
  if (!runs.length) return 0.5;
  const withWins = runs.filter((r) => r.finish === 1).length;
  return clamp01(0.4 + 0.6 * (withWins / runs.length));
}

// ---------------------------------------------------------------------------
// Score a whole race. `race` = { distance, going, runners: [{name, rating,
// weight, jockey, trainer, draw}] }. `fb` = formbook.
// Returns ranked array with per-factor breakdown + prose reasoning.
// ---------------------------------------------------------------------------
function scoreRace(fb, race) {
  const fieldSize = race.runners.length;
  const asOf = race.date;

  // pre-compute H2H standings for the actual field
  const fieldNames = race.runners.map((r) => r.name);
  const h2h = strongestByHeadToHead(fb, fieldNames, { asOf });
  const h2hByKey = Object.fromEntries(h2h.map((t) => [t.key, t]));
  const h2hPoints = h2h.map((t) => t.points);
  const h2hLo = Math.min(0, ...h2hPoints), h2hHi = Math.max(0, ...h2hPoints);

  // attach known runs/rating from formbook
  const enriched = race.runners.map((r) => {
    const key = normalizeName(r.name);
    const known = fb.horses[key] || { runs: [], rating: null };
    return {
      ...r,
      key,
      rating: r.rating != null ? r.rating : known.rating,
      runs: known.runs || [],
      knownRuns: (known.runs || []).length,
    };
  });

  const scored = enriched.map((r) => {
    const f = {
      form: formScore(r.runs),
      rating: ratingScore(r.rating, enriched),
      distance: distanceScore(r.runs, race.distance),
      going: goingScore(r.runs, race.going),
      draw: drawScore(r.draw, fieldSize),
      jockey: connectionScore(r.runs, 'jockey'),
      trainer: connectionScore(r.runs, 'trainer'),
      weight: weightScore(r.weight, enriched),
      headToHead: h2hHi > h2hLo
        ? clamp01(((h2hByKey[r.key]?.points ?? 0) - h2hLo) / (h2hHi - h2hLo))
        : 0.5,
      recencyMargin: recencyMarginScore(r.runs, asOf),
    };

    let total = 0, max = 0;
    const contrib = {};
    for (const [name, weight] of Object.entries(WEIGHTS)) {
      const pts = f[name] * weight;
      contrib[name] = +pts.toFixed(2);
      total += pts;
      max += weight;
    }
    const score = +((total / max) * 100).toFixed(1);
    const h2hRec = h2hByKey[r.key];

    return {
      name: r.name.trim(),
      key: r.key,
      draw: r.draw ?? null,
      rating: r.rating ?? null,
      jockey: r.jockey ?? null,
      trainer: r.trainer ?? null,
      weight: r.weight ?? null,
      score,
      factors: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, +v.toFixed(3)])),
      contrib,
      knownRuns: r.knownRuns,
      h2h: h2hRec ? { record: h2hRec.record, wins: h2hRec.wins, losses: h2hRec.losses, beats: h2hRec.beats, losesTo: h2hRec.losesTo } : null,
      reasoning: [],
    };
  });

  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => { s.rank = i + 1; s.reasoning = buildReasoning(s, WEIGHTS); });

  return { h2h, ranked: scored };
}

// Human-readable, glass-box reasoning: top contributing factors + caveats.
function buildReasoning(s, weights) {
  const order = Object.entries(s.contrib).sort((a, b) => b[1] - a[1]);
  const label = {
    form: 'recent form', rating: 'class/rating', distance: 'distance suitability',
    going: 'going suitability', draw: 'the draw', jockey: 'jockey record',
    trainer: 'trainer record', weight: 'weight', headToHead: 'head-to-head vs this field',
    recencyMargin: 'recent winning margins',
  };
  const notes = [];
  const strong = order.filter(([k, v]) => s.factors[k] >= 0.6).slice(0, 3);
  const weak = order.filter(([k]) => s.factors[k] <= 0.35).slice(0, 2);
  if (strong.length) notes.push('Strengths: ' + strong.map(([k]) => label[k]).join(', ') + '.');
  if (weak.length) notes.push('Concerns: ' + weak.map(([k]) => label[k]).join(', ') + '.');
  if (s.h2h && (s.h2h.wins || s.h2h.losses)) {
    if (s.h2h.beats.length) notes.push(`Has beaten ${[...new Set(s.h2h.beats)].join(', ')} before.`);
    if (s.h2h.losesTo.length) notes.push(`Beaten by ${[...new Set(s.h2h.losesTo)].join(', ')} in the past.`);
  }
  if (!s.knownRuns) notes.push('No prior runs in the formbook — scored on today\'s racecard data only.');
  return notes;
}

module.exports = { scoreRace, WEIGHTS };
