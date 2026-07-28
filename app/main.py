"""
Cricket Score Predictor — FastAPI backend (all formats)

Endpoints
  GET  /                 the web GUI
  GET  /api/meta         dropdowns + honest metrics, per format
  GET  /api/options      team/venue/event lists scoped to a format+competition
  GET  /api/report       everything the model-results page renders
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
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import HTMLResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator, model_validator

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "models")
REPORTS = os.path.join(ROOT, "reports")
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
# Human names for the format families, used in validation messages so an error
# reads "a T20 innings is 120 balls" rather than quoting the internal key.
FAMILY_LABEL = {"t20": "T20", "odi": "ODI", "multiday": "multi-day"}

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
    """One live innings state.

    The over count is two integers, not a float. A cricket over is six legal
    balls, so "11.7" describes nothing that can happen on a field - as a float
    it silently rounded down to a real state and the model answered as if the
    user had typed something sensible. Two integers make the illegal value
    unrepresentable and the 0-5 bound enforceable.
    """
    family: str = "t20"
    batting_team: str
    bowling_team: str
    venue: str
    event: str = ""
    gender: str = "male"
    innings: int = Field(1, ge=1, le=4)
    overs_completed: int = Field(..., ge=0, description="whole overs bowled, e.g. 11")
    balls_this_over: int = Field(0, ge=0, le=5,
                                 description="legal balls in the over in progress, 0-5")
    current_score: int = Field(..., ge=0)
    wickets: int = Field(..., ge=0, le=10)
    last30_runs: float | None = None
    fours: int = Field(0, ge=0)
    sixes: int = Field(0, ge=0)
    target: int = Field(0, ge=0)
    bat_won_toss: int = 0

    @field_validator("balls_this_over", mode="before")
    @classmethod
    def _six_ball_over(cls, v):
        # Runs ahead of the le=5 constraint so the message explains the rule
        # instead of reciting the bound.
        try:
            n = int(v)
        except (TypeError, ValueError):
            raise ValueError("Balls this over must be a whole number from 0 to 5.")
        if not 0 <= n <= 5:
            raise ValueError(
                f"An over has six legal balls, so balls this over must be 0-5; "
                f"got {n}. After the sixth ball the over is complete - add one "
                f"to overs completed instead.")
        return n

    @property
    def balls_bowled(self) -> int:
        return self.overs_completed * 6 + self.balls_this_over

    @model_validator(mode="after")
    def _check_state(self):
        if self.family not in FAMILIES:
            raise ValueError(
                f"Unknown format {self.family!r}. Choose one of: "
                f"{', '.join(FAMILIES)}.")
        if self.batting_team == self.bowling_team:
            raise ValueError(
                "Batting and bowling team cannot be the same side.")
        total = TOTAL_BALLS.get(self.family)
        if total and self.balls_bowled > total:
            name = FAMILY_LABEL.get(self.family, self.family)
            raise ValueError(
                f"{self.overs_completed}.{self.balls_this_over} overs is "
                f"{self.balls_bowled} balls, but a {name} innings is only "
                f"{int(total)} balls ({int(total) // 6} overs).")
        if self.innings > 1 and self.target > 0 and self.target <= self.current_score:
            raise ValueError(
                f"The target ({self.target}) has already been passed by the "
                f"current score ({self.current_score}); the innings is over.")
        return self


def state_to_row(s: MatchState) -> dict:
    # Before a ball is bowled there is no run rate to speak of. Floor the
    # divisor at one so the degenerate 0-ball row still produces a number;
    # current_score is 0 there anyway, so crr comes out 0.
    balls_bowled = max(1, s.balls_bowled)

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


# Field names the user never typed, rendered as the label they did see.
FIELD_LABEL = {
    "overs_completed": "Overs completed", "balls_this_over": "Balls this over",
    "current_score": "Current score", "wickets": "Wickets down",
    "target": "Target", "innings": "Innings", "fours": "Fours",
    "sixes": "Sixes", "family": "Format", "batting_team": "Batting team",
    "bowling_team": "Bowling team", "venue": "Venue", "event": "Competition",
}


@app.exception_handler(RequestValidationError)
async def readable_validation_error(request: Request, exc: RequestValidationError):
    """Flatten pydantic's error list into one sentence a user can act on.

    The default 422 body is a list of {loc, msg, type, ctx} objects, and ctx
    can hold a live exception that will not serialise. The page shows `detail`;
    `errors` keeps the per-field breakdown so a form can mark the right input.
    """
    parts, errors = [], []
    for e in exc.errors():
        field = next((str(x) for x in reversed(e.get("loc", []))
                      if str(x) != "body"), "")
        msg = str(e.get("msg", "Invalid value"))
        # pydantic prefixes anything raised from a validator; drop the noise.
        for pfx in ("Value error, ", "Assertion failed, "):
            if msg.startswith(pfx):
                msg = msg[len(pfx):]
        label = FIELD_LABEL.get(field, field.replace("_", " ").capitalize())
        parts.append(msg if field in ("", "__root__") else f"{label}: {msg}")
        errors.append({"field": field, "message": msg})
    return JSONResponse(status_code=422,
                        content={"detail": " ".join(parts) or "Invalid request.",
                                 "errors": errors})


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


@app.get("/api/report")
def api_report():
    """Everything the model-results page renders, straight from the artefacts.

    Sourced from models/meta.json, models/lookups.json and reports/. Nothing
    here is computed in the page, so a retrain updates the site by itself.
    """
    imp = []
    imp_path = os.path.join(REPORTS, "feature_importance.csv")
    if os.path.exists(imp_path):
        fi = pd.read_csv(imp_path).sort_values("gain", ascending=False)
        total_gain = float(fi["gain"].sum()) or 1.0
        imp = [{"feature": str(r.feature),
                "gain": float(r.gain),
                "share": round(float(r.gain) / total_gain, 5)}
               for r in fi.head(25).itertuples()]

    return {
        "headline": {
            "test_mae": meta["test_mae"],
            "test_r2": meta["test_r2"],
            "n_train_matches": meta["n_train_matches"],
            "n_test_matches": meta["n_test_matches"],
        },
        "format_table": meta.get("format_table", []),
        "phase_table": meta.get("phase_table", []),
        "phase_names": meta.get("phase_names", {}),
        # Same model, same features, three ways of deciding which rows are
        # allowed to be test rows. The page explains why the best number here
        # is the dishonest one.
        "leakage": [
            {"split": "random",
             "label": "Random ball-level split",
             "mae": meta.get("leaky_random_split_mae"),
             "r2": meta.get("leaky_random_split_r2"),
             "honest": False},
            {"split": "group",
             "label": "Group split by match",
             "mae": meta.get("group_split_mae"),
             "r2": None,
             "honest": True},
            {"split": "temporal",
             "label": "Temporal split (train on the past)",
             "mae": meta["test_mae"],
             "r2": meta["test_r2"],
             "honest": True},
        ],
        "intervals": {
            "nominal": 0.80,
            "quantile": meta.get("interval_coverage_quantile"),
            "conformal": meta.get("interval_coverage_conformal"),
        },
        "feature_importance": imp,
        "dataset": lookups.get("dataset", {}),
        "only_family": meta.get("only_family"),
    }


@app.post("/api/predict")
def api_predict(state: MatchState):
    row = state_to_row(state)
    point, lo, hi = predict_rows([row])
    bl = row["balls_left"]
    return {
        "predicted": round(float(point[0])),
        "low": round(float(lo[0])),
        "high": round(float(hi[0])),
        "balls_left": None if (bl is None or np.isnan(bl)) else int(bl),
        "balls_bowled": state.balls_bowled,
        "overs_display": f"{state.overs_completed}.{state.balls_this_over}",
        "total_balls": TOTAL_BALLS.get(state.family),
        "crr": round(row["crr"], 2),
        "venue_par": round(row["venue_par"]),
        "venue_n": row["venue_n"],
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
