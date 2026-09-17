# -*- coding: utf-8 -*-
"""
Запуск навигации по готовой карте: карта + AMCL + весь стек Nav2.

Аргументы:
  map          — путь к *.yaml карте (обязательно);
  use_sim_time — использование симулированного времени.

Выход контроллера скоростей перенаправляется на /cmd_vel_nav: дальше
скорости ведет узел безопасности (гейт), публикующий /cmd_vel.
Узлы стека запускаются напрямую (без нав2_bringup-оберток) ради явного
ремаппинга топиков и совместимости с Humble/Jazzy.
"""

from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument
from launch.substitutions import LaunchConfiguration, PathJoinSubstitution
from launch_ros.actions import Node
from launch_ros.substitutions import FindPackageShare


def generate_launch_description():
    map_arg = DeclareLaunchArgument('map',
                                    description='Путь к файлу карты *.yaml')
    sim_arg = DeclareLaunchArgument('use_sim_time', default_value='false')

    nav2_params = PathJoinSubstitution([
        FindPackageShare('rus_slam_navigation'), 'config', 'nav2_params.yaml'])
    use_sim_time = {'use_sim_time': LaunchConfiguration('use_sim_time')}

    map_server = Node(
        package='nav2_map_server',
        executable='map_server',
        name='map_server',
        output='screen',
        parameters=[use_sim_time,
                    {'yaml_filename': LaunchConfiguration('map')}],
    )

    amcl = Node(
        package='nav2_amcl',
        executable='amcl',
        name='amcl',
        output='screen',
        parameters=[nav2_params, use_sim_time],
    )

    controller_server = Node(
        package='nav2_controller',
        executable='controller_server',
        name='controller_server',
        output='screen',
        parameters=[nav2_params, use_sim_time],
        remappings=[('/cmd_vel', '/cmd_vel_nav'),
                    ('/odom', '/odom')],
    )

    planner_server = Node(
        package='nav2_planner',
        executable='planner_server',
        name='planner_server',
        output='screen',
        parameters=[nav2_params, use_sim_time],
    )

    behavior_server = Node(
        package='nav2_behaviors',
        executable='behavior_server',
        name='behavior_server',
        output='screen',
        parameters=[nav2_params, use_sim_time],
    )

    bt_navigator = Node(
        package='nav2_bt_navigator',
        executable='bt_navigator',
        name='bt_navigator',
        output='screen',
        parameters=[nav2_params, use_sim_time],
    )

    lifecycle_manager = Node(
        package='nav2_lifecycle_manager',
        executable='lifecycle_manager',
        name='lifecycle_manager_navigation',
        output='screen',
        parameters=[use_sim_time, {
            'autostart': True,
            'node_names': ['map_server', 'amcl', 'controller_server',
                           'planner_server', 'behavior_server',
                           'bt_navigator'],
        }],
    )

    return LaunchDescription([
        map_arg,
        sim_arg,
        map_server,
        amcl,
        controller_server,
        planner_server,
        behavior_server,
        bt_navigator,
        lifecycle_manager,
    ])
