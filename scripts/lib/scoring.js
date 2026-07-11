'use strict';

const fs = require('fs');
const path = require('path');
const { normalizeName } = require('./names');
const { strongestByHeadToHead, comboRecord, lastRunBefore, jockeyRecord, trainerRecord, horseJockeyRecord } = require('./formbook');

const H2H_MIN_SAMPLE = 5; // fewer than this many meetings = "small sample"

// ---------------------------------------------------------------------------
// Weighting. The 8 base factors are the original system; headToHead and
// recencyMargin are additive on top. These are the DEFAULTS — if the
// auto-tuner has learned weights from settled results (data/weights.json),
// those are merged over the top. Order here defines the feature vector.
// ---------------------------------------------------------------------------
const DEFAULT_WEIGHTS = {
  form: 18,          // 1. recent finishing positions
  rating: 16,        // 2. merit / class rating
  distance: 10,      // 3. proven at today's distance
  going: 8,          // 4. suited to today's going/surface
  draw: 6,           // 5. barrier draw
  jockey: 3,         // 6. jockey strike (deliberately light — a support signal,
                     //    not a driver; the horse's own form should lead)
  trainer: 5,        // 7. trainer strike
  weight: 6,         // 8. weight carried
  headToHead: 12,    // NEW: H2H vs today's actual field
  recencyMargin: 12, // NEW: recency-weighted winning/beaten margins
};

// Learned weights override defaults when present (written by scripts/tune-weights.js --apply).
const WEIGHTS = (() => {
  try {
    const wf = path.resolve(__dirname, '..', '..', 'data', 'weights.json');
    if (fs.existsSync(wf)) {
      const learned = JSON.parse(fs.readFileSync(wf, 'utf8'));
      if (learned && learned.weights) return { ...DEFAULT_WEIGHTS, ...learned.weights };
    }
  } catch { /* fall back to defaults */ }
  return { ...DEFAULT_WEIGHTS };
})();

const clamp01 = (x) => Math.max(0, Math.min(1, x));

