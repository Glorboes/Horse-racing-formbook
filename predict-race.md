# predict-race — how a pick is made

The predictor is **glass-box**: every horse gets a 0–100 score built from named,
inspectable factors. No hidden model. Weights live in one place
(`scripts/lib/scoring.js` → `WEIGHTS`) so you can tune them.

## Inputs
- Today's racecard (`predict <racecard.pdf|.txt|.json>`) — the actual field.
- The formbook (`data/formbook.json`) — every horse's run history + the
  auto-maintained `headToHead` map.

## The score = 8 base factors + 2 new contributors

| # | Factor | Weight | What it measures |
|---|--------|:-----:|------------------|
| 1 | `form` | 18 | Recent finishing positions, recency-weighted (last ~6 runs) |
| 2 | `rating` | 16 | Merit rating relative to today's field |
| 3 | `distance` | 10 | Record at ~today's distance (±200m) |
| 4 | `going` | 8 | Record on today's going/surface |
| 5 | `draw` | 6 | Barrier draw (mild inside bias for SA turf) |
| 6 | `jockey` | 6 | Strike proxy from the horse's runs |
| 7 | `trainer` | 6 | Strike proxy from the horse's runs |
| 8 | `weight` | 6 | Weight carried vs the field |
| + | **`headToHead`** | 12 | **NEW.** Standing vs the horses *actually in today's field*, recency-weighted, margin-scaled |
| + | **`recencyMargin`** | 12 | **NEW.** Recency-weighted winning/beaten margins (how far, how recently) |

Final score = weighted sum ÷ total weight × 100.

### Head-to-head weighting (factor 9)
For every rival **in today's field**, past meetings are pulled from
`headToHead`. Each meeting contributes `recency × marginMultiplier`:
- `recency = 0.5 ^ (ageDays / 365)` — a year-old result counts half.
- `marginMultiplier = 1 + min(1, lengths/10)` — a wide beating counts up to 2×.

Wins add, losses subtract. The field is then normalised 0–1 for the score, and
also surfaced directly as the **"strongest by head-to-head"** ranking
(`strongestByHeadToHead()` in `scripts/lib/formbook.js`).

### Recency-weighted margins (factor 10)
Rewards horses that have been finishing close to (or ahead of) the winner,
recently. `0.5 ^ (ageDays/200)` decay, margin mapped over ~12 lengths.

## Output
`predict` writes `data/predictions/<id>.json` containing `ranked`
(with per-factor `contrib`, `factors`, and prose `reasoning`), `comparison`
(table rows), and `headToHead` (the strongest ranking). The dashboard renders
all three, plus strike-rate history.

## Tuning
Edit `WEIGHTS`. Re-run `predict` on any racecard — nothing else changes.
The two new factors are deliberately additive: set them to `0` and you get the
original 8-factor behaviour back.
