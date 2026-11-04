#!/usr/bin/env python3
"""Прошить плату колеса без arduino-cli: avr-gcc + avrdude.

Зачем: `arduino-cli` в России часто недоступен (downloads.arduino.cc режется), а
прошивать платы всё равно надо самим, с кнопки на бортовом экране. Здесь тот же
путь, что делает Arduino IDE, но без неё и без её загрузок:

    скетч (.ino) → avr-gcc/avr-g++ + ядро Arduino AVR → .hex → avrdude в порт

Откуда берутся части (ищутся сами, ничего не нужно настраивать):

* **avr-gcc, avr-objcopy, avrdude** — из PATH, из установленной Arduino IDE
  (`…/hardware/tools/avr/bin`, `~/.arduino15/packages/arduino/tools/…`) или из
  системных пакетов (`sudo apt install gcc-avr avr-libc avrdude`);
* **ядро Arduino AVR** — из Arduino IDE (`hardware/arduino/avr`), из
  `~/.arduino15/packages/arduino/hardware/avr/*`, из пакета `arduino-core-avr`
  или скачивается из GitHub (`codeload.github.com/arduino/ArduinoCore-avr`);
* **библиотеки** (Servo) — из Arduino IDE/`~/Arduino/libraries`, из репозитория
  (`firmware/vendor/libraries`) или скачиваются из GitHub.

GitHub в России работает, поэтому путь «скачать ядро и Servo с GitHub» здесь
основной, а `--install` умеет доставить avr-gcc/avrdude через apt.

Команды:

    scripts/avr_upload.py --check                     # что нашлось, можно ли шить
    scripts/avr_upload.py --sketch-dir DIR --port PORT  # собрать и прошить
    scripts/avr_upload.py --sketch-dir DIR --hex-only   # только собрать .hex
    scripts/avr_upload.py --install                     # доставить avr-gcc/avrdude

Коды возврата: 0 — успех; 2 — нет инструментов (нужно `--install` или IDE);
3 — нет ядра/библиотек и скачать не удалось; 1 — ошибка сборки/загрузки.
"""
from __future__ import annotations

import argparse
import glob
import importlib.util
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MCU = "atmega2560"
#: Mega 2560: файл платы в ядре Arduino AVR.
VARIANT = "mega"
DEFINES = ["-DF_CPU=16000000L", "-DARDUINO=10819", "-DARDUINO_AVR_MEGA2560",
           "-DARDUINO_ARCH_AVR"]
#: Откуда качать ядро и Servo, если на машине их нет вообще.
DEFAULT_MIRROR = "https://codeload.github.com"
CORE_REPO = "arduino/ArduinoCore-avr"
CORE_TAG = "1.8.6"
SERVO_REPO = "arduino-libraries/Servo"
SERVO_TAG = "1.2.1"
#: Библиотеки, которые нужны прошивке колеса (scan `#include <…>` в скетче).
KNOWN_LIBS = {"Servo": (SERVO_REPO, SERVO_TAG)}

EXIT_NO_TOOLS = 2
EXIT_NO_CORE = 3


def say(text: str) -> None:
    print("[avr] %s" % text, flush=True)


def warn(text: str) -> None:
    print("[avr] %s" % text, file=sys.stderr, flush=True)


def _bin(name: str, roots: list[Path]) -> str | None:
    found = shutil.which(name)
    if found:
        return found
    for root in roots:
        for pattern in (root / "bin" / name, root / name):
            if pattern.is_file() and os.access(pattern, os.X_OK):
                return str(pattern)
    return None


def _home_globs(*patterns: str) -> list[Path]:
    found: list[Path] = []
    for pattern in patterns:
        found.extend(Path(p).expanduser() for p in glob.glob(os.path.expanduser(pattern)))
    return [p for p in found if p.exists()]


def tool_roots() -> list[Path]:
    """Где искать avr-gcc/avrdude: PATH, Arduino IDE, .arduino15, apt."""
    roots: list[Path] = []
    env_root = os.environ.get("RC_AVR_ROOT", "").strip()
    if env_root:
        roots.append(Path(env_root).expanduser())
    roots += _home_globs(
        "~/.arduino15/packages/arduino/tools/avr-gcc/*",
        "~/.arduino15/packages/arduino/tools/avrdude/*",
        "~/.arduino15/packages/arduino/tools/avr-dude/*",
        "~/.arduino15/packages/arduino/hardware/tools/avr",
        "~/arduino-*/hardware/tools/avr",
        "~/Arduino*/hardware/tools/avr",
        "/opt/arduino*/hardware/tools/avr",
        "~/.local/share/arduino*/hardware/tools/avr",
    )
    roots += [Path("/usr/share/arduino/hardware/tools/avr"), Path("/usr/bin"), Path("/usr/local/bin")]
    return roots


