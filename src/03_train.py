"""
STAGE 3 — Training + honest evaluation, ALL FORMATS

Trains:
  1. main model     LightGBM regression -> point prediction
  2. lower / upper  LightGBM quantile   -> raw 80% band
  3. conformal      residual percentiles per (format, phase) -> calibrated band
  4. leakage demo   the same model on a random split, to show the inflation

Note on a crash that is easy to hit: a LightGBM Dataset frees its raw data
after the first train() call, so reusing it for a second model with
categorical_feature set raises
    "Cannot set categorical feature after freed raw data".
Every model below therefore builds its own Dataset via make_ds().

Run:  python src/03_train.py
"""
import os
import json
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.metrics import mean_absolute_error, r2_score, mean_squared_error
from sklearn.model_selection import GroupShuffleSplit

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MODELS = os.path.join(ROOT, "models")
REPORTS = os.path.join(ROOT, "reports")
os.makedirs(MODELS, exist_ok=True)
os.makedirs(REPORTS, exist_ok=True)

CAT_COLS = ["match_type", "family", "batting_team", "bowling_team",
            "venue", "event", "gender"]
NUM_COLS = [
    "year", "innings", "current_score", "balls_bowled", "balls_left",
    "total_balls_f", "progress", "wickets_left", "crr",
    "last30_runs", "last30_wkts", "fours", "sixes",
    "dot_pct", "boundary_pct", "resource",
    "is_chase", "target_runs", "runs_needed", "bat_won_toss",
    "venue_par", "venue_n", "batteam_par", "bowlteam_par",
    "bat_sr", "bat_balls", "bowl_econ", "bowl_sr", "bowl_balls",
]
FEATURES = CAT_COLS + NUM_COLS
TARGET = "final_score"

PARAMS = dict(
    objective="regression", metric="l1",
    learning_rate=0.05, num_leaves=255, min_data_in_leaf=200,
    feature_fraction=0.85, bagging_fraction=0.85, bagging_freq=1,
    lambda_l2=2.0, max_cat_threshold=64, cat_smooth=20,
    verbose=-1, n_jobs=-1, seed=42,
)
N_ROUNDS = 4000
EARLY_STOP = 150

# Set to "t20", "odi" or "multiday" to train a single-format model instead of
# one shared across every format. Useful for the viva question "does one model
# for all formats cost you accuracy on T20?" - run it both ways and compare.
ONLY_FAMILY = None

PHASE_NAMES = {0: "first quarter", 1: "second quarter",
               2: "third quarter", 3: "final quarter", 4: "no ball limit"}


def prep(df):
    df = df.copy()
    for c in CAT_COLS:
        df[c] = df[c].astype("category")
    return df


def align_cats(train_df, other_df):
    """Force the same category dictionary so LightGBM sees consistent codes."""
    other_df = other_df.copy()
    for c in CAT_COLS:
        cats = train_df[c].cat.categories
        v = other_df[c].astype(object)
        other_df[c] = pd.Categorical(v.where(v.isin(cats)), categories=cats)
    return other_df


def make_ds(df, reference=None):
    """A fresh Dataset every time. Reusing one across train() calls crashes."""
    return lgb.Dataset(df[FEATURES], df[TARGET],
                       categorical_feature=CAT_COLS,
                       reference=reference, free_raw_data=False)


def phase_of(progress):
    """Quarter of the innings. Bucket 4 = multi-day, where there is no limit."""
    p = np.asarray(progress, dtype=float)
    out = np.select([p < 0.30, p < 0.55, p < 0.80, p <= 1.01],
                    [0, 1, 2, 3], default=4)
    return np.where(np.isnan(p), 4, out).astype(int)


def metrics_table(df, y_true, y_pred, by):
    rows = []
    for keyval, sub in df.groupby(by, observed=True):
        m = sub.index
        yt, yp = y_true[m], y_pred[m]
        if len(m) < 30:
            continue
        rows.append({
            "group": str(keyval),
            "n": int(len(m)),
            "MAE": round(float(mean_absolute_error(yt, yp)), 2),
            "RMSE": round(float(np.sqrt(mean_squared_error(yt, yp))), 2),
            "R2": round(float(r2_score(yt, yp)), 3),
        })
    return pd.DataFrame(rows)


