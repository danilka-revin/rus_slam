/* ============================================================================
 * console-core.js — ядро сервисного пульта RUS SLAM (без DOM).
 *
 * Технический план и описание — docs/SERVICE_CONSOLE.md.
 * Модуль работает и в браузере (window.RS), и в Node (module.exports) —
 * используется узлами пульта и модульными тестами gui/tests/console.test.js.
 *
 * Состав:
 *   RS.pack   — модель АКБ 12S3P LiFePO4 (SOC по OCV, энергия, пороги);
 *   RS.uart   — кадры протокола обмена (10 Б команда, 16 Б телеметрия, CRC16);
 *   RS.PinVault — PIN-хранилище замка ячейки (SHA-256 + соль, блокировки, аудит);
 *   RS.StatsStore — статистика: рейсы, события, энергия, экспорт CSV/JSON;
 *   RS.fmt     — форматирование чисел/времени.
 * ========================================================================== */
(function (global) {
  'use strict';

  const RS = (global.RS = global.RS || {});

  /* ======================================================================
   * 1. Форматирование
   * ==================================================================== */
  const fmt = {
    num(v, d) { return Number(v || 0).toFixed(d === undefined ? 1 : d); },
    int(v) { return String(Math.round(Number(v) || 0)); },
    volts(v) { return fmt.num(v, 2) + ' В'; },
    amps(v) { return fmt.num(v, 1) + ' А'; },
    watts(v) { return fmt.int(v) + ' Вт'; },
    wh(v) { return fmt.int(v) + ' Вт·ч'; },
    kg(v) { return fmt.int(v) + ' кг'; },
    km(m) {
      const km = (Number(m) || 0) / 1000;
      return (km < 1 ? fmt.int(km * 1000) + ' м' : fmt.num(km, 2) + ' км');
    },
    /** Секунды → «чч:мм:сс» */
    dur(sec) {
      sec = Math.max(0, Math.round(Number(sec) || 0));
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return [h, m, s].map((x) => String(x).padStart(2, '0')).join(':');
    },
    /** Секунды → «мм:сс» (компактно) */
    durShort(sec) {
      sec = Math.max(0, Math.round(Number(sec) || 0));
      const m = Math.floor(sec / 60), s = sec % 60;
      return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    },
    hex(bytes) {
      const a = Array.from(bytes || []);
      return a.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
    },
    date(ts) {
      const d = new Date(ts || Date.now());
      return d.toLocaleString('ru-RU', { hour12: false });
    },
    time(ts) {
      const d = new Date(ts || Date.now());
      return d.toLocaleTimeString('ru-RU', { hour12: false });
    },
  };

  /* ======================================================================
   * 2. Модель АКБ 12S3P LiFePO4 (36 × 32700, 38.4 В, 18.6 А·ч, 714.2 Вт·ч)
   *    Данные: docs/TECHNICAL_SPECIFICATION.md §8, config/safety.yaml
   * ==================================================================== */
  const PACK = {
    series: 12,
    parallel: 3,
    cellAh: 6.2,
    nominalV: 38.4,
    fullV: 43.8,
    emptyV: 30.0,
    capacityAh: 18.6,
    capacityWh: 714.2,
    bmsA: 60,
    fuseA: 25,
    internalR: 0.075,          // эквивалентное сопротивление сборки + проводка, Ом
    thresholds: {
      lowV: 35.5,              // ползучий режим (safety_node battery_low_v)
      criticalV: 33.5,         // аварийный стоп (battery_critical_v)
      tempWarnC: 45,
      tempMaxC: 60,
    },
    // Кривая OCV LiFePO4: [напряжение на элемент, SOC %]
    ocv: [
      [2.50, 0], [2.80, 3], [3.00, 7], [3.10, 10], [3.20, 15], [3.25, 30],
      [3.30, 50], [3.33, 70], [3.35, 85], [3.40, 95], [3.45, 98], [3.65, 100],
    ],
  };

  function _interp(table, x, col) {
    // col = 0: искать по напряжению → SOC; col = 1: искать по SOC → напряжение
    const key = col === 0 ? 0 : 1, val = col === 0 ? 1 : 0;
    if (x <= table[0][key]) return table[0][val];
    const last = table[table.length - 1];
    if (x >= last[key]) return last[val];
    for (let i = 1; i < table.length; i++) {
      const a = table[i - 1], b = table[i];
      if (x <= b[key]) {
        const k = (x - a[key]) / (b[key] - a[key] || 1);
        return a[val] + k * (b[val] - a[val]);
      }
    }
    return last[val];
  }

  /** SOC (%) по напряжению холостого хода пакета (В). */
  function socFromVoltage(packV) {
    return Math.max(0, Math.min(100, _interp(PACK.ocv, (Number(packV) || 0) / PACK.series, 0)));
  }

  /** Напряжение холостого хода пакета (В) по SOC (%). */
  function voltageFromSoc(soc) {
    return _interp(PACK.ocv, Math.max(0, Math.min(100, Number(soc) || 0)), 1) * PACK.series;
  }

  /**
   * Терминальное напряжение пакета: OCV минус просадка под разрядом
   * (или плюс подъём при заряде).
   * @param {number} soc   — SOC, %
   * @param {number} currentA — ток, А (>0 разряд, <0 заряд)
   */
  function terminalVoltage(soc, currentA) {
    const ocv = voltageFromSoc(soc);
    const i = Number(currentA) || 0;
    return Math.max(0, ocv - i * PACK.internalR);
  }

  /**
   * Шаг разряда по энергии: dE = U·I·dt/3600, dSOC = dE / E_max · 100 %.
   * @returns {number} новый SOC, %
   */
  function stepSoc(soc, voltageV, currentA, dtSec) {
    const dE = Math.max(0, Number(voltageV) || 0) * Math.max(0, Number(currentA) || 0)
      * Math.max(0, Number(dtSec) || 0) / 3600;
    return Math.max(0, Math.min(100, (Number(soc) || 0) - dE / PACK.capacityWh * 100));
  }

  function remainingWh(soc) { return PACK.capacityWh * Math.max(0, Math.min(100, Number(soc) || 0)) / 100; }

  /** Запас хода, км, по текущему расходу (Вт·ч/км); при нуле — паспортные 22 км. */
  function rangeKm(soc, whPerKm) {
    const c = Number(whPerKm) > 5 ? Number(whPerKm) : PACK.capacityWh / 22;
    return remainingWh(soc) / c;
  }

  /** Уровень по напряжению: 3 — норма, 2 — низкий, 1 — критический, 0 — авария. */
  function packLevel(voltageV) {
    const v = Number(voltageV) || 0;
    if (v >= PACK.thresholds.lowV) return { code: 3, label: 'НОРМА', cls: 'green' };
    if (v >= PACK.thresholds.criticalV) return { code: 2, label: 'НИЗКИЙ', cls: 'amber' };
    if (v >= PACK.emptyV) return { code: 1, label: 'КРИТИЧЕСКИЙ', cls: 'red' };
    return { code: 0, label: 'АВАРИЯ', cls: 'red' };
  }

  /** Снимок состояния пакета для панели «АКБ». */
  function packSnapshot(opts) {
    const o = opts || {};
    const soc = Math.max(0, Math.min(100, Number(o.soc) || 0));
    const voltage = Number(o.voltage) || terminalVoltage(soc, o.current || 0);
    const current = Number(o.current) || 0;
    const cellV = voltage / PACK.series;
    const spread = 0.012 + (1 - soc / 100) * 0.02;
    const level = packLevel(voltage);
    return {
      soc, voltage, ocv: voltageFromSoc(soc), current,
      power: voltage * current,
      charging: !!o.charging,
      remainingWh: remainingWh(soc),
      rangeKm: rangeKm(soc, o.whPerKm),
      level,
      tempC: Number(o.tempC) || 28,
      cycles: Number(o.cycles) || 0,
      cells: {
        min: +(cellV - spread).toFixed(3),
        max: +(cellV + spread * 1.25).toFixed(3),
        delta: +(spread * 2.25).toFixed(3),
      },
      thresholds: PACK.thresholds,
    };
  }

  RS.pack = {
    PACK,
    socFromVoltage, voltageFromSoc, terminalVoltage, stepSoc,
    remainingWh, rangeKm, packLevel, packSnapshot,
  };

  /* ======================================================================
   * 3. Протокол обмена (зеркало ros2_ws/src/rus_slam_base/.../protocol.py)
   *    См. docs/SERIAL_PROTOCOL.md
   * ==================================================================== */
  const CMD_SYNC0 = 0xAA, CMD_SYNC1 = 0x55;
  const TLM_SYNC0 = 0xBB, TLM_SYNC1 = 0x44;
  const CMD_LEN = 10, TLM_LEN = 16;
  const FLAG_ENABLE = 0x01, FLAG_HOME = 0x02;
  const STATUS_ENABLED = 0x01, STATUS_HOMED = 0x02, STATUS_FAULT = 0x04;
  const MAX_PWM = 1000, MAX_STEER_CDEG = 32767;
  const MODULE_IDS = [1, 2, 3, 4];
  const MODULE_NAMES = { 1: 'FL', 2: 'FR', 3: 'RL', 4: 'RR' };

  /** CRC16/Modbus (полином 0xA001, init 0xFFFF) — эталонный вектор "123456789" → 0x4B37. */
  function crc16(bytes) {
    let crc = 0xFFFF;
    for (const byte of bytes) {
      crc ^= byte & 0xFF;
      for (let i = 0; i < 8; i++) {
        crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) & 0xFFFF : (crc >> 1) & 0xFFFF;
      }
    }
    return crc & 0xFFFF;
  }

  function _i16(v) { return ((Math.round(v) % 65536) + 65536) % 65536; }

  /**
   * Кадр команды ПК → МК (10 байт).
   * @param {{moduleId:number, steerCdeg:number, pwm:number, enable:boolean, home:boolean}} c
   */
  function buildCommand(c) {
    const steer = Math.max(-MAX_STEER_CDEG, Math.min(MAX_STEER_CDEG, Math.round(c.steerCdeg || 0)));
    const pwm = Math.max(-MAX_PWM, Math.min(MAX_PWM, Math.round(c.pwm || 0)));
    let flags = 0;
    if (c.enable) flags |= FLAG_ENABLE;
    if (c.home) flags |= FLAG_HOME;
    const out = new Uint8Array(CMD_LEN);
    out[0] = CMD_SYNC0; out[1] = CMD_SYNC1; out[2] = c.moduleId & 0xFF;
    const s = _i16(steer), p = _i16(pwm);
    out[3] = (s >> 8) & 0xFF; out[4] = s & 0xFF;
    out[5] = (p >> 8) & 0xFF; out[6] = p & 0xFF;
    out[7] = flags;
    const crc = crc16(out.slice(0, 8));
    out[8] = (crc >> 8) & 0xFF; out[9] = crc & 0xFF;
    return out;
  }

  /** Кадр телеметрии МК → ПК (16 байт) — для тестов и модели стенда. */
  function buildTelemetry(t) {
    const out = new Uint8Array(TLM_LEN);
    out[0] = TLM_SYNC0; out[1] = TLM_SYNC1;
    out[2] = t.moduleId & 0xFF;
    out[3] = t.status & 0xFF;
    const s = _i16(t.steerCdeg || 0), e = _i16(t.encDelta || 0), p = _i16(t.pwmActual || 0);
    out[4] = (s >> 8) & 0xFF; out[5] = s & 0xFF;
    out[6] = (e >> 8) & 0xFF; out[7] = e & 0xFF;
    out[8] = (p >> 8) & 0xFF; out[9] = p & 0xFF;
    out[10] = (t.vbatCv >> 8) & 0xFF; out[11] = t.vbatCv & 0xFF;
    out[12] = (t.currentMa >> 8) & 0xFF; out[13] = t.currentMa & 0xFF;
    const crc = crc16(out.slice(0, 14));
    out[14] = (crc >> 8) & 0xFF; out[15] = crc & 0xFF;
    return out;
  }

  /** Разбор кадра телеметрии; null при неверной длине/CRC. */
  function parseTelemetry(bytes) {
    const b = Array.from(bytes || []);
    if (b.length < TLM_LEN) return null;
    if (b[0] !== TLM_SYNC0 || b[1] !== TLM_SYNC1) return null;
    const crc = (b[14] << 8) | b[15];
    if (crc !== crc16(b.slice(0, 14))) return null;
    const i16 = (hi, lo) => (((hi << 8) | lo) << 16) >> 16;
    return {
      moduleId: b[2], status: b[3],
      steerCdeg: i16(b[4], b[5]), encDelta: i16(b[6], b[7]), pwmActual: i16(b[8], b[9]),
      vbatCv: (b[10] << 8) | b[11], currentMa: (b[12] << 8) | b[13],
      enabled: !!(b[3] & STATUS_ENABLED), homed: !!(b[3] & STATUS_HOMED),
      fault: !!(b[3] & STATUS_FAULT),
      get steerRad() { return this.steerCdeg / 100 * Math.PI / 180; },
      get vbatV() { return this.vbatCv / 100; },
      get currentA() { return this.currentMa / 1000; },
    };
  }

  const uart = {
    CMD_LEN, TLM_LEN, FLAG_ENABLE, FLAG_HOME, STATUS_ENABLED, STATUS_HOMED, STATUS_FAULT,
    MAX_PWM, MAX_STEER_CDEG, MODULE_IDS, MODULE_NAMES,
    crc16, buildCommand, buildTelemetry, parseTelemetry, hex: fmt.hex,
    degToCdeg(deg) { return Math.round((Number(deg) || 0) * 100); },
    pwmFromPercent(pct) { return Math.max(-100, Math.min(100, Number(pct) || 0)) / 100 * MAX_PWM; },
  };
  RS.uart = uart;

  /* ======================================================================
   * 4. Хранилище (localStorage с деградацией до памяти)
   * ==================================================================== */
  function memoryStorage() {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
    };
  }

  function safeStorage(name) {
    try {
      const s = global[name];
      if (!s) return memoryStorage();
      const probe = '__rs_probe__';
      s.setItem(probe, '1');
      s.removeItem(probe);
      return s;
    } catch (e) {
      return memoryStorage();
    }
  }

  RS.safeStorage = safeStorage;

  /* ======================================================================
   * 5. Хеширование (SHA-256: WebCrypto → node:crypto → резервный FNV)
   * ==================================================================== */
  /**
   * Кодировщик UTF-8: TextEncoder есть не везде (старые браузеры, jsdom),
   * поэтому держим компактный резервный вариант.
   */
  const utf8 = (function () {
    if (typeof TextEncoder === 'function') {
      const enc = new TextEncoder();
      return { encode: (str) => enc.encode(str) };
    }
    return {
      encode(str) {
        str = String(str);
        const out = [];
        for (let i = 0; i < str.length; i++) {
          const c = str.charCodeAt(i);
          if (c < 0x80) out.push(c);
          else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 63));
          else if (c >= 0xD800 && c < 0xDC00 && i + 1 < str.length) {
            const cp = 0x10000 + ((c - 0xD800) << 10) + (str.charCodeAt(++i) - 0xDC00);
            out.push(0xF0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
          } else out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
        }
        return new Uint8Array(out);
      },
    };
  })();
  RS.utf8 = utf8;

  async function sha256Hex(text) {
    const data = typeof text === 'string' ? utf8.encode(text) : text;
    try {
      if (global.crypto && global.crypto.subtle) {
        const digest = await global.crypto.subtle.digest('SHA-256', data);
        return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
      }
    } catch (e) { /* переходим к резервному пути */ }
    try {
      // Node без global.crypto (старые версии)
      if (typeof require === 'function') {
        const nodeCrypto = require('crypto');
        return nodeCrypto.createHash('sha256').update(text).digest('hex');
      }
    } catch (e) { /* игнорируем */ }
    // Резервный (ослабленный) путь — только для сред без WebCrypto
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < String(text).length; i++) {
      const c = String(text).charCodeAt(i);
      h1 = ((h1 ^ c) * 0x01000193) >>> 0;
      h2 = ((h2 + c * (i + 1)) ^ (h2 << 5)) >>> 0;
    }
    return 'fnv:' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  function randomHex(nBytes) {
    const a = new Uint8Array(nBytes);
    if (global.crypto && global.crypto.getRandomValues) global.crypto.getRandomValues(a);
    else for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256);
    return Array.from(a).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /* ======================================================================
   * 6. Замок ячейки хранения (PIN + блокировка + аудит-цепочка)
   * ==================================================================== */
  const LOCK_KEY = 'rus_slam_lock_v1';
  const DEFAULT_PIN = '2580';

  class PinVault {
    /**
     * @param {Storage} [storage] — localStorage-совместимое хранилище
     * @param {{key?:string, maxAttempts?:number, lockMs?:number, defaultPin?:string}} [opts]
     */
    constructor(storage, opts) {
      const o = opts || {};
      this.storage = storage || safeStorage('localStorage');
      this.key = o.key || LOCK_KEY;
      this.maxAttempts = o.maxAttempts || 5;
      this.lockMs = o.lockMs || 30000;
      this.defaultPin = o.defaultPin || DEFAULT_PIN;
      this.onEvent = typeof o.onEvent === 'function' ? o.onEvent : null;
      this.data = null;
    }

    async init() {
      let raw = null;
      try { raw = JSON.parse(this.storage.getItem(this.key) || 'null'); } catch (e) { raw = null; }
      if (!raw || typeof raw !== 'object') {
        const salt = randomHex(16);
        this.data = {
          version: 1, salt, pinHash: await sha256Hex(salt + ':' + this.defaultPin),
          fails: 0, lockUntil: 0, audit: [], changedAt: Date.now(),
        };
        this._persist();
      } else {
        this.data = raw;
        this.data.audit = Array.isArray(raw.audit) ? raw.audit : [];
        this.data.fails = Number(raw.fails) || 0;
        this.data.lockUntil = Number(raw.lockUntil) || 0;
      }
      return this.data;
    }

    _persist() {
      try { this.storage.setItem(this.key, JSON.stringify(this.data)); } catch (e) { /* нет места */ }
    }

    async _lock(pin) { return sha256Hex(this.data.salt + ':' + pin); }

    lockRemainingMs(now) {
      const t = Number(now) || Date.now();
      return Math.max(0, (this.data ? this.data.lockUntil : 0) - t);
    }

    isLocked(now) { return this.lockRemainingMs(now) > 0; }

    static validatePinFormat(pin) {
      const s = String(pin == null ? '' : pin).trim();
      if (!/^\d{4,8}$/.test(s)) return { ok: false, reason: 'PIN — от 4 до 8 цифр' };
      return { ok: true };
    }

    /**
     * Проверка PIN.
     * @returns {Promise<{ok:boolean, reason:'ok'|'wrong'|'locked'|'format', fails:number, remainingMs:number}>}
     */
    async verify(pin) {
      if (!this.data) await this.init();
      const now = Date.now();
      const rem = this.lockRemainingMs(now);
      if (rem > 0) {
        this._emit('unlock', false);
        await this._audit('unlock', false, 'заблокировано, осталось ' + Math.ceil(rem / 1000) + ' с');
        return { ok: false, reason: 'locked', fails: this.data.fails, remainingMs: rem };
      }
      const chk = PinVault.validatePinFormat(pin);
      if (!chk.ok) return { ok: false, reason: 'format', fails: this.data.fails, remainingMs: 0 };
      const hash = await this._lock(String(pin).trim());
      if (hash === this.data.pinHash) {
        this.data.fails = 0;
        this.data.lockUntil = 0;
        this.data.lastOpenAt = now;
        this._persist();
        this._emit('unlock', true);
        await this._audit('unlock', true, 'доступ разрешён');
        return { ok: true, reason: 'ok', fails: 0, remainingMs: 0 };
      }
      // сбрасываем остывшую блокировку
      if (this.data.lockUntil && this.data.lockUntil <= now) { this.data.fails = 0; this.data.lockUntil = 0; }
      this.data.fails = (this.data.fails || 0) + 1;
      if (this.data.fails >= this.maxAttempts) {
        this.data.lockUntil = now + this.lockMs;
        this.data.fails = 0;
      }
      this._persist();
      this._emit('unlock', false);
      await this._audit('unlock', false, 'неверный PIN');
      return {
        ok: false, reason: 'wrong',
        fails: this.data.fails, remainingMs: this.lockRemainingMs(),
      };
    }

    /** Смена PIN: требуется текущий. */
    async setPin(currentPin, newPin) {
      if (!this.data) await this.init();
      const res = await this.verify(currentPin);
      if (!res.ok) {
        return { ok: false, reason: res.reason === 'locked' ? 'locked' : 'current', detail: 'текущий PIN неверен' };
      }
      const chk = PinVault.validatePinFormat(newPin);
      if (!chk.ok) return { ok: false, reason: 'format', detail: chk.reason };
      if (String(newPin).trim() === String(currentPin).trim()) {
        return { ok: false, reason: 'same', detail: 'новый PIN совпадает с текущим' };
      }
      this.data.salt = randomHex(16);
      this.data.pinHash = await this._lock(String(newPin).trim());
      this.data.changedAt = Date.now();
      this._persist();
      this._emit('pin_change', true);
      await this._audit('pin_change', true, 'PIN изменён');
      return { ok: true };
    }

    /** Сброс к заводскому PIN (требуется текущий). */
    async resetToDefault(currentPin) {
      return this.setPin(currentPin, this.defaultPin);
    }

    _emit(action, ok) {
      if (this.onEvent) {
        try { this.onEvent(action, ok); } catch (e) { /* не ломаем замок из-за статистики */ }
      }
    }

    audit(limit) {
      const a = (this.data && this.data.audit) || [];
      return a.slice(-(limit || 20)).reverse();
    }

    /** Запись аудита с хеш-цепочкой (защита от подделки журнала). */
    async _audit(action, ok, detail) {
      const prev = this.data.audit.length ? this.data.audit[this.data.audit.length - 1].hash : 'genesis';
      const ts = Date.now();
      const hash = await sha256Hex(prev + '|' + ts + '|' + action + '|' + (ok ? 1 : 0) + '|' + (detail || ''));
      this.data.audit.push({ ts, action, ok: !!ok, detail: detail || '', prev, hash });
      if (this.data.audit.length > 200) this.data.audit.shift();
      this._persist();
      return { ts, action, ok, detail, prev, hash };
    }

    /** Проверка целостности журнала аудита. */
    async verifyAudit() {
      if (!this.data) await this.init();
      let prev = 'genesis';
      for (let i = 0; i < this.data.audit.length; i++) {
        const e = this.data.audit[i];
        if (e.prev !== prev) return { ok: false, brokenAt: i };
        const hash = await sha256Hex(prev + '|' + e.ts + '|' + e.action + '|' + (e.ok ? 1 : 0) + '|' + (e.detail || ''));
        if (hash !== e.hash) return { ok: false, brokenAt: i };
        prev = e.hash;
      }
      return { ok: true, brokenAt: -1 };
    }
  }

  RS.PinVault = PinVault;
  RS.DEFAULT_PIN = DEFAULT_PIN;

  /* ======================================================================
   * 7. Статистика: рейсы, события, метрики сессии, экспорт
   * ==================================================================== */
  const STATS_KEY = 'rus_slam_stats_v1';

  function emptyTotals() {
    return {
      trips: 0, distanceM: 0, energyWh: 0, movingSec: 0, cargoKg: 0, cargoTrips: 0,
      maxSpeed: 0, chargeCycles: 0, manualOps: 0, obstacles: 0, faults: 0,
      locks: { open: 0, denied: 0, changed: 0 },
      signs: { stop: 0, pedestrian_crossing: 0, speed_bump: 0, unknown: 0 },
      lights: { red: 0, green: 0 },
    };
  }

  class StatsStore {
    /**
     * @param {Storage} [storage]
     * @param {{key?:string, capacity?:number, tripCapacity?:number}} [opts]
     */
    constructor(storage, opts) {
      const o = opts || {};
      this.storage = storage || safeStorage('localStorage');
      this.key = o.key || STATS_KEY;
      this.tripCapacity = o.tripCapacity || 200;
      this.data = this._load();
      this.session = {
        startedAt: Date.now(), distanceM: 0, energyWh: 0, movingSec: 0, maxSpeed: 0,
      };
      this._trip = null;
      this._dirty = false;
      this._lastSave = 0;
      this._tickSec = 0;
    }

    _load() {
      let raw = null;
      try { raw = JSON.parse(this.storage.getItem(this.key) || 'null'); } catch (e) { raw = null; }
      if (!raw || typeof raw !== 'object') {
        return { version: 1, updatedAt: Date.now(), totals: emptyTotals(), trips: [], daily: {} };
      }
      raw.totals = Object.assign(emptyTotals(), raw.totals || {});
      raw.totals.locks = Object.assign({ open: 0, denied: 0, changed: 0 }, raw.totals.locks);
      raw.totals.signs = Object.assign({ stop: 0, pedestrian_crossing: 0, speed_bump: 0, unknown: 0 }, raw.totals.signs);
      raw.totals.lights = Object.assign({ red: 0, green: 0 }, raw.totals.lights);
      raw.trips = Array.isArray(raw.trips) ? raw.trips : [];
      raw.daily = raw.daily || {};
      return raw;
    }

    save(force) {
      const now = Date.now();
      if (!force && now - this._lastSave < 15000) { this._dirty = true; return; }
      this.data.updatedAt = now;
      try { this.storage.setItem(this.key, JSON.stringify(this.data)); } catch (e) { /* нет места */ }
      this._dirty = false;
      this._lastSave = now;
    }

    /** Немедленная запись на диск (например, перед закрытием пульта). */
    flush() { this.save(true); }

    reset() {
      this.data = { version: 1, updatedAt: Date.now(), totals: emptyTotals(), trips: [], daily: {} };
      this.session = { startedAt: Date.now(), distanceM: 0, energyWh: 0, movingSec: 0, maxSpeed: 0 };
      this._trip = null;
      this.save(true);
    }

    get totals() { return this.data.totals; }
    get trips() { return this.data.trips; }
    get tripActive() { return !!this._trip; }

    _dayKey(ts) {
      const d = new Date(ts || Date.now());
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    /**
     * Шаг интеграции метрик (вызывается из главного цикла симулятора).
     * @param {number} dt — шаг, с
     * @param {{distanceM?:number, voltage:number, current:number, speed:number,
     *          auto:boolean, estop?:boolean, cargo?:boolean, payload?:number,
     *          origin?:string, mission?:string}} s
     */
    tick(dt, s) {
      const step = Math.max(0, Number(dt) || 0);
      if (!step) return;
      const speed = Math.max(0, Number(s.speed) || 0);
      const dist = Number(s.distanceM) || speed * step;
      const voltage = Number(s.voltage) || PACK.nominalV;
      const current = Math.max(0, Number(s.current) || 0);
      const dE = voltage * current * step / 3600;

      this.session.distanceM += dist;
      this.session.energyWh += dE;
      if (speed > 0.05) this.session.movingSec += step;
      this.session.maxSpeed = Math.max(this.session.maxSpeed, speed);

      this.data.totals.distanceM += dist;
      this.data.totals.energyWh += dE;
      if (speed > 0.05) this.data.totals.movingSec += step;
      this.data.totals.maxSpeed = Math.max(this.data.totals.maxSpeed, speed);
      const day = this._dayKey();
      const d = this.data.daily[day] || (this.data.daily[day] = { distanceM: 0, energyWh: 0, trips: 0, cargoKg: 0 });
      d.distanceM += dist; d.energyWh += dE;

      // Рейсы: автоматический режим «auto» = активная миссия
      if (s.auto && !this._trip) this._beginTrip(s);
      if (this._trip) {
        this._trip.distanceM += dist;
        this._trip.energyWh += dE;
        if (speed > 0.05) this._trip.movingSec += step;
        this._trip.maxSpeed = Math.max(this._trip.maxSpeed, speed);
        if (s.cargo) this._trip.cargoKg = Math.max(this._trip.cargoKg, Number(s.payload) || 0);
      }
      if (this._trip && (s.estop || !s.auto)) {
        this._endTrip(s.estop ? 'aborted' : 'ok', s);
      }
      this._tickSec += step;
      if (this._tickSec >= 1) { this._tickSec = 0; this.save(false); }
    }

    _beginTrip(s) {
      this._trip = {
        id: this.data.trips.length + 1,
        startedAt: Date.now(),
        distanceM: 0, energyWh: 0, movingSec: 0, maxSpeed: 0,
        cargoKg: s.cargo ? (Number(s.payload) || 0) : 0,
        from: s.origin || 'база',
        to: s.mission || 'AUTO',
        route: (s.origin || '—') + ' → ' + (s.mission || 'AUTO'),
      };
      RS._onTripStart && RS._onTripStart(this._trip);
    }

    _endTrip(result, s) {
      const t = this._trip;
      this._trip = null;
      if (!t) return null;
      const endedAt = Date.now();
      const durationSec = (endedAt - t.startedAt) / 1000;
      const avg = t.movingSec > 0.5 ? t.distanceM / t.movingSec : 0;
      const trip = Object.assign(t, {
        endedAt, durationSec, result,
        avgSpeed: avg,
        to: (s && s.mission) || t.to,
        route: t.from + ' → ' + ((s && s.mission) || t.to),
      });
      this.data.trips.push(trip);
      if (this.data.trips.length > this.tripCapacity) this.data.trips.shift();
      const tot = this.data.totals;
      tot.trips += 1;
      tot.cargoKg += trip.cargoKg;
      if (trip.cargoKg > 0) tot.cargoTrips += 1;
      if (result !== 'ok') tot.faults += 1;
      const day = this._dayKey(trip.startedAt);
      const d = this.data.daily[day] || (this.data.daily[day] = { distanceM: 0, energyWh: 0, trips: 0, cargoKg: 0 });
      d.trips += 1; d.cargoKg += trip.cargoKg;
      if (result !== 'ok') d.faults = (d.faults || 0) + 1;
      this.save(true);
      RS._onTripEnd && RS._onTripEnd(trip);
      return trip;
    }

    /** Принудительное завершение рейса (например, по E-STOP). */
    abortTrip(reason, s) { return this._endTrip(reason || 'aborted', s || {}); }

    _bump(path, n) {
      const parts = path.split('.');
      let obj = this.data.totals;
      for (let i = 0; i < parts.length - 1; i++) {
        obj[parts[i]] = obj[parts[i]] || {};
        obj = obj[parts[i]];
      }
      const key = parts[parts.length - 1];
      obj[key] = (obj[key] || 0) + (n === undefined ? 1 : n);
      this._dirty = true;
    }

    /**
     * Счётчики событий пишутся на диск сразу: событий мало (десятки за
     * испытание), а потеря счётчика при перезапуске пульта недопустима.
     */
    _event(path, n) { this._bump(path, n); this.save(true); }

    noteSign(kind) {
      const k = this.data.totals.signs[kind] === undefined ? 'unknown' : kind;
      this._event('signs.' + k);
    }
    noteLight(kind) { this._event('lights.' + (kind === 'green' ? 'green' : 'red')); }
    noteObstacle(n) { this._event('obstacles', n); }
    noteManual(n) { this._event('manualOps', n); }
    noteFault(n) { this._event('faults', n); }
    noteChargeCycle(n) { this._event('chargeCycles', n); }
    noteLock(kind) {
      if (kind === 'open') this._event('locks.open');
      else if (kind === 'changed') this._event('locks.changed');
      else this._event('locks.denied');
    }

    /** Производные показатели для панели статистики. */
    summary() {
      const t = this.data.totals;
      const km = t.distanceM / 1000;
      const sessionKm = this.session.distanceM / 1000;
      return {
        trips: t.trips,
        distanceM: t.distanceM,
        distanceKm: km,
        energyWh: t.energyWh,
        cargoKg: t.cargoKg,
        movingSec: t.movingSec,
        maxSpeed: t.maxSpeed,
        chargeCycles: t.chargeCycles,
        manualOps: t.manualOps,
        obstacles: t.obstacles,
        faults: t.faults,
        signs: Object.assign({}, t.signs),
        lights: Object.assign({}, t.lights),
        locks: Object.assign({}, t.locks),
        avgTripSec: t.trips ? t.movingSec / t.trips : 0,
        avgSpeedKmh: t.movingSec > 1 ? (t.distanceM / t.movingSec) * 3.6 : 0,
        whPerKm: km > 0.05 ? t.energyWh / km : 0,
        session: {
          distanceM: this.session.distanceM,
          distanceKm: sessionKm,
          energyWh: this.session.energyWh,
          movingSec: this.session.movingSec,
          maxSpeed: this.session.maxSpeed,
          whPerKm: sessionKm > 0.05 ? this.session.energyWh / sessionKm : 0,
          startedAt: this.session.startedAt,
        },
        recentTrips: this.data.trips.slice(-10).reverse(),
      };
    }

    /** Расход сессии, Вт·ч/км (для оценки запаса хода). */
    whPerKm() { return this.summary().session.whPerKm || this.summary().whPerKm; }

    toCSV() {
      const s = this.summary();
      const lines = [];
      lines.push('# RUS SLAM — статистика сервисного пульта');
      lines.push('# сформировано;' + new Date().toISOString());
      lines.push('');
      lines.push('Показатель;Значение');
      lines.push('Рейсов;' + s.trips);
      lines.push('Пробег, м;' + s.distanceM.toFixed(1));
      lines.push('Энергия, Вт·ч;' + s.energyWh.toFixed(1));
      lines.push('Груз, кг;' + s.cargoKg);
      lines.push('Время в движении, с;' + s.movingSec.toFixed(0));
      lines.push('Средняя скорость, км/ч;' + s.avgSpeedKmh.toFixed(2));
      lines.push('Расход, Вт·ч/км;' + s.whPerKm.toFixed(1));
      lines.push('Максимальная скорость, м/с;' + s.maxSpeed.toFixed(2));
      lines.push('Циклов заряда;' + s.chargeCycles);
      lines.push('Объездов препятствий;' + s.obstacles);
      lines.push('Ручных команд;' + s.manualOps);
      lines.push('Открытий замка;' + s.locks.open);
      lines.push('Отказов доступа;' + s.locks.denied);
      lines.push('Знак Стоп;' + s.signs.stop);
      lines.push('Знак переход;' + s.signs.pedestrian_crossing);
      lines.push('Знак неровность;' + s.signs.speed_bump);
      lines.push('Светофор красный;' + s.lights.red);
      lines.push('Светофор зелёный;' + s.lights.green);
      lines.push('');
      lines.push('# Рейсы');
      lines.push('id;начало;окончание;маршрут;дистанция_м;энергия_Втч;время_с;движение_с;груз_кг;ср_скорость_мс;макс_скорость_мс;результат');
      for (const t of this.data.trips) {
        lines.push([
          t.id, new Date(t.startedAt).toISOString(), new Date(t.endedAt).toISOString(),
          (t.route || '').replace(/;/g, ','), t.distanceM.toFixed(1), t.energyWh.toFixed(1),
          t.durationSec.toFixed(0), t.movingSec.toFixed(0), t.cargoKg || 0,
          (t.avgSpeed || 0).toFixed(2), (t.maxSpeed || 0).toFixed(2), t.result,
        ].join(';'));
      }
      return lines.join('\n');
    }

    toJSON() {
      return JSON.stringify({
        generatedAt: new Date().toISOString(),
        device: 'RUS SLAM 4WIS/4WID, НТЦ АО «АВТОВАЗ»',
        summary: this.summary(),
        totals: this.data.totals,
        daily: this.data.daily,
        trips: this.data.trips,
      }, null, 2);
    }

    /** Печатный отчёт (HTML): сводка, события, рейсы, подпись. */
    reportHTML() {
      const s = this.summary();
      const rows = this.data.trips.slice(-25).reverse().map((t) => `
        <tr><td>${t.id}</td><td>${fmt.date(t.startedAt)}</td><td>${t.route || ''}</td>
        <td>${(t.distanceM / 1000).toFixed(3)}</td><td>${t.energyWh.toFixed(1)}</td>
        <td>${fmt.dur(t.movingSec)}</td><td>${t.cargoKg || 0}</td>
        <td>${(t.avgSpeed || 0).toFixed(2)}</td><td>${t.result}</td></tr>`).join('');
      return `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">
<title>RUS SLAM — отчёт о работе</title>
<style>
 body{font:13px/1.45 Arial,Helvetica,sans-serif;color:#17211d;margin:24px}
 h1{font-size:19px;margin:0 0 2px} h2{font-size:14px;margin:18px 0 6px}
 .muted{color:#6a7570;font-size:11px}
 table{border-collapse:collapse;width:100%;margin-top:6px}
 th,td{border:1px solid #cfd8d3;padding:4px 6px;font-size:11px;text-align:left}
 th{background:#eef3f0}
 .kpi{display:flex;flex-wrap:wrap;gap:10px;margin-top:8px}
 .kpi div{border:1px solid #cfd8d3;border-radius:8px;padding:8px 12px;min-width:120px}
 .kpi b{display:block;font-size:16px}
 .sig{margin-top:26px;font-size:12px;color:#333}
</style></head><body>
<h1>RUS SLAM — отчёт о работе робота-курьера 4WIS/4WID</h1>
<div class="muted">НТЦ АО «АВТОВАЗ» · сформировано ${fmt.date(Date.now())} · источник: сервисный пульт, окно «Сервис»</div>
<h2>Сводка</h2>
<div class="kpi">
 <div><span>Рейсов</span><b>${s.trips}</b></div>
 <div><span>Пробег</span><b>${(s.distanceM / 1000).toFixed(2)} км</b></div>
 <div><span>Энергия</span><b>${s.energyWh.toFixed(0)} Вт·ч</b></div>
 <div><span>Груз</span><b>${s.cargoKg} кг</b></div>
 <div><span>Время в движении</span><b>${fmt.dur(s.movingSec)}</b></div>
 <div><span>Средняя скорость</span><b>${s.avgSpeedKmh.toFixed(2)} км/ч</b></div>
 <div><span>Расход</span><b>${s.whPerKm.toFixed(1)} Вт·ч/км</b></div>
 <div><span>Циклов заряда</span><b>${s.chargeCycles}</b></div>
</div>
<h2>События и доступ к грузу</h2>
<table><tr><th>Показатель</th><th>Значение</th></tr>
 <tr><td>Знак «Стоп» / переход / неровность</td><td>${s.signs.stop} / ${s.signs.pedestrian_crossing} / ${s.signs.speed_bump}</td></tr>
 <tr><td>Светофор (красный / зелёный)</td><td>${s.lights.red} / ${s.lights.green}</td></tr>
 <tr><td>Объездов препятствий</td><td>${s.obstacles}</td></tr>
 <tr><td>Ручных сервисных команд</td><td>${s.manualOps}</td></tr>
 <tr><td>Открытий ячейки / отказов / смен PIN</td><td>${s.locks.open} / ${s.locks.denied} / ${s.locks.changed}</td></tr>
 <tr><td>Сбоев и аварий</td><td>${s.faults}</td></tr>
</table>
<h2>Рейсы (последние ${Math.min(25, this.data.trips.length)})</h2>
${this.data.trips.length ? `<table><tr><th>№</th><th>Начало</th><th>Маршрут</th><th>км</th><th>Вт·ч</th><th>движение</th><th>груз, кг</th><th>ср., м/с</th><th>итог</th></tr>${rows}</table>`
        : '<div class="muted">Рейсы ещё не зафиксированы.</div>'}
<div class="sig">Оператор смены: ____________________ &nbsp;&nbsp;&nbsp; Подпись: ____________________</div>
</body></html>`;
    }
  }

  RS.StatsStore = StatsStore;
  RS.fmt = fmt;
  RS.sha256Hex = sha256Hex;
  RS.randomHex = randomHex;
  RS.emptyTotals = emptyTotals;
  RS.version = '1.0.0';

  if (typeof module !== 'undefined' && module.exports) module.exports = RS;
})(typeof globalThis !== 'undefined' ? globalThis : this);
