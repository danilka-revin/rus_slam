from setuptools import find_packages, setup

package_name = 'rus_slam_perception'

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
    description='Камера, детекция знаков и светофоров',
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'camera_node = rus_slam_perception.camera_node:main',
            'sign_detector_node = rus_slam_perception.sign_detector_node:main',
            'traffic_light_node = rus_slam_perception.traffic_light_node:main',
        ],
    },
)
