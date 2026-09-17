# -*- coding: utf-8 -*-
"""Модульные тесты обратной кинематики шасси 4WIS/4WID."""

import math

from rus_slam_base.kinematics import SwerveKinematics


def _by_id(commands):
    return {c.module_id: c for c in commands}


def test_full_stop_disables_modules():
    kin = SwerveKinematics()
    for cmd in kin.inverse(0.0, 0.0, 0.0):
        assert cmd.enable is False
        assert cmd.speed_mps == 0.0


def test_forward_motion():
    kin = SwerveKinematics()
    cmds = _by_id(kin.inverse(0.5, 0.0, 0.0))
    for mid, cmd in cmds.items():
        assert cmd.enable is True
        assert abs(cmd.speed_mps - 0.5) < 1e-6
        # Все колеса смотрят вперед
        assert abs(math.atan2(math.sin(cmd.angle_rad),
                              math.cos(cmd.angle_rad))) < 1e-6


def test_crab_sideways_45():
    kin = SwerveKinematics()
    cmds = _by_id(kin.inverse(0.4, 0.4, 0.0))
    for cmd in cmds.values():
        speed = math.hypot(0.4, 0.4)
        assert abs(abs(cmd.speed_mps) - speed) < 1e-6
        # Угол ±45° (с учетом возможной инверсии тяги на 180°)
        a = math.atan2(math.sin(cmd.angle_rad), math.cos(cmd.angle_rad))
        assert abs(abs(a) - math.pi / 4.0) < 1e-6


def test_pure_rotation_tangential_angles():
    kin = SwerveKinematics()
    cmds = _by_id(kin.inverse(0.0, 0.0, 0.8))
    for mid, cmd in cmds.items():
        m = next(m for m in kin.modules if m.module_id == mid)
        # Касательная к окружности описания: перпендикуляр к радиус-вектору
        expected = math.atan2(m.x, -m.y)
        a = math.atan2(math.sin(cmd.angle_rad), math.cos(cmd.angle_rad))
        e = math.atan2(math.sin(expected), math.cos(expected))
        diff = abs(math.atan2(math.sin(a - e), math.cos(a - e)))
        assert diff < 1e-6 or abs(diff - math.pi) < 1e-6


def test_speed_normalization():
    kin = SwerveKinematics(max_speed=1.0)
    cmds = kin.inverse(1.0, 1.0, 1.0)
    assert max(abs(c.speed_mps) for c in cmds) <= 1.0 + 1e-9


def test_angle_optimization_reverses_thrust():
    kin = SwerveKinematics()
    # Разгон назад: цели близки к ±180°, доворот из нуля > 90°
    cmds = _by_id(kin.inverse(-0.5, 0.0, 0.0))
    for cmd in cmds.values():
        # Колесо осталось около 0°, но едет назад
        assert cmd.speed_mps < 0
        assert abs(cmd.angle_rad) < 1e-6
