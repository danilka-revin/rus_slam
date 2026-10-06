#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
backend.py — сервер борта RUS SLAM: отдаёт экраны и данные любому браузеру.

Ничего не открывает и не показывает сам: робот лишь отвечает по сети, а
страницы смотрят в браузере — на дисплее робота, планшете или ноутбуке.
Один процесс отдаёт оба экрана и данные к ним:

    /                     → основной экран робота (main.html, киоск)
    /index.html, /console → инженерный пульт (index.html)
    /api/state            → состояние: двигатели, АКБ, груз, замок, связь
    /api/lock/open        → открыть грузовой отсек по PIN-коду
    /api/lock/close       → закрыть отсек
    /api/lock/pin         → сменить PIN-код
    /api/audit            → журнал доступа (аудит с хеш-цепочкой)
    /api/health           → проверка живости

Источники данных (выбираются автоматически или флагом):
    --source sim      демонстрационная физика (стенд без робота) — по умолчанию;
    --source serial   реальные модули: кадры телеметрии 16 Б по /dev/ttyUSB*
                      (протокол: docs/SERIAL_PROTOCOL.md, CRC16/Modbus);
    --source ros      ROS 2 (rclpy): /modules/state, /battery, /cargo/lock.

Замок: PIN-код хранится как SHA-256(salt + pin) в gui/state/lock.json,
5 неудачных попыток → блокировка 30 с, каждое событие — в журнал аудита.
Реальный замок вызывается внешней командой:

    RUS_SLAM_LOCK_CMD='gpio write 7 1'   (open)   /  RUS_SLAM_LOCK_CMD_CLOSE  (close)

Примеры запуска:
    python3 gui/backend.py                          # только сервер (штатный режим)
    python3 gui/backend.py --source serial --ports /dev/ttyUSB0,/dev/ttyUSB1,/dev/ttyUSB2,/dev/ttyUSB3
    python3 gui/backend.py --source ros --pin 2580
    python3 gui/backend.py --kiosk                   # опция: дисплей на борту, браузер без рамок
    python3 gui/backend.py --open                    # опция: открыть страницу в браузере робота

Кто где смотрит:
    на роботе     http://127.0.0.1:8080/            основной экран
    планшет/ПК    http://<ip-робота>:8080/          основной экран (оператор, получатель)
    инженер       http://<ip-робота>:8080/console   инженерный пульт, удалённо
"""

import argparse
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
STATE_DIR = os.path.join(ROOT, "state")
LOCK_FILE = os.path.join(STATE_DIR, "lock.json")
MAIN_PAGE = "/main.html"
CONSOLE_PAGE = "/index.html"

DEFAULT_PIN = "2580"
MAX_ATTEMPTS = 5
LOCK_MS = 30_000

# --- Протокол (docs/SERIAL_PROTOCOL.md) -------------------------------------
CMD_SYNC = (0xAA, 0x55)
TLM_SYNC = (0xBB, 0x44)
CMD_LEN, TLM_LEN = 10, 16
STATUS_ENABLED, STATUS_HOMED, STATUS_FAULT = 0x01, 0x02, 0x04
MODULE_NAMES = {1: "FL", 2: "FR", 3: "RL", 4: "RR"}
MODULE_TITLES = {
    "FL": "передний левый", "FR": "передний правый",
    "RL": "задний левый", "RR": "задний правый",
}
WHEEL_R_M = 0.127            # радиус колеса Xiaomi M365 Pro, м

# --- АКБ 12S3P LiFePO4 (совпадает с gui/console-core.js) --------------------
PACK = {
    "series": 12, "parallel": 3, "cellAh": 6.2,
    "nominalV": 38.4, "fullV": 43.8, "emptyV": 30.0,
    "capacityAh": 18.6, "capacityWh": 714.2,
    "internalR": 0.075, "bmsA": 60, "fuseA": 25,
    "lowV": 35.5, "criticalV": 33.5, "tempWarnC": 45, "tempMaxC": 60,
    "ocv": [(2.50, 0), (2.80, 3), (3.00, 7), (3.10, 10), (3.20, 15), (3.25, 30),
            (3.30, 50), (3.33, 70), (3.35, 85), (3.40, 95), (3.45, 98), (3.65, 100)],
}


# ============================================================================
# 1. Протокол обмена
# ============================================================================
def crc16(data):
    """CRC16/Modbus (0xA001, init 0xFFFF). Эталон: b'123456789' → 0x4B37."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte & 0xFF
        for _ in range(8):
            crc = ((crc >> 1) ^ 0xA001) if (crc & 1) else (crc >> 1)
    return crc & 0xFFFF


