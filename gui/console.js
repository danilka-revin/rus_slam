/* ============================================================================
 * console.js — окно «Сервис» веб-пульта RUS SLAM (DOM-слой).
 *
 * Технический план: docs/SERVICE_CONSOLE.md (раздел 8.1 — десять улучшений).
 * Ядро без DOM: gui/console-core.js (window.RS), тесты gui/tests/console.test.js.
 *
 * Панели окна:
 *   1) Ячейка хранения — PIN-клавиатура, QR/RFID, смена PIN, аудит доступа;
 *   2) Двигатели — 4 модуля × 2 канала (руль/тяга): поле ввода + кнопка «Ввод»,
 *      джоги, «мёртвая рука» для тяги, факт телеметрии, HEX кадра UART;
 *   3) АКБ 12S3P LiFePO4 — напряжение, SOC, ток, мощность, ячейки, запас хода;
 *   4) Статистика и журнал сервисных действий — KPI, рейсы, экспорт, фильтры.
 *
 * Улучшения интерфейса (И-1…И-10):
 *   И-1  Панель быстрых действий (sticky) с живыми состояниями;
 *   И-2  Палитра команд Ctrl+K (/) и справка по горячим клавишам;
 *   И-3  Монитор смены: таймер, рейсы, SOC-кольцо, светофор, последний знак;
 *   И-4  Валидация полей ввода с автоклампом и подсветкой;
 *   И-5  «Мёртвая рука»: тяга подаётся только при удержании кнопки;
 *   И-6  Звуковая обратная связь (Web Audio) с тумблером;
 *   И-7  Свои модальные окна: подтверждения, предпросмотр отчёта, справка;
 *   И-8  Журнал сервисных действий с фильтрами, поиском и копированием кадра;
 *   И-9  Режим «крупный интерфейс» и доступность (aria-live, focus-visible);
 *   И-10 Синхронизация между окнами пульта (BroadcastChannel + storage).
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

  const SOUND_KEY = 'rus_slam_sound';
  const UI_KEY = 'rus_slam_ui_scale';
  const LOCK_STATE_KEY = 'rus_slam_lock_state_v1';
  const CHANNEL_NAME = 'rus_slam_console';
  const AUTO_CLOSE_MS = 30000;

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
      if (action === 'unlock') say(ok ? 'ok' : 'warn', ok ? 'замок ячейки: доступ разрешён' : 'замок ячейки: отказ в доступе');
      else if (action === 'pin_change') say('warn', 'замок ячейки: PIN изменён');
    },
  });

  const lock = { open: false, autoCloseAt: 0, lastKind: '—', pinBuf: '', busy: false };
  const settings = {
    sound: storage.getItem(SOUND_KEY) !== '0',
    large: storage.getItem(UI_KEY) === 'large',
  };
  const journal = { items: [], filter: 'all', q: '' };
  const peer = { id: RS.randomHex(4), seenAt: 0, channel: null };
  const holds = {};    // id модуля → активна ли подача тяги «мёртвой рукой»
  const lastSeen = { sign: '—', signAt: 0, light: '—' };

  const MODULES = [
    { id: 'FL', num: 1, title: 'передний левый' },
    { id: 'FR', num: 2, title: 'передний правый' },
    { id: 'RL', num: 3, title: 'задний левый' },
    { id: 'RR', num: 4, title: 'задний правый' },
  ];
  const MOD_INDEX = {};
  const history = { soc: [], speed: [], t: 0 };
  const frames = {};
  const cmd = {};

  let lastRender = 0;
  let ready = false;

  /* --------------------------------------------------------------------- */
  /* Базовые утилиты                                                       */
  /* --------------------------------------------------------------------- */
  function visible() {
    const sec = $('view-console');
    return !!sec && !sec.classList.contains('hidden');
  }

  function modOf(id) {
    const i = MOD_INDEX[id];
    return (typeof state !== 'undefined' && state.modules && state.modules[i]) || null;
  }

  function setText(id, text) {
    const el = $(id);
    if (el && el.textContent !== text) el.textContent = text;
  }

  function setHTML(id, html) {
    const el = $(id);
    if (el) el.innerHTML = html;
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, Number(v) || 0)); }

  /** Символ текущего состояния окна для заголовка вкладки (document.title). */
  function titleBadge() {
    const parts = [];
    if (typeof state !== 'undefined' && state.estop) parts.push('E-STOP');
    if (lock.open) parts.push('ячейка открыта');
    if (typeof state !== 'undefined' && state.serviceStand) parts.push('стенд');
    return parts.length ? '[' + parts.join(' · ') + '] ' : '';
  }

  /* Обёртки над функциями app.js: окно не должно падать без пульта. */
  function logLine(level, msg) { if (typeof log === 'function') log(level, msg); }
  function tip(text) { if (typeof toast === 'function') toast(text); }

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
  /* И-6. Звуковая обратная связь (Web Audio)                              */
  /* --------------------------------------------------------------------- */
  let actx = null;
  const TONES = {
    ok: [[880, 0.09]],
    lock: [[659, 0.07], [988, 0.13]],
    warn: [[520, 0.08], [392, 0.14]],
    err: [[233, 0.3]],
    tick: [[1245, 0.03]],
  };

  function beep(kind) {
    if (!settings.sound) return;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!actx) actx = new AC();
      if (actx.state === 'suspended' && actx.resume) actx.resume();
      let t = actx.currentTime;
      for (const [freq, dur] of (TONES[kind] || TONES.ok)) {
        const osc = actx.createOscillator();
        const gain = actx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.exponentialRampToValueAtTime(0.06, t + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(gain);
        gain.connect(actx.destination);
        osc.start(t);
        osc.stop(t + dur + 0.02);
        t += dur + 0.03;
      }
    } catch (e) { /* звук не критичен */ }
  }

  function setSound(on) {
    settings.sound = !!on;
    try { storage.setItem(SOUND_KEY, settings.sound ? '1' : '0'); } catch (e) {}
    renderToolbar();
    say('ok', settings.sound ? 'звуковые сигналы включены' : 'звуковые сигналы выключены');
    if (settings.sound) beep('tick');
  }

  /* --------------------------------------------------------------------- */
  /* И-8. Журнал сервисных действий (в окне, с фильтрами и поиском)        */
  /* --------------------------------------------------------------------- */
  function say(level, msg) {
    logLine(level, msg);
    journal.items.unshift({ ts: Date.now(), level: level || 'ok', msg: String(msg) });
    if (journal.items.length > 300) journal.items.pop();
    renderJournal();
  }

  /** Событие в ленту пульта (app.js может отсутствовать). */
  function event(type, msg) {
    if (typeof emit === 'function') emit(type, msg);
  }

  function journalMatch(item) {
    if (journal.filter !== 'all' && item.level !== journal.filter) return false;
    if (journal.q && item.msg.toLowerCase().indexOf(journal.q.toLowerCase()) < 0) return false;
    return true;
  }

  function renderJournal() {
    const rows = journal.items.filter(journalMatch).slice(0, 80).map((it) => {
      const hex = /(?:[0-9A-F]{2} ){9}[0-9A-F]{2}/.exec(it.msg);
      return `<div class="csl-jrow ${it.level}">
        <span class="csl-jts">${F.time(it.ts)}</span>
        <span class="csl-jmsg">${it.msg}</span>
        ${hex ? `<button type="button" class="csl-jcopy" data-copy="${hex[0]}" title="скопировать кадр">HEX</button>` : ''}
      </div>`;
    }).join('');
    setHTML('csl-journal-rows', rows || '<div class="csl-jempty">Нет записей по фильтру</div>');
    document.querySelectorAll('[data-jfilter]').forEach((b) => {
      b.classList.toggle('on', b.dataset.jfilter === journal.filter);
    });
    const box = $('csl-journal-rows');
    if (box && journal.items.length && box.scrollTop > 4) box.scrollTop = 0;
  }

  function copyText(text, label) {
    const done = () => { say('ok', (label || 'Скопировано') + ': ' + text); beep('tick'); };
    const fail = () => {
      say('warn', 'буфер обмена недоступен — кадр показан в окне');
      modalText(label || 'Кадр UART', text);
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => legacyCopy(text, done, fail));
        return;
      }
    } catch (e) { /* ниже резервный путь */ }
    legacyCopy(text, done, fail);
  }

  function legacyCopy(text, done, fail) {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'readonly');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand && document.execCommand('copy');
      ta.remove();
      if (ok) done();
      else fail();
    } catch (e) { fail(); }
  }

  /* --------------------------------------------------------------------- */
  /* И-7. Модальные окна окна «Сервис»                                     */
  /* --------------------------------------------------------------------- */
  const modal = { open: false, onOk: null, onCancel: null };

  function openModal(opts) {
    const o = opts || {};
    modal.open = true;
    modal.onOk = o.onOk || null;
    modal.onCancel = o.onCancel || null;
    const card = $('csl-modal-card');
    if (card) {
      card.classList.toggle('csl-modal-wide', !!o.wide);
      card.classList.toggle('csl-modal-danger', !!o.danger);
    }
    setText('csl-modal-title', o.title || 'Подтверждение');
    setHTML('csl-modal-body', o.body || '');
    const okBtn = $('csl-modal-ok');
    if (okBtn) {
      okBtn.textContent = o.okText || 'Подтвердить';
      okBtn.classList.toggle('hidden', o.okText === null);
    }
    const cancelBtn = $('csl-modal-cancel');
    if (cancelBtn) {
      cancelBtn.textContent = o.cancelText === null ? '' : (o.cancelText || 'Отмена');
      cancelBtn.classList.toggle('hidden', o.cancelText === null);
    }
    const el = $('csl-modal');
    if (el) {
      el.classList.remove('hidden');
      el.setAttribute('aria-hidden', 'false');
    }
    const focusEl = o.wide ? $('csl-modal-cancel') : okBtn;
    if (focusEl && focusEl.focus) focusEl.focus();
    beep(o.danger ? 'warn' : 'tick');
  }

  function closeModal(result) {
    const el = $('csl-modal');
    if (el) {
      el.classList.add('hidden');
      el.setAttribute('aria-hidden', 'true');
    }
    const ok = modal.onOk;
    const cancel = modal.onCancel;
    modal.open = false;
    modal.onOk = modal.onCancel = null;
    if (result && ok) ok();
    else if (!result && cancel) cancel();
  }

  function confirmModal(title, body, opts) {
    const o = opts || {};
    return new Promise((resolve) => {
      openModal(Object.assign({}, o, {
        title,
        body: '<p class="csl-modal-text">' + body + '</p>',
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      }));
    });
  }

  function modalText(title, text) {
    openModal({
      title,
      body: `<textarea class="csl-modal-textarea" readonly rows="8">${text}</textarea>`,
      okText: 'Закрыть',
      cancelText: 'Скопировать',
      onCancel: () => {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => say('ok', 'Скопировано: ' + text));
          } else say('warn', 'буфер обмена недоступен в этой среде');
        } catch (e) { say('warn', 'буфер обмена недоступен в этой среде'); }
      },
    });
  }

  function previewReport() {
    openModal({
      title: 'Предпросмотр отчёта смены',
      body: '<div class="csl-report">' + stats.reportHTML() + '</div>',
      okText: 'Печать',
      cancelText: 'Закрыть',
      wide: true,
      onOk: printReport,
    });
  }

  function showHelp() {
    openModal({
      title: 'Горячие клавиши и подсказки',
      body: `
        <table class="csl-table">
          <tr><th>Клавиши</th><th>Действие</th></tr>
          <tr><td><kbd>Ctrl</kbd>+<kbd>K</kbd> или <kbd>/</kbd></td><td>палитра команд</td></tr>
          <tr><td><kbd>1</kbd>…<kbd>0</kbd>, <kbd>Enter</kbd>, <kbd>Esc</kbd></td><td>ввод PIN и открытие ячейки</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>1</kbd>…<kbd>7</kbd></td><td>переход по вкладкам пульта</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>L</kbd></td><td>открыть/закрыть ячейку хранения</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>S</kbd></td><td>сервисный режим «стенд»</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>X</kbd></td><td>стоп всех модулей</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>Z</kbd></td><td>звук вкл/выкл</td></tr>
          <tr><td><kbd>Alt</kbd>+<kbd>A</kbd></td><td>крупный интерфейс</td></tr>
          <tr><td><kbd>Esc</kbd></td><td>закрыть окно/палитру</td></tr>
        </table>
        <p class="csl-modal-text">Тяга подаётся кнопками с удержанием — «мёртвая рука»: отпустили кнопку,
        и модуль получает нулевую ШИМ. Команды разрешены только в режиме «стенд» и вне E-STOP.</p>`,
      okText: 'Понятно',
      cancelText: null,
    });
  }

  /* --------------------------------------------------------------------- */
  /* И-2. Палитра команд (Ctrl+K) и горячие клавиши                        */
  /* --------------------------------------------------------------------- */
  const VIEWS = [
    ['dash', 'Пульт'], ['drive', 'Ходовая'], ['mission', 'Миссия'], ['sensors', 'Сенсоры'],
    ['safety', 'Безопасность'], ['logs', 'Журнал'], ['console', 'Сервис'],
  ];

  function goView(view) {
    const btn = document.querySelector('nav button[data-view="' + view + '"]');
    if (btn) btn.click();
  }

  function commands() {
    const list = VIEWS.map(([v, title], i) => ({
      title: 'Вкладка «' + title + '»',
      hint: 'Alt+' + (i + 1),
      run: () => goView(v),
    }));
    return list.concat([
      { title: lock.open ? 'Закрыть ячейку хранения' : 'Открыть ячейку хранения', hint: 'Alt+L', run: () => (lock.open ? closeLock('палитра') : tryOpen('pin')) },
      { title: 'Сменить PIN ячейки', hint: '', run: () => { const d = document.querySelector('#view-console .csl-details'); if (d) d.open = true; const el = $('csl-pin-cur'); if (el && el.focus) el.focus(); } },
      { title: (typeof state !== 'undefined' && state.serviceStand ? 'Выключить' : 'Включить') + ' сервисный режим «стенд»', hint: 'Alt+S', run: toggleStand },
      { title: 'Стоп всех модулей', hint: 'Alt+X', run: allStop },
      { title: 'Хоминг всех модулей', hint: '', run: homeAll },
      { title: 'Задать всем угол', hint: '', run: syncSteerAll },
      { title: 'Экспорт статистики: CSV', hint: '', run: () => exportStats('csv') },
      { title: 'Экспорт статистики: JSON', hint: '', run: () => exportStats('json') },
      { title: 'Предпросмотр и печать отчёта', hint: '', run: previewReport },
      { title: 'Сбросить статистику', hint: '', run: () => resetStats() },
      { title: 'Светлая / тёмная тема', hint: '', run: () => { const b = $('btn-theme'); if (b) b.click(); } },
      { title: (settings.sound ? 'Выключить' : 'Включить') + ' звук', hint: 'Alt+Z', run: () => setSound(!settings.sound) },
      { title: (settings.large ? 'Обычный' : 'Крупный') + ' интерфейс', hint: 'Alt+A', run: () => setLarge(!settings.large) },
      { title: 'Справка: горячие клавиши', hint: '', run: showHelp },
      { title: (typeof state !== 'undefined' && state.estop ? 'Снять' : 'Включить') + ' E-STOP', hint: 'Space', run: () => { const b = $('btn-estop'); if (b) b.click(); } },
    ]);
  }

  const palette = { open: false, items: [], index: 0 };

  function openPalette() {
    if (typeof state === 'undefined') return;
    palette.open = true;
    const el = $('csl-palette');
    if (el) el.classList.remove('hidden');
    const input = $('csl-palette-input');
    if (input) { input.value = ''; if (input.focus) input.focus(); }
    renderPalette('');
    beep('tick');
  }

  function closePalette() {
    palette.open = false;
    const el = $('csl-palette');
    if (el) el.classList.add('hidden');
  }

  function renderPalette(q) {
    const query = String(q || '').trim().toLowerCase();
    palette.items = commands().filter((c) => !query || c.title.toLowerCase().indexOf(query) >= 0);
    if (palette.index >= palette.items.length) palette.index = 0;
    setHTML('csl-palette-list', palette.items.map((c, i) =>
      `<button type="button" class="csl-pitem ${i === palette.index ? 'on' : ''}" data-pi="${i}">
        <span>${c.title}</span>${c.hint ? `<em>${c.hint}</em>` : ''}
      </button>`).join('') || '<div class="csl-jempty">Ничего не найдено</div>');
    document.querySelectorAll('[data-pi]').forEach((b) => {
      b.addEventListener('click', () => runPalette(Number(b.dataset.pi)));
    });
  }

  function runPalette(i) {
    const c = palette.items[i];
    closePalette();
    if (c) { say('ok', 'команда: ' + c.title); c.run(); }
  }

  function paletteKey(e) {
    if (!palette.open) return;
    if (e.key === 'ArrowDown') { palette.index = Math.min(palette.items.length - 1, palette.index + 1); renderPalette($('csl-palette-input').value); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { palette.index = Math.max(0, palette.index - 1); renderPalette($('csl-palette-input').value); e.preventDefault(); }
    else if (e.key === 'Enter') { runPalette(palette.index); e.preventDefault(); }
    else if (e.key === 'Escape') { closePalette(); e.preventDefault(); }
  }

  /* --------------------------------------------------------------------- */
  /* И-1/И-3/И-9. Панель быстрых действий, монитор смены, крупный режим    */
  /* --------------------------------------------------------------------- */
  function toggleStand(on) {
    const cb = $('csl-stand');
    const next = on === undefined ? !(cb && cb.checked) : !!on;
    if (cb) cb.checked = next;
    applyStand(next);
  }

  function applyStand(next) {
    if (typeof state === 'undefined') return;
    state.serviceStand = !!next;
    if (state.serviceStand) {
      state.auto = false;
      state.progRun = false;
      state.explore = false;
      state.pause = true;
      state.vx = state.vy = state.wz = 0;
      state.spdVx = state.spdVy = state.spdWz = 0;
      event('warn', 'СЕРВИСНЫЙ РЕЖИМ · стенд — автономия заблокирована');
      beep('warn');
    } else {
      state.pause = false;
      allHoldStop('выход из стенда');
      event('ok', 'сервисный режим выключен');
      beep('tick');
    }
    const badge = $('csl-stand-badge');
    if (badge) badge.classList.toggle('hidden', !state.serviceStand);
    document.body.classList.toggle('service-stand', state.serviceStand);
    const runBtn = $('btn-prog-run');
    if (runBtn) runBtn.disabled = state.serviceStand;
    const autoBtn = $('btn-auto');
    if (autoBtn) autoBtn.disabled = false;
    render();
  }

  function setLarge(on) {
    settings.large = !!on;
    try { storage.setItem(UI_KEY, settings.large ? 'large' : 'normal'); } catch (e) {}
    document.body.classList.toggle('ui-large', settings.large);
    renderToolbar();
    say('ok', settings.large ? 'крупный интерфейс включён' : 'обычный масштаб интерфейса');
  }

  function pushLockState() {
    const payload = JSON.stringify({ open: lock.open, kind: lock.lastKind, at: Date.now(), by: peer.id });
    try { storage.setItem(LOCK_STATE_KEY, payload); } catch (e) {}
    try { peer.channel && peer.channel.postMessage({ type: 'lock', payload }); } catch (e) {}
  }

  function applyRemoteLock(payload, from) {
    let data = null;
    try { data = typeof payload === 'string' ? JSON.parse(payload) : payload; } catch (e) { data = null; }
    if (!data || data.by === peer.id || typeof data.open !== 'boolean') return;
    if (data.open === lock.open) return;
    lock.open = data.open;
    lock.lastKind = data.kind || '—';
    applyLockToSim(data.open);
    if (data.open) autoClose(true); else lock.autoCloseAt = 0;
    say('warn', 'ячейка ' + (data.open ? 'открыта' : 'закрыта') + ' в другом окне пульта' + (from ? ' (' + from + ')' : ''));
    beep(data.open ? 'lock' : 'tick');
    render();
  }

  function initChannel() {
    try {
      if (typeof BroadcastChannel === 'function') {
        peer.channel = new BroadcastChannel(CHANNEL_NAME);
        peer.channel.onmessage = (e) => {
          const m = e.data || {};
          if (m.id === peer.id) return;
          if (m.type === 'lock') applyRemoteLock(m.payload, 'канал');
          else if (m.type === 'hello' || m.type === 'here') { peer.seenAt = Date.now(); if (m.type === 'hello') peer.channel.postMessage({ type: 'here', id: peer.id }); renderToolbar(); }
          else if (m.type === 'stats') { reloadStats(); }
        };
        peer.channel.postMessage({ type: 'hello', id: peer.id });
      }
    } catch (e) { peer.channel = null; }
  }

  function reloadStats() {
    try {
      stats.data = stats._load();
      render();
    } catch (e) { /* ignore */ }
  }

  function renderToolbar() {
    if (typeof state === 'undefined') return;
    const estop = $('csl-tb-estop');
    if (estop) {
      estop.textContent = state.estop ? 'E-STOP' : 'движение разрешено';
      estop.className = 'csl-chip ' + (state.estop ? 'csl-chip-locked' : 'csl-chip-open');
    }
    const l = $('csl-tb-lock');
    if (l) {
      l.textContent = 'ячейка: ' + (lock.open ? 'ОТКРЫТА' : 'закрыта');
      l.className = 'csl-chip ' + (lock.open ? 'csl-chip-open' : 'csl-chip-closed');
    }
    const st = $('csl-tb-stand');
    if (st) {
      st.textContent = state.serviceStand ? 'СТЕНД · автономия off' : 'автономия вкл';
      st.className = 'csl-chip ' + (state.serviceStand ? 'csl-chip-locked' : 'csl-chip-closed');
    }
    const light = $('csl-tb-light');
    if (light) {
      const green = state.lightGreen !== false;
      light.textContent = 'светофор: ' + (green ? 'зелёный' : 'красный');
      light.className = 'csl-chip ' + (green ? 'csl-chip-open' : 'csl-chip-locked');
    }
    setText('csl-tb-sign', lastSeen.sign === '—' ? 'знаки: —' : 'знак: ' + lastSeen.sign + ' (' + F.time(lastSeen.signAt) + ')');
    setText('csl-tb-trip', 'рейсы: ' + stats.summary().trips + ' · смена ' + F.dur((Date.now() - stats.session.startedAt) / 1000));
    const openBtn = $('csl-tb-lock-btn');
    if (openBtn) openBtn.textContent = lock.open ? 'Закрыть ячейку' : 'Открыть ячейку';
    const soundBtn = $('csl-tb-sound');
    if (soundBtn) {
      soundBtn.textContent = settings.sound ? '🔊 звук' : '🔇 звук';
      soundBtn.setAttribute('aria-pressed', String(settings.sound));
      soundBtn.classList.toggle('on', settings.sound);
    }
    const uiBtn = $('csl-tb-ui');
    if (uiBtn) {
      uiBtn.textContent = settings.large ? 'А− обычный' : 'А+ крупный';
      uiBtn.setAttribute('aria-pressed', String(settings.large));
      uiBtn.classList.toggle('on', settings.large);
    }
    const peerChip = $('csl-tb-peer');
    if (peerChip) {
      const alive = Date.now() - peer.seenAt < 20000;
      peerChip.classList.toggle('hidden', !alive);
      peerChip.textContent = 'второе окно пульта активно';
    }
    if (!peer.baseTitle) peer.baseTitle = document.title.replace(/^\[[^\]]*\]\s*/, '');
    const badge = titleBadge();
    const nextTitle = badge + peer.baseTitle;
    if (document.title !== nextTitle) document.title = nextTitle;
    // кольцо SOC в шапке окна (И-3)
    const ring = $('csl-tb-ring');
    if (ring) {
      const ctx = ring.getContext && ring.getContext('2d');
      if (ctx) {
        const soc = typeof state !== 'undefined' ? state.soc : 0;
        const W = ring.width, H = ring.height, r = Math.min(W, H) / 2 - 4;
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 5;
        ctx.strokeStyle = 'rgba(110,140,130,0.35)';
        ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = soc < 20 ? '#e4503e' : soc < 40 ? '#e5a438' : '#7ddc52';
        ctx.beginPath(); ctx.arc(W / 2, H / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (soc / 100)); ctx.stroke();
        ctx.fillStyle = '#dbe7e1';
        ctx.font = 'bold 11px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(Math.round(soc) + '%', W / 2, H / 2 + 4);
      }
    }
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
      const label = k === 'C' ? 'C' : k === '⌫' ? '⌫' : k;
      return `<button type="button" class="${cls}" data-key="${k}" aria-label="${k === 'C' ? 'очистить' : k === '⌫' ? 'стереть' : 'цифра ' + k}">${label}</button>`;
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
    beep('tick');
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
      beep('warn');
      return;
    }
    lock.busy = true;
    try {
      if (vault.isLocked() && kind === 'pin') { renderLockStatus(); return; }
      const res = kind === 'pin' ? await vault.verify(pin) : { ok: true, reason: kind };
      if (res.ok) {
        lock.open = true;
        lock.lastKind = kind === 'pin' ? 'PIN' : kind.toUpperCase();
        lock.pinBuf = '';
        renderPin();
        setMsg('Доступ разрешён (' + lock.lastKind + '). Ячейка открыта', 'ok');
        applyLockToSim(true);
        autoClose(true);
        beep('lock');
        say('ok', 'ячейка хранения открыта (' + lock.lastKind + ')');
        pushLockState();
      } else if (res.reason === 'locked') {
        setMsg('Ввод заблокирован: ещё ' + Math.ceil(res.remainingMs / 1000) + ' с', 'err');
        beep('err');
        renderLockStatus();
      } else if (res.reason === 'format') {
        setMsg('PIN — от 4 до 8 цифр', 'warn');
        beep('warn');
      } else {
        const left = 5 - (res.fails || 0);
        setMsg('Неверный PIN. Осталось попыток: ' + Math.max(0, left), 'err');
        lock.pinBuf = '';
        renderPin();
        beep('err');
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
    say('ok', 'ячейка хранения закрыта' + (reason ? ' — ' + reason : ''));
    beep('tick');
    pushLockState();
    renderLock();
  }

  function autoClose(on) { lock.autoCloseAt = on ? performance.now() + AUTO_CLOSE_MS : 0; }

  function applyLockToSim(open) {
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
      const st = lock.open ? ['ОТКРЫТО', 'open'] : rem > 0 ? ['БЛОКИРОВКА ' + Math.ceil(rem / 1000) + ' с', 'locked'] : ['ЗАКРЫТО', 'closed'];
      chip.textContent = st[0];
      chip.className = 'csl-chip csl-chip-' + st[1];
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
      const ring = $('csl-lock-ring');
      if (ring && ring.getContext) {
        const ctx = ring.getContext('2d');
        const W = ring.width, H = ring.height, r = Math.min(W, H) / 2 - 3;
        ctx.clearRect(0, 0, W, H);
        ctx.lineWidth = 4;
        ctx.strokeStyle = 'rgba(110,140,130,0.3)';
        ctx.beginPath(); ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2); ctx.stroke();
        ctx.strokeStyle = '#e5a438';
        ctx.beginPath(); ctx.arc(W / 2, H / 2, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * (left / (AUTO_CLOSE_MS / 1000))); ctx.stroke();
      }
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
    if (nw !== rep) { setMsg('Новый PIN и повтор не совпадают', 'warn'); beep('warn'); return; }
    const res = await vault.setPin(cur, nw);
    if (res.ok) {
      setMsg('PIN изменён', 'ok');
      $('csl-pin-cur').value = $('csl-pin-new').value = $('csl-pin-rep').value = '';
      beep('lock');
    } else {
      setMsg(res.detail || 'Не удалось сменить PIN', 'err');
      beep('err');
    }
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
          <input type="number" id="csl-steer-${m.id}" value="0" min="-180" max="180" step="1" inputmode="numeric"
                 aria-describedby="csl-hint-${m.id}" title="Угол поворота модуля: −180…+180°" />
          <button type="button" class="csl-send" data-mod="${m.id}" data-ch="steer" title="Отправить кадр 10 Б (CRC16)">Ввод</button>
        </div>
        <div class="csl-jog">
          <button type="button" data-jog="${m.id}" data-ch="steer" data-val="-45" title="Повернуть на −45°">−45°</button>
          <button type="button" data-jog="${m.id}" data-ch="steer" data-val="-5">−5°</button>
          <button type="button" data-jog="${m.id}" data-ch="steer" data-val="5">+5°</button>
          <button type="button" data-jog="${m.id}" data-ch="steer" data-val="45" title="Повернуть на +45°">+45°</button>
          <button type="button" data-home="${m.id}" title="Хоминг модуля: обнулить азимут">⌂</button>
        </div>
        <div class="csl-field">
          <label for="csl-pwm-${m.id}">Тяга, %</label>
          <input type="number" id="csl-pwm-${m.id}" value="0" min="-100" max="100" step="5" inputmode="numeric"
                 aria-describedby="csl-hint-${m.id}" title="Задание тяги: −100…+100 % (в кадре −1000…+1000)" />
          <button type="button" class="csl-send" data-mod="${m.id}" data-ch="traction" title="Отправить кадр 10 Б (CRC16)">Ввод</button>
        </div>
        <div class="csl-jog csl-jog-hold">
          <button type="button" data-hold="${m.id}" data-ch="traction" data-val="-20" title="Удерживать: реверс −20 % (мёртвая рука)">−20 %</button>
          <button type="button" data-jog="${m.id}" data-ch="traction" data-val="0" title="Остановить модуль">0</button>
          <button type="button" data-hold="${m.id}" data-ch="traction" data-val="20" title="Удерживать: ход +20 % (мёртвая рука)">+20 %</button>
          <button type="button" data-stop="${m.id}" class="csl-stop" title="Стоп модуля">■</button>
        </div>
        <div class="csl-hint" id="csl-hint-${m.id}" aria-live="polite"></div>
        <div class="csl-fact" id="csl-fact-${m.id}">телеметрия —</div>
        <pre class="csl-frame" id="csl-frame-${m.id}">кадр: —</pre>
      </article>`).join('');

    box.querySelectorAll('.csl-send').forEach((b) => {
      b.addEventListener('click', () => sendModule(b.dataset.mod, b.dataset.ch, null));
    });
    box.querySelectorAll('[data-jog]').forEach((b) => {
      b.addEventListener('click', () => sendModule(b.dataset.jog, b.dataset.ch, Number(b.dataset.val)));
    });
    box.querySelectorAll('[data-hold]').forEach((b) => {
      const start = (e) => { if (e && e.preventDefault) e.preventDefault(); holdStart(b.dataset.hold, Number(b.dataset.val)); };
      const stop = () => holdStop(b.dataset.hold);
      // Слушаем и pointer-, и mouse-события: повторный «start» игнорируется,
      // пока модуль уже удерживается (см. holdStart), поэтому дублей нет.
      b.addEventListener('pointerdown', start);
      b.addEventListener('mousedown', start);
      b.addEventListener('pointerup', stop);
      b.addEventListener('pointerleave', stop);
      b.addEventListener('pointercancel', stop);
      b.addEventListener('mouseup', stop);
      b.addEventListener('mouseleave', stop);
    });
    box.querySelectorAll('[data-home]').forEach((b) => {
      b.addEventListener('click', () => homeModule(b.dataset.home));
    });
    box.querySelectorAll('[data-stop]').forEach((b) => {
      b.addEventListener('click', () => sendModule(b.dataset.stop, 'stop', 0));
    });

    // И-4: валидация полей ввода с автоклампом и подсветкой.
    MODULES.forEach((m) => {
      guardField($('csl-steer-' + m.id), -180, 180, 'угол', $('csl-hint-' + m.id));
      guardField($('csl-pwm-' + m.id), -100, 100, 'тяга', $('csl-hint-' + m.id));
    });
  }

  function guardField(input, min, max, label, hint) {
    if (!input) return;
    const check = () => {
      const v = Number(input.value);
      const bad = !Number.isFinite(v) || v < min || v > max;
      input.classList.toggle('csl-invalid', bad);
      input.setAttribute('aria-invalid', String(bad));
      if (hint && bad) hint.textContent = label + ': допустимо ' + min + '…' + max;
      else if (hint && !bad) hint.textContent = '';
      return bad;
    };
    input.addEventListener('input', check);
    input.addEventListener('blur', () => {
      if (!check()) return;
      const v = clamp(input.value, min, max);
      input.value = v;
      input.classList.remove('csl-invalid');
      input.setAttribute('aria-invalid', 'false');
      if (hint) hint.textContent = label + ' приведён к ' + v;
      input.classList.add('csl-clamped');
      beep('warn');
      setTimeout(() => input.classList.remove('csl-clamped'), 700);
      say('warn', 'значение поля «' + label + '» приведено к ' + v);
    });
    return check;
  }

  function serviceInterlock() {
    if (typeof state === 'undefined') return 'Симуляция недоступна';
    if (state.estop) return 'Снимите E-STOP';
    if (!state.serviceStand) return 'Включите «Сервисный режим · стенд»';
    return null;
  }

  function sendModule(id, ch, quick) {
    const bad = serviceInterlock();
    if (bad) { tip(bad); say('warn', 'ручная команда отклонена: ' + bad); beep('err'); return; }

    const m = modOf(id);
    if (!m) return;
    if (!cmd[id]) cmd[id] = { steer: 0, pwm: 0 };

    const steerEl = $('csl-steer-' + id);
    const pwmEl = $('csl-pwm-' + id);
    const hint = $('csl-hint-' + id);
    let home = false;
    let enable = true;

    if (ch === 'steer') {
      const raw = quick === null || quick === undefined ? Number(steerEl.value) : quick;
      const v = clamp(raw, -180, 180);
      if (Number.isFinite(raw) && raw !== v) {
        if (hint) hint.textContent = 'угол приведён к ' + v + '°';
        say('warn', id + ': угол ' + raw + '° приведён к ' + v + '°');
      } else if (hint) hint.textContent = '';
      cmd[id].steer = v;
      if (steerEl) steerEl.value = v;
    } else if (ch === 'traction') {
      const raw = quick === null || quick === undefined ? Number(pwmEl.value) : quick;
      const v = clamp(raw, -100, 100);
      if (Number.isFinite(raw) && raw !== v) {
        if (hint) hint.textContent = 'тяга приведена к ' + v + ' %';
        say('warn', id + ': тяга ' + raw + ' % приведена к ' + v + ' %');
      } else if (hint) hint.textContent = '';
      cmd[id].pwm = v;
      if (pwmEl) pwmEl.value = v;
    } else if (ch === 'home') {
      home = true;
      enable = false;
      m.homed = false;
    } else if (ch === 'stop') {
      cmd[id].pwm = 0;
      if (pwmEl) pwmEl.value = 0;
      if (hint) hint.textContent = '';
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

    m.svcSteer = cmd[id].steer;
    m.svcPwm = cmd[id].pwm;
    m.enabled = enable;
    m.cmdAt = Date.now();
    if (home) m.homed = true;

    stats.noteManual(1);
    say('ok', 'UART → ' + id + ' (#' + MODULES[MOD_INDEX[id]].num + '): ' + hex);
    event('nav', 'сервис: ' + id + ' ' + (ch === 'traction' ? cmd[id].pwm + ' %' : ch === 'home' ? 'хоминг' : cmd[id].steer + '°'));
    beep('tick');

    const fr = $('csl-frame-' + id);
    if (fr) fr.textContent = 'кадр: ' + hex;
    renderModules();
  }

  /* И-5. «Мёртвая рука»: тяга живёт, пока удерживают кнопку. */
  function holdStart(id, val) {
    if (typeof state === 'undefined') return;
    if (serviceInterlock()) { tip(serviceInterlock()); return; }
    if (holds[id]) return;   // защита от двойного срабатывания pointerdown + mousedown
    holds[id] = true;
    sendModule(id, 'traction', val);
    renderModules();
  }

  function holdStop(id) {
    if (!holds[id]) return;
    delete holds[id];
    sendModule(id, 'traction', 0);
    renderModules();
  }

  function allHoldStop(reason) {
    const ids = Object.keys(holds);
    if (!ids.length) return;
    ids.forEach((id) => { delete holds[id]; });
    if (typeof state !== 'undefined' && state.serviceStand) {
      ids.forEach((id) => { if (cmd[id]) cmd[id].pwm = 0; const el = $('csl-pwm-' + id); if (el) el.value = 0; const mm = modOf(id); if (mm) mm.svcPwm = 0; });
    }
    say('warn', 'аварийный сброс тяги (' + (reason || 'потеря фокуса') + ')');
    beep('warn');
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
        // Приоритет: авария → активное удержание тяги → хоминг → движение → готов.
        const st = state.estop ? ['E-STOP', 'locked']
          : holds[mm.id] ? ['УДЕРЖАНИЕ', 'open']
          : !m.homed ? ['ХОМИНГ', 'locked']
          : Math.abs(c.pwm) > 0.5 ? ['ДВИЖЕНИЕ', 'open'] : ['ГОТОВ', 'closed'];
        chip.textContent = st[0];
        chip.className = 'csl-chip csl-chip-' + st[1];
      }
      const holdBtn = document.querySelector('[data-hold="' + mm.id + '"][data-val="20"]');
      if (holdBtn) holdBtn.classList.toggle('on', !!holds[mm.id]);
      if (frames[mm.id]) {
        const fr = $('csl-frame-' + mm.id);
        if (fr) fr.textContent = 'кадр: ' + frames[mm.id];
      }
    });
  }

  function allStop() {
    if (typeof state === 'undefined') return;
    MODULES.forEach((m) => {
      delete holds[m.id];
      cmd[m.id] = cmd[m.id] || { steer: 0, pwm: 0 };
      cmd[m.id].pwm = 0;
      const el = $('csl-pwm-' + m.id);
      if (el) el.value = 0;
      const mm = modOf(m.id);
      if (mm) { mm.svcPwm = 0; mm.svcSteer = cmd[m.id].steer; }
    });
    say('warn', 'сервис: стоп всех модулей');
    beep('warn');
    renderModules();
  }

  function syncSteerAll() {
    const v = clamp($('csl-steer-all') ? $('csl-steer-all').value : 0, -180, 180);
    MODULES.forEach((m) => {
      cmd[m.id] = cmd[m.id] || { steer: 0, pwm: 0 };
      cmd[m.id].steer = v;
      const el = $('csl-steer-' + m.id);
      if (el) el.value = v;
      const mm = modOf(m.id);
      if (mm) mm.svcSteer = v;
    });
    say('ok', 'сервис: синхронный угол ' + v + '°');
    renderModules();
  }

  async function homeAll() {
    const ok = await confirmModal('Хоминг всех модулей',
      'Обнулить азимут всех четырёх модулей? Убедитесь, что колёса не упираются в препятствие.',
      { okText: 'Хоминг', danger: false });
    if (!ok) return;
    MODULES.forEach((m) => {
      const mm = modOf(m.id);
      if (mm) mm.homed = false;
      frames[m.id] = F.hex(RS.uart.buildCommand({ moduleId: m.num, steerCdeg: 0, pwm: 0, enable: false, home: true }));
    });
    stats.noteManual(1);
    say('warn', 'сервис: хоминг всех модулей');
    beep('warn');
    renderModules();
  }

  async function homeModule(id) {
    const ok = await confirmModal('Хоминг модуля ' + id, 'Обнулить азимут модуля ' + id + '?', { okText: 'Хоминг' });
    if (ok) sendModule(id, 'home', 1);
  }

  /* --------------------------------------------------------------------- */
  /* 3. АКБ                                                                */
  /* --------------------------------------------------------------------- */
  function packNow() {
    const P = RS.pack;
    const soc = typeof state !== 'undefined' ? state.soc : 0;
    const current = typeof state !== 'undefined' ? state.current : 0;
    const charging = typeof state !== 'undefined' ? state.charging : false;
    return P.packSnapshot({
      soc, current: charging ? -current : current, charging, whPerKm: stats.whPerKm(),
      tempC: 28 + Math.abs(current) * 0.12,
      cycles: stats.summary().chargeCycles,
    });
  }

  function spark(canvas, data, opts) {
    if (!canvas || !canvas.getContext) return;
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
    const lvl = $('csl-bat-level');
    if (lvl) {
      lvl.textContent = p.level.label + ' (порог ' + p.thresholds.lowV + ' / ' + p.thresholds.criticalV + ' В)';
      lvl.className = 'csl-level csl-' + p.level.cls;
    }

    const rows = (typeof state !== 'undefined' ? state.modules : []).map((m, i) => {
      const share = p.current / ((state.modules && state.modules.length) || 4);
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

  function exportStats(kind) {
    if (kind === 'csv') {
      if (download('rus_slam_stats.csv', stats.toCSV(), 'text/csv;charset=utf-8')) say('ok', 'статистика выгружена в CSV');
    } else {
      const text = typeof stats.toJSON === 'string' ? stats.toJSON() : JSON.stringify(stats.toJSON(), null, 2);
      if (download('rus_slam_stats.json', text, 'application/json')) say('ok', 'статистика выгружена в JSON');
    }
    try { peer.channel && peer.channel.postMessage({ type: 'stats', id: peer.id }); } catch (e) {}
  }

  function resetStats() {
    confirmModal('Сброс статистики',
      'Обнулить накопленные показатели (рейсы, пробег, энергию, события)? Журнал доступа замка сохранится.',
      { okText: 'Сбросить', danger: true }).then((ok) => {
      if (!ok) return;
      stats.reset();
      history.soc.length = 0;
      history.speed.length = 0;
      event('warn', 'статистика сброшена');
      say('warn', 'статистика сброшена оператором');
      beep('warn');
      render();
    });
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

    spark($('csl-trip-chart'), (stats.trips || []).slice(-20).map((t) => t.energyWh), { min: 0, color: '#7ddc52' });
    setText('csl-stats-updated', 'обновлено ' + F.time(stats.data.updatedAt));
  }

  /* --------------------------------------------------------------------- */
  /* Рендер и жизненный цикл                                               */
  /* --------------------------------------------------------------------- */
  function render() {
    if (typeof state === 'undefined') return;
    renderToolbar();
    renderLock();
    renderModules();
    renderBattery();
    renderStats();
  }

  function tick(now) {
    if (!ready || !visible()) return;
    if (now - lastRender < 250) return;
    lastRender = now;
    // И-3: «последний знак» — из журнала пульта, чтобы не трогать app.js.
    if (typeof state !== 'undefined' && state.bubble) {
      const b = String(state.bubble);
      const map = { 'СТОП': 'Стоп', 'переход': 'Пешеходный переход', 'неровность': 'Искусственная неровность', 'красный': 'красный', 'жёлтый': 'жёлтый' };
      if (map[b]) { lastSeen.sign = map[b]; lastSeen.signAt = Date.now(); }
    }
    try { render(); } catch (e) { console.error('console.js render', e); }
  }

  function init() {
    mountModules();
    renderKeypad();
    renderPin();
    setLarge(settings.large);
    if (settings.sound === false) renderToolbar();

    /* --- замок --- */
    if ($('csl-pin-open')) $('csl-pin-open').addEventListener('click', () => tryOpen('pin'));
    if ($('csl-pin-close')) $('csl-pin-close').addEventListener('click', () => closeLock('кнопка'));
    if ($('csl-pin-qr')) $('csl-pin-qr').addEventListener('click', () => tryOpen('qr'));
    if ($('csl-pin-rfid')) $('csl-pin-rfid').addEventListener('click', () => tryOpen('rfid'));
    if ($('csl-pin-change')) $('csl-pin-change').addEventListener('click', changePin);
    if ($('csl-pin-reset')) $('csl-pin-reset').addEventListener('click', async () => {
      const cur = $('csl-pin-cur') ? $('csl-pin-cur').value.trim() : '';
      const res = await vault.resetToDefault(cur);
      setMsg(res.ok ? 'PIN сброшен к заводскому 2580' : (res.detail || 'Сброс не выполнен'), res.ok ? 'ok' : 'err');
      beep(res.ok ? 'lock' : 'err');
      renderLock();
    });

    const pinInput = $('csl-pin-input');
    if (pinInput) {
      pinInput.setAttribute('readonly', 'readonly');
      pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); tryOpen('pin'); }
      });
    }

    /* --- панель быстрых действий (И-1) --- */
    if ($('csl-tb-lock-btn')) $('csl-tb-lock-btn').addEventListener('click', () => (lock.open ? closeLock('кнопка') : tryOpen('pin')));
    if ($('csl-tb-stand')) $('csl-tb-stand').addEventListener('click', () => toggleStand());
    if ($('csl-tb-stop')) $('csl-tb-stop').addEventListener('click', allStop);
    if ($('csl-tb-palette')) $('csl-tb-palette').addEventListener('click', openPalette);
    if ($('csl-tb-help')) $('csl-tb-help').addEventListener('click', showHelp);
    if ($('csl-tb-sound')) $('csl-tb-sound').addEventListener('click', () => setSound(!settings.sound));
    if ($('csl-tb-ui')) $('csl-tb-ui').addEventListener('click', () => setLarge(!settings.large));
    if ($('csl-pin-extend')) $('csl-pin-extend').addEventListener('click', () => { autoClose(true); say('ok', 'автозакрытие ячейки отложено на 30 с'); });

    /* --- стенд --- */
    if ($('csl-stand')) $('csl-stand').addEventListener('change', (e) => applyStand(e.target.checked));

    /* --- действия панелей --- */
    document.querySelectorAll('[data-csl]').forEach((b) => {
      b.addEventListener('click', () => {
        const a = b.dataset.csl;
        if (a === 'stop-all') allStop();
        else if (a === 'home-all') homeAll();
        else if (a === 'sync-steer') syncSteerAll();
        else if (a === 'csv') exportStats('csv');
        else if (a === 'json') exportStats('json');
        else if (a === 'print') previewReport();
        else if (a === 'reset') resetStats();
        else if (a === 'help') showHelp();
        else if (a === 'palette') openPalette();
        else if (a === 'charge') { const btn = $('btn-charge'); if (btn) btn.click(); }
        else if (a === 'cargo-out') closeLock('груз сдан');
      });
    });

    /* --- журнал сервисных действий (И-8) --- */
    document.querySelectorAll('[data-jfilter]').forEach((b) => {
      b.addEventListener('click', () => { journal.filter = b.dataset.jfilter; renderJournal(); });
    });
    if ($('csl-journal-q')) {
      $('csl-journal-q').addEventListener('input', (e) => { journal.q = e.target.value; renderJournal(); });
    }
    if ($('csl-journal-clear')) $('csl-journal-clear').addEventListener('click', () => {
      journal.items.length = 0;
      journal.q = '';
      if ($('csl-journal-q')) $('csl-journal-q').value = '';
      renderJournal();
    });
    const jrows = $('csl-journal-rows');
    if (jrows) {
      jrows.addEventListener('click', (e) => {
        const b = e.target.closest ? e.target.closest('[data-copy]') : null;
        if (b) copyText(b.dataset.copy, 'Кадр UART');
      });
    }
    if ($('csl-copy-frame')) {
      $('csl-copy-frame').addEventListener('click', () => {
        const last = Object.keys(frames).pop();
        if (!last) { tip('Кадров ещё нет'); return; }
        copyText(frames[last], 'Кадр UART ' + last);
      });
    }

    /* --- модальное окно (И-7) --- */
    if ($('csl-modal-ok')) $('csl-modal-ok').addEventListener('click', () => closeModal(true));
    if ($('csl-modal-cancel')) $('csl-modal-cancel').addEventListener('click', () => closeModal(false));
    if ($('csl-modal-x')) $('csl-modal-x').addEventListener('click', () => closeModal(false));
    if ($('csl-modal')) {
      $('csl-modal').addEventListener('click', (e) => { if (e.target === $('csl-modal')) closeModal(false); });
    }

    /* --- палитра команд (И-2) --- */
    if ($('csl-palette-input')) {
      $('csl-palette-input').addEventListener('input', (e) => { palette.index = 0; renderPalette(e.target.value); });
      $('csl-palette-input').addEventListener('keydown', paletteKey);
    }
    if ($('csl-palette')) $('csl-palette').addEventListener('click', (e) => { if (e.target === $('csl-palette')) closePalette(); });

    /* --- клавиатура --- */
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); palette.open ? closePalette() : openPalette(); return; }
      if (e.altKey && /^[1-7]$/.test(e.key)) { e.preventDefault(); goView(VIEWS[Number(e.key) - 1][0]); return; }
      if (e.altKey && (e.key === 'l' || e.key === 'L')) { e.preventDefault(); lock.open ? closeLock('клавиша') : tryOpen('pin'); return; }
      if (e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); toggleStand(); return; }
      if (e.altKey && (e.key === 'x' || e.key === 'X')) { e.preventDefault(); allStop(); return; }
      if (e.altKey && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); setSound(!settings.sound); return; }
      if (e.altKey && (e.key === 'a' || e.key === 'A')) { e.preventDefault(); setLarge(!settings.large); return; }
      if (palette.open) {
        if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
        return;
      }
      if (e.key === 'Escape' && modal.open) { closeModal(false); return; }
      if (!visible() || !ready || modal.open) return;
      if (e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === '/' && !(e.target && e.target.tagName === 'INPUT')) { e.preventDefault(); openPalette(); return; }
      const el = e.target;
      const typing = el && ((el.tagName === 'INPUT' && el !== pinInput) || el.tagName === 'TEXTAREA');
      if (typing) return;
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); pressKey(e.key); }
      else if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); pressKey('⌫'); }
      else if (e.key === 'Enter') { if (lock.open) return; e.preventDefault(); tryOpen('pin'); }
      else if (e.key === 'Escape') pressKey('C');
    }, true);

    /* --- «мёртвая рука»: отпускание где угодно останавливает тягу (И-5) --- */
    ['pointerup', 'pointercancel', 'blur'].forEach((ev) => window.addEventListener(ev, () => allHoldStop()));
    document.addEventListener('visibilitychange', () => { if (document.hidden) allHoldStop('вкладка скрыта'); });
    if (jrows) jrows.addEventListener('pointerup', () => allHoldStop());

    /* --- синхронизация между окнами (И-10) --- */
    initChannel();
    window.addEventListener('storage', (e) => {
      if (e.key === LOCK_STATE_KEY) applyRemoteLock(e.newValue, 'окно');
      else if (e.key === 'rus_slam_stats_v1') reloadStats();
    });

    window.addEventListener('beforeunload', () => { stats.flush(); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) stats.flush(); });

    Promise.resolve(vault.init()).then(() => {
      renderLock();
      say('ok', 'сервисный пульт: замок ячейки готов (заводской PIN 2580)');
    }).catch((e) => console.error('console.js vault.init', e));

    ready = true;
    renderJournal();
    render();
  }

  /* --------------------------------------------------------------------- */
  /* Публичный API для app.js (интеграция симуляции)                       */
  /* --------------------------------------------------------------------- */
  window.RSConsole = {
    stats,
    vault,
    cmd,
    journal,
    settings,
    beep,
    noteManual: (n) => stats.noteManual(n),
    noteSign: (kind) => {
      const names = { stop: 'Стоп', cross: 'Пешеходный переход', bump: 'Искусственная неровность', light: 'светофор' };
      stats.noteSign(kind);
      lastSeen.sign = names[kind] || kind;
      lastSeen.signAt = Date.now();
    },
    noteLight: (kind) => stats.noteLight(kind),
    noteObstacle: (n) => stats.noteObstacle(n),
    noteFault: (n) => stats.noteFault(n),
    noteChargeCycle: (n) => stats.noteChargeCycle(n),
    isLockOpen: () => lock.open,
    closeLock,
    openPalette,
    showHelp,
    confirmModal,
    render,
    render1: () => { try { render(); } catch (e) {} },
    /** Интеграция метрик в главный цикл симуляции. */
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
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Главный цикл пульта (app.js) вызывает RSConsole.frame(now).
  window.RSConsole.frame = function (now) { tick(now || performance.now()); };
})();
