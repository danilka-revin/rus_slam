# -*- coding: utf-8 -*-
"""
Базовый запуск робота: модель, мост модулей, кинематика, одометрия,
лидар, камера, детекторы, гейт безопасности.

Аргументы:
  sim          — true: все модули в симуляции (без железа);
  use_sim_time — симулированное время (для Gazebo и т. п.).

Телеуправление: `ros2 topic pub /cmd_vel_nav geometry_msgs/msg/Twist ...`
(гейт безопасности транслирует очищенные команды в /cmd_vel).
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare

CONFIG_PKG = 'rus_slam_bringup'


def _config(name: str):
    return PathJoinSubstitution([FindPackageShare(CONFIG_PKG), 'config', name])


def generate_launch_description():
    sim = LaunchConfiguration('sim')
    use_sim_time = {'use_sim_time': LaunchConfiguration('use_sim_time')}

    description = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(PathJoinSubstitution([
            FindPackageShare('rus_slam_description'),
            'launch', 'description.launch.py'])))

    bridge = Node(
        package='rus_slam_base', executable='module_bridge_node',
        name='module_bridge_node', output='screen',
        parameters=[_config('robot.yaml'), use_sim_time,
                    {'sim': sim}],
    )
    kinematics = Node(
        package='rus_slam_base', executable='crab_drive_node',
        name='crab_drive_node', output='screen',
        parameters=[_config('robot.yaml'), use_sim_time],
    )
    odometry = Node(
        package='rus_slam_base', executable='odometry_node',
        name='odometry_node', output='screen',
        parameters=[_config('robot.yaml'), use_sim_time],
    )
    lidar = Node(
        package='rus_slam_lidar', executable='lds01_driver_node',
        name='lds01_driver_node', output='screen',
        parameters=[_config('lidar.yaml'), use_sim_time],
    )
    camera = Node(
        package='rus_slam_perception', executable='camera_node',
        name='camera_node', output='screen',
        parameters=[_config('perception.yaml'), use_sim_time],
    )
    signs = Node(
        package='rus_slam_perception', executable='sign_detector_node',
        name='sign_detector_node', output='screen',
        parameters=[_config('perception.yaml'), use_sim_time],
    )
    lights = Node(
        package='rus_slam_perception', executable='traffic_light_node',
        name='traffic_light_node', output='screen',
        parameters=[_config('perception.yaml'), use_sim_time],
    )
    safety = Node(
        package='rus_slam_safety', executable='safety_node',
        name='safety_node', output='screen',
        parameters=[_config('safety.yaml'), use_sim_time],
    )

    return LaunchDescription([
        DeclareLaunchArgument('sim', default_value='false',
                              description='Полная симуляция модулей'),
        DeclareLaunchArgument('use_sim_time', default_value='false'),
        description,
        bridge, kinematics, odometry,
        lidar, camera, signs, lights,
        safety,
    ])