// recent form score from last N finishes (1st best). Recency weighted.
// Falls back to the card's career record (starts/wins/places) when we have no
// logged runs, so a horse with real racing history isn't scored as "unknown".
function formScore(runs, limit = 6, career = null) {
  const recent = runs.slice(-limit).reverse();
  if (!recent.length) {
    if (career && career.starts > 0) {
      const winRate = career.wins / career.starts;
      const placeRate = (career.wins + (career.seconds || 0) + (career.thirds || 0) + (career.places || 0)) / career.starts;
      return clamp01(0.32 + 0.5 * winRate + 0.16 * placeRate);
    }
    return 0.4; // truly unknown / unraced -> neutral-ish
  }
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

// Convert a jockey/trainer strike record into a 0-1 factor, shrunk toward the
// field base-rate for small samples (so a 1-from-1 jockey isn't rated elite).
function strikeToScore(rec, fieldSize) {
  if (!rec) return 0.5; // unknown -> neutral
  const base = 1 / Math.max(6, fieldSize || 10); // avg win chance in this field
  const k = 10; // prior strength (rides) — heavy shrink while data is thin
  const shrunk = (rec.wins + k * base) / (rec.starts + k);
  return clamp01(0.5 + (shrunk / base - 1) * 0.2); // base->0.5, 2x base->0.7
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
  h2h.forEach((t) => { t.smallSample = t.meetings > 0 && t.meetings < H2H_MIN_SAMPLE; });
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
      form: formScore(r.runs, 6, r.careerStats),
      rating: ratingScore(r.rating, enriched),
      distance: distanceScore(r.runs, race.distance),
      going: goingScore(r.runs, race.going),
      draw: drawScore(r.draw, fieldSize),
      jockey: strikeToScore(jockeyRecord(fb, r.jockey), fieldSize),
      trainer: strikeToScore(trainerRecord(fb, r.trainer), fieldSize),
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
    const meetings = h2hRec ? h2hRec.meetings : 0;

    return {
      name: r.name.trim(),
      key: r.key,
      draw: r.draw ?? null,
      rating: r.rating ?? null,
      jockey: r.jockey ?? null,
      trainer: r.trainer ?? null,
      weight: r.weight ?? null,
      odds: r.oddsFrac ?? null,
      oddsDecimal: r.oddsDecimal ?? null,
      score,
      factors: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, +v.toFixed(3)])),
      contrib,
      knownRuns: r.knownRuns,
      _runs: r.runs || [],
      career: r.careerStats ?? null,
      h2h: h2hRec ? { record: h2hRec.record, wins: h2hRec.wins, losses: h2hRec.losses, meetings, smallSample: meetings > 0 && meetings < H2H_MIN_SAMPLE, beats: h2hRec.beats, losesTo: h2hRec.losesTo } : null,
      recentForm: formNarrative(r.runs, r.careerStats, race),
      combo: comboRecord(fb, r.jockey, r.trainer),
      jockeyRec: jockeyRecord(fb, r.jockey),
      trainerRec: trainerRecord(fb, r.trainer),
      partnership: r.jockey ? horseJockeyRecord(fb, r.key, r.jockey) : null,
      classMove: classMovement(fb, r.key, race),
      reasoning: [],
    };
  });

  scored.sort((a, b) => b.score - a.score);

  // Relative strengths/concerns: a factor only counts as an advantage if the
  // horse is genuinely better than the field on it (not just a decent absolute
  // value). Fixes e.g. "good draw" showing for every runner.
  const fkeys = Object.keys(WEIGHTS);
  for (const k of fkeys) {
    const vals = scored.map((s) => s.factors[k]);
    const max = Math.max(...vals), min = Math.min(...vals);
    const spread = max - min;
    for (const s of scored) {
      // fraction of rivals this horse beats on factor k
      const better = vals.filter((x) => x < s.factors[k]).length;
      const frac = scored.length > 1 ? better / (scored.length - 1) : 0.5;
      (s._rel = s._rel || {})[k] = { frac, spread };
    }
  }
  const ratings = scored.map((s) => s.rating).filter((x) => x != null);
  const weights = scored.map((s) => s.weight).filter((x) => x != null);
  const ctx = {
    maxRating: ratings.length ? Math.max(...ratings) : null,
    minWeight: weights.length ? Math.min(...weights) : null,
    maxWeight: weights.length ? Math.max(...weights) : null,
    fieldSize: scored.length, distance: race.distance, track: race.track, going: race.going,
  };
  for (const s of scored) {
    const rel = fkeys.map((k) => ({ k, ...s._rel[k], v: s.factors[k] }));
    s._strengths = rel.filter((r) => r.spread >= 0.10 && r.frac >= 0.70 && r.v >= 0.5)
      .sort((a, b) => b.frac - a.frac).slice(0, 3).map((r) => r.k);
    s._concerns = rel.filter((r) => r.spread >= 0.10 && r.frac <= 0.30 && r.v <= 0.55)
      .sort((a, b) => a.frac - b.frac).slice(0, 2).map((r) => r.k);
    s._strReasons = s._strengths.map((k) => strengthReason(k, s, ctx));
    s._conReasons = s._concerns.map((k) => concernReason(k, s, ctx));
    delete s._rel; delete s._runs;
  }

  // market rank (shortest odds = 1) vs model rank; flag big disagreements
  const priced = scored.filter((s) => s.oddsDecimal != null)
    .sort((a, b) => a.oddsDecimal - b.oddsDecimal);
  priced.forEach((s, i) => { s.marketRank = i + 1; });
  scored.forEach((s, i) => {
    s.rank = i + 1;
    if (s.marketRank != null) {
      s.marketDisagree = Math.abs(s.rank - s.marketRank) >= 3;
    }
    s.reasoning = buildReasoning(s);
  });

  return { h2h, ranked: scored, marketPriced: priced.length > 0 };
}

// Class movement vs the horse's most recent prior run.
function classMovement(fb, key, race) {
  if (race.classType == null || race.classRank == null) return null;
  const prev = lastRunBefore(fb, key, race.date);
  if (!prev || prev.classRank == null || prev.classType == null) return null;
  if (prev.classType !== race.classType) {
    return { from: prev.classLabel, to: race.classLabel, direction: 'change' };
  }
  const dir = race.classRank > prev.classRank ? 'up' : race.classRank < prev.classRank ? 'down' : 'same';
  return { from: prev.classLabel, to: race.classLabel, direction: dir };
}

