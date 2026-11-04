#!/usr/bin/env bash
# Старый инструмент обслуживания: порты RC_WHEEL_*_PORT берутся из .env и
# НЕ подтверждают расположение физической платы. Автопоиска ролей здесь нет.
# Предпочтительно прошивать платы по одной через Arduino IDE, проверив кабель и
# MODULE_ID. Даже --check открывает порты и может перезагрузить Arduino.
#
# Обязателен --confirm-physical-roles: перед КАЖДЫМ вызовом человек физически
# проверил все старые назначения .env и кабели; иное может прошить неверную роль.
# Флаги: --check (план), --force (загрузить заново), --no-verify, --reason TEXT.
# Инструмент выбирает arduino-cli или avr-gcc/avrdude. Код 64 — нет подтверждения.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
VAR_DIR="${RC_VAR_DIR:-$ROOT/var}"
BUILD_DIR="$VAR_DIR/firmware-build"
STATE_DIR="$VAR_DIR/firmware-flashed"
LOG_FILE="$VAR_DIR/firmware-flash.log"
ENV_FILE="${RC_ENV_FILE:-$ROOT/.env}"
SKETCH="$ROOT/firmware/motor_wheel/motor_wheel.ino"
MODULES=(FL FR RL RR)
# Куда install_arduino_cli.sh кладёт бинарник: он может быть ещё не в PATH.
CLI_DIR="${RC_ARDUINO_CLI_DIR:-$HOME/.local/bin}"
[[ -d "$CLI_DIR" ]] && PATH="$CLI_DIR:$PATH"

CHECK=0
FORCE=0
CONFIRM_PHYSICAL_ROLES=0
VERIFY="${RC_FIRMWARE_VERIFY:-1}"
REASON=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1 ;;
    --force) FORCE=1 ;;
    --confirm-physical-roles) CONFIRM_PHYSICAL_ROLES=1 ;;
    --no-verify) VERIFY=0 ;;
    --reason) shift; REASON="${1:-}" ;;
    -h|--help)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "[firmware] неизвестный аргумент: $1" >&2; exit 64 ;;
  esac
  shift
done

say() { printf '[firmware] %s\n' "$*"; }
warn() { printf '[firmware] %s\n' "$*" >&2; }

# This maintenance utility predates automatic discovery and trusts old .env
# assignments. USB renumbering can flash FR firmware onto a physical FL board.
# Never open, probe or upload any such port without explicit, fresh physical
# verification by the operator. This is not automatic role detection.
if [[ "$CONFIRM_PHYSICAL_ROLES" -ne 1 ]]; then
  warn "ОТКАЗ: старые RC_WHEEL_*_PORT не доказывают расположение плат."
  warn "Прошейте платы по одной через IDE с проверкой физической роли;"
  warn "либо после проверки каждого кабеля передайте --confirm-physical-roles."
  exit 64
fi

read_env() {
  local key="$1" fallback="${2:-}" value
  value="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -n 1 | cut -d= -f2- || true)"
  printf '%s' "${value:-$fallback}"
}

FQBN="${RC_FIRMWARE_FQBN:-$(read_env RC_FIRMWARE_FQBN arduino:avr:mega)}"

if [[ ! -f "$SKETCH" ]]; then
  warn "нет исходника прошивки: $SKETCH"
  exit 1
fi

# Версия прошивки, которая лежит в коде. Именно её должна сообщить плата в @TLM.
EXPECTED_FW="$(grep -oE 'FIRMWARE_PROTOCOL[[:space:]]*=[[:space:]]*[0-9]+' "$SKETCH" \
  | head -n 1 | grep -oE '[0-9]+$' || true)"

mkdir -p "$BUILD_DIR" "$STATE_DIR" || { warn "не удалось создать $VAR_DIR"; exit 1; }
: >"$LOG_FILE" 2>/dev/null || true

[[ -n "$REASON" ]] && say "причина: $REASON"
[[ -n "$EXPECTED_FW" ]] && say "в коде прошивка fw=$EXPECTED_FW ($FQBN)"

# Скетч колеса: имя каталога обязано совпадать с именем .ino (так работает
# arduino-cli), поэтому у каждого колеса свой каталог в var/, а не рядом с
# исходником в репозитории.
make_sketch() {
  local module="$1" dir="$BUILD_DIR/motor_wheel_$1" tmp
  mkdir -p "$dir" || return 1
  tmp="$dir/motor_wheel_$module.ino.tmp.$$"
  if ! sed -e "s/^#define MODULE_ID .*/#define MODULE_ID \"${module}\"/" \
           -- "$SKETCH" >"$tmp"; then
    rm -f "$tmp"
    return 1
  fi
  mv -f "$tmp" "$dir/motor_wheel_$module.ino" || return 1
  printf '%s' "$dir"
}

