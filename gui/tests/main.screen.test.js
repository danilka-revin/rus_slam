/* Дымовые тесты основного экрана робота (main.html) в jsdom.
 * Запуск:  NODE_PATH=/tmp/harness/node_modules node gui/tests/main.screen.test.js
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
  check('часы идут', /\d{2}:\d{2}:\d{2}/.test(window.document.getElementById('sc-clock').textContent),
    window.document.getElementById('sc-clock').textContent);
  check('шапка показывает режим', window.document.getElementById('sc-mode').textContent.includes('АВТОНОМНЫЙ'),
    window.document.getElementById('sc-mode').textContent);

  // 2. Живые показания (демо-цикл)
  const rpmBefore = window.document.getElementById('mc-rpm-FL').textContent;
  const socBefore = window.document.getElementById('sc-soc').textContent;
  await sleep(900);
  check('угол руля показывается в градусах', /°/.test(window.document.getElementById('mc-angle-FL').textContent),
    window.document.getElementById('mc-angle-FL').textContent);
  check('кольцо АКБ заполнено', /[\d.]+ [\d.]+/.test(window.document.getElementById('sc-ring-fill').style.strokeDasharray),
    window.document.getElementById('sc-ring-fill').style.strokeDasharray);
  check('заряд показан в процентах', /%/.test(window.document.getElementById('sc-soc').textContent),
    window.document.getElementById('sc-soc').textContent);
  check('напряжение в вольтах', /В/.test(window.document.getElementById('sc-volts').textContent),
    window.document.getElementById('sc-volts').textContent);
  check('показания меняются во времени',
    window.document.getElementById('mc-rpm-FL').textContent !== rpmBefore ||
    window.document.getElementById('sc-soc').textContent !== socBefore);
  check('статус модуля отображается', /готов|движение|перегрев|хоминг/.test(window.document.getElementById('mc-state-FL').textContent),
    window.document.getElementById('mc-state-FL').textContent);

  // 3. PIN-код грузового отсека
  const key = (d) => click([...window.document.querySelectorAll('#sc-keypad .sc-key')].find((b) => b.dataset.key === d));
  key('1'); key('2'); key('3');
  check('ввод PIN отражается точками', window.document.getElementById('sc-pin-dots').textContent.replace(/\s/g, '') === '•••',
    window.document.getElementById('sc-pin-dots').textContent);
  click(window.document.getElementById('sc-btn-clear'));
  check('сброс очищает ввод', window.document.getElementById('sc-pin-dots').textContent.includes('—'));

  key('9'); key('9'); key('9'); key('9');
  click(window.document.getElementById('sc-btn-open'));
  check('неверный PIN: сообщение об ошибке', window.document.getElementById('sc-pin-msg').textContent.includes('Неверный PIN'),
    window.document.getElementById('sc-pin-msg').textContent);
  check('состояние осталось «ЗАКРЫТО»', window.document.getElementById('sc-lock-state').textContent === 'ЗАКРЫТО');

  key('2'); key('5'); key('8'); key('0');
  click(window.document.getElementById('sc-btn-open'));
  check('верный PIN открыл отсек', window.document.getElementById('sc-lock-state').textContent === 'ОТКРЫТО');
  check('кнопка стала «Закрыть отсек»', window.document.getElementById('sc-btn-open').textContent.includes('Закрыть'),
    window.document.getElementById('sc-btn-open').textContent);
  check('чип отсека зелёный', window.document.getElementById('sc-lock-state').className.includes('sc-chip-open'));
  check('груз помечен доступным', window.document.getElementById('sc-cargo-state').textContent.includes('ОТКРЫТ'));
  check('ввод после открытия очищен', window.document.getElementById('sc-pin-dots').textContent.includes('—'));

  // 4. Блокировка после 5 неудач (сначала штатно закрываем отсек)
  await window.RS_MAIN.closeCargo();
  await sleep(50);
  check('отсек закрыт перед проверкой блокировки', window.RS_MAIN.lock.open === false);
  let blocked = false;
  for (let i = 0; i < 5; i++) {
    key('1'); key('1'); key('1'); key('1');
    click(window.document.getElementById('sc-btn-open'));
    if (window.document.getElementById('sc-lock-state').textContent.includes('БЛОКИРОВКА')) { blocked = true; break; }
  }
  check('5 неудач → блокировка ввода', blocked, window.document.getElementById('sc-lock-state').textContent);
  check('кнопка «Открыть» заблокирована', window.document.getElementById('sc-btn-open').disabled === true);

  // 4.1. Режим данных: без fetch (jsdom) экран уходит в демо-режим
  check('чип источника данных показывает демо-режим',
    window.document.getElementById('sc-data').textContent.includes('демо'),
    window.document.getElementById('sc-data').textContent);
  check('ссылка на инженерный пульт есть в подвале',
    !!window.document.getElementById('sc-console-link') &&
    window.document.getElementById('sc-console-link').getAttribute('href') === 'index.html');
  check('журнал доступа выводится в подвал',
    /журнал:/.test(window.document.getElementById('sc-foot-event').textContent),
    window.document.getElementById('sc-foot-event').textContent);

  // 5. Ошибок страницы нет
  check('без ошибок jsdom/console', problems.length === 0, problems.join('\n'));

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.extra ? '\n        ' + r.extra : ''));
  console.log('\nИТОГО основной экран: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', e); process.exit(2); });
