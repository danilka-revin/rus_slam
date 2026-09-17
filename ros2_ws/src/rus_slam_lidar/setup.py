from setuptools import find_packages, setup

package_name = 'rus_slam_lidar'

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
    description='Драйвер лидара ЛДС-01 (LaserScan)',
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'lds01_driver_node = rus_slam_lidar.lds01_driver_node:main',
        ],
    },
)