def find_toolchain() -> dict:
    """Собрать инструменты: чем собирать и чем заливать (пути могут быть None)."""
    roots = tool_roots()
    tools = {
        "gcc": _bin("avr-gcc", roots),
        "gxx": _bin("avr-g++", roots),
        "objcopy": _bin("avr-objcopy", roots),
        "size": _bin("avr-size", roots),
        "avrdude": _bin("avrdude", roots),
    }
    # avrdude из .arduino15 лежит в отдельном каталоге tools/avrdude — ищем и там.
    if tools["avrdude"] is None:
        for path in _home_globs("~/.arduino15/packages/arduino/tools/avrdude/*/bin/avrdude",
                                "~/arduino-*/hardware/tools/avr/bin/avrdude"):
            tools["avrdude"] = str(path)
            break
    tools["avrdude_conf"] = _avrdude_conf(tools["avrdude"])
    tools["core"] = find_core()
    tools["libraries"] = [str(p) for p in find_libraries()]
    tools["ready"] = all(tools[key] for key in ("gcc", "gxx", "objcopy", "avrdude"))
    return tools


def _avrdude_conf(avrdude: str | None) -> str | None:
    """avrdude нужен свой avrdude.conf — иначе «cannot find configuration»."""
    if not avrdude:
        return None
    for candidate in _home_globs("~/.arduino15/packages/arduino/tools/avrdude/*/etc/avrdude.conf",
                                 "~/arduino-*/hardware/tools/avr/etc/avrdude.conf",
                                 "/etc/avrdude.conf",
                                 "/usr/share/arduino/hardware/tools/avr/etc/avrdude.conf"):
        return str(candidate)
    near = Path(avrdude).resolve().parent.parent / "etc" / "avrdude.conf"
    if near.is_file():
        return str(near)
    return None


def find_core() -> str | None:
    """Каталог ядра Arduino AVR (внутри — cores/arduino/Arduino.h)."""
    explicit = os.environ.get("RC_ARDUINO_CORE", "").strip()
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    candidates += _home_globs(
        "~/.arduino15/packages/arduino/hardware/avr/*",
        "~/Arduino/hardware/arduino/avr",
        "~/arduino-*/hardware/arduino/avr",
        "~/Arduino*/hardware/arduino/avr",
        "/opt/arduino*/hardware/arduino/avr",
        "/usr/share/arduino/hardware/arduino/avr",
        "~/.local/share/arduino*/hardware/arduino/avr",
    )
    candidates.append(ROOT / "var" / "toolchain" / "ArduinoCore-avr")
    candidates.append(ROOT / "firmware" / "vendor" / "ArduinoCore-avr")
    for path in candidates:
        if (path / "cores" / "arduino" / "Arduino.h").is_file():
            return str(path)
    return None


def find_libraries() -> list[Path]:
    """Каталоги библиотек Arduino (в них ищем Servo)."""
    found: list[Path] = []
    env_dirs = os.environ.get("RC_ARDUINO_LIBS", "")
    for item in env_dirs.split(os.pathsep):
        if item.strip():
            found.append(Path(item.strip()).expanduser())
    found += _home_globs(
        "~/Arduino/libraries",
        "~/.arduino15/libraries",
        "~/.arduino15/packages/arduino/hardware/avr/*/libraries",
        "~/arduino-*/libraries",
        "/usr/share/arduino/libraries",
        "/opt/arduino*/libraries",
    )
    found.append(ROOT / "firmware" / "vendor" / "libraries")
    return [path for path in found if path.is_dir()]


def _download(url: str, target: Path, timeout: float = 120.0) -> bool:
    say("скачиваю %s" % url)
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            target.write_bytes(response.read())
        return True
    except (urllib.error.URLError, OSError, ValueError) as exc:
        warn("не удалось скачать %s: %s" % (url, exc))
        return False


def _unpack(archive: Path, into: Path) -> Path | None:
    """tar.gz → каталог; возвращаем единственный верхний каталог архива."""
    try:
        with tarfile.open(archive) as tar:
            members = tar.getmembers()
            if not members:
                return None
            names = {m.name.split("/")[0] for m in members}
            tar.extractall(into)
    except (tarfile.TarError, OSError) as exc:
        warn("архив %s не распаковался: %s" % (archive.name, exc))
        return None
    if len(names) != 1:
        return into if names else None
    return into / names.pop()


