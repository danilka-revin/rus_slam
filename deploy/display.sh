#!/usr/bin/env bash
# display.sh — показывает ОСНОВНОЙ ЭКРАН на дисплее робота.
#
# Запускается сервисом `rus-slam-display.service` (см. deploy/README.md):
# ждёт, пока сервер борта ответит, и открывает страницу в браузере без рамок.
# Сам сервер (gui/backend.py) при этом ничего не открывает — страницу на
# дисплее робота показывает именно этот скрипт, и только если её нужно видеть
# постоянно на борту.
#
# Использование:  deploy/display.sh [URL]     (по умолчанию http://127.0.0.1:8080/)
set -euo pipefail

URL="${1:-http://127.0.0.1:8080/}"
HEALTH="${URL%/}/api/health"

# 1. Ждём сервер борта (до 60 с) — при загрузке робота он поднимается не сразу
for _ in $(seq 1 60); do
  if curl -sf -o /dev/null --max-time 2 "$HEALTH"; then
    break
  fi
  sleep 1
done

# 2. Открываем страницу первым найденным браузером в режиме киоска
for bin in chromium-browser chromium google-chrome google-chrome-stable microsoft-edge firefox; do
  if command -v "$bin" >/dev/null 2>&1; then
    case "$(basename "$bin")" in
      firefox)
        exec "$bin" --kiosk "$URL"
        ;;
      *)
        exec "$bin" --kiosk --app="$URL" \
             --noerrdialogs --disable-infobars --disable-session-crashed-bubble \
             --autoplay-policy=no-user-gesture-required
        ;;
    esac
  fi
done

echo "display.sh: браузер не найден — откройте $URL на дисплее робота вручную" >&2
exit 1
