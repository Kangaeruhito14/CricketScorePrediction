"""
Cricket Score Predictor — FastAPI backend (all formats)

Endpoints
  GET  /                 the web GUI
  GET  /api/meta         dropdowns + honest metrics, per format
  GET  /api/options      team/venue/event lists scoped to a format+competition
  POST /api/predict      one prediction from a manual match state
  GET  /api/matches      innings available for replay
  GET  /api/replay/{id}  ball-by-ball predictions for one real innings

Run locally:
  uvicorn app.main:app --reload --port 8000
"""
import os
import json
import numpy as np
import pandas as pd
import lightgbm as lgb
from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel, Field

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "models")
APP = os.path.join(ROOT, "app")

app = FastAPI(title="Cricket Score Predictor")

# The page is a plain static file; every number it shows comes from the API.
INDEX_HTML = open(os.path.join(APP, "templates", "index.html"),
                  encoding="utf-8").read()

main_model = lgb.Booster(model_file=os.path.join(MODELS, "lgb_main.txt"))
meta = json.load(open(os.path.join(MODELS, "meta.json")))
lookups = json.load(open(os.path.join(MODELS, "lookups.json")))

FEATURES = meta["features"]
CAT_COLS = meta["cat_cols"]
CATEGORIES = meta["categories"]
CONFORMAL = meta.get("conformal_offsets", {})
FALLBACK = meta.get("conformal_fallback", [-30.0, 30.0])
DEFAULTS = meta["defaults"]

FAMILIES = list(lookups["families"])
TOTAL_BALLS = lookups["family_total_balls"]

_rp = os.path.join(APP, "replay_sample.parquet")
REPLAY = pd.read_parquet(_rp) if os.path.exists(_rp) else None


def phase_of(progress) -> int:
    if progress is None or (isinstance(progress, float) and np.isnan(progress)):
        return 4
    p = float(progress)
    if p < 0.30:
        return 0
    if p < 0.55:
        return 1
    if p < 0.80:
        return 2
    if p <= 1.01:
        return 3
    return 4


def to_frame(rows):
    df = pd.DataFrame(rows)
    for c in CAT_COLS:
        v = df[c].astype(object)
        df[c] = pd.Categorical(v.where(v.isin(CATEGORIES[c])),
                               categories=CATEGORIES[c])
    for c in FEATURES:
        if c not in df.columns:
            df[c] = np.nan
    return df[FEATURES]


def predict_rows(rows):
    X = to_frame(rows)
    point = main_model.predict(X)
    lo, hi = [], []
    for r, p in zip(rows, point):
        key = f"{r['family']}|{phase_of(r.get('progress'))}"
        off = CONFORMAL.get(key, FALLBACK)
        lo.append(p + off[0])
        hi.append(p + off[1])
    # A physical floor and ceiling. The final score can never drop below what
    # is already on the board, and in a limited-overs innings it cannot exceed
    # roughly 18 runs an over off the balls that remain. Without this, an
    # unfamiliar venue or team can push the model somewhere impossible.
    cur = np.array([r["current_score"] for r in rows], dtype=float)
    bl = np.array([np.nan if r.get("balls_left") is None else r["balls_left"]
                   for r in rows], dtype=float)
    ceiling = np.where(np.isnan(bl), np.inf, cur + bl * 3.0 + 20.0)

    point = np.clip(np.maximum(point, cur), None, ceiling)
    lo = np.clip(np.maximum(np.array(lo), cur), None, ceiling)
    hi = np.clip(np.maximum(np.array(hi), point), None, ceiling)
    return point, lo, hi


class MatchState(BaseModel):
    family: str = "t20"
    batting_team: str
    bowling_team: str
    venue: str
    event: str = ""
    gender: str = "male"
    innings: int = 1
    overs: float = Field(..., ge=0.0, description="e.g. 12.4")
    current_score: int = Field(..., ge=0)
    wickets: int = Field(..., ge=0, le=10)
    last30_runs: float | None = None
    fours: int = 0
    sixes: int = 0
    target: int = 0
    bat_won_toss: int = 0


