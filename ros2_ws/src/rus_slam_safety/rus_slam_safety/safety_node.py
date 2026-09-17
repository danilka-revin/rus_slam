# -*- coding: utf-8 -*-
"""
Узел безопасности — гейт скоростей робота.

Подписка:
  /cmd_vel_nav     (Twist)          — от стека навигации (или телеуправления);
  /modules/state   (ModuleStateArray) — здоровье модулей;
  /battery         (BatteryInfo)    — напряжение тяговой АКБ;
  /e_stop          (Bool)           — внешний аварийный стоп (кнопка/пульт);
  /safety/speed_limit (Float32)     — коэффициент 0..1 от менеджера миссии.
Издание:
  /cmd_vel         (Twist)          — очищенная команда на кинематику;
  /safety/status   (String)         — состояние безопасности (2 Гц);
  /safety/e_stop_active (Bool)      — для световой/звуковой сигнализации.

Политика: робот останавливается при потере телеметрии модулей, внешнем
аварийном стопе, неисправности модуля или критической просадке АКБ; при
низком напряжении переходит в ползущий режим.
"""

import time

import rclpy
from geometry_msgs.msg import Twist
from rclpy.node import Node
from rus_slam_interfaces.msg import BatteryInfo, ModuleStateArray
from std_msgs.msg import Bool, Float32, String

STATUS_OK = 'OK'
STATUS_E_STOP = 'E_STOP'
STATUS_NO_MODULES = 'NO_MODULES'
STATUS_BATTERY_CRITICAL = 'BATTERY_CRITICAL'
STATUS_BATTERY_LOW = 'BATTERY_LOW'
STATUS_MODULE_FAULT = 'MODULE_FAULT'

STOP_STATUSES = (STATUS_E_STOP, STATUS_NO_MODULES, STATUS_BATTERY_CRITICAL,
                 STATUS_MODULE_FAULT)


class SafetyNode(Node):

    def __init__(self):
        super().__init__('safety_node')

        self.declare_parameter('modules_required', 4)
        self.declare_parameter('comms_timeout_sec', 0.6)
        self.declare_parameter('battery_low_v', 35.5)
        self.declare_parameter('battery_critical_v', 33.5)
        self.declare_parameter('battery_stale_sec', 6.0)
        self.declare_parameter('creep_limit', 0.2)
        self.declare_parameter('publish_rate_hz', 20.0)

        self._modules_required = self.get_parameter('modules_required').value
        self._comms_timeout = self.get_parameter('comms_timeout_sec').value
        self._bat_low = self.get_parameter('battery_low_v').value
        self._bat_crit = self.get_parameter('battery_critical_v').value
        self._bat_stale = self.get_parameter('battery_stale_sec').value
        self._creep = self.get_parameter('creep_limit').value

        self._last_cmd = Twist()
        self._last_cmd_rx = 0.0
        self._cmd_timeout = self._comms_timeout

        self._state_rx = 0.0
        self._state_ok = False
        self._state_fault_ids = []

        self._battery_v = None
        self._battery_rx = 0.0

        self._e_stop = False
        self._mission_limit = 1.0

        self._pub_cmd = self.create_publisher(Twist, '/cmd_vel', 10)
        self._pub_status = self.create_publisher(String, '/safety/status', 10)
        self._pub_estop = self.create_publisher(Bool, '/safety/e_stop_active',
                                                10)

        self.create_subscription(Twist, '/cmd_vel_nav', self._on_cmd, 10)
        self.create_subscription(ModuleStateArray, '/modules/state',
                                 self._on_state, 10)
        self.create_subscription(BatteryInfo, '/battery', self._on_battery, 10)
        self.create_subscription(Bool, '/e_stop', self._on_estop, 10)
        self.create_subscription(Float32, '/safety/speed_limit',
                                 self._on_limit, 10)

        rate = self.get_parameter('publish_rate_hz').value
        self.create_timer(1.0 / rate, self._tick)
        self.create_timer(0.5, self._publish_status)
        self.get_logger().info('Гейт безопасности запущен: '
                               '/cmd_vel_nav -> /cmd_vel')

    # ------------------------------ подписки ------------------------------- #
    def _on_cmd(self, msg: Twist):
        self._last_cmd = msg
        self._last_cmd_rx = time.monotonic()

    def _on_state(self, msg: ModuleStateArray):
        now = time.monotonic()
        self._state_rx = now
        ids = set()
        faults = []
        for st in msg.states:
            ids.add(st.module_id)
            if st.fault:
                faults.append(st.module_id)
        self._state_fault_ids = faults
        self._state_ok = len(ids) >= self._modules_required

    def _on_battery(self, msg: BatteryInfo):
        self._battery_v = msg.voltage
        self._battery_rx = time.monotonic()

    def _on_estop(self, msg: Bool):
        if msg.data and not self._e_stop:
            self.get_logger().error('ВНЕШНИЙ АВАРИЙНЫЙ СТОП АКТИВИРОВАН')
        self._e_stop = msg.data

    def _on_limit(self, msg: Float32):
        self._mission_limit = max(0.0, min(1.0, msg.data))

    # ------------------------------ логика --------------------------------- #
    def _evaluate(self) -> str:
        now = time.monotonic()
        if self._e_stop:
            return STATUS_E_STOP
        if now - self._state_rx > self._comms_timeout:
            return STATUS_NO_MODULES
        if self._state_fault_ids:
            return STATUS_MODULE_FAULT
        if self._battery_v is not None:
            age = now - self._battery_rx
            if age < self._bat_stale:
                if self._battery_v < self._bat_crit:
                    return STATUS_BATTERY_CRITICAL
                if self._battery_v < self._bat_low:
                    return STATUS_BATTERY_LOW
        if not self._state_ok:
            return STATUS_NO_MODULES
        return STATUS_OK

    def _tick(self):
        status = self._evaluate()
        cmd = Twist()
        if status not in STOP_STATUSES:
            now = time.monotonic()
            if now - self._last_cmd_rx < self._cmd_timeout:
                cmd = self._last_cmd
            limit = self._mission_limit
            if status == STATUS_BATTERY_LOW:
                limit = min(limit, self._creep)
            cmd.linear.x *= limit
            cmd.linear.y *= limit
            cmd.angular.z *= limit
        self._pub_cmd.publish(cmd)

    def _publish_status(self):
        status = self._evaluate()
        self._pub_status.publish(String(data=status))
        self._pub_estop.publish(Bool(data=(status in STOP_STATUSES)))


def main(args=None):
    rclpy.init(args=args)
    node = SafetyNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