sketch_hash() {
  sha1sum "$1" 2>/dev/null | cut -d' ' -f1
}

# Определить каталог, где лежит скетч колеса (уже собранный).
sketch_dir() {
  printf '%s' "$BUILD_DIR/motor_wheel_$1"
}

# --- опрос плат: какая прошивка на самом деле ---------------------------------
# PROBE_OUT — строка вида «FL=7 FR=7 RL=- RR=-». Пустая — платы не ответили.
PROBE_OUT=""
# Проверка «уже прошито» должна быть быстрой: плата при открытии порта
# перезагружается и печатает @TLM примерно через 2 с, а держать порты колёс
# закрытыми на старте дольше — значит задерживать подключение колёс.
PROBE_TIMEOUT="${RC_FIRMWARE_PROBE_TIMEOUT:-3}"
probe_run() {
  local modules=("$@") cmd=() args=() module python
  PROBE_OUT=""
  [[ ${#modules[@]} -eq 0 ]] && return 1
  if [[ -n "${RC_FIRMWARE_PROBE_CMD:-}" ]]; then
    cmd=("$RC_FIRMWARE_PROBE_CMD")
  else
    python="$ROOT/.venv/bin/python"
    [[ -x "$python" ]] || python="$(command -v python3 || true)"
    [[ -n "$python" && -f "$ROOT/scripts/firmware_probe.py" ]] || return 1
    cmd=("$python" "$ROOT/scripts/firmware_probe.py")
  fi
  args=(--env-file "$ENV_FILE" --timeout "$PROBE_TIMEOUT")
  for module in "${modules[@]}"; do args+=(--module "$module"); done
  PROBE_OUT="$("${cmd[@]}" "${args[@]}" 2>/dev/null || true)"
  [[ -n "$PROBE_OUT" ]]
}

# Версия прошивки конкретной платы по последнему опросу: «7» или «-».
probe_value() {
  local module="$1"
  grep -oE "(^| )${module}=([0-9]+|-)" <<<"$PROBE_OUT" | tail -n 1 | cut -d= -f2
}

# --- план ---------------------------------------------------------------------
todo=() current_records=() unassigned=() absent=() plan=()
known_failed=0

for module in "${MODULES[@]}"; do
  port="$(read_env "RC_WHEEL_${module}_PORT" "")"
  if [[ -z "$port" ]]; then
    unassigned+=("$module")
    continue
  fi
  real="$(readlink -f "$port" 2>/dev/null || printf '%s' "$port")"
  if [[ ! -e "$real" ]]; then
    absent+=("$module ($port)")
    continue
  fi
  dir="$(make_sketch "$module")" || { warn "$module: не удалось собрать скетч"; continue; }
  hash="$(sketch_hash "$dir/motor_wheel_$module.ino")"
  if [[ $FORCE -ne 1 && -f "$STATE_DIR/$module.flash" ]]; then
    known="$(cat "$STATE_DIR/$module.flash" 2>/dev/null)"
    if [[ "$known" == "$hash $real" || "$known" == "$hash $real ok" ]]; then
      current_records+=("$module|$port|$real|$hash")
      continue
    fi
    if [[ "$known" == "$hash $real fail" ]]; then
      say "колесо $module: прошлая прошивка не удалась — проверьте кабель и питание," \
          "и запустите ./scripts/flash_firmware.sh --force"
      known_failed=$((known_failed + 1))
      continue
    fi
  fi
  todo+=("$module|$port|$real|$hash|")
done

for module in "${unassigned[@]}"; do say "колесо $module: порт не выбран в настройках — пропущено"; done
for item in "${absent[@]}"; do say "колесо $item: устройства нет сейчас — пропущено"; done

# Платы, которые по отметке «уже прошиты», всё равно спрашиваем про fw=:
# плату могли заменить, прошить старой копией с рабочего стола или прошивка
# могла не дойти. Это и есть «актуальная версия на самом деле», а не «мы так
# думаем по своему файлу».
current=0
if [[ ${#current_records[@]} -gt 0 ]]; then
  probe_modules=()
  for record in "${current_records[@]}"; do probe_modules+=("${record%%|*}"); done
  if [[ "$VERIFY" != "0" ]] && probe_run "${probe_modules[@]}" >/dev/null 2>&1; then
    for record in "${current_records[@]}"; do
      IFS='|' read -r module port real hash <<<"$record"
      fw="$(probe_value "$module")"
      if [[ "$fw" == "-" || -z "$fw" ]]; then
        say "колесо $module: плата не ответила — считаю прошивку актуальной (проверить: --force)"
        current=$((current + 1))
        plan+=("$module=$port уже с этой прошивкой")
        continue
      fi
      if [[ -n "$EXPECTED_FW" && "$fw" != "$EXPECTED_FW" ]]; then
        say "колесо $module: на плате fw=$fw, в коде fw=$EXPECTED_FW — прошиваю заново"
        todo+=("$module|$port|$real|$hash|на плате fw=$fw, нужна fw=$EXPECTED_FW")
        continue
      fi
      say "колесо $module: подтверждено по @TLM — fw=$fw, прошивка актуальна"
      plan+=("$module=$port уже с этой прошивкой")
      current=$((current + 1))
    done
  else
    current=${#current_records[@]}
    for record in "${current_records[@]}"; do
      IFS='|' read -r module port real hash <<<"$record"
      plan+=("$module=$port уже с этой прошивкой")
    done
    [[ "$VERIFY" == "0" ]] || say "платы не ответили на опрос — веру проверяю по отметке о прошивке"
  fi
fi

if [[ ${#unassigned[@]} -eq ${#MODULES[@]} ]]; then
  say "порты колёс не выбраны в старых RC_WHEEL_*_PORT для обслуживания."
  say "Предпочтительна прошивка по одной плате в IDE с физической проверкой роли."
  exit 3
fi

if [[ ${#todo[@]} -eq 0 ]]; then
  if [[ $known_failed -gt 0 ]]; then
    say "прошивать нечего: $known_failed плат(ы) с прошлой неудачей ждут --force."
  elif [[ -n "$EXPECTED_FW" ]]; then
    say "прошивать нечего: все назначенные платы уже на прошивке fw=$EXPECTED_FW."
  else
    say "прошивать нечего: у всех назначенных колёс уже эта прошивка."
  fi
  exit 0
fi

for record in "${todo[@]}"; do
  IFS='|' read -r module port real hash why <<<"$record"
  plan+=("$module=$port прошить${why:+ ($why)}")
done

if [[ $CHECK -eq 1 ]]; then
  for line in "${plan[@]}"; do say "план: $line"; done
  say "проверка закончена, ничего не прошивал (--check)."
  exit 0
fi

# --- чем шить: arduino-cli или avr-gcc+avrdude ---------------------------------
PYTHON="${ROOT}/.venv/bin/python"
[[ -x "$PYTHON" ]] || PYTHON="$(command -v python3 || true)"
AVR_UPLOAD="$ROOT/scripts/avr_upload.py"
BACKEND=""

cli_ready() {
  [[ -x "$CLI_DIR/arduino-cli" ]] && PATH="$CLI_DIR:$PATH"
  command -v arduino-cli >/dev/null 2>&1
}
# Готов ли родной путь: avr-gcc + avrdude (ядро докачается при первой прошивке).
avr_ready() {
  [[ -n "$PYTHON" && -f "$AVR_UPLOAD" ]] || return 1
  "$PYTHON" "$AVR_UPLOAD" --check >/dev/null 2>&1
}

if [[ "${RC_FIRMWARE_BACKEND:-auto}" == "cli" ]]; then
  cli_ready && BACKEND="cli"
elif [[ "${RC_FIRMWARE_BACKEND:-auto}" == "avr" ]]; then
  avr_ready && BACKEND="avr"
else
  if cli_ready; then
    BACKEND="cli"
  elif avr_ready; then
    BACKEND="avr"
  fi
fi

# Ничего не готово — попробовать доставить инструменты (это одноразово).
# RC_FIRMWARE_INSTALL отвечает только за apt-пакеты gcc-avr/avr-libc/avrdude,
# RC_FIRMWARE_AUTOCLI — только за arduino-cli: их можно включать по отдельности.
if [[ -z "$BACKEND" && "${RC_FIRMWARE_INSTALL:-1}" != "0" ]]; then
  if [[ -n "$PYTHON" && -f "$AVR_UPLOAD" ]]; then
    say "нет ни arduino-cli, ни avr-gcc — ставлю gcc-avr/avr-libc/avrdude (apt)…"
    "$PYTHON" "$AVR_UPLOAD" --install >>"$LOG_FILE" 2>&1 || true
    avr_ready && BACKEND="avr"
  fi
fi
if [[ -z "$BACKEND" && "${RC_FIRMWARE_AUTOCLI:-1}" != "0" \
      && -f "$ROOT/scripts/install_arduino_cli.sh" ]]; then
  say "arduino-cli не найден — пробую поставить с GitHub (без sudo)…"
  if bash "$ROOT/scripts/install_arduino_cli.sh" >>"$LOG_FILE" 2>&1; then
    cli_ready && BACKEND="cli"
  else
    tail -n 5 "$LOG_FILE" | while IFS= read -r line; do warn "  $line"; done
  fi
fi

if [[ -z "$BACKEND" ]]; then
  warn "нечем прошивать: нет ни arduino-cli, ни avr-gcc/avrdude."
  warn "самый простой путь (работает в России, без сайта Arduino):"
  warn "  sudo apt install gcc-avr avr-libc avrdude"
  warn "  ./scripts/flash_firmware.sh            # ядро AVR докачается с GitHub"
  warn "или вручную: motor_wheel_*.ino с рабочего стола в Arduino IDE."
  for line in "${plan[@]}"; do warn "  $line"; done
  exit 2
fi

if [[ "$BACKEND" == "cli" ]]; then
  say "прошиваю через arduino-cli ($FQBN)"
  # Ядро AVR должно быть установлено: без него compile упадёт «Platform not installed».
  if ! arduino-cli core list 2>/dev/null | grep -q '^arduino:avr'; then
    say "ставлю ядро arduino:avr для arduino-cli…"
    if ! arduino-cli core install arduino:avr >>"$LOG_FILE" 2>&1; then
      warn "не удалось поставить ядро arduino:avr — см. $LOG_FILE"
      warn "попробуйте без arduino-cli: sudo apt install gcc-avr avr-libc avrdude"
      exit 2
    fi
  fi
else
  say "прошиваю без arduino-cli: avr-gcc + avrdude ($(command -v avr-gcc || echo avr-gcc))"
fi

# Собрать и залить одну плату выбранным способом.
flash_board() {
  local module="$1" port="$2" dir
  dir="$(sketch_dir "$module")"
  if [[ "$BACKEND" == "cli" ]]; then
    arduino-cli compile --upload -p "$port" --fqbn "$FQBN" "$dir" >>"$LOG_FILE" 2>&1
    return $?
  fi
  "$PYTHON" "$AVR_UPLOAD" --sketch-dir "$dir" --port "$port" >>"$LOG_FILE" 2>&1
}

# --- прошивка -----------------------------------------------------------------
flashed=0 failed=0
flashed_modules=()
for record in "${todo[@]}"; do
  IFS='|' read -r module port real hash why <<<"$record"
  say "прошиваю $module → $port${why:+ ($why)}…"
  if flash_board "$module" "$port"; then
    printf '%s %s ok\n' "$hash" "$real" >"$STATE_DIR/$module.flash"
    say "колесо $module: прошито ($port)"
    flashed=$((flashed + 1))
    flashed_modules+=("$module")
  else
    printf '%s %s fail\n' "$hash" "$real" >"$STATE_DIR/$module.flash"
    tail -n 5 "$LOG_FILE" | while IFS= read -r line; do warn "  $line"; done
    warn "колесо $module: прошивка не удалась ($port), журнал: $LOG_FILE"
    failed=$((failed + 1))
  fi
done

# --- подтверждение ------------------------------------------------------------
# «Загружено без ошибок» ещё не значит «плата работает на новой прошивке»:
# спрашиваем у неё самой, какой fw она сообщает.
if [[ ${#flashed_modules[@]} -gt 0 && "$VERIFY" != "0" && -n "$EXPECTED_FW" ]]; then
  say "проверяю, что платы действительно на fw=$EXPECTED_FW…"
  # После загрузки плате нужно время на перезапуск — ждём дольше, чем при
  # обычной проверке.
  PROBE_TIMEOUT="${RC_FIRMWARE_PROBE_TIMEOUT:-3}"
  [[ "$PROBE_TIMEOUT" -lt 6 ]] && PROBE_TIMEOUT=6
  if probe_run "${flashed_modules[@]}"; then
    for module in "${flashed_modules[@]}"; do
      fw="$(probe_value "$module")"
      case "$fw" in
        "$EXPECTED_FW")
          say "колесо $module: подтверждено по @TLM — fw=$fw" ;;
        "-"|"")
          say "колесо $module: не ответило на опрос (это не ошибка: проверьте журнал плат)" ;;
        *)
          warn "колесо $module: после прошивки плата сообщает fw=$fw вместо $EXPECTED_FW"
          printf '%s %s fail\n' "$(sketch_hash "$(sketch_dir "$module")/motor_wheel_$module.ino")" \
            "$(readlink -f "$(read_env "RC_WHEEL_${module}_PORT" "")" 2>/dev/null || true)" \
            >"$STATE_DIR/$module.flash"
          failed=$((failed + 1)) ;;
      esac
    done
  else
    say "платы не ответили на опрос после прошивки — проверьте их телеметрию на экране"
  fi
fi

say "итог: прошито $flashed, уже было актуально $current, ошибок $failed, без порта ${#unassigned[@]}, нет устройства ${#absent[@]}."
[[ $failed -eq 0 ]] || exit 1
exit 0
