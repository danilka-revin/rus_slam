#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Нативный полноэкранный дисплей RUS SLAM.

Рисует основной экран стандартными Tkinter/Canvas-виджетами и получает данные
из JSON API `gui/backend.py`. Не открывает браузер и не загружает HTML/CSS/JS.
"""

from __future__ import annotations

import argparse
import math
import os
import queue
import threading
import time
try:
    import tkinter as tk
    import tkinter.font as tkfont
except ImportError:  # Tkinter может быть отдельным пакетом python3-tk в Linux
    tk = None  # type: ignore[assignment]
    tkfont = None  # type: ignore[assignment]

import webbrowser
from datetime import datetime
from typing import Any

from native_display_core import (
    DEFAULT_API_URL,
    ApiError,
    DisplayApi,
    as_number,
    battery_tone,
    format_ru,
    motor_status,
)


COLORS = {
    "bg": "#0b1411",
    "panel": "#121d18",
    "panel_alt": "#16241e",
    "line": "#26372f",
    "text": "#e6f0eb",
    "muted": "#8fa79d",
    "accent": "#d5ff45",
    "ok": "#7ddc52",
    "warning": "#e5a438",
    "error": "#ff6a55",
    "dark_text": "#17211d",
}

STATUS_COLOR = {
    "ok": COLORS["ok"],
    "warning": COLORS["warning"],
    "error": COLORS["error"],
    "accent": COLORS["accent"],
    "muted": COLORS["muted"],
}

MOTOR_ORDER = ("FL", "FR", "RL", "RR")
MOTOR_TITLES = {
    "FL": "передний левый",
    "FR": "передний правый",
    "RL": "задний левый",
    "RR": "задний правый",
}
KEYPAD = ("1", "2", "3", "4", "5", "6", "7", "8", "9", "⌫", "0", "СБРОС")


class NativeDisplay:
    """Окно основного экрана; вся графика строится на Tk Canvas."""

    def __init__(self, root: tk.Tk, api: DisplayApi, fullscreen: bool = True,
                 poll_ms: int = 300):
        self.root = root
        self.api = api
        self.poll_ms = max(100, int(poll_ms))
        self.stop_event = threading.Event()
        self.events: queue.Queue[tuple[str, Any]] = queue.Queue()

        self.data: dict[str, Any] | None = None
        self.api_online = False
        self.last_data_at = 0.0
        self.latest_audit: dict[str, Any] | None = None
        self.pin = ""
        self.action_busy = False
        self.message = "Подключение к серверу…"
        self.message_kind = "muted"
        self._hit_targets: list[tuple[float, float, float, float, tuple[str, Any]]] = []
        self._scale = 1.0
        self._font_family = tkfont.nametofont("TkDefaultFont").actual("family")
        self._last_audit_poll = 0.0

        root.title("RUS SLAM — основной экран")
        root.configure(background=COLORS["bg"])
        root.attributes("-fullscreen", bool(fullscreen))
        if not fullscreen:
            root.geometry("1280x720")
            root.minsize(800, 560)
        root.protocol("WM_DELETE_WINDOW", self.close)
        root.bind("<Key>", self._on_key)

        self.canvas = tk.Canvas(
            root,
            background=COLORS["bg"],
            highlightthickness=0,
            borderwidth=0,
            takefocus=True,
        )
        self.canvas.pack(fill="both", expand=True)
        self.canvas.bind("<Button-1>", self._on_click)
        self.canvas.bind("<Configure>", self._on_canvas_resize)
        self.canvas.focus_set()

        self.worker = threading.Thread(target=self._poll_loop, name="native-display-api", daemon=True)
        self.worker.start()
        self.root.after(100, self._drain_events)
        self.root.after(250, self._tick)

    # ------------------------------------------------------------------
    # API worker and event handling
    # ------------------------------------------------------------------
    def _poll_loop(self) -> None:
        """Опрос API идёт в фоне, чтобы таймаут сети не подвешивал экран."""
        while not self.stop_event.is_set():
            try:
                data = self.api.get_state()
                self.events.put(("state", data))
                now = time.monotonic()
                if now - self._last_audit_poll >= 5.0:
                    try:
                        self.events.put(("audit", self.api.get_latest_audit()))
                    except ApiError:
                        pass  # журнал вспомогательный; состояние экрана важнее
                    self._last_audit_poll = now
            except ApiError as exc:
                self.events.put(("offline", str(exc)))
            self.stop_event.wait(self.poll_ms / 1000.0)

    def _drain_events(self) -> None:
        changed = False
        try:
            while True:
                kind, payload = self.events.get_nowait()
                if kind == "state":
                    self.data = payload
                    self.api_online = True
                    self.last_data_at = time.monotonic()
                    if (self.message_kind == "muted" or self.message.startswith("Нет связи")
                            or self.message.startswith("Нет ответа от сервера")):
                        self.message = "Введите PIN-код и нажмите «Открыть»"
                        self.message_kind = "muted"
                    changed = True
                elif kind == "offline":
                    self.api_online = False
                    if self.data is None:
                        self.message = "Сервер недоступен — запустите gui/backend.py"
                    else:
                        self.message = "Нет связи с сервером — показаны последние полученные данные"
                    self.message_kind = "error"
                    changed = True
                elif kind == "audit":
                    self.latest_audit = payload
                    changed = True
                elif kind == "action":
                    action, result = payload
                    self.action_busy = False
                    if action == "open":
                        self.pin = ""
                    if isinstance(result, dict) and isinstance(result.get("lock"), dict):
                        if self.data is None:
                            self.data = {}
                        self.data["lock"] = result["lock"]
                        cargo = self.data.setdefault("cargo", {})
                        cargo["closed"] = not bool(result["lock"].get("open"))
                    if result.get("ok"):
                        self.message = "Доступ разрешён" if action == "open" else "Отсек закрыт"
                        self.message_kind = "ok"
                    else:
                        reason = result.get("reason")
                        if reason == "blocked":
                            seconds = max(1, math.ceil(as_number(result.get("remainingMs")) / 1000))
                            self.message = "Ввод заблокирован: ещё %d с" % seconds
                        elif reason == "format":
                            self.message = "PIN должен содержать от 4 до 8 цифр"
                        else:
                            left = result.get("attemptsLeft")
                            self.message = ("Неверный PIN. Осталось попыток: %s" % left
                                            if left is not None else "Неверный PIN")
                        self.message_kind = "error"
                    changed = True
                elif kind == "action_error":
                    self.action_busy = False
                    self.pin = ""
                    self.message = "Нет ответа от сервера: %s" % payload
                    self.message_kind = "error"
                    changed = True
        except queue.Empty:
            pass
        if changed:
            self.draw()
        if self.root.winfo_exists():
            self.root.after(100, self._drain_events)

    def _run_action(self, action: str, pin: str = "") -> None:
        try:
            result = self.api.open_lock(pin) if action == "open" else self.api.close_lock()
            self.events.put(("action", (action, result)))
        except ApiError as exc:
            self.events.put(("action_error", str(exc)))

    # ------------------------------------------------------------------
    # Window input and lifecycle
    # ------------------------------------------------------------------
    def _on_canvas_resize(self, _event: tk.Event) -> None:
        self.draw()

    def _on_key(self, event: tk.Event) -> str | None:
        key = getattr(event, "keysym", "")
        char = getattr(event, "char", "")
        if key == "F11":
            self._toggle_fullscreen()
            return "break"
        if key in ("Escape", "BackSpace"):
            if self.pin:
                self._press_key("СБРОС" if key == "Escape" else "⌫")
                return "break"
            if key == "Escape":
                self._toggle_fullscreen()
                return "break"
        if char.isdigit() and len(char) == 1:
            self._press_key(char)
            return "break"
        if key in ("Return", "KP_Enter"):
            self._submit_lock_action()
            return "break"
        return None

    def _toggle_fullscreen(self, _event: tk.Event | None = None) -> str:
        value = self.root.attributes("-fullscreen")
        current = value is True or str(value).lower() in ("1", "true", "yes")
        self.root.attributes("-fullscreen", not current)
        return "break"

    def close(self) -> None:
        self.stop_event.set()
        try:
            self.root.destroy()
        except tk.TclError:
            pass

    def _on_click(self, event: tk.Event) -> None:
        for x1, y1, x2, y2, action in reversed(self._hit_targets):
            if x1 <= event.x <= x2 and y1 <= event.y <= y2:
                kind, value = action
                if kind == "key":
                    self._press_key(str(value))
                elif kind == "submit":
                    self._submit_lock_action()
                elif kind == "console":
                    self._open_console()
                return

    def _press_key(self, key: str) -> None:
        if not self.api_online or self.action_busy or self._lock_blocked():
            return
        if key == "СБРОС":
            self.pin = ""
            self.message = "Введите PIN-код и нажмите «Открыть»"
            self.message_kind = "muted"
        elif key == "⌫":
            self.pin = self.pin[:-1]
        elif key.isdigit() and len(self.pin) < 8:
            self.pin += key
        self.draw()

    def _submit_lock_action(self) -> None:
        if not self.api_online or self.action_busy:
            if not self.api_online:
                self.message = "Нет связи с сервером — действие недоступно"
                self.message_kind = "error"
                self.draw()
            return
        if self._lock_open():
            action = "close"
        else:
            if self._lock_blocked():
                self.message = "Ввод заблокирован: ещё %d с" % max(1, math.ceil(self._lock_remaining_ms() / 1000))
                self.message_kind = "error"
                self.draw()
                return
            if len(self.pin) < 4:
                self.message = "PIN должен содержать не менее 4 цифр"
                self.message_kind = "warning"
                self.draw()
                return
            action = "open"
        self.action_busy = True
        self.message = "Отправка команды…"
        self.message_kind = "muted"
        if action == "open":
            # PIN очищается сразу, не оставаясь на экране во время запроса.
            pin, self.pin = self.pin, ""
        else:
            pin = ""
        self.draw()
        threading.Thread(target=self._run_action, args=(action, pin), daemon=True).start()

    def _open_console(self) -> None:
        try:
            webbrowser.open(self.api.base_url + "/console")
        except Exception as exc:  # noqa: BLE001 - окружение может не иметь браузера
            self.message = "Не удалось открыть инженерный пульт: %s" % exc
            self.message_kind = "warning"
            self.draw()

    # ------------------------------------------------------------------
    # State helpers
    # ------------------------------------------------------------------
    def _lock(self) -> dict[str, Any]:
        if not isinstance(self.data, dict):
            return {}
        lock = self.data.get("lock")
        return lock if isinstance(lock, dict) else {}

    def _lock_open(self) -> bool:
        return bool(self._lock().get("open"))

    def _lock_remaining_ms(self) -> int:
        lock = self._lock()
        remaining = as_number(lock.get("remainingMs"))
        if self.api_online and self.last_data_at:
            remaining -= max(0.0, time.monotonic() - self.last_data_at) * 1000.0
        return max(0, int(remaining))

    def _lock_blocked(self) -> bool:
        return bool(self._lock().get("blocked")) and self._lock_remaining_ms() > 0

    def _motor(self, motor_id: str) -> dict[str, Any]:
        if not isinstance(self.data, dict):
            return {"id": motor_id, "title": MOTOR_TITLES[motor_id]}
        motors = self.data.get("motors")
        if isinstance(motors, list):
            for item in motors:
                if isinstance(item, dict) and str(item.get("id", "")).upper() == motor_id:
                    return item
        return {"id": motor_id, "title": MOTOR_TITLES[motor_id], "online": False}

    # ------------------------------------------------------------------
    # Canvas primitives
    # ------------------------------------------------------------------
    def _rounded(self, x1: float, y1: float, x2: float, y2: float, radius: float,
                 fill: str, outline: str = "", width: int = 1) -> None:
        radius = max(0.0, min(radius, (x2 - x1) / 2, (y2 - y1) / 2))
        points = (
            x1 + radius, y1, x2 - radius, y1, x2, y1 + radius,
            x2, y2 - radius, x2 - radius, y2, x1 + radius, y2,
            x1, y2 - radius, x1, y1 + radius,
        )
        self.canvas.create_polygon(
            points, smooth=True, splinesteps=10, fill=fill,
            outline=outline or fill, width=width,
        )

    def _text(self, x: float, y: float, text: Any, size: float = 12,
              color: str | None = None, bold: bool = False,
              anchor: str = "nw", width: float | None = None,
              justify: str = "left") -> int:
        options: dict[str, Any] = {
            "text": str(text),
            "anchor": anchor,
            "fill": color or COLORS["text"],
            "font": (self._font_family, max(8, int(size * self._scale)), "bold" if bold else "normal"),
            "justify": justify,
        }
        if width is not None:
            options["width"] = max(1, width)
        return self.canvas.create_text(x, y, **options)

    def _panel(self, x: float, y: float, width: float, height: float) -> None:
        self._rounded(x, y, x + width, y + height, 16 * self._scale,
                      COLORS["panel"], COLORS["line"])

    def _button(self, x: float, y: float, width: float, height: float,
                label: str, action: tuple[str, Any], enabled: bool = True,
                primary: bool = False, font_size: float = 14) -> None:
        if primary and enabled:
            fill, outline, text_color = COLORS["accent"], COLORS["accent"], COLORS["dark_text"]
        elif enabled:
            fill, outline, text_color = COLORS["panel_alt"], COLORS["line"], COLORS["text"]
        else:
            fill, outline, text_color = "#18231e", COLORS["line"], "#71847b"
        self._rounded(x, y, x + width, y + height, min(12 * self._scale, height / 3), fill, outline)
        self._text(x + width / 2, y + height / 2, label, font_size, text_color,
                   bold=True, anchor="center")
        if enabled:
            self._hit_targets.append((x, y, x + width, y + height, action))

    def _chip(self, x: float, y: float, label: str, color_key: str,
              max_width: float | None = None) -> float:
        font_size = 9.5 * self._scale
        estimated = max(48 * self._scale, len(label) * font_size * 0.61 + 18 * self._scale)
        if max_width is not None:
            estimated = min(estimated, max_width)
        height = max(20 * self._scale, 23 * self._scale)
        color = STATUS_COLOR.get(color_key, COLORS["muted"])
        self._rounded(x, y, x + estimated, y + height, height / 2, "#1a2b23", "#2a3d32")
        self._text(x + estimated / 2, y + height / 2, label, 9.5, color,
                   bold=True, anchor="center", width=estimated - 8 * self._scale, justify="center")
        return estimated

    # ------------------------------------------------------------------
    # Full screen drawing
    # ------------------------------------------------------------------
    def draw(self) -> None:
        if not hasattr(self, "canvas"):
            return
        width = max(1, self.canvas.winfo_width())
        height = max(1, self.canvas.winfo_height())
        if width < 300 or height < 250:
            return
        self._scale = max(0.72, min(1.35, min(width / 1280.0, height / 720.0)))
        self._hit_targets = []
        self.canvas.delete("all")
        self.canvas.configure(background=COLORS["bg"])

        margin = max(10, 14 * self._scale)
        gap = max(8, 10 * self._scale)
        header_h = max(58 * self._scale, 70 * self._scale)
        footer_h = max(38 * self._scale, 44 * self._scale)
        self._draw_header(margin, margin, width - 2 * margin, header_h)
        content_y = margin + header_h + gap
        content_bottom = height - margin - footer_h - gap
        content_h = max(200.0, content_bottom - content_y)
        usable_w = width - 2 * margin

        if width >= 1080:
            inner = usable_w - 2 * gap
            motor_w = inner * 0.465
            battery_w = inner * 0.245
            lock_w = inner - motor_w - battery_w
            self._draw_motors(margin, content_y, motor_w, content_h)
            self._draw_battery(margin + motor_w + gap, content_y, battery_w, content_h)
            self._draw_lock(margin + motor_w + battery_w + 2 * gap, content_y, lock_w, content_h)
        else:
            left_w = max(usable_w * 0.53, usable_w - 390 * self._scale)
            left_w = min(left_w, usable_w - 290 * self._scale - gap)
            right_w = usable_w - left_w - gap
            left_w = max(usable_w - right_w - gap, 250 * self._scale)
            top_h = max(210 * self._scale, (content_h - gap) * 0.54)
            lower_h = content_h - top_h - gap
            self._draw_motors(margin, content_y, left_w, top_h)
            self._draw_battery(margin, content_y + top_h + gap, left_w, lower_h)
            self._draw_lock(margin + left_w + gap, content_y, right_w, content_h)

        self._draw_footer(margin, height - margin - footer_h, usable_w, footer_h)

    def _draw_header(self, x: float, y: float, width: float, height: float) -> None:
        self._panel(x, y, width, height)
        s = self._scale
        left = x + 12 * s
        center_y = y + height / 2
        logo = 40 * s
        self._rounded(left, center_y - logo / 2, left + logo, center_y + logo / 2,
                      11 * s, COLORS["accent"], COLORS["accent"])
        # Небольшая нативная пиктограмма робота — две линии и пара колёс.
        self.canvas.create_line(left + 9 * s, center_y, left + 31 * s, center_y,
                                fill=COLORS["dark_text"], width=max(2, int(2.2 * s)), capstyle="round")
        self.canvas.create_line(left + 12 * s, center_y - 7 * s, left + 28 * s, center_y - 7 * s,
                                fill=COLORS["dark_text"], width=max(2, int(2.2 * s)), capstyle="round")
        self.canvas.create_oval(left + 9 * s, center_y + 7 * s, left + 15 * s, center_y + 13 * s,
                                fill=COLORS["dark_text"], outline=COLORS["dark_text"])
        self.canvas.create_oval(left + 25 * s, center_y + 7 * s, left + 31 * s, center_y + 13 * s,
                                fill=COLORS["dark_text"], outline=COLORS["dark_text"])
        self._text(left + logo + 10 * s, center_y - 14 * s, "RUS SLAM", 16, COLORS["text"], bold=True)
        self._text(left + logo + 10 * s, center_y + 6 * s, "робот-курьер 4WIS/4WID", 9.5, COLORS["muted"])

        clock_w = 76 * s
        right = x + width - 14 * s
        self._text(right, center_y, datetime.now().strftime("%H:%M:%S"), 18,
                   COLORS["text"], bold=True, anchor="e")
        link_x = right - clock_w - 84 * s
        if self.api_online:
            link_ok = bool((self.data or {}).get("linkOk", False))
            dot_color = COLORS["ok"] if link_ok else COLORS["error"]
            link_label = "МОДУЛИ" if link_ok else "НЕТ СВЯЗИ"
        else:
            dot_color, link_label = COLORS["error"], "СЕРВЕР ОФЛАЙН"
        dot_r = 4.5 * s
        self.canvas.create_oval(link_x, center_y - dot_r, link_x + 2 * dot_r, center_y + dot_r,
                                fill=dot_color, outline=dot_color)
        self._text(link_x + 2 * dot_r + 6 * s, center_y, link_label, 9.5,
                   COLORS["muted"] if self.api_online else COLORS["error"], bold=True, anchor="w")

        source = (self.data or {}).get("source", "—")
        source_label = ("API · " + str(source).upper()) if self.api_online else "API · НЕТ СВЯЗИ"
        chip_color = "ok" if self.api_online else "error"
        chip_width = 118 * s
        chip_x = link_x - chip_width - 10 * s
        self._chip(chip_x, center_y - 11 * s, source_label, chip_color, max_width=chip_width)

        mode = str((self.data or {}).get("mode") or "ОЖИДАНИЕ ДАННЫХ")
        mode_width = min(210 * s, width * 0.27)
        brand_end = left + logo + 180 * s
        mode_x = (brand_end + chip_x - mode_width) / 2
        mode_x = max(brand_end + 8 * s, mode_x)
        mode_x = min(mode_x, chip_x - mode_width - 8 * s)
        self._rounded(mode_x, center_y - 15 * s, mode_x + mode_width, center_y + 15 * s,
                      15 * s, "#1a2410", "#3a4a1f")
        self._text(mode_x + mode_width / 2, center_y, mode, 9.5, COLORS["accent"],
                   bold=True, anchor="center", width=mode_width - 14 * s, justify="center")

    def _draw_motors(self, x: float, y: float, width: float, height: float) -> None:
        self._panel(x, y, width, height)
        s = self._scale
        self._text(x + 15 * s, y + 13 * s, "ДВИГАТЕЛИ", 15, COLORS["text"], bold=True)
        self._text(x + width - 14 * s, y + 16 * s, "4 модуля · руль + тяга", 9.5,
                   COLORS["muted"], anchor="ne")

        grid_top = y + 43 * s
        foot_h = 27 * s
        inner_x = x + 12 * s
        inner_w = width - 24 * s
        grid_h = max(100.0, height - (grid_top - y) - foot_h - 9 * s)
        card_gap = 8 * s
        card_w = (inner_w - card_gap) / 2
        card_h = (grid_h - card_gap) / 2
        moving = 0
        online = 0
        motors = {str(item.get("id", "")).upper(): item
                  for item in (self.data or {}).get("motors", [])
                  if isinstance(item, dict)}
        for index, motor_id in enumerate(MOTOR_ORDER):
            row, col = divmod(index, 2)
            cx = inner_x + col * (card_w + card_gap)
            cy = grid_top + row * (card_h + card_gap)
            motor = motors.get(motor_id, {"id": motor_id, "online": False})
            self._draw_motor_card(cx, cy, card_w, card_h, motor_id, motor)
            if abs(as_number(motor.get("rpm"))) > 4:
                moving += 1
            if motor.get("online") is not False:
                online += 1
        foot_y = y + height - 15 * s
        self._text(x + 14 * s, foot_y, "NEMA 23 · BLDC 260 Вт", 8.5,
                   COLORS["muted"], anchor="w")
        count_text = "движение: %d/4 · связь: %d/4" % (moving, online)
        self._text(x + width - 14 * s, foot_y, count_text, 8.5,
                   COLORS["muted"], anchor="e")

    def _draw_motor_card(self, x: float, y: float, width: float, height: float,
                         motor_id: str, motor: dict[str, Any]) -> None:
        s = self._scale
        self._rounded(x, y, x + width, y + height, 12 * s, COLORS["panel_alt"], COLORS["line"])
        title = str(motor.get("title") or MOTOR_TITLES[motor_id])
        status, color_key = motor_status(motor)
        status_color = STATUS_COLOR[color_key]
        self._text(x + 10 * s, y + 8 * s, motor_id, 15, COLORS["text"], bold=True)
        self._text(x + 43 * s, y + 11 * s, title, 8.5, COLORS["muted"])
        chip_w = min(88 * s, max(54 * s, len(status) * 5.7 * s + 14 * s))
        self._rounded(x + width - chip_w - 8 * s, y + 7 * s,
                      x + width - 8 * s, y + 25 * s, 9 * s, "#1b2b23", COLORS["line"])
        self._text(x + width - chip_w / 2 - 8 * s, y + 16 * s, status, 7.8,
                   status_color, bold=True, anchor="center")

        body_top = y + 31 * s
        body_h = max(38 * s, height - 37 * s)
        radius = min(width * 0.205, body_h * 0.42, 48 * s)
        center_x = x + 12 * s + radius
        center_y = body_top + body_h * 0.45
        self.canvas.create_oval(center_x - radius, center_y - radius,
                                center_x + radius, center_y + radius,
                                outline="#34493f", width=max(2, int(5 * s)))
        tick_inner = radius * 0.80
        tick_outer = radius * 0.96
        for deg in range(-60, 121, 18):
            angle = math.radians(deg - 90)
            ax = center_x + math.cos(angle) * tick_inner
            ay = center_y + math.sin(angle) * tick_inner
            bx = center_x + math.cos(angle) * tick_outer
            by = center_y + math.sin(angle) * tick_outer
            self.canvas.create_line(ax, ay, bx, by, fill="#52675c", width=max(1, int(1.4 * s)))
        has_reading = motor.get("online") is not False
        steer = max(-60.0, min(60.0, as_number(motor.get("angle"))))
        if has_reading:
            needle_angle = math.radians(steer - 90)
            needle_x = center_x + math.cos(needle_angle) * radius * 0.68
            needle_y = center_y + math.sin(needle_angle) * radius * 0.68
            self.canvas.create_line(center_x, center_y, needle_x, needle_y,
                                    fill=COLORS["accent"], width=max(2, int(3.5 * s)), capstyle="round")
        hub = max(3 * s, 4.2)
        self.canvas.create_oval(center_x - hub, center_y - hub, center_x + hub, center_y + hub,
                                fill=COLORS["accent"] if has_reading else COLORS["muted"],
                                outline=COLORS["accent"] if has_reading else COLORS["muted"])
        angle_label = "%d°" % round(as_number(motor.get("angle"))) if has_reading else "—°"
        self._text(center_x, center_y + radius * 0.58, angle_label,
                   10.5, COLORS["text"], bold=True, anchor="center")

        stats_x = center_x + radius + 11 * s
        stats_w = max(42 * s, x + width - 10 * s - stats_x)
        label_y = body_top + 3 * s
        self._text(stats_x, label_y, "об/мин", 8, COLORS["muted"])
        rpm = as_number(motor.get("rpm"))
        rpm_label = "%d" % round(rpm) if has_reading else "—"
        self._text(stats_x, label_y + 12 * s, rpm_label,
                   18 if height > 115 * s else 15, COLORS["text"], bold=True)
        temp_y = label_y + min(47 * s, body_h * 0.52)
        self._text(stats_x, temp_y, "температура", 7.5, COLORS["muted"])
        temp_label = "%d °C" % round(as_number(motor.get("temp"))) if has_reading else "— °C"
        self._text(stats_x, temp_y + 12 * s, temp_label,
                   11.5, COLORS["text"], bold=True)
        bar_y = y + height - 14 * s
        bar_h = max(5 * s, 6)
        self._rounded(stats_x, bar_y, stats_x + stats_w, bar_y + bar_h, bar_h / 2,
                      "#0d1714", COLORS["line"])
        fill_w = stats_w * min(1.0, abs(rpm) / 300.0)
        if fill_w > 0:
            bar_color = COLORS["error"] if rpm < 0 else COLORS["ok"]
            self._rounded(stats_x, bar_y, stats_x + max(bar_h, fill_w), bar_y + bar_h,
                          bar_h / 2, bar_color, bar_color)

    def _draw_battery(self, x: float, y: float, width: float, height: float) -> None:
        self._panel(x, y, width, height)
        s = self._scale
        self._text(x + 15 * s, y + 13 * s, "АККУМУЛЯТОР", 15, COLORS["text"], bold=True)
        self._text(x + width - 14 * s, y + 16 * s, "LiFePO₄ 12S3P", 9,
                   COLORS["muted"], anchor="ne")

        battery = (self.data or {}).get("battery")
        battery = battery if isinstance(battery, dict) else {}
        has_soc = battery.get("soc") is not None
        soc = max(0.0, min(100.0, as_number(battery.get("soc")))) if has_soc else 0.0
        tone = battery_tone(soc) if has_soc else "muted"
        ring_color = STATUS_COLOR[tone]
        ring_area_h = max(90 * s, height * 0.44)
        ring_cx = x + width / 2
        ring_cy = y + 49 * s + ring_area_h / 2
        radius = max(29 * s, min(width * 0.27, ring_area_h * 0.42, 85 * s))
        self.canvas.create_oval(ring_cx - radius, ring_cy - radius,
                                ring_cx + radius, ring_cy + radius,
                                outline="#1d2b25", width=max(7, int(10 * s)))
        self.canvas.create_arc(ring_cx - radius, ring_cy - radius,
                               ring_cx + radius, ring_cy + radius,
                               start=90, extent=-3.6 * soc, style=tk.ARC,
                               outline=ring_color, width=max(7, int(10 * s)))
        self._text(ring_cx, ring_cy - 3 * s, ("%d%%" % round(soc)) if has_soc else "—%",
                   min(40, max(27, 39 * s)), COLORS["text"], bold=True, anchor="center")
        label = str(battery.get("level") or "нет данных").lower()
        self._text(ring_cx, ring_cy + 23 * s, label, 8.5, COLORS["muted"],
                   bold=True, anchor="center")

        details_top = max(y + height * 0.56, ring_cy + radius + 10 * s)
        foot_h = 31 * s
        detail_bottom = y + height - foot_h - 8 * s
        detail_h = max(40 * s, detail_bottom - details_top)
        cell_gap = 7 * s
        cell_w = (width - 26 * s - cell_gap) / 2
        cell_h = (detail_h - cell_gap) / 2
        values = (
            ("НАПРЯЖЕНИЕ", format_ru(battery.get("volts"), 1, "—") + " В"),
            ("ТОК", format_ru(battery.get("amps"), 1, "—") + " А"),
            ("ЗАПАС ХОДА", format_ru(battery.get("rangeKm"), 1, "—") + " км"),
            ("СОСТОЯНИЕ", str(battery.get("state") or "—").upper()),
        )
        for index, (label_text, value) in enumerate(values):
            row, col = divmod(index, 2)
            cx = x + 13 * s + col * (cell_w + cell_gap)
            cy = details_top + row * (cell_h + cell_gap)
            self._rounded(cx, cy, cx + cell_w, cy + cell_h, 9 * s,
                          COLORS["panel_alt"], COLORS["line"])
            self._text(cx + 8 * s, cy + 5 * s, label_text, 7.5, COLORS["muted"])
            value_size = 12.2 if len(value) <= 12 else 9.5
            self._text(cx + 8 * s, cy + cell_h - 7 * s, value, value_size,
                       COLORS["text"], bold=True, anchor="sw", width=cell_w - 14 * s)

        volts = as_number(battery.get("volts"))
        if volts and volts < 33.5:
            hint, hint_color = "НИЖЕ АВАРИЙНОГО ПОРОГА 33,5 В", COLORS["error"]
        elif volts and volts < 35.5:
            hint, hint_color = "НИЖЕ ПОРОГА ПРЕДУПРЕЖДЕНИЯ 35,5 В", COLORS["warning"]
        else:
            hint, hint_color = "ПОРОГИ: 35,5 В · 33,5 В", COLORS["muted"]
        self._text(x + width / 2, y + height - 12 * s, hint, 8.2,
                   hint_color, bold=hint_color != COLORS["muted"], anchor="center")

    def _draw_lock(self, x: float, y: float, width: float, height: float) -> None:
        self._panel(x, y, width, height)
        s = self._scale
        title_y = y + 14 * s
        self._text(x + 15 * s, title_y, "ГРУЗОВОЙ ОТСЕК", 15, COLORS["text"], bold=True)
        lock = self._lock()
        lock_open = bool(lock.get("open"))
        blocked = self._lock_blocked()
        if not self.api_online:
            lock_label, lock_color = "НЕТ ДАННЫХ", "muted"
        elif blocked:
            lock_label = "БЛОКИРОВКА · %d С" % max(1, math.ceil(self._lock_remaining_ms() / 1000))
            lock_color = "error"
        elif lock_open:
            lock_label, lock_color = "ОТКРЫТО", "ok"
        else:
            lock_label, lock_color = "ЗАКРЫТО", "muted"
        chip_max = width * 0.48
        chip_w = min(chip_max, max(72 * s, len(lock_label) * 6 * s + 18 * s))
        self._rounded(x + width - chip_w - 12 * s, title_y - 1 * s,
                      x + width - 12 * s, title_y + 23 * s,
                      12 * s, "#1b2b23", COLORS["line"])
        self._text(x + width - chip_w / 2 - 12 * s, title_y + 11 * s,
                   lock_label, 8.5, STATUS_COLOR[lock_color], bold=True, anchor="center",
                   width=chip_w - 8 * s, justify="center")

        keypad_gap = 7 * s
        button_h = max(40 * s, min(50 * s, height * 0.105))
        cargo_h = 23 * s
        head_bottom = y + 40 * s
        pin_y = head_bottom + 5 * s
        pin_h = max(32 * s, height * 0.085)
        message_y = pin_y + pin_h + 1 * s
        message_h = 26 * s
        key_top = message_y + message_h + 2 * s
        cargo_y = y + height - 15 * s
        button_y = cargo_y - cargo_h - button_h - 5 * s
        key_bottom = button_y - 7 * s
        key_area_h = max(100 * s, key_bottom - key_top)
        inner_x = x + 14 * s
        inner_w = width - 28 * s
        key_w = (inner_w - 2 * keypad_gap) / 3
        key_h = (key_area_h - 3 * keypad_gap) / 4
        if key_h < 31 * s:
            key_h = 31 * s
            key_area_h = 4 * key_h + 3 * keypad_gap
            key_bottom = key_top + key_area_h
            button_y = key_bottom + 7 * s
            cargo_y = button_y + button_h + cargo_h + 5 * s

        pin_display = "  ".join("●" for _ in self.pin) if self.pin else "—  —  —  —"
        self._text(x + width / 2, pin_y + pin_h / 2, pin_display,
                   min(28, max(19, 26 * s)), COLORS["accent"], bold=True,
                   anchor="center")
        self._text(x + width / 2, message_y + message_h / 2, self.message,
                   8.5, STATUS_COLOR.get(self.message_kind, COLORS["muted"]),
                   anchor="center", width=width - 28 * s, justify="center")

        keys_active = self.api_online and not self.action_busy and not blocked and not lock_open
        for index, key in enumerate(KEYPAD):
            row, col = divmod(index, 3)
            kx = inner_x + col * (key_w + keypad_gap)
            ky = key_top + row * (key_h + keypad_gap)
            is_mode = key in ("⌫", "СБРОС")
            if keys_active:
                fill, outline, text_color = COLORS["panel_alt"], COLORS["line"], COLORS["text"]
            else:
                fill, outline, text_color = "#18231e", COLORS["line"], "#71847b"
            self._rounded(kx, ky, kx + key_w, ky + key_h, 10 * s, fill, outline)
            key_font = 10 if key == "СБРОС" else (15 if is_mode else 20)
            self._text(kx + key_w / 2, ky + key_h / 2, key, key_font,
                       text_color if not is_mode else (COLORS["muted"] if keys_active else text_color),
                       bold=True, anchor="center")
            if keys_active:
                self._hit_targets.append((kx, ky, kx + key_w, ky + key_h, ("key", key)))

        action_enabled = self.api_online and not self.action_busy and (lock_open or not blocked)
        action_label = "ЗАКРЫТЬ ОТСЕК" if lock_open else "ОТКРЫТЬ ОТСЕК"
        if self.action_busy:
            action_label = "ОБРАБОТКА…"
        self._button(inner_x, button_y, inner_w, button_h, action_label,
                     ("submit", None), enabled=action_enabled,
                     primary=action_enabled, font_size=12)

        cargo = (self.data or {}).get("cargo")
        cargo = cargo if isinstance(cargo, dict) else {}
        kg = cargo.get("kg", "—")
        cargo_state = "можно выгружать" if lock_open else "закреплён и заперт"
        self._text(inner_x + 2 * s, cargo_y, "ГРУЗ: %s кг" % kg,
                   8.5, COLORS["muted"], anchor="w")
        self._text(x + width - 14 * s, cargo_y, cargo_state,
                   8.5, COLORS["muted"], anchor="e")

    def _draw_footer(self, x: float, y: float, width: float, height: float) -> None:
        self._panel(x, y, width, height)
        s = self._scale
        route = str((self.data or {}).get("route") or "—")
        power = format_ru((self.data or {}).get("powerKw"), 2, "—")
        event = self.latest_audit
        if not event:
            event_text = "журнал: —"
        elif event.get("ok"):
            event_text = "журнал: доступ разрешён"
        else:
            event_text = "журнал: отказ в доступе"
        self._text(x + 14 * s, y + height / 2, "МАРШРУТ: " + route,
                   8.5, COLORS["muted"], anchor="w", width=width * 0.40)
        self._text(x + width * 0.47, y + height / 2,
                   "ТЯГА: %s кВт · КПД 0,86" % power,
                   8.5, COLORS["muted"], anchor="center")
        self._text(x + width - 180 * s, y + height / 2, event_text,
                   8, COLORS["muted"], anchor="e", width=145 * s, justify="right")
        link_w = min(154 * s, width * 0.20)
        link_h = min(height - 8 * s, 34 * s)
        link_x = x + width - link_w - 8 * s
        link_y = y + (height - link_h) / 2
        self._button(link_x, link_y, link_w, link_h, "ПУЛЬТ ИНЖЕНЕРА →",
                     ("console", None), enabled=True, primary=False, font_size=8.5)

    def _tick(self) -> None:
        if not self.root.winfo_exists():
            return
        # Перерисовка раз в секунду обновляет часы и время блокировки PIN.
        self.draw()
        self.root.after(1000, self._tick)


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Нативный полноэкранный экран RUS SLAM")
    parser.add_argument(
        "--url",
        default=os.environ.get("RUS_SLAM_API_URL", DEFAULT_API_URL),
        help="адрес API сервера робота (по умолчанию %(default)s)",
    )
    parser.add_argument("--windowed", action="store_true", help="запустить в обычном окне для отладки")
    parser.add_argument("--poll-ms", type=int, default=300, help="период опроса API в миллисекундах")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(argv)
    try:
        api = DisplayApi(args.url)
    except ValueError as exc:
        print("Ошибка адреса API: %s" % exc)
        return 2
    if tk is None or tkfont is None:
        print("Для нативного экрана нужен Tkinter (Ubuntu/Debian: sudo apt install python3-tk)")
        return 2
    try:
        root = tk.Tk()
    except tk.TclError as exc:
        print("Не удалось открыть графическое окно: %s" % exc)
        return 2
    NativeDisplay(root, api, fullscreen=not args.windowed, poll_ms=args.poll_ms)
    root.mainloop()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
