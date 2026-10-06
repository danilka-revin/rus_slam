/* Дымовые тесты основного экрана робота (main.html) в jsdom.
 * Запуск:  NODE_PATH=/tmp/harness/node_modules node gui/tests/main.screen.test.js
 *
 * Отдельно проверяется, что в интерфейсе нет дублей: у каждого действия ровно
 * один орган управления, состояние показывается в одном месте.
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const GUI = path.join(__dirname, '..');
let problems = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => problems.push('jsdomError: ' + (e.stack || e.message)));
vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));

const dom = new JSDOM(fs.readFileSync(path.join(GUI, 'main.html'), 'utf8'), {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://rus-slam.test/main.html',
  virtualConsole: vc,
});
const { window } = dom;

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: ok ? '' : (extra || '') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
const txt = (id) => window.document.getElementById(id).textContent;
const norm = (s) => s.replace(/\s+/g, ' ').trim().toLowerCase();

(async () => {
  const script = window.document.createElement('script');
  script.textContent = fs.readFileSync(path.join(GUI, 'main.js'), 'utf8');
  window.document.body.appendChild(script);
  await sleep(500);

  // 1. Разметка и запуск
  check('4 карточки двигателей FL/FR/RL/RR', window.document.querySelectorAll('.mcard').length === 4,
    String(window.document.querySelectorAll('.mcard').length));
  check('клавиатура отсека: 12 клавиш', window.document.querySelectorAll('#sc-keypad .sc-key').length === 12);
  check('кольцо АКБ отрисовано', !!window.document.getElementById('sc-ring-fill'));
  check('часы идут', /\d{2}:\d{2}:\d{2}/.test(txt('sc-clock')), txt('sc-clock'));
  check('шапка показывает режим', txt('sc-mode').includes('АВТОНОМНЫЙ'), txt('sc-mode'));

  // 2. Живые показания (демо-цикл)
  const rpmBefore = txt('mc-rpm-FL');
  const socBefore = txt('sc-soc');
  await sleep(900);
  check('угол руля показывается в градусах', /°/.test(txt('mc-angle-FL')), txt('mc-angle-FL'));
  check('кольцо АКБ заполнено', /[\d.]+ [\d.]+/.test(window.document.getElementById('sc-ring-fill').style.strokeDasharray),
    window.document.getElementById('sc-ring-fill').style.strokeDasharray);
  check('заряд показан в процентах', /%/.test(txt('sc-soc')), txt('sc-soc'));
  check('напряжение в вольтах', /В/.test(txt('sc-volts')), txt('sc-volts'));
  check('показания меняются во времени', txt('mc-rpm-FL') !== rpmBefore || txt('sc-soc') !== socBefore);
  check('статус модуля отображается', /готов|движение|перегрев|хоминг/.test(txt('mc-state-FL')), txt('mc-state-FL'));

  // 3. PIN-код грузового отсека
  const key = (d) => click([...window.document.querySelectorAll('#sc-keypad .sc-key')].find((b) => b.dataset.key === d));
  const keys = () => [...window.document.querySelectorAll('#sc-keypad .sc-key')].map((b) => b.dataset.key);
  key('1'); key('2'); key('3');
  check('ввод PIN отражается точками', txt('sc-pin-dots').replace(/\s/g, '') === '•••', txt('sc-pin-dots'));
  key('⌫');
  check('«⌫» удаляет одну цифру', txt('sc-pin-dots').replace(/\s/g, '') === '••', txt('sc-pin-dots'));
  key('СБРОС');
  check('«СБРОС» очищает ввод', txt('sc-pin-dots').includes('—'));
  check('после «СБРОС» показана подсказка, а не состояние замка',
    txt('sc-pin-msg').includes('Введите PIN-код'), txt('sc-pin-msg'));

  key('9'); key('9'); key('9'); key('9');
  click(window.document.getElementById('sc-btn-open'));
  check('неверный PIN: сообщение об ошибке', txt('sc-pin-msg').includes('Неверный PIN'), txt('sc-pin-msg'));
  check('состояние осталось «ЗАКРЫТО»', txt('sc-lock-state') === 'ЗАКРЫТО');

  key('2'); key('5'); key('8'); key('0');
  click(window.document.getElementById('sc-btn-open'));
  check('верный PIN открыл отсек', txt('sc-lock-state') === 'ОТКРЫТО');
  check('кнопка стала «Закрыть отсек»', txt('sc-btn-open').includes('Закрыть'), txt('sc-btn-open'));
  check('чип отсека зелёный', window.document.getElementById('sc-lock-state').className.includes('sc-chip-open'));
  check('груз помечен доступным', txt('sc-cargo-state').includes('доступен'), txt('sc-cargo-state'));
  check('строка груза не повторяет состояние замка',
    !/открыт|закрыт|заперт/i.test(txt('sc-cargo-state')), txt('sc-cargo-state'));
  check('ввод после открытия очищен', txt('sc-pin-dots').includes('—'));

  // 4. Блокировка после 5 неудач (сначала штатно закрываем отсек)
  await window.RS_MAIN.closeCargo();
  await sleep(50);
  check('отсек закрыт перед проверкой блокировки', window.RS_MAIN.lockView().open === false);
  let blocked = false;
  for (let i = 0; i < 5; i++) {
    key('1'); key('1'); key('1'); key('1');
    click(window.document.getElementById('sc-btn-open'));
    if (txt('sc-lock-state').includes('БЛОКИРОВКА')) { blocked = true; break; }
  }
  check('5 неудач → блокировка ввода', blocked, txt('sc-lock-state'));
  check('кнопка «Открыть» заблокирована', window.document.getElementById('sc-btn-open').disabled === true);

  // 4.1. Режим данных: без fetch (jsdom) экран уходит в демо-режим
  check('чип источника данных показывает демо-режим', txt('sc-data').includes('демо'), txt('sc-data'));
  check('ссылка на инженерный пульт есть в подвале',
    !!window.document.getElementById('sc-console-link') &&
    window.document.getElementById('sc-console-link').getAttribute('href') === 'index.html');
  check('журнал доступа выводится в подвал', /журнал:/.test(txt('sc-foot-event')), txt('sc-foot-event'));

  // 5. Нет дублей органов управления
  const doc = window.document;
  const ids = [...doc.querySelectorAll('[id]')].map((el) => el.id);
  const dupIds = ids.filter((id, i) => ids.indexOf(id) !== i);
  check('нет повторяющихся id', dupIds.length === 0, dupIds.join(', '));
  check('на экране ровно одна кнопка отсека', doc.querySelectorAll('.sc-lock-buttons button').length === 1,
    String(doc.querySelectorAll('.sc-lock-buttons button').length));
  const visibleButtons = [...doc.querySelectorAll('.sc-btn')].map((b) => norm(b.textContent));
  const dupBtn = visibleButtons.filter((t, i) => visibleButtons.indexOf(t) !== i);
  check('нет двух кнопок с одинаковой надписью', dupBtn.length === 0, visibleButtons.join(' | '));
  const clears = [...doc.querySelectorAll('#sc-keypad .sc-key')].filter((b) => b.dataset.key === 'СБРОС');
  check('очистка ввода — только одна клавиша «СБРОС»', clears.length === 1, String(clears.length));
  check('клавиша «СБРОС» размечена как очистка ввода',
    clears[0] && clears[0].getAttribute('aria-label') === 'очистить ввод',
    clears[0] && clears[0].getAttribute('aria-label'));
  check('«⌫» — это удаление одной цифры, а не очистка', keys().includes('⌫') && keys().includes('СБРОС'));
  check('порядок нижнего ряда клавиатуры: ⌫ 0 СБРОС', keys().slice(9).join(' ') === '⌫ 0 СБРОС', keys().slice(9).join(' '));
  check('канал связи и модули на связи подписаны по-разному',
    !norm(txt('sc-link-text')).includes('модули') && /модули на связи/.test(txt('sc-motors-sum')));

  // 6. Ошибок страницы нет
  check('без ошибок jsdom/console', problems.length === 0, problems.join('\n'));

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.extra ? '\n        ' + r.extra : ''));
  console.log('\nИТОГО основной экран: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
