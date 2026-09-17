# -*- coding: utf-8 -*-
"""
Менеджер миссии — конечный автомат доставки.

Состояния:
  BOOT    — ожидание готовности стека безопасности;
  HOMING  — поиск нулевого азимута всех модулей;
  READY   — пауза перед стартом маршрута;
  DELIVER — последовательный обход точек через Nav2 NavigateToPose;
  DONE    — маршрут завершен;
  FAULT   — аварийное состояние стека (лимит скорости 0, ожидание
            восстановления и продолжение с текущей точки).

Реакции на восприятие:
  красный светофор  → лимит 0 до зеленого;
  знак «Стоп»       → полная остановка на stop_hold_sec;
  «Искусственная неровность» → лимит 0.3 на slowdown_hold_sec.
"""

import time

import rclpy
from nav2_msgs.action import NavigateToPose
from geometry_msgs.msg import PoseStamped
from rclpy.action import ActionClient
from rclpy.node import Node
from rus_slam_interfaces.msg import SignDetectionArray, TrafficLightState
from rus_slam_interfaces.srv import HomeModules
from std_msgs.msg import Float32, String

BOOT, HOMING, READY, DELIVER, DONE, FAULT = \
    'BOOT', 'HOMING', 'READY', 'DELIVER', 'DONE', 'FAULT'


