# -*- coding: utf-8 -*-
"""
Узел бортовой камеры машинного зрения.

Читает кадры с USB-камеры (V4L2 через OpenCV) и публикует:
  /camera/image_raw (sensor_msgs/Image, rgb8)
  /camera/camera_info (sensor_msgs/CameraInfo, базовая модель пинхол-камеры)
"""

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import CameraInfo, Image


class CameraNode(Node):

    def __init__(self):
        super().__init__('camera_node')

        self.declare_parameter('device', 0)
        self.declare_parameter('width', 640)
        self.declare_parameter('height', 480)
        self.declare_parameter('fps', 15.0)
        self.declare_parameter('frame_id', 'camera_link')

        self._cv2 = None
        self._cap = None
        try:
            import cv2
            self._cv2 = cv2
            device = self.get_parameter('device').value
            self._cap = cv2.VideoCapture(device)
            self._cap.set(cv2.CAP_PROP_FRAME_WIDTH,
                          self.get_parameter('width').value)
            self._cap.set(cv2.CAP_PROP_FRAME_HEIGHT,
                          self.get_parameter('height').value)
            if not self._cap.isOpened():
                self.get_logger().error(
                    f'Камера /dev/video{device} недоступна.')
                self._cap = None
            else:
                self.get_logger().info(f'Камера открыта: /dev/video{device}')
        except Exception as exc:  # noqa: BLE001
            self.get_logger().error(
                f'OpenCV недоступен или камера не открыта: {exc}')

        self._frame_id = self.get_parameter('frame_id').value
        self._pub_img = self.create_publisher(Image, '/camera/image_raw', 10)
        self._pub_info = self.create_publisher(CameraInfo,
                                               '/camera/camera_info', 10)

        fps = max(1.0, self.get_parameter('fps').value)
        self.create_timer(1.0 / fps, self._tick)

    # ------------------------------------------------------------------ #
    def _tick(self):
        if self._cap is None:
            return
        ok, frame = self._cap.read()
        if not ok or frame is None:
            self.get_logger().warn('Кадр с камеры не получен',
                                   throttle_duration_sec=5.0)
            return

        h, w = frame.shape[:2]
        stamp = self.get_clock().now().to_msg()

        img = Image()
        img.header.stamp = stamp
        img.header.frame_id = self._frame_id
        img.height, img.width = h, w
        img.encoding = 'bgr8'
        img.step = w * 3
        img.data = frame.tobytes()
        self._pub_img.publish(img)

        info = CameraInfo()
        info.header.stamp = stamp
        info.header.frame_id = self._frame_id
        info.height, info.width = h, w
        fx = fy = float(w)  # грубая оценка пинхол-модели (~90° по горизонтали)
        info.k = [fx, 0.0, w / 2.0,
                  0.0, fy, h / 2.0,
                  0.0, 0.0, 1.0]
        info.p = [fx, 0.0, w / 2.0, 0.0,
                  0.0, fy, h / 2.0, 0.0,
                  0.0, 0.0, 1.0, 0.0]
        self._pub_info.publish(info)

    # ------------------------------------------------------------------ #
    def destroy_node(self):
        if self._cap is not None:
            self._cap.release()
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = CameraNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
