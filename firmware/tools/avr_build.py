#!/usr/bin/env python3
"""Сборка скетча под Arduino Mega 2560 без Arduino IDE — проверка, что прошивка
вообще компилируется тем же avr-gcc, что и в IDE.

Нужны avr-gcc (с avr-libc), ядро ArduinoCore-avr и штатная библиотека Servo:

    AVR_ROOT=/путь/к/avr     # каталог, где лежит bin/avr-gcc (у IDE: .../tools/avr-gcc/7.3.0-…)
    CORE_ROOT=/путь/к/ArduinoCore-avr
    SERVO_ROOT=/путь/к/Servo # https://github.com/arduino-libraries/Servo
    python3 firmware/tools/avr_build.py firmware/motor_wheel/motor_wheel.ino

Делает то же, что arduino-cli: дописывает #include <Arduino.h> и прототипы
функций, собирает ядро, компонует и печатает avr-size. Предупреждения
компилятора (-Wall -Wextra) печатаются; код возврата ≠ 0 при ошибке сборки.
Если есть arduino-cli, проще: arduino-cli compile --fqbn arduino:avr:mega <каталог>.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

MCU = "atmega2560"
DEFINES = ["-DF_CPU=16000000L", "-DARDUINO=10819", "-DARDUINO_AVR_MEGA2560", "-DARDUINO_ARCH_AVR"]

FUNCTION_RE = re.compile(
    r"^(?!\s)(?!(?:if|for|while|switch|return|else)\b)"
    r"((?:static\s+|inline\s+)*(?:const\s+)?(?:unsigned\s+|signed\s+)?[A-Za-z_][\w:<>]*[\s\*&]+)"
    r"([A-Za-z_]\w*)\s*\(([^;{}()]*)\)\s*\{",
    re.M,
)


def toolchain() -> tuple[Path, Path]:
    avr = Path(os.environ.get("AVR_ROOT", "")).expanduser()
    core = Path(os.environ.get("CORE_ROOT", "")).expanduser()
    if not (avr / "bin" / "avr-gcc").exists():
        found = shutil.which("avr-gcc")
        if not found:
            raise SystemExit("avr-gcc не найден: задайте AVR_ROOT")
        avr = Path(found).resolve().parent.parent
    if not (core / "cores" / "arduino" / "Arduino.h").exists():
        raise SystemExit("ядро Arduino не найдено: задайте CORE_ROOT (клон ArduinoCore-avr)")
    return avr, core


def servo_library(core: Path) -> Path:
    """Найти исходники штатной Servo, не подменяя её тестовой заглушкой."""
    candidates = []
    if os.environ.get("SERVO_ROOT"):
        candidates.append(Path(os.environ["SERVO_ROOT"]).expanduser())
    candidates.extend([core / "libraries" / "Servo", core.parent / "libraries" / "Servo"])
    for candidate in candidates:
        for source in (candidate / "src", candidate):
            if (source / "Servo.h").is_file() and (source / "avr" / "Servo.cpp").is_file():
                return source
    raise SystemExit("библиотека Servo не найдена: задайте SERVO_ROOT")


def run(command: list[str]) -> str:
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stdout + result.stderr)
        raise SystemExit(result.returncode)
    return result.stdout + result.stderr


def sketch_source(ino: Path) -> str:
    """Скетч → C++ как у arduino-cli: Arduino.h и прототипы перед первой функцией."""
    source = ino.read_text(encoding="utf-8")
    prototypes = []
    for match in FUNCTION_RE.finditer(source):
        result_type, name, arguments = match.group(1).strip(), match.group(2), match.group(3).strip()
        if name in ("setup", "loop"):
            continue
        arguments = re.sub(r"\s*=\s*[^,]+", "", arguments)
        prototypes.append(f"{result_type} {name}({arguments});")
    first = FUNCTION_RE.search(source)
    position = first.start() if first else len(source)
    line = source[:position].count("\n") + 1
    return (f'#include <Arduino.h>\n#line 1 "{ino.name}"\n' + source[:position] + "\n".join(prototypes)
            + f'\n#line {line} "{ino.name}"\n' + source[position:])


def build(ino: Path, out_dir: Path) -> str:
    avr, core = toolchain()
    needs_servo = re.search(r'^\s*#include\s*[<"]Servo\.h[>"]', ino.read_text(encoding="utf-8"), re.M)
    servo = servo_library(core) if needs_servo else None
    gcc, gxx = str(avr / "bin" / "avr-gcc"), str(avr / "bin" / "avr-g++")
    include = ["-I", str(core / "cores" / "arduino"), "-I", str(core / "variants" / "mega")]
    if servo is not None:
        include += ["-I", str(servo)]
    common = ["-c", "-g", "-Os", "-ffunction-sections", "-fdata-sections", "-flto",
              "-mmcu=" + MCU, *DEFINES, *include]
    cflags = [*common, "-std=gnu11", "-fno-fat-lto-objects"]
    cxxflags = [*common, "-std=gnu++11", "-fpermissive", "-fno-exceptions",
                "-fno-threadsafe-statics", "-Wno-error=narrowing"]
    sources = sorted((core / "cores" / "arduino").glob("*.c")) \
        + sorted((core / "cores" / "arduino").glob("*.cpp")) \
        + sorted((core / "cores" / "arduino").glob("*.S"))
    if servo is not None:
        sources.append(servo / "avr" / "Servo.cpp")
    objects = []
    for source in sources:
        target = out_dir / (source.name + ".o")
        if source.suffix == ".c":
            run([gcc, *cflags, "-w", str(source), "-o", str(target)])
        elif source.suffix == ".cpp":
            run([gxx, *cxxflags, "-w", str(source), "-o", str(target)])
        else:
            run([gcc, "-c", "-g", "-x", "assembler-with-cpp", "-flto", "-mmcu=" + MCU,
                 *DEFINES, *include, str(source), "-o", str(target)])
        objects.append(str(target))
    cpp = out_dir / (ino.stem + ".ino.cpp")
    cpp.write_text(sketch_source(ino), encoding="utf-8")
    sketch_object = out_dir / (ino.stem + ".ino.o")
    warnings = run([gxx, *cxxflags, "-Wall", "-Wextra", "-I", str(ino.parent), str(cpp),
                    "-o", str(sketch_object)])
    # Arduino IDE помещает ядро в архив: иначе неиспользуемый Tone.cpp
    # определит тот же Timer2 ISR, что и прошивка руления.
    archive = out_dir / "core.a"
    ar = avr / "bin" / "avr-gcc-ar"
    if not ar.exists():
        ar = avr / "bin" / "avr-ar"
    run([str(ar), "rcs", str(archive), *objects])
    elf = out_dir / (ino.stem + ".elf")
    run([gcc, "-w", "-Os", "-g", "-flto", "-fuse-linker-plugin", "-Wl,--gc-sections",
         "-mmcu=" + MCU, "-o", str(elf), str(sketch_object), str(archive), "-lm"])
    size = run([str(avr / "bin" / "avr-size"), "-C", "--mcu=" + MCU, str(elf)])
    return warnings + size


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    for name in argv:
        ino = Path(name).resolve()
        with tempfile.TemporaryDirectory(prefix="avr-build-") as tmp:
            print(f"== {ino.name}")
            print(build(ino, Path(tmp)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
