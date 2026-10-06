#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Тесты бэкенда основного экрана (gui/backend.py) — без внешних зависимостей.

Запуск:  python3 gui/tests/backend.test.py
Проверяет: CRC16 и кадры протокола, модель АКБ, разбор потока UART с мусором,
PIN-хранилище (попытки, блокировка, смена PIN, целостность аудита),
и HTTP API (статика, /api/state, открытие/закрытие замка, /api/audit).
"""

import json
import os
import sys
import tempfile
import threading
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

import backend as B  # noqa: E402

OK, FAIL = [], []


def check(name, cond, extra=""):
    (OK if cond else FAIL).append(name)
    print(("  ok   " if cond else "  FAIL ") + name + (("  → " + str(extra)) if (extra and not cond) else ""))


class TestProtocol(unittest.TestCase):
    def test_crc_vector(self):
        check("CRC16: эталон '123456789' → 0x4B37", B.crc16(b"123456789") == 0x4B37,
              hex(B.crc16(b"123456789")))

    def test_command_frame(self):
        f = B.build_command(1, 4500, 200, enable=True, home=False)
        check("кадр команды: 10 байт, AA 55, ID, флаги, CRC", len(f) == 10 and f[0] == 0xAA and f[1] == 0x55
              and f[2] == 1 and f[7] == 0x01 and B.crc16(f[:8]) == int.from_bytes(f[8:], "big"), f.hex())

    def test_telemetry_roundtrip(self):
        body = bytes([0xBB, 0x44, 2, 0x03]) + (1500).to_bytes(2, "big", signed=True) \
            + (120).to_bytes(2, "big", signed=True) + (500).to_bytes(2, "big", signed=True) \
            + (4120).to_bytes(2, "big") + (1240).to_bytes(2, "big")
        frame = body + B.crc16(body).to_bytes(2, "big")
        t = B.parse_telemetry(frame)
        check("телеметрия: разбор 16 Б (угол, энкодер, ШИМ, U, I)",
              t and t["id"] == "FR" and abs(t["steerDeg"] - 15.0) < 1e-6
              and abs(t["volts"] - 41.2) < 1e-6 and abs(t["amps"] - 1.24) < 1e-6
              and t["homed"] and t["enabled"], t)

    def test_bad_crc(self):
        body = bytes([0xBB, 0x44, 1, 0x01]) + b"\x00" * 10
        frame = body + b"\x00\x01"
        check("телеметрия: битый CRC отбрасывается", B.parse_telemetry(frame) is None)

    def test_stream_resync(self):
        body = bytes([0xBB, 0x44, 3, 0x03]) + b"\x00" * 10
        good = body + B.crc16(body).to_bytes(2, "big")
        stream = b"\x00\x11\x22" + good[:7] + b"garbage" + good + b"\x33"
        found, rest = B.pick_telemetry(stream)
        check("поток: кадр найден после мусора", found and found["moduleId"] == 3, found)
        check("поток: хвост буфера сохранён", isinstance(rest, bytes))

    def test_extreme_clamp(self):
        f = B.build_command(4, 99999, -99999)
        steer = int.from_bytes(f[3:5], "big", signed=True)
        pwm = int.from_bytes(f[5:7], "big", signed=True)
        check("кадр: клампы угла и ШИМ", steer == 32767 and pwm == -1000, (steer, pwm))


class TestBattery(unittest.TestCase):
    def test_ocv_bounds(self):
        check("АКБ: 43,8 В → 100 %, 30,0 В → 0 %",
              B.soc_from_voltage(43.8) == 100 and B.soc_from_voltage(30.0) == 0,
              (B.soc_from_voltage(43.8), B.soc_from_voltage(30.0)))

    def test_monotonic(self):
        vals = [B.soc_from_voltage(v) for v in (30, 33, 35.5, 38, 40, 43.8)]
        check("АКБ: SOC монотонен по напряжению", all(a <= b for a, b in zip(vals, vals[1:])), vals)

    def test_pack_state(self):
        # 38,4 В — «номинал» пакета, но по OCV-кривой LiFePO4 это ~15 % заряда:
        # кривая плоская, поэтому проверяем на напряжении, соответствующем 60 % SOC.
        mid = B.voltage_from_soc(60)
        st = B.pack_state(mid, 12.4)
        check("АКБ: сводка на 60 % (Вт·ч, км, уровень)",
              abs(st["soc"] - 60) < 3 and 400 < st["remainingWh"] < 460
              and st["rangeKm"] > 12 and st["level"] == "НОРМА", st)
        nom = B.pack_state(38.4, 12.4)
        check("АКБ: 38,4 В по кривой — низкий заряд (плоская OCV LiFePO4)",
              10 < nom["soc"] < 25, nom["soc"])
        low = B.pack_state(34.0, 5.0)
        check("АКБ: порог 35,5/33,5 В работает", low["level"] == "НИЗКИЙ", low["level"])
        crit = B.pack_state(32.0, 5.0)
        check("АКБ: ниже 33,5 В — критический", crit["level"] == "КРИТИЧЕСКИЙ", crit["level"])


class TestVault(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.path = os.path.join(self.tmp, "lock.json")
        self.now = [1000.0]
        self.v = B.Vault(self.path, "2580", max_attempts=5, lock_ms=30000,
                         clock=lambda: self.now[0])

    def test_default_pin(self):
        check("PIN: заводской 2580 работает", self.v.verify("2580")["ok"] is True)

    def test_wrong_pin(self):
        r = self.v.verify("1111")
        check("PIN: неверный отклонён, остались попытки", r["ok"] is False and r["attemptsLeft"] == 4, r)

    def test_lockout_and_expiry(self):
        for _ in range(5):
            self.v.verify("1111")
        r = self.v.verify("2580")
        check("PIN: 5 неудач → блокировка (даже верный PIN)", r["ok"] is False and r["reason"] == "blocked", r)
        self.now[0] += 31
        check("PIN: через 30 с ввод разблокирован", self.v.verify("2580")["ok"] is True)

    def test_set_pin(self):
        bad = self.v.set_pin("0000", "1234")
        check("PIN: смена с неверным текущим отклонена", bad["ok"] is False)
        good = self.v.set_pin("2580", "4321")
        check("PIN: смена PIN работает", good["ok"] is True and self.v.verify("4321")["ok"] is True)

    def test_persist(self):
        self.v.verify("2580")
        v2 = B.Vault(self.path, "2580")
        check("PIN: данные переживают перезапуск", v2.verify("2580")["ok"] is True)
        check("PIN: аудит сохранён", len(v2.audit(10)) >= 1)

    def test_audit_chain(self):
        self.v.verify("2580")
        self.v.verify("0000")
        self.v.verify("2580")
        check("аудит: цепочка валидна", self.v.verify_audit()["ok"] is True, self.v.verify_audit())
        self.v.data["audit"][0]["detail"] = "подделка"
        res = self.v.verify_audit()
        check("аудит: подделка записи обнаружена", res["ok"] is False and res["brokenAt"] == 0, res)

    def test_hardware_hook_absent(self):
        check("замок: без RUS_SLAM_LOCK_CMD работает программно", B.hardware_lock("open") == "software")


class TestApi(unittest.TestCase):
    """Живой HTTP-сервер на свободном порту."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        B.LOCK_FILE = os.path.join(cls.tmp, "lock.json")
        app = B.App(B.SimSource(), B.Vault(B.LOCK_FILE, "2580"))
        B.ApiHandler.app = app
        cls.server = B.ThreadingHTTPServer(("127.0.0.1", 0), B.partial(B.ApiHandler))
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        time.sleep(0.2)

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def url(self, path):
        return "http://127.0.0.1:%d%s" % (self.port, path)

    def get(self, path):
        with urllib.request.urlopen(self.url(path), timeout=5) as r:
            return r.status, json.load(r)

    def post(self, path, payload):
        req = urllib.request.Request(self.url(path), data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                return r.status, json.load(r)
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    def test_01_static(self):
        req = urllib.request.Request(self.url("/"))
        opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler)
        with opener.open(req, timeout=5) as r:
            body = r.read().decode("utf-8")
        check("HTTP: / отдаёт основной экран", "основной экран робота" in body, body[:60])

    def test_02_state(self):
        status, body = self.get("/api/state")
        d = body.get("data", {})
        check("API: /api/state — 200 и структура", status == 200 and d.get("source") == "sim"
              and len(d.get("motors", [])) == 4 and "soc" in d.get("battery", {})
              and "lock" in d, list(d.keys()))

    def test_03_state_moves(self):
        _, a = self.get("/api/state")
        time.sleep(0.6)
        _, b = self.get("/api/state")
        check("API: показания меняются во времени",
              a["data"]["battery"]["soc"] != b["data"]["battery"]["soc"]
              or a["data"]["motors"][0]["rpm"] != b["data"]["motors"][0]["rpm"])

    def test_04_lock_wrong_pin(self):
        status, body = self.post("/api/lock/open", {"pin": "1111"})
        check("API: неверный PIN → 403 и остаток попыток",
              status == 403 and body.get("ok") is False and body.get("attemptsLeft") == 4, body)

    def test_05_lock_open(self):
        status, body = self.post("/api/lock/open", {"pin": "2580"})
        check("API: верный PIN открывает отсек", status == 200 and body.get("ok") is True
              and body["lock"]["open"] is True, body)
        _, state = self.get("/api/state")
        check("API: состояние отсека в /api/state", state["data"]["lock"]["open"] is True
              and state["data"]["cargo"]["closed"] is False)

    def test_06_lock_close(self):
        status, body = self.post("/api/lock/close", {})
        check("API: закрытие отсека", status == 200 and body["lock"]["open"] is False, body)
        _, state = self.get("/api/state")
        check("API: груз снова закрыт", state["data"]["cargo"]["closed"] is True)

    def test_07_audit(self):
        _, body = self.get("/api/audit?limit=10")
        check("API: журнал доступа и целостность", body["ok"] and body["integrity"]["ok"]
              and len(body["audit"]) >= 1, body.get("integrity"))

    def test_08_health(self):
        _, body = self.get("/api/health")
        check("API: /api/health отвечает", body["ok"] is True and body["source"] == "sim", body)

    def test_09_change_pin(self):
        status, body = self.post("/api/lock/pin", {"current": "2580", "new": "1357"})
        check("API: смена PIN через API", status == 200 and body.get("ok") is True, body)
        status2, body2 = self.post("/api/lock/open", {"pin": "1357"})
        check("API: новый PIN открывает отсек", status2 == 200 and body2.get("ok") is True, body2)


