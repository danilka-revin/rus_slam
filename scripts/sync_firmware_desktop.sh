#!/usr/bin/env bash
# Кладёт на рабочий стол актуальные прошивки Arduino: по одной на каждое колесо.
#
# Запускается сам при каждом старте через ярлык «Запустить робот»
# (scripts/start_desktop.sh), при создании ярлыка (scripts/make_shortcut.sh),
# при общем запуске робота (scripts/start_robot.sh) и после кнопки «Обновить с
# GitHub» (robot_control/updater.py), поэтому на рабочем столе всегда лежат
# те же файлы, что и в firmware/ репозитория.
# Копии зеркальные: правки на рабочем столе при следующем запуске заменятся
# версией из репозитория — исходник правится в firmware/motor_wheel.
#
# Связь с колёсами — только USB-UART: каждое колесо — своя плата со своим
# кабелем и своей прошивкой. Готовые motor_wheel_FL/FR/RL/RR.ino отличаются
# одной строкой (MODULE_ID) — их нельзя перепутать, и сервер сам поймёт,
# какое колесо на каком порту (см. slam_gui/backend.py MasterSource).
# Старые файлы прошивок схемы «мастер + слейвы» с рабочего стола убираются.
#
# Файл переписывается только если содержимое изменилось: актуальная копия
# не трогается (даже время изменения сохраняется). Ошибка копирования не
# критична для запуска робота — вызывающий скрипт предупреждает и идёт дальше.
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

# Где лежит рабочий стол. Порядок поиска:
#   1) каталог, где уже стоит ярлык «Запустить робот» (robot-control.desktop) —
#      файлы обязаны оказаться рядом с ярлыком, что бы ни думал xdg;
#   2) xdg-user-dir DESKTOP — но НЕ само $HOME: при не настроенном каталоге
#      xdg-user-dir отдаёт $HOME, и файлы «пропадали» бы в домашней папке;
#   3) известные имена каталога в разных локалях (Desktop, «Рабочий стол»,
#      Skrivebord, …) — какой существует;
#   4) иначе создаём ~/Desktop.
find_desktop() {
  local candidate
  for candidate in "$HOME"/*/; do
    candidate="${candidate%/}"
    if [[ -f "$candidate/robot-control.desktop" ]]; then
      printf '%s' "$candidate"
      return
    fi
  done
  if command -v xdg-user-dir >/dev/null 2>&1; then
    candidate="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
    if [[ -n "$candidate" && "$candidate" != "$HOME" && -d "$candidate" ]]; then
      printf '%s' "$candidate"
      return
    fi
  fi
  for candidate in "$HOME/Desktop" "$HOME/Рабочий стол" "$HOME/Рабочая область" \
                   "$HOME/Робочий стіл" "$HOME/Skrivebord" "$HOME/Skrivbord" \
                   "$HOME/Schreibtisch" "$HOME/Escritorio" "$HOME/Bureau" \
                   "$HOME/Pulpit" "$HOME/Scrivania" "$HOME/Área de trabalho"; do
    if [[ -d "$candidate" ]]; then
      printf '%s' "$candidate"
      return
    fi
  done
  printf '%s' "$HOME/Desktop"
}

DESK="$(find_desktop)"
mkdir -p "$DESK" || { echo "[firmware] не удалось создать папку рабочего стола: $DESK" >&2; exit 1; }

# Старые файлы прошивок схемы «мастер + слейвы» (I²C): их больше нет в
# репозитории, на рабочем столе они только путают — убираем.
for stale in "$DESK"/motor_master*.ino "$DESK"/motor_node*.ino; do
  [[ -f "$stale" ]] || continue
  rm -f -- "$stale" && echo "[firmware] убрана устаревшая прошивка (мастер+слейвы): $(basename "$stale")"
done

FAILED=0
sync_one() {
  local src="$1" title="$2" dst tmp
  dst="$DESK/$(basename "$src")"
  if [[ ! -f "$src" ]]; then
    echo "[firmware] нет исходника прошивки $title: $src" >&2
    FAILED=1
    return
  fi
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    echo "[firmware] $title: на рабочем столе уже актуальная версия ($(basename "$src"))"
    return
  fi
  # Через временный файл + mv: прерванное копирование не оставит на рабочем
  # столе половину прошивки, которую Arduino IDE потом не соберёт.
  tmp="$dst.tmp.$$"
  if cp -- "$src" "$tmp" && mv -f -- "$tmp" "$dst"; then
    echo "[firmware] $title: прошивка обновлена на рабочем столе: $dst"
  else
    rm -f "$tmp"
    echo "[firmware] не удалось скопировать прошивку $title в $dst" >&2
    FAILED=1
  fi
}

# Прошивка конкретного колеса: имя (MODULE_ID) уже вписано, править файл не
# нужно. Четыре платы, прошитые одним и тем же motor_wheel.ino, все называют
# себя FL — сервер видит четыре одинаковые прошивки и честно просит
# перепрошить. Готовые файлы исключают эту ошибку.
make_wheel() {
  local module="$1" src dst tmp
  src="$ROOT/firmware/motor_wheel/motor_wheel.ino"
  dst="$DESK/motor_wheel_${module}.ino"
  if [[ ! -f "$src" ]]; then
    echo "[firmware] нет исходника прошивки колеса: $src" >&2
    FAILED=1
    return
  fi
  tmp="$dst.tmp.$$"
  if ! sed -e "s/^#define MODULE_ID .*/#define MODULE_ID \"${module}\"/" \
           -- "$src" >"$tmp"; then
    rm -f "$tmp"
    echo "[firmware] не удалось собрать motor_wheel_${module}.ino" >&2
    FAILED=1
    return
  fi
  if [[ -f "$dst" ]] && cmp -s "$tmp" "$dst"; then
    rm -f "$tmp"
    echo "[firmware] колесо ${module}: на рабочем столе уже актуальная версия"
    return
  fi
  if mv -f -- "$tmp" "$dst"; then
    echo "[firmware] колесо ${module}: прошивка обновлена на рабочем столе: $dst"
  else
    rm -f "$tmp"
    echo "[firmware] не удалось скопировать прошивку колеса ${module} в $dst" >&2
    FAILED=1
  fi
}

sync_one "$ROOT/firmware/motor_wheel/motor_wheel.ino" "колесо (шаблон: имя в начале файла)"
make_wheel FL
make_wheel FR
make_wheel RL
make_wheel RR

exit "$FAILED"
