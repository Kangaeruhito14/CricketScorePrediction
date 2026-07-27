"""
STAGE 4 — Export what the web app needs (all formats)

Writes:
  models/lookups.json        dropdowns + latest as-of-date par values,
                             keyed by (venue, format family)
  app/replay_sample.parquet  ball-by-ball rows for recent innings across every
                             format, used by the "replay a real match" demo

Run:  python src/04_export_app_assets.py
"""
import os
import json
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MODELS = os.path.join(ROOT, "models")
APP = os.path.join(ROOT, "app")
os.makedirs(APP, exist_ok=True)

REPLAY_PER_FAMILY = 120       # recent innings kept per format for the demo


def main():
    df = pd.read_parquet(os.path.join(DATA, "model_data.parquet"))
    df["date"] = pd.to_datetime(df["date"])
    df = df.sort_values("date", kind="mergesort")

    key = ["match_id", "innings"]
    head = df.groupby(key, observed=True).first().reset_index()
    head = head.sort_values("date", kind="mergesort")

    # ---- latest as-of-date par per (venue, family) and per (team, family) --
    vp = (head.groupby(["venue", "family"], observed=True)
          .agg(par=("venue_par", "last"), n=("venue_n", "last"),
               cnt=("match_id", "count")).reset_index())
    vp = vp[vp["cnt"] >= 3]

    bp = (head.groupby(["batting_team", "family"], observed=True)["batteam_par"]
          .last().reset_index())
    wp = (head.groupby(["bowling_team", "family"], observed=True)["bowlteam_par"]
          .last().reset_index())

    fam_par = head.groupby("family", observed=True)["final_score"].mean().to_dict()
    fam_balls = (head.groupby("family", observed=True)["total_balls_f"]
                 .median().to_dict())

    families = sorted(head["family"].unique().tolist())
    lookups = {
        "families": families,
        "match_types": sorted(head["match_type"].unique().tolist()),
        "teams_by_family": {f: sorted(set(
            head.loc[head["family"] == f, "batting_team"]).union(
            head.loc[head["family"] == f, "bowling_team"]))
            for f in families},
        "venues_by_family": {f: sorted(vp.loc[vp["family"] == f, "venue"].tolist())
                             for f in families},
        "events_by_family": {f: sorted(
            head.loc[head["family"] == f, "event"].dropna().unique().tolist())
            for f in families},
        "match_type_by_family": {f: head.loc[head["family"] == f, "match_type"]
                                 .mode().iloc[0] for f in families},
        "venue_par": {f"{r.venue}||{r.family}": [float(r.par), int(r.n)]
                      for r in vp.itertuples()},
        "bat_par": {f"{r.batting_team}||{r.family}": float(r.batteam_par)
                    for r in bp.itertuples()},
        "bowl_par": {f"{r.bowling_team}||{r.family}": float(r.bowlteam_par)
                     for r in wp.itertuples()},
        "family_par": {k: float(v) for k, v in fam_par.items()},
        "family_total_balls": {k: (None if pd.isna(v) else float(v))
                               for k, v in fam_balls.items()},
        # Medians per format. Using one global median would hand a T20 row a
        # Test batter's strike rate, and the model would answer accordingly.
        "defaults_by_family": {
            f: {
                "bat_sr": float(df.loc[df["family"] == f, "bat_sr"].median(skipna=True)),
                "bowl_econ": float(df.loc[df["family"] == f, "bowl_econ"].median(skipna=True)),
                "bowl_sr": float(df.loc[df["family"] == f, "bowl_sr"].median(skipna=True)),
                "bat_balls": float(df.loc[df["family"] == f, "bat_balls"].median()),
                "bowl_balls": float(df.loc[df["family"] == f, "bowl_balls"].median()),
                "dot_pct": float(df.loc[df["family"] == f, "dot_pct"].median()),
                "last30_wkts": float(df.loc[df["family"] == f, "last30_wkts"].median()),
            } for f in families
        },
        "latest_year": int(df["year"].max()),
    }
    with open(os.path.join(MODELS, "lookups.json"), "w") as f:
        json.dump(lookups, f)

    # ---- replay sample: recent innings from every format ------------------
    picks = []
    for f in families:
        sub = head[head["family"] == f].tail(REPLAY_PER_FAMILY)
        picks.append(sub[key])
    pick = pd.concat(picks)
    sample = df.merge(pick, on=key, how="inner")
    sample.to_parquet(os.path.join(APP, "replay_sample.parquet"),
                      index=False, compression="zstd")

    print("=========== STAGE 4 DONE ===========")
    for f in families:
        print(f"  {f:<14} teams={len(lookups['teams_by_family'][f]):<4} "
              f"venues={len(lookups['venues_by_family'][f])}")
    print(f"  replay: {sample.groupby(key).ngroups} innings, {len(sample):,} balls")
    print(f"  -> models/lookups.json")
    print(f"  -> app/replay_sample.parquet "
          f"({os.path.getsize(os.path.join(APP,'replay_sample.parquet'))/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
