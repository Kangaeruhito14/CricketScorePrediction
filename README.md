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
all_json/*.json                    ~22,400 Cricsheet match files
   │
   ├─ src/01_parse.py              → data/matches.parquet, data/deliveries.parquet
   ├─ src/02_features.py           → data/model_data.parquet   (leakage-safe)
   ├─ src/03_train.py              → models/*.txt, models/meta.json, reports/*
   └─ src/04_export_app_assets.py  → models/lookups.json, app/replay_sample.parquet
                                        │
                                        └─ app/main.py  (FastAPI web GUI)
```

## Quick start

```bash
python3 -m venv venv && source venv/bin/activate
pip install -r requirements.txt
./run_all.sh
uvicorn app.main:app --reload --port 8000
```

Then open <http://127.0.0.1:8000>.

## The web app

- **Predict** — enter the live match state, get a final-score estimate plus an
  80% band.
- **Replay a real match** — pick a match the model never trained on and watch
  the prediction move ball by ball against the actual final score. This is the
  demo worth showing.
- **Model honesty** — per-phase error table and the leakage comparison.

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
