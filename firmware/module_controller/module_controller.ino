/**
 * @file module_controller.ino
 * @brief Прошивка контроллера поворотного модуля (Arduino Mega Pro Embed)
 *        Робот-курьер НТЦ АО «АВТОВАЗ» (Шасси с крабовым ходом 4WIS/4WID)
 * 
 * Назначение:
 *  - Прием команд по UART от бортового компьютера Ubuntu с проверкой CRC16
 *  - Телеметрия модуля в бортовой компьютер 20 Гц (угол, энкодер, АКБ, ток)
 *  - Управление шаговым двигателем NEMA 23 через драйвер TB6600 (редуктор 1:7.5)
 *  - 6-тактная коммутация собственного драйвера BLDC (3-фазный MOSFET-инвертор собственной разработки) тягового мотор-колеса
 *  - Обработка сигналов с датчиков Холла мотор-колеса и концевика нулевого азимута
 *  - Хоминг по команде с ПК (флаг FLAG_HOME)
 *  - Сторожевой таймер безопасности (Watchdog) при обрыве связи
 *
 * Протокол обмена полностью описан в docs/SERIAL_PROTOCOL.md
 */

#include <Arduino.h>

// ============================================================================
// КОНФИГУРАЦИЯ МОДУЛЯ
// ============================================================================
#define MODULE_ID           1        // ID модуля: 1=FL, 2=FR, 3=RL, 4=RR
#define BAUD_RATE           115200   // Скорость шины связи с Ubuntu
#define TIMEOUT_MS          300      // Таймаут сторожевого таймера (мс)

// Телеметрия МК -> ПК (кадр 16 байт, 20 Гц, см. docs/SERIAL_PROTOCOL.md)
#define TLM_PERIOD_MS       50
#define TLM_SYNC0           0xBB
#define TLM_SYNC1           0x44

// Флаги байта FLAGS кадра команды
#define FLAG_ENABLE         0x01
#define FLAG_HOME           0x02

// Флаги байта STATUS кадра телеметрии
#define STATUS_ENABLED      0x01
#define STATUS_HOMED        0x02

// Калибровочные коэффициенты аналоговых цепей
#define VBAT_DIVIDER_RATIO  10.0f    // Делитель 90к/10к: 38.4 В -> 3.84 В на АЦП
#define CURRENT_FULL_MA     25000    // 0..5 В с усилителя шунта 5 мОм <-> 0..25 А

// Пины управления шаговым двигателем (TB6600)
#define PIN_STEP_PUL        4
#define PIN_STEP_DIR        5
#define PIN_STEP_ENA        6

// Пины датчиков Холла мотор-колеса Xiaomi M365 Pro (прерывания)
#define PIN_HALL_A          2
#define PIN_HALL_B          3
#define PIN_HALL_C          18

// Пины квадратурного энкодера мотор-колеса Xiaomi M365 Pro
#define PIN_ENC_A           20       // INT3
#define PIN_ENC_B           21       // INT2

// Концевой датчик нулевого азимута
#define PIN_HOME_SW         19

// Пины управления собственным драйвером BLDC: 3-фазный мост MOSFET (FD6288/IR2101)
#define PIN_PWM_HA          8
#define PIN_PWM_LA          9
#define PIN_PWM_HB          10
#define PIN_PWM_LB          11
#define PIN_PWM_HC          12
#define PIN_PWM_LC          13

// Аналоговые входы
#define PIN_CURRENT_SENSE   A0
#define PIN_VBAT_SENSE      A1

// Кинематические константы поворотного привода
const float STEPS_PER_REV_MOTOR = 1600.0f; // 200 шагов * 1/8 микрошага
const float GEAR_RATIO          = 7.5f;    // Редукция ременной передачи GT2 10мм (шкивы 150/20)
const float TOTAL_STEPS_PER_360 = STEPS_PER_REV_MOTOR * GEAR_RATIO; // 12000 шагов
const float STEPS_PER_DEGREE    = TOTAL_STEPS_PER_360 / 360.0f;     // 33.333 шагов/град

// ============================================================================
// СОСТОЯНИЕ МОДУЛЯ
// ============================================================================
volatile long current_step_pos   = 0;
long target_step_pos             = 0;
int  target_traction_pwm         = 0;
bool motor_enabled               = false;
bool is_homed                    = false;
unsigned long last_packet_time   = 0;

// Телеметрия и хоминг
unsigned long last_tlm_time       = 0;
volatile long last_sent_enc_ticks = 0;
bool homing_pending               = false;

