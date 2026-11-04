// Хост-симуляция Arduino Mega для прошивки firmware/motor_wheel (колесо руля).
//
// Каждая плата — свой экземпляр Board: выводы, USB Serial, модель шагового
// привода (TB6600 шагает по фронту PUL, если ENA = HIGH, направление — по DIR)
// и оптодатчика нуля на D18 (флажок с гистерезисом). Связь с сервером — только
// USB Serial: I²C в прошивке вырезан, здесь его заглушек больше нет.
// Скетч компилируется внутри своего namespace (см. sim.cpp), а функции
// digitalWrite/Serial там подменяются привязанными к своей плате.
// Время общее: тик шагового таймера — 50 мкс, прерывания всех плат идут по тику,
// loop() каждой платы — между тиками.
#pragma once

#include <cctype>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <string>
#include <strings.h>
#include <vector>
#include <ctype.h>
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define RISING 3
#define CHANGE 4
#define DEFAULT 1
// На Mega 2560 аналоговые входы — это цифровые выводы 54…69.
#define A0 54
#define A1 55
#define A2 56
#define A3 57
#define A4 58
#define A5 59
#define A6 60
#define A7 61
#define A8 62
#define A9 63
#define A10 64
#define A11 65
#define A12 66
#define A13 67
#define A14 68
#define A15 69
#define PROGMEM
#define PSTR(s) (s)
#define F(s) (s)
#define snprintf_P snprintf
#define vsnprintf_P vsnprintf
#define strncpy_P strncpy
#define strcpy_P strcpy
#define strcmp_P strcmp
#define strcasecmp_P strcasecmp
#define memcpy_P memcpy
#define ISR(vector) void vector##_handler()

typedef uint8_t byte;
typedef bool boolean;

// Регистры Timer2 (шаги руля): прошивка их только настраивает, ход задаёт
// симуляция.
inline uint8_t TCCR2A = 0, TCCR2B = 0, TIMSK2 = 0, OCR2A = 0, TCNT2 = 0;
constexpr int WGM21 = 1, CS21 = 1, OCIE2A = 1;
inline uint8_t SREG = 0;
inline void cli() {}
inline void sei() {}

namespace sim {

inline int64_t now_us = 0;
inline int64_t next_tick_us = 50;
void advance(int64_t us);

struct Board;

class SimSerial {
 public:
  std::deque<uint8_t> input;
  std::string output;
  int writable = 63;
  void begin(unsigned long) {}
  int available() { return (int)input.size(); }
  int read() {
    if (input.empty()) return -1;
    const int ch = input.front();
    input.pop_front();
    return ch;
  }
  int availableForWrite() { return writable; }
  size_t write(uint8_t ch) {
    output.push_back((char)ch);
    return 1;
  }
  void send(const std::string& line) {
    for (char ch : line) input.push_back((uint8_t)ch);
    input.push_back('\n');
  }
};

struct Board {
  const char* name = "";
  uint8_t level[80] = {0};
  uint8_t mode[80] = {0};
  int analog[80] = {0};
  SimSerial serial;
  // EEPROM платы (ATmega2560 — 4 КиБ, здесь хватает 1 КиБ): ноль, наклон
  // потенциометра и т.п.
  uint8_t eeprom[1024] = {0};
  // Negative = normal EEPROM; zero simulates power loss / a failed write.
  int eeprom_writes_left = -1;
  uint8_t eeprom_read(uint16_t address) { return eeprom[address & 1023]; }
  void eeprom_write(uint16_t address, uint8_t value) {
    if (eeprom_writes_left == 0) return;
    if (eeprom_writes_left > 0) --eeprom_writes_left;
    eeprom[address & 1023] = value;
  }
  void (*setup_fn)() = nullptr;
  void (*loop_fn)() = nullptr;
  void (*isr_fn)() = nullptr;
  void (*tach_fn)() = nullptr;
  uint8_t tach_irq = 0xFF;
  int tach_mode = 0;
  // Опциональные искусственные переходы SC для PTY-тестов, не модель мотора.
  int64_t tach_period_us = 0;
  int64_t tach_next_edge_us = 0;

  void tach_change() {
    const uint8_t previous = level[19];
    level[19] = previous == HIGH ? LOW : HIGH;
    if (tach_fn && tach_irq == 4 && (tach_mode == CHANGE ||
        (tach_mode == RISING && previous == LOW))) tach_fn();
  }

