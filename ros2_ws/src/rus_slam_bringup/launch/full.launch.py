# -*- coding: utf-8 -*-
"""
Полный запуск: робот + навигация (SLAM или по готовой карте) + миссия.

Аргументы:
  sim   — true: модули в симуляции;
  slam  — true: картирование; false: локализация по карте (нужен `map`);
  map   — путь к *.yaml карте при slam:=false.

Примеры:
  # картирование полигона
  ros2 launch rus_slam_bringup full.launch.py slam:=true
  # боевой запуск по готовой карте
  ros2 launch rus_slam_bringup full.launch.py slam:=false map:=/path/ntc.yaml
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, IncludeLaunchDescription
from launch.conditions import IfCondition, UnlessCondition
from launch.launch_description_sources import PythonLaunchDescriptionSource
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    config_pkg = FindPackageShare('rus_slam_bringup')
    nav_pkg = FindPackageShare('rus_slam_navigation')
    use_sim_time = {'use_sim_time': LaunchConfiguration('use_sim_time')}

    robot = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(PathJoinSubstitution([
            config_pkg, 'launch', 'robot.launch.py'])),
        launch_arguments={
            'sim': LaunchConfiguration('sim'),
            'use_sim_time': LaunchConfiguration('use_sim_time'),
        }.items(),
    )

    slam = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(PathJoinSubstitution([
            nav_pkg, 'launch', 'slam.launch.py'])),
        condition=IfCondition(LaunchConfiguration('slam')),
    )

    navigation = IncludeLaunchDescription(
        PythonLaunchDescriptionSource(PathJoinSubstitution([
            nav_pkg, 'launch', 'navigation.launch.py'])),
        launch_arguments={
            'map': LaunchConfiguration('map'),
            'use_sim_time': LaunchConfiguration('use_sim_time'),
        }.items(),
        condition=UnlessCondition(LaunchConfiguration('slam')),
    )

    mission = Node(
        package='rus_slam_safety', executable='mission_manager_node',
        name='mission_manager_node', output='screen',
        parameters=[PathJoinSubstitution([config_pkg, 'config',
                                          'mission.yaml']),
                    use_sim_time],
    )

    return LaunchDescription([
        DeclareLaunchArgument('sim', default_value='false'),
        DeclareLaunchArgument('slam', default_value='true',
                              description='true — картирование, '
                                          'false — навигация по карте'),
        DeclareLaunchArgument('map', default_value='',
                              description='Файл карты *.yaml при slam:=false'),
        DeclareLaunchArgument('use_sim_time', default_value='false'),
        robot,
        slam,
        navigation,
        mission,
    ])