// Concrete, data-backed "why it can win" — drawn from the horse's actual
// logged runs (with margins) or, failing that, its career record off the card.
function fmtLen(x) {
  if (x == null) return '';
  if (x <= 0.15) return 'a nose';
  if (x < 0.4) return 'a head';
  if (x < 0.75) return 'half a length';
  return `${(+x).toFixed(x % 1 ? 2 : 0)}L`;
}
function placeWord(n) { return ({ 1: '1st', 2: '2nd', 3: '3rd' }[n] || `${n}th`); }
function formNarrative(runs, career, race) {
  const lines = [];
  if (runs && runs.length) {
    const sorted = [...runs].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    const recent = sorted.slice(0, 6);
    const last = sorted[0];
    if (last.finish === 1) {
      lines.push(`Won last start${last.wonBy != null ? ` by ${fmtLen(last.wonBy)}` : ''}${last.distance ? ` over ${last.distance}m` : ''}${last.track ? ` at ${last.track}` : ''}.`);
    } else if (last.marginBehindWinner != null && last.marginBehindWinner <= 1.5) {
      lines.push(`Beaten only ${fmtLen(last.marginBehindWinner)} into ${placeWord(last.finish)} last start — right there.`);
    } else {
      lines.push(`${placeWord(last.finish)} of ${last.field || '?'} last start.`);
    }
    const wins = recent.filter((r) => r.finish === 1).length;
    const places = recent.filter((r) => r.finish <= 3).length;
    if (wins >= 2) lines.push(`In form — ${wins} wins from last ${recent.length}.`);
    else if (recent.length >= 3 && places >= Math.ceil(recent.length * 0.6)) lines.push(`Consistent — placed in ${places} of last ${recent.length}.`);
    if (race.track && race.distance) {
      const cd = recent.some((r) => r.finish === 1 && r.track === race.track && Math.abs((r.distance || 0) - race.distance) <= 100);
      if (cd) lines.push(`Course-and-distance winner — has won here over ${race.distance}m.`);
    }
    const bigWin = Math.max(0, ...recent.filter((r) => r.finish === 1 && r.wonBy != null).map((r) => r.wonBy));
    if (bigWin >= 2.5) lines.push(`Won by ${fmtLen(bigWin)} recently — has a telling turn of foot.`);
  } else if (career && career.starts > 0) {
    const wr = career.wins / career.starts;
    const placed = career.wins + (career.seconds || 0) + (career.thirds || 0) + (career.places || 0);
    if (career.starts >= 4 && wr >= 0.30) lines.push(`Proven winner — ${career.wins} from ${career.starts} (${Math.round(wr * 100)}%) per the card.`);
    else if (career.starts >= 4 && placed / career.starts >= 0.6) lines.push(`Reliable — placed in ${placed} of ${career.starts} career starts.`);
    else lines.push(`Career ${career.starts} start${career.starts === 1 ? '' : 's'}, ${career.wins} win${career.wins === 1 ? '' : 's'}${placed > career.wins ? `, ${placed} placed` : ''} (from the card).`);
  }
  return [...new Set(lines)].slice(0, 3);
}

const LABEL = {
  form: 'recent form', rating: 'class/rating', distance: 'distance suitability',
  going: 'going suitability', draw: 'the draw', jockey: 'jockey record',
  trainer: 'trainer record', weight: 'weight', headToHead: 'head-to-head vs this field',
  recencyMargin: 'recent winning margins',
};

// Explain WHY a factor is an advantage for this horse, with real evidence.
function strengthReason(k, s, ctx) {
  const runs = s._runs || [];
  switch (k) {
    case 'form': return 'strong recent form';
    case 'recencyMargin': return 'hitting the line hard lately';
    case 'rating': return s.rating != null
      ? (s.rating >= ctx.maxRating ? `top-rated in the field (MR ${s.rating})` : `well-rated (MR ${s.rating})`)
      : 'higher class';
    case 'distance': {
      const at = runs.filter((r) => ctx.distance && Math.abs((r.distance || 0) - ctx.distance) <= 150);
      if (at.some((r) => r.finish === 1)) return `has won at ${ctx.distance}m`;
      if (at.some((r) => r.finish <= 3)) return 'placed at this trip before';
      return 'suited to this distance';
    }
    case 'going': {
      const g = (ctx.going || '').toLowerCase().split(' ')[0];
      const at = runs.filter((r) => g && String(r.going || '').toLowerCase().includes(g));
      return at.some((r) => r.finish <= 3) ? `handles the ${ctx.going} going` : 'acts on the going';
    }
    case 'draw': return s.draw != null
      ? `drawn ${s.draw}${s.draw <= Math.ceil(ctx.fieldSize / 3) ? ' — a handy low draw' : ''}`
      : 'well drawn';
    case 'jockey': return s.jockeyRec && s.jockeyRec.starts >= 3 ? `${s.jockeyRec.winPct}%-strike jockey booked` : 'good jockey booking';
    case 'trainer': return s.trainerRec && s.trainerRec.starts >= 3 ? `stable in form (${s.trainerRec.winPct}%)` : 'in-form stable';
    case 'weight': return (s.weight != null && ctx.minWeight != null && s.weight <= ctx.minWeight + 1)
      ? `well-in at the weights (${s.weight}kg)` : `carries ${s.weight ?? '?'}kg`;
    case 'headToHead': return s.h2h && s.h2h.beats.length ? `has beaten ${[...new Set(s.h2h.beats)].slice(0, 2).join(', ')}` : 'strong vs this field';
    default: return LABEL[k] || k;
  }
}

