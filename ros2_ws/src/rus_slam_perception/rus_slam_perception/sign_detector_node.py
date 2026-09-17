# -*- coding: utf-8 -*-
"""
Детектор дорожных знаков по регламенту задания № 2:
  * «Стоп» (2.5) — красный восьмиугольник;
  * «Пешеходный переход» (5.19.1) — синий квадрат;
  * «Искусственная неровность» (1.17) — желтый треугольник.

Подписка:  /camera/image_raw (sensor_msgs/Image).
Издание:   /perception/signs (rus_slam_interfaces/SignDetectionArray).

В базовой ревизии используется классическая цветовая сегментация (HSV) и
анализ формы контуров. Точная оценка дистанции появится после калибровки
камеры; сейчас расстояние оценивается по высоте рамки знака в кадре.
Замена на нейросетевую модель (YOLOv8) выполняется в этом же узле.
"""

import rclpy
from rclpy.node import Node
from rus_slam_interfaces.msg import SignDetection, SignDetectionArray

from .vision_common import image_msg_to_bgr, polygon_sides, try_import_cv2

# Физическая высота рамки знака, м (для оценки дистанции)
SIGN_REAL_HEIGHT = {
    'stop': 0.30,
    'pedestrian_crossing': 0.30,
    'speed_bump': 0.30,
}


class SignDetectorNode(Node):

    def __init__(self):
        super().__init__('sign_detector_node')

        self.declare_parameter('process_every', 3)       # обрабатывать каждый 3-й кадр
        self.declare_parameter('min_area_px', 400)
        self.declare_parameter('focal_px', 640.0)        # фокусное расстояние в пикселях
        self.declare_parameter('max_detections', 5)

        self._cv2 = try_import_cv2()
        if self._cv2 is None:
            self.get_logger().error(
                'OpenCV не установлен: детекция знаков отключена '
                '(установите пакет python3-opencv).')
        self._pub = self.create_publisher(SignDetectionArray,
                                          '/perception/signs', 10)
        from sensor_msgs.msg import Image
        self.create_subscription(Image, '/camera/image_raw',
                                 self._on_image, 1)
        self._process_every = max(1, self.get_parameter('process_every').value)
        self._counter = 0
        self.get_logger().info('Детектор знаков запущен.')

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
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        out = SignDetectionArray()
        out.header.stamp = msg.header.stamp
        out.header.frame_id = msg.header.frame_id

        max_det = self.get_parameter('max_detections').value
        min_area = self.get_parameter('min_area_px').value
        focal = self.get_parameter('focal_px').value

        # 1. Знак «Стоп»: красный восьмиугольник
        red = cv2.inRange(hsv, (0, 120, 70), (10, 255, 255)) | \
            cv2.inRange(hsv, (170, 120, 70), (180, 255, 255))
        self._find_sign(cv2, frame, red, out, 'stop', 8, min_area, focal)

        # 2. «Пешеходный переход»: синий квадрат
        blue = cv2.inRange(hsv, (95, 120, 70), (130, 255, 255))
        self._find_sign(cv2, frame, blue, out, 'pedestrian_crossing',
                        4, min_area, focal)

        # 3. «Искусственная неровность»: желтый треугольник
        yellow = cv2.inRange(hsv, (20, 120, 120), (35, 255, 255))
        self._find_sign(cv2, frame, yellow, out, 'speed_bump',
                        3, min_area, focal)

        if len(out.detections) > max_det:
            out.detections = out.detections[:max_det]
        self._pub.publish(out)

    # ------------------------------------------------------------------ #
    def _find_sign(self, cv2, frame, mask, out: SignDetectionArray,
                   class_id: str, sides: int, min_area: float,
                   focal: float):
        mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                                cv2.getStructuringElement(cv2.MORPH_RECT,
                                                          (5, 5)))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL,
                                       cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < min_area:
                continue
            x, y, w, h = cv2.boundingRect(cnt)
            aspect = w / max(h, 1)
            if aspect < 0.5 or aspect > 2.0:
                continue
            n = polygon_sides(cv2, cnt)
            if abs(n - sides) > 1:
                continue
            det = SignDetection()
            det.header = out.header
            det.class_id = class_id
            det.confidence = min(1.0, area / 5000.0)
            real_h = SIGN_REAL_HEIGHT.get(class_id, 0.3)
            det.distance = float(focal * real_h / max(h, 1))
            det.x, det.y, det.width, det.height = int(x), int(y), int(w), int(h)
            out.detections.append(det)


def main(args=None):
    rclpy.init(args=args)
    node = SignDetectorNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
