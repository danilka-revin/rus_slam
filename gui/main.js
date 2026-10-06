/* ============================================================================
 * main.js — основной экран робота: данные и взаимодействие.
 *
 * Источник данных:
 *   1) бэкенд `gui/backend.py` — GET /api/state каждые 300 мс (двигатели, АКБ,
 *      груз, замок, связь), POST /api/lock/open|close, GET /api/audit;
 *   2) если сервера нет (страница открыта как файл или обычным static-сервером)
 *      — локальная демонстрация, чтобы экран не оставался пустым.
 *
 * ПРАВИЛА ЭКРАНА (чтобы в интерфейсе не было дублей):
 *   • одно действие — один орган управления. Очистка ввода PIN — только клавиша
 *     «СБРОС» на клавиатуре; открытие/закрытие отсека — одна кнопка, её надпись
 *     меняется по состоянию. Второй кнопки сброса нет;
 *   • одно состояние показывается в одном месте: замок — чип в шапке панели
 *     «Грузовой отсек»; груз — строка под клавиатурой; заряд — кольцо АКБ;
 *     связь с модулями — подвал панели «Двигатели»; канал данных — чип в шапке;
 *   • сообщение под PIN-кодом — только отклик на последнее действие
 *     (доступ разрешён / неверный PIN / блокировка), оно не повторяет состояние.
 *
 * Переход на инженерный пульт: одна ссылка в подвале экрана.
 * ========================================================================== */