def mirror_url(repo: str, tag: str) -> str:
    """Адрес архива из GitHub (или своего зеркала: RC_FIRMWARE_MIRROR)."""
    base = (os.environ.get("RC_FIRMWARE_MIRROR") or DEFAULT_MIRROR).rstrip("/")
    if base != DEFAULT_MIRROR and "{repo}" in base:
        return base.format(repo=repo, tag=tag)
    if base != DEFAULT_MIRROR and "{repo}" not in base:
        # Своё зеркало: https://сервер/arduino/ArduinoCore-avr/1.8.6.tar.gz
        return "%s/%s/%s.tar.gz" % (base, repo, tag)
    return "%s/%s/tar.gz/refs/tags/%s" % (base, repo, tag)


def ensure_core(root: Path | None = None) -> str | None:
    """Ядро Arduino AVR: найти на машине или скачать с GitHub (работает в РФ)."""
    core = find_core()
    if core:
        return core
    project = Path(root) if root else ROOT
    into = project / "var" / "toolchain"
    into.mkdir(parents=True, exist_ok=True)
    archive = into / "ArduinoCore-avr.tar.gz"
    if not _download(mirror_url(CORE_REPO, CORE_TAG), archive):
        return None
    unpacked = _unpack(archive, into)
    try:
        archive.unlink()
    except OSError:
        pass
    if unpacked is None:
        return None
    target = into / "ArduinoCore-avr"
    if unpacked != target:
        shutil.rmtree(target, ignore_errors=True)
        unpacked.rename(target)
    if (target / "cores" / "arduino" / "Arduino.h").is_file():
        say("ядро Arduino AVR установлено: %s" % target)
        return str(target)
    return None


def ensure_library(name: str, root: Path | None = None) -> Path | None:
    """Библиотека (Servo): найти в Arduino или скачать из GitHub."""
    for base in find_libraries():
        for candidate in (base / name, base / (name + "-master")):
            if candidate.is_dir():
                return candidate
    spec = KNOWN_LIBS.get(name)
    if spec is None:
        return None
    repo, tag = spec
    project = Path(root) if root else ROOT
    into = project / "var" / "toolchain" / "libraries"
    into.mkdir(parents=True, exist_ok=True)
    archive = into / ("%s.tar.gz" % name)
    if not _download(mirror_url(repo, tag), archive):
        return None
    unpacked = _unpack(archive, into)
    try:
        archive.unlink()
    except OSError:
        pass
    if unpacked is None:
        return None
    target = into / name
    if unpacked != target:
        shutil.rmtree(target, ignore_errors=True)
        unpacked.rename(target)
    say("библиотека %s установлена: %s" % (name, target))
    return target if target.is_dir() else None


def sketch_includes(ino: Path) -> list[str]:
    """Какие библиотеки просит скетч: `#include <Servo.h>` → Servo."""
    import re

    text = ino.read_text(encoding="utf-8", errors="replace")
    names = []
    for match in re.finditer(r'^\s*#include\s*[<"]([^>"]+)[>"]', text, re.M):
        header = Path(match.group(1)).stem
        if header in ("Arduino", "avr", "EEPROM", "Wire", "SPI", "SoftwareSerial"):
            continue
        if header not in names:
            names.append(header)
    return names