def build_command(module_id, steer_cdeg=0, pwm=0, enable=False, home=False):
    """Кадр команды ПК → модуль, 10 байт."""
    steer = max(-32767, min(32767, int(round(steer_cdeg))))
    duty = max(-1000, min(1000, int(round(pwm))))
    flags = (0x01 if enable else 0) | (0x02 if home else 0)
    body = bytes([CMD_SYNC[0], CMD_SYNC[1], module_id & 0xFF]) + \
        struct.pack(">hh", steer, duty) + bytes([flags])
    crc = crc16(body)
    return body + struct.pack(">H", crc)


def parse_telemetry(frame):
    """Кадр телеметрии 16 Б → dict, либо None (длина/синхро/CRC)."""
    if len(frame) < TLM_LEN:
        return None
    if frame[0] != TLM_SYNC[0] or frame[1] != TLM_SYNC[1]:
        return None
    if crc16(frame[:14]) != struct.unpack(">H", frame[14:16])[0]:
        return None
    steer_cdeg, enc_delta, pwm_actual = struct.unpack(">hhh", frame[4:10])
    vbat_cv, current_ma = struct.unpack(">HH", frame[10:14])
    status = frame[3]
    return {
        "moduleId": frame[2],
        "id": MODULE_NAMES.get(frame[2], "M%d" % frame[2]),
        "status": status,
        "enabled": bool(status & STATUS_ENABLED),
        "homed": bool(status & STATUS_HOMED),
        "fault": bool(status & STATUS_FAULT),
        "steerDeg": steer_cdeg / 100.0,
        "encDelta": enc_delta,
        "pwm": pwm_actual,
        "volts": vbat_cv / 100.0,
        "amps": current_ma / 1000.0,
    }


def pick_telemetry(buf):
    """Ищет в буфере корректный кадр. → (кадр | None, остаток буфера)."""
    while len(buf) >= TLM_LEN:
        start = buf.find(bytes(TLM_SYNC))
        if start < 0:
            return None, buf[-1:]          # синхробайтов нет — держим хвост
        if start:
            buf = buf[start:]
        if len(buf) < TLM_LEN:
            return None, buf
        frame = buf[:TLM_LEN]
        parsed = parse_telemetry(frame)
        if parsed:
            return parsed, buf[TLM_LEN:]
        buf = buf[1:]                      # CRC не сошёлся — сдвигаемся на байт
    return None, buf


# ============================================================================
# 2. Модель АКБ 12S3P
# ============================================================================
def _interp(table, x, col):
    key, val = (0, 1) if col == 0 else (1, 0)
    if x <= table[0][key]:
        return table[0][val]
    if x >= table[-1][key]:
        return table[-1][val]
    for i in range(1, len(table)):
        a, b = table[i - 1], table[i]
        if x <= b[key]:
            k = (x - a[key]) / (b[key] - a[key] or 1)
            return a[val] + k * (b[val] - a[val])
    return table[-1][val]


def soc_from_voltage(pack_v):
    """SOC, % — по кривой OCV на элемент."""
    return max(0.0, min(100.0, _interp(PACK["ocv"], (pack_v or 0) / PACK["series"], 0)))


def voltage_from_soc(soc):
    return _interp(PACK["ocv"], max(0.0, min(100.0, soc)), 1) * PACK["series"]


