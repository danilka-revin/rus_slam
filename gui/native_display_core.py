#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""HTTP-клиент и небольшие форматтеры для нативного экрана RUS SLAM.

Модуль намеренно не зависит от Tkinter и не загружает HTML: он общается только
с JSON API `gui/backend.py`. Это позволяет тестировать клиент без графической
сессии и использовать его в Windows/Linux-сборках.
"""

from __future__ import annotations

import json
import math
import urllib.error
import urllib.request
from typing import Any


DEFAULT_API_URL = "http://127.0.0.1:8080"


class ApiError(RuntimeError):
    """Сервер недоступен или вернул некорректный ответ API."""

    def __init__(self, message: str, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class DisplayApi:
    """Клиент только для JSON API основного экрана."""

    def __init__(self, base_url: str = DEFAULT_API_URL, timeout: float = 1.2):
        base_url = (base_url or DEFAULT_API_URL).strip().rstrip("/")
        if not base_url.startswith(("http://", "https://")):
            raise ValueError("адрес сервера должен начинаться с http:// или https://")
        self.base_url = base_url
        self.timeout = max(0.1, float(timeout))

    def _request(self, path: str, payload: dict[str, Any] | None = None) -> tuple[int, dict[str, Any]]:
        url = self.base_url + path
        headers = {"Accept": "application/json", "Cache-Control": "no-cache"}
        data = None
        method = "GET"
        if payload is not None:
            method = "POST"
            headers["Content-Type"] = "application/json; charset=utf-8"
            data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        status = 200
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                status = int(response.status)
                raw = response.read()
        except urllib.error.HTTPError as exc:
            # Ошибочный PIN штатно отвечает HTTP 403 и JSON-телом; не теряем
            # это сообщение и возвращаем его вызывающему интерфейсу.
            status = int(exc.code)
            raw = exc.read()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            reason = getattr(exc, "reason", exc)
            raise ApiError("сервер недоступен: %s" % reason) from exc

        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ApiError("сервер вернул не JSON", status=status) from exc
        if not isinstance(body, dict):
            raise ApiError("ожидался JSON-объект", status=status, body=body)
        return status, body

    def get_state(self) -> dict[str, Any]:
        status, body = self._request("/api/state")
        data = body.get("data")
        if status >= 400 or body.get("ok") is not True or not isinstance(data, dict):
            raise ApiError("сервер не вернул состояние робота", status=status, body=body)
        return data

    def get_latest_audit(self) -> dict[str, Any] | None:
        status, body = self._request("/api/audit?limit=1")
        if status >= 400:
            raise ApiError("не удалось получить журнал доступа", status=status, body=body)
        entries = body.get("audit")
        if not isinstance(entries, list) or not entries or not isinstance(entries[0], dict):
            return None
        return entries[0]

    def open_lock(self, pin: str) -> dict[str, Any]:
        _, body = self._request("/api/lock/open", {"pin": str(pin)})
        return body

    def close_lock(self) -> dict[str, Any]:
        _, body = self._request("/api/lock/close", {})
        return body


def as_number(value: Any, default: float = 0.0) -> float:
    """Безопасно преобразует API-значение в конечное число."""
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return number if math.isfinite(number) else default


def format_ru(value: Any, digits: int = 1, default: str = "—") -> str:
    """Форматирует число в привычной русской записи с десятичной запятой."""
    try:
        if value is None or value == "":
            return default
        number = float(value)
        if not math.isfinite(number):
            return default
        return ("%.*f" % (max(0, int(digits)), number)).replace(".", ",")
    except (TypeError, ValueError, OverflowError):
        return default


def motor_status(motor: dict[str, Any]) -> tuple[str, str]:
    """Возвращает короткую подпись и цветовой ключ состояния модуля."""
    if motor.get("online") is False:
        return "НЕТ СВЯЗИ", "error"
    if motor.get("fault"):
        return "АВАРИЯ", "error"
    if motor.get("homed") is False:
        return "ХОМИНГ", "warning"
    if as_number(motor.get("temp")) > 55:
        return "ПЕРЕГРЕВ", "error"
    if abs(as_number(motor.get("rpm"))) > 4:
        return "ДВИЖЕНИЕ", "accent"
    return "ГОТОВ", "ok"


def battery_tone(soc: Any) -> str:
    """Цветовая категория заряда аккумулятора."""
    value = as_number(soc)
    if value < 20:
        return "error"
    if value < 40:
        return "warning"
    return "ok"
