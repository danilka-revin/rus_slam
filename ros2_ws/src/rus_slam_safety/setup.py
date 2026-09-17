from setuptools import find_packages, setup

package_name = 'rus_slam_safety'

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
    description='Безопасность и менеджер миссии',
    license='MIT',
    tests_require=['pytest'],
    entry_points={
        'console_scripts': [
            'safety_node = rus_slam_safety.safety_node:main',
            'mission_manager_node = rus_slam_safety.mission_manager_node:main',
        ],
    },
)
