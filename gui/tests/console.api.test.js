/* Сквозной тест «инженерный пульт ↔ борт»: index.html в jsdom с реальным
 * gui/backend.py. Проверяется главное: PIN и журнал у пульта и основного
 * экрана ОДНИ И ТЕ ЖЕ (замок живёт на борту, а не в браузере).
 *
 * Запуск:  NODE_PATH=/tmp/harness/node_modules node gui/tests/console.api.test.js
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
    } catch (err) { /* сервер поднимается */ }
    await sleep(150);
  }
  return false;
}

(async () => {
  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const lockFile = path.join(os.tmpdir(), 'rus_slam_console_lock_' + port + '.json');

  const backend = spawn('python3', [path.join(GUI, 'backend.py'),
    '--port', String(port), '--host', '127.0.0.1', '--source', 'sim',
    '--pin', '2580', '--lock-file', lockFile], { cwd: REPO, stdio: 'ignore' });

  let dom = null;
  try {
    check('бэкенд поднялся', await waitHealth(base, 15000));
    if (!(await waitHealth(base, 100))) throw new Error('бэкенд не поднялся');

    let html = fs.readFileSync(path.join(GUI, 'index.html'), 'utf8')
      .replace(/<link[^>]+>/g, '').replace(/<script src="[^"]+"><\/script>/g, '');
    const problems = [];
    const vc = new VirtualConsole();
    vc.on('jsdomError', (e) => problems.push('jsdomError: ' + (e.stack || e.message)));
    vc.on('error', (...a) => problems.push('console.error: ' + a.join(' ')));

    dom = new JSDOM(html, {
      runScripts: 'dangerously', pretendToBeVisual: true, url: base + '/index.html', virtualConsole: vc,
    });
    const { window } = dom;
    window.fetch = (url, opts) => fetch(new URL(url, base + '/index.html').toString(), opts);
    // canvas 2d-контекст: заглушка (jsdom без нативного canvas)
    const ctxStub = () => new Proxy({}, {
      get(t, p) {
        if (p in t) return t[p];
        if (p === 'measureText') return () => ({ width: 24 });
        if (p === 'createLinearGradient' || p === 'createRadialGradient') return () => ({ addColorStop() {} });
        if (p === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
        return () => {};
      },
      set(t, p, v) { t[p] = v; return true; },
    });
    window.HTMLCanvasElement.prototype.getContext = function () { return ctxStub(); };

    for (const f of ['console-core.js', 'vision.js', 'console.js']) {
      const s = window.document.createElement('script');
      s.textContent = fs.readFileSync(path.join(GUI, f), 'utf8');
      window.document.body.appendChild(s);
    }
    await sleep(1500);

    const doc = window.document;
    const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    const key = (d) => click([...doc.querySelectorAll('#csl-keypad button[data-key]')]
      .find((b) => b.dataset.key === d));

    check('пульт переключился на замок борта', window.RSConsole.vault.mode === 'api',
      String(window.RSConsole.vault.mode));

    // 1. Открытие по PIN с пульта видно серверу и, значит, основному экрану
    key('2'); key('5'); key('8'); key('0');
    click(doc.getElementById('csl-pin-open'));
    await sleep(600);
    const st1 = await (await fetch(base + '/api/state')).json();
    check('PIN 2580 с пульта открыл отсек на борту', st1.data.lock.open === true);
    check('пульт показывает ячейку открытой', window.RSConsole.isLockOpen() === true);

    // 2. Закрытие с пульта тоже уходит на борт
    click(doc.getElementById('csl-pin-close'));
    await sleep(600);
    const st2 = await (await fetch(base + '/api/state')).json();
    check('закрытие с пульта закрыло отсек на борту', st2.data.lock.open === false);

    // 3. Открытие на основном экране (эмуляция клиента киоска) видно пульту
    await fetch(base + '/api/lock/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '2580' }),
    });
    await sleep(1400);
    check('открытие с основного экрана подхвачено пультом', window.RSConsole.isLockOpen() === true,
      'ячейка: ' + window.RSConsole.isLockOpen());

    // 4. Смена PIN из сервисного окна меняет PIN на борту
    doc.getElementById('csl-pin-cur').value = '2580';
    doc.getElementById('csl-pin-new').value = '4321';
    doc.getElementById('csl-pin-rep').value = '4321';
    click(doc.getElementById('csl-pin-change'));
    await sleep(800);

    const oldPin = await (await fetch(base + '/api/lock/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '2580' }),
    })).json();
    check('старый PIN на борту больше не действует', oldPin.ok === false, JSON.stringify(oldPin).slice(0, 120));

    const newPin = await (await fetch(base + '/api/lock/open', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: '4321' }),
    })).json();
    check('новый PIN с пульта действует на борту', newPin.ok === true, JSON.stringify(newPin).slice(0, 120));
    const st3 = await (await fetch(base + '/api/state')).json();
    check('новый PIN открыл отсек на борту', st3.data.lock.open === true);
    await sleep(1400);
    check('пульт увидел открытие, сделанное через новый PIN', window.RSConsole.isLockOpen() === true,
      'ячейка: ' + window.RSConsole.isLockOpen());
    await fetch(base + '/api/lock/close', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    await sleep(1400);
    check('пульт увидел закрытие отсека с борта', window.RSConsole.isLockOpen() === false,
      'ячейка: ' + window.RSConsole.isLockOpen());

    // 5. Журнал пульта — это журнал борта (с хеш-цепочкой)
    const audit = await (await fetch(base + '/api/audit?limit=6')).json();
    check('в журнале борта есть смена PIN', audit.audit.some((e) => e.action === 'pin_change'));
    check('цепочка журнала целостна', audit.integrity.ok === true);
    await sleep(200);
    const rows = doc.querySelectorAll('#csl-audit tr').length;
    check('пульт показывает журнал борта', rows >= 2, 'строк: ' + rows);

    // 6. QR/RFID в режиме борта не подменяют PIN
    key('9'); key('9'); key('9'); key('9');
    click(doc.getElementById('csl-pin-qr'));
    await sleep(300);
    check('QR в режиме борта не открывает отсек', window.RSConsole.isLockOpen() === false);
    check('пульт объясняет причину', /считыватель/i.test(doc.getElementById('csl-pin-msg').textContent),
      doc.getElementById('csl-pin-msg').textContent);

    check('без ошибок в консоли страницы', problems.length === 0, problems.join('\n'));
  } catch (err) {
    check('сквозной прогон без исключений', false, err && (err.stack || err.message));
  } finally {
    if (dom) dom.window.close();
    backend.kill('SIGTERM');
    await sleep(300);
    try { fs.unlinkSync(lockFile); } catch (e) { /* уже удалён */ }
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) console.log((r.ok ? '  ok   ' : '  FAIL ') + r.name + (r.extra ? '\n        ' + r.extra : ''));
  console.log('\nИТОГО пульт+борт: ' + (results.length - failed.length) + ' passed, ' + failed.length + ' failed');
  process.exit(failed.length ? 1 : 0);
})();