def _load_avr_build():
    path = ROOT / "firmware" / "tools" / "avr_build.py"
    spec = importlib.util.spec_from_file_location("avr_build_tool", str(path))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def build(sketch_dir: Path, out_dir: Path, strict: bool = False) -> Path:
    """Собрать скетч в .hex. Бросает RuntimeError с понятным текстом."""
    tools = find_toolchain()
    if not all(tools[key] for key in ("gcc", "gxx", "objcopy")):
        raise RuntimeError("нет avr-gcc/avr-objcopy")
    core = tools["core"] or ensure_core()
    if not core:
        raise RuntimeError("нет ядра Arduino AVR")
    core_path = Path(core)
    ino_files = sorted(Path(sketch_dir).glob("*.ino"))
    if not ino_files:
        raise RuntimeError("в %s нет .ino" % sketch_dir)
    ino = ino_files[0]
    avr_build = _load_avr_build()
    out_dir.mkdir(parents=True, exist_ok=True)

    include = ["-I", str(core_path / "cores" / "arduino"),
               "-I", str(core_path / "variants" / VARIANT),
               "-I", str(sketch_dir)]
    lib_sources: list[Path] = []
    for name in sketch_includes(ino):
        library = ensure_library(name)
        if library is None:
            if strict:
                raise RuntimeError("нет библиотеки %s" % name)
            warn("библиотека %s не найдена — пробую без неё" % name)
            continue
        include += ["-I", str(library), "-I", str(library / "src")]
        for pattern in ("src/**/*.cpp", "src/**/*.c", "*.cpp", "*.c"):
            lib_sources += sorted(library.glob(pattern))

    common = ["-c", "-g", "-Os", "-ffunction-sections", "-fdata-sections", "-flto",
              "-mmcu=" + MCU, *DEFINES, *include]
    cflags = [*common, "-std=gnu11", "-fno-fat-lto-objects"]
    cxxflags = [*common, "-std=gnu++11", "-fpermissive", "-fno-exceptions",
                "-fno-threadsafe-statics", "-Wno-error=narrowing"]

    clean = os.environ.get("RC_FIRMWARE_CLEAN") == "1"

    def run(command: list[str]) -> str:
        result = subprocess.run(command, capture_output=True, text=True)
        if result.returncode != 0:
            raise RuntimeError((result.stdout + result.stderr).strip()[-1500:])
        return result.stdout + result.stderr

    def compile_object(command: list[str], target: Path, source: Path) -> None:
        """Не пересобирать одно и то же: ядро и библиотеки не меняются.

        Сборка ядра — это десятки файлов; без кеша каждая из четырёх плат
        стоила бы полминуты. Кеш лежит рядом с .hex (var/firmware-build/<колесо>).
        """
        if not clean and target.is_file() and target.stat().st_mtime >= source.stat().st_mtime:
            return
        run(command)

    core_dir = core_path / "cores" / "arduino"
    sources = (sorted(core_dir.glob("*.c")) + sorted(core_dir.glob("*.cpp"))
               + sorted(core_dir.glob("*.S")) + lib_sources)
    objects: list[str] = []
    for source in sources:
        # Имя объекта уникально: у ядра и библиотек бывают одноимённые файлы.
        target = out_dir / (source.parent.name + "-" + source.name + ".o")
        if source.suffix == ".c":
            compile_object([tools["gcc"], *cflags, "-w", str(source), "-o", str(target)],
                           target, source)
        elif source.suffix == ".cpp":
            compile_object([tools["gxx"], *cxxflags, "-w", str(source), "-o", str(target)],
                           target, source)
        else:
            compile_object([tools["gcc"], "-c", "-g", "-x", "assembler-with-cpp", "-flto",
                            "-mmcu=" + MCU, *DEFINES, *include, str(source), "-o", str(target)],
                           target, source)
        objects.append(str(target))

    cpp = out_dir / (ino.stem + ".ino.cpp")
    cpp.write_text(avr_build.sketch_source(ino), encoding="utf-8")
    sketch_object = out_dir / (ino.stem + ".ino.o")
    run([tools["gxx"], *cxxflags, "-Wall", "-Wextra", str(cpp), "-o", str(sketch_object)])
    elf = out_dir / (ino.stem + ".elf")
    run([tools["gcc"], "-w", "-Os", "-g", "-flto", "-fuse-linker-plugin",
         "-Wl,--gc-sections", "-mmcu=" + MCU, "-o", str(elf), str(sketch_object),
         *objects, "-lm"])
    hex_file = out_dir / (ino.stem + ".hex")
    run([tools["objcopy"], "-O", "ihex", "-R", ".eeprom", str(elf), str(hex_file)])
    # Пустой .hex — это провал сборки, а не «всё хорошо»: заливать нечего.
    if not hex_file.is_file() or hex_file.stat().st_size == 0:
        raise RuntimeError("objcopy не создал %s" % hex_file.name)
    if tools["size"]:
        try:
            say(run([tools["size"], "-C", "--mcu=" + MCU, str(elf)]).strip())
        except RuntimeError:
            pass
    return hex_file


def upload_command(hex_file: Path, port: str, tools: dict | None = None) -> list[str]:
    """Та же загрузка, что делает Arduino IDE для Mega 2560 (wiring, 115200)."""
    tools = tools or find_toolchain()
    command = [tools["avrdude"] or "avrdude"]
    if tools.get("avrdude_conf"):
        command += ["-C", str(tools["avrdude_conf"])]
    command += ["-v", "-p", MCU, "-c", "wiring", "-P", port, "-b", "115200",
                "-D", "-U", "flash:w:%s:i" % hex_file]
    return command


