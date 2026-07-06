'use strict';

// Horse-name normalization + fuzzy matching.
// SA racecards and results sites spell names slightly differently
// (case, apostrophes, "(AUS)" country suffixes, spacing). We keep a
// human display name but match on a normalized key.

function normalizeName(raw) {
  if (!raw) return '';
  return String(raw)
    .toUpperCase()
    .replace(/\([A-Z]{2,3}\)/g, ' ') // strip country suffixes e.g. (AUS)
    .replace(/[’'`]/g, '')           // apostrophes
    .replace(/[^A-Z0-9 ]/g, ' ')     // punctuation -> space
    .replace(/\s+/g, ' ')
    .trim();
}

// Head-to-head pair key: order-independent, so A|B === B|A.
function pairKey(a, b) {
  return [normalizeName(a), normalizeName(b)].sort().join('|');
}

// Levenshtein distance for catching renames / typos ("EL BARB" vs "EL-BARB").
function levenshtein(a, b) {
  a = a || ''; b = b || '';
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
      prev = tmp;
    }
  }
  return dp[n];
}

// Find the best matching known horse for a scraped/parsed name.
// Returns { key, score } where score in [0,1]; null if below threshold.
function bestMatch(candidate, knownKeys, threshold = 0.82) {
  const target = normalizeName(candidate);
  if (!target) return null;
  if (knownKeys.includes(target)) return { key: target, score: 1 };
  let best = null;
  for (const key of knownKeys) {
    const dist = levenshtein(target, key);
    const score = 1 - dist / Math.max(target.length, key.length);
    if (!best || score > best.score) best = { key, score };
  }
  if (best && best.score >= threshold) return best;
  return null;
}

// SA racing circuits — tracks in the same circuit share horses/jockeys/trainers.
const CIRCUITS = {
  Cape: ['kenilworth', 'durbanville'],
  Highveld: ['turffontein', 'vaal', 'newmarket'],
  KZN: ['greyville', 'scottsville', 'hollywoodbets greyville', 'hollywoodbets scottsville'],
  'Eastern Cape': ['fairview'],
};
function circuitOf(track) {
  const t = normalizeName(track).toLowerCase();
  for (const [circuit, tracks] of Object.entries(CIRCUITS)) {
    if (tracks.some((x) => t.includes(x))) return circuit;
  }
  return 'Other';
}

module.exports = { normalizeName, pairKey, levenshtein, bestMatch, circuitOf, CIRCUITS };
