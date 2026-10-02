# Пульт RUS SLAM

Веб-панель управления роботом-курьером 4WIS/4WID в визуальном языке [ZMK Vision](https://github.com/danilka-revin/zmk-videoanalytics): тёмный сайдбар `#101b17`, акцент `#d5ff45`, светлая рабочая зона `#f3f5f7`.

Сейчас крутится **симуляция** (одометрия, лидар, камера, модули, FSM, e-stop). Клавиши: WASD / стрелки, Q/E — крабовый сдвиг, пробел — стоп, H — хоминг.

Файлы: `index.html`, `styles.css`, `vision.js` (карта/камеры/лидар), `app.js` (симулятор),
`console-core.js` (ядро сервисного пульта без DOM), `console.js` (вкладка «Сервис»:
замок ячейки по PIN, ручное управление двигателями, АКБ 12S3P, статистика).

Тесты:

```bash
node tests/console.test.js        # 32 теста ядра, без зависимостей
                              # интеграционный jsdom-прогон: см. docs/GUI.md §7.1
```

Откройте `index.html` или поднимите static-сервер из этой папки:
`python3 -m http.server 8080 --directory .`. Полное описание — `docs/GUI.md`,
план окна «Сервис» — `docs/SERVICE_CONSOLE.md`.
