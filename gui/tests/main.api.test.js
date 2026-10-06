/* Сквозной тест «основной экран ↔ бэкенд»: main.html в jsdom с реальным
 * gui/backend.py на случайном порту и окном fetch, проксирующим запросы.
 *
 * Запуск:  NODE_PATH=/tmp/harness/node_modules node gui/tests/main.api.test.js
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { JSDOM, VirtualConsole } = require('jsdom');

const REPO = path.join(__dirname, '..', '..');
const GUI = path.join(REPO, 'gui');

const results = [];
const check = (name, ok, extra) => results.push({ name, ok: !!ok, extra: ok ? '' : (extra || '') });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitHealth(base, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return true;
    } catch (err) { /* сервер ещё поднимается */ }
    await sleep(150);
  }
  return false;
}

(async () => {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const lockFile = path.join(os.tmpdir(), 'rus_slam_lock_' + port + '.json');

  const backend = spawn('python3', [path.join(GUI, 'backend.py'),
    '--port', String(port), '--host', '127.0.0.1', '--source', 'sim',
    '--pin', '2580', '--lock-file', lockFile], { cwd: REPO, stdio: 'ignore' });

  let dom = null;
  try {
    const up = await waitHealth(base, 15000);
    check('бэкенд поднялся и отвечает /api/health', up);
    if (!up) throw new Error('бэкенд не поднялся');

    // --- jsdom с окном fetch, проксирующим на реальный сервер ---
    let html = fs.readFileSync(path.join(GUI, 'main.html'), 'utf8')
      .replace(/<link[^>]+>/g, '').replace(/<script src="[^"]+"><\/script>/g, '');
    const problems = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => problems.push('jsdomError: ' + (e.stack || e.message)));
    vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));

    dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: base + '/main.html', virtualConsole: vc,
    });
    const { window } = dom;
    window.fetch = (url, opts) => fetch(new URL(url, base + '/main.html').toString(), opts);
    const script = window.document.createElement('script');
    script.textContent = fs.readFileSync(path.join(GUI, 'main.js'), 'utf8');
    window.document.body.appendChild(script);
    await sleep(1200);

    // 1. Экран показывает данные сервера
    const chip = window.document.getElementById('sc-data').textContent;
    check('экран переключился на данные сервера', chip.includes('сервер') && chip.includes('sim'), chip);
    const rpm = Number(window.document.getElementById('mc-rpm-FL').textContent);
    check('об/мин модуля приходят с сервера (не демо-нули)', rpm > 0, String(rpm));
    const soc = window.document.getElementById('sc-soc').textContent;
    check('заряд АКБ в процентах с сервера', /\d+\s*%/.test(soc), soc);
    check('напряжение в диапазоне 12S (29…44,5 В)',
      (() => { const v = parseFloat(window.document.getElementById('sc-volts').textContent.replace(',', '.')); return v > 29 && v < 44.5; })(),
      window.document.getElementById('sc-volts').textContent);

    // 2. PIN через API: сначала неверный
    const key = (d) => window.document.querySelector('#sc-keypad [data-key="' + d + '"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const openBtn = window.document.getElementById('sc-btn-open');
    ['1', '1', '1', '1'].forEach(key);
    openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(400);
    check('неверный PIN: экран получил остаток попыток от сервера',
      window.document.getElementById('sc-pin-msg').textContent.includes('Осталось попыток: 4'),
      window.document.getElementById('sc-pin-msg').textContent);

    // 3. Верный PIN открывает отсек через API
    ['2', '5', '8', '0'].forEach(key);
    openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(500);
    check('верный PIN: отсек ОТКРЫТО на экране',
      window.document.getElementById('sc-lock-state').textContent === 'ОТКРЫТО',
      window.document.getElementById('sc-lock-state').textContent);
    const state1 = await (await fetch(base + '/api/state')).json();
    check('состояние замка на сервере тоже открыто', state1.data.lock.open === true);
    check('груз помечен как доступный на экране',
      window.document.getElementById('sc-cargo-state').textContent.includes('ОТКРЫТ'));
    check('кнопка предлагает закрыть отсек', openBtn.textContent.includes('Закрыть'), openBtn.textContent);

    // 4. Аудит попал в журнал и на экран
    const audit = await (await fetch(base + '/api/audit?limit=5')).json();
    check('аудит: есть отказ и разрешение', audit.audit.some((e) => !e.ok) && audit.audit.some((e) => e.ok),
      audit.audit.map((e) => e.action + ':' + e.ok).join(', '));
    check('аудит: цепочка целостна', audit.integrity.ok === true, audit.integrity);
    await sleep(200);
    check('строка журнала появилась в подвале экрана',
      /журнал: (доступ разрешён|отказ в доступе)/.test(window.document.getElementById('sc-foot-event').textContent),
      window.document.getElementById('sc-foot-event').textContent);

    // 5. Закрытие через экран
    openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await sleep(500);
    check('закрытие отсека с экрана прошло', window.document.getElementById('sc-lock-state').textContent === 'ЗАКРЫТО');
    const state2 = await (await fetch(base + '/api/state')).json();
    check('сервер подтверждает закрытие', state2.data.lock.open === false);

    // 6. Блокировка после 5 неудач — считает сервер
    let attempts = 0;
    while (attempts < 8 && !window.document.getElementById('sc-lock-state').textContent.includes('БЛОКИРОВКА')) {
      ['9', '9', '9', '9'].forEach(key);
      openBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      attempts += 1;
      await sleep(400);
    }
    check('не более 5 попыток до блокировки', attempts <= 6, 'попыток: ' + attempts);
    check('после 5 неудач экран показывает БЛОКИРОВКУ',
      window.document.getElementById('sc-lock-state').textContent.includes('БЛОКИРОВКА'),
      window.document.getElementById('sc-lock-state').textContent);
    check('кнопка открытия заблокирована сервером', openBtn.disabled === true);

    check('без ошибок в консоли страницы', problems.length === 0, problems.join('\n'));
  } catch (err) {
    check('сквозной прогон без исключений', false, err && err.message);
  } finally {
    if (dom) dom.window.close();
    backend.kill('SIGTERM');
    await sleep(300);
    try { fs.unlinkSync(lockFile); } catch (e) { /* уже удалён */ }
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.extra ? '\n        ' + r.extra : ''));
  console.log('\nИТОГО экран+API: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
