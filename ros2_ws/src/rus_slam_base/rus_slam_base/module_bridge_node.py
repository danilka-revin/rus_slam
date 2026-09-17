# -*- coding: utf-8 -*-
"""
Мост обмена с 4 контроллерами поворотно-тяговых модулей (Arduino Mega Pro).

Подписка:  /wheel_commands (WheelCommandArray) — от узла кинематики.
Издание:   /modules/state (ModuleStateArray, 20 Гц) — телеметрия модулей;
           /battery (BatteryInfo, 1 Гц) — сводка по тяговой батарее.
Сервисы:   /home_modules (HomeModules) — поиск нулевого азимута;
           /modules/enable (SetModulesEnabled) — подача/снятие момента.

Команды транслируются в кадры протокола (см. docs/SERIAL_PROTOCOL.md) со
скоростью 20 Гц (прошивка требует пакет не реже, чем раз в 300 мс).
При отсутствии порта модуль автоматически переводится в режим симуляции —
весь остальной стек работает без железа.
"""

import math
import threading
import time

import rclpy
from rclpy.duration import Duration
from rclpy.node import Node
from rus_slam_interfaces.msg import (BatteryInfo, ModuleState,
                                     ModuleStateArray, WheelCommandArray)
from rus_slam_interfaces.srv import HomeModules, SetModulesEnabled

from . import protocol
from .module_link import SimulatedModule, open_port

MODULE_IDS = (protocol.MODULE_FL, protocol.MODULE_FR,
              protocol.MODULE_RL, protocol.MODULE_RR)
NAME_BY_ID = {1: 'fl', 2: 'fr', 3: 'rl', 4: 'rr'}