def pack_state(pack_v, pack_a, soc=None, temp_c=28.0):
    """Сводка по АКБ для экрана: %, напряжение, ток, запас хода, состояние."""
    soc = soc_from_voltage(pack_v) if soc is None else max(0.0, min(100.0, soc))
    remaining_wh = PACK["capacityWh"] * soc / 100.0
    wh_per_km = PACK["capacityWh"] / 22.0          # паспортные ~22 км на полный заряд
    if pack_v >= PACK["lowV"]:
        level = "НОРМА"
    elif pack_v >= PACK["criticalV"]:
        level = "НИЗКИЙ"
    else:
        level = "КРИТИЧЕСКИЙ"
    return {
        "soc": round(soc, 1),
        "volts": round(pack_v, 2),
        "amps": round(abs(pack_a), 2),
        "watts": round(pack_v * abs(pack_a), 1),
        "remainingWh": round(remaining_wh, 1),
        "rangeKm": round(remaining_wh / wh_per_km, 1),
        "state": "заряд" if pack_a < -0.2 else ("разряд" if pack_a > 0.2 else "покой"),
        "level": level,
        "tempC": round(temp_c, 1),
        "cellMin": round(pack_v / PACK["series"] - 0.011, 3),
        "cellMax": round(pack_v / PACK["series"] + 0.013, 3),
        "thresholds": {"lowV": PACK["lowV"], "criticalV": PACK["criticalV"]},
    }


# ============================================================================
# 3. Источники данных
# ============================================================================
class SimSource:
    """Демонстрационная физика: робот едет по маршруту, модули рулят."""

    name = "sim"

    def __init__(self):
        self.t0 = time.time()
        self.soc = 78.0
        self.last = time.time()
        self.motors = [{"id": mid, "title": MODULE_TITLES[mid], "angle": 0.0,
                        "rpm": 0.0, "temp": 36.0, "homed": True} for mid in MODULE_NAMES.values()]

    def read(self):
        now = time.time()
        dt = max(0.001, min(0.5, now - self.last))
        self.last = now
        t = now - self.t0

        speed = 0.55 + 0.45 * math.sin(t / 9.0)          # условная скорость 0,1…1,0
        for i, m in enumerate(self.motors):
            m["angle"] = math.sin(t / (2.6 + i * 0.4)) * 34.0
            m["rpm"] = speed * 260.0 + math.sin(t * 2 + i) * 3.0
            m["temp"] = 34.0 + abs(m["rpm"]) / 40.0 + math.sin(t / 5 + i) * 1.4
        amps = 6.0 + 12.0 * abs(math.sin(t / 9.0))
        self.soc = max(4.0, self.soc - amps * dt / 3600.0 * 100.0 / PACK["capacityAh"])
        volts = voltage_from_soc(self.soc) - amps * PACK["internalR"]
        return self._payload(self.motors, volts, amps, speed)

    def _payload(self, motors, volts, amps, speed):
        battery = pack_state(volts, amps, self.soc)
        return {
            "motors": motors,
            "battery": battery,
            "cargo": {"kg": 80, "closed": True},
            "mode": "АВТОНОМНЫЙ РЕЖИМ",
            "route": "склад → зона выгрузки",
            "speedMps": round(speed, 2),
            "powerKw": round(battery["watts"] / 1000.0, 2),
            "linkOk": True,
        }


