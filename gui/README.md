# Пульт RUS SLAM

Веб-панель управления роботом-курьером 4WIS/4WID в визуальном языке [ZMK Vision](https://github.com/danilka-revin/zmk-videoanalytics): тёмный сайдбар `#101b17`, акцент `#d5ff45`, светлая рабочая зона `#f3f5f7`.

Сейчас крутится **симуляция** (одометрия, лидар, камера, модули, FSM, e-stop). Клавиши: WASD / стрелки, Q/E — крабовый сдвиг, пробел — стоп, H — хоминг.

Основной экран робота — `main.html` + `main.css` + `main.js`: крупные показатели
4 двигателей, заряд АКБ в процентах и PIN-клавиатура грузового отсека. Он висит
**статично на дисплее робота**: там вводят PIN, и отсек открывается на самом
роботе. Инженерный пульт (`index.html`) открывают **удалённо** по
`http://<ip-робота>:8080/console`.

Сервер борта (окон сам не открывает):

```bash
python3 gui/backend.py                 # отдаёт страницы и API на 0.0.0.0:8080
python3 gui/backend.py --kiosk         # разово: + страница на дисплее робота
sudo systemctl enable --now rus-slam-server rus-slam-display   # штатный автозапуск (deploy/)
```

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
                                  # экран (jsdom): tests/main.screen.test.js — 38 проверок
                                  # аудит интерфейса: tests/ui.audit.test.js — 20 проверок
                                  # экран + API (jsdom): tests/main.api.test.js — 20 проверок
                                  # пульт + борт (jsdom): tests/console.api.test.js — 17 проверок
                                  # jsdom-прогоны: docs/GUI.md §7.1 и docs/MAIN_SCREEN.md §6
```

Откройте `index.html` или поднимите static-сервер из этой папки:
`python3 -m http.server 8080 --directory .`. Полное описание — `docs/GUI.md`,
план окна «Сервис» — `docs/SERVICE_CONSOLE.md`.
