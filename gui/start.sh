#!/usr/bin/env bash
# ============================================================================
# start.sh — запуск веб-пульта РУС-SLAM на Ubuntu / Linux
#
# Использование:
#   ./start.sh             — режим разработки (http://localhost:5173)
#   ./start.sh --prod      — прод-сборка и локальный просмотр (порт 4173)
#   ./start.sh --port 8080 — другой порт (работает с обоими режимами)
#   ./start.sh --help      — справка
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")"

MODE="dev"
PORT=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prod|--production|--build) MODE="prod"; shift ;;
    --port) PORT="${2:?--port требует значение}"; shift 2 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Неизвестный аргумент: $1 (см. --help)" >&2; exit 1 ;;
  esac
done

# --- 1. Node.js -------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js не найден. Установите его:"
  echo "    Ubuntu:  sudo apt update && sudo apt install -y nodejs npm"
  echo "    или свежий LTS (рекомендуется):"
  echo "      curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -"
  echo "      sudo apt install -y nodejs"
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "✗ Нужен Node.js 18+ (сейчас $(node -v)). Обновите: см. подсказки выше."
  exit 1
fi

# --- 2. Зависимости ---------------------------------------------------------
if [[ ! -d node_modules ]]; then
  echo "→ Первый запуск: устанавливаю зависимости (npm install)..."
  npm install --no-audit --no-fund
fi

# --- 3. Запуск --------------------------------------------------------------
PORT_ARGS=()
if [[ -n "$PORT" ]]; then PORT_ARGS=(--port "$PORT"); fi

if [[ "$MODE" == "prod" ]]; then
  echo "→ Прод-сборка (typecheck + vite build)..."
  npm run build
  echo "→ Запуск: откройте $( [[ -n "$PORT" ]] && echo "http://localhost:$PORT" || echo 'http://localhost:4173' )"
  exec npm run preview -- "${PORT_ARGS[@]}"
else
  echo "→ Режим разработки: откройте $( [[ -n "$PORT" ]] && echo "http://localhost:$PORT" || echo 'http://localhost:5173' )"
  exec npm run dev -- "${PORT_ARGS[@]}"
fi
