# -*- coding: utf-8 -*-
"""
Детектор сигнала светофора.

Подписка:  /camera/image_raw (sensor_msgs/Image).
Издание:   /perception/traffic_light (rus_slam_interfaces/TrafficLightState).

Базовый алгоритм: в верхней половине кадра ищутся насыщенные цветовые
области (красный/желтый/зеленый), победитель по площади задает сигнал.
При отсутствии цветовых пятен публикуется "unknown".
"""

import rclpy
from rclpy.node import Node
from rus_slam_interfaces.msg import TrafficLightState

from .vision_common import image_msg_to_bgr, try_import_cv2


class TrafficLightNode(Node):

    def __init__(self):
        super().__init__('traffic_light_node')

        self.declare_parameter('process_every', 3)
        self.declare_parameter('min_blob_px', 80)

        self._cv2 = try_import_cv2()
        if self._cv2 is None:
            self.get_logger().error(
                'OpenCV не установлен: детекция светофора отключена.')
        self._pub = self.create_publisher(TrafficLightState,
                                          '/perception/traffic_light', 10)
        from sensor_msgs.msg import Image
        self.create_subscription(Image, '/camera/image_raw',
                                 self._on_image, 1)
        self._process_every = max(1, self.get_parameter('process_every').value)
        self._counter = 0
        self.get_logger().info('Детектор светофора запущен.')

    # ------------------------------------------------------------------ #
    def _on_image(self, msg):
        if self._cv2 is None:
            return
        self._counter += 1
        if self._counter % self._process_every != 0:
            return
        frame = image_msg_to_bgr(msg)
        if frame is None:
            return

        cv2 = self._cv2
        h_img = frame.shape[0]
        roi = frame[:h_img // 2]  # светофоры ищем в верхней половине кадра
        hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)

        masks = {
            'red': cv2.inRange(hsv, (0, 140, 120), (8, 255, 255)) |
                   cv2.inRange(hsv, (172, 140, 120), (180, 255, 255)),
            'yellow': cv2.inRange(hsv, (18, 140, 140), (32, 255, 255)),
            'green': cv2.inRange(hsv, (45, 120, 100), (80, 255, 255)),
        }

        best_state, best_area = 'unknown', 0.0
        min_blob = self.get_parameter('min_blob_px').value
        for state, mask in masks.items():
            mask = cv2.morphologyEx(
                mask, cv2.MORPH_OPEN,
                cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3)))
            contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL,
                                           cv2.CHAIN_APPROX_SIMPLE)
            area = sum(cv2.contourArea(c) for c in contours
                       if cv2.contourArea(c) >= min_blob)
            if area > best_area:
                best_state, best_area = state, area

        out = TrafficLightState()
        out.header.stamp = msg.header.stamp
        out.header.frame_id = msg.header.frame_id
        out.state = best_state
        out.confidence = min(1.0, best_area / 2000.0)
        self._pub.publish(out)


def main(args=None):
    rclpy.init(args=args)
    node = TrafficLightNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