  // Вход «P» драйвера — сигнал сервопривода 50 Гц из штатной библиотеки Servo.
  // Прошивка делает attach(D3) и write(0…180); заглушка Servo пишет сюда же.
  bool servo_attached = false;
  uint8_t servo_pin = 0;
  int servo_value = 0;
  int servo_min_us = 544;
  int servo_max_us = 2400;
  // Положение ручки в промилле шкалы: 0 — мотор не тянет, 1000 — полный ход.
  int duty_permille() const {
    if (servo_value <= 0) return 0;
    return (int)((uint32_t)servo_value * 1000UL / 180UL);
  }
  // Импульс на «P» в микросекундах: у Servo значение 0…180 — это 544…2400 мкс.
  int servo_pulse_us() const {
    return servo_min_us + servo_value * (servo_max_us - servo_min_us) / 180;
  }
  // Библиотека подключена к выводу и выдаёт импульсы.
  bool servo_running() const { return servo_attached; }

  // Модель руля: phys — где колесо на самом деле, в шагах от «прямо».
  long phys = 0;
  long phys_min = 0, phys_max = 0;
  // Заклинивание колеса: phys замирает на stall_phys, хотя драйвер продолжает
  // получать импульсы. Прошивка считает СГЕНЕРИРОВАННЫЕ импульсы, а не
  // положение колеса, поэтому открытый контур по шагам считает, что доехали.
  bool stall_enabled = false;
  long stall_phys = 0;
  long steps_lost = 0;
  // Модель потенциометра на A0: движок жёстко связан с колесом (1:1),
  // показывает угол (phys + pot_bias_steps) / phys_per_degree.
  bool pot_present = true;
  double pot_center_raw = 512.0;
  double pot_counts_per_degree = 1023.0 / 270.0;
  double pot_bias_steps = 0.0;
  double phys_per_degree = 133.333333333333;
  bool opto_present = true;
  bool opto_stuck = false;
  long flag_lo = -200, flag_hi = 200;    // шаги, где датчик закрыт
  long hysteresis = 20;
  bool opto_state = false;
  // Разброс срабатывания: при каждом освобождении датчика следующий сдвиг края флажка
  // берётся из списка (по кругу). Сдвиг вступает, только когда колесо вне старого и
  // нового окна: как люфт между подходами, а не перескок флажка под колесом.
  std::vector<long> flag_shift_script;
  size_t flag_shift_index = 0;
  long flag_shift = 0;
  bool flag_shift_pending = false;
  long flag_shift_next = 0;
  // Проверки сигналов TB6600.
  int64_t last_dir_change_us = -1000000;
  int64_t pul_rise_us = 0;
  int64_t last_rise_us = -1;
  int64_t min_high_us = 1000000;
  int64_t min_period_us = 1000000;
  long dir_setup_violations = 0;
  long brake_releases = 0;  // high -> low, including transient releases
  long steps = 0;
  long steps_while_disabled = 0;

  void reset_stats() {
    phys_min = phys_max = phys;
    min_high_us = min_period_us = 1000000;
    last_rise_us = -1;
    steps = 0;
    max_loop_us = 0;
  }

  // Самый долгий проход loop(): если loop() стоит, плата не шлёт USB
  // (телеметрия, heartbeat тяги) и не обновляет watchdog тяги (650 мс).
  int64_t max_loop_us = 0;

  bool opto_active() {
    if (opto_stuck) return true;
    if (!opto_present) return false;
    const long lo = flag_lo + flag_shift;
    const long hi = flag_hi + flag_shift;
    const bool inside = phys >= lo && phys <= hi;
    const bool held = phys >= lo - hysteresis && phys <= hi + hysteresis;
    const bool was = opto_state;
    opto_state = was ? held : inside;
    if (was && !opto_state && !flag_shift_script.empty()) {
      flag_shift_next = flag_shift_script[flag_shift_index % flag_shift_script.size()];
      ++flag_shift_index;
      flag_shift_pending = true;
    }
    if (flag_shift_pending) {
      const long next_lo = flag_lo + flag_shift_next;
      const long next_hi = flag_hi + flag_shift_next;
      const long union_lo = (lo < next_lo ? lo : next_lo) - hysteresis;
      const long union_hi = (hi > next_hi ? hi : next_hi) + hysteresis;
      if (phys < union_lo || phys > union_hi) {
        flag_shift = flag_shift_next;
        flag_shift_pending = false;
      }
    }
    return opto_state;
  }