// Одометрия по квадратурному энкодеру Xiaomi M365 Pro
volatile long wheel_encoder_ticks = 0;

void encoder_isr() {
    if (digitalRead(PIN_ENC_A) == digitalRead(PIN_ENC_B)) {
        wheel_encoder_ticks++;
    } else {
        wheel_encoder_ticks--;
    }
}

// ============================================================================
// ТАБЛИЦА КОММУТАЦИИ 6-СТУПЕНЧАТОГО СОБСТВЕННОГО BLDC ИНВЕРТОРА
// ============================================================================
void bldc_set_phase_state(uint8_t ha, uint8_t la, uint8_t hb, uint8_t lb, uint8_t hc, uint8_t lc, uint8_t duty) {
    analogWrite(PIN_PWM_HA, ha ? duty : 0);
    digitalWrite(PIN_PWM_LA, la ? HIGH : LOW);
    analogWrite(PIN_PWM_HB, hb ? duty : 0);
    digitalWrite(PIN_PWM_LB, lb ? HIGH : LOW);
    analogWrite(PIN_PWM_HC, hc ? duty : 0);
    digitalWrite(PIN_PWM_LC, lc ? HIGH : LOW);
}

void bldc_commutation(uint8_t hall_state, int speed_pwm) {
    if (abs(speed_pwm) < 15 || !motor_enabled) {
        // Отключение всех фаз (плавный накат)
        bldc_set_phase_state(0, 0, 0, 0, 0, 0, 0);
        return;
    }

    uint8_t duty = (uint8_t)constrain(map(abs(speed_pwm), 0, 1000, 0, 255), 0, 255);
    bool reverse = (speed_pwm < 0);

    // 6 секторов коммутации по датчикам Холла [H_C, H_B, H_A]
    if (!reverse) {
        switch (hall_state) {
            case 0b001: bldc_set_phase_state(1, 0, 0, 1, 0, 0, duty); break; // A+ B-
            case 0b011: bldc_set_phase_state(1, 0, 0, 0, 0, 1, duty); break; // A+ C-
            case 0b010: bldc_set_phase_state(0, 0, 1, 0, 0, 1, duty); break; // B+ C-
            case 0b110: bldc_set_phase_state(0, 1, 1, 0, 0, 0, duty); break; // B+ A-
            case 0b100: bldc_set_phase_state(0, 1, 0, 0, 1, 0, duty); break; // C+ A-
            case 0b101: bldc_set_phase_state(0, 0, 0, 1, 1, 0, duty); break; // C+ B-
            default:    bldc_set_phase_state(0, 0, 0, 0, 0, 0, 0); break;
        }
    } else {
        // Реверс фазировки
        switch (hall_state) {
            case 0b001: bldc_set_phase_state(0, 1, 1, 0, 0, 0, duty); break;
            case 0b011: bldc_set_phase_state(0, 1, 0, 0, 1, 0, duty); break;
            case 0b010: bldc_set_phase_state(0, 0, 0, 1, 1, 0, duty); break;
            case 0b110: bldc_set_phase_state(1, 0, 0, 1, 0, 0, duty); break;
            case 0b100: bldc_set_phase_state(1, 0, 0, 0, 0, 1, duty); break;
            case 0b101: bldc_set_phase_state(0, 0, 1, 0, 0, 1, duty); break;
            default:    bldc_set_phase_state(0, 0, 0, 0, 0, 0, 0); break;
        }
    }
}

// Прерывание от изменения состояния датчиков Холла
void hall_change_isr() {
    uint8_t ha = digitalRead(PIN_HALL_A);
    uint8_t hb = digitalRead(PIN_HALL_B);
    uint8_t hc = digitalRead(PIN_HALL_C);
    uint8_t hall_state = (hc << 2) | (hb << 1) | ha;
    bldc_commutation(hall_state, target_traction_pwm);
}

// ============================================================================
// ВЫЧИСЛЕНИЕ КОНТРОЛЬНОЙ СУММЫ CRC16 (MODBUS)
// ============================================================================
uint16_t calc_crc16(const uint8_t *buffer, size_t length) {
    uint16_t crc = 0xFFFF;
    for (size_t i = 0; i < length; ++i) {
        crc ^= (uint16_t)buffer[i];
        for (uint8_t bit = 0; bit < 8; ++bit) {
            if (crc & 0x0001) {
                crc = (crc >> 1) ^ 0xA001;
            } else {
                crc >>= 1;
            }
        }
    }
    return crc;
}