class SerialSource:
    """Реальные модули: 4 UART, кадры телеметрии 16 Б (20 Гц)."""

    name = "serial"

    def __init__(self, ports, baud=115200):
        self.ports = ports
        self.baud = baud
        self.lock = threading.Lock()
        self.frames = {}                 # id модуля → последний кадр
        self.cargo = {"kg": 80, "closed": True}
        self.seen = 0.0
        self._stop = False
        for idx, port in enumerate(ports):
            threading.Thread(target=self._reader, args=(port, idx + 1), daemon=True).start()

    def _reader(self, port, default_id):
        try:
            import serial                    # pyserial, только для реального железа
        except ImportError:
            print("! serial: pyserial не установлен (pip install pyserial) — модуль %s выключен" % port)
            return
        buf = b""
        while not self._stop:
            try:
                with serial.Serial(port, self.baud, timeout=0.2) as dev:
                    print("· serial: %s открыт (модуль %d)" % (port, default_id))
                    while not self._stop:
                        chunk = dev.read(64)
                        if not chunk:
                            continue
                        buf += chunk
                        while True:
                            frame, buf = pick_telemetry(buf)
                            if not frame:
                                break
                            mid = frame.get("moduleId") or default_id
                            with self.lock:
                                self.frames[mid] = frame
                                self.seen = time.time()
            except Exception as exc:          # noqa: BLE001 — порт может пропасть
                print("! serial %s: %s — повтор через 2 с" % (port, exc))
                time.sleep(2.0)

    def read(self):
        with self.lock:
            frames = dict(self.frames)
            seen = self.seen
        motors = []
        volts_all, amps_all = [], []
        for num, name in MODULE_NAMES.items():
            f = frames.get(num)
            if not f:
                motors.append({"id": name, "title": MODULE_TITLES[name], "angle": 0.0,
                               "rpm": 0.0, "temp": 0.0, "homed": False, "online": False})
                continue
            rpm = f["encDelta"] * 6 * 60 / 360.0 * 10            # 6 имп/об·10 → об/мин (при 10 Гц опросе)
            motors.append({"id": name, "title": MODULE_TITLES[name], "angle": f["steerDeg"],
                           "rpm": rpm, "temp": 0.0, "homed": f["homed"], "online": True,
                           "fault": f["fault"], "amps": f["amps"], "pwm": f["pwm"]})
            volts_all.append(f["volts"])
            amps_all.append(f["amps"])
        volts = sum(volts_all) / len(volts_all) if volts_all else 0.0
        amps = sum(amps_all) if amps_all else 0.0
        link = (time.time() - seen) < 1.0 if seen else False
        battery = pack_state(volts or PACK["nominalV"], amps)
        return {
            "motors": motors,
            "battery": battery,
            "cargo": dict(self.cargo),
            "mode": "АВТОНОМНЫЙ РЕЖИМ" if link else "НЕТ СВЯЗИ С МОДУЛЯМИ",
            "route": "—",
            "speedMps": round(sum(abs(m.get("rpm", 0)) for m in motors) / 4 * 2 * math.pi * WHEEL_R_M / 60, 2),
            "powerKw": round(battery["watts"] / 1000.0, 2),
            "linkOk": link,
        }


class RosSource:
    """ROS 2 (rclpy): /modules/state, /battery. Если rclpy нет — падаем в sim."""

    name = "ros"

    def __init__(self):
        self.ok = False
        self.data = {}
        try:
            import rclpy                                            # noqa: F401
            from rclpy.node import Node
        except ImportError:
            print("! ros: rclpy не найден — используется демонстрационный источник")
            self.fallback = SimSource()
            return
        self.fallback = None
        threading.Thread(target=self._spin_node, daemon=True).start()

    def _spin_node(self):
        import rclpy
        from rclpy.node import Node
        from std_msgs.msg import Float32, String

        source = self

        class Bridge(Node):
            def __init__(self):
                super().__init__("rus_slam_screen_bridge")
                self.create_subscription(String, "/screen/state", source._on_state, 10)
                self.create_subscription(Float32, "/battery/voltage", source._on_volts, 10)
                self.create_subscription(Float32, "/battery/current", source._on_amps, 10)
                self.create_subscription(String, "/screen/motors", source._on_motors, 10)

        rclpy.init(args=None)
        node = Bridge()
        self.ok = True
        print("· ros: мост экрана запущен (/screen/state, /battery/*, /screen/motors)")
        try:
            rclpy.spin(node)
        except Exception:                                            # noqa: BLE001
            pass

    def _on_state(self, msg):
        try:
            self.data.update(json.loads(msg.data))
        except Exception:                                            # noqa: BLE001
            pass

    def _on_volts(self, msg):
        self.data.setdefault("battery", {})["volts"] = float(msg.data)

    def _on_amps(self, msg):
        self.data.setdefault("battery", {})["amps"] = float(msg.data)

    def _on_motors(self, msg):
        try:
            self.data["motors"] = json.loads(msg.data)
        except Exception:                                            # noqa: BLE001
            pass

    def read(self):
        if self.fallback:
            return self.fallback.read()
        d = self.data
        volts = float(d.get("battery", {}).get("volts") or 0.0)
        amps = float(d.get("battery", {}).get("amps") or 0.0)
        return {
            "motors": d.get("motors") or [],
            "battery": pack_state(volts or PACK["nominalV"], amps),
            "cargo": d.get("cargo") or {"kg": 0, "closed": True},
            "mode": d.get("mode") or ("АВТОНОМНЫЙ РЕЖИМ" if self.ok else "ОЖИДАНИЕ ROS"),
            "route": d.get("route") or "—",
            "speedMps": d.get("speedMps") or 0.0,
            "powerKw": round((volts * abs(amps)) / 1000.0, 2),
            "linkOk": self.ok,
        }


