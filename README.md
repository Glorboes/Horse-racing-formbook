# 🐎 horse-racing-formbook

Private SA horse-racing formbook: **8-factor + head-to-head** predictions, an
**auto-updating** results database, and a **password-gated, phone-friendly**
dashboard served from GitHub Pages.

Tracks: Turffontein · Vaal · Fairview (incl. Polytrack) · Scottsville · Greyville.

---

## What it does (the dashboard shows all four)

1. **Comparison** — side-by-side runners: last-5 form, rating, draw, weight, and
   a bar per scoring factor.
2. **Educated Guess** — ranked picks with *visible reasoning per horse* (no
   black-box scores).
3. **Who Beat Who / Strongest** — head-to-head matrix + standings, with a clear
   🥇 "strongest by head-to-head" indicator for the field.
4. **Auto-updating database** — results and head-to-head update automatically
   after each race day; the phone view refreshes itself via auto-push.

---

## Quick start

```bash
npm install                 # optional: pulls pdf-parse for PDF racecards
export PATH="$PWD/bin:$PATH" # enables the `predict` command

# 1) predict a card  (PDF, or .txt/.json fallback — see data/racecards/EXAMPLE.txt)
predict data/racecards/turffontein-r5.pdf

# 2) after the races, log results  → updates head-to-head + strike rate
node scripts/pull-results.js            # scrape Gold Circle + 4Racing, or…
node scripts/pull-results.js --source inbox   # …consume data/results-inbox/*.json

# manual single result (original workflow, preserved):
node scripts/log-result.js result.json
```

Every command refreshes `docs/` and **git-commits + pushes automatically**, so
the phone dashboard stays current. Disable with `AUTO_PUSH=0` or `--no-push`.

---

## Phone-only workflow (no laptop needed) — GitHub Actions

**Where do I send the day's racecard?** → Upload it into **`data/racecards/`**.

On your phone: open the repo on github.com → `data/racecards/` → **Add file →
Upload files** → pick the TAB Computaform **PDF** (or a `.txt`/`.json` card) →
Commit. The **“Predict on racecard upload”** Action
(`.github/workflows/predict.yml`) runs automatically, generates the prediction,
and pushes it — the dashboard shows the new race a minute later. No git, no CLI.

**Auto-updating results + the 6-month backfill.** The **“Pull results”** Action
(`.github/workflows/pull-results.yml`) runs nightly to log results and refresh
head-to-head. To backfill history, run it manually:
**Actions tab → “Pull results” → Run workflow → `days` = `180`.**

> ⚠️ The results sites (Gold Circle, 4Racing) are Cloudflare-protected and the
> scraper's CSS selectors are **unverified against the live pages** — the first
> real run may log 0 races until the selectors in `scripts/pull-results.js`
> (`ADAPTERS`) are tuned using the debug HTML the Action uploads as an artifact.
> The **`data/results-inbox/`** path always works as a fallback.

---

## The dashboard

- Lives in `docs/dashboard.html` (Pages entry `docs/index.html` redirects to it).
- **Password gate:** it stores only the SHA-256 of your passphrase — the plain
  text is never in the source. To change it, hash a new phrase and replace
  `PASS_HASH` in `docs/dashboard.html`:
  ```bash
  printf '%s' 'your new passphrase' | sha256sum
  ```
  (The gate keeps it off Google and casual eyes; the real protection is the
  **private repo**.)
- Reads `docs/data/manifest.json` + `docs/data/predictions/*.json` +
  `docs/data/strike-rate.json`, all generated for you.

### Enable GitHub Pages (one-time, manual)
Repo **Settings → Pages → Build and deployment → Deploy from a branch →
Branch: `main` / `/docs`**. Your dashboard is then at
`https://<user>.github.io/horse-racing-formbook/`.

---

## Data model

`data/formbook.json`
```jsonc
{
  "horses": {
    "EL BARB": { "name":"El Barb", "rating":96, "runs":[ /* per-race history */ ] }
  },
  "headToHead": {
    "EL BARB|SILVER HOST": [
      { "date":"2026-06-14","track":"Greyville","race":5,"distance":1600,
        "going":"Soft","marginLengths":1.25,"winner":"Silver Host" }
    ]
  },
  "predictionsLog": [ /* settled automatically for strike rate */ ]
}
```
Pair keys are order-independent (`A|B` === `B|A`) and auto-populated whenever a
result is logged for a race with 2+ shared runners. Helpers:
`strongestByHeadToHead(field)`, `headToHeadBetween(a,b)` in
`scripts/lib/formbook.js`.

### Porting your existing formbook
Put your current horse history under `horses` (keys = UPPERCASE names). Leave
`headToHead` empty `{}` and replay past results through `log-result` — the
head-to-head map rebuilds itself. Or just start logging from today.

---

## Scoring
See **`predict-race.md`**. 8 base factors + head-to-head vs today's field +
recency-weighted margins. All weights in `scripts/lib/scoring.js`.

## Notes on the results scrapers
Gold Circle and 4Racing sit behind Cloudflare and may block automated fetches.
The scraper uses browser-like headers and keeps all CSS selectors in one
`ADAPTERS` block (`scripts/pull-results.js`) for easy tuning — run with
`--debug` to dump the fetched HTML. The **results-inbox** path
(`data/results-inbox/*.json`) always works and is the reliable way to feed
results if the live scrape is blocked. Unmatched/renamed horses are logged to
`data/review/` instead of failing silently.

## Tests
```bash
npm test          # engine self-test (no network/git)
```
