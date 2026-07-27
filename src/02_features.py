"""
STAGE 2 — Feature engineering, ALL FORMATS (leakage-safe)

Covers every match type in the Cricsheet archive: T20 / IT20, ODI / ODM,
Test / MDM, and anything else present. One row per delivery of every innings.
Target = the score that innings finished on.

Two ideas let one model span formats that look nothing alike:

  1. `progress` = balls bowled / total balls in the innings. A T20 at ball 60
     and an ODI at ball 150 are both halfway, and the model can see that.
     Multi-day innings have no ball limit, so progress stays NaN and LightGBM
     routes those rows down its own branch.

  2. Every context feature (venue par, team form, player form) is computed
     PER FORMAT FAMILY and as of the match date. A ground's par score in an
     ODI is not its par score in a T20, and a batter's Test strike rate is not
     his T20 strike rate. Pooling them would be worse than no feature at all.

Run:  python src/02_features.py
"""
import os
import gc
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")

# Every ball of a short innings is kept. Multi-day innings run to thousands of
# balls and would dominate the training loss purely by row count, so those are
# thinned. Set LONG_INNINGS_STRIDE = 1 to keep every single ball.
LONG_INNINGS_BALLS = 400
LONG_INNINGS_STRIDE = 4

MIN_BALLS_UNLIMITED = 60      # a multi-day innings must have some substance
COMPLETE_FRACTION = 0.95      # limited-overs innings must be ~fully bowled
ROLL_WINDOW = 30              # "recent scoring" = last 30 deliveries


def family_of(total_balls):
    """Group formats by innings length rather than by their label."""
    tb = np.asarray(total_balls)
    return np.select(
        [tb <= 0, tb <= 130, tb <= 400],
        ["multiday", "t20", "odi"],
        default="long_limited",
    )


def asof_mean(df, keys, value, date_col="date"):
    """Expanding mean of `value` within `keys`, using only earlier matches."""
    df = df.sort_values(date_col, kind="mergesort")
    return (df.groupby(keys, observed=True)[value]
              .transform(lambda s: s.shift(1).expanding().mean()))


