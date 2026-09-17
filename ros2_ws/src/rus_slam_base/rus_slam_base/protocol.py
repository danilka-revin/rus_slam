# -*- coding: utf-8 -*-
"""
Протокол обмена бортового ПК с контроллерами поворотно-тяговых модулей
(4× Arduino Mega Pro). Полное описание — в docs/SERIAL_PROTOCOL.md.

Кадр команды  (ПК -> МК): 10 байт, заголовок 0xAA 0x55
Кадр телеметрии (МК -> ПК): 16 байт, заголовок 0xBB 0x44, 20 Гц
Контрольная сумма: CRC16/Modbus, байты в порядке big-endian.

Модуль написан на чистом Python без ROS-зависимостей — используется и в узлах,
и в модульных тестах.
"""

import struct
from dataclasses import dataclass

# Заголовки кадров
CMD_SYNC0, CMD_SYNC1 = 0xAA, 0x55
TLM_SYNC0, TLM_SYNC1 = 0xBB, 0x44

# Размеры кадров
CMD_PACKET_LEN = 10
TLM_PACKET_LEN = 16

# Флаги байта FLAGS кадра команды
FLAG_ENABLE = 0x01   # подать момент на приводы
FLAG_HOME = 0x02     # запуск процедуры хоминга (поиск нулевого азимута)

# Флаги байта STATUS кадра телеметрии
STATUS_ENABLED = 0x01
STATUS_HOMED = 0x02
STATUS_FAULT = 0x04

# Диапазоны кодирования
MAX_PWM = 1000             # ШИМ тяги: −1000..+1000
MAX_STEER_CDEG = 32767     # угол в сотых долях градуса

# Идентификаторы модулей
MODULE_FL, MODULE_FR, MODULE_RL, MODULE_RR = 1, 2, 3, 4
MODULE_NAMES = {MODULE_FL: 'FL', MODULE_FR: 'FR', MODULE_RL: 'RL', MODULE_RR: 'RR'}


def crc16(data: bytes) -> int:
    """Контрольная сумма CRC16/Modbus (полином 0xA001, init 0xFFFF)."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x0001:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc


def build_command_packet(module_id: int, steer_cdeg: int, pwm: int,
                         enable: bool, home: bool = False) -> bytes:
    """Сборка кадра команды (10 байт).

    :param module_id: ID модуля 1..4
    :param steer_cdeg: целевой угол, сотые доли градуса
    :param pwm: задание тяги −1000..+1000
    :param enable: подать момент
    :param home: запустить хоминг
    """
    steer_cdeg = max(-MAX_STEER_CDEG, min(MAX_STEER_CDEG, int(steer_cdeg)))
    pwm = max(-MAX_PWM, min(MAX_PWM, int(pwm)))
    flags = 0
    if enable:
        flags |= FLAG_ENABLE
    if home:
        flags |= FLAG_HOME
    payload = struct.pack('>BBBhhB', CMD_SYNC0, CMD_SYNC1,
                          module_id & 0xFF, steer_cdeg, pwm, flags)
    return payload + struct.pack('>H', crc16(payload))


@dataclass
class TelemetryFrame:
    """Распакованный кадр телеметрии модуля."""
    module_id: int
    status: int
    steer_cdeg: int       # фактический угол, 0.01 градуса
    enc_delta: int        # приращение тиков энкодера с прошлого кадра
    pwm_actual: int       # фактическая скважность тяги
    vbat_cv: int          # напряжение шины, сантиВольты
    current_ma: int       # ток мотор-колеса, мА

    @property
    def enabled(self) -> bool:
        return bool(self.status & STATUS_ENABLED)

    @property
    def homed(self) -> bool:
        return bool(self.status & STATUS_HOMED)

    @property
    def fault(self) -> bool:
        return bool(self.status & STATUS_FAULT)

    @property
    def steer_rad(self) -> float:
        import math
        return math.radians(self.steer_cdeg / 100.0)

    @property
    def vbat_v(self) -> float:
        return self.vbat_cv / 100.0

    @property
    def current_a(self) -> float:
        return self.current_ma / 1000.0


class TelemetryParser:
    """Потоковый парсер кадров телеметрии.

    Устойчив к рассинхронизации: ищет заголовок 0xBB 0x44 побайтно,
    при неверной CRC кадр отбрасывается, поиск продолжается со следующего байта.
    """

    def __init__(self):
        self._buf = bytearray()
        self.crc_errors = 0

    def feed(self, data: bytes):
        """Подать принятые байты; вернуть список полных кадров."""
        self._buf.extend(data)
        frames = []
        while True:
            # Поиск заголовка
            idx = self._find_sync()
            if idx < 0:
                # Оставляем возможный частичный заголовок (1 байт)
                del self._buf[:max(0, len(self._buf) - 1)]
                break
            if idx > 0:
                del self._buf[:idx]
            if len(self._buf) < TLM_PACKET_LEN:
                break  # ждем остальные байты
            packet = bytes(self._buf[:TLM_PACKET_LEN])
            crc_recv = (packet[14] << 8) | packet[15]
            if crc_recv == crc16(packet[:14]):
                frames.append(self._unpack(packet))
                del self._buf[:TLM_PACKET_LEN]
            else:
                self.crc_errors += 1
                del self._buf[:2]  # пропускаем фальшивый заголовок
        return frames

    def _find_sync(self) -> int:
        for i in range(len(self._buf) - 1):
            if self._buf[i] == TLM_SYNC0 and self._buf[i + 1] == TLM_SYNC1:
                return i
        return -1

    @staticmethod
    def _unpack(packet: bytes) -> TelemetryFrame:
        _, _, module_id, status, steer_cdeg, enc_delta, pwm_actual, \
            vbat_cv, current_ma = struct.unpack('>BBBBhhhHH', packet[:14])
        return TelemetryFrame(
            module_id=module_id,
            status=status,
            steer_cdeg=steer_cdeg,
            enc_delta=enc_delta,
            pwm_actual=pwm_actual,
            vbat_cv=vbat_cv,
            current_ma=current_ma,
        )


def build_telemetry_packet(module_id: int, status: int, steer_cdeg: int,
                           enc_delta: int, pwm_actual: int, vbat_cv: int,
                           current_ma: int) -> bytes:
    """Сборка кадра телеметрии (16 байт).

    Используется прошивкой (логика зеркальна) и симулятором модулей.
    """
    payload = struct.pack('>BBBBhhhHH', TLM_SYNC0, TLM_SYNC1,
                          module_id & 0xFF, status & 0xFF,
                          int(steer_cdeg), int(enc_delta), int(pwm_actual),
                          int(vbat_cv) & 0xFFFF, int(current_ma) & 0xFFFF)
    return payload + struct.pack('>H', crc16(payload))
