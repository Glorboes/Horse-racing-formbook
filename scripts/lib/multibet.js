'use strict';

// Probability engine + multi-leg (accumulator) suggestion builder.
// Everything here is expressed as PROBABILITY / CONFIDENCE — no stakes,
// no payouts, no returns (keeps the "no ROI tracking" rule).

// ---- per-race probabilities -------------------------------------------------

function softmax(scores, temp) {
  const mx = Math.max(...scores);
  const ex = scores.map((s) => Math.exp((s - mx) / temp));
  const sum = ex.reduce((a, b) => a + b, 0) || 1;
  return ex.map((e) => e / sum);
}

// Market-implied win prob from fractional odds value (a/b). decimal incl. stake
// = a/b + 1, implied = 1/that. Overround removed by normalising across priced runners.
function marketProbs(oddsDecimals) {
  const raw = oddsDecimals.map((d) => (d != null ? 1 / (d + 1) : null));
  const sum = raw.reduce((a, b) => a + (b || 0), 0);
  if (sum <= 0) return raw.map(() => null);
  return raw.map((r) => (r != null ? r / sum : null));
}

// SA place terms by field size (tunable).
function placeCount(field) {
  if (field >= 16) return 4;
  if (field >= 8) return 3;
  if (field >= 5) return 2;
  return 0; // <5 runners: win only, no place pool
}

// Harville model: P(horse i finishes in the top m), from win probs.
function topMInclusion(p, m) {
  const n = p.length;
  const inTop = new Array(n).fill(0);
  const total = p.reduce((a, b) => a + b, 0);
  if (m <= 0 || total <= 0) return inTop;
  if (m >= n) return inTop.map(() => 1);
  (function rec(depth, used, runProb, remSum) {
    if (depth === m || remSum <= 0) return;
    for (let i = 0; i < n; i++) {
      if (used & (1 << i)) continue;
      const prob = runProb * (p[i] / remSum);
      inTop[i] += prob;
      rec(depth + 1, used | (1 << i), prob, remSum - p[i]);
    }
  })(0, 0, 1, total);
  return inTop;
}

// Blend model (softmax over scores) with market (odds), then derive place probs.
// opts: { temp, marketWeight }
function computeRaceProbs(ranked, opts = {}) {
  const temp = opts.temp || 6;
  const wMkt = opts.marketWeight != null ? opts.marketWeight : 0.5;
  const field = ranked.length;
  const scores = ranked.map((r) => r.score);
  const pModel = softmax(scores, temp);
  const pMkt = marketProbs(ranked.map((r) => r.oddsDecimal ?? null));
  const anyMarket = pMkt.some((x) => x != null);

  // blended win prob (fall back to model where a runner has no price)
  let pWin = ranked.map((r, i) => {
    if (anyMarket && pMkt[i] != null) return wMkt * pMkt[i] + (1 - wMkt) * pModel[i];
    return pModel[i];
  });
  const s = pWin.reduce((a, b) => a + b, 0) || 1;
  pWin = pWin.map((x) => x / s);

  const places = placeCount(field);
  const pPlace = places > 0 ? topMInclusion(pWin, places) : pWin.map(() => null);

  return ranked.map((r, i) => ({
    name: r.name, no: r.no ?? null, rank: r.rank,
    pModel: +pModel[i].toFixed(4),
    pMarket: pMkt[i] != null ? +pMkt[i].toFixed(4) : null,
    pWin: +pWin[i].toFixed(4),
    pPlace: pPlace[i] != null ? +pPlace[i].toFixed(4) : null,
    edge: pMkt[i] != null ? +(pModel[i] - pMkt[i]).toFixed(4) : null, // model vs market
  }));
}

// Attach pWin/pPlace onto a prediction's ranked[] (used by predict.js).
function annotatePrediction(prediction, opts) {
  const probs = computeRaceProbs(prediction.ranked, opts);
  const byName = Object.fromEntries(probs.map((p) => [p.name, p]));
  prediction.ranked.forEach((r) => {
    const p = byName[r.name];
    if (p) { r.pWin = p.pWin; r.pPlace = p.pPlace; r.pMarket = p.pMarket; r.edge = p.edge; }
  });
  prediction.places = placeCount(prediction.ranked.length);
  return prediction;
}

// ---- day-level multi builder ------------------------------------------------

const conf = (p) => (p >= 0.25 ? 'strong' : p >= 0.10 ? 'fair' : p >= 0.03 ? 'speculative' : 'longshot');
const product = (a) => a.reduce((x, y) => x * y, 1);

// races: [{ id, race, track, time, ranked:[{name,pWin,pPlace,rank,edge,pMarket}] }]
function buildDayMultis(races) {
  const legs = races.map((r) => {
    const top = [...r.ranked].sort((a, b) => (b.pWin || 0) - (a.pWin || 0))[0];
    const topPlace = [...r.ranked].sort((a, b) => (b.pPlace || 0) - (a.pPlace || 0))[0];
    return {
      id: r.id, race: r.race, track: r.track, time: r.time || null,
      pick: top ? top.name : null, pWin: top ? top.pWin : 0,
      placePick: topPlace ? topPlace.name : null, pPlace: topPlace ? (topPlace.pPlace || 0) : 0,
      edge: top ? (top.edge || 0) : 0,
    };
  }).filter((l) => l.pick);

  const byWin = [...legs].sort((a, b) => b.pWin - a.pWin);
  const byPlace = [...legs].filter((l) => l.pPlace > 0).sort((a, b) => b.pPlace - a.pPlace);

  function multi(sel, kind) {
    const p = product(sel.map((l) => (kind === 'place' ? l.pPlace : l.pWin)));
    return {
      kind, legs: sel.length,
      combined: +p.toFixed(4), combinedPct: +(p * 100).toFixed(1), confidence: conf(p),
      selections: sel.map((l) => ({
        race: l.race, track: l.track, time: l.time,
        selection: kind === 'place' ? l.placePick : l.pick,
        prob: +((kind === 'place' ? l.pPlace : l.pWin) * 100).toFixed(1),
      })),
    };
  }

  const winMultis = [3, 4, 5].filter((k) => byWin.length >= k).map((k) => multi(byWin.slice(0, k), 'win'));
  const placeMultis = [4, 5, 6].filter((k) => byPlace.length >= k).map((k) => multi(byPlace.slice(0, k), 'place'));

  const bankers = byWin.slice(0, 3).map((l) => ({
    race: l.race, track: l.track, time: l.time, selection: l.pick,
    pWin: +(l.pWin * 100).toFixed(1), pPlace: +(l.pPlace * 100).toFixed(1), confidence: conf(l.pWin),
  }));

  // model-edge legs: model rates the pick materially higher than the market does
  const edges = legs.filter((l) => l.edge >= 0.06)
    .sort((a, b) => b.edge - a.edge)
    .map((l) => ({ race: l.race, selection: l.pick, edgePts: +(l.edge * 100).toFixed(1), pWin: +(l.pWin * 100).toFixed(1) }));

  // headline recommendation: best win multi whose combined prob is still meaningful
  const best = [...winMultis].sort((a, b) => b.combined - a.combined)[0] || null;

  return { bankers, winMultis, placeMultis, edges, best,
    note: 'Probabilities blend model score with market odds; place uses the Harville model. Confidence only — no stakes or payouts.' };
}

module.exports = { computeRaceProbs, annotatePrediction, buildDayMultis, placeCount, topMInclusion };
