"""
STAGE 1 — Cricsheet JSON  ->  Parquet

Reads every *.json in RAW_DIR and writes two tables:
  data/matches.parquet     one row per match
  data/deliveries.parquet  one row per delivery (ball)

Streamed with pyarrow.ParquetWriter, so RAM stays flat no matter how big
the archive is. Uses all CPU cores.

Run:  python src/01_parse.py
"""
import os
import sys
import glob
import orjson
import pyarrow as pa
import pyarrow.parquet as pq
from multiprocessing import Pool, cpu_count
from datetime import date

# ----------------------------------------------------------------------
# CONFIG — change RAW_DIR if your folder name is different
# ----------------------------------------------------------------------
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_DIR = os.path.join(ROOT, "all_json")
OUT_DIR = os.path.join(ROOT, "data")
BATCH = 1000                      # matches parsed per parquet row-group

# Dismissal kinds that do NOT cost the batting side a wicket
NOT_A_WICKET = {"retired hurt", "retired not out"}


def parse_one(path):
    """Parse a single Cricsheet JSON file -> (match_row, [delivery_rows])."""
    try:
        with open(path, "rb") as fh:
            d = orjson.loads(fh.read())
    except Exception:
        return None

    info = d.get("info", {})
    innings_list = d.get("innings", [])
    if not innings_list:
        return None

    match_id = os.path.splitext(os.path.basename(path))[0]
    teams = info.get("teams", [None, None])
    if len(teams) < 2:
        return None

    dates = info.get("dates") or []
    match_date = dates[0] if dates else None

    toss = info.get("toss", {}) or {}
    outcome = info.get("outcome", {}) or {}
    event = info.get("event", {}) or {}
    if isinstance(event, str):
        event = {"name": event}

    bpo = info.get("balls_per_over", 6) or 6
    max_overs = info.get("overs")          # None for Tests

    match_row = {
        "match_id": match_id,
        "date": match_date,
        "season": str(info.get("season", "")),
        "match_type": info.get("match_type", ""),
        "team_type": info.get("team_type", ""),
        "gender": info.get("gender", ""),
        "event": event.get("name", "") or "",
        "venue": info.get("venue", "") or "",
        "city": info.get("city", "") or "",
        "team1": teams[0],
        "team2": teams[1],
        "toss_winner": toss.get("winner", "") or "",
        "toss_decision": toss.get("decision", "") or "",
        "winner": outcome.get("winner", "") or "",
        "balls_per_over": int(bpo),
        "max_overs": int(max_overs) if max_overs else 0,
    }

    mtype = match_row["match_type"]
    deliveries = []
    for inn_no, inn in enumerate(innings_list, start=1):
        # skip super overs — they are not normal innings
        if inn.get("super_over"):
            continue
        bat_team = inn.get("team", "")
        bowl_team = teams[1] if teams[0] == bat_team else teams[0]
        target = (inn.get("target") or {}).get("runs")

        for over_obj in inn.get("overs", []):
            over_no = over_obj.get("over", 0)
            for ball_idx, dl in enumerate(over_obj.get("deliveries", []), start=1):
                runs = dl.get("runs", {}) or {}
                extras = dl.get("extras", {}) or {}
                is_wide = 1 if "wides" in extras else 0
                is_noball = 1 if "noballs" in extras else 0

                wkts = dl.get("wickets", []) or []
                real_wkts = sum(
                    1 for w in wkts
                    if str(w.get("kind", "")).lower() not in NOT_A_WICKET
                )

                deliveries.append({
                    "match_id": match_id,
                    "match_type": mtype,
                    "innings": inn_no,
                    "batting_team": bat_team,
                    "bowling_team": bowl_team,
                    "over": int(over_no),
                    "ball_in_over": int(ball_idx),
                    "batter": dl.get("batter", "") or "",
                    "bowler": dl.get("bowler", "") or "",
                    "non_striker": dl.get("non_striker", "") or "",
                    "runs_batter": int(runs.get("batter", 0) or 0),
                    "runs_extras": int(runs.get("extras", 0) or 0),
                    "runs_total": int(runs.get("total", 0) or 0),
                    "is_wide": is_wide,
                    "is_noball": is_noball,
                    "is_legal": 0 if (is_wide or is_noball) else 1,
                    "wicket": int(real_wkts),
                    "target": int(target) if target else 0,
                })

    if not deliveries:
        return None
    return match_row, deliveries


