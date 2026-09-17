# -*- coding: utf-8 -*-
"""Общие утилиты машинного зрения (мягкая зависимость от OpenCV)."""

from typing import Optional


def try_import_cv2():
    """Импортирует cv2; возвращает None, если библиотека не установлена."""
    try:
        import cv2  # noqa: F401
        return cv2
    except Exception:  # noqa: BLE001
        return None


def image_msg_to_bgr(msg):
    """Преобразует sensor_msgs/Image (rgb8/bgr8) в массив cv2 (BGR)."""
    import numpy as np
    if msg.encoding not in ('rgb8', 'bgr8'):
        return None
    arr = np.frombuffer(msg.data, dtype=np.uint8)
    try:
        img = arr.reshape(msg.height, msg.width, 3)
    except ValueError:
        return None
    if msg.encoding == 'rgb8':
        return img[:, :, ::-1].copy()
    return img.copy()


def polygon_sides(cv2, contour, epsilon_scale: float = 0.03) -> int:
    """Число сторон приближающего многоугольника контура."""
    peri = cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, epsilon_scale * peri, True)
    return len(approx)
