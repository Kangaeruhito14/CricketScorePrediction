# Opening this project in Antigravity

Open **this folder** (`CricketScorePredictor`) as the workspace root — not the
parent folder. Everything in `.vscode/` is scoped to this root, and the parent
path contains spaces and parentheses that confuse some tooling.

## Interpreter

The status bar must show `venv/bin/python` (3.12). If it shows Antigravity's
bundled Python or a conda base, imports will appear unresolved even though the
packages are installed.

  Ctrl+Shift+P → "Python: Select Interpreter" → Enter interpreter path
  → /home/anup/.../CricketScorePredictor/venv/bin/python

`.vscode/settings.json` already sets `python.defaultInterpreterPath`, so this
usually happens automatically on first open.

## Conda

If your shell auto-activates conda `(base)`, the integrated terminal may start
in conda instead of the venv. Either run `conda deactivate` then
`source venv/bin/activate`, or disable auto-activation once:

  conda config --set auto_activate_base false

## Run configurations

F5 → pick one:
  ▶ Web app (uvicorn, reload)
  1 · Parse JSON → parquet
  2 · Feature engineering
  3 · Train + evaluate
  4 · Export app assets

Ctrl+Shift+B runs the full rebuild (features → train → export).
