# Backtest inputs

Walk-forward backtest over many past meetings — the fast way to build history
and get an honest track record. See `scripts/backtest.js`.

## How to use
1. Drop one **Computaform racecard PDF per meeting** into `cards/`.
2. Drop the matching **Raceform results** into `results/` as a `.txt`, with the
   filename **starting with the date**: `2026-07-05-turffontein.txt`.
3. Run:
   ```bash
   node scripts/backtest.js --fresh        # --fresh = start from an empty DB
   node scripts/backtest.js --fresh --push # also push the result
   ```

## Why it's honest
It processes meetings in **date order**: each meeting is predicted using **only
the data from earlier meetings**, then its results are logged before moving on.
That means no race is ever predicted with knowledge of its own (or later)
results — the strike rate and calibration it reports are genuine out-of-sample.

⚠️ Always use `--fresh` for a clean run. Predicting a meeting whose results are
already in the database leaks the future and produces a fake, inflated number.

(PDFs/results here are git-ignored — they're your private data.)
