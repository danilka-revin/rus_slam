#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
PYTHON="${PYTHON:-python3}"

if ! "$PYTHON" -c 'import tkinter' >/dev/null 2>&1; then
  echo "Tkinter is missing. On Ubuntu/Debian install it with: sudo apt install python3-tk" >&2
  exit 1
fi

if [[ ! -x .build-venv/bin/python ]]; then
  "$PYTHON" -m venv .build-venv
fi
.build-venv/bin/python -m pip install --upgrade pip
.build-venv/bin/python -m pip install -r requirements-native-display.txt
.build-venv/bin/python -m PyInstaller \
  --clean --noconfirm --onefile --windowed \
  --name RUS-SLAM-Display \
  --distpath dist --workpath build/native --specpath build/native \
  native_display.py

echo "Built: $SCRIPT_DIR/dist/RUS-SLAM-Display"
echo "Run with: $SCRIPT_DIR/dist/RUS-SLAM-Display --url http://127.0.0.1:8080"
