"""Проверки прошивки и документации без железа.

Запуск:  python3 -m pytest tests/test_firmware_sim.py -q

Что проверяется:

* скетч `firmware/motor_wheel` собирается g++ в четырёх экземплярах
  (FL/FR/RL/RR) и проходит все сценарии хост-симуляции (`tests/firmware_sim`);
* телеметрия, которую отдаёт симулятор, соответствует описанию в
  `docs/SERIAL_PROTOCOL.md` (поля `@F` и `@TLM`, версия fw, роль);
* распиновка в `docs/ELECTRICAL_AND_PINOUTS.md` и `firmware/README.md`
  совпадает с константами скетча — документы не должны расходиться с кодом;
* старые артефакты (удалённая бинарная прошивка) не возвращаются.

Тест не требует Arduino IDE и не трогает реальные USB-порты.
"""

from __future__ import annotations

import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SKETCH = ROOT / "firmware" / "motor_wheel" / "motor_wheel.ino"
SIM_DIR = ROOT / "tests" / "firmware_sim"
FIRMWARE_README = ROOT / "firmware" / "README.md"
PINOUT = ROOT / "docs" / "ELECTRICAL_AND_PINOUTS.md"
PROTOCOL = ROOT / "docs" / "SERIAL_PROTOCOL.md"


def _text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _const(text: str, name: str) -> str:
    match = re.search(r"\bconst\s+[\w ]+?\b%s\s*=\s*([^;]+);" % re.escape(name), text)
    assert match, name
    return match.group(1).strip().rstrip("f").rstrip("UL").rstrip("L")


@pytest.fixture(scope="module")
def simulator(tmp_path_factory):
    compiler = shutil.which("g++") or shutil.which("clang++")
    if not compiler:
        pytest.skip("нет g++/clang++ — симуляция прошивки пропущена")
    binary = tmp_path_factory.mktemp("firmware-sim") / "sim"
    result = subprocess.run(
        [compiler, "-std=c++17", "-O1", "-w", "-I", str(SIM_DIR / "stubs"),
         str(SIM_DIR / "sim.cpp"), "-o", str(binary)],
        capture_output=True, text=True, timeout=600,
    )
    assert result.returncode == 0, result.stderr[-4000:]
    return binary


def test_all_firmware_scenarios_pass(simulator):
    result = subprocess.run([str(simulator)], capture_output=True, text=True, timeout=900)
    report = result.stdout + "\n" + result.stderr[-6000:]
    assert result.returncode == 0, report
    summary = re.search(r"(\d+)/(\d+) сценариев прошли", result.stdout)
    assert summary and summary.group(1) == summary.group(2), report


def test_telemetry_matches_documented_format(simulator):
    result = subprocess.run([str(simulator), "tlm_dump"], capture_output=True, text=True, timeout=300)
    assert result.returncode == 0, result.stderr[-4000:]
    fast = [line for line in result.stdout.splitlines() if line.startswith("@F ")]
    full = [line for line in result.stdout.splitlines() if line.startswith("@TLM ")]
    assert fast, "@F не найден"
    assert full, "@TLM не найден"

    fw = int(_const(_text(SKETCH), "FIRMWARE_PROTOCOL"))
    assert fw == 25

    # @F: 20 полей + CRC, роль в поле 2.
    for line in fast:
        fields = line.split()
        assert len(fields) == 21, line
        assert int(fields[1]) == fw
        assert int(fields[2]) in (1, 2, 3, 4)
        assert re.fullmatch(r"[0-9A-Fa-f]{4}", fields[-1]), line

    # @TLM: ключ=значение, обязательные поля на месте.
    required = ("mod=", "deg=", "tgt=", "cal=", "home=", "err=", "fw=", "pot=",
                "pm=", "ph=", "zfault=", "sc_rpm=", "sc_hz=", "sc_ppr=",
                "brake_id=", "live_id=", "crc=")
    for line in full:
        for key in required:
            assert key in line, (key, line)
        assert "fw=%d" % fw in line


def test_docs_and_sketch_agree_on_pins():
    sketch = _text(SKETCH)
    expected = {
        "STEP_PUL_PIN": ("D6", "D6"),
        "STEP_DIR_PIN": ("D7", "D7"),
        "STEP_ENA_PIN": ("D8", "D8"),
        "BLDC_STOP_PIN": ("D2", "D2"),
        "BLDC_SPEED_PIN": ("D3", "D3"),
        "BLDC_DIR_PIN": ("D4", "D4"),
        "BLDC_BRAKE_PIN": ("D5", "D5"),
        "OPTO_PIN": ("D18", "D18"),
        "TACH_PIN": ("D19", "D19"),
    }
    for const, (sketch_pin, doc_pin) in expected.items():
        assert _const(sketch, const) == sketch_pin.strip("D"), const
        for doc in (PINOUT, FIRMWARE_README):
            assert doc_pin in _text(doc), (const, doc.name)

    # Потенциометр и предел хода — одно число на весь стек.
    assert _const(sketch, "POT_PIN") == "A0"
    assert "A0" in _text(PINOUT)
    assert float(_const(sketch, "STEPS_PER_DEGREE")) == pytest.approx(133.333333, rel=1e-6)
    assert "133.33" in _text(PINOUT)
    assert "133.33" in _text(_text(PINOUT) and FIRMWARE_README)
    assert float(_const(sketch, "STEER_LIMIT_DEG")) == 100.0
    assert "±100" in _text(FIRMWARE_README)
    assert int(_const(sketch, "DRIVE_COMMAND_TIMEOUT_MS")) == 650
    assert "650 мс" in _text(PROTOCOL)


def test_old_binary_firmware_is_gone():
    assert not (ROOT / "firmware" / "module_controller").exists()
    for doc in (PROTOCOL,):
        text = _text(doc)
        assert "0xAA" not in text and "0xBB" not in text, doc


def test_reference_sketch_is_untouched_benchmark():
    reference = ROOT / "firmware" / "reference" / "steering_tested" / "steering_tested.ino"
    assert reference.is_file()
    text = _text(reference)
    # Пины эталона: TB6600 6/7/8, оптодатчик 18 — с ними сверяется прошивка.
    for pin in ("PUL = 6", "DIR = 7", "ENA = 8", "OPTO_PIN = 18"):
        assert pin in text, pin
