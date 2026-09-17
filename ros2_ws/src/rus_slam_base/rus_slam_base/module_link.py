# -*- coding: utf-8 -*-
"""
Низкоуровневый доступ к портам модулей и программная симуляция модуля.

* `open_port` — открытие последовательного порта (ленивый импорт pyserial);
* `SimulatedModule` — идеализированная модель модуля для режима без железа:
  угол сходится к заданию с ограничением скорости перекладки, колесо
  повторяет заданную тягу, напряжение и ток эмулируются.
"""

import math
import time
from dataclasses import dataclass, field

from . import protocol

BAUD_RATE = 115200


def open_port(port: str, baud: int = BAUD_RATE, timeout: float = 0.05):
    """Открыть последовательный порт. Бросает исключение при неудаче."""
    import serial  # ленивый импорт: пакет может работать и без железа
    return serial.Serial(port, baud, timeout=timeout)


@dataclass
class SimulatedModule:
    """Программная модель поворотно-тягового модуля."""

    module_id: int
    max_steer_rate_deg: float = 360.0   # скорость перекладки, град/с
    max_speed_mps: float = 2.0          # скорость при ШИМ 1000
    vbat_cv: int = 3840                 # эмулируемое напряжение, сВ
    _angle_deg: float = field(default=0.0, init=False)
    _speed_mps: float = field(default=0.0, init=False)
    _enabled: bool = field(default=False, init=False)
    _homed: bool = field(default=True, init=False)
    _last_time: float = field(default_factory=time.monotonic, init=False)

    def feed_command(self, steer_cdeg: int, pwm: int, enable: bool,
                     home: bool) -> None:
        """Применить входящий кадр команды к модели."""
        if home:
            self._angle_deg = 0.0
            self._homed = True
        self._enabled = enable
        target = steer_cdeg / 100.0
        now = time.monotonic()
        dt = max(0.0, now - self._last_time)
        self._last_time = now

        if enable:
            max_step = self.max_steer_rate_deg * dt
            delta = max(-max_step, min(max_step, target - self._angle_deg))
            self._angle_deg += delta
            self._speed_mps = (pwm / protocol.MAX_PWM) * self.max_speed_mps
        else:
            self._speed_mps = 0.0

    def step(self, dt: float, wheel_radius: float,
             ticks_per_rev: float) -> protocol.TelemetryFrame:
        """Сделать шаг симуляции и выдать кадр телеметрии."""
        self._last_time = time.monotonic()
        if ticks_per_rev > 0:
            dist = self._speed_mps * dt
            enc_delta = int(round(dist * ticks_per_rev / (2.0 * math.pi * wheel_radius)))
        else:
            enc_delta = 0
        status = 0
        if self._enabled:
            status |= protocol.STATUS_ENABLED
        if self._homed:
            status |= protocol.STATUS_HOMED
        current_ma = int(abs(self._speed_mps) / max(self.max_speed_mps, 1e-6) * 8000)
        return protocol.TelemetryFrame(
            module_id=self.module_id,
            status=status,
            steer_cdeg=int(round(self._angle_deg * 100.0)),
            enc_delta=max(-32767, min(32767, enc_delta)),
            pwm_actual=0,
            vbat_cv=self.vbat_cv,
            current_ma=current_ma,
        )
