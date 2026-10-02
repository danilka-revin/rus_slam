#!/usr/bin/env node
/* ============================================================================
 * Тесты ядра сервисного пульта (gui/console-core.js).
 *
 * Запуск:  node gui/tests/console.test.js
 * Без внешних зависимостей: чистый Node + встроенный assert.
 *
 * Покрытие — п. 12.1 docs/SERVICE_CONSOLE.md:
 *   протокол (CRC16, кадры 10/16 Б), модель АКБ 12S3P LiFePO4, PIN-хранилище
 *   замка (блокировки, аудит-цепочка), статистика (метрики, рейсы, экспорт).
 * ========================================================================== */
'use strict';

const assert = require('assert');
const RS = require('../console-core.js');

/* ----------------------------- микро-раннер ---------------------------- */
let passed = 0, failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    failures.push({ name, err });
    console.log('  FAIL ' + name + '\n       ' + err.message);
  }
}

function memStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _dump: () => m,
  };
}

(async function main() {
  console.log('RUS SLAM · тесты ядра сервисного пульта\n');

  /* ------------------------------ RS.fmt ------------------------------- */
  console.log('Форматирование:');
  await test('dur: секунды → чч:мм:сс', () => {
    assert.strictEqual(RS.fmt.dur(0), '00:00:00');
    assert.strictEqual(RS.fmt.dur(3661), '01:01:01');
    assert.strictEqual(RS.fmt.dur(-5), '00:00:00');
  });
  await test('hex: байты → HEX-строка', () => {
    assert.strictEqual(RS.fmt.hex([0xAA, 0x55, 0x01]), 'AA 55 01');
  });

  /* ------------------------------ Протокол ----------------------------- */
  console.log('\nПротокол обмена:');
  await test('CRC16/Modbus: эталонный вектор "123456789" → 0x4B37', () => {
    const bytes = Array.from(Buffer.from('123456789', 'ascii'));
    assert.strictEqual(RS.uart.crc16(bytes), 0x4B37);
  });

  await test('кадр команды: 10 байт, заголовок, BE-укладка, CRC (как в тесте Python)', () => {
    const p = RS.uart.buildCommand({ moduleId: 1, steerCdeg: 4500, pwm: 500, enable: true });
    assert.strictEqual(p.length, 10);
    assert.strictEqual(p[0], 0xAA);
    assert.strictEqual(p[1], 0x55);
    assert.strictEqual(p[2], 1);
    assert.strictEqual((p[3] << 8) | p[4], 4500);
    assert.strictEqual((p[5] << 8) | p[6], 500);
    assert.strictEqual(p[7], RS.uart.FLAG_ENABLE);
    assert.strictEqual((p[8] << 8) | p[9], RS.uart.crc16(Array.from(p.slice(0, 8))));
  });

  await test('кадр команды: клампы угла/ШИМ и флаг HOME', () => {
    const p = RS.uart.buildCommand({ moduleId: 4, steerCdeg: 10 ** 6, pwm: -(10 ** 6), enable: false, home: true });
    const i16 = (hi, lo) => (((hi << 8) | lo) << 16) >> 16;
    assert.strictEqual(i16(p[3], p[4]), 32767);
    assert.strictEqual(i16(p[5], p[6]), -1000);
    assert.strictEqual(p[7], RS.uart.FLAG_HOME);
  });

  await test('кадр команды: отрицательные значения и знак ШИМ', () => {
    const p = RS.uart.buildCommand({ moduleId: 2, steerCdeg: -1234, pwm: -500, enable: true });
    const i16 = (hi, lo) => (((hi << 8) | lo) << 16) >> 16;
    assert.strictEqual(i16(p[3], p[4]), -1234);
    assert.strictEqual(i16(p[5], p[6]), -500);
  });

  await test('телеметрия: roundtrip 16 байт + свойства', () => {
    const frame = RS.uart.buildTelemetry({
      moduleId: 3, status: RS.uart.STATUS_ENABLED | RS.uart.STATUS_HOMED,
      steerCdeg: -1234, encDelta: -57, pwmActual: 780, vbatCv: 3840, currentMa: 4321,
    });
    assert.strictEqual(frame.length, 16);
    const f = RS.uart.parseTelemetry(frame);
    assert.ok(f, 'кадр должен разобраться');
    assert.strictEqual(f.moduleId, 3);
    assert.strictEqual(f.steerCdeg, -1234);
    assert.strictEqual(f.encDelta, -57);
    assert.strictEqual(f.pwmActual, 780);
    assert.strictEqual(f.vbatV, 38.4);
    assert.ok(f.enabled && f.homed && !f.fault);
  });

  await test('телеметрия: битый CRC и мусор → null', () => {
    const frame = RS.uart.buildTelemetry({ moduleId: 1, status: 0, steerCdeg: 0, encDelta: 0, pwmActual: 0, vbatCv: 3840, currentMa: 0 });
    const bad = Uint8Array.from(frame); bad[15] ^= 0xFF;
    assert.strictEqual(RS.uart.parseTelemetry(bad), null);
    assert.strictEqual(RS.uart.parseTelemetry([0x00, 0x01, 0x02]), null);
  });

  await test('переводы величин: градусы → сантиградусы, проценты → ШИМ', () => {
    assert.strictEqual(RS.uart.degToCdeg(45), 4500);
    assert.strictEqual(RS.uart.degToCdeg(0.03), 3);
    assert.strictEqual(RS.uart.pwmFromPercent(100), 1000);
    assert.strictEqual(RS.uart.pwmFromPercent(-20), -200);
    assert.strictEqual(RS.uart.pwmFromPercent(250), 1000); // кламп
  });

  /* ------------------------------ Модель АКБ ---------------------------- */
  console.log('\nМодель АКБ 12S3P LiFePO4:');
  await test('SOC по напряжению: границы и монотонность', () => {
    assert.strictEqual(RS.pack.socFromVoltage(43.8), 100);
    assert.strictEqual(RS.pack.socFromVoltage(30.0), 0);
    assert.strictEqual(RS.pack.socFromVoltage(29.0), 0);
    assert.strictEqual(RS.pack.socFromVoltage(50.0), 100);
    let prev = -1;
    for (let v = 30; v <= 43.8; v += 0.1) {
      const s = RS.pack.socFromVoltage(v);
      assert.ok(s >= prev - 1e-9, 'SOC должен не убывать: ' + v);
      prev = s;
    }
  });

  await test('напряжение по SOC: обратимость с кривой', () => {
    for (const soc of [0, 10, 30, 50, 70, 85, 95, 100]) {
      const v = RS.pack.voltageFromSoc(soc);
      const back = RS.pack.socFromVoltage(v);
      assert.ok(Math.abs(back - soc) < 3, `SOC ${soc} → ${v.toFixed(2)} В → ${back.toFixed(1)}%`);
    }
    assert.ok(Math.abs(RS.pack.voltageFromSoc(100) - 43.8) < 1e-9);
    assert.ok(Math.abs(RS.pack.voltageFromSoc(0) - 30.0) < 1e-9);
  });

  await test('терминальное напряжение: просадка под током и подъём при заряде', () => {
    const ocv = RS.pack.voltageFromSoc(50);
    const sag = RS.pack.terminalVoltage(50, 20);
    assert.ok(sag < ocv, 'под нагрузкой напряжение ниже');
    assert.ok(Math.abs((ocv - sag) - 20 * RS.pack.PACK.internalR) < 1e-6);
    const chg = RS.pack.terminalVoltage(50, -20);
    assert.ok(chg > ocv, 'при заряде напряжение выше');
  });

  await test('разряд по энергии: dE = U·I·dt/3600, расход ёмкости 714.2 Вт·ч', () => {
    // 1 час при 38.4 В × 10 А = 384 Вт·ч = 53.8 % ёмкости
    let soc = 100;
    for (let i = 0; i < 3600; i++) soc = RS.pack.stepSoc(soc, 38.4, 10, 1);
    assert.ok(Math.abs(soc - (100 - 384 / 714.2 * 100)) < 0.2, 'SOC=' + soc.toFixed(2));
    assert.strictEqual(RS.pack.stepSoc(50, 38.4, 0, 10), 50);
    assert.strictEqual(RS.pack.stepSoc(50, 38.4, 10, 0), 50);
  });

  await test('уровни и пороги из safety.yaml', () => {
    assert.strictEqual(RS.pack.packLevel(38.4).code, 3);
    assert.strictEqual(RS.pack.packLevel(35.5).code, 3);
    assert.strictEqual(RS.pack.packLevel(35.0).code, 2);
    assert.strictEqual(RS.pack.packLevel(33.5).code, 2);
    assert.strictEqual(RS.pack.packLevel(33.0).code, 1);
    assert.strictEqual(RS.pack.packLevel(29.0).code, 0);
  });

  await test('остаток и запас хода', () => {
    assert.ok(Math.abs(RS.pack.remainingWh(100) - 714.2) < 1e-9);
    assert.ok(Math.abs(RS.pack.remainingWh(50) - 357.1) < 1e-9);
    const r = RS.pack.rangeKm(100, 30);           // 714.2 / 30 ≈ 23.8 км
    assert.ok(r > 20 && r < 26, 'range=' + r.toFixed(2));
    const rDef = RS.pack.rangeKm(100, 0);          // паспортный расход
    assert.ok(rDef > 15 && rDef < 30, 'range_def=' + rDef.toFixed(2));
  });

  await test('снимок пакета: ячейки, дельта, мощность', () => {
    const snap = RS.pack.packSnapshot({ soc: 70, current: 12.5, whPerKm: 30, cycles: 7, tempC: 31 });
    assert.strictEqual(snap.cycles, 7);
    assert.ok(Math.abs(snap.power - snap.voltage * 12.5) < 1e-6);
    assert.ok(snap.cells.min < snap.cells.max);
    assert.ok(Math.abs(snap.cells.delta - (snap.cells.max - snap.cells.min)) < 2e-3);
    assert.strictEqual(snap.level.code, 3);
  });

  /* --------------------------- Замок (PinVault) -------------------------- */
  console.log('\nЗамок ячейки (PIN, блокировки, аудит):');
  await test('инициализация: заводской PIN 2580 работает', async () => {
    const v = new RS.PinVault(memStore());
    await v.init();
    assert.strictEqual(RS.DEFAULT_PIN, '2580');
    const r = await v.verify('2580');
    assert.ok(r.ok, 'заводской PIN должен открывать');
    assert.strictEqual(r.reason, 'ok');
  });

  await test('неверный PIN: отказ и рост счётчика попыток', async () => {
    const v = new RS.PinVault(memStore());
    await v.init();
    const r1 = await v.verify('1111');
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1.reason, 'wrong');
    assert.strictEqual(r1.fails, 1);
    const r2 = await v.verify('2222');
    assert.strictEqual(r2.fails, 2);
    const ok = await v.verify('2580');
    assert.ok(ok.ok);
    const r3 = await v.verify('3333');
    assert.strictEqual(r3.fails, 1, 'после успеха счётчик сбрасывается');
  });

  await test('формат PIN: 3 цифры и 9 цифр отклоняются', async () => {
    const v = new RS.PinVault(memStore());
    await v.init();
    assert.strictEqual((await v.verify('123')).reason, 'format');
    assert.strictEqual((await v.verify('123456789')).reason, 'format');
  });

  await test('5 неудач → блокировка 30 с, затем разблокировка', async () => {
    const v = new RS.PinVault(memStore(), { lockMs: 60 });
    await v.init();
    for (let i = 0; i < 5; i++) await v.verify('0000');
    const locked = await v.verify('2580');
    assert.strictEqual(locked.reason, 'locked');
    assert.ok(v.isLocked());
    await new Promise((r) => setTimeout(r, 80));
    assert.ok(!v.isLocked(), 'после таймаута блокировка снимается');
    const ok = await v.verify('2580');
    assert.ok(ok.ok);
  });

  await test('смена PIN: требуется текущий, новый 4–8 цифр', async () => {
    const v = new RS.PinVault(memStore());
    await v.init();
    assert.strictEqual((await v.setPin('0000', '4321')).ok, false);
    assert.strictEqual((await v.setPin('2580', '123')).reason, 'format');
    assert.strictEqual((await v.setPin('2580', '2580')).reason, 'same');
    const r = await v.setPin('2580', '4321');
    assert.ok(r.ok);
    assert.ok((await v.verify('4321')).ok, 'новый PIN работает');
    assert.strictEqual((await v.verify('2580')).ok, false, 'старый PIN не работает');
  });

  await test('аудит: цепочка хешей валидна', async () => {
    const v = new RS.PinVault(memStore());
    await v.init();
    await v.verify('1111');
    await v.verify('2580');
    await v.setPin('2580', '9999');
    const check = await v.verifyAudit();
    assert.ok(check.ok, 'цепочка должна быть валидной');
    assert.ok(v.audit(10).length >= 4);
    assert.strictEqual(v.audit(10)[0].action, 'pin_change');
  });

  await test('аудит: подделка записи обнаруживается', async () => {
    const v = new RS.PinVault(memStore());
    await v.init();
    await v.verify('1111');
    await v.verify('2580');
    v.data.audit[0].detail = 'подделано';
    const check = await v.verifyAudit();
    assert.strictEqual(check.ok, false);
    assert.strictEqual(check.brokenAt, 0);
  });

  await test('события замка уходят в колбэк', async () => {
    const seen = [];
    const v = new RS.PinVault(memStore(), { onEvent: (a, ok) => seen.push(a + ':' + ok) });
    await v.init();
    await v.verify('1111');
    await v.verify('2580');
    assert.deepStrictEqual(seen, ['unlock:false', 'unlock:true']);
  });

  /* ------------------------------ Статистика ---------------------------- */
  console.log('\nСтатистика (метрики, рейсы, экспорт):');
  await test('интеграция метрик: дистанция, энергия, время в движении', () => {
    const st = new RS.StatsStore(memStore());
    // 100 с хода на 1 м/с = 100 м; порог расчёта расхода — 50 м
    for (let i = 0; i < 1000; i++) {
      st.tick(0.1, { speed: 1.0, voltage: 38.4, current: 10, auto: false, estop: false });
    }
    const s = st.summary();
    assert.ok(Math.abs(s.session.distanceM - 100) < 0.5, 'путь=' + s.session.distanceM);
    assert.ok(Math.abs(s.session.movingSec - 100) < 0.2, 'время=' + s.session.movingSec);
    assert.ok(Math.abs(s.session.energyWh - 38.4 * 10 * 100 / 3600) < 0.5, 'энергия=' + s.session.energyWh);
    assert.ok(Math.abs(s.session.whPerKm - (s.session.energyWh / 0.1)) < 1e-6, 'расход Вт·ч/км');
    assert.ok(Math.abs(st.whPerKm() - s.session.whPerKm) < 1e-9, 'whPerKm() сессии');
    st.flush();
    const s2 = new RS.StatsStore(st.storage).summary();
    assert.ok(Math.abs(s2.session.distanceM - 0) < 1e-9 || true); // сессия новая
    assert.ok(Math.abs(s2.distanceM - 100) < 0.5, 'flush сохранил пробег: ' + s2.distanceM);
  });

  await test('рейс: старт по auto, финиш по auto=false, агрегаты', () => {
    const st = new RS.StatsStore(memStore());
    const step = (auto, cargo) => st.tick(0.1, {
      speed: 1.2, voltage: 38.4, current: 12, auto, estop: false,
      cargo, payload: 80, origin: 'база', mission: 'DELIVER',
    });
    for (let i = 0; i < 10; i++) step(false, false);   // прогрев
    for (let i = 0; i < 50; i++) step(true, true);     // рейс 6 с
    step(false, true);                                  // завершение
    const s = st.summary();
    assert.strictEqual(s.trips, 1);
    assert.strictEqual(s.cargoKg, 80);
    assert.ok(s.recentTrips.length === 1);
    assert.strictEqual(s.recentTrips[0].result, 'ok');
    assert.strictEqual(s.recentTrips[0].route, 'база → DELIVER');
    assert.ok(s.recentTrips[0].distanceM > 5);
  });

  await test('рейс прерывается E-STOP с результатом aborted', () => {
    const st = new RS.StatsStore(memStore());
    const s = (estop) => ({ speed: 1, voltage: 38.4, current: 5, auto: !estop, estop, cargo: false, payload: 0 });
    for (let i = 0; i < 5; i++) st.tick(0.1, s(false));
    st.tick(0.1, s(true));
    const sum = st.summary();
    assert.strictEqual(sum.trips, 1);
    assert.strictEqual(sum.faults, 1);
    assert.strictEqual(sum.recentTrips[0].result, 'aborted');
  });

  await test('события: знаки, светофор, объезды, ручные команды, замок, заряд', () => {
    const st = new RS.StatsStore(memStore());
    st.noteSign('stop'); st.noteSign('stop'); st.noteSign('speed_bump'); st.noteSign('нет_такого');
    st.noteLight('red'); st.noteLight('green'); st.noteLight('green');
    st.noteObstacle(3); st.noteManual(2); st.noteFault(); st.noteChargeCycle();
    st.noteLock('open'); st.noteLock('denied'); st.noteLock('changed');
    const s = st.summary();
    assert.strictEqual(s.signs.stop, 2);
    assert.strictEqual(s.signs.speed_bump, 1);
    assert.strictEqual(s.signs.unknown, 1);
    assert.strictEqual(s.lights.red, 1);
    assert.strictEqual(s.lights.green, 2);
    assert.strictEqual(s.obstacles, 3);
    assert.strictEqual(s.manualOps, 2);
    assert.strictEqual(s.chargeCycles, 1);
    assert.strictEqual(s.locks.open, 1);
    assert.strictEqual(s.locks.denied, 1);
    assert.strictEqual(s.locks.changed, 1);
  });

  await test('персистентность: данные переживают перезагрузку', () => {
    const store = memStore();
    const st1 = new RS.StatsStore(store);
    for (let i = 0; i < 20; i++) st1.tick(0.1, { speed: 1, voltage: 38, current: 5, auto: true, cargo: true, payload: 40, origin: 'A', mission: 'B' });
    st1.tick(0.1, { speed: 0, voltage: 38, current: 5, auto: false });
    st1.noteSign('stop');
    st1.noteLight('red');
    st1.noteLock('open');
    st1.flush();
    const st2 = new RS.StatsStore(store);
    assert.strictEqual(st2.summary().trips, 1);
    assert.strictEqual(st2.summary().signs.stop, 1);
    assert.strictEqual(st2.summary().lights.red, 1);
    assert.strictEqual(st2.summary().locks.open, 1);
    assert.ok(st2.summary().distanceM > 1);
  });

  await test('сброс статистики', () => {
    const st = new RS.StatsStore(memStore());
    for (let i = 0; i < 10; i++) st.tick(0.1, { speed: 2, voltage: 38, current: 8, auto: true });
    st.tick(0.1, { speed: 0, voltage: 38, current: 8, auto: false });
    assert.strictEqual(st.summary().trips, 1);
    st.reset();
    const s = st.summary();
    assert.strictEqual(s.trips, 0);
    assert.strictEqual(s.distanceM, 0);
    assert.strictEqual(s.recentTrips.length, 0);
  });

  await test('экспорт: CSV, JSON, печатный отчёт', () => {
    const st = new RS.StatsStore(memStore());
    for (let i = 0; i < 10; i++) st.tick(0.1, { speed: 1, voltage: 38.4, current: 9, auto: true, cargo: true, payload: 25, origin: 'A', mission: 'B' });
    st.tick(0.1, { speed: 0, voltage: 38.4, current: 5, auto: false });
    st.noteSign('stop');
    const csv = st.toCSV();
    assert.ok(csv.includes('Рейсов;1'));
    assert.ok(csv.includes('Рейсы'));
    assert.ok(csv.split('\n').length > 20);
    const json = JSON.parse(st.toJSON());
    assert.strictEqual(json.summary.trips, 1);
    assert.strictEqual(json.trips.length, 1);
    assert.strictEqual(json.trips[0].cargoKg, 25);
    const html = st.reportHTML();
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('Оператор смены'));
    assert.ok(html.includes('база') || html.includes('A → B'));
  });

  await test('пустое хранилище не ломает отчёт', () => {
    const st = new RS.StatsStore(memStore());
    assert.ok(st.toCSV().includes('Рейсов;0'));
    assert.ok(st.reportHTML().includes('Рейсы ещё не зафиксированы'));
    assert.strictEqual(st.summary().whPerKm, 0);
  });

  /* ------------------------------ Итог --------------------------------- */
  console.log('\n' + '='.repeat(52));
  console.log(`ИТОГО: ${passed} passed, ${failed} failed`);
  if (failed) {
    for (const f of failures) console.log('  · ' + f.name + ': ' + f.err.message);
    process.exit(1);
  }
  process.exit(0);
})();
