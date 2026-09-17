# -*- coding: utf-8 -*-
"""
Узел одометрии шасси 4WIS/4WID.

Подписка:  /modules/state (ModuleStateArray) — телеметрия модулей.
Издание:   /odom (nav_msgs/Odometry), /joint_states (sensor_msgs/JointState),
           TF: odom -> base_link.

Скорость корпуса восстанавливается МНК по фактическим углам модулей и
скоростям колес (модуль `odometry_core.py`), поза интегрируется со средним
курсом за период. Имена сочленений совпадают с моделью в
`rus_slam_description`: steer_<side> и wheel_<side>.
"""

import math

import rclpy
import tf2_ros
from geometry_msgs.msg import TransformStamped
from nav_msgs.msg import Odometry
from rclpy.node import Node
from rus_slam_interfaces.msg import ModuleStateArray
from sensor_msgs.msg import JointState

from .odometry_core import SwerveOdometry, Twist2D, WheelSample, integrate_pose

SIDES = {1: 'fl', 2: 'fr', 3: 'rl', 4: 'rr'}


class OdometryNode(Node):

    def __init__(self):
        super().__init__('odometry_node')

        self.declare_parameter('wheelbase_L', 0.55)
        self.declare_parameter('track_W', 0.46)
        self.declare_parameter('wheel_radius_m', 0.127)
        self.declare_parameter('odom_frame', 'odom')
        self.declare_parameter('base_frame', 'base_link')
        self.declare_parameter('max_period_sec', 0.5)

        self._odom = SwerveOdometry(
            wheelbase=self.get_parameter('wheelbase_L').value,
            track=self.get_parameter('track_W').value,
        )
        self._radius = self.get_parameter('wheel_radius_m').value
        self._max_period = self.get_parameter('max_period_sec').value
        self._odom_frame = self.get_parameter('odom_frame').value
        self._base_frame = self.get_parameter('base_frame').value

        self._pose = (0.0, 0.0, 0.0)
        self._last_stamp = None
        self._wheel_pos = {mid: 0.0 for mid in SIDES}

        self._pub_odom = self.create_publisher(Odometry, '/odom', 10)
        self._pub_joints = self.create_publisher(JointState, '/joint_states', 10)
        self._tf_br = tf2_ros.TransformBroadcaster(self)
        self.create_subscription(ModuleStateArray, '/modules/state',
                                 self._on_state, 10)
        self.get_logger().info('Одометрия 4WIS/4WID запущена.')

    # ------------------------------------------------------------------ #
    def _on_state(self, msg: ModuleStateArray):
        stamp = msg.header.stamp
        now_sec = stamp.sec + stamp.nanosec * 1e-9
        if self._last_stamp is None:
            self._last_stamp = now_sec
            return
        dt = now_sec - self._last_stamp
        self._last_stamp = now_sec
        if dt <= 0.0:
            return
        dt = min(dt, self._max_period)

        samples = [WheelSample(st.module_id, st.steer_angle,
                               st.wheel_speed * dt) for st in msg.states]
        twist = self._odom.estimate_twist(dt, samples)
        self._pose = integrate_pose(self._pose, twist, dt)
        x, y, yaw = self._pose

        self._publish_odom(stamp, x, y, yaw, twist)
        self._broadcast_tf(stamp, x, y, yaw)
        self._publish_joints(stamp, msg, dt)

    # ------------------------------------------------------------------ #
    def _publish_odom(self, stamp, x, y, yaw, twist: Twist2D):
        msg = Odometry()
        msg.header.stamp = stamp
        msg.header.frame_id = self._odom_frame
        msg.child_frame_id = self._base_frame
        msg.pose.pose.position.x = x
        msg.pose.pose.position.y = y
        msg.pose.pose.position.z = 0.0
        msg.pose.pose.orientation.z = math.sin(yaw / 2.0)
        msg.pose.pose.orientation.w = math.cos(yaw / 2.0)
        msg.twist.twist.linear.x = twist.vx
        msg.twist.twist.linear.y = twist.vy
        msg.twist.twist.angular.z = twist.wz
        # Диагональные ковариации: доверие к энкодерам среднее,
        # по курсу — выше (бокового скольжения у свера почти нет)
        msg.pose.covariance = [1e-3, 0, 0, 0, 0, 0,
                               0, 1e-3, 0, 0, 0, 0,
                               0, 0, 1e9, 0, 0, 0,
                               0, 0, 0, 1e9, 0, 0,
                               0, 0, 0, 0, 1e9, 0,
                               0, 0, 0, 0, 0, 1e-2]
        msg.twist.covariance = [1e-3, 0, 0, 0, 0, 0,
                                0, 1e-3, 0, 0, 0, 0,
                                0, 0, 1e9, 0, 0, 0,
                                0, 0, 0, 1e9, 0, 0,
                                0, 0, 0, 0, 1e9, 0,
                                0, 0, 0, 0, 0, 1e-2]
        self._pub_odom.publish(msg)

    def _broadcast_tf(self, stamp, x, y, yaw):
        tf = TransformStamped()
        tf.header.stamp = stamp
        tf.header.frame_id = self._odom_frame
        tf.child_frame_id = self._base_frame
        tf.transform.translation.x = x
        tf.transform.translation.y = y
        tf.transform.translation.z = 0.0
        tf.transform.rotation.z = math.sin(yaw / 2.0)
        tf.transform.rotation.w = math.cos(yaw / 2.0)
        self._tf_br.sendTransform(tf)

    def _publish_joints(self, stamp, msg: ModuleStateArray, dt: float):
        js = JointState()
        js.header.stamp = stamp
        for st in msg.states:
            side = SIDES.get(st.module_id)
            if side is None:
                continue
            wheel_vel = st.wheel_speed / self._radius if self._radius else 0.0
            self._wheel_pos[st.module_id] += wheel_vel * dt
            js.name.append(f'steer_{side}')
            js.position.append(st.steer_angle)
            js.velocity.append(0.0)
            js.name.append(f'wheel_{side}')
            js.position.append(self._wheel_pos[st.module_id])
            js.velocity.append(wheel_vel)
        self._pub_joints.publish(js)


def main(args=None):
    rclpy.init(args=args)
    node = OdometryNode()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()
