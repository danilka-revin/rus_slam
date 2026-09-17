#!/usr/bin/env python3
# -*- coding: utf-8 -*-

"""
@file crab_drive_node.py
@brief Узел ROS 2 для управления полноповоротным шасси с крабовым ходом (4WIS / 4WID)
       Робот-курьер внутренней логистики НТЦ АО «АВТОВАЗ»

Преобразует команды линейной и угловой скорости (cmd_vel: Vx, Vy, Wz)
в углы поворота колес (NEMA 23, редуктор GT2 1:7.5, шкивы 150/20) и обороты мотор-колес (BLDC 260W)
для 4 независимых плат на базе Arduino Mega Pro.
"""

import math
import struct
import serial
import rclpy
from rclpy.node import Node
from geometry_msgs.msg import Twist

def calc_crc16(data: bytes) -> int:
    """Вычисление контрольной суммы Modbus CRC16."""
    crc = 0xFFFF
    for byte in data:
        crc ^= byte
        for _ in range(8):
            if crc & 0x0001:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc

class CrabDriveController(Node):
    def __init__(self):
        super().__init__('crab_drive_controller')

        # Геометрические параметры шасси (метры)
        self.declare_parameter('wheelbase_L', 0.62)   # Продольное расстояние между осями
        self.declare_parameter('track_W', 0.50)       # Поперечное расстояние между колеями
        self.declare_parameter('wheel_radius_R', 0.127) # Радиус мотор-колеса 10 дюймов
        self.declare_parameter('max_linear_speed', 2.5) # Максимальная скорость, м/с

        self.L = self.get_parameter('wheelbase_L').value
        self.W = self.get_parameter('track_W').value
        self.R = self.get_parameter('wheel_radius_R').value
        self.max_v = self.get_parameter('max_linear_speed').value

        # Координаты 4 модулей относительно центра робота (FL, FR, RL, RR)
        self.modules = [
            {'id': 1, 'name': 'FL', 'x':  self.L / 2.0, 'y':  self.W / 2.0, 'last_angle': 0.0},
            {'id': 2, 'name': 'FR', 'x':  self.L / 2.0, 'y': -self.W / 2.0, 'last_angle': 0.0},
            {'id': 3, 'name': 'RL', 'x': -self.L / 2.0, 'y':  self.W / 2.0, 'last_angle': 0.0},
            {'id': 4, 'name': 'RR', 'x': -self.L / 2.0, 'y': -self.W / 2.0, 'last_angle': 0.0},
        ]

        # Инициализация последовательных портов для 4 модулей
        self.serial_ports = {}
        for mod in self.modules:
            port_name = f'/dev/ttyUSB{mod["id"] - 1}'
            try:
                ser = serial.Serial(port_name, 115200, timeout=0.05)
                self.serial_ports[mod['id']] = ser
                self.get_logger().info(f'Модуль {mod["name"]} (ID {mod["id"]}) подключен на {port_name}')
            except Exception as e:
                self.get_logger().warn(f'Не удалось открыть порт {port_name}: {e}. Работа в режиме симуляции.')
                self.serial_ports[mod['id']] = None

        # Подписка на топик cmd_vel от стека навигации Nav2
        self.sub_cmd_vel = self.create_subscription(
            Twist,
            '/cmd_vel',
            self.cmd_vel_callback,
            10
        )
        self.get_logger().info('Контроллер крабового хода 4WIS/4WID запущен и ожидает команды.')

    def optimize_steering_angle(self, target_angle: float, current_angle: float, speed: float):
        """
        Оптимизация угла поворота колеса:
        Если требуемый поворот больше 90 градусов, колесо разворачивается на (target_angle - 180°),
        а направление тяги инвертируется (минимизация времени перекладки курса).
        """
        diff = (target_angle - current_angle + math.pi) % (2 * math.pi) - math.pi
        if abs(diff) > math.pi / 2.0:
            diff = diff - math.pi if diff > 0 else diff + math.pi
            speed = -speed
        return current_angle + diff, speed

    def cmd_vel_callback(self, msg: Twist):
        vx = msg.linear.x
        vy = msg.linear.y
        wz = msg.angular.z

        # Пороговая фильтрация шума
        if abs(vx) < 0.01 and abs(vy) < 0.01 and abs(wz) < 0.01:
            for mod in self.modules:
                self.send_module_command(mod['id'], mod['last_angle'], 0.0, enable=False)
            return

        # Прямой расчет обратной кинематики для 4 колес
        speeds = []
        angles = []

        for mod in self.modules:
            # Линейные составляющие скорости для каждого колеса
            vx_i = vx - wz * mod['y']
            vy_i = vy + wz * mod['x']

            raw_speed = math.hypot(vx_i, vy_i)
            raw_angle = math.atan2(vy_i, vx_i)

            opt_angle, opt_speed = self.optimize_steering_angle(raw_angle, mod['last_angle'], raw_speed)
            mod['last_angle'] = opt_angle

            speeds.append(opt_speed)
            angles.append(opt_angle)

        # Нормализация скоростей, если одна из них превышает предел
        max_calc_speed = max(abs(s) for s in speeds) if speeds else 0.0
        scale = 1.0
        if max_calc_speed > self.max_v:
            scale = self.max_v / max_calc_speed

        # Отправка пакетов на каждый модуль
        for i, mod in enumerate(self.modules):
            speed = speeds[i] * scale
            angle_deg = math.degrees(angles[i])
            self.send_module_command(mod['id'], angle_deg, speed, enable=True)

    def send_module_command(self, module_id: int, angle_deg: float, speed_m_s: float, enable: bool):
        """Упаковка и передача бинарного пакета управления по протоколу CRC16."""
        # Перевод угла в сотые доли градуса
        steer_param = int(angle_deg * 100.0)
        steer_param = max(-32767, min(32767, steer_param))

        # Перевод скорости в значение ШИМ от -1000 до +1000
        pwm_val = int((speed_m_s / self.max_v) * 1000.0) if self.max_v > 0 else 0
        pwm_val = max(-1000, min(1000, pwm_val))

        flags = 0x01 if enable else 0x00

        # Заголовок + данные пакета (8 байт)
        payload = struct.pack('>BBhhB', 0xAA, 0x55, module_id, steer_param, pwm_val, flags)
        # 16-битная контрольная сумма
        crc = calc_crc16(payload)
        packet = payload + struct.pack('>H', crc)

        ser = self.serial_ports.get(module_id)
        if ser and ser.is_open:
            try:
                ser.write(packet)
            except Exception as e:
                self.get_logger().error(f'Ошибка передачи данных в модуль {module_id}: {e}')

def main(args=None):
    rclpy.init(args=args)
    controller = CrabDriveController()
    try:
        rclpy.spin(controller)
    except KeyboardInterrupt:
        pass
    finally:
        controller.destroy_node()
        rclpy.shutdown()

if __name__ == '__main__':
    main()