# ============================================================================
# 4. Замок грузового отсека (PIN, блокировки, аудит)
# ============================================================================
class Vault:
    """PIN-хранилище: SHA-256 + соль, счётчик попыток, аудит с хеш-цепочкой."""

    def __init__(self, path=LOCK_FILE, default_pin=DEFAULT_PIN,
                 max_attempts=MAX_ATTEMPTS, lock_ms=LOCK_MS, clock=time.time):
        self.path = path
        self.default_pin = default_pin
        self.max_attempts = max_attempts
        self.lock_ms = lock_ms
        self.clock = clock
        self.lock = threading.Lock()
        self.data = self._load()

    # --- файл ---
    def _load(self):
        try:
            with open(self.path, "r", encoding="utf-8") as fh:
                raw = json.load(fh)
            if isinstance(raw, dict) and raw.get("pinHash"):
                raw.setdefault("audit", [])
                raw.setdefault("fails", 0)
                raw.setdefault("lockUntil", 0)
                return raw
        except (OSError, ValueError):
            pass
        return self._fresh()

    def _fresh(self):
        salt = secrets.token_hex(16)
        return {
            "version": 1, "salt": salt,
            "pinHash": self._hash(salt, self.default_pin),
            "fails": 0, "lockUntil": 0, "audit": [], "changedAt": time.time(),
        }

    def _persist(self):
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(self.data, fh, ensure_ascii=False, indent=2)
            os.replace(tmp, self.path)
        except OSError as exc:
            print("! не удалось сохранить %s: %s" % (self.path, exc))

    # --- крипто ---
    @staticmethod
    def _hash(salt, pin):
        return hashlib.sha256((salt + ":" + str(pin)).encode("utf-8")).hexdigest()

    def _audit(self, action, ok, detail=""):
        prev = self.data["audit"][-1]["hash"] if self.data["audit"] else "genesis"
        ts = self.clock()
        payload = "%s|%.0f|%s|%d|%s" % (prev, ts * 1000, action, 1 if ok else 0, detail)
        entry = {"ts": ts, "action": action, "ok": bool(ok), "detail": detail,
                 "prev": prev, "hash": hashlib.sha256(payload.encode("utf-8")).hexdigest()}
        self.data["audit"].append(entry)
        del self.data["audit"][:-200]

    def verify_audit(self):
        prev = "genesis"
        for i, e in enumerate(self.data["audit"]):
            if e.get("prev") != prev:
                return {"ok": False, "brokenAt": i}
            payload = "%s|%.0f|%s|%d|%s" % (prev, e["ts"] * 1000, e["action"],
                                            1 if e["ok"] else 0, e.get("detail", ""))
            if hashlib.sha256(payload.encode("utf-8")).hexdigest() != e.get("hash"):
                return {"ok": False, "brokenAt": i}
            prev = e["hash"]
        return {"ok": True, "brokenAt": -1}

    # --- логика ---
    def lock_remaining_ms(self, now=None):
        now = self.clock() if now is None else now
        return max(0, int((self.data.get("lockUntil", 0) - now) * 1000))

    def state(self, open_flag=False):
        rem = self.lock_remaining_ms()
        return {
            "open": bool(open_flag),
            "blocked": rem > 0,
            "remainingMs": rem,
            "attemptsLeft": max(0, self.max_attempts - int(self.data.get("fails", 0))),
            "changedAt": self.data.get("changedAt"),
        }

    def verify(self, pin):
        with self.lock:
            now = self.clock()
            if self.lock_remaining_ms(now) > 0:
                self._audit("unlock", False, "ввод заблокирован")
                self._persist()
                return {"ok": False, "reason": "blocked",
                        "remainingMs": self.lock_remaining_ms(now),
                        "attemptsLeft": 0}
            pin = re.sub(r"\D", "", str(pin or ""))
            if not 4 <= len(pin) <= 8:
                return {"ok": False, "reason": "format", "attemptsLeft": self.state()["attemptsLeft"]}
            if self._hash(self.data["salt"], pin) == self.data["pinHash"]:
                self.data["fails"] = 0
                self.data["lockUntil"] = 0
                self.data["lastOpenAt"] = now
                self._audit("unlock", True, "доступ разрешён")
                self._persist()
                return {"ok": True, "reason": "ok", "attemptsLeft": self.max_attempts}
            if self.data.get("lockUntil") and self.data["lockUntil"] <= now:
                self.data["fails"] = 0
                self.data["lockUntil"] = 0
            self.data["fails"] = int(self.data.get("fails", 0)) + 1
            if self.data["fails"] >= self.max_attempts:
                self.data["fails"] = 0
                self.data["lockUntil"] = now + self.lock_ms / 1000.0
                self._audit("unlock", False, "блокировка после %d попыток" % self.max_attempts)
                self._persist()
                return {"ok": False, "reason": "blocked", "remainingMs": self.lock_ms, "attemptsLeft": 0}
            self._audit("unlock", False, "неверный PIN")
            self._persist()
            return {"ok": False, "reason": "wrong",
                    "attemptsLeft": max(0, self.max_attempts - self.data["fails"])}

    def set_pin(self, current, new):
        res = self.verify(current)
        if not res.get("ok"):
            return {"ok": False, "reason": res.get("reason"), "detail": "текущий PIN неверен"}
        new = re.sub(r"\D", "", str(new or ""))
        if not 4 <= len(new) <= 8:
            return {"ok": False, "reason": "format", "detail": "новый PIN — 4…8 цифр"}
        with self.lock:
            self.data["salt"] = secrets.token_hex(16)
            self.data["pinHash"] = self._hash(self.data["salt"], new)
            self.data["changedAt"] = self.clock()
            self._audit("pin_change", True, "PIN изменён")
            self._persist()
        return {"ok": True}

    def audit(self, limit=20):
        items = self.data["audit"][-int(limit):][::-1]
        return [{k: v for k, v in e.items() if k != "hash"} for e in items]


