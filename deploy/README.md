# Автозапуск на роботе

Сервер и экран запускаются независимо. Для отображения можно выбрать браузерный
экран или отдельное нативное приложение без HTML/браузера:

| Сервис | Файл | Что делает |
| :--- | :--- | :--- |
| `rus-slam-server.service` | [`systemd/`](systemd/rus-slam-server.service) | поднимает `gui/backend.py` — отдаёт страницы и JSON API на `0.0.0.0:8080`, окон не открывает |
| `rus-slam-display.service` | [`systemd/`](systemd/rus-slam-display.service) | показывает основной экран в браузере без рамок |
| `rus-slam-native-display.service` | [`systemd/`](systemd/rus-slam-native-display.service) | показывает экран нативным Tkinter-приложением |

Одновременно включают только один сервис дисплея. Инженерный пульт на роботе не
запускается — в него заходят удалённо по `http://<ip-робота>:8080/console`.

> **Legacy.** Это автозапуск справочного `gui/`. Рабочий автозапуск робота —
> ярлык «Запустить робот» в репозитории
> [Zapret](https://github.com/danilka-revin/Zapret) (`scripts/autostart.sh`).

## Установка

```bash
sudo git clone <репозиторий> /opt/rus_slam
sudo cp /opt/rus_slam/deploy/systemd/rus-slam-server.service /etc/systemd/system/
sudo cp /opt/rus_slam/deploy/systemd/rus-slam-display.service /etc/systemd/system/
sudo chmod +x /opt/rus_slam/deploy/systemd/display.sh

# проверьте User=, DISPLAY=:0 и XAUTHORITY в display.service
sudo systemctl daemon-reload
sudo systemctl enable --now rus-slam-server
sudo systemctl enable --now rus-slam-display
```

Нативный вариант вместо браузера:

```bash
sudo apt install -y python3-tk python3-venv
cd /opt/rus_slam/gui && ./tools/build-native-linux.sh
sudo systemctl disable --now rus-slam-display
sudo cp /opt/rus_slam/deploy/systemd/rus-slam-native-display.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now rus-slam-native-display
```

Не включайте оба сервиса дисплея одновременно. Windows-сборка — `gui/README.md`.
