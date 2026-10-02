/* ============================================================================
 * console.js — окно «Сервис» веб-пульта RUS SLAM (DOM-слой).
 *
 * Технический план: docs/SERVICE_CONSOLE.md.
 * Ядро без DOM: gui/console-core.js (window.RS), тесты gui/tests/console.test.js.
 *
 * Панели окна:
 *   1) Ячейка хранения — PIN-клавиатура, QR/RFID, смена PIN, аудит доступа;
 *   2) Двигатели — 4 модуля × 2 канала (руль/тяга): поле ввода + кнопка «Ввод»,
 *      джоги, факт телеметрии, HEX кадра UART;
 *   3) АКБ 12S3P LiFePO4 — напряжение, SOC, ток, мощность, ячейки, запас хода;
 *   4) Статистика — KPI, рейсы, экспорт CSV/JSON/печать, сброс.
 *
 * Загружается последним: <script console-core → vision → app → console>.
 * Все внешние вызовы — опциональные (window.RS может отсутствовать).
 * ========================================================================== */
(function () {
  'use strict';

  const RS = window.RS;
  if (!RS) {
    console.warn('console.js: ядро RS (console-core.js) не загружено — окно «Сервис» выключено');
    return;
  }

  const $ = (id) => document.getElementById(id);
  const storage = RS.safeStorage('localStorage');
  const F = RS.fmt;

  /* --------------------------------------------------------------------- */
  /* Состояние слоя                                                        */
  /* --------------------------------------------------------------------- */
  const stats = new RS.StatsStore(storage, { tripCapacity: 200 });
  stats.flush();
  RS._onTripStart = (trip) => { try { event('nav', 'рейс №' + trip.id + ' начат: ' + trip.route); } catch (e) {} };
  RS._onTripEnd = (trip) => { try { event('ok', 'рейс №' + trip.id + ' завершён: ' + F.km(trip.distanceM) + ', ' + F.wh(trip.energyWh)); } catch (e) {} };

  const vault = new RS.PinVault(storage, {
    key: 'rus_slam_lock_v1',
    maxAttempts: 5,
    lockMs: 30000,
    defaultPin: '2580',
    onEvent: (action, ok) => {
      try {
        if (action === 'unlock') stats.noteLock(ok ? 'open' : 'denied');
        else if (action === 'pin_change') stats.noteLock('changed');
      } catch (e) { /* статистика не должна ломать замок */ }
      try {
        if (!window.RSConsole) return;
        if (action === 'unlock') say(ok ? 'ok' : 'warn', ok ? 'замок ячейки: доступ разрешён' : 'замок ячейки: отказ в доступе');
        else if (action === 'pin_change') say('warn', 'замок ячейки: PIN изменён');
      } catch (e) { /* вне пульта (Node/тесты) log отсутствует */ }
    },
  });

  const lock = {
    open: false,
    autoCloseAt: 0,
    lastKind: '—',
    pinBuf: '',
    busy: false,
  };

  const MODULES = [
    { id: 'FL', num: 1, title: 'передний левый' },
    { id: 'FR', num: 2, title: 'передний правый' },
    { id: 'RL', num: 3, title: 'задний левый' },
    { id: 'RR', num: 4, title: 'задний правый' },
  ];
  const MOD_INDEX = {};   // FL → 0 … RR → 3 (порядок state.modules)

  const history = { soc: [], speed: [], t: 0 };
  const frames = {};       // id → HEX последнего кадра
  const cmd = {};          // id → { steer, pwm }

  let lastRender = 0;
  let lastHeavy = 0;
  let ready = false;

  /* --------------------------------------------------------------------- */
  /* Утилиты                                                               */
  /* --------------------------------------------------------------------- */
  function visible() {
    const sec = $('view-console');
    return !!sec && !sec.classList.contains('hidden');
  }

  function modOf(id) {
    const i = MOD_INDEX[id];
    return (state.modules && state.modules[i]) || null;
  }

  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  // Безопасные обёртки: окно не должно падать, если app.js не загрузился.
  function say(level, msg) { if (typeof log === 'function') log(level, msg); }
  function tip(text) { if (typeof toast === 'function') toast(text); }
  function event(type, msg) { if (typeof emit === 'function') emit(type, msg); }

  function download(name, text, mime) {
    try {
      const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      return true;
    } catch (e) {
      tip('Экспорт недоступен в этой среде');
      return false;
    }
  }

  function printReport() {
    const html = stats.reportHTML();
    const w = window.open('', '_blank');
    if (!w) { tip('Разрешите всплывающие окна для отчёта'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => { try { w.print(); } catch (e) {} }, 300);
  }

  /* --------------------------------------------------------------------- */
  /* 1. Замок ячейки хранения                                              */
  /* --------------------------------------------------------------------- */
  const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];

  function renderKeypad() {
    const pad = $('csl-keypad');
    if (!pad) return;
    pad.innerHTML = KEYPAD.map((k) => {
      const cls = k === 'C' ? 'csl-key csl-key-c' : k === '⌫' ? 'csl-key csl-key-b' : 'csl-key';
      return `<button type="button" class="${cls}" data-key="${k}">${k}</button>`;
    }).join('');
    pad.querySelectorAll('button[data-key]').forEach((b) => {
      b.addEventListener('click', () => pressKey(b.dataset.key));
    });
  }

  function pressKey(k) {
    if (vault.isLocked() || lock.busy) return;
    if (k === 'C') lock.pinBuf = '';
    else if (k === '⌫') lock.pinBuf = lock.pinBuf.slice(0, -1);
    else if (lock.pinBuf.length < 8) lock.pinBuf += k;
    renderPin();
  }

  function renderPin() {
    const masked = lock.pinBuf ? '•'.repeat(lock.pinBuf.length) : '';
    setText('csl-pin-dots', masked || '— — — —');
    const inp = $('csl-pin-input');
    if (inp) inp.value = lock.pinBuf;
  }

  async function tryOpen(kind) {
    if (lock.busy) return;
    const pin = lock.pinBuf;
    if (kind === 'pin' && !vault.isLocked() && pin.length < 4) {
      setMsg('Введите от 4 до 8 цифр', 'warn');
      return;
    }
    lock.busy = true;
    try {
      if (vault.isLocked() && kind === 'pin') {
        renderLockStatus();
        return;
      }
      const res = kind === 'pin' ? await vault.verify(pin) : { ok: true, reason: kind };
      if (res.ok) {
        lock.open = true;
        lock.lastKind = kind === 'pin' ? 'PIN' : kind.toUpperCase();
        lock.pinBuf = '';
        renderPin();
        setMsg('Доступ разрешён (' + lock.lastKind + '). Ячейка открыта', 'ok');
        applyLockToSim(true);
        autoClose(true);
        say('ok', 'ячейка хранения открыта (' + lock.lastKind + ')');
      } else if (res.reason === 'locked') {
        setMsg('Ввод заблокирован: ещё ' + Math.ceil(res.remainingMs / 1000) + ' с', 'err');
        renderLockStatus();
      } else if (res.reason === 'format') {
        setMsg('PIN — от 4 до 8 цифр', 'warn');
      } else {
        const left = 5 - (res.fails || 0);
        setMsg('Неверный PIN. Осталось попыток: ' + Math.max(0, left), 'err');
        lock.pinBuf = '';
        renderPin();
        renderLockStatus();
      }
    } finally {
      lock.busy = false;
      renderLock();
    }
  }

  function closeLock(reason) {
    if (!lock.open) return;
    lock.open = false;
    lock.autoCloseAt = 0;
    applyLockToSim(false);
    setMsg('Ячейка закрыта' + (reason ? ' (' + reason + ')' : ''), 'ok');
    say('ok', 'ячейка хранения закрыта');
    renderLock();
  }

  function autoClose(on) {
    lock.autoCloseAt = on ? performance.now() + 30000 : 0;
  }

  function applyLockToSim(open) {
    // Замок — единственный «физический» интерфейс окна: синхронизируем симуляцию.
    try {
      state.cargoLock = !open;
      state.lockOpen = !!open;
      const cb = $('cargo');
      if (cb) cb.checked = !open;
      const pill = $('cargo-state');
      if (pill) pill.textContent = open ? 'отсек ОТКРЫТ' : (state.cargo ? 'груз в отсеке' : 'отсек закрыт');
    } catch (e) { /* симуляция может отсутствовать */ }
  }

  function setMsg(text, cls) {
    const el = $('csl-pin-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'csl-msg ' + (cls || '');
  }

  function renderLockStatus() {
    const rem = vault.lockRemainingMs();
    const chip = $('csl-lock-chip');
    if (chip) {
      const state_ = lock.open ? ['ОТКРЫТО', 'open'] : rem > 0 ? ['БЛОКИРОВКА ' + Math.ceil(rem / 1000) + ' с', 'locked'] : ['ЗАКРЫТО', 'closed'];
      chip.textContent = state_[0];
      chip.className = 'csl-chip csl-chip-' + state_[1];
    }
    const b = $('csl-pin-open');
    if (b) b.disabled = lock.busy || rem > 0;
  }

  function renderAudit() {
    const rows = vault.audit(12).map((e) => `
      <tr>
        <td>${F.time(e.ts)}</td>
        <td>${e.action === 'unlock' ? 'Доступ' : e.action === 'pin_change' ? 'Смена PIN' : e.action}</td>
        <td class="${e.ok ? 'ok' : 'err'}">${e.ok ? 'разрешено' : 'отказ'}</td>
        <td>${e.detail || ''}</td>
      </tr>`).join('');
    setHTML('csl-audit', rows || '<tr><td colspan="4" class="muted">Записей нет</td></tr>');
  }

  function renderLock() {
    renderLockStatus();
    setText('csl-lock-kind', 'Последний доступ: ' + lock.lastKind);
    if (lock.autoCloseAt) {
      const left = Math.max(0, (lock.autoCloseAt - performance.now()) / 1000);
      setText('csl-lock-timer', 'Автозакрытие через ' + left.toFixed(0) + ' с');
      if (left <= 0) { closeLock('таймер 30 с'); return; }
    } else {
      setText('csl-lock-timer', '');
    }
    renderAudit();
  }

  async function changePin() {
    const cur = $('csl-pin-cur') ? $('csl-pin-cur').value.trim() : '';
    const nw = $('csl-pin-new') ? $('csl-pin-new').value.trim() : '';
    const rep = $('csl-pin-rep') ? $('csl-pin-rep').value.trim() : '';
    if (nw !== rep) { setMsg('Новый PIN и повтор не совпадают', 'warn'); return; }
    const res = await vault.setPin(cur, nw);
    if (res.ok) {
      setMsg('PIN изменён', 'ok');
      $('csl-pin-cur').value = $('csl-pin-new').value = $('csl-pin-rep').value = '';
      say('warn', 'PIN ячейки хранения изменён');
    } else {
      setMsg(res.detail || 'Не удалось сменить PIN', 'err');
    }
    renderLock();
  }

  async function showPinChangedAt() {
    await vault.init();
    renderLock();
  }

  /* --------------------------------------------------------------------- */
  /* 2. Двигатели                                                          */
  /* --------------------------------------------------------------------- */
  function mountModules() {
    const box = $('csl-mods');
    if (!box) return;
    MODULES.forEach((m, i) => { MOD_INDEX[m.id] = i; });

    box.innerHTML = MODULES.map((m) => `
      <article class="csl-mod" id="csl-mod-${m.id}">
        <header>
          <b>${m.id}</b>
          <span class="csl-mod-sub">#${m.num} · ${m.title}</span>
          <span class="csl-chip" id="csl-state-${m.id}">—</span>
        </header>
        <div class="csl-field">
          <label for="csl-steer-${m.id}">Руль, °</label>
          <input type="number" id="csl-steer-${m.id}" value="0" min="-180" max="180" step="1" inputmode="numeric" />
          <button type="button" class="csl-send" data-mod="${m.id}" data-ch="steer">Ввод</button>
        </div>
        <div class="csl-jog">
          <button type="button" data-jog="${m.id}" data-ch="steer" data-val="-45">−45°</button>
          <button type="button" data-jog="${m.id}" data-ch="steer" data-val="-5">−5°</button>
          <button type="button" data-jog="${m.id}" data-ch="steer" data-val="5">+5°</button>
          <button type="button" data-jog="${m.id}" data-ch="steer" data-val="45">+45°</button>
          <button type="button" data-home="${m.id}" title="Хоминг модуля">⌂</button>
        </div>
        <div class="csl-field">
          <label for="csl-pwm-${m.id}">Тяга, %</label>
          <input type="number" id="csl-pwm-${m.id}" value="0" min="-100" max="100" step="5" inputmode="numeric" />
          <button type="button" class="csl-send" data-mod="${m.id}" data-ch="traction">Ввод</button>
        </div>
        <div class="csl-jog">
          <button type="button" data-jog="${m.id}" data-ch="traction" data-val="-20">−20 %</button>
          <button type="button" data-jog="${m.id}" data-ch="traction" data-val="0">0</button>
          <button type="button" data-jog="${m.id}" data-ch="traction" data-val="20">+20 %</button>
          <button type="button" data-stop="${m.id}" class="csl-stop">■</button>
        </div>
        <div class="csl-fact" id="csl-fact-${m.id}">телеметрия —</div>
        <pre class="csl-frame" id="csl-frame-${m.id}">кадр: —</pre>
      </article>`).join('');

    box.querySelectorAll('.csl-send').forEach((b) => {
      b.addEventListener('click', () => sendModule(b.dataset.mod, b.dataset.ch, null));
    });
    box.querySelectorAll('[data-jog]').forEach((b) => {
      b.addEventListener('click', () => sendModule(b.dataset.jog, b.dataset.ch, Number(b.dataset.val)));
    });
    box.querySelectorAll('[data-home]').forEach((b) => {
      b.addEventListener('click', () => sendModule(b.dataset.home, 'home', 1));
    });
    box.querySelectorAll('[data-stop]').forEach((b) => {
      b.addEventListener('click', () => sendModule(b.dataset.stop, 'stop', 0));
    });
  }

  function serviceInterlock() {
    if (typeof state === 'undefined') return 'Симуляция недоступна';
    if (state.estop) return 'Снимите E-STOP';
    if (!state.serviceStand) return 'Включите «Сервисный режим · стенд»';
    return null;
  }

  function sendModule(id, ch, quick) {
    const bad = serviceInterlock();
    if (bad) { tip(bad); say('warn', 'ручная команда отклонена: ' + bad); return; }

    const m = modOf(id);
    if (!m) return;
    if (!cmd[id]) cmd[id] = { steer: 0, pwm: 0 };

    const steerEl = $('csl-steer-' + id);
    const pwmEl = $('csl-pwm-' + id);
    let home = false;
    let enable = true;

    if (ch === 'steer') {
      const v = quick === null || quick === undefined ? Number(steerEl.value) : quick;
      cmd[id].steer = Math.max(-180, Math.min(180, Number.isFinite(v) ? v : 0));
      if (steerEl) steerEl.value = cmd[id].steer;
    } else if (ch === 'traction') {
      const v = quick === null || quick === undefined ? Number(pwmEl.value) : quick;
      cmd[id].pwm = Math.max(-100, Math.min(100, Number.isFinite(v) ? v : 0));
      if (pwmEl) pwmEl.value = cmd[id].pwm;
    } else if (ch === 'home') {
      home = true;
      enable = false;
      m.homed = false;
    } else if (ch === 'stop') {
      cmd[id].pwm = 0;
      if (pwmEl) pwmEl.value = 0;
    }

    const frame = RS.uart.buildCommand({
      moduleId: MODULES[MOD_INDEX[id]].num,
      steerCdeg: RS.uart.degToCdeg(cmd[id].steer),
      pwm: RS.uart.pwmFromPercent(cmd[id].pwm),
      enable,
      home,
    });
    const hex = F.hex(frame);
    frames[id] = hex;

    // Применяем к модели: руль — сразу, тяга — через sim() в app.js.
    m.svcSteer = cmd[id].steer;
    m.svcPwm = cmd[id].pwm;
    m.enabled = enable;
    m.cmdAt = Date.now();
    if (home) m.homed = true;

    stats.noteManual(1);
    say('ok', 'UART → ' + id + ' (#' + MODULES[MOD_INDEX[id]].num + '): ' + hex);
    event('nav', 'сервис: ' + id + ' ' + (ch === 'traction' ? cmd[id].pwm + ' %' : ch === 'home' ? 'хоминг' : cmd[id].steer + '°'));

    const fr = $('csl-frame-' + id);
    if (fr) fr.textContent = 'кадр: ' + hex;
    renderModules();
  }

  function renderModules() {
    MODULES.forEach((mm) => {
      const m = modOf(mm.id);
      if (!m) return;
      const c = cmd[mm.id] || { steer: 0, pwm: 0 };
      const err = (m.steer || 0) - c.steer;
      const rpm = state.serviceStand ? c.pwm * 8 : (m.rpm || 0);
      const speed = Math.abs(rpm) * 0.0127 * 2 * Math.PI / 60;
      setText('csl-fact-' + mm.id,
        'руль ' + F.num(m.steer, 1) + '° (задание ' + F.num(c.steer, 0) + '°, ошибка ' + F.num(err, 1) + '°) · ' +
        'ШИМ ' + F.num(c.pwm, 0) + ' % → ' + F.int(rpm) + ' об/мин · ' + F.num(speed, 2) + ' м/с · ' +
        F.num(m.temp, 0) + ' °C · ' + (m.homed ? 'homed' : 'seek'));
      const chip = $('csl-state-' + mm.id);
      if (chip) {
        const st = state.estop ? ['E-STOP', 'locked']
          : !m.homed ? ['ХОМИНГ', 'locked']
          : Math.abs(c.pwm) > 0.5 ? ['ДВИЖЕНИЕ', 'open'] : ['ГОТОВ', 'closed'];
        chip.textContent = st[0];
        chip.className = 'csl-chip csl-chip-' + st[1];
      }
      if (frames[mm.id]) {
        const fr = $('csl-frame-' + mm.id);
        if (fr) fr.textContent = 'кадр: ' + frames[mm.id];
      }
    });
  }

  function allStop() {
    MODULES.forEach((m) => {
      cmd[m.id] = cmd[m.id] || { steer: 0, pwm: 0 };
      cmd[m.id].pwm = 0;
      const el = $('csl-pwm-' + m.id);
      if (el) el.value = 0;
      const mm = modOf(m.id);
      if (mm) { mm.svcPwm = 0; mm.svcSteer = cmd[m.id].steer; }
    });
    say('warn', 'сервис: стоп всех модулей');
    renderModules();
  }

  function syncSteerAll() {
    const v = Number($('csl-steer-all') ? $('csl-steer-all').value : 0) || 0;
    MODULES.forEach((m) => {
      cmd[m.id] = cmd[m.id] || { steer: 0, pwm: 0 };
      cmd[m.id].steer = Math.max(-180, Math.min(180, v));
      const el = $('csl-steer-' + m.id);
      if (el) el.value = cmd[m.id].steer;
      const mm = modOf(m.id);
      if (mm) mm.svcSteer = cmd[m.id].steer;
    });
    say('ok', 'сервис: синхронный угол ' + v + '°');
    renderModules();
  }

  function homeAll() {
    MODULES.forEach((m) => {
      const mm = modOf(m.id);
      if (mm) mm.homed = false;
      frames[m.id] = F.hex(RS.uart.buildCommand({ moduleId: m.num, steerCdeg: 0, pwm: 0, enable: false, home: true }));
    });
    stats.noteManual(1);
    say('warn', 'сервис: хоминг всех модулей');
    renderModules();
  }

  /* --------------------------------------------------------------------- */
  /* 3. АКБ                                                                */
  /* --------------------------------------------------------------------- */
  function packNow() {
    const P = RS.pack;
    const soc = typeof state !== 'undefined' ? state.soc : 0;
    const current = typeof state !== 'undefined' ? state.current : 0;
    const charging = typeof state !== 'undefined' ? state.charging : false;
    const whPerKm = stats.whPerKm();
    return P.packSnapshot({
      soc, current: charging ? -current : current, charging, whPerKm,
      tempC: 28 + Math.abs(current) * 0.12,
      cycles: stats.summary().chargeCycles,
    });
  }

  function spark(canvas, data, opts) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0b1411';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(213,255,69,0.12)';
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      ctx.beginPath(); ctx.moveTo(0, H * i / 4); ctx.lineTo(W, H * i / 4); ctx.stroke();
    }
    const o = opts || {};
    if (!data.length) {
      ctx.fillStyle = '#6b7a74';
      ctx.font = '12px Inter, sans-serif';
      ctx.fillText('накопление данных…', 12, H / 2);
      return;
    }
    const min = o.min !== undefined ? o.min : Math.min.apply(null, data);
    const max = o.max !== undefined ? o.max : Math.max.apply(null, data);
    const span = Math.max(1e-6, max - min);
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = data.length === 1 ? W : (i / (data.length - 1)) * W;
      const y = H - ((v - min) / span) * (H - 8) - 4;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = o.color || '#d5ff45';
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  function renderBattery() {
    const p = packNow();
    const charge = typeof state !== 'undefined' && state.charging;
    setText('csl-bat-v', F.num(p.voltage, 2) + ' В');
    setText('csl-bat-v-sub', 'OCV ' + F.num(p.ocv, 2) + ' В · ' + p.cells.min.toFixed(3) + '…' + p.cells.max.toFixed(3) + ' В/эл (Δ ' + Math.round(p.cells.delta * 1000) + ' мВ)');
    setText('csl-bat-soc', F.num(p.soc, 0) + ' %');
    setText('csl-bat-i', (charge ? '−' : '+') + F.num(Math.abs(p.current), 1) + ' А');
    setText('csl-bat-p', F.num(Math.abs(p.power), 0) + ' Вт · ' + F.num(p.remainingWh, 0) + ' Вт·ч');
    setText('csl-bat-range', 'запас хода ≈ ' + F.num(p.rangeKm, 1) + ' км');
    setText('csl-bat-temp', F.num(p.tempC, 0) + ' °C');
    setText('csl-bat-cycles', String(p.cycles));

    const bar = $('csl-bat-bar');
    if (bar) {
      bar.style.width = Math.max(0, Math.min(100, p.soc)) + '%';
      bar.className = 'csl-bar-fill csl-' + p.level.cls;
    }
    setText('csl-bat-level', p.level.label + ' (порог ' + p.thresholds.lowV + ' / ' + p.thresholds.criticalV + ' В)');
    const lvl = $('csl-bat-level');
    if (lvl) lvl.className = 'csl-level csl-' + p.level.cls;

    // Телеметрия по модулям: кадр 16 Б (vbat_cV, current_mA) — как в протоколе.
    const rows = (state.modules || []).map((m, i) => {
      const share = p.current / (state.modules.length || 4);
      const tlm = RS.uart.buildTelemetry({
        moduleId: i + 1,
        status: (m.homed ? 2 : 0) | (state.estop ? 0 : 1),
        steerCdeg: RS.uart.degToCdeg(m.steer || 0),
        encDelta: Math.round((m.rpm || 0) * 6),
        pwmActual: RS.uart.pwmFromPercent((cmd[m.id] || {}).pwm || 0),
        vbatCv: Math.round((p.voltage - share * RS.pack.PACK.internalR / 4) * 100),
        currentMa: Math.round(share * 1000),
      });
      const t = RS.uart.parseTelemetry(tlm);
      return `<tr>
        <td><b>${m.id}</b></td>
        <td>${F.num(t.vbatV, 2)}</td>
        <td>${F.num(t.currentA, 2)}</td>
        <td>${F.num(m.temp, 0)}</td>
        <td>${m.homed ? 'homed' : 'seek'}</td>
      </tr>`;
    }).join('');
    setHTML('csl-bat-mods', rows);

    history.t += 1;
    history.soc.push(p.soc);
    history.speed.push(typeof state !== 'undefined' ? Math.hypot(state.spdVx || 0, state.spdVy || 0) : 0);
    while (history.soc.length > 600) { history.soc.shift(); history.speed.shift(); }
    spark($('csl-bat-chart'), history.soc, { min: 0, max: 100, color: '#7ddc52' });
    spark($('csl-speed-chart'), history.speed, { min: 0, max: 2.2, color: '#d5ff45' });
  }

  /* --------------------------------------------------------------------- */
  /* 4. Статистика                                                         */
  /* --------------------------------------------------------------------- */
  function kpi(label, value, sub) {
    return `<article class="csl-kpi"><span>${label}</span><b>${value}</b><small>${sub || ''}</small></article>`;
  }

  function renderStats() {
    const s = stats.summary();
    const sess = s.session;
    setHTML('csl-kpi', [
      kpi('Рейсы (сессия)', String(s.trips), 'грузовых: ' + s.cargoTrips),
      kpi('Пробег', F.km(s.distanceM), 'сессия: ' + F.km(sess.distanceM)),
      kpi('Энергия', F.wh(s.energyWh), 'сессия: ' + F.wh(sess.energyWh)),
      kpi('Расход', (s.whPerKm ? F.num(s.whPerKm, 1) : '—') + ' Вт·ч/км', 'по рейсам'),
      kpi('Время в движении', F.dur(s.movingSec), 'ср. скорость ' + F.num(s.avgSpeedKmh, 1) + ' км/ч'),
      kpi('Макс. скорость', F.num(s.maxSpeed, 2) + ' м/с', 'лимит 1,2 м/с'),
      kpi('Перевезено груза', F.kg(s.cargoKg), 'за ' + s.cargoTrips + ' рейсов'),
      kpi('Объезды препятствий', String(s.obstacles), 'знаки: СТОП ' + s.signs.stop + ' · переход ' + s.signs.pedestrian_crossing + ' · неровность ' + s.signs.speed_bump),
      kpi('Светофор', 'красный ' + s.lights.red + ' / зелёный ' + s.lights.green, 'цикл светофора стенда'),
      kpi('Замок ячейки', 'открыт ' + s.locks.open + ' · отказ ' + s.locks.denied, 'смен PIN: ' + s.locks.changed),
      kpi('Ручные команды', String(s.manualOps), 'сервисный стенд'),
      kpi('Сбои и аварии', String(s.faults), 'циклов заряда: ' + s.chargeCycles),
    ].join(''));

    const rows = (s.recentTrips || []).map((t) => `
      <tr>
        <td>№${t.id}</td>
        <td>${F.time(t.startedAt)}</td>
        <td>${t.route}</td>
        <td>${F.km(t.distanceM)}</td>
        <td>${F.wh(t.energyWh)}</td>
        <td>${F.durShort(t.movingSec)}</td>
        <td>${t.cargoKg || 0}</td>
        <td class="${t.result === 'ok' ? 'ok' : 'err'}">${t.result === 'ok' ? 'доставлено' : t.result === 'aborted' ? 'прерван' : t.result}</td>
      </tr>`).join('');
    setHTML('csl-trips', rows || '<tr><td colspan="8" class="muted">Рейсы ещё не зафиксированы — стартуйте миссию</td></tr>');

    const data = (stats.trips || []).slice(-20).map((t) => t.energyWh);
    spark($('csl-trip-chart'), data, { min: 0, color: '#7ddc52' });

    setText('csl-stats-updated', 'обновлено ' + F.time(stats.data.updatedAt));
  }

  /* --------------------------------------------------------------------- */
  /* Рендер и жизненный цикл                                               */
  /* --------------------------------------------------------------------- */
  function render() {
    if (typeof state === 'undefined') return;
    renderLock();
    renderModules();
    renderBattery();
    renderStats();
    const t = $('csl-trips-total');
    if (t) t.textContent = String(stats.summary().trips);
  }

  function tick(now) {
    if (!ready) return;
    if (!visible()) return;
    if (now - lastRender < 250) return;
    lastRender = now;
    try { render(); } catch (e) { console.error('console.js render', e); }
    lastHeavy = now;
  }

  function init() {
    mountModules();
    renderKeypad();
    renderPin();

    $('csl-pin-open') && $('csl-pin-open').addEventListener('click', () => tryOpen('pin'));
    $('csl-pin-close') && $('csl-pin-close').addEventListener('click', () => closeLock('кнопка'));
    $('csl-pin-qr') && $('csl-pin-qr').addEventListener('click', () => tryOpen('qr'));
    $('csl-pin-rfid') && $('csl-pin-rfid').addEventListener('click', () => tryOpen('rfid'));
    $('csl-pin-change') && $('csl-pin-change').addEventListener('click', changePin);
    $('csl-pin-reset') && $('csl-pin-reset').addEventListener('click', async () => {
      const cur = $('csl-pin-cur') ? $('csl-pin-cur').value.trim() : '';
      const res = await vault.resetToDefault(cur);
      setMsg(res.ok ? 'PIN сброшен к заводскому 2580' : (res.detail || 'Сброс не выполнен'), res.ok ? 'ok' : 'err');
      renderLock();
    });

    const pinInput = $('csl-pin-input');
    if (pinInput) {
      pinInput.setAttribute('readonly', 'readonly');
      pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); tryOpen('pin'); }
      });
    }
    // Физическая клавиатура: цифры → PIN, Enter → «Открыть», Backspace/Delete → ⌫, Esc → C.
    document.addEventListener('keydown', (e) => {
      if (!visible() || !ready) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      const el = e.target;
      const typing = el && (el.tagName === 'INPUT' && el !== pinInput || el.tagName === 'TEXTAREA');
      if (typing) return;
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pressKey(e.key); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); pressKey('⌫'); }
      else if (e.key === 'Enter') {
        if (lock.open) return;
        e.preventDefault();
        tryOpen('pin');
      } else if (e.key === 'Escape') { pressKey('C'); }
    });

    $('csl-stand') && $('csl-stand').addEventListener('change', (e) => {
      state.serviceStand = !!e.target.checked;
      if (state.serviceStand) {
        state.auto = false;
        state.progRun = false;
        state.explore = false;
        state.pause = true;
        state.vx = state.vy = state.wz = 0;
        state.spdVx = state.spdVy = state.spdWz = 0;
        event('warn', 'СЕРВИСНЫЙ РЕЖИМ · стенд — автономия заблокирована');
        const b = $('btn-prog-run'); if (b) b.disabled = true;
        const a = $('btn-auto'); if (a) a.disabled = true;
      } else {
        state.pause = false;
        event('ok', 'сервисный режим выключен');
        const b = $('btn-prog-run'); if (b) b.disabled = false;
        const a = $('btn-auto'); if (a) a.disabled = false;
      }
      const badge = $('csl-stand-badge');
      if (badge) badge.classList.toggle('hidden', !state.serviceStand);
      document.body.classList.toggle('service-stand', state.serviceStand);
      render();
    });

    document.querySelectorAll('[data-csl]').forEach((b) => {
      b.addEventListener('click', () => {
        const a = b.dataset.csl;
        if (a === 'stop-all') allStop();
        else if (a === 'home-all') homeAll();
        else if (a === 'sync-steer') syncSteerAll();
        else if (a === 'csv') { if (download('rus_slam_stats.csv', stats.toCSV(), 'text/csv;charset=utf-8')) say('ok', 'статистика выгружена в CSV'); }
        else if (a === 'json') {
          // StatsStore.toJSON() уже возвращает готовую JSON-строку (pretty).
          const text = typeof stats.toJSON === 'string' ? stats.toJSON() : JSON.stringify(stats.toJSON(), null, 2);
          if (download('rus_slam_stats.json', text, 'application/json')) say('ok', 'статистика выгружена в JSON');
        }
        else if (a === 'print') { printReport(); say('ok', 'печатный отчёт сформирован'); }
        else if (a === 'reset') {
          if (window.confirm('Сбросить накопленную статистику? Журнал аудита замка сохранится.')) {
            stats.reset();
            history.soc.length = 0;
            history.speed.length = 0;
            event('warn', 'статистика сброшена');
            render();
          }
        } else if (a === 'charge') {
          const btn = $('btn-charge');
          if (btn) btn.click();
        } else if (a === 'cargo-out') {
          closeLock('груз сдан');
        }
      });
    });

    window.addEventListener('beforeunload', () => { stats.flush(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stats.flush(); });

    Promise.resolve(vault.init()).then(() => {
      renderLock();
      say('ok', 'сервисный пульт: замок ячейки готов (заводской PIN 2580)');
    }).catch((e) => console.error('console.js vault.init', e));

    ready = true;
    render();
  }

  /* --------------------------------------------------------------------- */
  /* Публичный API для app.js (интеграция симуляции)                       */
  /* --------------------------------------------------------------------- */
  window.RSConsole = {
    stats,
    vault,
    cmd,
    noteManual: (n) => stats.noteManual(n),
    noteSign: (kind) => stats.noteSign(kind),
    noteLight: (kind) => stats.noteLight(kind),
    noteObstacle: (n) => stats.noteObstacle(n),
    noteFault: (n) => stats.noteFault(n),
    noteChargeCycle: (n) => stats.noteChargeCycle(n),
    isLockOpen: () => lock.open,
    closeLock,
    render,
    /**
     * Интеграция метрик в главный цикл симуляции.
     * @param {number} dt
     * @param {object} st — ссылка на state пульта
     * @param {object} [extra] — { distanceM }
     */
    onSimTick(dt, st, extra) {
      if (!st) return;
      const speed = Math.hypot(st.spdVx || 0, st.spdVy || 0);
      stats.tick(dt, {
        distanceM: extra && extra.distanceM !== undefined ? extra.distanceM : speed * dt,
        voltage: st.bat,
        current: st.charging ? Math.max(2, st.current) : st.current,
        speed,
        auto: !!st.auto && !st.serviceStand,
        estop: !!st.estop,
        cargo: !!st.cargo,
        payload: st.payload,
        origin: st.origin || 'база',
        mission: st.mission,
      });
    },
    render1: () => { try { render(); } catch (e) {} },
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Главный цикл пульта (app.js) вызывает RSConsole.frame(now).
  window.RSConsole.frame = function (now) { tick(now || performance.now()); };
})();
