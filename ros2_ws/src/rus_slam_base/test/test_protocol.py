# -*- coding: utf-8 -*-
"""Модульные тесты протокола обмена с контроллерами модулей."""

import struct

from rus_slam_base import protocol


def test_crc16_modbus_reference_vector():
    # Эталонный вектор для CRC16/Modbus
    assert protocol.crc16(b'123456789') == 0x4B37


def test_command_packet_layout():
    packet = protocol.build_command_packet(module_id=1, steer_cdeg=4500,
                                           pwm=500, enable=True)
    assert len(packet) == protocol.CMD_PACKET_LEN
    assert packet[0] == 0xAA and packet[1] == 0x55
    assert packet[2] == 1
    assert struct.unpack('>h', packet[3:5])[0] == 4500
    assert struct.unpack('>h', packet[5:7])[0] == 500
    assert packet[7] == protocol.FLAG_ENABLE
    crc = struct.unpack('>H', packet[8:10])[0]
    assert crc == protocol.crc16(packet[:8])


def test_command_packet_clamps():
    packet = protocol.build_command_packet(module_id=2, steer_cdeg=10**6,
                                           pwm=10**6, enable=False)
    steer = struct.unpack('>h', packet[3:5])[0]
    pwm = struct.unpack('>h', packet[5:7])[0]
    assert steer == protocol.MAX_STEER_CDEG
    assert pwm == protocol.MAX_PWM
    assert packet[7] == 0


def test_home_flag():
    packet = protocol.build_command_packet(1, 0, 0, enable=True, home=True)
    assert packet[7] == protocol.FLAG_ENABLE | protocol.FLAG_HOME


def test_telemetry_roundtrip_single():
    packet = protocol.build_telemetry_packet(
        module_id=3, status=protocol.STATUS_ENABLED | protocol.STATUS_HOMED,
        steer_cdeg=-1234, enc_delta=-57, pwm_actual=780,
        vbat_cv=3840, current_ma=4321)
    frames = protocol.TelemetryParser().feed(packet)
    assert len(frames) == 1
    f = frames[0]
    assert f.module_id == 3
    assert f.enabled and f.homed and not f.fault
    assert f.steer_cdeg == -1234
    assert f.enc_delta == -57
    assert f.pwm_actual == 780
    assert f.vbat_cv == 3840
    assert f.current_ma == 4321
    assert abs(f.vbat_v - 38.4) < 1e-6


def test_telemetry_parser_resyncs_after_garbage():
    good = protocol.build_telemetry_packet(2, 0, 100, 5, 0, 3840, 100)
    stream = b'\x00\xff\x13\xbb\x55garbage' + good + good
    frames = protocol.TelemetryParser().feed(stream)
    assert len(frames) == 2
    assert all(f.module_id == 2 for f in frames)


def test_telemetry_parser_split_delivery():
    good = protocol.build_telemetry_packet(4, 1, 0, 0, 0, 3840, 0)
    parser = protocol.TelemetryParser()
    assert parser.feed(good[:5]) == []
    frames = parser.feed(good[5:])
    assert len(frames) == 1
    assert frames[0].module_id == 4


def test_telemetry_parser_drops_corrupted_crc():
    good = protocol.build_telemetry_packet(1, 0, 0, 0, 0, 3840, 0)
    bad = bytearray(good)
    bad[-1] ^= 0xFF
    parser = protocol.TelemetryParser()
    frames = parser.feed(bytes(bad) + good)
    assert len(frames) == 1
    assert parser.crc_errors >= 1