MATCH_SCHEMA = pa.schema([
    ("match_id", pa.string()), ("date", pa.string()), ("season", pa.string()),
    ("match_type", pa.string()), ("team_type", pa.string()), ("gender", pa.string()),
    ("event", pa.string()), ("venue", pa.string()), ("city", pa.string()),
    ("team1", pa.string()), ("team2", pa.string()),
    ("toss_winner", pa.string()), ("toss_decision", pa.string()),
    ("winner", pa.string()),
    ("balls_per_over", pa.int8()), ("max_overs", pa.int16()),
])

DELIV_SCHEMA = pa.schema([
    ("match_id", pa.string()), ("match_type", pa.string()), ("innings", pa.int8()),
    ("batting_team", pa.string()), ("bowling_team", pa.string()),
    ("over", pa.int16()), ("ball_in_over", pa.int8()),
    ("batter", pa.string()), ("bowler", pa.string()), ("non_striker", pa.string()),
    ("runs_batter", pa.int8()), ("runs_extras", pa.int8()), ("runs_total", pa.int8()),
    ("is_wide", pa.int8()), ("is_noball", pa.int8()), ("is_legal", pa.int8()),
    ("wicket", pa.int8()), ("target", pa.int16()),
])


def rows_to_table(rows, schema):
    cols = {f.name: [r[f.name] for r in rows] for f in schema}
    return pa.Table.from_pydict(cols, schema=schema)


def main():
    if not os.path.isdir(RAW_DIR):
        sys.exit(f"[X] Folder not found: {RAW_DIR}")
    os.makedirs(OUT_DIR, exist_ok=True)

    files = sorted(glob.glob(os.path.join(RAW_DIR, "*.json")))
    # README.txt and similar are ignored automatically by the *.json glob
    print(f"[i] Found {len(files):,} JSON files in {RAW_DIR}")
    if not files:
        sys.exit("[X] No .json files found.")

    m_path = os.path.join(OUT_DIR, "matches.parquet")
    d_path = os.path.join(OUT_DIR, "deliveries.parquet")
    mw = pq.ParquetWriter(m_path, MATCH_SCHEMA, compression="zstd")
    dw = pq.ParquetWriter(d_path, DELIV_SCHEMA, compression="zstd")

    n_ok = n_bad = n_balls = 0
    m_buf, d_buf = [], []

    workers = max(1, cpu_count() - 1)
    print(f"[i] Parsing with {workers} worker processes...")

    with Pool(workers) as pool:
        for i, res in enumerate(pool.imap_unordered(parse_one, files, chunksize=64), 1):
            if res is None:
                n_bad += 1
            else:
                m_row, d_rows = res
                m_buf.append(m_row)
                d_buf.extend(d_rows)
                n_ok += 1
                n_balls += len(d_rows)

            if len(m_buf) >= BATCH:
                mw.write_table(rows_to_table(m_buf, MATCH_SCHEMA))
                dw.write_table(rows_to_table(d_buf, DELIV_SCHEMA))
                m_buf, d_buf = [], []

            if i % 2000 == 0:
                print(f"    {i:,}/{len(files):,} files | {n_balls:,} balls")

    if m_buf:
        mw.write_table(rows_to_table(m_buf, MATCH_SCHEMA))
        dw.write_table(rows_to_table(d_buf, DELIV_SCHEMA))
    mw.close()
    dw.close()

    print("\n=========== STAGE 1 DONE ===========")
    print(f"  matches parsed : {n_ok:,}")
    print(f"  files skipped  : {n_bad:,}")
    print(f"  deliveries     : {n_balls:,}")
    print(f"  -> {m_path}  ({os.path.getsize(m_path)/1e6:.1f} MB)")
    print(f"  -> {d_path}  ({os.path.getsize(d_path)/1e6:.1f} MB)")


if __name__ == "__main__":
    main()
