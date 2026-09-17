# Карты для навигации

В этом каталоге хранятся готовые карты (пара `*.pgm` + `*.yaml`) для
локализации в режиме боевой эксплуатации.

## Создание карты

1. Запустить робота и SLAM:
   ```bash
   ros2 launch rus_slam_bringup full.launch.py slam:=true
   ```
2. Покатать робота по площадке (телеуправление или по точкам), пока карта
   не покроет весь маршрут.
3. Сохранить карту:
   ```bash
   ros2 run nav2_map_server map_saver_cli -f ros2_ws/src/rus_slam_navigation/maps/ntc_avtovaz
   ```
4. Запустить боевой режим с готовой картой:
   ```bash
   ros2 launch rus_slam_bringup full.launch.py slam:=false \
        map:=$(ros2 pkg prefix rus_slam_navigation)/share/rus_slam_navigation/maps/ntc_avtovaz.yaml
   ```
