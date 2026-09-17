# -*- coding: utf-8 -*-
"""
Разбор кадров кругового UART-лидара семейства ЛДС-01.

По умолчанию реализован кадр, совместимый с компактными лидарами
семейства LDS/LD06:

    [0x54][VER_LEN][SPEED u16][ANGLE_START u16]
    [N × (DIST_MM u16, INTENSITY u8)]
    [ANGLE_END u16][TIMESTAMP u16][CHECKSUM]

где N = (VER_LEN − 8) / 3 (12 точек при VER_LEN=0x2C), углы в сотых долях
градуса, CHECKSUM = XOR всех предыдущих байтов кадра.

Параметры кадра вынесены в конструктор — после получения паспорта
конкретного экземпляра ЛДС-01 значения уточняются в конфиге `lidar.yaml`.
"""

from dataclasses import dataclass
from typing import List, Tuple


@dataclass
class LidarFrame:
    speed_dps: float                       # скорость вращения, град/с
    start_angle_deg: float
    end_angle_deg: float
    points: List[Tuple[float, int]]        # (дистанция, м; интенсивность)


class LdsParser:
    """Потоковый разбор кадров лидара с повторной синхронизацией."""

    def __init__(self, sync_byte: int = 0x54, ver_len: int = 0x2C):
        self.sync_byte = sync_byte
        self.ver_len = ver_len
        self.points_per_frame = max(0, (ver_len - 8) // 3)
        # Заголовок 6 байт + точки + конец угла 2 + таймстамп 2 + КС 1
        self.frame_len = 6 + self.points_per_frame * 3 + 5
        self._buf = bytearray()
        self.checksum_errors = 0

    def feed(self, data: bytes) -> List[LidarFrame]:
        self._buf.extend(data)
        frames: List[LidarFrame] = []
        while True:
            try:
                idx = self._buf.index(self.sync_byte)
            except ValueError:
                self._buf.clear()
                break
            if idx > 0:
                del self._buf[:idx]
            if len(self._buf) < self.frame_len:
                break
            if self._buf[1] != self.ver_len:
                del self._buf[:1]
                continue
            packet = bytes(self._buf[:self.frame_len])
            if self._checksum_ok(packet):
                frames.append(self._unpack(packet))
                del self._buf[:self.frame_len]
            else:
                self.checksum_errors += 1
                del self._buf[:1]
        return frames

    # ------------------------------------------------------------------ #
    @staticmethod
    def _checksum_ok(packet: bytes) -> bool:
        xor = 0
        for b in packet[:-1]:
            xor ^= b
        return (xor & 0xFF) == packet[-1]

    def _unpack(self, p: bytes) -> LidarFrame:
        # Скорость и углы кодируются в сотых долях градуса
        speed = (p[2] | (p[3] << 8)) / 100.0
        start = (p[4] | (p[5] << 8)) / 100.0
        points = []
        off = 6
        for _ in range(self.points_per_frame):
            dist_mm = p[off] | (p[off + 1] << 8)
            intensity = p[off + 2]
            points.append((dist_mm / 1000.0, intensity))
            off += 3
        end = (p[off] | (p[off + 1] << 8)) / 100.0
        return LidarFrame(speed_dps=speed, start_angle_deg=start,
                          end_angle_deg=end, points=points)
