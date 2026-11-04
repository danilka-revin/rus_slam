// Включается внутри namespace платы перед скетчем (см. sim.cpp): привязывает
// digitalWrite/Serial к своей Board. SIM_BOARD — имя объекта Board.
// Без include guard намеренно: по одному разу в каждом namespace.
static sim::Board& sim_board = SIM_BOARD;
inline void pinMode(uint8_t pin, uint8_t mode) { sim_board.pin_mode(pin, mode); }
inline void digitalWrite(uint8_t pin, uint8_t level) { sim_board.digital_write(pin, level); }
inline int digitalRead(uint8_t pin) { return sim_board.digital_read(pin); }
inline int analogRead(uint8_t pin) { return sim_board.analog_read(pin); }
inline void analogReference(uint8_t) {}
inline void analogWrite(uint8_t pin, int value) { sim_board.analog[pin] = value; }
// Номера Arduino attachInterrupt отличаются от аппаратных INT на Mega:
// D2→0 (INT4), D3→1 (INT5), D21→2 (INT0), D20→3 (INT1),
// D19→4 (INT2), D18→5 (INT3). Совпадает с variants/mega/pins_arduino.h.
inline uint8_t digitalPinToInterrupt(uint8_t pin) {
  switch (pin) {
    case 2: return 0;
    case 3: return 1;
    case 21: return 2;
    case 20: return 3;
    case 19: return 4;
    case 18: return 5;
    default: return 0xFF;
  }
}
inline void attachInterrupt(uint8_t irq, void (*fn)(), int mode) {
  sim_board.tach_fn = fn;
  sim_board.tach_irq = irq;
  sim_board.tach_mode = mode;
}
inline void detachInterrupt(uint8_t) { sim_board.tach_fn = nullptr; }
static sim::SimSerial& Serial = sim_board.serial;

// EEPROM платы (avr/eeprom.h): адрес — просто номер ячейки, как на AVR.
inline uint8_t eeprom_read_byte(const uint8_t* address) {
  return sim_board.eeprom_read((uint16_t)(uintptr_t)address);
}
inline void eeprom_write_byte(uint8_t* address, uint8_t value) {
  sim_board.eeprom_write((uint16_t)(uintptr_t)address, value);
}
inline void eeprom_update_byte(uint8_t* address, uint8_t value) {
  const uint16_t slot = (uint16_t)(uintptr_t)address;
  if (sim_board.eeprom_read(slot) != value) sim_board.eeprom_write(slot, value);
}