def main():
    print("[1/8] Loading parquet ...")
    matches = pd.read_parquet(os.path.join(DATA, "matches.parquet"))
    matches["date"] = pd.to_datetime(matches["date"], errors="coerce")
    matches = matches.dropna(subset=["date"])
    matches["total_balls"] = (matches["max_overs"].astype("int32")
                              * matches["balls_per_over"].astype("int32"))
    matches["family"] = family_of(matches["total_balls"].values)
    print("      matches by family:")
    print(matches["family"].value_counts().to_string())

    d = pd.read_parquet(os.path.join(DATA, "deliveries.parquet"))
    if "match_type" in d.columns:
        d = d.drop(columns=["match_type"])
    d = d[d["match_id"].isin(set(matches["match_id"]))]
    print(f"      deliveries: {len(d):,}")

    d = d.merge(
        matches[["match_id", "date", "match_type", "family", "total_balls",
                 "venue", "city", "event", "gender", "toss_winner"]],
        on="match_id", how="left")

    # ---------- per-innings summary: the target, and completeness ----------
    print("[2/8] Innings summaries ...")
    key = ["match_id", "innings"]
    summ = (d.groupby(key, observed=True)
              .agg(final_score=("runs_total", "sum"),
                   legal_balls=("is_legal", "sum"),
                   wkts=("wicket", "sum"),
                   target=("target", "max"),
                   total_balls=("total_balls", "first"))
              .reset_index())

    has_limit = summ["total_balls"] > 0
    is_chase = summ["target"] > 0
    complete = (
        (summ["wkts"] >= 10)
        | (has_limit & (summ["legal_balls"] >= COMPLETE_FRACTION * summ["total_balls"]))
        | (is_chase & (summ["final_score"] >= summ["target"]))
        | (~has_limit & (summ["legal_balls"] >= MIN_BALLS_UNLIMITED))
    )
    summ = summ[complete].reset_index(drop=True)
    print(f"      usable innings: {len(summ):,}")

    d = d.merge(summ[key], on=key, how="inner")
    gc.collect()

    # ---------- as-of-date player form, PER FORMAT FAMILY ----------
    print("[3/8] Player form (per format family, as-of-date) ...")
    bat = (d.groupby(["family", "batter", "match_id", "date"], observed=True)
             .agg(r=("runs_batter", "sum"), b=("is_legal", "sum"))
             .reset_index().sort_values("date", kind="mergesort"))
    g = bat.groupby(["family", "batter"], observed=True)
    bat["cr"] = g["r"].transform(lambda s: s.shift(1).cumsum())
    bat["cb"] = g["b"].transform(lambda s: s.shift(1).cumsum())
    bat["bat_sr"] = 100.0 * bat["cr"] / bat["cb"].replace(0, np.nan)
    bat["bat_balls"] = bat["cb"].fillna(0)
    bat_feat = bat[["batter", "match_id", "bat_sr", "bat_balls"]].copy()
    del bat, g
    gc.collect()

    bowl = (d.groupby(["family", "bowler", "match_id", "date"], observed=True)
              .agg(rc=("runs_total", "sum"), b=("is_legal", "sum"),
                   w=("wicket", "sum"))
              .reset_index().sort_values("date", kind="mergesort"))
    g = bowl.groupby(["family", "bowler"], observed=True)
    bowl["crc"] = g["rc"].transform(lambda s: s.shift(1).cumsum())
    bowl["cb"] = g["b"].transform(lambda s: s.shift(1).cumsum())
    bowl["cw"] = g["w"].transform(lambda s: s.shift(1).cumsum())
    bowl["bowl_econ"] = 6.0 * bowl["crc"] / bowl["cb"].replace(0, np.nan)
    bowl["bowl_sr"] = bowl["cb"] / bowl["cw"].replace(0, np.nan)
    bowl["bowl_balls"] = bowl["cb"].fillna(0)
    bowl_feat = bowl[["bowler", "match_id", "bowl_econ", "bowl_sr",
                      "bowl_balls"]].copy()
    del bowl, g
    gc.collect()

    # ---------- in-innings running state ----------
    print("[4/8] In-innings state ...")
    d = d.sort_values(["match_id", "innings", "over", "ball_in_over"],
                      kind="mergesort").reset_index(drop=True)
    grp = d.groupby(key, observed=True)
    d["balls_bowled"] = grp["is_legal"].cumsum().astype("int32")
    d["current_score"] = grp["runs_total"].cumsum().astype("int32")
    d["wickets_lost"] = grp["wicket"].cumsum().astype("int16")

    d["is_four"] = (d["runs_batter"] == 4).astype("int8")
    d["is_six"] = (d["runs_batter"] == 6).astype("int8")
    d["is_dot"] = ((d["runs_total"] == 0) & (d["is_legal"] == 1)).astype("int8")
    grp = d.groupby(key, observed=True)
    d["fours"] = grp["is_four"].cumsum().astype("int32")
    d["sixes"] = grp["is_six"].cumsum().astype("int32")
    d["dots"] = grp["is_dot"].cumsum().astype("int32")
    d["last30_runs"] = (grp["runs_total"].rolling(ROLL_WINDOW, min_periods=1)
                        .sum().reset_index(level=[0, 1], drop=True)
                        ).astype("float32")
    d["last30_wkts"] = (grp["wicket"].rolling(ROLL_WINDOW, min_periods=1)
                        .sum().reset_index(level=[0, 1], drop=True)
                        ).astype("float32")

    # keep only legal deliveries, and only after a few balls of signal
    d = d[(d["is_legal"] == 1) & (d["balls_bowled"] >= 6)]

    # thin very long innings so multi-day cricket does not swamp the loss
    print("[5/8] Thinning long innings ...")
    d = d.merge(summ[key + ["legal_balls"]], on=key, how="left")
    keep = ((d["legal_balls"] <= LONG_INNINGS_BALLS)
            | (d["balls_bowled"] % LONG_INNINGS_STRIDE == 0))
    d = d[keep].copy()
    print(f"      rows after thinning: {len(d):,}")
    gc.collect()

    # ---------- derived numeric features ----------
    tb = d["total_balls"].astype("float32")
    d["total_balls_f"] = tb.where(tb > 0, np.nan)
    d["balls_left"] = (d["total_balls_f"] - d["balls_bowled"]).clip(lower=0)
    d["progress"] = (d["balls_bowled"] / d["total_balls_f"]).astype("float32")
    d["wickets_left"] = (10 - d["wickets_lost"]).clip(lower=0).astype("int32")
    d["crr"] = (6.0 * d["current_score"] / d["balls_bowled"]).astype("float32")
    d["dot_pct"] = (d["dots"] / d["balls_bowled"]).astype("float32")
    d["boundary_pct"] = ((d["fours"] + d["sixes"])
                         / d["balls_bowled"]).astype("float32")
    d["resource"] = (d["wickets_left"] * d["balls_left"]).astype("float32")
    d["is_chase"] = (d["target"] > 0).astype("int8")
    d["target_runs"] = d["target"].astype("float32")
    d["runs_needed"] = np.where(
        d["is_chase"] == 1,
        (d["target_runs"] - d["current_score"]).clip(lower=0), np.nan
    ).astype("float32")
    d["bat_won_toss"] = (d["toss_winner"] == d["batting_team"]).astype("int8")

    # ---------- as-of-date venue / team par, PER FORMAT FAMILY ----------
    print("[6/8] Venue & team par (per format family, as-of-date) ...")
    ms = summ.merge(matches[["match_id", "date", "venue", "family"]],
                    on="match_id", how="left")
    firsts = (d.groupby(key, observed=True)
                .agg(bat_team=("batting_team", "first"),
                     bowl_team=("bowling_team", "first"))
                .reset_index())
    ms = ms.merge(firsts, on=key, how="inner")
    ms = ms.sort_values("date", kind="mergesort").reset_index(drop=True)

    ms["venue_par"] = asof_mean(ms, ["venue", "family"], "final_score")
    ms["batteam_par"] = asof_mean(ms, ["bat_team", "family"], "final_score")
    ms["bowlteam_par"] = asof_mean(ms, ["bowl_team", "family"], "final_score")
    fam_mean = asof_mean(ms, ["family"], "final_score")
    fam_overall = ms.groupby("family", observed=True)["final_score"].transform("mean")
    for c in ["venue_par", "batteam_par", "bowlteam_par"]:
        ms[c] = ms[c].fillna(fam_mean).fillna(fam_overall)
    ms["venue_n"] = ms.groupby(["venue", "family"], observed=True).cumcount()

    d = d.merge(ms[key + ["final_score", "venue_par", "venue_n",
                          "batteam_par", "bowlteam_par"]],
                on=key, how="inner")
    d["year"] = d["date"].dt.year.astype("int16")

    # ---------- attach player form ----------
    print("[7/8] Attaching player form ...")
    d = d.merge(bat_feat, on=["batter", "match_id"], how="left")
    d = d.merge(bowl_feat, on=["bowler", "match_id"], how="left")
    d["bat_balls"] = d["bat_balls"].fillna(0).astype("float32")
    d["bowl_balls"] = d["bowl_balls"].fillna(0).astype("float32")
    # bat_sr / bowl_econ / bowl_sr stay NaN for debutants. That is real
    # information, and LightGBM handles missing values natively.

    # ---------- write ----------
    print("[8/8] Writing model_data.parquet ...")
    cols = [
        "match_id", "innings", "date", "year",
        "match_type", "family", "batting_team", "bowling_team",
        "venue", "city", "event", "gender",
        "current_score", "balls_bowled", "balls_left", "total_balls_f",
        "progress", "wickets_left", "crr", "last30_runs", "last30_wkts",
        "fours", "sixes", "dot_pct", "boundary_pct", "resource",
        "is_chase", "target_runs", "runs_needed", "bat_won_toss",
        "venue_par", "venue_n", "batteam_par", "bowlteam_par",
        "bat_sr", "bat_balls", "bowl_econ", "bowl_sr", "bowl_balls",
        "final_score",
    ]
    missing = [c for c in cols if c not in d.columns]
    if missing:
        raise RuntimeError(f"missing columns: {missing}")
    out = d[cols].dropna(subset=["final_score"]).reset_index(drop=True)
    for c in ["family", "match_type"]:
        out[c] = out[c].astype(str)

    path = os.path.join(DATA, "model_data.parquet")
    out.to_parquet(path, index=False, compression="zstd")

    print("\n=========== STAGE 2 DONE ===========")
    print(f"  rows    : {len(out):,}")
    print(f"  innings : {out.groupby(key).ngroups:,}")
    print(f"  dates   : {out['date'].min().date()} .. {out['date'].max().date()}")
    print("\n  rows per format family:")
    print(out["family"].value_counts().to_string())
    print("\n  mean innings total by family:")
    print(out.groupby("family", observed=True)["final_score"]
          .mean().round(1).to_string())
    print(f"\n  -> {path}  ({os.path.getsize(path)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
