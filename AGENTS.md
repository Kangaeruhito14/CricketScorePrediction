# AGENTS.md — context for AI agents working in this repo

Read this before changing anything. Most of the value in this project is in
decisions that look wrong if you don't know why they were made.

## What this is

Innings final-score prediction for cricket, across every format in the
Cricsheet archive (T20/IT20, ODI/ODM, Test/MDM), from the live state of an
innings. LightGBM on ~7.4M ball-level rows. FastAPI + a single static HTML page
for the demo.

## Non-negotiable rules

**1. Never split the data randomly.**
`final_score` is constant across every ball of one innings. A random split puts
ball 12.3 in train and ball 12.4 in test — nearly identical rows with the same
answer — and the model recalls instead of predicting. The split must be
temporal (train on the past, test on the future). `GroupShuffleSplit` by
`match_id` is acceptable as a secondary check. Both are already implemented in
`src/03_train.py`; the random split there is a deliberate demonstration of the
inflation and must stay labelled as such.

**2. Never compute a context feature over the whole dataset.**
Venue par score, team form, batter strike rate, bowler economy are all
expanding means **shifted by one match**, so a row only ever sees matches that
happened before it. Replacing any of these with a plain `groupby().mean()`
would leak the future and silently inflate every metric.

**3. Context features are computed per format family, not globally.**
A ground's ODI par is not its T20 par. A batter's Test strike rate is not his
T20 strike rate. Pooling them is worse than having no feature.

**4. Do not report a single headline MAE.**
Error scales with how many runs a format produces. Metrics are reported per
format and per quarter of the innings. Keep it that way.

## Pipeline

```
all_json/*.json          ~22,300 Cricsheet match files (git-ignored)
 ├─ src/01_parse.py             → data/matches.parquet, data/deliveries.parquet
 ├─ src/02_features.py          → data/model_data.parquet
 ├─ src/03_train.py             → models/*.txt, models/meta.json, reports/*
 └─ src/04_export_app_assets.py → models/lookups.json, app/replay_sample.parquet
                                    └─ app/main.py (FastAPI)
```

Stage 1 takes ~10 min, stage 2 ~10 min, stage 3 ~30 min. Do not re-run stage 1
unless the raw JSON changed.

## Gotchas already hit, do not reintroduce

- A LightGBM `Dataset` frees its raw data after the first `train()` call.
  Reusing one for a second model with `categorical_feature` set raises
  *"Cannot set categorical feature after freed raw data"*. Every model builds
  its own Dataset via `make_ds()`.
- `wickets_left * balls_left` overflows `int8`. Keep it `int32`.
- Wides and no-balls are not legal deliveries. Ball counting uses `is_legal`,
  never `over * 6 + ball_number`.
- The app builds a feature row by hand in `state_to_row()`. Its defaults must
  come from `defaults_by_family` in `lookups.json`, not a global median — a
  global median hands a T20 row a Test batter's strike rate and the model
  answers with a Test-sized score.
- `event` matters a lot to the model. Leaving it empty produces bad
  predictions, which is why the UI has a competition dropdown.
- Jinja2Templates broke on the installed Starlette version. The page is served
  as a static string instead. Do not reintroduce a template engine.

## Things worth doing

- `ONLY_FAMILY` at the top of `src/03_train.py` trains a single-format model.
  Running it as `"t20"` and comparing against the T20 row of the shared model
  answers "does one model across formats cost accuracy?" with a number.
- Ball-level rolling player form (last 100 balls) instead of career-to-date.
- A second-innings win-probability model using `target_runs` and `runs_needed`.

## Do not

- Do not commit `all_json/`, `data/*.parquet`, or `venv/`.
- Do not delete `models/` or `app/replay_sample.parquet` — the deployed app
  needs both, and regenerating them costs a full retrain.
- Do not "clean up" the leakage demonstration in `src/03_train.py`. It is the
  point of the project, not dead code.
