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
import pyarrow.parquet as pq

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "data")
MODELS = os.path.join(ROOT, "models")
APP = os.path.join(ROOT, "app")
os.makedirs(APP, exist_ok=True)

REPLAY_PER_FAMILY = 120       # recent innings kept per format for the demo

# The temporal split from stage 3, repeated here verbatim. It is a pure
# function of the data - order match_ids by first date, cut at 70% and 85% -
# so recomputing it costs nothing and needs no retrain. The results page shows
# these boundaries; they are asserted against meta.json at the end of main().
TRAIN_FRAC, VALID_FRAC = 0.70, 0.85


def by_event(head, value_cols):
    """{event: [value, ...]} pooled over every column in value_cols.

    Keyed by event name alone, not by (event, family). 180 of the 1,084 events
    run more than one format - an English county side plays both the County
    Championship and a one-day cup under names that overlap - so the app
    intersects this with the family list rather than trusting the event alone.
    The empty event is dropped: the API already falls back to the family lists
    when no competition is selected, so storing it twice would only bloat the
    file.
    """
    out = {}
    for ev, sub in head.groupby("event", observed=True):
        ev = str(ev)
        if not ev:
            continue
        vals = set()
        for c in value_cols:
            vals.update(sub[c].dropna().astype(str))
        if vals:
            out[ev] = sorted(vals)
    return out


def temporal_split_bounds(head):
    """Reproduce stage 3's train/valid/test cut and report its date edges."""
    md = head.groupby("match_id", observed=True)["date"].first().sort_values()
    n = len(md)
    parts = {
        "train": md.iloc[: int(n * TRAIN_FRAC)],
        "valid": md.iloc[int(n * TRAIN_FRAC): int(n * VALID_FRAC)],
        "test": md.iloc[int(n * VALID_FRAC):],
    }
    return {k: {"n_matches": int(len(v)),
                "start": str(v.min().date()),
                "end": str(v.max().date())}
            for k, v in parts.items()}


def dataset_summary(df, head):
    """Scale and date coverage, for the About and Results pages.

    Every figure the site quotes about the corpus is computed here so the
    pages can render it from the API instead of hard-coding a number that
    goes stale the moment the archive grows.
    """
    deliveries = os.path.join(DATA, "deliveries.parquet")
    return {
        "n_matches": int(head["match_id"].nunique()),
        "n_innings": int(len(head)),
        "n_model_rows": int(len(df)),
        # Every legal and illegal delivery in the archive, before stage 2
        # thins multi-day innings and drops rain-shortened ones. Absent if
        # stage 1's output has been cleaned away.
        "n_deliveries": (int(pq.ParquetFile(deliveries).metadata.num_rows)
                         if os.path.exists(deliveries) else None),
        "date_min": str(head["date"].min().date()),
        "date_max": str(head["date"].max().date()),
        "n_events": int(head.loc[head["event"].astype(str) != "", "event"].nunique()),
        "n_venues": int(head["venue"].nunique()),
        "split": temporal_split_bounds(head),
    }


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
        # Competition-scoped options. Picking the IPL must not leave a BPL
        # side selectable, and it must not offer a ground the IPL never uses.
        "teams_by_event": by_event(head, ["batting_team", "bowling_team"]),
        "venues_by_event": by_event(head, ["venue"]),
        # So venue search can match on a city: typing "sydney" should surface
        # the SCG and every other ground in Sydney. 65 of the 881 venues carry
        # more than one spelling of their city across the archive; the most
        # frequent one wins.
        "venue_city": {str(v): str(c) for v, c in
                       head.groupby("venue", observed=True)["city"]
                       .agg(lambda s: s.mode().iloc[0] if len(s.mode()) else "")
                       .items() if c},
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
        "dataset": dataset_summary(df, head),
    }
    with open(os.path.join(MODELS, "lookups.json"), "w") as f:
        json.dump(lookups, f)

    # The split above is only worth showing if it is the same one the model was
    # actually trained on. meta.json recorded stage 3's counts, so compare.
    meta_path = os.path.join(MODELS, "meta.json")
    if os.path.exists(meta_path):
        meta = json.load(open(meta_path))
        sp = lookups["dataset"]["split"]
        for label, got, want in [
            ("train matches", sp["train"]["n_matches"], meta.get("n_train_matches")),
            ("test matches", sp["test"]["n_matches"], meta.get("n_test_matches")),
            ("train end date", sp["train"]["end"], meta.get("train_end")),
        ]:
            if want is not None and got != want:
                raise SystemExit(
                    f"[!] recomputed {label} = {got!r} but meta.json from the "
                    f"trained model says {want!r}. The split in this file has "
                    f"drifted from src/03_train.py - fix it before the results "
                    f"page quotes a boundary the model never used.")
        print("  split reproduced from data matches meta.json exactly")

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
    ds = lookups["dataset"]
    print(f"  events with scoped options: {len(lookups['teams_by_event'])}")
    print(f"  venues with a city: {len(lookups['venue_city'])}")
    print(f"  corpus: {ds['n_matches']:,} matches, {ds['n_innings']:,} innings, "
          f"{(ds['n_deliveries'] or 0):,} deliveries, "
          f"{ds['date_min']} .. {ds['date_max']}")
    for k in ("train", "valid", "test"):
        s = ds["split"][k]
        print(f"  {k:<6} {s['n_matches']:>6,} matches  {s['start']} .. {s['end']}")
    print(f"  replay: {sample.groupby(key).ngroups} innings, {len(sample):,} balls")
    print(f"  -> models/lookups.json")
    print(f"  -> app/replay_sample.parquet "
          f"({os.path.getsize(os.path.join(APP,'replay_sample.parquet'))/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