class ModuleBridgeNode(Node):

    def __init__(self):
        super().__init__('module_bridge_node')

        # ----------------------------- параметры ----------------------------- #
        self.declare_parameter('baud_rate', 115200)
        self.declare_parameter('sim', False)             # полная симуляция
        self.declare_parameter('sim_on_fail', True)      # симуляция при недоступном порте
        self.declare_parameter('max_speed_mps', 2.0)     # соответствует ШИМ 1000
        self.declare_parameter('wheel_radius_m', 0.127)
        self.declare_parameter('encoder_ticks_per_rev', 120.0)
        self.declare_parameter('telemetry_rate_hz', 20.0)
        self.declare_parameter('command_watchdog_sec', 0.5)
        self.declare_parameter('stale_telemetry_sec', 1.0)
        for mid in MODULE_IDS:
            self.declare_parameter(f'port_{NAME_BY_ID[mid]}',
                                   f'/dev/rus_module_{NAME_BY_ID[mid]}')

        self._max_speed = self.get_parameter('max_speed_mps').value
        self._radius = self.get_parameter('wheel_radius_m').value
        self._ticks = self.get_parameter('encoder_ticks_per_rev').value
        self._cmd_watchdog = self.get_parameter('command_watchdog_sec').value
        self._stale_sec = self.get_parameter('stale_telemetry_sec').value
        force_sim = self.get_parameter('sim').value
        sim_on_fail = self.get_parameter('sim_on_fail').value

        # ------------------------------- состояние --------------------------- #
        self._lock = threading.Lock()
        self._links = {}          # mid -> serial.Serial | None
        self._sims = {}           # mid -> SimulatedModule | None
        self._parsers = {mid: protocol.TelemetryParser() for mid in MODULE_IDS}
        self._frames = {}         # mid -> (TelemetryFrame, monotonic_time)
        self._last_commands = {}  # mid -> (steer_cdeg, pwm, enable)
        self._last_cmd_rx = 0.0
        self._pending_home = {}   # mid -> monotonic deadline
        self._enable_override = {mid: True for mid in MODULE_IDS}
        self._running = True

        for mid in MODULE_IDS:
            port = self.get_parameter(f'port_{NAME_BY_ID[mid]}').value
            if force_sim:
                self._sims[mid] = SimulatedModule(module_id=mid,
                                                  max_speed_mps=self._max_speed)
                self.get_logger().info(f'Модуль {NAME_BY_ID[mid]}: режим симуляции')
                continue
            try:
                self._links[mid] = open_port(port,
                                             self.get_parameter('baud_rate').value)
                self.get_logger().info(
                    f'Модуль {NAME_BY_ID[mid]} (ID {mid}) подключен: {port}')
                t = threading.Thread(target=self._reader, args=(mid,),
                                     daemon=True)
                t.start()
            except Exception as exc:  # noqa: BLE001
                if sim_on_fail:
                    self._sims[mid] = SimulatedModule(
                        module_id=mid, max_speed_mps=self._max_speed)
                    self.get_logger().warn(
                        f'Порт {port} недоступен ({exc}). '
                        f'Модуль {NAME_BY_ID[mid]} переведен в симуляцию.')
                else:
                    self._links[mid] = None
                    self.get_logger().error(
                        f'Порт {port} недоступен ({exc}). Модуль отключен.')

        # ------------------------------ коммуникация ------------------------- #
        self._pub_state = self.create_publisher(ModuleStateArray,
                                                '/modules/state', 10)
        self._pub_battery = self.create_publisher(BatteryInfo, '/battery', 10)
        self.create_subscription(WheelCommandArray, '/wheel_commands',
                                 self._on_commands, 10)
        self.create_service(HomeModules, '/home_modules', self._srv_home)
        self.create_service(SetModulesEnabled, '/modules/enable',
                            self._srv_enable)

        rate = self.get_parameter('telemetry_rate_hz').value
        self._cycle_dt = 1.0 / rate
        self.create_timer(self._cycle_dt, self._cycle)
        self._battery_div = 0
        self.get_logger().info('Мост модулей запущен (протокол: '
                               'команды 10 Б, телеметрия 16 Б, CRC16/Modbus).')

    # ------------------------------ подписки/сервисы ------------------------ #
    def _on_commands(self, msg: WheelCommandArray):
        now = time.monotonic()
        with self._lock:
            self._last_cmd_rx = now
            for cmd in msg.commands:
                steer_cdeg = int(round(math.degrees(cmd.steer_angle) * 100.0))
                if self._max_speed > 0:
                    pwm = int(round(cmd.drive_speed / self._max_speed
                                    * protocol.MAX_PWM))
                else:
                    pwm = 0
                pwm = max(-protocol.MAX_PWM, min(protocol.MAX_PWM, pwm))
                self._last_commands[cmd.module_id] = (steer_cdeg, pwm,
                                                      cmd.enable)

    def _srv_home(self, req: HomeModules, rsp: HomeModules.Response):
        ids = req.module_ids if req.module_ids else list(MODULE_IDS)
        with self._lock:
            for mid in ids:
                self._pending_home[mid] = time.monotonic() + 1.0
        rsp.success = True
        rsp.message = f'Хоминг запущен для модулей: {sorted(ids)}'
        self.get_logger().info(rsp.message)
        return rsp

    def _srv_enable(self, req: SetModulesEnabled,
                    rsp: SetModulesEnabled.Response):
        ids = req.module_ids if req.module_ids else list(MODULE_IDS)
        with self._lock:
            for mid in ids:
                self._enable_override[mid] = req.enable
        rsp.success = True
        rsp.message = f'enable={req.enable} для модулей: {sorted(ids)}'
        self.get_logger().info(rsp.message)
        return rsp

    # ------------------------------ цикл 20 Гц ------------------------------ #
    def _cycle(self):
        now = time.monotonic()
        fresh_commands = (now - self._last_cmd_rx) < self._cmd_watchdog

        for mid in MODULE_IDS:
            if fresh_commands and mid in self._last_commands:
                steer_cdeg, pwm, enable = self._last_commands[mid]
            else:
                steer_cdeg, pwm, enable = 0, 0, False
            enable = enable and self._enable_override[mid]
            home = self._pending_home.get(mid, 0.0) > now
            packet = protocol.build_command_packet(mid, steer_cdeg, pwm,
                                                   enable, home)

            sim = self._sims.get(mid)
            if sim is not None:
                sim.feed_command(steer_cdeg, pwm, enable, home)
                frame = sim.step(self._cycle_dt, self._radius, self._ticks)
                with self._lock:
                    self._frames[mid] = (frame, now)
            else:
                link = self._links.get(mid)
                if link is not None:
                    try:
                        link.write(packet)
                    except Exception as exc:  # noqa: BLE001
                        self.get_logger().error(
                            f'Ошибка записи в модуль {mid}: {exc}',
                            throttle_duration_sec=5.0)

        self._publish_state(now)
        self._battery_div += 1
        if self._battery_div >= 20:  # 1 Гц при 20 Гц цикла
            self._battery_div = 0
            self._publish_battery(now)

    # ------------------------------- издания -------------------------------- #
    def _publish_state(self, now: float):
        msg = ModuleStateArray()
        stamp = self.get_clock().now()
        msg.header.stamp = stamp.to_msg()
        msg.header.frame_id = 'base_link'
        with self._lock:
            for mid in MODULE_IDS:
                item = self._frames.get(mid)
                if item is None:
                    continue
                frame, rx_time = item
                st = ModuleState()
                age = now - rx_time
                # Метка времени — момент приема кадра от модуля:
                # по ней узлы видят, насколько данные свежие
                st.header.stamp = (stamp - Duration(seconds=age)).to_msg()
                st.header.frame_id = 'base_link'
                st.module_id = mid
                st.enabled = frame.enabled
                st.homed = frame.homed
                st.fault = frame.fault or age >= self._stale_sec
                st.steer_angle = frame.steer_rad
                st.wheel_speed = (frame.enc_delta
                                  * 2.0 * math.pi * self._radius
                                  / max(self._ticks, 1.0) / self._cycle_dt)
                st.battery_voltage = frame.vbat_v
                st.current = frame.current_a
                msg.states.append(st)
        self._pub_state.publish(msg)

    def _publish_battery(self, now: float):
        voltages, currents = [], []
        with self._lock:
            for mid, (frame, rx_time) in self._frames.items():
                if now - rx_time < self._stale_sec:
                    voltages.append(frame.vbat_v)
                    currents.append(frame.current_a)
        if not voltages:
            return
        voltage = max(voltages)
        msg = BatteryInfo()
        msg.header.stamp = self.get_clock().now().to_msg()
        msg.voltage = voltage
        msg.current = sum(currents)
        # Оценка SOC по напряжению 12S LiFePO4: 33.0 В пусто, 42.0 В полно
        msg.soc_percent = max(0.0, min(100.0,
                                       (voltage - 33.0) / (42.0 - 33.0) * 100.0))
        if voltage >= 36.0:
            msg.level = 3
        elif voltage >= 34.5:
            msg.level = 2
        elif voltage >= 33.0:
            msg.level = 1
        else:
            msg.level = 0
        self._pub_battery.publish(msg)

    # --------------------------- поток чтения UART --------------------------- #
    def _reader(self, mid: int):
        link = self._links[mid]
        parser = self._parsers[mid]
        while self._running and rclpy.ok():
            try:
                data = link.read(128)
            except Exception as exc:  # noqa: BLE001
                self.get_logger().error(
                    f'Ошибка чтения модуля {mid}: {exc}',
                    throttle_duration_sec=5.0)
                time.sleep(0.1)
                continue
            if not data:
                continue
            for frame in parser.feed(data):
                with self._lock:
                    self._frames[frame.module_id] = (frame, time.monotonic())

    # --------------------------------- выход --------------------------------- #
    def destroy_node(self):
        self._running = False
        for link in self._links.values():
            if link is not None:
                try:
                    link.close()
                except Exception:  # noqa: BLE001
                    pass
        super().destroy_node()


def main(args=None):
    rclpy.init(args=args)
    node = ModuleBridgeNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
