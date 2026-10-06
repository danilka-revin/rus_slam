# Автозапуск на роботе

Два независимых сервиса systemd:

| Сервис | Что делает | Когда нужен |
| :--- | :--- | :--- |
| `rus-slam-server.service` | поднимает `gui/backend.py` — отдаёт страницы и API по сети `0.0.0.0:8080`. **Окон не открывает** | всегда |
| `rus-slam-display.service` | показывает **основной экран** на дисплее робота: ждёт сервер и открывает `http://127.0.0.1:8080/` в браузере без рамок | если у робота есть свой дисплей |

Инженерный пульт на роботе не запускается: в него заходят **удалённо** —
с ноутбука или планшета по адресу `http://<ip-робота>:8080/console`.

## Установка

```bash
# 1. код на роботе
sudo git clone <репозиторий> /opt/rus_slam      # или скопировать папку целиком

# 2. сервисы
sudo cp /opt/rus_slam/deploy/rus-slam-server.service  /etc/systemd/system/
sudo cp /opt/rus_slam/deploy/rus-slam-display.service /etc/systemd/system/
sudo chmod +x /opt/rus_slam/deploy/display.sh

# 3. в display.service укажите пользователя графической сессии (по умолчанию rus)
#    и дисплей (DISPLAY=:0), если он другой

sudo systemctl daemon-reload
sudo systemctl enable --now rus-slam-server        # сервер (обязательно)
sudo systemctl enable --now rus-slam-display       # страница на дисплее робота
```

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