class MissionManagerNode(Node):

    def __init__(self):
        super().__init__('mission_manager_node')

        # Точки маршрута: список [{x, y, yaw}, ...] из конфигурации
        self.declare_parameter('waypoints', [])
        self.declare_parameter('start_delay_sec', 3.0)
        self.declare_parameter('stop_hold_sec', 3.0)
        self.declare_parameter('slowdown_limit', 0.3)
        self.declare_parameter('slowdown_hold_sec', 5.0)
        self.declare_parameter('goal_timeout_sec', 300.0)

        self._waypoints = self.get_parameter('waypoints').value
        self._start_delay = self.get_parameter('start_delay_sec').value
        self._stop_hold = self.get_parameter('stop_hold_sec').value
        self._slow_limit = self.get_parameter('slowdown_limit').value
        self._slow_hold = self.get_parameter('slowdown_hold_sec').value
        self._goal_timeout = self.get_parameter('goal_timeout_sec').value

        self._state = BOOT
        self._wp_index = 0
        self._limit = 1.0
        self._limit_until = 0.0
        self._red_light = False
        self._state_entered = time.monotonic()
        self._home_future = None
        self._goal_handle = None
        self._result_future = None
        self._goal_sent = 0.0
        self._last_status = ''

        self._pub_limit = self.create_publisher(Float32,
                                                '/safety/speed_limit', 10)
        self.create_subscription(String, '/safety/status',
                                 self._on_safety, 10)
        self.create_subscription(SignDetectionArray, '/perception/signs',
                                 self._on_signs, 10)
        self.create_subscription(TrafficLightState,
                                 '/perception/traffic_light',
                                 self._on_light, 10)

        self._home_client = self.create_client(HomeModules, '/home_modules')
        self._nav_client = ActionClient(self, NavigateToPose,
                                        '/navigate_to_pose')

        self.create_timer(0.2, self._tick)
        self.get_logger().info(
            f'Менеджер миссии запущен, точек маршрута: {len(self._waypoints)}')

    # ----------------------------- восприятие ------------------------------ #
    def _on_safety(self, msg: String):
        self._last_status = msg.data

    def _on_light(self, msg: TrafficLightState):
        if msg.state == 'red':
            if not self._red_light:
                self.get_logger().info('Красный сигнал светофора — остановка')
            self._red_light = True
        elif msg.state == 'green':
            if self._red_light:
                self.get_logger().info('Зеленый сигнал светофора — проезд')
            self._red_light = False

    def _on_signs(self, msg: SignDetectionArray):
        now = time.monotonic()
        for det in msg.detections:
            if det.confidence < 0.3:
                continue
            if det.class_id == 'stop':
                self._limit = 0.0
                self._limit_until = now + self._stop_hold
                self.get_logger().info('Знак «Стоп»: полная остановка '
                                       f'{self._stop_hold:.0f} с',
                                       throttle_duration_sec=10.0)
            elif det.class_id == 'speed_bump':
                if self._limit_until < now + self._slow_hold:
                    self._limit = self._slow_limit
                    self._limit_until = now + self._slow_hold
                self.get_logger().info('«Искусственная неровность»: '
                                       f'лимит {self._slow_limit}',
                                       throttle_duration_sec=10.0)

    # ------------------------------- автомат ------------------------------- #
    def _tick(self):
        now = time.monotonic()

        # Восстановление лимита по таймеру (если не горит красный)
        if now > self._limit_until and not self._red_light:
            self._limit = 1.0
        if self._red_light:
            self._limit = 0.0
        self._pub_limit.publish(Float32(data=self._limit))

        # Авария стека безопасности
        if self._state not in (BOOT, FAULT) and \
                self._last_status in ('E_STOP', 'NO_MODULES',
                                      'BATTERY_CRITICAL', 'MODULE_FAULT'):
            self._cancel_goal()
            self._enter(FAULT)
        if self._state == FAULT:
            if self._last_status == 'OK':
                self.get_logger().info('Стек восстановлен — продолжение миссии')
                self._enter(DELIVER)
            return

        if self._state == BOOT:
            if self._last_status == 'OK':
                self._request_homing()
                self._enter(HOMING)

        elif self._state == HOMING:
            if self._home_future is not None and self._home_future.done():
                rsp = self._home_future.result()
                if rsp is not None and rsp.success:
                    self.get_logger().info('Хоминг модулей завершен')
                    self._enter(READY)
                else:
                    self.get_logger().warn('Хоминг не подтвержден, '
                                           'переходим в READY')
                    self._enter(READY)

        elif self._state == READY:
            if now - self._state_entered >= self._start_delay:
                self._enter(DELIVER)

        elif self._state == DELIVER:
            self._drive()

        elif self._state == DONE:
            self._limit = 0.0

    # ------------------------------- навигация ----------------------------- #
    def _drive(self):
        now = time.monotonic()
        if self._wp_index >= len(self._waypoints):
            self.get_logger().info('Маршрут завершен: все точки достигнуты')
            self._enter(DONE)
            return

        if self._goal_handle is None:
            if not self._nav_client.wait_for_server(timeout_sec=1.0):
                self.get_logger().warn('Nav2 недоступен, ожидание…',
                                       throttle_duration_sec=5.0)
                return
            wp = self._waypoints[self._wp_index]
            goal = NavigateToPose.Goal()
            goal.pose = self._make_pose(wp)
            self._goal_sent = now
            send_future = self._nav_client.send_goal_async(goal)
            send_future.add_done_callback(self._on_goal_accepted)
            self.get_logger().info(
                f'Точка {self._wp_index + 1}/{len(self._waypoints)}: '
                f'({wp.get("x", 0):.2f}, {wp.get("y", 0):.2f})')
            return

        # Контроль результата/таймаута
        if self._result_future is not None and self._result_future.done():
            result = self._result_future.result()
            success = bool(result.result.status == 4)  # STATUS_SUCCEEDED
            self._goal_handle = None
            self._result_future = None
            if success:
                self.get_logger().info(
                    f'Точка {self._wp_index + 1} достигнута')
                self._wp_index += 1
            else:
                self.get_logger().error(
                    f'Точка {self._wp_index + 1} недостижима, повтор')
        elif now - self._goal_sent > self._goal_timeout:
            self.get_logger().error('Таймаут ведения — отмена и повтор')
            self._cancel_goal()

    def _make_pose(self, wp) -> PoseStamped:
        import math
        pose = PoseStamped()
        pose.header.stamp = self.get_clock().now().to_msg()
        pose.header.frame_id = 'map'
        pose.pose.position.x = float(wp.get('x', 0.0))
        pose.pose.position.y = float(wp.get('y', 0.0))
        yaw = float(wp.get('yaw', 0.0))
        pose.pose.orientation.z = math.sin(yaw / 2.0)
        pose.pose.orientation.w = math.cos(yaw / 2.0)
        return pose

    def _on_goal_accepted(self, future):
        try:
            handle = future.result()
        except Exception as exc:  # noqa: BLE001
            self.get_logger().error(f'Цель отклонена: {exc}')
            return
        if not handle.accepted:
            self.get_logger().error('Nav2 отклонил цель')
            return
        self._goal_handle = handle
        self._result_future = handle.get_result_async()

    def _cancel_goal(self):
        if self._goal_handle is not None:
            try:
                self._goal_handle.cancel_goal_async()
            except Exception:  # noqa: BLE001
                pass
        self._goal_handle = None
        self._result_future = None

    # ------------------------------- служебное ----------------------------- #
    def _request_homing(self):
        if not self._home_client.wait_for_service(timeout_sec=2.0):
            self.get_logger().warn('Сервис /home_modules недоступен — '
                                   'пропуск хоминга')
            self._home_future = None
            return
        req = HomeModules.Request()
        req.module_ids = []  # все модули
        self._home_future = self._home_client.call_async(req)

    def _enter(self, state: str):
        self._state = state
        self._state_entered = time.monotonic()
        self.get_logger().info(f'FSM: -> {state}')


def main(args=None):
    rclpy.init(args=args)
    node = MissionManagerNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
