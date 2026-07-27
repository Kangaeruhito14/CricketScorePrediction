#!/usr/bin/env bash
# One command to rebuild everything from the raw JSON.
set -e
source venv/bin/activate
echo "=== STAGE 1: parse JSON -> parquet ==="   && python src/01_parse.py
echo "=== STAGE 2: feature engineering ==="     && python src/02_features.py
echo "=== STAGE 3: train + evaluate ==="        && python src/03_train.py
echo "=== STAGE 4: export app assets ==="       && python src/04_export_app_assets.py
echo
echo "All done. Start the site with:"
echo "  uvicorn app.main:app --reload --port 8000"