// ============================================================================
// ПОВОРОТ ШАГОВОГО ДВИГАТЕЛЯ NEMA 23 (TB6600)
// ============================================================================
void update_stepper() {
    if (current_step_pos == target_step_pos || !motor_enabled) {
        return;
    }

    if (target_step_pos > current_step_pos) {
        digitalWrite(PIN_STEP_DIR, HIGH);
        current_step_pos++;
    } else {
        digitalWrite(PIN_STEP_DIR, LOW);
        current_step_pos--;
    }

    // Формирование импульса PUL (длительность 4 мкс)
    digitalWrite(PIN_STEP_PUL, HIGH);
    delayMicroseconds(4);
    digitalWrite(PIN_STEP_PUL, LOW);
    delayMicroseconds(4);
}

// Процедура поиска нулевого азимута (Homing)
void run_homing_sequence() {
    digitalWrite(PIN_STEP_ENA, LOW); // Включаем TB6600
    digitalWrite(PIN_STEP_DIR, LOW); // Вращение в сторону концевика

    unsigned long start = millis();
    while (digitalRead(PIN_HOME_SW) == HIGH && (millis() - start < 10000)) {
        digitalWrite(PIN_STEP_PUL, HIGH);
        delayMicroseconds(200);
        digitalWrite(PIN_STEP_PUL, LOW);
        delayMicroseconds(200);
    }

    // Нулевая точка зафиксирована
    current_step_pos = 0;
    target_step_pos = 0;
    is_homed = true;
}

// ============================================================================
// ТЕЛЕМЕТРИЯ МОДУЛЯ (МК -> ПК): кадр 16 байт с CRC16
// ============================================================================
void send_telemetry() {
    uint8_t status = 0;
    if (motor_enabled) status |= STATUS_ENABLED;
    if (is_homed)      status |= STATUS_HOMED;

    // Приращение тиков энкодера колеса с прошлого кадра
    long enc_delta = wheel_encoder_ticks - last_sent_enc_ticks;
    last_sent_enc_ticks = wheel_encoder_ticks;
    enc_delta = constrain(enc_delta, -32767, 32767);

    // Фактический угол модуля, сотые доли градуса
    int16_t steer_cdeg = (int16_t)constrain(
        (long)((float)current_step_pos / STEPS_PER_DEGREE * 100.0f),
        -32767, 32767);

    uint16_t vbat_cv    = (uint16_t)(analogRead(PIN_VBAT_SENSE) * 5.0f
                                     / 1023.0f * VBAT_DIVIDER_RATIO * 100.0f);
    uint16_t current_ma = (uint16_t)(analogRead(PIN_CURRENT_SENSE)
                                     * (float)CURRENT_FULL_MA / 1023.0f);

    uint8_t buffer[16];
    buffer[0]  = TLM_SYNC0;
    buffer[1]  = TLM_SYNC1;
    buffer[2]  = MODULE_ID;
    buffer[3]  = status;
    buffer[4]  = (steer_cdeg >> 8) & 0xFF;
    buffer[5]  = steer_cdeg & 0xFF;
    buffer[6]  = (enc_delta >> 8) & 0xFF;
    buffer[7]  = enc_delta & 0xFF;
    buffer[8]  = (target_traction_pwm >> 8) & 0xFF;
    buffer[9]  = target_traction_pwm & 0xFF;
    buffer[10] = (vbat_cv >> 8) & 0xFF;
    buffer[11] = vbat_cv & 0xFF;
    buffer[12] = (current_ma >> 8) & 0xFF;
    buffer[13] = current_ma & 0xFF;
    uint16_t crc = calc_crc16(buffer, 14);
    buffer[14] = (crc >> 8) & 0xFF;
    buffer[15] = crc & 0xFF;
    Serial.write(buffer, 16);
}