def state_to_row(s: MatchState) -> dict:
    whole = int(s.overs)
    part = min(int(round((s.overs - whole) * 10)), 5)
    balls_bowled = max(1, whole * 6 + part)

    tb = lookups["family_total_balls"].get(s.family)
    total_balls = float(tb) if tb else np.nan
    balls_left = (max(0.0, total_balls - balls_bowled)
                  if not np.isnan(total_balls) else np.nan)
    progress = (balls_bowled / total_balls
                if not np.isnan(total_balls) else np.nan)

    wickets_left = 10 - s.wickets
    crr = 6.0 * s.current_score / balls_bowled
    fam_par = lookups["family_par"].get(s.family, 200.0)

    vp, vn = lookups["venue_par"].get(f"{s.venue}||{s.family}", [fam_par, 0])
    dflt = lookups.get("defaults_by_family", {}).get(s.family, DEFAULTS)
    last30 = s.last30_runs
    if last30 is None:
        last30 = crr * 5 if balls_bowled >= 30 else float(s.current_score)

    return {
        "match_type": lookups["match_type_by_family"].get(s.family, "T20"),
        "family": s.family,
        "batting_team": s.batting_team,
        "bowling_team": s.bowling_team,
        "venue": s.venue,
        "event": s.event or "",
        "gender": s.gender,
        "year": lookups["latest_year"],
        "innings": s.innings,
        "current_score": s.current_score,
        "balls_bowled": balls_bowled,
        "balls_left": balls_left,
        "total_balls_f": total_balls,
        "progress": progress,
        "wickets_left": wickets_left,
        "crr": crr,
        "last30_runs": float(last30),
        "last30_wkts": dflt.get("last30_wkts", 0.0),
        "fours": s.fours,
        "sixes": s.sixes,
        "dot_pct": dflt.get("dot_pct", 0.35),
        "boundary_pct": (s.fours + s.sixes) / balls_bowled,
        "resource": (wickets_left * balls_left
                     if not np.isnan(balls_left) else np.nan),
        "is_chase": 1 if s.target > 0 else 0,
        "target_runs": float(s.target),
        "runs_needed": (max(0.0, s.target - s.current_score)
                        if s.target > 0 else np.nan),
        "bat_won_toss": s.bat_won_toss,
        "venue_par": float(vp),
        "venue_n": int(vn),
        "batteam_par": float(lookups["bat_par"].get(
            f"{s.batting_team}||{s.family}", fam_par)),
        "bowlteam_par": float(lookups["bowl_par"].get(
            f"{s.bowling_team}||{s.family}", fam_par)),
        "bat_sr": dflt.get("bat_sr", DEFAULTS["bat_sr"]),
        "bat_balls": dflt.get("bat_balls", 500.0),
        "bowl_econ": dflt.get("bowl_econ", DEFAULTS["bowl_econ"]),
        "bowl_sr": dflt.get("bowl_sr", DEFAULTS["bowl_sr"]),
        "bowl_balls": dflt.get("bowl_balls", 500.0),
    }


@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse(INDEX_HTML)


@app.get("/api/meta")
def api_meta():
    return {
        "families": lookups["families"],
        "events_by_family": lookups["events_by_family"],
        "teams_by_family": lookups["teams_by_family"],
        "venues_by_family": lookups["venues_by_family"],
        "family_total_balls": lookups["family_total_balls"],
        "metrics": {
            "test_mae": meta["test_mae"],
            "test_r2": meta["test_r2"],
            "leaky_mae": meta.get("leaky_random_split_mae"),
            "leaky_r2": meta.get("leaky_random_split_r2"),
            "group_mae": meta.get("group_split_mae"),
            "coverage": meta.get("interval_coverage_conformal"),
            "coverage_raw": meta.get("interval_coverage_quantile"),
            "n_train_matches": meta["n_train_matches"],
            "n_test_matches": meta["n_test_matches"],
            "format_table": meta.get("format_table", []),
            "phase_table": meta.get("phase_table", []),
        },
    }


