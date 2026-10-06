/* Интеграционный прогон окна «Сервис» в jsdom: реальный index.html + скрипты. */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const GUI = '/home/user/rus_slam/gui';
let html = fs.readFileSync(path.join(GUI, 'index.html'), 'utf8');

// порядок скриптов берём из index.html — это часть проверки
const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]);
html = html.replace(/<script src="[^"]+"><\/script>/g, '');

const problems = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));
vc.on('warn', (...a) => problems.push('console.warn: ' + a.join(' ')));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://rus-slam.test/',
  virtualConsole: vc,
});
const { window } = dom;

// canvas 2d-контекст: заглушка (jsdom без нативного canvas)
function ctxStub() {
  const store = { canvas: null };
  return new Proxy(store, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'measureText') return () => ({ width: 24 });
      if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set(t, p, v) { t[p] = v; return true; },
  });
}
window.HTMLCanvasElement.prototype.getContext = function () { return ctxStub(); };
window.HTMLCanvasElement.prototype.toDataURL = () => 'data:image/png;base64,';
if (!window.URL.createObjectURL) window.URL.createObjectURL = () => 'blob:stub';
if (!window.URL.revokeObjectURL) window.URL.revokeObjectURL = () => {};

const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: cond ? '' : (extra || '') });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

(async () => {
  // 1. Скрипты в нужном порядке
  check('index.html подключает скрипты в порядке core → vision → app → console',
    JSON.stringify(scripts) === JSON.stringify(['console-core.js', 'vision.js', 'app.js', 'console.js']),
    JSON.stringify(scripts));

  for (const f of scripts) {
    const el = window.document.createElement('script');
    el.textContent = fs.readFileSync(path.join(GUI, f), 'utf8');
    window.document.body.appendChild(el);
  }
  await sleep(120);

  check('ядро RS загружено', !!window.RS && !!window.RS.uart && !!window.RS.StatsStore);
  check('окно «Сервис» зарегистрировано (RSConsole)', !!window.RSConsole);
  check('вкладка «Сервис» есть в навигации', !!window.document.querySelector('nav button[data-view="console"]'));
  check('секция view-console есть', !!window.document.getElementById('view-console'));

  // 2. Переключение вкладки
  click(window.document.querySelector('nav button[data-view="console"]'));
  check('вкладка «Сервис» стала видимой', !window.document.getElementById('view-console').classList.contains('hidden'));
  check('заголовок страницы переключился', window.document.getElementById('page-title').textContent.includes('Сервис'),
    window.document.getElementById('page-title').textContent);

  // 3. Пуск главного цикла (rAF jsdom) — ждём несколько кадров
  await sleep(700);
  const cards = window.document.querySelectorAll('#csl-mods .csl-mod');
  check('4 карточки модулей FL/FR/RL/RR', cards.length === 4, 'найдено ' + cards.length);
  check('клавиатура PIN: 12 кнопок', window.document.querySelectorAll('#csl-keypad button').length === 12);
  check('KPI-плитки статистики отрисованы', window.document.querySelectorAll('#csl-kpi article').length >= 10);
  check('АКБ: напряжение 12S в диапазоне 29…44 В',
    (() => { const t = window.document.getElementById('csl-bat-v').textContent; const v = parseFloat(t); return v >= 29 && v <= 44.5; })(),
    window.document.getElementById('csl-bat-v').textContent);
  check('АКБ: таблица телеметрии модулей (4 строки)', window.document.querySelectorAll('#csl-bat-mods tr').length === 4);
  check('статистика: аудит замка отрисован', window.document.getElementById('csl-audit') !== null);

  // 4. Замок: неверный PIN → отказ, затем верный → открытие
  const keypad = [...window.document.querySelectorAll('#csl-keypad button')];
  const press = (d) => click(keypad.find((b) => b.dataset.key === d));
  const openBtn = window.document.getElementById('csl-pin-open');
  click(openBtn);            // пустой ввод
  check('пустой PIN отклонён', window.document.getElementById('csl-pin-msg').textContent.includes('4 до 8'));
  ['9', '9', '9', '9'].forEach(press);
  click(openBtn);
  await sleep(80);
  check('неверный PIN: отказ с остатком попыток',
    window.document.getElementById('csl-pin-msg').textContent.includes('Неверный PIN'),
    window.document.getElementById('csl-pin-msg').textContent);
  check('счётчик отказов в статистике замка', window.RSConsole.stats.summary().locks.denied >= 1);
  ['2', '5', '8', '0'].forEach(press);
  click(openBtn);
  await sleep(120);
  check('верный PIN 2580 открыл ячейку', window.RSConsole.isLockOpen() === true);
  check('чип замка «ОТКРЫТО»', window.document.getElementById('csl-lock-chip').textContent === 'ОТКРЫТО');
  check('замок синхронизирован с симуляцией (cargoLock=false)', window.eval('state.cargoLock') === false);
  check('статистика зафиксировала открытие', window.RSConsole.stats.summary().locks.open >= 1);
  const audit = window.RSConsole.stats.summary();
  check('аудит доступа в localStorage', (window.localStorage.getItem('rus_slam_lock_v1') || '').includes('audit'));
  click(window.document.getElementById('csl-pin-close'));
  check('кнопка «Закрыть» закрыла ячейку', window.RSConsole.isLockOpen() === false);

  // 5. Двигатели: интерлоки и ручная команда
  const stand = window.document.getElementById('csl-stand');
  const steerIn = window.document.getElementById('csl-steer-FL');
  const sendBtn = window.document.querySelector('#csl-mod-FL .csl-send[data-ch="steer"]');
  steerIn.value = '45';
  click(sendBtn);
  await sleep(30);
  check('без режима «стенд» команда отклонена', !window.document.getElementById('csl-frame-FL').textContent.includes('AA 55'));
  stand.checked = true;
  stand.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('режим «стенд» включён', window.eval('state.serviceStand') === true);
  check('чип панели показывает стенд', window.document.getElementById('csl-tb-stand').textContent.includes('СТЕНД'),
    window.document.getElementById('csl-tb-stand').textContent);
  check('класс service-stand на body', window.document.body.classList.contains('service-stand'));
  check('автономия сброшена в стенде', window.eval('state.auto') === false);
  const vIn = window.document.getElementById('csl-pwm-FL');
  vIn.value = '20';
  click(window.document.querySelector('#csl-mod-FL .csl-send[data-ch="traction"]'));
  click(sendBtn);
  await sleep(30);
  const frame = window.document.getElementById('csl-frame-FL').textContent;
  check('кадр UART сформирован (AA 55 01 …)', frame.includes('AA 55 01'), frame);
  check('факт телеметрии модуля FL обновился', window.document.getElementById('csl-fact-FL').textContent.includes('задание 45'));
  check('статистика: ручные команды учтены', window.RSConsole.stats.summary().manualOps >= 2);
  check('журнал пульта содержит UART-кадр', window.eval('state.logs').some((l) => l.msg.includes('UART → FL')));
  // групповые операции
  click(window.document.querySelector('#csl-tb-stop'));
  check('«Стоп все» обнулил тягу', Number(window.document.getElementById('csl-pwm-RR').value) === 0);
  click(window.document.querySelector('[data-csl="home-all"]'));
  check('«Хоминг всех» спрашивает подтверждение', !window.document.getElementById('csl-modal').classList.contains('hidden'));
  click(window.document.getElementById('csl-modal-ok'));
  await sleep(40);
  check('«Хоминг всех» пометил модули seek', window.eval('state.modules.every((m) => !m.homed)') === true);
  check('модальное окно хоминга закрылось', window.document.getElementById('csl-modal').classList.contains('hidden'));

  // 6. Стенд двигает только модули, корпус стоит
  window.eval('state.vx = 0; state.spdVy = 0;');
  const before = window.eval('({x: state.x, y: state.y})');
  await sleep(300);
  const after = window.eval('({x: state.x, y: state.y})');
  check('в стенде корпус не перемещается', Math.hypot(after.x - before.x, after.y - before.y) < 1e-6);

  // 7. Статистика: рейс, экспорт
  const st = window.RSConsole.stats;
  for (let i = 0; i < 60; i++) st.tick(0.1, { speed: 1, voltage: 38, current: 6, auto: true, cargo: true, payload: 40, origin: 'А', mission: 'DELIVER' });
  st.tick(0.1, { speed: 0, voltage: 38, current: 3, auto: false });
  const sum = st.summary();
  check('рейс зафиксирован', sum.trips >= 1, 'trips=' + sum.trips);
  check('CSV-экспорт содержит разделы', st.toCSV().includes('Показатель;Значение') && st.toCSV().includes('# Рейсы'));
  check('JSON-экспорт валиден (готовая строка → parse)',    (() => { try { const j = JSON.parse(st.toJSON()); return j.totals.trips >= 1 && !!j.summary; } catch (e) { return false; } })());
  check('печатный отчёт содержит подпись оператора', st.reportHTML().includes('Оператор смены'));
  check('статистика персистится в localStorage', (window.localStorage.getItem('rus_slam_stats_v1') || '').includes('totals'));
  check('таблица рейсов отрисована', window.document.querySelectorAll('#csl-trips tr').length >= 1);

  // 8. Светофор в WORLD + событие
  check('светофор добавлен в WORLD', window.eval('(WORLD.signs || []).some((s) => s.kind === "light")') === true);
  window.eval('window.__rsNow = () => 8000;'); // 6,0…12,5 с — красная фаза
  await sleep(120);
  check('фаза светофора вычисляется (красный)', window.eval('state.lightGreen') === false, String(window.eval('state.lightGreen')));
  window.eval('window.__rsNow = () => 1000;'); // 0…6 с — зелёная фаза
  await sleep(120);
  check('фаза светофора переключилась (зелёный)', window.eval('state.lightGreen') === true);
  check('событие светофора попало в статистику',
    (window.RSConsole.stats.summary().lights.red + window.RSConsole.stats.summary().lights.green) >= 1);

  // 9. Стенд-выход, интерлок замка на старт миссии
  stand.checked = false;
  stand.dispatchEvent(new window.Event('change', { bubbles: true }));
  check('стенд выключен', window.eval('state.serviceStand') === false);
  window.eval('state.cargoLock = false;');
  click(window.document.getElementById('btn-start-mission'));
  check('старт миссии при открытой ячейке заблокирован', window.eval('state.mission') !== 'NAVIGATE', window.eval('state.mission'));
  window.eval('state.cargoLock = true;');

  // 9.1. Выдача груза: без PIN ячейка не открывается, груз не выдаётся
  window.eval('state.cargo = true; state.cargoLock = true; state.x = 9.5; state.y = -1.2;');
  check('выгрузка запрещена при закрытой ячейке', window.eval('doUnload()') === false);
  ['2', '5', '8', '0'].forEach(press);
  click(openBtn);
  await sleep(120);
  check('PIN открыл ячейку повторно', window.RSConsole.isLockOpen() === true);
  check('выгрузка разрешена из открытой ячейки', window.eval('doUnload()') === true);
  check('статистика видит выгрузку (груза больше нет)', window.eval('state.cargo') === false);
  click(window.document.getElementById('csl-pin-close'));
  check('ячейка закрыта после выдачи', window.RSConsole.isLockOpen() === false);

  // 9.2. Точка отправления рейса подставляется по расположению
  window.eval('state.origin = "база"; state.x = -9.5; state.y = -1.2; goToStation("load");');
  check('origin рейса = площадка А', window.eval('state.origin') === 'площадка A', String(window.eval('state.origin')));

  // 9.3. Ввод PIN с физической клавиатуры (цифры + Enter)
  const kb = (key) => window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true }));
  kb('5'); kb('8'); kb('5'); kb('2');
  check('клавиатура набрала PIN (маска 4 знака)', window.document.getElementById('csl-pin-dots').textContent === '••••',
    window.document.getElementById('csl-pin-dots').textContent);
  kb('Backspace');
  check('Backspace удалил цифру', window.document.getElementById('csl-pin-dots').textContent === '•••');
  kb('2');
  check('после дозвона снова 4 цифры', window.document.getElementById('csl-pin-dots').textContent === '••••');
  kb('Escape');
  check('Esc очистил ввод', window.document.getElementById('csl-pin-dots').textContent === '— — — —');
  kb('9'); kb('9'); kb('9'); kb('9');
  kb('Enter');
  await sleep(80);
  check('Enter отправил PIN на проверку', window.document.getElementById('csl-pin-msg').textContent.includes('Неверный PIN'),
    window.document.getElementById('csl-pin-msg').textContent);
  kb('Escape');

  // 9.4. И-1: панель быстрых действий
  check('панель быстрых действий отрисована', !!window.document.getElementById('csl-toolbar'));
  check('чип ячейки в панели обновляется', /ячейка: (закрыта|ОТКРЫТА)/.test(window.document.getElementById('csl-tb-lock').textContent),
    window.document.getElementById('csl-tb-lock').textContent);
  check('чип E-STOP в панели', window.document.getElementById('csl-tb-estop').textContent.length > 0);
  check('сводка рейсов в панели', /рейсы: \d+/.test(window.document.getElementById('csl-tb-trip').textContent),
    window.document.getElementById('csl-tb-trip').textContent);
  click(window.document.getElementById('csl-tb-stand'));
  check('чип «автономия» переключает стенд', window.eval('state.serviceStand') === true);
  click(window.document.getElementById('csl-tb-stand'));
  check('повторный клик выключает стенд', window.eval('state.serviceStand') === false);

  // 9.5. И-2: палитра команд
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
  check('Ctrl+K открыл палитру команд', !window.document.getElementById('csl-palette').classList.contains('hidden'));
  const pin = window.document.getElementById('csl-palette-input');
  pin.value = 'хоминг';
  pin.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('фильтр палитры нашёл команду', window.document.querySelectorAll('#csl-palette-list .csl-pitem').length === 1,
    String(window.document.querySelectorAll('#csl-palette-list .csl-pitem').length));
  pin.value = 'неттакойкоманды';
  pin.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('пустой результат палитры', window.document.getElementById('csl-palette-list').textContent.includes('Ничего не найдено'));
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Esc закрыл палитру', window.document.getElementById('csl-palette').classList.contains('hidden'));

  // 9.6. И-4: автокламп значений с подсветкой
  const stand2 = window.document.getElementById('csl-stand');
  stand2.checked = true; stand2.dispatchEvent(new window.Event('change', { bubbles: true }));
  const steerFR = window.document.getElementById('csl-steer-FR');
  steerFR.value = '250';
  steerFR.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('значение вне диапазона подсвечено', steerFR.classList.contains('csl-invalid'));
  steerFR.dispatchEvent(new window.Event('blur', { bubbles: true }));
  check('автокламп привёл угол к 180', Number(steerFR.value) === 180, steerFR.value);
  window.document.getElementById('csl-pwm-FR').value = '20';
  click(window.document.querySelector('#csl-mod-FR .csl-send[data-ch="traction"]'));
  await sleep(30);
  check('кадр FR содержит ШИМ 200 (0x00C8)', window.document.getElementById('csl-frame-FR').textContent.includes('00 C8'),
    window.document.getElementById('csl-frame-FR').textContent);

  // 9.7. И-5: «мёртвая рука»
  window.eval('state.modules.forEach((m) => { m.homed = true; });');   // хоминг завершён
  const holdBtn = window.document.querySelector('[data-hold="RR"][data-val="20"]');
  holdBtn.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  await sleep(30);
  check('удержание подало тягу +20 %', window.RSConsole.cmd.RR && window.RSConsole.cmd.RR.pwm === 20);
  check('карточка показывает УДЕРЖАНИЕ', window.document.getElementById('csl-state-RR').textContent === 'УДЕРЖАНИЕ');
  window.dispatchEvent(new window.Event('pointerup', { bubbles: true }));
  await sleep(30);
  check('отпускание сбросило тягу в 0', window.RSConsole.cmd.RR.pwm === 0, String(window.RSConsole.cmd.RR.pwm));

  // 9.8. И-6: звук и И-9: крупный интерфейс
  const soundBtn = window.document.getElementById('csl-tb-sound');
  const wasSound = window.RSConsole.settings.sound;
  click(soundBtn);
  check('тумблер звука переключил настройку', window.RSConsole.settings.sound === !wasSound);
  check('настройка звука сохранена', window.localStorage.getItem('rus_slam_sound') === (!wasSound ? '1' : '0'));
  click(soundBtn);
  click(window.document.getElementById('csl-tb-ui'));
  check('крупный интерфейс включён', window.document.body.classList.contains('ui-large'));
  check('масштаб сохранён', window.localStorage.getItem('rus_slam_ui_scale') === 'large');
  click(window.document.getElementById('csl-tb-ui'));
  check('масштаб вернулся к обычному', !window.document.body.classList.contains('ui-large'));

  // 9.9. И-7: модальные окна вместо confirm/alert
  let modalOk = null;
  window.RSConsole.confirmModal('Тест', 'Проверка модального окна', { okText: 'Да' }).then((v) => { modalOk = v; });
  check('модальное окно открылось', !window.document.getElementById('csl-modal').classList.contains('hidden'));
  click(window.document.getElementById('csl-modal-ok'));
  await sleep(30);
  check('модальное окно вернуло «подтверждено»', modalOk === true);
  check('модальное окно закрылось', window.document.getElementById('csl-modal').classList.contains('hidden'));
  click(window.document.querySelector('[data-csl="print"]'));
  check('предпросмотр отчёта открылся', window.document.getElementById('csl-modal-body').textContent.includes('Оператор смены'));
  click(window.document.getElementById('csl-modal-cancel'));
  click(window.document.getElementById('csl-tb-help'));
  check('справка показывает горячие клавиши', window.document.getElementById('csl-modal-body').textContent.includes('Ctrl'));
  click(window.document.getElementById('csl-modal-ok'));

  // 9.10. И-8: журнал сервисных действий с фильтрами и копированием
  check('журнал окна накопил записи', window.RSConsole.journal.items.length > 0,
    String(window.RSConsole.journal.items.length));
  check('фильтр «ошибки» работает', (() => {
    window.document.querySelector('[data-jfilter="err"]').click();
    const rows = [...window.document.querySelectorAll('#csl-journal-rows .csl-jrow')];
    return rows.length === 0 || rows.every((r) => r.classList.contains('err'));
  })());
  window.document.querySelector('[data-jfilter="all"]').click();
  const q = window.document.getElementById('csl-journal-q');
  q.value = 'UART';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('поиск по журналу фильтрует строки',
    [...window.document.querySelectorAll('#csl-journal-rows .csl-jrow')].every((r) => r.textContent.includes('UART')));
  q.value = '';
  q.dispatchEvent(new window.Event('input', { bubbles: true }));
  check('кнопка копирования кадра есть в строках', !!window.document.querySelector('#csl-journal-rows [data-copy]'));
  click(window.document.getElementById('csl-copy-frame'));
  await sleep(30);
  const copied = window.document.getElementById('csl-journal-rows').textContent;
  const frameModal = window.document.getElementById('csl-modal-body').textContent;
  check('копирование кадра: отчёт в журнале или окно с кадром',
    copied.includes('Скопировано') || /([0-9A-F]{2} ){9}[0-9A-F]{2}/.test(frameModal),
    copied.slice(0, 120));
  if (!window.document.getElementById('csl-modal').classList.contains('hidden')) {
    click(window.document.getElementById('csl-modal-ok'));
  }

  // 9.11. И-10: синхронизация между окнами через storage-событие
  const remote = JSON.stringify({ open: true, kind: 'QR', at: Date.now(), by: 'other' });
  window.localStorage.setItem('rus_slam_lock_state_v1', remote);
  window.dispatchEvent(new window.StorageEvent('storage', { key: 'rus_slam_lock_state_v1', newValue: remote }));
  await sleep(50);
  check('состояние ячейки принято из другого окна', window.RSConsole.isLockOpen() === true);
  check('в журнале есть отметка о другом окне',
    window.document.getElementById('csl-journal-rows').textContent.includes('другом окне'));
  window.eval('state.cargoLock = true;');

  // 9.12. Возврат стенда и интерлоков в исходное состояние
  const stand3 = window.document.getElementById('csl-stand');
  stand3.checked = false; stand3.dispatchEvent(new window.Event('change', { bubbles: true }));

  // 10. Ошибки страницы
  const realProblems = problems.filter((p) => !/Хоминг|не найдена|CSS/.test(p));
  check('без ошибок jsdom/console', realProblems.length === 0, realProblems.join('\n'));

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.extra ? '\n        ' + r.extra : ''));
  console.log('\nИТОГО jsdom: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  if (realProblems.length) console.log('Замечания консоли:\n' + realProblems.join('\n'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS CRASH', e); process.exit(2); });