// ============================================================================
// ИНИЦИАЛИЗАЦИЯ
// ============================================================================
void setup() {
    Serial.begin(BAUD_RATE);

    // Конфигурация пинов шагового драйвера
    pinMode(PIN_STEP_PUL, OUTPUT);
    pinMode(PIN_STEP_DIR, OUTPUT);
    pinMode(PIN_STEP_ENA, OUTPUT);
    digitalWrite(PIN_STEP_ENA, HIGH); // По умолчанию отключен (High-Z)

    // Конфигурация пинов датчиков
    pinMode(PIN_HALL_A, INPUT_PULLUP);
    pinMode(PIN_HALL_B, INPUT_PULLUP);
    pinMode(PIN_HALL_C, INPUT_PULLUP);
    pinMode(PIN_HOME_SW, INPUT_PULLUP);

    // Квадратурный энкодер мотор-колеса Xiaomi M365 Pro
    pinMode(PIN_ENC_A, INPUT_PULLUP);
    pinMode(PIN_ENC_B, INPUT_PULLUP);
    attachInterrupt(digitalPinToInterrupt(PIN_ENC_A), encoder_isr, CHANGE);

    attachInterrupt(digitalPinToInterrupt(PIN_HALL_A), hall_change_isr, CHANGE);
    attachInterrupt(digitalPinToInterrupt(PIN_HALL_B), hall_change_isr, CHANGE);
    attachInterrupt(digitalPinToInterrupt(PIN_HALL_C), hall_change_isr, CHANGE);

    // Пины силового моста MOSFET
    pinMode(PIN_PWM_HA, OUTPUT);
    pinMode(PIN_PWM_LA, OUTPUT);
    pinMode(PIN_PWM_HB, OUTPUT);
    pinMode(PIN_PWM_LB, OUTPUT);
    pinMode(PIN_PWM_HC, OUTPUT);
    pinMode(PIN_PWM_LC, OUTPUT);
    bldc_set_phase_state(0, 0, 0, 0, 0, 0, 0);

    // Повышение частоты ШИМ Таймера 1 и Таймера 2 до ~31.25 кГц для бесшумной работы
    TCCR1B = (TCCR1B & 0b11111000) | 0x01;
    TCCR2B = (TCCR2B & 0b11111000) | 0x01;

    run_homing_sequence();
    last_packet_time = millis();
}

// ============================================================================
// ГЛАВНЫЙ ЦИКЛ УПРАВЛЕНИЯ
// ============================================================================
void loop() {
    // 1. Проверка приема пакета от бортового ПК Ubuntu
    if (Serial.available() >= 10) {
        if (Serial.peek() == 0xAA) {
            uint8_t buffer[10];
            Serial.readBytes(buffer, 10);

            if (buffer[0] == 0xAA && buffer[1] == 0x55 && buffer[2] == MODULE_ID) {
                uint16_t received_crc = (buffer[8] << 8) | buffer[9];
                uint16_t calculated_crc = calc_crc16(buffer, 8);

                if (received_crc == calculated_crc) {
                    int16_t steer_deg_c = (int16_t)((buffer[3] << 8) | buffer[4]); // в 0.01 градуса
                    int16_t traction_pwm = (int16_t)((buffer[5] << 8) | buffer[6]);
                    uint8_t flags = buffer[7];

                    // Пересчет угла поворота в шаги
                    float target_deg = (float)steer_deg_c / 100.0f;
                    target_step_pos = (long)(target_deg * STEPS_PER_DEGREE);
                    target_traction_pwm = traction_pwm;

                    motor_enabled = (flags & FLAG_ENABLE);
                    digitalWrite(PIN_STEP_ENA, motor_enabled ? LOW : HIGH);

                    if (flags & FLAG_HOME) {
                        homing_pending = true; // Отложенный хоминг до концевика
                    }

                    last_packet_time = millis();

                    // Немедленно обновляем коммутацию BLDC
                    hall_change_isr();
                }
            }
        } else {
            Serial.read(); // Сдвиг байта при рассинхронизации
        }
    }

    // 2. Отработка шагового двигателя NEMA 23
    update_stepper();

    // 3. Отложенный хоминг (поиск нулевого азимута по команде с ПК)
    if (homing_pending) {
        homing_pending = false;
        run_homing_sequence();
        last_packet_time = millis(); // Сброс сторожа: хоминг занимает до 10 с
        last_tlm_time = millis();
    }

    // 4. Телеметрия модуля в бортовой компьютер, 20 Гц
    if (millis() - last_tlm_time >= TLM_PERIOD_MS) {
        last_tlm_time = millis();
        send_telemetry();
    }

    // 5. Сторожевой таймер безопасности (Watchdog)
    if (millis() - last_packet_time > TIMEOUT_MS) {
        motor_enabled = false;
        target_traction_pwm = 0;
        digitalWrite(PIN_STEP_ENA, HIGH); // Снятие момента с шаговика
        bldc_set_phase_state(0, 0, 0, 0, 0, 0, 0); // Обесточивание мотор-колеса
    }
}
