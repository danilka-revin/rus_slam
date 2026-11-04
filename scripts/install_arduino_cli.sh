#!/usr/bin/env bash
# Ставит arduino-cli без sudo — чтобы автопрошивка плат колёс работала сама.
#
# Нужен для scripts/flash_firmware.sh: он собирает прошивку колеса и загружает её
# в плату. Если arduino-cli нет, скрипт вызывает этот и, получив успех, прошивает
# платы сам. Ничего системного не трогаем: бинарник кладётся в
# ${RC_ARDUINO_CLI_DIR:-$HOME/.local/bin}, конфигурация и ядра — в
# ${ARDUINO_DIRECTORIES_DATA:-$HOME/.arduino15}, как у обычной установки.
#
# Качаем сначала с **GitHub** (в России он работает, а downloads.arduino.cc
# часто недоступен), и только потом с сайта Arduino. Если не вышло ни там, ни
# там — прошивать всё равно можно: scripts/avr_upload.py собирает прошивку
# обычным avr-gcc и заливает avrdude (sudo apt install gcc-avr avr-libc avrdude).
#
# Флаги: --check (только проверить, ничего не ставить),
#        --dir КАТАЛОГ (куда положить бинарник),
#        --no-core (не ставить ядро arduino:avr).
#
# Коды возврата: 0 — готово (или уже стоит), 1 — поставить не удалось,
#                2 — --check и arduino-cli нет.
set -uo pipefail

DIR="${RC_ARDUINO_CLI_DIR:-$HOME/.local/bin}"
CHECK=0
WITH_CORE=1
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1 ;;
    --dir) shift; DIR="${1:-$DIR}" ;;
    --no-core) WITH_CORE=0 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[arduino-cli] неизвестный аргумент: $1" >&2; exit 64 ;;
  esac
  shift
done

say() { printf '[arduino-cli] %s\n' "$*"; }
warn() { printf '[arduino-cli] %s\n' "$*" >&2; }

# Уже установлен (в PATH или там, куда мы ставим) — ничего не делаем.
find_cli() {
  if command -v arduino-cli >/dev/null 2>&1; then
    command -v arduino-cli
    return 0
  fi
  if [[ -x "$DIR/arduino-cli" ]]; then
    printf '%s' "$DIR/arduino-cli"
    return 0
  fi
  return 1
}

if CLI="$(find_cli)"; then
  say "arduino-cli уже есть: $CLI ($("$CLI" version 2>/dev/null | head -n 1))"
  if [[ $CHECK -eq 1 ]]; then exit 0; fi
else
  if [[ $CHECK -eq 1 ]]; then
    say "arduino-cli не установлен (искал в PATH и в $DIR)."
    exit 2
  fi
fi

# Архитектура → имя архива с официального сайта.
case "$(uname -m)" in
  x86_64|amd64)  ARCH=64bit ;;
  aarch64|arm64) ARCH=ARM64 ;;
  armv7l|armv6l|arm) ARCH=ARMv7 ;;
  i386|i686)     ARCH=32bit ;;
  *) warn "неизвестная архитектура $(uname -m) — поставьте arduino-cli вручную"; exit 1 ;;
esac
TMP="$(mktemp -d)" || { warn "нет временного каталога"; exit 1; }
trap 'rm -rf "$TMP"' EXIT

download() {
  local url="$1" out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --max-time 300 --retry 2 -o "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -T 60 -t 2 -O "$out" "$url"
  else
    warn "нет ни curl, ни wget — скачать arduino-cli нечем"
    return 1
  fi
}

# Откуда брать архив: свой адрес, GitHub (основной путь в РФ), сайт Arduino.
cli_urls() {
  if [[ -n "${RC_ARDUINO_CLI_URL:-}" ]]; then
    printf '%s\n' "$RC_ARDUINO_CLI_URL"
    return
  fi
  local tag=""
  tag="$(curl -fsSL --max-time 15 https://api.github.com/repos/arduino/arduino-cli/releases/latest 2>/dev/null \
        | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)"
  if [[ -z "$tag" ]] && command -v wget >/dev/null 2>&1; then
    tag="$(wget -q -T 15 -O - https://api.github.com/repos/arduino/arduino-cli/releases/latest 2>/dev/null \
          | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d'"' -f4 || true)"
  fi
  if [[ -n "$tag" ]]; then
    printf '%s\n' "https://github.com/arduino/arduino-cli/releases/download/${tag}/arduino-cli_${tag#v}_Linux_${ARCH}.tar.gz"
  fi
  printf '%s\n' "https://downloads.arduino.cc/arduino-cli/arduino-cli_latest_Linux_${ARCH}.tar.gz"
}

if ! CLI="$(find_cli)"; then
  got=""
  while IFS= read -r url; do
    [[ -n "$url" ]] || continue
    say "скачиваю arduino-cli ($ARCH): $url"
    if download "$url" "$TMP/arduino-cli.tar.gz"; then got="$url"; break; fi
    say "этот адрес не ответил — пробую следующий"
  done < <(cli_urls)
  if [[ -z "$got" ]]; then
    warn "не удалось скачать arduino-cli ни с GitHub, ни с сайта Arduino."
    warn "ничего страшного: прошивка работает и без него —"
    warn "  python3 scripts/avr_upload.py --install   (gcc-avr, avr-libc, avrdude)"
    warn "  или вручную: motor_wheel_*.ino с рабочего стола в Arduino IDE."
    exit 1
  fi
  if ! tar -xzf "$TMP/arduino-cli.tar.gz" -C "$TMP"; then
    warn "архив arduino-cli повреждён"
    exit 1
  fi
  mkdir -p "$DIR" || { warn "не удалось создать $DIR"; exit 1; }
  install -m 0755 "$TMP/arduino-cli" "$DIR/arduino-cli" 2>/dev/null \
    || { cp "$TMP/arduino-cli" "$DIR/arduino-cli" && chmod 0755 "$DIR/arduino-cli"; } \
    || { warn "не удалось положить arduino-cli в $DIR"; exit 1; }
  CLI="$DIR/arduino-cli"
  case ":$PATH:" in
    *":$DIR:"*) ;;
    *) warn "$DIR не в PATH — автопрошивка добавляет его сама, а в терминале:"
       warn "  export PATH=\"$DIR:\$PATH\"" ;;
  esac
  say "arduino-cli установлен: $CLI"
fi

# Конфигурация и ядро AVR: без ядра arduino:avr сборка Mega не соберётся.
if [[ $WITH_CORE -eq 1 ]]; then
  if ! "$CLI" core list 2>/dev/null | grep -q '^arduino:avr'; then
    say "ставлю ядро arduino:avr (один раз, нужен интернет)…"
    if ! "$CLI" core install arduino:avr; then
      warn "ядро arduino:avr не установилось — платы не прошьются автоматически."
      warn "повторите позже: $CLI core install arduino:avr"
      exit 1
    fi
  fi
  say "ядро arduino:avr на месте."
fi

say "готово: $CLI"
exit 0
