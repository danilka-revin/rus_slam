#!/usr/bin/env python3
"""Прочитать версию прошивки (`fw=`) с плат колёс, не мешая программе.

Зачем: «прошивка обновилась» — это не то же самое, что «плата работает на новой
прошивке». Плату могли заменить, прошить вручную старой копией с рабочего стола
или прошивка могла не дойти. Поэтому перед прошивкой (и после неё) мы спрашиваем
саму плату: она в каждой телеметрической строке `@TLM … fw=N` сообщает протокол
своей прошивки. Сравнив `N` с `FIRMWARE_PROTOCOL` из скетча, видно, актуальна ли
прошивка на самом деле.

Порты берутся из `.env` (`RC_WHEEL_FL_PORT … RC_WHEEL_RR_PORT`) — то же место,
что и у автопрошивки. Открываются они только на время опроса; вызывающий скрипт
(`scripts/flash_firmware.sh`) делает это до того, как программа займёт USB.

Вывод: строка `FL=7 FR=7 RL=- RR=-` (или JSON с `--json`). `-` — плата не
ответила. Код возврата: 0 — ответила хотя бы одна плата, 1 — ни одна, 3 — нет
pyserial.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import threading
import time
from pathlib import Path

MODULES = ("FL", "FR", "RL", "RR")
ENV_KEYS = {module: "RC_WHEEL_%s_PORT" % module for module in MODULES}
#: Строка телеметрии прошивки: «@TLM deg=… fw=6 …». Ищем именно поле fw.
FW_RE = re.compile(r"(?:^|[ \t])fw=(\d+)\b")
#: Сколько ждать первую телеметрию: плата при открытии порта перезагружается.
DEFAULT_TIMEOUT = 6.0


def parse_firmware(line: str) -> int | None:
    """Версия прошивки из строки монитора (None — это не телеметрия с fw=)."""
    text = str(line or "")
    if "@TLM" not in text:
        return None
    match = FW_RE.search(text)
    if match is None:
        return None
    try:
        return int(match.group(1))
    except ValueError:                        # pragma: no cover — (\d+) уже число
        return None


def read_env_ports(env_path: Path | str) -> dict[str, str]:
    """Порты колёс из .env: пустое значение — колесо не назначено."""
    ports = {module: "" for module in MODULES}
    try:
        text = Path(env_path).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ports
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key, value = key.strip(), value.strip().strip('"').strip("'")
        for module, name in ENV_KEYS.items():
            if key == name:
                ports[module] = value
    # Окружение главнее файла: так же поступает и сама программа.
    for module, name in ENV_KEYS.items():
        if os.environ.get(name, "").strip():
            ports[module] = os.environ[name].strip()
    return ports


def probe_port(port: str, timeout: float = DEFAULT_TIMEOUT) -> int | None:
    """Открыть порт, дождаться @TLM и вернуть версию прошивки платы."""
    if not port:
        return None
    try:
        import serial                          # pyserial
    except ImportError:
        raise
    deadline = time.monotonic() + max(0.5, float(timeout))
    device = None
    try:
        # exclusive: чужой процесс не должен читать тот же UART вперемешку.
        try:
            device = serial.Serial(port, 115200, timeout=0.2, exclusive=True)
        except TypeError:                      # старый pyserial без exclusive
            device = serial.Serial(port, 115200, timeout=0.2)
        while time.monotonic() < deadline:
            raw = device.readline()
            if not raw:
                continue
            version = parse_firmware(raw.decode("ascii", "replace"))
            if version is not None:
                return version
    except Exception:                          # noqa: BLE001 — порт занят/нет прав
        return None
    finally:
        if device is not None:
            try:
                device.close()
            except Exception:                  # noqa: BLE001 — порт уже мёртв
                pass
    return None


def probe(ports: dict[str, str], timeout: float = DEFAULT_TIMEOUT,
          modules=None) -> dict[str, int | None]:
    """Опросить порты параллельно: медленная плата не задерживает остальные."""
    wanted = [m for m in (modules or MODULES) if ports.get(m)]
    result: dict[str, int | None] = {module: None for module in MODULES}
    if not wanted:
        return result
    try:
        import serial                          # noqa: F401 — проверка наличия
    except ImportError:
        raise
    threads = {}
    for module in wanted:
        def worker(name=module, port=ports[module]):
            result[name] = probe_port(port, timeout)
        thread = threading.Thread(target=worker, daemon=True)
        thread.start()
        threads[module] = thread
    for thread in threads.values():
        thread.join(timeout + 1.0)
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Версии прошивок плат колёс по @TLM")
    parser.add_argument("--env-file", default=os.environ.get("RC_ENV_FILE", ".env"))
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--module", action="append", default=None,
                        help="только эти колёса (FL/FR/RL/RR), можно несколько раз")
    parser.add_argument("--port", action="append", default=None,
                        help="явный порт: --port FL=/dev/ttyUSB0 (вместо .env)")
    parser.add_argument("--json", action="store_true", help="вывод в JSON")
    args = parser.parse_args(argv)

    ports = read_env_ports(args.env_file)
    for item in args.port or []:
        module, _, path = item.partition("=")
        module = module.strip().upper()
        if module in ports:
            ports[module] = path.strip()
    modules = [m.strip().upper() for m in (args.module or MODULES)]
    try:
        versions = probe(ports, args.timeout, modules)
    except ImportError:
        print("нет pyserial: опрос плат невозможен", file=sys.stderr)
        return 3

    if args.json:
        print(json.dumps(versions, ensure_ascii=False))
    else:
        print(" ".join("%s=%s" % (module, "-" if versions[module] is None else versions[module])
                       for module in MODULES))
    return 0 if any(value is not None for value in versions.values()) else 1


if __name__ == "__main__":
    sys.exit(main())
