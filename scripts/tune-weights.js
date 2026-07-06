#!/usr/bin/env node
'use strict';

// tune-weights.js — learn the factor weights from settled results.
//
// Model: conditional logistic regression (a.k.a. conditional logit /
// Plackett–Luce rank-1) — the statistically correct model for "exactly one
// winner per race". For race r, P(runner i wins) = softmax_i( w · x_i ), where
// x_i is that runner's 10 factor values. We fit w by maximising the likelihood
// of the actual winners (gradient descent, L2-regularised, non-negative).
//
// It STAYS a glass box: it prints the learned weights and only writes them
// (data/weights.json, which scoring.js then uses) when you pass --apply AND
// there is enough data AND the tuned weights beat the defaults out-of-sample.
//
// Usage:
//   node scripts/tune-weights.js            # fit + report, change nothing
//   node scripts/tune-weights.js --apply    # also write data/weights.json (gated)
//   node scripts/tune-weights.js --reset     # delete data/weights.json (back to defaults)

const fs = require('fs');
const path = require('path');
const fb = require('./lib/formbook');
const { DEFAULT_WEIGHTS } = require('./lib/scoring');
const { normalizeName } = require('./lib/names');

const ROOT = fb.ROOT;
const WEIGHTS_FILE = path.join(ROOT, 'data', 'weights.json');
const KEYS = Object.keys(DEFAULT_WEIGHTS);
const F = KEYS.length;

const MIN_RUN = 30;    // below this, too noisy to even fit meaningfully
const MIN_APPLY = 200; // won't write learned weights below this without --force
const TEMP = 6;        // matches the app's win-probability temperature