def hardware_lock(action):
    """Реальный замок: внешняя команда из окружения (реле/соленоид/GPIO)."""
    cmd = os.environ.get("RUS_SLAM_LOCK_CMD_CLOSE" if action == "close" else "RUS_SLAM_LOCK_CMD")
    if not cmd:
        return "software"
    try:
        subprocess.Popen(cmd, shell=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return "hardware"
    except OSError as exc:
        print("! замок: команда не выполнена (%s)" % exc)
        return "error"


# ============================================================================
# 5. Состояние приложения
# ============================================================================
class App:
    def __init__(self, source, vault, cargo_nominal_kg=80):
        self.source = source
        self.vault = vault
        self.cargo_nominal_kg = cargo_nominal_kg
        self.lock_open = False
        self.started = time.time()

    def snapshot(self):
        data = self.source.read()
        lock_state = self.vault.state(self.lock_open)
        cargo = dict(data.get("cargo") or {})
        cargo["closed"] = not self.lock_open
        cargo.setdefault("kg", self.cargo_nominal_kg)
        out = dict(data)
        out["cargo"] = cargo
        out["lock"] = lock_state
        out["source"] = getattr(self.source, "name", "unknown")
        out["uptimeSec"] = int(time.time() - self.started)
        out["ts"] = time.time()
        return out

    def open_lock(self, pin):
        res = self.vault.verify(pin)
        if res.get("ok"):
            self.lock_open = True
            res["hardware"] = hardware_lock("open")
            res["lock"] = self.vault.state(True)
        else:
            res["lock"] = self.vault.state(self.lock_open)
        return res

    def close_lock(self):
        if not self.lock_open:
            return {"ok": True, "lock": self.vault.state(False)}
        self.lock_open = False
        return {"ok": True, "hardware": hardware_lock("close"), "lock": self.vault.state(False)}


# ============================================================================
# 6. HTTP: статика + JSON API
# ============================================================================
class ApiHandler(SimpleHTTPRequestHandler):
    app = None                      # проставляется в main()

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # --- утилиты ---
    def _json(self, payload, code=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            return json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError, OSError):
            return {}

    # --- маршруты ---
    def do_GET(self):                                            # noqa: N802
        path = self.path.split("?", 1)[0]
        if path == "/api/state":
            return self._json({"ok": True, "data": self.app.snapshot()})
        if path == "/api/audit":
            limit = 20
            m = re.search(r"[?&]limit=(\d+)", self.path)
            if m:
                limit = max(1, min(200, int(m.group(1))))
            return self._json({"ok": True, "audit": self.app.vault.audit(limit),
                               "integrity": self.app.vault.verify_audit()})
        if path == "/api/health":
            return self._json({"ok": True, "source": getattr(self.app.source, "name", "?"),
                               "uptimeSec": int(time.time() - self.app.started),
                               "pinDefault": self.app.vault.default_pin})
        if path in ("/", "/index.htm", "/default.html"):
            self.send_response(302)
            self.send_header("Location", MAIN_PAGE)
            self.end_headers()
            return
        if path == "/console":
            self.send_response(302)
            self.send_header("Location", CONSOLE_PAGE)
            self.end_headers()
            return
        super().do_GET()

    def do_POST(self):                                           # noqa: N802
        path = self.path.split("?", 1)[0]
        body = self._body()
        if path == "/api/lock/open":
            res = self.app.open_lock(body.get("pin", ""))
            return self._json(res, 200 if res.get("ok") else 403)
        if path == "/api/lock/close":
            return self._json(self.app.close_lock())
        if path == "/api/lock/pin":
            res = self.app.vault.set_pin(body.get("current", ""), body.get("new", ""))
            if res.get("ok"):
                self.app.close_lock()
            return self._json(res, 200 if res.get("ok") else 403)
        return self._json({"ok": False, "error": "неизвестный метод"}, 404)

    # --- служебное ---
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, fmt, *args):
        status = str(args[1]) if len(args) > 1 else ""
        if status.startswith(("4", "5")):
            super().log_message(fmt, *args)


