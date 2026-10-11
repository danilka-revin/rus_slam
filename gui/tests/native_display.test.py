#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Проверки API-клиента нативного дисплея (без Tk и графической сессии).

Запуск: python3 gui/tests/native_display.test.py
"""

import os
import sys
import tempfile
import threading
import unittest
from functools import partial

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import backend as B  # noqa: E402
from native_display_core import (  # noqa: E402
    ApiError,
    DisplayApi,
    battery_tone,
    format_ru,
    motor_status,
)


class TestDisplayApi(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp(prefix="rus-slam-native-display-")
        app = B.App(B.SimSource(), B.Vault(os.path.join(cls.tmp, "lock.json"), "2580"))
        B.ApiHandler.app = app
        cls.server = B.ThreadingHTTPServer(("127.0.0.1", 0), partial(B.ApiHandler))
        cls.port = cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.api = DisplayApi("http://127.0.0.1:%d/" % cls.port, timeout=1.0)

    def setUp(self):
        # Each API test starts from a fresh PIN/lock state.
        app = B.ApiHandler.app
        app.vault.data = app.vault._fresh()
        app.vault._persist()
        app.lock_open = False

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(timeout=2)

    def test_reads_snapshot_from_existing_backend(self):
        data = self.api.get_state()
        self.assertEqual(data["source"], "sim")
        self.assertEqual([m["id"] for m in data["motors"]], ["FL", "FR", "RL", "RR"])
        self.assertIn("soc", data["battery"])
        self.assertIn("lock", data)

    def test_pin_open_and_close_use_shared_lock_api(self):
        opened = self.api.open_lock("2580")
        self.assertTrue(opened["ok"])
        self.assertTrue(opened["lock"]["open"])
        self.assertTrue(self.api.get_state()["lock"]["open"])

        closed = self.api.close_lock()
        self.assertTrue(closed["ok"])
        self.assertFalse(closed["lock"]["open"])
        self.assertTrue(self.api.get_state()["cargo"]["closed"])

    def test_wrong_pin_returns_backend_message_instead_of_network_error(self):
        result = self.api.open_lock("1111")
        self.assertFalse(result["ok"])
        self.assertEqual(result["reason"], "wrong")
        self.assertEqual(result["attemptsLeft"], 4)

    def test_reads_latest_audit_entry(self):
        self.api.open_lock("0000")
        entry = self.api.get_latest_audit()
        self.assertIsNotNone(entry)
        self.assertFalse(entry["ok"])
        self.assertEqual(entry["action"], "unlock")

    def test_unavailable_server_raises_api_error(self):
        with self.assertRaises(ApiError):
            DisplayApi("http://127.0.0.1:1", timeout=0.2).get_state()

    def test_only_http_or_https_urls_are_accepted(self):
        with self.assertRaises(ValueError):
            DisplayApi("file:///tmp/main.html")


class TestDisplayFormatters(unittest.TestCase):
    def test_russian_number_format(self):
        self.assertEqual(format_ru(41.25, 1), "41,2")
        self.assertEqual(format_ru(None, 1), "—")

    def test_battery_thresholds(self):
        self.assertEqual(battery_tone(80), "ok")
        self.assertEqual(battery_tone(35), "warning")
        self.assertEqual(battery_tone(10), "error")

    def test_motor_status_priority(self):
        self.assertEqual(motor_status({"online": False}), ("НЕТ СВЯЗИ", "error"))
        self.assertEqual(motor_status({"fault": True, "rpm": 10}), ("АВАРИЯ", "error"))
        self.assertEqual(motor_status({"homed": False}), ("ХОМИНГ", "warning"))
        self.assertEqual(motor_status({"temp": 60}), ("ПЕРЕГРЕВ", "error"))
        self.assertEqual(motor_status({"rpm": 20}), ("ДВИЖЕНИЕ", "accent"))
        self.assertEqual(motor_status({"rpm": 0}), ("ГОТОВ", "ok"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
