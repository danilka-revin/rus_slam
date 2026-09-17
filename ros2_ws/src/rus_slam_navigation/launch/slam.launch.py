# -*- coding: utf-8 -*-
"""Запуск slam_toolbox (картографирование в режиме online_async)."""

from launch import LaunchDescription
from launch.substitutions import PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    params = PathJoinSubstitution([
        FindPackageShare('rus_slam_navigation'),
        'config',
        'slam_toolbox.yaml',
    ])

    slam = Node(
        package='slam_toolbox',
        executable='async_slam_toolbox_node',
        name='slam_toolbox',
        output='screen',
        parameters=[params],
    )

    return LaunchDescription([slam])
