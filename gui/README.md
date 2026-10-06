# Пульт RUS SLAM

Веб-панель управления роботом-курьером 4WIS/4WID в визуальном языке [ZMK Vision](https://github.com/danilka-revin/zmk-videoanalytics): тёмный сайдбар `#101b17`, акцент `#d5ff45`, светлая рабочая зона `#f3f5f7`.

Сейчас крутится **симуляция** (одометрия, лидар, камера, модули, FSM, e-stop). Клавиши: WASD / стрелки, Q/E — крабовый сдвиг, пробел — стоп, H — хоминг.

Основной экран робота (киоск): `main.html` + `main.css` + `main.js` — крупные
показатели 4 двигателей, заряд АКБ в процентах и PIN-клавиатура грузового отсека.
Запуск на борту: `python3 gui/backend.py --kiosk` (корень `/` — основной экран,
`/index.html` — инженерный пульт). Данные отдаёт бэкенд `backend.py`:
`--source sim` (стенд) · `--source serial` (UART-кадры телеметрии) ·
`--source ros` (ROS 2); замок отсека — PIN-код, файл `state/lock.json`.
Описание: `docs/MAIN_SCREEN.md`, доступ к экранам: `docs/RUN_AND_ACCESS.md`.

Файлы инженерного пульта: `index.html`, `styles.css`, `vision.js` (карта/камеры/лидар), `app.js` (симулятор),
`console-core.js` (ядро сервисного пульта без DOM), `console.js` (вкладка «Сервис»:
замок ячейки по PIN, ручное управление двигателями, АКБ 12S3P, статистика).

Тесты:

```bash
node tests/console.test.js        # 32 теста ядра сервисного пульта (без зависимостей)
python3 backend.py --port 8081    # основной экран робота + API замка
python3 tests/backend.test.py     # 36 проверок бэкенда и API
                                  # экран+API (jsdom): tests/main.api.test.js — 19 проверок
                                  # jsdom-прогоны: docs/GUI.md §7.1 и docs/MAIN_SCREEN.md §6
```

Откройте `index.html` или поднимите static-сервер из этой папки:
`python3 -m http.server 8080 --directory .`. Полное описание — `docs/GUI.md`,
план окна «Сервис» — `docs/SERVICE_CONSOLE.md`.
