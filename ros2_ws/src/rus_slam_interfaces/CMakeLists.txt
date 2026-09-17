cmake_minimum_required(VERSION 3.8)
project(rus_slam_interfaces)

find_package(ament_cmake REQUIRED)
find_package(rosidl_default_generators REQUIRED)
find_package(std_msgs REQUIRED)

rosidl_generate_interfaces(${PROJECT_NAME}
  "msg/WheelCommand.msg"
  "msg/WheelCommandArray.msg"
  "msg/ModuleState.msg"
  "msg/ModuleStateArray.msg"
  "msg/BatteryInfo.msg"
  "msg/SignDetection.msg"
  "msg/SignDetectionArray.msg"
  "msg/TrafficLightState.msg"
  "srv/HomeModules.srv"
  "srv/SetModulesEnabled.srv"
  DEPENDENCIES std_msgs
)

ament_package()
