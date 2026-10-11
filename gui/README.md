# Пульт RUS SLAM

Веб-панель управления роботом-курьером 4WIS/4WID в визуальном языке [ZMK Vision](https://github.com/danilka-revin/zmk-videoanalytics): тёмный сайдбар `#101b17`, акцент `#d5ff45`, светлая рабочая зона `#f3f5f7`.

Сейчас крутится **симуляция** (одометрия, лидар, камера, модули, FSM, e-stop). Клавиши: WASD / стрелки, Q/E — крабовый сдвиг, пробел — стоп, H — хоминг.

Основной экран робота показывает крупные показатели 4 двигателей, заряд АКБ
и PIN-клавиатуру грузового отсека. По умолчанию это веб-экран
`main.html` + `main.css` + `main.js`; на нём вводят PIN, и отсек открывается на
самом роботе. Инженерный пульт (`index.html`) открывают **удалённо** по
`http://<ip-робота>:8080/console`.

**Альтернатива без веб-страницы:** `native_display.py` — отдельное нативное
полноэкранное приложение на Tkinter/Canvas. Оно не загружает HTML и не
запускает браузер: получает только JSON из API `backend.py`, включая данные,
PIN-замок и журнал. Экран можно собрать в Windows `.exe` или Linux-бинарник;
сервер `backend.py` при этом остаётся запущенным отдельно.

Сервер борта (окон сам не открывает):

```bash
python3 gui/backend.py                 # отдаёт страницы и API на 0.0.0.0:8080
python3 gui/backend.py --kiosk         # разово: + страница на дисплее робота
sudo systemctl enable --now rus-slam-server rus-slam-display   # штатный автозапуск (deploy/)
```

### Нативный полноэкранный экран (без HTML и браузера)

Сначала запустите сервер данных, например `python3 gui/backend.py --source sim`,
затем откройте приложение:

```bash
# исходный код — полноэкранно; для отладки добавьте --windowed
python3 gui/native_display.py --url http://127.0.0.1:8080

# на Windows: запустить gui/build-native-windows.bat, затем
# gui/dist/RUS-SLAM-Display.exe --url http://IP-РОБОТА:8080

# на Ubuntu/Linux: установить python3-tk и python3-venv, затем
cd gui && ./build-native-linux.sh
# результат: gui/dist/RUS-SLAM-Display
```

`--url` можно заменить адресом сервера в локальной сети; по умолчанию —
`http://127.0.0.1:8080`. У нативного приложения PIN и блокировка общие с
веб-экраном, поскольку действия идут в тот же API. Без доступного сервера
экран явно показывает отсутствие связи и **не разрешает менять состояние замка**.
F11 переключает полноэкранный режим; PIN также вводится физической клавиатурой.
Для автозапуска на дисплее Linux используйте альтернативный сервис
`deploy/rus-slam-native-display.service`, не включая одновременно
`rus-slam-display.service`.

PyInstaller собирает приложение на целевой ОС: Windows `.exe` следует собирать
на Windows, Linux-бинарник — на Linux. Нативный экран не заменяет сервер
`backend.py`; он отображает данные из его JSON API.

Данные отдаёт `backend.py`: `--source sim` (стенд) · `--source serial`
(UART-кадры телеметрии) · `--source ros` (ROS 2); замок отсека — PIN-код,
файл `state/lock.json` (общий для экрана и пульта).
Описание: `docs/MAIN_SCREEN.md`, доступ к экранам: `docs/RUN_AND_ACCESS.md`,
автозапуск: `deploy/README.md`.

Файлы инженерного пульта: `index.html`, `styles.css`, `vision.js` (карта/камеры/лидар), `app.js` (симулятор),
`console-core.js` (ядро сервисного пульта без DOM), `console.js` (вкладка «Сервис»:
замок ячейки по PIN, ручное управление двигателями, АКБ 12S3P, статистика).

Тесты:

```bash
node tests/console.test.js        # 32 теста ядра сервисного пульта (без зависимостей)
python3 backend.py --port 8081    # основной экран робота + API замка
python3 tests/backend.test.py     # 40 проверок бэкенда и API
python3 tests/native_display.test.py # HTTP-клиент и контракт нативного экрана
                                  # экран (jsdom): tests/main.screen.test.js — 38 проверок
                                  # аудит интерфейса: tests/ui.audit.test.js — 20 проверок
                                  # экран + API (jsdom): tests/main.api.test.js — 20 проверок
                                  # пульт + борт (jsdom): tests/console.api.test.js — 17 проверок
                                  # jsdom-прогоны: docs/GUI.md §7.1 и docs/MAIN_SCREEN.md §6
```

Откройте `index.html` или поднимите static-сервер из этой папки:
`python3 -m http.server 8080 --directory .`. Полное описание — `docs/GUI.md`,
план окна «Сервис» — `docs/SERVICE_CONSOLE.md`.