def main():
    df = pd.read_parquet(os.path.join(DATA, "model_data.parquet"))
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date", kind="mergesort").reset_index(drop=True)
    if ONLY_FAMILY:
        df = df[df["family"] == ONLY_FAMILY].reset_index(drop=True)
        print(f"[i] restricted to family = {ONLY_FAMILY}")
    df["phase"] = phase_of(df["progress"].values)
    print(f"[i] rows={len(df):,}  innings={df.groupby(['match_id','innings']).ngroups:,}")
    print("[i] rows per family:\n" + df["family"].value_counts().to_string())

    # ---------------- TEMPORAL SPLIT (the correct one) ----------------
    md = df.groupby("match_id", observed=True)["date"].first().sort_values()
    n = len(md)
    tr_ids = set(md.index[: int(n * 0.70)])
    va_ids = set(md.index[int(n * 0.70): int(n * 0.85)])
    te_ids = set(md.index[int(n * 0.85):])

    tr = prep(df[df["match_id"].isin(tr_ids)]).reset_index(drop=True)
    va = align_cats(tr, prep(df[df["match_id"].isin(va_ids)])).reset_index(drop=True)
    te = align_cats(tr, prep(df[df["match_id"].isin(te_ids)])).reset_index(drop=True)

    print(f"\n[i] train {len(tr_ids):,} matches  ({tr['date'].min().date()} .. {tr['date'].max().date()})")
    print(f"[i] valid {len(va_ids):,} matches  ({va['date'].min().date()} .. {va['date'].max().date()})")
    print(f"[i] test  {len(te_ids):,} matches  ({te['date'].min().date()} .. {te['date'].max().date()})")

    print("\n[1/4] Training main model ...")
    dtr = make_ds(tr)
    dva = make_ds(va, reference=dtr)
    model = lgb.train(PARAMS, dtr, num_boost_round=N_ROUNDS,
                      valid_sets=[dva], valid_names=["valid"],
                      callbacks=[lgb.early_stopping(EARLY_STOP, verbose=False),
                                 lgb.log_evaluation(250)])
    best = model.best_iteration
    print(f"      best iteration: {best}")

    yte = te[TARGET].values
    pred_te = model.predict(te[FEATURES], num_iteration=best)
    mae = mean_absolute_error(yte, pred_te)
    r2 = r2_score(yte, pred_te)
    print(f"\n  OVERALL HONEST TEST:  MAE = {mae:.2f}   R2 = {r2:.3f}")
    print("  (overall is a blend of formats - the per-format table below is the real story)")

    fam_tbl = metrics_table(te, yte, pred_te, "family")
    print("\n  BY FORMAT")
    print(fam_tbl.to_string(index=False))

    te2 = te.copy()
    te2["fam_phase"] = (te2["family"].astype(str) + " | "
                        + te2["phase"].map(PHASE_NAMES).astype(str))
    ph_tbl = metrics_table(te2, yte, pred_te, "fam_phase").sort_values("group")
    print("\n  BY FORMAT AND STAGE OF INNINGS")
    print(ph_tbl.to_string(index=False))

    # ---------------- QUANTILE MODELS ----------------
    print("\n[2/4] Training quantile models (10% / 90%) ...")
    qmodels = {}
    for alpha, name in [(0.10, "lower"), (0.90, "upper")]:
        # Lighter than the main model on purpose: the calibrated interval
        # comes from the conformal step below, so these two only need to be
        # good enough to show that raw quantile regression under-covers.
        p = dict(PARAMS)
        p.update(objective="quantile", alpha=alpha, metric="quantile",
                 num_leaves=63, learning_rate=0.08)
        qm = lgb.train(p, make_ds(tr), num_boost_round=min(max(best, 150), 300),
                       valid_sets=[make_ds(va)],
                       callbacks=[lgb.early_stopping(80, verbose=False)])
        qmodels[name] = qm
        print(f"      {name} (alpha={alpha}) best_iter={qm.best_iteration}")

    lo = qmodels["lower"].predict(te[FEATURES], num_iteration=qmodels["lower"].best_iteration)
    hi = qmodels["upper"].predict(te[FEATURES], num_iteration=qmodels["upper"].best_iteration)
    cov_q = float(((yte >= lo) & (yte <= hi)).mean())
    print(f"      raw quantile coverage: {cov_q*100:.1f}%  (target 80%)")

    # ---------------- CONFORMAL CALIBRATION ----------------
    print("\n[3/4] Conformal calibration of the interval ...")
    pred_va = model.predict(va[FEATURES], num_iteration=best)
    res_va = va[TARGET].values - pred_va
    kv = (va["family"].astype(str) + "|" + va["phase"].astype(str)).values
    kt = (te["family"].astype(str) + "|" + te["phase"].astype(str)).values

    conformal, fallback = {}, [float(np.percentile(res_va, 10)),
                               float(np.percentile(res_va, 90))]
    for k in np.unique(kv):
        r = res_va[kv == k]
        if len(r) >= 200:
            conformal[k] = [float(np.percentile(r, 10)),
                            float(np.percentile(r, 90))]
    c_lo = np.array([conformal.get(k, fallback)[0] for k in kt]) + pred_te
    c_hi = np.array([conformal.get(k, fallback)[1] for k in kt]) + pred_te
    cov_c = float(((yte >= c_lo) & (yte <= c_hi)).mean())
    print(f"      conformal coverage   : {cov_c*100:.1f}%  (target 80%, "
          f"mean width {np.mean(c_hi - c_lo):.0f} runs)")

    # ---------------- LEAKAGE DEMO ----------------
    print("\n[4/4] Leakage demonstration ...")
    dall = prep(df)
    rs = np.random.RandomState(42)
    idx = rs.permutation(len(dall))
    cut = int(len(dall) * 0.8)
    lk_tr = dall.iloc[idx[:cut]].reset_index(drop=True)
    lk_te = align_cats(lk_tr, dall.iloc[idx[cut:]]).reset_index(drop=True)
    lk_model = lgb.train(PARAMS, make_ds(lk_tr), num_boost_round=best)
    lk_pred = lk_model.predict(lk_te[FEATURES])
    lk_mae = mean_absolute_error(lk_te[TARGET], lk_pred)
    lk_r2 = r2_score(lk_te[TARGET], lk_pred)

    gss = GroupShuffleSplit(n_splits=1, test_size=0.2, random_state=42)
    gi, gj = next(gss.split(dall, groups=dall["match_id"]))
    g_tr = dall.iloc[gi].reset_index(drop=True)
    g_te = align_cats(g_tr, dall.iloc[gj]).reset_index(drop=True)
    g_model = lgb.train(PARAMS, make_ds(g_tr), num_boost_round=best)
    g_mae = mean_absolute_error(g_te[TARGET], g_model.predict(g_te[FEATURES]))

    print(f"      LEAKY random split  : MAE = {lk_mae:.2f}  R2 = {lk_r2:.3f}   <-- inflated")
    print(f"      GroupSplit by match : MAE = {g_mae:.2f}")
    print(f"      HONEST time split   : MAE = {mae:.2f}  R2 = {r2:.3f}   <-- the real number")

    # ---------------- SAVE ----------------
    model.save_model(os.path.join(MODELS, "lgb_main.txt"))
    qmodels["lower"].save_model(os.path.join(MODELS, "lgb_lower.txt"))
    qmodels["upper"].save_model(os.path.join(MODELS, "lgb_upper.txt"))

    meta = {
        "features": FEATURES, "cat_cols": CAT_COLS, "num_cols": NUM_COLS,
        "categories": {c: [str(x) for x in tr[c].cat.categories] for c in CAT_COLS},
        "phase_names": {str(k): v for k, v in PHASE_NAMES.items()},
        "test_mae": round(float(mae), 2),
        "test_r2": round(float(r2), 3),
        "interval_coverage_quantile": round(cov_q, 3),
        "interval_coverage_conformal": round(cov_c, 3),
        "conformal_offsets": conformal,
        "conformal_fallback": fallback,
        "leaky_random_split_mae": round(float(lk_mae), 2),
        "leaky_random_split_r2": round(float(lk_r2), 3),
        "group_split_mae": round(float(g_mae), 2),
        "only_family": ONLY_FAMILY,
        "n_train_matches": len(tr_ids), "n_test_matches": len(te_ids),
        "train_end": str(tr["date"].max().date()),
        "format_table": fam_tbl.to_dict(orient="records"),
        "phase_table": ph_tbl.to_dict(orient="records"),
        "defaults": {
            "bat_sr": float(tr["bat_sr"].median(skipna=True)),
            "bowl_econ": float(tr["bowl_econ"].median(skipna=True)),
            "bowl_sr": float(tr["bowl_sr"].median(skipna=True)),
        },
    }
    with open(os.path.join(MODELS, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)

    imp = pd.DataFrame({"feature": model.feature_name(),
                        "gain": model.feature_importance("gain")}
                       ).sort_values("gain", ascending=False)
    imp.to_csv(os.path.join(REPORTS, "feature_importance.csv"), index=False)
    fam_tbl.to_csv(os.path.join(REPORTS, "format_metrics.csv"), index=False)
    ph_tbl.to_csv(os.path.join(REPORTS, "phase_metrics.csv"), index=False)

    print("\n  Top 15 features by gain:")
    print(imp.head(15).to_string(index=False))
    print("\n=========== STAGE 3 DONE ===========")


if __name__ == "__main__":
    main()
