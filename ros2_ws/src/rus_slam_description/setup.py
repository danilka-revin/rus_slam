from setuptools import find_packages, setup

package_name = 'rus_slam_description'

setup(
    name=package_name,
    version='0.1.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        ('share/' + package_name + '/urdf', ['urdf/rus_slam.urdf.xacro']),
        ('share/' + package_name + '/launch', ['launch/description.launch.py']),
    ],
    install_requires=['setuptools'],
    zip_safe=True,
    maintainer='RUS SLAM Team',
    maintainer_email='team@rus-slam.local',
    description='URDF-модель робота-курьера 4WIS/4WID',
    license='MIT',
    tests_require=['pytest'],
    entry_points={'console_scripts': []},
)
