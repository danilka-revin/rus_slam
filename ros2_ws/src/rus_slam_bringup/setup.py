import os
from glob import glob

from setuptools import find_packages, setup

package_name = 'rus_slam_bringup'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        (os.path.join('share', package_name, 'launch'),
            glob('launch/*.launch.py')),
        (os.path.join('share', package_name, 'config'),
            glob('config/*.yaml')),
        (os.path.join('share', package_name, 'udev'),
            glob('udev/*.rules')),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='RUS SLAM Team',
    maintainer_email='team@rus-slam.local',
    description='Запуск робота-курьера НТЦ АО «АВТОВАЗ»',
    license='MIT',
    tests_require=['pytest'],
    entry_points={'console_scripts': []},
)