# ============================================================================
# 7. Запуск
# ============================================================================
KIOSK_CANDIDATES = ["chromium-browser", "chromium", "google-chrome",
                    "google-chrome-stable", "microsoft-edge", "firefox"]


def local_ips():
    try:
        return [ip for ip in socket.gethostbyname_ex(socket.gethostname())[2]
                if not ip.startswith("127.")]
    except OSError:
        return []


def launch_kiosk(url):
    exe = next((shutil.which(c) for c in KIOSK_CANDIDATES if shutil.which(c)), None)
    if not exe:
        print("! браузер не найден — откройте вручную:", url)
        return
    base = os.path.basename(exe)
    args = ([exe, "--kiosk", url] if "firefox" in base
            else [exe, "--kiosk", "--app=" + url, "--noerrdialogs", "--disable-infobars",
                  "--autoplay-policy=no-user-gesture-required"])
    try:
        subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print("· браузер открыт в киоск-режиме:", base)
    except OSError as exc:
        print("! не удалось открыть браузер:", exc)


def make_source(kind, ports):
    if kind == "serial":
        return SerialSource(ports or ["/dev/ttyUSB0", "/dev/ttyUSB1", "/dev/ttyUSB2", "/dev/ttyUSB3"])
    if kind == "ros":
        return RosSource()
    if kind == "auto":
        src = RosSource()
        return src if not getattr(src, "fallback", None) else src
    return SimSource()


