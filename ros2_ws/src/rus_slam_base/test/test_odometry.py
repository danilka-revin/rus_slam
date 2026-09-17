# -*- coding: utf-8 -*-
"""Модульные тесты одометрии шасси 4WIS/4WID."""

import math

from rus_slam_base.odometry_core import (SwerveOdometry, WheelSample,
                                         integrate_pose, ticks_to_meters,
                                         Twist2D)

L, W = 0.55, 0.46


def _samples_from_twist(vx, vy, wz, dt):
    """Синтез показаний колес, соответствующих заданной скорости корпуса."""
    odom = SwerveOdometry(L, W)
    samples = []
    for mid, (x_i, y_i) in odom.positions.items():
        vx_i = vx - wz * y_i
        vy_i = vy + wz * x_i
        speed = math.hypot(vx_i, vy_i)
        angle = math.atan2(vy_i, vx_i)
        samples.append(WheelSample(mid, angle, speed * dt))
    return samples


def test_recovers_forward_motion():
    odom = SwerveOdometry(L, W)
    twist = odom.estimate_twist(0.05, _samples_from_twist(0.8, 0.0, 0.0, 0.05))
    assert abs(twist.vx - 0.8) < 1e-5
    assert abs(twist.vy) < 1e-5
    assert abs(twist.wz) < 1e-5


def test_recovers_crab_motion():
    odom = SwerveOdometry(L, W)
    twist = odom.estimate_twist(0.05, _samples_from_twist(0.3, 0.3, 0.0, 0.05))
    assert abs(twist.vx - 0.3) < 1e-5
    assert abs(twist.vy - 0.3) < 1e-5
    assert abs(twist.wz) < 1e-5


def test_recovers_rotation_in_place():
    odom = SwerveOdometry(L, W)
    twist = odom.estimate_twist(0.05, _samples_from_twist(0.0, 0.0, 1.2, 0.05))
    assert abs(twist.vx) < 1e-5
    assert abs(twist.vy) < 1e-5
    assert abs(twist.wz - 1.2) < 1e-5


def test_recovers_combined_motion():
    odom = SwerveOdometry(L, W)
    twist = odom.estimate_twist(0.1, _samples_from_twist(0.5, -0.2, 0.7, 0.1))
    assert abs(twist.vx - 0.5) < 1e-5
    assert abs(twist.vy + 0.2) < 1e-5
    assert abs(twist.wz - 0.7) < 1e-5


def test_zero_dt_gives_zero():
    odom = SwerveOdometry(L, W)
    twist = odom.estimate_twist(0.0, _samples_from_twist(1.0, 0.0, 0.0, 0.1))
    assert twist.vx == twist.vy == twist.wz == 0.0


def test_integrate_pose_forward():
    pose = integrate_pose((0.0, 0.0, 0.0), Twist2D(1.0, 0.0, 0.0), 2.0)
    assert abs(pose[0] - 2.0) < 1e-9
    assert abs(pose[1]) < 1e-9


def test_integrate_pose_crab_rotated():
    # Крабовый ход вбок при курсе 90°
    pose = integrate_pose((0.0, 0.0, math.pi / 2), Twist2D(1.0, 0.0, 0.0), 1.0)
    assert abs(pose[0]) < 1e-9
    assert abs(pose[1] - 1.0) < 1e-9


def test_ticks_to_meters():
    dist = ticks_to_meters(120, 0.127, 120.0)
    assert abs(dist - 2 * math.pi * 0.127) < 1e-9
    assert ticks_to_meters(10, 0.127, 0.0) == 0.0