def upload(hex_file: Path, port: str) -> str:
    tools = find_toolchain()
    if not tools["avrdude"]:
        raise RuntimeError("нет avrdude")
    result = subprocess.run(upload_command(hex_file, port, tools),
                            capture_output=True, text=True)
    output = result.stdout + result.stderr
    if result.returncode != 0:
        raise RuntimeError(output.strip()[-1200:])
    return output


def install_tools() -> bool:
    """Доставить avr-gcc/avrdude через apt (в РФ работает; нужен sudo)."""
    if find_toolchain()["ready"]:
        say("avr-gcc и avrdude уже есть — ставить нечего.")
        return True
    packages = ["gcc-avr", "avr-libc", "avrdude"]
    for prefix in (["sudo", "-n"], ["sudo"]):
        command = prefix + ["apt-get", "install", "-y", *packages]
        say("пробую: %s" % " ".join(command))
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=900)
        except (OSError, subprocess.SubprocessError) as exc:
            warn("apt не запустился: %s" % exc)
            continue
        if result.returncode == 0:
            ok = find_toolchain()["ready"]
            say("avr-gcc/avrdude установлены" if ok else "apt завершился, но инструментов нет")
            return ok
        tail = (result.stderr or result.stdout or "").strip().splitlines()[-3:]
        warn("apt не смог: %s" % (" | ".join(tail) or result.returncode))
        if prefix == ["sudo", "-n"]:
            continue
        break
    warn("поставьте вручную: sudo apt install gcc-avr avr-libc avrdude")
    return False


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Прошивка платы без arduino-cli")
    parser.add_argument("--sketch-dir", help="каталог со скетчем motor_wheel_XX.ino")
    parser.add_argument("--port", help="USB-порт платы (/dev/ttyUSB0)")
    parser.add_argument("--check", action="store_true", help="что найдено, можно ли шить")
    parser.add_argument("--install", action="store_true", help="поставить avr-gcc/avrdude")
    parser.add_argument("--hex-only", action="store_true", help="только собрать .hex")
    parser.add_argument("--json", action="store_true", help="машинный вывод для --check")
    parser.add_argument("--out-dir", help="куда положить .hex (по умолчанию рядом)")
    args = parser.parse_args(argv)

    if args.install:
        ok = install_tools()
        return 0 if ok else EXIT_NO_TOOLS

    if args.check:
        tools = find_toolchain()
        core = tools["core"]
        payload = {
            "ready": bool(tools["ready"] and core),
            "gcc": tools["gcc"], "avrdude": tools["avrdude"],
            "core": core, "libraries": tools["libraries"],
        }
        if args.json:
            import json

            print(json.dumps(payload, ensure_ascii=False))
        else:
            say("avr-gcc: %s" % (tools["gcc"] or "нет"))
            say("avrdude: %s" % (tools["avrdude"] or "нет"))
            say("ядро Arduino AVR: %s" % (core or "нет (скачаю с GitHub при первой прошивке)"))
            say("библиотеки: %s" % (", ".join(tools["libraries"]) or "нет"))
            say("шить можно: %s" % ("да" if payload["ready"] else "нет, нужны avr-gcc и avrdude"))
        return 0 if payload["ready"] else EXIT_NO_TOOLS

    if not args.sketch_dir:
        parser.print_help()
        return EXIT_NO_TOOLS
    sketch_dir = Path(args.sketch_dir).expanduser()
    out_dir = Path(args.out_dir).expanduser() if args.out_dir else sketch_dir
    started = time.monotonic()
    try:
        hex_file = build(sketch_dir, out_dir)
    except RuntimeError as exc:
        warn("сборка не удалась: %s" % exc)
        if "ядро" in str(exc):
            return EXIT_NO_CORE
        return 1
    say("собрано за %.1f с: %s" % (time.monotonic() - started, hex_file))
    if args.hex_only:
        return 0
    if not args.port:
        warn("не указан --port: .hex собран, но не загружен")
        return 1
    try:
        upload(hex_file, args.port)
    except RuntimeError as exc:
        warn("загрузка в %s не удалась: %s" % (args.port, exc))
        return 1
    say("загружено в %s" % args.port)
    return 0


if __name__ == "__main__":
    sys.exit(main())