(function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const POLL_MS = 300;
  const AUDIT_MS = 5000;
  const PROMPT = 'Введите PIN-код и нажмите «Открыть»';

  /* ======================================================================
   * 1. Демонстрационный источник (резерв, когда API недоступен)
   * ==================================================================== */
  const DEMO = {
    motors: [
      { id: 'FL', title: 'передний левый', angle: 0, rpm: 0, temp: 36, homed: true },
      { id: 'FR', title: 'передний правый', angle: 0, rpm: 0, temp: 37, homed: true },
      { id: 'RL', title: 'задний левый', angle: 0, rpm: 0, temp: 35, homed: true },
      { id: 'RR', title: 'задний правый', angle: 0, rpm: 0, temp: 36, homed: true },
    ],
    battery: { soc: 78, volts: 41.2, amps: 12.4, rangeKm: 14.2, state: 'разряд', level: 'НОРМА' },
    cargo: { kg: 80, closed: true },
    mode: 'АВТОНОМНЫЙ РЕЖИМ',
    route: 'склад → зона выгрузки',
    powerKw: 2.4,
    linkOk: true,
    localPin: '2580',          // только для демо-режима
    maxAttempts: 5,
    lockMs: 30000,
  };

  function demoStep(dt) {
    const b = DEMO.battery;
    DEMO.motors.forEach((m, i) => {
      const target = Math.sin(Date.now() / (2600 + i * 400)) * 34;
      m.angle += (target - m.angle) * Math.min(1, dt * 3.2);
      const rpm = (b.amps / 12) * 260;
      m.rpm += (rpm - m.rpm) * Math.min(1, dt * 1.4);
      m.temp = 34 + Math.abs(m.rpm) / 40 + Math.sin(Date.now() / 5000 + i) * 1.4;
    });
    b.amps += ((6 + 12 * Math.abs(Math.sin(Date.now() / 9000))) - b.amps) * Math.min(1, dt * 0.6);
    b.soc = Math.max(6, b.soc - b.amps * dt / 3600 * 100 / 18.6);
    b.volts = 30 + b.soc / 100 * 13.8 - b.amps * 0.075 / 12;
    b.rangeKm = b.soc / 100 * 18.5;
    b.state = 'разряд';
    b.level = b.volts < 33.5 ? 'КРИТИЧЕСКИЙ' : b.volts < 35.5 ? 'НИЗКИЙ' : 'НОРМА';
    DEMO.powerKw = b.volts * b.amps / 1000;
  }

  /* ======================================================================
   * 2. API-источник (gui/backend.py)
   * ==================================================================== */
  const api = {
    ok: false,          // есть ли ответ сервера
    data: null,
    at: 0,              // когда получен последний снимок
    source: '—',
    error: '',
    lastAudit: null,
    timer: null,
    auditTimer: null,
  };

  const hasFetch = typeof fetch === 'function';

  function apiUrl(path) { return path; }        // относительные URL — работает на любом порту

  /** Данные сервера свежие (ответ был меньше 2 с назад). */
  function apiFresh() { return api.ok && !!api.data && (Date.now() - api.at) < 2000; }

  async function apiPoll() {
    if (!hasFetch) return;
    try {
      const res = await fetch(apiUrl('api/state'), { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.json();
      if (body && body.ok && body.data) {
        api.data = body.data;
        api.source = body.data.source || '—';
        api.at = Date.now();
        api.ok = true;
        api.error = '';
      }
    } catch (err) {
      api.ok = false;
      api.error = String(err && err.message ? err.message : err);
    }
  }

  async function apiAudit() {
    if (!hasFetch) return;
    try {
      const res = await fetch(apiUrl('api/audit?limit=1'), { cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json();
      api.lastAudit = body && body.audit && body.audit.length ? body.audit[0] : null;
    } catch (err) { /* журнал не критичен */ }
  }

  async function apiLock(path, payload) {
    const res = await fetch(apiUrl(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    return res.json();
  }

  /** Данные для отрисовки: свежий снимок API либо локальная демонстрация. */
  function read() {
    if (apiFresh()) return api.data;
    return {
      motors: DEMO.motors,
      battery: DEMO.battery,
      cargo: DEMO.cargo,
      mode: DEMO.mode,
      route: DEMO.route,
      powerKw: DEMO.powerKw,
      linkOk: DEMO.linkOk,
      ts: Date.now() / 1000,
    };
  }

  /* ======================================================================
   * 3. Состояние экрана
   * ==================================================================== */
  const lock = { pin: '', busy: false, demoOpen: false, fails: 0, lockUntil: 0 };

  /**
   * Единственный источник правды о замке: пока сервер отвечает — его состояние,
   * иначе — локальное демонстрационное. Экрану не нужна своя копия состояния.
   */
  function lockView() {
    if (apiFresh() && api.data.lock) {
      const l = api.data.lock;
      return {
        open: !!l.open,
        blocked: !!l.blocked,
        remainingMs: Number(l.remainingMs || 0),
        attemptsLeft: l.attemptsLeft,
        from: 'сервер',
      };
    }
    const left = Math.max(0, lock.lockUntil - Date.now());
    return {
      open: lock.demoOpen,
      blocked: left > 0,
      remainingMs: left,
      attemptsLeft: DEMO.maxAttempts - lock.fails,
      from: 'демо',
    };
  }

  /* ======================================================================
   * 4. Разметка
   * ==================================================================== */
  const KEYPAD = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', 'СБРОС'];
  const KEY_LABEL = { '⌫': '⌫', 'СБРОС': 'СБРОС' };

  function mountMotors() {
    const grid = $('sc-motor-grid');
    if (!grid) return;
    grid.innerHTML = DEMO.motors.map((m) => `
      <article class="mcard" id="mc-${m.id}">
        <div class="mcard-top">
          <b>${m.id}</b>
          <span class="mcard-name">${m.title}</span>
          <span class="sc-chip sc-chip-idle" id="mc-state-${m.id}">ожидание</span>
        </div>
        <div class="mcard-body">
          <div class="dial">
            <svg viewBox="0 0 100 100" aria-hidden="true">
              <circle class="dial-bg" cx="50" cy="50" r="38"></circle>
              <g>
                ${[-60, -30, 0, 30, 60, 90, 120, 150, 180, 210, 240].map((a) =>
                  `<line class="dial-tick" x1="50" y1="12" x2="50" y2="19" transform="rotate(${a} 50 50)"></line>`).join('')}
              </g>
              <line class="dial-needle" id="mc-needle-${m.id}" x1="50" y1="50" x2="50" y2="18"></line>
              <circle class="dial-hub" cx="50" cy="50" r="4.5"></circle>
            </svg>
            <span class="dial-val" id="mc-angle-${m.id}">0°</span>
          </div>
          <div class="mcard-stats">
            <div class="mstat"><span>об/мин</span><b id="mc-rpm-${m.id}">0</b></div>
            <div class="mstat"><span>температура</span><b id="mc-temp-${m.id}">36<small>°C</small></b></div>
            <div class="pbar"><i id="mc-bar-${m.id}"></i></div>
          </div>
        </div>
      </article>`).join('');
  }

  function mountKeypad() {
    const pad = $('sc-keypad');
    if (!pad) return;
    pad.innerHTML = KEYPAD.map((k) => {
      const mode = k === '⌫' || k === 'СБРОС';
      const label = KEY_LABEL[k] || k;
      const aria = k === '⌫' ? 'удалить последнюю цифру'
        : k === 'СБРОС' ? 'очистить ввод' : 'цифра ' + k;
      return `<button type="button" class="sc-key${mode ? ' sc-key-mode' : ''}" data-key="${k}"
                 aria-label="${aria}">${label}</button>`;
    }).join('');
    pad.querySelectorAll('[data-key]').forEach((b) => b.addEventListener('click', () => press(b.dataset.key)));
  }

  /* ======================================================================
   * 5. Замок грузового отсека
   * ==================================================================== */
  function press(k) {
    if (lock.busy) return;                       // идёт проверка PIN — ввод не принимаем
    if (lockView().blocked) return;              // блокировку считает сервер (или демо-режим)
    if (k === 'СБРОС' || k === 'C') {
      lock.pin = '';
      renderPin();
      setMsg(PROMPT);
      return;
    }
    if (k === '⌫') lock.pin = lock.pin.slice(0, -1);
    else if (lock.pin.length < 8) lock.pin += k;
    renderPin();
  }

  function renderPin() {
    const el = $('sc-pin-dots');
    if (el) el.textContent = lock.pin ? '•'.repeat(lock.pin.length).split('').join(' ') : '— — — —';
  }

  function setMsg(text, cls) {
    const el = $('sc-pin-msg');
    if (!el) return;
    el.textContent = text;
    el.className = 'sc-pin-msg' + (cls ? ' ' + cls : '');
  }

  function shake() {
    const box = $('sc-lock-state');
    if (!box || !box.parentElement) return;
    box.parentElement.classList.add('sc-shake');
    setTimeout(() => box.parentElement.classList.remove('sc-shake'), 400);
  }

  /** Главное действие: открыть отсек по PIN либо закрыть уже открытый. */
  function toggleCargo() {
    if (lockView().open) closeCargo(); else tryOpen();
  }

  async function tryOpen() {
    if (lock.busy) return;
    const lv = lockView();
    if (lv.blocked) {
      setMsg('Ввод заблокирован: ещё ' + Math.ceil(lv.remainingMs / 1000) + ' с', 'err');
      return;
    }
    if (lock.pin.length < 4) { setMsg('PIN — не менее 4 цифр', 'warn'); return; }
    lock.busy = true;
    try {
      if (api.ok) {
        const res = await apiLock('api/lock/open', { pin: lock.pin });
        lock.pin = '';
        renderPin();
        if (res.ok) {
          setMsg('Доступ разрешён', 'ok');
          await apiAudit();
        } else if (res.reason === 'blocked') {
          setMsg('Ввод заблокирован: ещё ' + Math.ceil((res.remainingMs || 0) / 1000) + ' с', 'err');
          shake();
        } else {
          const left = res.attemptsLeft;
          setMsg(left !== undefined ? 'Неверный PIN. Осталось попыток: ' + left : 'Неверный PIN', 'err');
          shake();
        }
      } else {
        // демо-режим: проверка на месте
        const pin = lock.pin;
        lock.pin = '';
        renderPin();
        if (pin === DEMO.localPin) {
          lock.demoOpen = true;
          lock.fails = 0;
          setMsg('Доступ разрешён (демо-режим)', 'ok');
        } else {
          lock.fails += 1;
          if (lock.fails >= DEMO.maxAttempts) {
            lock.fails = 0;
            lock.lockUntil = Date.now() + DEMO.lockMs;
            setMsg('Пять неудачных попыток. Блокировка на 30 с', 'err');
          } else {
            setMsg('Неверный PIN. Осталось попыток: ' + (DEMO.maxAttempts - lock.fails), 'err');
          }
          shake();
        }
      }
    } catch (err) {
      setMsg('Нет связи с сервером: ' + (err && err.message ? err.message : err), 'err');
    } finally {
      lock.busy = false;
      render();
    }
  }

  async function closeCargo() {
    if (!lockView().open) return;
    lock.busy = true;
    try {
      if (api.ok) await apiLock('api/lock/close', {});
    } catch (err) { /* закрываем локально в любом случае */ }
    lock.demoOpen = false;
    lock.pin = '';
    renderPin();
    setMsg('Отсек закрыт', 'ok');
    lock.busy = false;
    render();
  }

  /* ======================================================================
   * 6. Отрисовка
   * ==================================================================== */
  function motorState(m) {
    if (m.online === false) return ['нет связи', 'sc-chip-err'];
    if (m.fault) return ['авария', 'sc-chip-err'];
    if (m.homed === false) return ['хоминг', 'sc-chip-warn'];
    if (m.temp > 55) return ['перегрев', 'sc-chip-err'];
    if (Math.abs(m.rpm) > 4) return ['движение', 'sc-chip-move'];
    return ['готов', 'sc-chip-ok'];
  }

  function fmt(v, digits) {
    return Number(v || 0).toFixed(digits === undefined ? 1 : digits).replace('.', ',');
  }

  function render() {
    const d = read();
    const fresh = apiFresh();
    const lv = lockView();

    /* двигатели: карточки + сводка */
    let moving = 0;
    let online = 0;
    const motors = d.motors || [];
    motors.forEach((m) => {
      const needle = $('mc-needle-' + m.id);
      if (needle) needle.style.transform = 'rotate(' + Number(m.angle || 0).toFixed(1) + 'deg)';
      const ang = $('mc-angle-' + m.id);
      if (ang) ang.textContent = Math.round(m.angle || 0) + '°';
      const rpm = $('mc-rpm-' + m.id);
      if (rpm) rpm.textContent = String(Math.round(m.rpm || 0));
      const temp = $('mc-temp-' + m.id);
      if (temp) temp.innerHTML = Math.round(m.temp || 0) + '<small>°C</small>';
      const bar = $('mc-bar-' + m.id);
      if (bar) {
        bar.style.width = Math.min(100, Math.abs(m.rpm || 0) / 3) + '%';
        bar.classList.toggle('neg', (m.rpm || 0) < 0);
      }
      const st = $('mc-state-' + m.id);
      if (st) {
        const s = motorState(m);
        st.textContent = s[0];
        st.className = 'sc-chip ' + s[1];
      }
      if (Math.abs(m.rpm || 0) > 4) moving += 1;
      if (m.online !== false) online += 1;
    });
    const sum = $('sc-motors-sum');
    if (sum) sum.textContent = 'в движении: ' + moving + ' из ' + motors.length
      + ' · модули на связи: ' + online + ' из ' + motors.length;

    /* АКБ: кольцо (заряд и уровень), строки, подсказка о порогах */
    const b = d.battery || {};
    const soc = Number(b.soc || 0);
    const C = 2 * Math.PI * 60;
    const fill = $('sc-ring-fill');
    if (fill) {
      fill.style.strokeDasharray = (soc / 100 * C).toFixed(1) + ' ' + C.toFixed(1);
      fill.style.stroke = soc < 20 ? 'var(--err)' : soc < 40 ? 'var(--warn)' : 'var(--ok)';
    }
    const socEl = $('sc-soc');
    if (socEl) socEl.innerHTML = Math.round(soc) + '<span>%</span>';
    const label = $('sc-soc-label');
    if (label) label.textContent = String(b.level || '—').toLowerCase();
    const volts = $('sc-volts');
    if (volts) volts.textContent = fmt(b.volts, 1) + ' В';
    const amps = $('sc-amps');
    if (amps) amps.textContent = fmt(b.amps, 1) + ' А';
    const range = $('sc-range');
    if (range) range.textContent = fmt(b.rangeKm, 1) + ' км';
    const bstate = $('sc-batt-state');
    if (bstate) bstate.textContent = b.state || '—';
    const hint = $('sc-batt-hint');
    if (hint) {
      const v = Number(b.volts || 0);
      hint.textContent = v && v < 33.5 ? 'ниже аварийного порога 33,5 В — движение запрещено'
        : v && v < 35.5 ? 'ниже порога 35,5 В — «ползучий» режим'
        : 'пороги: 35,5 В предупреждение · 33,5 В авария';
      hint.style.color = v && v < 33.5 ? 'var(--err)' : v && v < 35.5 ? 'var(--warn)' : '';
    }

    /* груз: только про груз, состояние замка показывает чип панели */
    const cargo = d.cargo || {};
    const kg = $('sc-cargo-kg');
    if (kg) kg.textContent = (cargo.kg === undefined ? '—' : cargo.kg) + ' кг';
    const cst = $('sc-cargo-state');
    if (cst) cst.textContent = lv.open ? 'доступен для погрузки/выгрузки' : 'закреплён и заперт';

    /* шапка и подвал */
    const mode = $('sc-mode');
    if (mode) mode.textContent = d.mode || '—';
    const route = $('sc-foot-route');
    if (route) route.textContent = 'маршрут: ' + (d.route || '—');
    const power = $('sc-foot-power');
    if (power) power.textContent = 'тяга: ' + fmt(d.powerKw, 2) + ' кВт · КПД 0,86';
    const dot = $('sc-link-dot');
    if (dot) dot.classList.toggle('off', !d.linkOk);
    const txt = $('sc-link-text');
    if (txt) txt.textContent = d.linkOk ? 'связь с бортом: есть' : 'связь с бортом: нет';

    /* режим данных: сервер или демо */
    const chip = $('sc-data');
    if (chip) {
      if (fresh) {
        chip.textContent = 'данные: сервер (' + api.source + ')';
        chip.className = 'sc-chip sc-chip-ok';
      } else {
        chip.textContent = hasFetch ? 'данные: демо · сервер недоступен' : 'данные: демо';
        chip.className = 'sc-chip sc-chip-warn';
      }
    }
    const ev = $('sc-foot-event');
    if (ev) {
      const e = api.lastAudit;
      ev.textContent = 'журнал: ' + (e ? (e.ok ? 'доступ разрешён' : 'отказ в доступе') : '—');
    }

    /* замок: чип и единственная кнопка действия */
    const chipLock = $('sc-lock-state');
    if (chipLock) {
      if (lv.blocked) {
        chipLock.textContent = 'БЛОКИРОВКА ' + Math.ceil(lv.remainingMs / 1000) + ' с';
        chipLock.className = 'sc-chip sc-chip-blocked';
      } else if (lv.open) {
        chipLock.textContent = 'ОТКРЫТО';
        chipLock.className = 'sc-chip sc-chip-open';
      } else {
        chipLock.textContent = 'ЗАКРЫТО';
        chipLock.className = 'sc-chip sc-chip-closed';
      }
    }
    const openBtn = $('sc-btn-open');
    if (openBtn) {
      openBtn.disabled = lv.blocked || lock.busy;
      openBtn.textContent = lv.open ? 'Закрыть отсек' : 'Открыть отсек';
    }
  }

  function clock() {
    const el = $('sc-clock');
    if (el) el.textContent = new Date().toLocaleTimeString('ru-RU', { hour12: false });
  }

  /* ======================================================================
   * 7. Навигация: основной экран ↔ инженерный пульт
   * ==================================================================== */
  function goConsole() { window.location.href = 'index.html'; }

  function initNav() {
    const link = $('sc-console-link');
    if (link) link.addEventListener('click', (e) => { e.preventDefault(); goConsole(); });
  }

  /* ======================================================================
   * 8. Запуск
   * ==================================================================== */
  function boot() {
    mountMotors();
    mountKeypad();
    renderPin();
    setMsg(PROMPT);
    initNav();
    clock();
    setInterval(clock, 1000);

    // Единственная кнопка отсека: открыть по PIN либо закрыть
    const openBtn = $('sc-btn-open');
    if (openBtn) openBtn.addEventListener('click', toggleCargo);

    // Физическая клавиатура (дубликатов органов управления не создаёт)
    document.addEventListener('keydown', (e) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('⌫');
      else if (e.key === 'Escape') press('СБРОС');
      else if (e.key === 'Enter') toggleCargo();
    });

    // Опрос бэкенда
    if (hasFetch) {
      apiPoll().then(render);
      api.timer = setInterval(apiPoll, POLL_MS);
      api.auditTimer = setInterval(apiAudit, AUDIT_MS);
      apiAudit();
    }

    // Отрисовка; локальная анимация — только когда данных сервера нет
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.5, (now - last) / 1000);
      last = now;
      if (!apiFresh()) demoStep(dt);
      render();
    }, 200);

    window.addEventListener('beforeunload', () => {
      if (api.timer) clearInterval(api.timer);
      if (api.auditTimer) clearInterval(api.auditTimer);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  // Для тестов и отладки в консоли браузера
  window.RS_MAIN = { api, lock, read, press, tryOpen, closeCargo, toggleCargo, lockView, render };
})();
