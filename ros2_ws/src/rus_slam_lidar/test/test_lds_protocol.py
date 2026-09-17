# -*- coding: utf-8 -*-
"""Тесты парсера кадров лидара."""

from rus_slam_lidar.lds_protocol import LdsParser


def _build_frame(points, start_cdeg=0, end_cdeg=3000, speed_cdeg=36000):
    body = bytearray()
    body.append(0x54)
    body.append(0x2C)  # 12 точек
    body += (speed_cdeg & 0xFFFF).to_bytes(2, 'little')
    body += (start_cdeg & 0xFFFF).to_bytes(2, 'little')
    for dist_m, intensity in points:
        body += (int(dist_m * 1000) & 0xFFFF).to_bytes(2, 'little')
        body.append(intensity & 0xFF)
    body += (end_cdeg & 0xFFFF).to_bytes(2, 'little')
    body.append(0x00)  # timestamp
    body.append(0x00)
    xor = 0
    for b in body:
        xor ^= b
    body.append(xor & 0xFF)
    return bytes(body)


def test_single_frame():
    pts = [(0.5 + 0.01 * i, 200) for i in range(12)]
    frame = _build_frame(pts)
    frames = LdsParser().feed(frame)
    assert len(frames) == 1
    f = frames[0]
    assert len(f.points) == 12
    assert abs(f.start_angle_deg - 0.0) < 1e-6
    assert abs(f.end_angle_deg - 30.0) < 1e-6
    assert abs(f.speed_dps - 360.0) < 1e-6
    assert abs(f.points[0][0] - 0.5) < 1e-6


def test_split_and_garbage():
    pts = [(1.0, 100)] * 12
    good = _build_frame(pts)
    stream = b'\x00\x54\x11junk' + good[:10]
    parser = LdsParser()
    assert parser.feed(stream) == []
    frames = parser.feed(good[10:] + good)
    assert len(frames) == 2


def test_bad_checksum_rejected():
    pts = [(1.0, 100)] * 12
    good = bytearray(_build_frame(pts))
    good[-1] ^= 0xFF
    frames = LdsParser().feed(bytes(good))
    assert frames == []
