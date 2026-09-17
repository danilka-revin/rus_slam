# -*- coding: utf-8 -*-
"""
Одометрия полноповоротного шасси 4WIS/4WID.

Чистый Python без ROS-зависимостей — покрыт модульными тестами.

Каждое колесо задает вектор скорости, приложенный в своей точке опоры:
  w_i = v_i · [cos θ_i, sin θ_i].
Скорость корпуса (vx, vy, wz) — решение переопределенной системы
методом наименьших квадратов (нормальные уравнения 3×3).
"""

import math
from dataclasses import dataclass
from typing import List, Tuple


@dataclass
class Twist2D:
    vx: float = 0.0
    vy: float = 0.0
    wz: float = 0.0


@dataclass
class WheelSample:
    module_id: int
    angle_rad: float    # фактический угол модуля
    distance_m: float   # пройденный колесом путь за период (со знаком)


def _solve3(a: List[List[float]], b: List[float]):
    """Решение СЛАУ 3×3 методом Гаусса; возвращает None при вырождении."""
    m = [row[:] + [b[i]] for i, row in enumerate(a)]
    for col in range(3):
        pivot = max(range(col, 3), key=lambda r: abs(m[r][col]))
        if abs(m[pivot][col]) < 1e-9:
            return None
        m[col], m[pivot] = m[pivot], m[col]
        for r in range(col + 1, 3):
            k = m[r][col] / m[col][col]
            for c in range(col, 4):
                m[r][c] -= k * m[col][c]
    x = [0.0] * 3
    for r in range(2, -1, -1):
        x[r] = (m[r][3] - sum(m[r][c] * x[c] for c in range(r + 1, 3))) / m[r][r]
    return x


class SwerveOdometry:
    """Восстановление скорости корпуса по данным 4 модулей."""

    def __init__(self, wheelbase: float, track: float):
        self.positions = {
            1: (wheelbase / 2.0, track / 2.0),    # FL
            2: (wheelbase / 2.0, -track / 2.0),   # FR
            3: (-wheelbase / 2.0, track / 2.0),   # RL
            4: (-wheelbase / 2.0, -track / 2.0),  # RR
        }

    def estimate_twist(self, dt: float, samples: List[WheelSample]) -> Twist2D:
        """МНК-оценка скорости корпуса по выборке колес."""
        if dt <= 0.0 or not samples:
            return Twist2D()

        # Нормальные уравнения: (A^T A) x = A^T b
        ata = [[0.0] * 3 for _ in range(3)]
        atb = [0.0] * 3
        for s in samples:
            if s.module_id not in self.positions:
                continue
            x_i, y_i = self.positions[s.module_id]
            c, sn = math.cos(s.angle_rad), math.sin(s.angle_rad)
            # Строка матрицы наблюдений: [c, s, x·s − y·c]
            row = [c, sn, x_i * sn - y_i * c]
            speed = s.distance_m / dt
            for r in range(3):
                atb[r] += row[r] * speed
                for col in range(3):
                    ata[r][col] += row[r] * row[col]

        # Регуляризация Тихонова: при прямолинейном/крабовом ходе система
        # вырождена по одной из компонент — берем решение с мин. нормой
        for r in range(3):
            ata[r][r] += 1e-9

        sol = _solve3(ata, atb)
        if sol is None:
            return Twist2D()
        return Twist2D(vx=sol[0], vy=sol[1], wz=sol[2])


def integrate_pose(pose: Tuple[float, float, float], twist: Twist2D,
                   dt: float) -> Tuple[float, float, float]:
    """Интегрирование позы (x, y, yaw) по скорости корпуса.

    Используется средний курс за период — точность выше, чем при
    простом Эйлеровом интегрировании.
    """
    x, y, yaw = pose
    mid_yaw = yaw + twist.wz * dt / 2.0
    x += (twist.vx * math.cos(mid_yaw) - twist.vy * math.sin(mid_yaw)) * dt
    y += (twist.vx * math.sin(mid_yaw) + twist.vy * math.cos(mid_yaw)) * dt
    yaw = math.atan2(math.sin(yaw + twist.wz * dt),
                     math.cos(yaw + twist.wz * dt))
    return x, y, yaw


def ticks_to_meters(enc_delta: int, wheel_radius: float,
                    ticks_per_rev: float) -> float:
    """Пересчет приращения тиков энкодера в пройденный путь, м."""
    if ticks_per_rev <= 0.0:
        return 0.0
    return enc_delta * 2.0 * math.pi * wheel_radius / ticks_per_rev
