// Заглушка штатной библиотеки Servo (её ставит Arduino IDE вместе с ядром).
//
// Прошивка тяги управляет входом «P» драйвера как сервоприводом постоянного
// вращения, поэтому заглушке достаточно запомнить три вещи про свою плату:
// на каком выводе attach, выдан ли сигнал и какое последнее значение write.
// Include guard намеренно нет: скетч включается по разу в namespace каждой
// платы (wheel_fl … wheel_rr), и у каждой должен быть свой класс Servo со
// своими переменными.
#include <stdint.h>
#include "Arduino.h"

class Servo {
 public:
  uint8_t attach(int pin) { return attach(pin, 544, 2400); }
  uint8_t attach(int pin, int min_pulse, int max_pulse) {
    sim_board.pin_mode((uint8_t)pin, OUTPUT);
    sim_board.servo_attached = true;
    sim_board.servo_pin = (uint8_t)pin;
    sim_board.servo_min_us = min_pulse;
    sim_board.servo_max_us = max_pulse;
    sim_board.servo_value = 0;
    return 1;
  }
  void detach() { sim_board.servo_attached = false; }
  void write(int value) {
    if (value < 0) value = 0;
    if (value > 180) value = 180;
    sim_board.servo_value = value;
  }
  int read() const { return sim_board.servo_value; }
  bool attached() const { return sim_board.servo_attached; }
};
