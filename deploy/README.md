# Автозапуск на роботе

Сервер и экран запускаются независимо. Для отображения можно выбрать браузерный
экран или отдельное нативное приложение без HTML/браузера:

| Сервис | Что делает | Когда нужен |
| :--- | :--- | :--- |
| `rus-slam-server.service` | поднимает `gui/backend.py` — отдаёт страницы и JSON API по сети `0.0.0.0:8080`. **Окон не открывает** | всегда |
| `rus-slam-display.service` | показывает основной экран в браузере без рамок | если выбран веб-экран |
| `rus-slam-native-display.service` | показывает основной экран нативным Tkinter-приложением; браузер и HTML для главного экрана не используются | если выбрана нативная сборка |

Одновременно включают только один сервис дисплея. Инженерный пульт на роботе
не запускается: в него заходят **удалённо** — с ноутбука или планшета по адресу
`http://<ip-робота>:8080/console`.

## Установка

```bash
# 1. код на роботе
sudo git clone <репозиторий> /opt/rus_slam      # или скопировать папку целиком

# 2. установить сервис сервера и выбранный вариант дисплея
sudo cp /opt/rus_slam/deploy/rus-slam-server.service /etc/systemd/system/
sudo cp /opt/rus_slam/deploy/rus-slam-display.service /etc/systemd/system/
sudo cp /opt/rus_slam/deploy/rus-slam-native-display.service /etc/systemd/system/
sudo chmod +x /opt/rus_slam/deploy/display.sh

# 3. В выбранном display.service проверьте User=rus, DISPLAY=:0 и XAUTHORITY.
#    Для веб-варианта:
sudo systemctl daemon-reload
sudo systemctl enable --now rus-slam-server
sudo systemctl enable --now rus-slam-display
```

### Выбор нативного приложения вместо браузера

Сборка создаётся **на той же ОС и архитектуре, где будет запускаться**. Для
Ubuntu/Linux установите Tkinter и инструменты сборки, затем запустите скрипт:

```bash
sudo apt install -y python3-tk python3-venv
cd /opt/rus_slam/gui
./build-native-linux.sh

sudo systemctl disable --now rus-slam-display
sudo systemctl daemon-reload
sudo systemctl enable --now rus-slam-native-display
```

Скрипт создаёт `gui/dist/RUS-SLAM-Display` — PyInstaller-приложение с нативным
полноэкранным интерфейсом. Для переключения обратно выключите
`rus-slam-native-display` и включите `rus-slam-display`. Не включайте оба
сервиса дисплея одновременно.

Для Windows отдельная инструкция и `.exe`-сборщик — `gui/README.md`;
PyInstaller собирает Windows `.exe` на Windows, кросс-сборка из Linux не
поддерживается.

Проверка:

```bash
systemctl status rus-slam-server --no-pager
curl -s http://127.0.0.1:8080/api/health          # {"ok": true, "source": "..."}
xdg-open http://127.0.0.1:8080/console            # с ноутбука — пульт
```

## Что важно знать

* **PIN грузового отсека** задаётся на борту: заводской `2580`, меняется из
  сервисного окна пульта (удалённо) либо первым запуском с `--pin 1234`.
  Хранится в `gui/state/lock.json` — файл переживает перезапуски и обновления
  кода, поэтому его стоит сохранять.
* **Замок на железе**: раскомментируйте `RUS_SLAM_LOCK_CMD` и
  `RUS_SLAM_LOCK_CMD_CLOSE` в `rus-slam-server.service`. Без них отсек
  «открывается» только программно.
* **Обновление кода** не требует переустановки сервисов:
  `sudo git -C /opt/rus_slam pull && sudo systemctl restart rus-slam-server`.
* Если робот без дисплея — `rus-slam-display.service` не нужен: страницы
  открывают с планшета или ноутбука, сервер для этого уже работает.
* Подробности про роли, PIN и сетевые адреса — `docs/RUN_AND_ACCESS.md`.