  void pin_mode(uint8_t pin, uint8_t value) {
    mode[pin] = value;
    if (value == INPUT_PULLUP) level[pin] = HIGH;
  }

  void digital_write(uint8_t pin, uint8_t value) {
    value = value ? HIGH : LOW;
    const uint8_t before = level[pin];
    level[pin] = value;
    if (pin == 5 && before == HIGH && value == LOW) ++brake_releases;
    if (pin == 7 && before != value) last_dir_change_us = now_us;
    if (pin != 6 || before == value) return;
    if (value == HIGH) {
      // TB6600 делает шаг по фронту PUL.
      if (now_us - last_dir_change_us < 5) ++dir_setup_violations;
      if (last_rise_us >= 0 && now_us - last_rise_us < min_period_us) min_period_us = now_us - last_rise_us;
      last_rise_us = now_us;
      pul_rise_us = now_us;
      if (level[8] != HIGH) {
        ++steps_while_disabled;
        return;
      }
      const long delta = level[7] == LOW ? 1 : -1;
      if (stall_enabled && ((delta > 0 && phys >= stall_phys) ||
                            (delta < 0 && phys <= stall_phys))) {
        ++steps_lost;
      } else {
        phys += delta;
      }
      ++steps;
      if (phys < phys_min) phys_min = phys;
      if (phys > phys_max) phys_max = phys;
    } else if (now_us - pul_rise_us < min_high_us) {
      min_high_us = now_us - pul_rise_us;
    }
  }

  int digital_read(uint8_t pin) {
    if (pin == 18) return opto_active() ? LOW : HIGH;
    return level[pin];
  }

  int analog_read(uint8_t pin) {
    if (pin == A0) {
      if (!pot_present) return 1023;   // обрыв движка — вход прижат к 5 В
      const double angle = ((double)phys + pot_bias_steps) / phys_per_degree;
      double raw = pot_center_raw + pot_counts_per_degree * angle;
      if (raw < 0.0) raw = 0.0;
      if (raw > 1023.0) raw = 1023.0;
      return (int)(raw + 0.5);
    }
    return analog[pin];
  }
};

inline std::vector<Board*> boards;

inline void tick_all() {
  for (Board* board : boards) {
    if (board->isr_fn) board->isr_fn();
    if (board->tach_period_us > 0 && now_us >= board->tach_next_edge_us) {
      board->tach_change();
      board->tach_next_edge_us += board->tach_period_us;
    }
  }
}

inline void advance(int64_t us) {
  const int64_t target = now_us + us;
  while (next_tick_us <= target) {
    now_us = next_tick_us;
    next_tick_us += 50;
    tick_all();
  }
  now_us = target;
}

// loop() каждой платы зовётся раз за тик, но в разной фазе: на чётных тиках
// сразу после прерывания, на нечётных — за 1 мкс до следующего. Так ловятся
// гонки вроде «DIR сменили, а фронт PUL пришёл раньше чем через 5 мкс».
inline int64_t loop_round = 0;

inline void run_for_ms(double ms) {
  const int64_t end = now_us + (int64_t)(ms * 1000.0);
  while (now_us < end) {
    now_us = next_tick_us;
    next_tick_us += 50;
    tick_all();
    if (++loop_round & 1) now_us = next_tick_us - 1;
    for (Board* board : boards) {
      if (!board->loop_fn) continue;
      const int64_t started = now_us;
      board->loop_fn();
      const int64_t spent = now_us - started;
      if (spent > board->max_loop_us) board->max_loop_us = spent;
    }
  }
}

}  // namespace sim

// Arduino unsigned long is 32-bit even when this host compiler uses 64-bit long.
inline unsigned long millis() { return (uint32_t)(sim::now_us / 1000); }
inline unsigned long micros() { return (uint32_t)sim::now_us; }
inline void delayMicroseconds(unsigned int us) { sim::advance(us); }
inline void delay(unsigned long ms) { sim::advance((int64_t)ms * 1000); }
inline void noInterrupts() {}
inline void interrupts() {}
