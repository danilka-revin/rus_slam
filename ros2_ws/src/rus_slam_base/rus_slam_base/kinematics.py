# -*- coding: utf-8 -*-
"""
Обратная кинематика полноповоротного шасси 4WIS/4WID (крабовый ход).

Чистый Python без ROS-зависимостей — покрыт модульными тестами.

На входе: требуемая скорость корпуса (vx, vy, wz).
На выходе: угол поворота и скорость каждого из 4 модулей с учетом:
  * оптимизации перекладки (разворот на 180° вместо доворота > 90°);
  * нормализации скоростей при превышении максимума.
"""

import math
from dataclasses import dataclass, field
from typing import Dict, List

# Идентификаторы модулей (совпадают с ID в прошивке)
FL, FR, RL, RR = 1, 2, 3, 4


@dataclass
class ModulePose:
    """Геометрия одного поворотно-тягового модуля."""
    module_id: int
    name: str
    x: float  # продольная координата относительно центра робота, м
    y: float  # поперечная координата, м


@dataclass
class ModuleCommand:
    """Результат обратной кинематики для одного модуля."""
    module_id: int
    angle_rad: float   # целевой угол поворота модуля
    speed_mps: float   # линейная скорость колеса, м/с (со знаком)
    enable: bool = True


@dataclass
class SwerveKinematics:
    """Обратная кинематика шасси с 4 независимыми модулями."""

    wheelbase: float = 0.55       # расстояние между осями модулей по X, м
    track: float = 0.46           # колея по Y, м
    max_speed: float = 2.0        # физический предел скорости колеса, м/с
    deadband: float = 0.01        # порог нулевых команд, м/с и рад/с
    modules: List[ModulePose] = field(default_factory=list)

    def __post_init__(self):
        if not self.modules:
            hx, hy = self.wheelbase / 2.0, self.track / 2.0
            self.modules = [
                ModulePose(FL, 'FL', +hx, +hy),
                ModulePose(FR, 'FR', +hx, -hy),
                ModulePose(RL, 'RL', -hx, +hy),
                ModulePose(RR, 'RR', -hx, -hy),
            ]
        self._last_angles: Dict[int, float] = {m.module_id: 0.0 for m in self.modules}

    # ------------------------------------------------------------------ #
    def inverse(self, vx: float, vy: float, wz: float) -> List[ModuleCommand]:
        """Расчет команд модулей по скорости корпуса."""
        if abs(vx) < self.deadband and abs(vy) < self.deadband \
                and abs(wz) < self.deadband:
            # Стоянка: тяга снята, углы удерживаются
            return [ModuleCommand(m.module_id, self._last_angles[m.module_id],
                                  0.0, enable=False) for m in self.modules]

        angles: List[float] = []
        speeds: List[float] = []
        for m in self.modules:
            vx_i = vx - wz * m.y
            vy_i = vy + wz * m.x
            speed = math.hypot(vx_i, vy_i)
            angle = math.atan2(vy_i, vx_i)
            angle, speed = self._optimize_angle(angle, speed, m.module_id)
            self._last_angles[m.module_id] = angle
            angles.append(angle)
            speeds.append(speed)

        # Нормализация: сохраняем траекторию при превышении лимита
        max_calc = max(abs(s) for s in speeds)
        scale = self.max_speed / max_calc if max_calc > self.max_speed else 1.0

        return [
            ModuleCommand(m.module_id, angles[i], speeds[i] * scale, enable=True)
            for i, m in enumerate(self.modules)
        ]

    # ------------------------------------------------------------------ #
    def _optimize_angle(self, target: float, speed: float,
                        module_id: int) -> (float, float):
        """Минимизация времени перекладки руля.

        Если кратчайший доворот превышает 90°, колесо разворачивается на
        (цель − 180°), а направление тяги инвертируется.
        """
        prev = self._last_angles.get(module_id, 0.0)
        diff = (target - prev + math.pi) % (2.0 * math.pi) - math.pi
        if abs(diff) > math.pi / 2.0:
            diff = diff - math.pi if diff > 0.0 else diff + math.pi
            speed = -speed
        return prev + diff, speed

    @property
    def last_angles(self) -> Dict[int, float]:
        return dict(self._last_angles)
