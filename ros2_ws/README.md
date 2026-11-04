# ROS 2 workspace — legacy (справочно)

Пакеты `rus_slam_*` в этом workspace — **справочная архитектура**. Рабочий софт
робота (лидар через ROS 2-драйверы, навигация по карте, пульт) живёт в
[danilka-revin/Zapret](https://github.com/danilka-revin/Zapret) — и там свой
`ros2_ws` с супервизором лидара.

Почему legacy: мост `rus_slam_base/module_link.py` и `protocol.py` используют
**бинарные** кадры 10/16 Б (`0xAA 0x55` / `0xBB 0x44`), которых прошивка робота
не выдаёт. Реальная прошивка — [`firmware/motor_wheel`](../firmware/motor_wheel/motor_wheel.ino)
(fw25), протокол — [`../docs/SERIAL_PROTOCOL.md`](../docs/SERIAL_PROTOCOL.md),
план перевода моста — [`../docs/SOFTWARE_ARCHITECTURE.md`](../docs/SOFTWARE_ARCHITECTURE.md), §10.

Сборка (если нужна для справки):

```bash
cd ros2_ws
colcon build --symlink-install && source install/setup.bash
ros2 launch rus_slam_bringup robot.launch.py sim:=true
```