def build_app(args):
    source = make_source(args.source, args.ports)
    vault = Vault(args.lock_file or LOCK_FILE, args.pin or DEFAULT_PIN,
                  max_attempts=args.max_attempts, lock_ms=int(args.lock_sec * 1000))
    return App(source, vault)


def main(argv=None):
    ap = argparse.ArgumentParser(description="RUS SLAM: основной экран робота и API")
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--source", choices=["sim", "serial", "ros", "auto"], default="sim",
                    help="источник данных (по умолчанию sim — стенд)")
    ap.add_argument("--ports", default="", help="UART-порты для --source serial, через запятую")
    ap.add_argument("--pin", default=DEFAULT_PIN, help="заводской PIN отсека (по умолчанию 2580)")
    ap.add_argument("--lock-file", default="", help="файл состояния замка (по умолчанию gui/state/lock.json)")
    ap.add_argument("--max-attempts", type=int, default=MAX_ATTEMPTS)
    ap.add_argument("--lock-sec", type=float, default=LOCK_MS / 1000.0)
    ap.add_argument("--kiosk", action="store_true",
                    help="опция: открыть основной экран браузером на дисплее робота (без рамок)")
    ap.add_argument("--open", action="store_true",
                    help="опция: открыть основной экран в браузере робота (с рамками)")
    ap.add_argument("--delay", type=float, default=1.2)
    ap.add_argument("--reset-pin", action="store_true", help="сбросить PIN к заводскому")
    args = ap.parse_args(argv)

    lock_path = args.lock_file or LOCK_FILE
    if args.reset_pin:
        try:
            os.remove(lock_path)
            print("· PIN сброшен к заводскому (%s)" % args.pin)
        except OSError:
            pass

    app = build_app(args)
    if not os.path.exists(lock_path):
        app.vault._persist()                                  # noqa: SLF001 — первичная запись
    ApiHandler.app = app

    server = ThreadingHTTPServer((args.host, args.port),
                                 partial(ApiHandler))
    url = "http://127.0.0.1:%d%s" % (args.port, MAIN_PAGE)

    print("RUS SLAM · сервер борта: страницы и API (сам окон не открывает)")
    print("  источник данных : %s" % getattr(app.source, "name", "?"))
    print("  на роботе       : %s" % url)
    for ip in local_ips():
        print("  с планшета/ПК   : http://%s:%d%s" % (ip, args.port, MAIN_PAGE))
    print("  пульт (удалённо): http://127.0.0.1:%d%s" % (args.port, CONSOLE_PAGE))
    print("  API             : /api/state · /api/lock/open · /api/lock/close · /api/audit · /api/health")
    print("  дисплей робота  : страницу показывает deploy/rus-slam-display.service")
    print("                    (разово — флаг --kiosk); сервер только отдаёт данные")
    print("  Ctrl+C — остановить\n")

    if args.kiosk or args.open:
        def opener():
            time.sleep(max(0.0, args.delay))
            launch_kiosk(url) if args.kiosk else webbrowser.open(url)
        threading.Thread(target=opener, daemon=True).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n· остановлено оператором")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