// Explain WHY a factor is a concern.
function concernReason(k, s, ctx) {
  switch (k) {
    case 'form': return 'patchy recent form';
    case 'recencyMargin': return 'well beaten lately';
    case 'rating': return s.rating != null ? `lower-rated (MR ${s.rating})` : 'up in class';
    case 'distance': return 'unproven at this trip';
    case 'going': return 'questions on the going';
    case 'draw': return s.draw != null ? `drawn wide (${s.draw})` : 'awkward draw';
    case 'jockey': return 'lightly-supported jockey booking';
    case 'trainer': return 'stable out of form';
    case 'weight': return (s.weight != null && ctx.maxWeight != null && s.weight >= ctx.maxWeight - 1) ? `top-weight (${s.weight}kg)` : `carries ${s.weight ?? '?'}kg`;
    case 'headToHead': return s.h2h && s.h2h.losesTo.length ? `beaten by ${[...new Set(s.h2h.losesTo)].slice(0, 2).join(', ')} before` : 'outclassed by this field';
    default: return LABEL[k] || k;
  }
}

// Human-readable, glass-box reasoning: top contributing factors + caveats.
function buildReasoning(s) {
  const notes = [];
  // lead with concrete, data-backed evidence (margins / recent form / career)
  if (s.recentForm && s.recentForm.length) notes.push(...s.recentForm);
  if (s._strReasons && s._strReasons.length) notes.push('Why it can win: ' + s._strReasons.join('; ') + '.');
  if (s._conReasons && s._conReasons.length) notes.push('Against it: ' + s._conReasons.join('; ') + '.');

  if (s.classMove && s.classMove.from && s.classMove.to && s.classMove.from !== s.classMove.to) {
    const verb = s.classMove.direction === 'up' ? 'Rising' : s.classMove.direction === 'down' ? 'Dropping' : 'Moving';
    notes.push(`${verb} in class: ${s.classMove.from} → ${s.classMove.to} since last run.`);
  }
  // One jockey line at most, and only when there's a real signal — kept as a
  // minor supporting note so it doesn't dominate the reasoning.
  if (s.partnership && s.partnership.starts >= 2 && s.partnership.wins > 0) {
    notes.push(`Winning partnership: ${s.jockey} ${s.partnership.record} on this horse.`);
  } else if (s.jockey && s.jockeyRec && s.jockeyRec.starts >= 10 && s.jockeyRec.winPct >= 18) {
    notes.push(`Jockey ${s.jockey} in form (${s.jockeyRec.winPct}% strike).`);
  }
  if (s.h2h && (s.h2h.wins || s.h2h.losses)) {
    const tag = s.h2h.smallSample ? ' ⚠ small sample' : '';
    if (s.h2h.beats.length) notes.push(`Has beaten ${[...new Set(s.h2h.beats)].join(', ')} before (H2H ${s.h2h.record}${tag}).`);
    else if (s.h2h.losesTo.length) notes.push(`Beaten by ${[...new Set(s.h2h.losesTo)].join(', ')} in the past (H2H ${s.h2h.record}${tag}).`);
  }
  if (s.marketDisagree) {
    notes.push(`Model/market disagree: model rank ${s.rank} vs market rank ${s.marketRank}${s.odds ? ` (${s.odds})` : ''}.`);
  }
  if (!s.knownRuns && (!s.recentForm || !s.recentForm.length)) {
    if (s.career && s.career.starts === 0) notes.push('Unraced — first career start.');
    else notes.push('No form data — scored on today\'s racecard only.');
  }
  return notes;
}

module.exports = { scoreRace, WEIGHTS, DEFAULT_WEIGHTS };