class TestServerNoWindows(unittest.TestCase):
    """Сервер борта сам ничего не открывает: страницы смотрят в браузере.

    Основной экран на дисплее робота показывает отдельный сервис
    (deploy/rus-slam-display.service), поэтому запуск backend.py без флагов
    не должен трогать браузер робота.
    """

    def _run_main(self, argv):
        import unittest.mock as mock
        opened = []
        with mock.patch.object(B.webbrowser, "open", lambda *a, **k: opened.append("webbrowser")), \
             mock.patch.object(B, "launch_kiosk", lambda *a, **k: opened.append("kiosk")), \
             mock.patch.object(B, "ThreadingHTTPServer") as srv:
            srv.return_value.serve_forever.side_effect = KeyboardInterrupt
            code = B.main(argv)
            # даём шанс потоку-открывателю (если он есть) — заглушки ещё активны
            deadline = time.time() + 0.7
            while time.time() < deadline and not opened:
                time.sleep(0.05)
        return code, opened

    def test_01_no_browser_by_default(self):
        code, opened = self._run_main(["--port", "0"])
        check("запуск без флагов: сервер не открывает окон", opened == [], opened)
        check("запуск без флагов: код возврата 0", code == 0, code)

    def test_02_kiosk_is_explicit(self):
        code, opened = self._run_main(["--port", "0", "--kiosk", "--delay", "0"])
        check("флаг --kiosk: страница на дисплее робота открывается", "kiosk" in opened, opened)

    def test_03_open_is_explicit(self):
        code, opened = self._run_main(["--port", "0", "--open", "--delay", "0"])
        check("флаг --open: страница открывается в браузере", "webbrowser" in opened, opened)


if __name__ == "__main__":
    unittest.main(verbosity=0, exit=False)
    print("\nИТОГО бэкенд: %d passed, %d failed" % (len(OK), len(FAIL)))
    if FAIL:
        print("Провалено: " + ", ".join(FAIL))
    sys.exit(1 if FAIL else 0)
