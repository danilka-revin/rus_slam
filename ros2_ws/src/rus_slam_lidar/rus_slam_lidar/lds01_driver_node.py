# -*- coding: utf-8 -*-
"""
Узел драйвера кругового лидара ЛДС-01.

Читает кадры по UART (по умолчанию совместимый формат семейства
ЛДС-01, параметры кадра — в конфиге) и публикует
`sensor_msgs/LaserScan` на топик `/scan` в системе координат `lidar_link`.
"""

import math
import threading
import time

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import LaserScan

from .lds_protocol import LdsParser


class Lds01DriverNode(Node):

    def __init__(self):
        super().__init__('lds01_driver_node')

        self.declare_parameter('port', '/dev/rus_lidar')
        self.declare_parameter('baud_rate', 230400)
        self.declare_parameter('frame_id', 'lidar_link')
        self.declare_parameter('sync_byte', 0x54)
        self.declare_parameter('ver_len', 0x2C)
        self.declare_parameter('min_range_m', 0.12)
        self.declare_parameter('max_range_m', 12.0)
        self.declare_parameter('angle_min_deg', -180.0)
        self.declare_parameter('angle_max_deg', 180.0)
        self.declare_parameter('stale_warn_sec', 1.5)

        self._frame_id = self.get_parameter('frame_id').value
        self._min_range = self.get_parameter('min_range_m').value
        self._max_range = self.get_parameter('max_range_m').value
        self._stale_warn = self.get_parameter('stale_warn_sec').value

        self._parser = LdsParser(
            sync_byte=self.get_parameter('sync_byte').value,
            ver_len=self.get_parameter('ver_len').value,
        )
        self._pub = self.create_publisher(LaserScan, '/scan', 10)

        self._serial = None
        self._running = True
        self._last_frame_time = time.monotonic()
        port = self.get_parameter('port').value
        baud = self.get_parameter('baud_rate').value
        try:
            import serial
            self._serial = serial.Serial(port, baud, timeout=0.1)
            self.get_logger().info(f'Лидар ЛДС-01 открыт: {port} @ {baud}')
        except Exception as exc:  # noqa: BLE001
            self.get_logger().error(
                f'Не удалось открыть лидар {port}: {exc}. '
                'Сканы публиковаться не будут.')

        self._thread = threading.Thread(target=self._reader, daemon=True)
        self._thread.start()
        self.create_timer(self._stale_warn, self._health_check)

    # ------------------------------------------------------------------ #
    def _reader(self):
        while self._running and rclpy.ok():
            if self._serial is None:
                time.sleep(1.0)
                continue
            try:
                data = self._serial.read(512)
            except Exception as exc:  # noqa: BLE001
                self.get_logger().error(f'Ошибка чтения лидара: {exc}',
                                        throttle_duration_sec=5.0)
                time.sleep(0.2)
                continue
            if not data:
                continue
            for frame in self._parser.feed(data):
                self._publish_scan(frame)
                self._last_frame_time = time.monotonic()

    def _publish_scan(self, frame):
        n = len(frame.points)
        if n == 0:
            return

        span = frame.end_angle_deg - frame.start_angle_deg
        if span <= 0.0:
            span += 360.0

        msg = LaserScan()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.header.frame_id = self._frame_id
        msg.angle_min = math.radians(frame.start_angle_deg)
        msg.angle_max = math.radians(frame.start_angle_deg + span)
        msg.angle_increment = math.radians(span) / max(n - 1, 1)
        # Один оборот ~360° за кадр из нескольких пакетов; время между
        # пакетами оцениваем по скорости вращения
        if frame.speed_dps > 1e-3:
            msg.scan_time = span / frame.speed_dps
            msg.time_increment = msg.scan_time / max(n - 1, 1)
        msg.range_min = self._min_range
        msg.range_max = self._max_range
        ranges = []
        intensities = []
        for dist, intensity in frame.points:
            if dist < 1e-6:
                ranges.append(float('inf'))      # нет возврата
            else:
                ranges.append(dist)
            intensities.append(float(intensity))
        msg.ranges = ranges
        msg.intensities = intensities
        self._pub.publish(msg)

    def _health_check(self):
        if self._serial is None:
            return
        age = time.monotonic() - self._last_frame_time
        if age > self._stale_warn:
            self.get_logger().warn(
                f'Нет данных лидара {age:.1f} с',
                throttle_duration_sec=5.0)

    # ------------------------------------------------------------------ #
    def destroy_node(self):
        self._running = False
        if self._serial is not None:
            try:
                self._serial.close()
            except Exception:  # noqa: BLE001
                pass
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = Lds01DriverNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
