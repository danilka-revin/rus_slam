# -*- coding: utf-8 -*-
"""
Узел обратной кинематики шасси 4WIS/4WID (крабовый ход).

Подписка:  /cmd_vel (geometry_msgs/Twist) — от гейта безопасности (далее —
           от стека навигации).
Издание:   /wheel_commands (rus_slam_interfaces/WheelCommandArray) — команды
           углов и скоростей для 4 модулей.

Расчет выполняется на частоте ~20 Гц по последней принятой команде; если
команд нет дольше `cmd_timeout_sec`, издается останов (модули обесточены).
Сама кинематика — в модуле `kinematics.py` (покрыта тестами).
"""

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from rus_slam_interfaces.msg import WheelCommand, WheelCommandArray

from .kinematics import SwerveKinematics


class CrabDriveNode(Node):

    def __init__(self):
        super().__init__('crab_drive_node')

        # Геометрия шасси под габариты 750×600 мм
        self.declare_parameter('wheelbase_L', 0.55)
        self.declare_parameter('track_W', 0.46)
        self.declare_parameter('max_linear_speed', 2.0)
        self.declare_parameter('deadband', 0.01)
        self.declare_parameter('control_rate_hz', 20.0)
        self.declare_parameter('cmd_timeout_sec', 0.5)

        self._kin = SwerveKinematics(
            wheelbase=self.get_parameter('wheelbase_L').value,
            track=self.get_parameter('track_W').value,
            max_speed=self.get_parameter('max_linear_speed').value,
            deadband=self.get_parameter('deadband').value,
        )
        self._cmd_timeout = self.get_parameter('cmd_timeout_sec').value

        self._last_twist = None
        self._last_rx = self.get_clock().now()

        self._pub = self.create_publisher(WheelCommandArray, '/wheel_commands', 10)
        self.create_subscription(Twist, '/cmd_vel', self._on_cmd_vel, 10)

        rate = self.get_parameter('control_rate_hz').value
        self.create_timer(1.0 / rate, self._tick)
        self.get_logger().info(
            f'Кинематика 4WIS/4WID запущена: L={self._kin.wheelbase} м, '
            f'W={self._kin.track} м, Vmax={self._kin.max_speed} м/с')

    # ------------------------------------------------------------------ #
    def _on_cmd_vel(self, msg: Twist):
        self._last_twist = msg
        self._last_rx = self.get_clock().now()

    def _tick(self):
        now = self.get_clock().now()
        if self._last_twist is None or \
                (now - self._last_rx).nanoseconds * 1e-9 > self._cmd_timeout:
            vx = vy = wz = 0.0
        else:
            vx, vy, wz = (self._last_twist.linear.x,
                          self._last_twist.linear.y,
                          self._last_twist.angular.z)

        commands = self._kin.inverse(vx, vy, wz)

        msg = WheelCommandArray()
        msg.header.stamp = now.to_msg()
        msg.header.frame_id = 'base_link'
        for cmd in commands:
            wc = WheelCommand()
            wc.module_id = cmd.module_id
            wc.steer_angle = float(cmd.angle_rad)
            wc.drive_speed = float(cmd.speed_mps)
            wc.enable = cmd.enable
            msg.commands.append(wc)
        self._pub.publish(msg)


def main(args=None):
    rclpy.init(args=args)
    node = CrabDriveNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