@app.get("/api/options")
def api_options(family: str, event: str = ""):
    """Team, venue and competition lists for one format+competition pair.

    The family lists alone are too coarse for the form: picking a format still
    leaves every side that has ever played it selectable, so a user can build
    an IPL innings out of BPL teams and get a confident answer to a fixture
    that never happened. With a competition chosen, the lists narrow to sides
    and grounds that actually appear in it.
    """
    if family not in FAMILIES:
        raise HTTPException(
            400, f"Unknown format {family!r}. Choose one of: {', '.join(FAMILIES)}.")

    fam_teams = lookups["teams_by_family"][family]
    fam_venues = lookups["venues_by_family"][family]
    # The empty event is a real training category (a match with no competition
    # recorded), but it is not something to list in a dropdown. The caller asks
    # for it by sending event="" and gets the family lists back.
    events = [e for e in lookups["events_by_family"][family] if e]

    teams, venues, scoped = fam_teams, fam_venues, False
    if event:
        ev_teams = set(lookups["teams_by_event"].get(event, []))
        ev_venues = set(lookups["venues_by_event"].get(event, []))
        # Intersect rather than trust the event alone: 180 competitions run
        # more than one format, so an event's team list can carry sides that
        # only ever played the other format under the same banner.
        t = sorted(ev_teams & set(fam_teams))
        v = sorted(ev_venues & set(fam_venues))
        # venues_by_family drops grounds with fewer than three matches, which
        # can empty a small competition entirely. Fall back rather than hand
        # back a dropdown with nothing in it.
        teams = t or sorted(ev_teams) or fam_teams
        venues = v or sorted(ev_venues) or fam_venues
        scoped = bool(ev_teams or ev_venues)

    city = lookups.get("venue_city", {})
    return {
        "family": family,
        "event": event,
        "scoped": scoped,
        "events": events,
        "teams": teams,
        "venues": venues,
        # Only the venues actually returned, so the combobox can match a typed
        # city name without pulling the whole 808-entry map on every keystroke.
        "venue_city": {v: city[v] for v in venues if v in city},
        "total_balls": TOTAL_BALLS.get(family),
        "match_type": lookups["match_type_by_family"].get(family),
    }


@app.post("/api/predict")
def api_predict(state: MatchState):
    if state.batting_team == state.bowling_team:
        raise HTTPException(400, "Batting and bowling team cannot be the same.")
    row = state_to_row(state)
    point, lo, hi = predict_rows([row])
    bl = row["balls_left"]
    return {
        "predicted": round(float(point[0])),
        "low": round(float(lo[0])),
        "high": round(float(hi[0])),
        "balls_left": None if (bl is None or np.isnan(bl)) else int(bl),
        "crr": round(row["crr"], 2),
        "venue_par": round(row["venue_par"]),
        "projected_at_crr": (round(row["current_score"] + row["crr"] * bl / 6)
                             if bl and not np.isnan(bl) else None),
    }


@app.get("/api/matches")
def api_matches():
    if REPLAY is None:
        return []
    g = (REPLAY.groupby(["match_id", "innings"], observed=True)
         .agg(date=("date", "first"), fam=("family", "first"),
              mt=("match_type", "first"), bat=("batting_team", "first"),
              bowl=("bowling_team", "first"), venue=("venue", "first"),
              final=("final_score", "first"))
         .reset_index().sort_values("date", ascending=False))
    return [{
        "id": f"{r.match_id}:{r.innings}",
        "family": r.fam,
        "label": f"[{r.mt}] {r.bat} vs {r.bowl} — inns {r.innings} — "
                 f"{str(r.date)[:10]} ({r.venue[:34]})",
        "final": int(r.final),
    } for r in g.itertuples()]


@app.get("/api/replay/{rid}")
def api_replay(rid: str):
    if REPLAY is None:
        raise HTTPException(404, "No replay data bundled.")
    try:
        mid, inn = rid.split(":")
        inn = int(inn)
    except ValueError:
        raise HTTPException(400, "id must look like matchid:innings")
    sub = REPLAY[(REPLAY["match_id"] == mid) & (REPLAY["innings"] == inn)]
    sub = sub.sort_values("balls_bowled")
    if sub.empty:
        raise HTTPException(404, "Innings not found.")
    cols = FEATURES + [c for c in ("family", "progress") if c not in FEATURES]
    rows = sub[cols].to_dict(orient="records")
    point, lo, hi = predict_rows(rows)
    final = int(sub["final_score"].iloc[0])
    return {
        "id": rid,
        "match_type": sub["match_type"].iloc[0],
        "batting_team": sub["batting_team"].iloc[0],
        "bowling_team": sub["bowling_team"].iloc[0],
        "venue": sub["venue"].iloc[0],
        "date": str(sub["date"].iloc[0])[:10],
        "final_score": final,
        "balls": sub["balls_bowled"].astype(int).tolist(),
        "score": sub["current_score"].astype(int).tolist(),
        "pred": [round(float(x), 1) for x in point],
        "low": [round(float(x), 1) for x in lo],
        "high": [round(float(x), 1) for x in hi],
        "mae": round(float(np.mean(np.abs(point - final))), 2),
    }