// ---- gather training samples from settled races -----------------------------
function gather(book) {
  const races = [];
  for (const p of book.predictionsLog) {
    if (!(p.settled && p.result && p.result.winner)) continue;
    const file = path.join(ROOT, 'data', 'predictions', `${p.id}.json`);
    if (!fs.existsSync(file)) continue;
    let pred; try { pred = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const winKey = normalizeName(p.result.winner);
    const runners = (pred.ranked || []).map((r) => ({
      x: KEYS.map((k) => (r.factors && r.factors[k] != null ? r.factors[k] : 0.5)),
      win: normalizeName(r.name) === winKey,
    }));
    if (runners.length < 2 || !runners.some((r) => r.win)) continue; // need a field + an in-field winner
    races.push({ date: pred.date, runners });
  }
  races.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  return races;
}

const dot = (w, x) => { let s = 0; for (let i = 0; i < F; i++) s += w[i] * x[i]; return s; };
function softmax(v) { const m = Math.max(...v); const e = v.map((z) => Math.exp(z - m)); const s = e.reduce((a, b) => a + b, 0); return e.map((z) => z / s); }

// ---- fit conditional logit by gradient descent ------------------------------
function fit(races, opts = {}) {
  const lr = opts.lr || 0.3, iters = opts.iters || 4000, l2 = opts.l2 || 0.02;
  let w = KEYS.map((k) => DEFAULT_WEIGHTS[k] / 60); // start near defaults, sane logit scale
  for (let it = 0; it < iters; it++) {
    const grad = new Array(F).fill(0);
    for (const r of races) {
      const scores = r.runners.map((ru) => dot(w, ru.x));
      const p = softmax(scores);
      for (let i = 0; i < r.runners.length; i++) {
        const err = p[i] - (r.runners[i].win ? 1 : 0);
        const x = r.runners[i].x;
        for (let j = 0; j < F; j++) grad[j] += err * x[j];
      }
    }
    for (let j = 0; j < F; j++) {
      w[j] -= lr * (grad[j] / races.length + l2 * w[j]);
      if (w[j] < 0) w[j] = 0; // weights are non-negative (keeps them interpretable)
    }
  }
  return w;
}

// rescale a weight vector to the same total as the defaults, for display + use
function rescale(w) {
  const sum = w.reduce((a, b) => a + b, 0) || 1;
  const target = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  const obj = {};
  KEYS.forEach((k, i) => { obj[k] = +((w[i] / sum) * target).toFixed(2); });
  return obj;
}

// evaluate a weight object the way the app does (score 0-100, rank + softmax logloss)
function evaluate(races, weightsObj) {
  const total = Object.values(weightsObj).reduce((a, b) => a + b, 0) || 1;
  let correct = 0, logloss = 0, n = 0;
  for (const r of races) {
    const scores = r.runners.map((ru) => {
      let s = 0; KEYS.forEach((k, i) => { s += weightsObj[k] * ru.x[i]; });
      return (s / total) * 100;
    });
    const top = scores.indexOf(Math.max(...scores));
    if (r.runners[top].win) correct++;
    const p = softmax(scores.map((s) => s / TEMP));
    const wi = r.runners.findIndex((ru) => ru.win);
    logloss += -Math.log(Math.max(1e-9, p[wi]));
    n++;
  }
  return { winAcc: +((correct / n) * 100).toFixed(1), logloss: +(logloss / n).toFixed(4), n };
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--reset')) {
    if (fs.existsSync(WEIGHTS_FILE)) { fs.unlinkSync(WEIGHTS_FILE); console.log('✓ removed data/weights.json — back to default weights.'); }
    else console.log('• no learned weights to remove.');
    return;
  }
  const apply = args.includes('--apply');
  const force = args.includes('--force');

  const book = fb.load();
  const races = gather(book);
  const N = races.length;
  console.log(`Settled races usable for tuning: ${N}`);
  if (N < MIN_RUN) {
    console.log(`\nNeed at least ${MIN_RUN} to fit anything meaningful — ${MIN_RUN - N} more to go.`);
    console.log('(The tuner is installed and will work automatically once the data is there.)');
    return;
  }

  // time-ordered split (train on earlier, validate on later)
  const inSample = N < 40;
  const cut = inSample ? 0 : Math.floor(N * 0.8);
  const train = inSample ? races : races.slice(0, cut);
  const val = inSample ? races : races.slice(cut);

  const learned = rescale(fit(train));
  const defEval = evaluate(val, DEFAULT_WEIGHTS);
  const tunEval = evaluate(val, learned);

  console.log(`\nLearned weights (fit on ${train.length} races, validated on ${val.length}${inSample ? ' — IN-SAMPLE, thin data' : ''}):`);
  console.log('  factor'.padEnd(16) + 'default   tuned');
  for (const k of KEYS) console.log('  ' + k.padEnd(14) + String(DEFAULT_WEIGHTS[k]).padStart(6) + '  ' + String(learned[k]).padStart(6));

  console.log(`\nValidation — default:  top-pick ${defEval.winAcc}%  log-loss ${defEval.logloss}`);
  console.log(`Validation — tuned:    top-pick ${tunEval.winAcc}%  log-loss ${tunEval.logloss}`);
  const better = tunEval.logloss < defEval.logloss;
  console.log(better ? '→ tuned improves out-of-sample.' : '→ tuned does NOT beat defaults out-of-sample.');

  if (!apply) { console.log('\n(report only — pass --apply to write these, once gates pass.)'); return; }

  if (N < MIN_APPLY && !force) {
    console.log(`\n✗ Not applying: need ${MIN_APPLY}+ settled races to trust learned weights (have ${N}). Use --force to override.`);
    return;
  }
  if (!better && !force) {
    console.log('\n✗ Not applying: tuned weights do not beat defaults out-of-sample. Use --force to override.');
    return;
  }
  fs.writeFileSync(WEIGHTS_FILE, JSON.stringify({
    generated: new Date().toISOString(), trainedOn: N, validation: { default: defEval, tuned: tunEval }, weights: learned,
  }, null, 2) + '\n');
  console.log(`\n✓ wrote data/weights.json — scoring will now use the learned weights. (Undo: node scripts/tune-weights.js --reset)`);
}

main();
