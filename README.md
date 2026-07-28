# 🏏 Cricket Score Predictor — CSE-458 Final Lab Project

Innings final-score prediction from live match state, across **every format in
the Cricsheet archive** - T20/IT20, ODI/ODM, Test/MDM - including both innings
of limited-overs games and chases.

## What makes this different from the usual tutorial version

Most cricket score predictors on the internet report R² above 0.95. Almost all
of them are wrong, in the same way. They shuffle the **balls** and then split
into train/test. But the target (`final_score`) is a constant for every ball of
the same innings, so ball 12.3 in train and ball 12.4 in test are near-identical
rows with an identical answer. The model recalls the answer instead of
predicting it.

This project measures both numbers and shows the gap:

| split | what it means | result |
|---|---|---|
| random split on balls | the common, wrong way | flattering, meaningless |
| group split by match | balls of one match stay together | honest |
| **temporal split** | train on the past, test on the future | **honest and realistic** |

Every context feature — venue par score, team form, batter strike rate, bowler
economy — is computed **as of the match date**, using only earlier matches.
Career averages computed over the whole dataset would leak the future.

## One model across formats that look nothing alike

Two ideas do the work:

- `progress` = balls bowled / total balls in the innings. A T20 at ball 60 and
  an ODI at ball 150 are both halfway. Multi-day innings have no ball limit, so
  progress stays NaN and LightGBM routes those rows down their own branch.
- Every context feature - venue par, team form, batter strike rate, bowler
  economy - is computed **per format family** and as of the match date. A
  ground's ODI par is not its T20 par, and pooling them would be worse than
  having no feature at all.

Because a 30-run miss means something different in a Test than in a T20, the
headline number is deliberately not the overall MAE. Metrics are reported per
format and per quarter of the innings, in `reports/` and in the app.

To train a single-format model instead (useful for the viva question "does one
shared model cost you accuracy on T20?"), set `ONLY_FAMILY = "t20"` at the top
of `src/03_train.py` and run it both ways.

## Pipeline

```
all_json/*.json                    22,326 Cricsheet match files (git-ignored)
   │
   ├─ src/01_parse.py              → data/matches.parquet, data/deliveries.parquet
   ├─ src/02_features.py           → data/model_data.parquet   (leakage-safe)
   ├─ src/03_train.py              → models/*.txt, models/meta.json, reports/*
   └─ src/04_export_app_assets.py  → models/lookups.json, app/replay_sample.parquet
                                        │
                                        └─ app/main.py  (FastAPI: API + static site)
```

21,719 of those matches survive stage 2 — the rest are dropped as
rain-shortened, abandoned part-way, or otherwise not comparable.

## Quick start

The trained model and its lookups are committed, so the site runs without
rebuilding anything:

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
venv/bin/python -m uvicorn app.main:app --reload --port 8000
```

Then open <http://127.0.0.1:8000>.

To rebuild the model from the raw archive instead, put the Cricsheet JSON in
`all_json/` and run `./run_all.sh` first. Stages 1–3 take roughly 50 minutes;
stage 4 alone takes about a minute and is all you need if only the app assets
have changed.

## The web app

Five pages, served by FastAPI from `app/static/`. There is no second runtime —
the model is LightGBM and has to be served from Python, so a separate frontend
service would have meant two deployments and two cold starts.

| Page | What it does |
|---|---|
| `/` | What the project is, in one sentence, beside a live worked prediction. Headline figures are read from the API, never typed in. |
| `/predict.html` | The prediction tool: match setup, live state, result. Cascading filters, searchable fields, inline validation, saved history. |
| `/replay.html` | Ball-by-ball replay of a real innings with a hover readout, playback controls, and a table of the balls that mattered. |
| `/results.html` | The full evaluation report — error by format and by phase, the leakage comparison, interval calibration, feature importance. |
| `/about.html` | Method and an honest account of the limits. |

```
app/
  main.py                 FastAPI: API + StaticFiles mount
  replay_sample.parquet   ball-by-ball rows for the replay demo
  static/
    index.html  predict.html  replay.html  results.html  about.html
    css/  tokens.css  base.css  components.css  predict.css  replay.css  results.css
    js/   api.js  nav.js  combobox.js  history.js
          home.js  about.js  predict.js  replay.js  results.js
```

`tokens.css` is the only file allowed to name a colour, a size or a duration.
Everything else reads its custom properties, which is what makes the light and
dark themes a single source of truth rather than two stylesheets.

### API

| Endpoint | Returns |
|---|---|
| `GET /api/meta` | Dropdown lists and headline metrics per format |
| `GET /api/options?family=&event=` | Team, venue and competition lists scoped to one format + competition, plus each venue's city |
| `GET /api/report` | Everything `results.html` renders |
| `POST /api/predict` | One prediction from a manual match state |
| `GET /api/matches` | Innings available for replay |
| `GET /api/replay/{id}` | Ball-by-ball predictions for one real innings |

Overs are sent as two integers — `overs_completed` and `balls_this_over`
(0–5) — not one float. An over is six legal balls, so `11.7` describes nothing
that can happen on a field; as a float it silently rounded to a real state and
the model answered as though the input made sense. It is now a 422 with a
message explaining the rule.

### Nothing on the site is a typed-in number

Every figure the pages show comes from the API at runtime. A test asserts that
none of the 39 values `/api/report` supplies appears anywhere in the served
HTML, so retraining the model updates the site by itself and cannot leave a
stale number behind on the page that reports it.

## Prediction intervals

Quantile regression alone came out under-covered (a nominal 80% band caught far
fewer than 80% of outcomes). So the interval is calibrated by
**split-conformal** correction: residual percentiles measured on the validation
set, per phase of the innings, added to the point prediction. Coverage lands
near nominal, and the band visibly narrows as the innings runs out of balls.

## Honest limits

- No weather, pitch report, or team-sheet data — none of it is reliably free.
- Rain-shortened limited-overs innings are dropped: a total from 12 overs is
  not comparable to one from 20.
- Chases are included, with `is_chase`, `target_runs` and `runs_needed` as
  features - but a chase ends the moment the target is passed, so its final
  score is a censored observation rather than "how many they could have made".
- Multi-day innings are thinned to every 4th ball. They run to thousands of
  deliveries and would otherwise dominate the loss by sheer row count.
- Cricsheet withholds a small number of matches, so the archive is not literally
  every match ever played.
- A side or ground the model never saw in training falls back to a format-wide
  average. The prediction still looks confident and is worth considerably less.

`/about.html` says all of this in full, and quotes no accuracy figure anywhere.

## Deployment

One Render service, no build step beyond `pip install`:

```yaml
startCommand: uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

`models/` and `app/replay_sample.parquet` are committed because the deployed
app needs both and regenerating them costs a full retrain. On a free tier the
first request after idling pays a cold start while the 4.6 MB booster and the
replay parquet load into memory.

## Credits

Built on an existing baseline — the parsing, feature engineering and training
pipeline in `src/01_parse.py`, `src/02_features.py` and `src/03_train.py`,
which this project uses unmodified.

<!-- TODO: replace this line with the correct name and attribution wording. -->

The web layer (`app/static/`), the API additions in `app/main.py`, and the
competition-scoped exports in `src/04_export_app_assets.py` were built on top
of that baseline.

## Reading the code

`AGENTS.md` is the file to read before changing anything — it records the
decisions that look wrong without their reasoning, including why the split
must stay temporal and why the leakage demonstration in `src/03_train.py` is
the point of the project rather than dead code.
