from setuptools import find_packages, setup

package_name = 'rus_slam_base'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='RUS SLAM Team',
    maintainer_email='team@rus-slam.local',
    description='Ядро управления шасси 4WIS/4WID: протокол, кинематика, мост, одометрия',
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'crab_drive_node = rus_slam_base.crab_drive_node:main',
            'module_bridge_node = rus_slam_base.module_bridge_node:main',
            'odometry_node = rus_slam_base.odometry_node:main',
        ],
    },
)
