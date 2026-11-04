// motor_wheel — прошивка ОДНОГО колеса руля (Arduino Mega 2560 / Mega Mini).
// Каждая плата подключена отдельным USB-кабелем (115200 бод).
// MODULE_ID задаёт положение колеса, фильтр адресных команд и зеркалирование DIR.
// С fw22 каждая проверенная CRC телеметрия содержит это имя: сервер определяет
// USB-порт автоматически, не угадывая роль по номеру порта или USB-разъёму.
// Физически правильное расположение плат всё равно проверяет человек.
//
// Команды с USB: k, q, c, d, h, s, g, z, p, w, v, t, b. Старый n только тормозит.
//   w 12.5 | w FL 12.5 — поворот колеса; w zero / w calib — ноль и калибровка;
//   v N [f/b] — прямое значение Servo.write для тяги (0…150) и направление;
//   t N — прежняя команда тяги BLDC ±N% для других пультов;
//   обе команды повторяются чаще 650 мс, иначе плата сама тормозит.
//   b — тормоз; p — состояние; ? — справка.
//
// Выход на регулятор скорости — «PWM» драйвера RioRand ZS-Z11H (hoverboard,
// разбор входов: mad-ee.com/easy-inexpensive-hoverboard-motor-controller).
// Вход «P» рассчитан на ШИМ по скважности. По требованию оператора используется
// штатная Servo: экран передаёт целое 0…150 напрямую в Servo.write() на D3.
// При стандартных настройках Servo импульс 544…2400 мкс повторяется каждые
// ~20 мс: это лишь 2,7…12 % скважности, не весь диапазон входа P. Значение 0
// выключает тягу линиями BRAKE/STOP, а не нулевым импульсом. Прежняя t
// оставлена старым пультам и манёврам.
//   * P (D3) — сигнал Servo, около 50 Гц; при команде 0 драйвер выключен;
//   * DIR — уровень: для этого колеса «вперёд» (у FR и RR он перевёрнут —
//     колёса стоят зеркально), инверсия — назад;
//   * BRAKE — 1 = тормоз включён, 0 = отпущен;
//   * STOP — 1 = драйвер разрешён, 0 = выходы выключены (свободный выбег).
// Всё это — константы прошивки, а не настройки: подбирать на экране нечего.
// Если конкретное колесо крутится не в ту сторону — поменяйте местами два
// фазных провода мотора или константы уровней ниже.
//
// SC на D19 считает обороты и переходы для серверной одометрии манёвров.
// Сама плата не регулирует тягу по SC; сервер отдельно следит за счётчиками.
// Для проверки нужен независимый физический E-STOP.
//
// На каждой плате: свой TB6600 (шаговый руль), оптодатчик нуля на D18,
// потенциометр положения колеса на A0 и интерфейс BLDC-тяги:
// DIR (D4), BRAKE (D5), STOP (D2), SPEED/ШИМ (D3), SC (D19) и общая земля.
// Сигнал на D3 формирует штатная библиотека Servo.
#include <Servo.h>
#include <avr/eeprom.h>
#include <avr/interrupt.h>
#include <avr/pgmspace.h>
#include <ctype.h>
#include <math.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Имя колеса задаёт положение и зеркалирование DIR. Его обязательно прошить
// правильно для каждой платы; sync_firmware_desktop.sh подставляет FL/FR/RL/RR.
#ifndef MODULE_ID
#define MODULE_ID "FL"
#endif
// Буфер ответов в USB: «p» печатает состояние, сведения о приводе и имя
// колеса; 640 байт оставляют запас, чтобы последняя строка не терялась.
#define TX_BUFFER_SIZE 640

// =========================== STEERING CORE BEGIN ===========================
// Этот блок — руль и датчики, он не зависит от способа связи с сервером.
//
// Руль повторяет скетч, проверенный на железе (firmware/reference/steering_tested):
// те же пины и уровни, 133.33 шага/°, 100 мкс на шаг в работе и 2000 мкс при
// точном подходе к оптодатчику D18, те же команды монитора (k c d h s g p z).
// Отличия от него:
//   * шаги выдаёт таймер (тик 50 мкс), а не loop(): чтение USB и печать
//     не сбивают ход мотора;
//   * датчик проверяется в том же прерывании — кромка ловится с точностью до
//     шага, без запаздывания loop();
//   * калибровка доведена: выход из флажка перед медленным подходом, поиск
//     влево действительно включается, ноль ставится без зависаний, есть
//     таймаут и отмена командой s.

// ---- распиновка (одинакова на всех четырёх платах) ----
// STOP — отдельный выход на драйвер; SC — вход внешнего прерывания INT2.
const uint8_t TACH_PIN = 19;         // BLDC SC — оба перехода для RPM и одометрии
const uint8_t BLDC_STOP_PIN = 2;     // BLDC STOP — вход «разрешить» драйвера
const uint8_t BLDC_SPEED_PIN = 3;    // сигнал Servo на вход «P» драйвера
const uint8_t BLDC_DIR_PIN = 4;      // BLDC DIR
const uint8_t BLDC_BRAKE_PIN = 5;    // BLDC BRAKE
const uint8_t STEP_PUL_PIN = 6;      // TB6600 PUL
const uint8_t STEP_DIR_PIN = 7;      // TB6600 DIR
const uint8_t STEP_ENA_PIN = 8;      // TB6600 ENA
const uint8_t OPTO_PIN = 18;         // оптодатчик нуля руля (INPUT_PULLUP)
const uint8_t POT_PIN = A0;          // потенциометр положения колеса (ADC0; на Mega это вывод 54)

// ---- уровни сигналов (как в проверенном скетче) ----
const uint8_t STEP_DIR_PLUS_LEVEL = LOW;       // LOW — «вправо» (f), шаги растут
const uint8_t STEP_DIR_MINUS_LEVEL = HIGH;     // HIGH — «влево» (b), шаги убывают
const uint8_t STEP_ENABLE_LEVEL = HIGH;        // ENA = HIGH сразу при включении и всегда
const bool OPTO_ACTIVE_LOW = true;             // датчик сработал → на D18 LOW
// Уровни — по документации драйвера (RioRand ZS-Z11H, см. шапку файла):
// BRAKE активен высоким, DIR меняет сторону низким, STOP разрешает высоким.
// Пока тяги нет (старт платы, «b», watchdog), драйвер выключен, тормоз взведён.
const uint8_t BLDC_BRAKE_ACTIVE_LEVEL = HIGH;  // BRAKE = 1 → мотор заторможен
const uint8_t BLDC_DIR_FORWARD_LEVEL = HIGH;   // DIR = 1 (в покое) — штатное вращение
const uint8_t BLDC_STOP_ENABLE_LEVEL = HIGH;   // STOP = 1 → драйвер разрешён
const uint8_t BLDC_STOP_DISABLE_LEVEL = LOW;   // STOP = 0 → выходы выключены (выбег)

// ---- механика и скорость руля ----
const float STEPS_PER_DEGREE = 133.333333f;    // шагов_на_оборот × микрошаг × редуктор / 360
const uint16_t STEP_PERIOD_US = 100;           // рабочий ход: 10 кГц ≈ 75°/с
const uint16_t CALIB_STEP_PERIOD_US = 2000;    // точный подход к датчику: 500 Гц ≈ 3,75°/с
// Предел абсолютной команды «w <угол>». ОДНО число на весь стек: столько же
// в slam_gui/backend.py (STEER_LIMIT_DEG / MasterSource.MAX_STEER_DEG),
// в robot_control/slam.py и в экранах (slam_gui/steer_presets.js). 90° дают
// чистый боковой ход, а 100° — запас для диагоналей на неровном полу; до упора
// потенциометра (±130°) и до программного предела хода
// STEER_TRAVEL_LIMIT_DEG (±125°) запас остаётся.
const float STEER_LIMIT_DEG = 100.0f;
const float MANUAL_MOVE_LIMIT_DEG = 360.0f;    // предел одной ручной команды d / c
const float STEER_TRAVEL_LIMIT_DEG = 125.0f;   // предел хода от нуля: упор потенциометра ±130°

// ---- калибровка по оптодатчику (команда k) ----
const float CALIB_HALF_RANGE_DEG = 125.0f;     // поиск вправо 125°, затем влево 250°: 5° запаса до упора потенциометра ±130°
const float CALIB_SLOW_SEARCH_DEGREES = 20.0f; // медленный подход к кромке — не дальше
const uint8_t CALIB_SLOW_PASSES = 3;           // подходов к КАЖДОЙ кромке; ноль — среднее по всем подходам
const float CALIB_MAX_EDGE_SPREAD_DEG = 2.0f;  // разброс кромок между подходами больше — ошибка 6, ноль не ставим
const float CALIB_CLEARANCE_DEGREES = 2.0f;    // отъезд за кромку перед медленным подходом
const float CALIB_MAX_FLAG_DEGREES = 30.0f;    // шире — датчик «залип» или ошибка проводки
// true: ноль = середина между кромками, найденными медленным подходом справа и
// слева (так задумано в проверенном скетче: «Точка 0 = (right + left) / 2»).
// false: ноль = кромка при подходе вправо — так скетч работал фактически,
// потому что медленные фазы сразу срабатывали на той же кромке.
const bool CALIB_ZERO_AT_CENTER = true;
const float CALIB_ZERO_OFFSET_DEG = 0.0f;      // заводская поправка к центру флажка
const float FULL_ZERO_MAX_OFFSET_DEG = 20.0f;   // до ±100° остаётся запас в ходе ±125°
const uint32_t CALIB_TIMEOUT_MS = 120000UL;    // страховка: дольше — ошибка (3 подхода на кромку)
const uint8_t OPTO_DEBOUNCE_TICKS = 3;         // 3 тика по 50 мкс подряд = срабатывание

// ---- потенциометр положения колеса (команда q) ----
// Линейный 10 кОм, 270°: крайние выводы — 5 В и GND платы, движок — A0.
// Питание от 5 В той же платы: измерение ратиометрическое, просадка 5 В не
// меняет угол. A0 свободен на всех четырёх платах (заняты только D2–D8 и D18).
const int16_t POT_ADC_MAX = 1023;
const int16_t POT_RAIL_MARGIN = 4;               // 0…4 и 1019…1023 — обрыв, КЗ или упор
const float POT_NOMINAL_COUNTS_PER_DEG = 1023.0f / 270.0f;  // 270° на весь ход
const uint16_t POT_SAMPLE_PERIOD_MS = 10;        // один отсчёт АЦП раз в 10 мс
const uint8_t POT_FILTER_SHIFT = 2;              // EMA 1/4: шум АЦП падает вчетверо
const float POT_CORRECTION_DEADBAND_DEG = 0.7f;  // меньше — мотор не дёргаем
const uint8_t POT_CORRECTION_MAX_PASSES = 3;     // поправок на один поворот
const uint16_t POT_CORRECTION_SETTLE_MS = 60;    // механика успокаивается после стопа
const float POT_RESYNC_DEG = 0.25f;              // счётчик шагов привязать к датчику
// Насколько датчику вообще позволено спорить с целью. Доводка убирает
// люфт и увод на единицы градусов; расхождение в десятки градусов означает,
// что врёт датчик (сбился ноль, изношена дорожка, не сделана q), а не колесо.
const float POT_TRUST_DEG = 5.0f;
const float POT_CAL_POINT_DEG = 60.0f;           // автокалибровка наклона: −60° и +60°
const float POT_CAL_MIN_COUNTS_PER_DEG = 1.5f;   // проверка правдоподобия наклона
const float POT_CAL_MAX_COUNTS_PER_DEG = 8.0f;
const uint32_t POT_CAL_TIMEOUT_MS = 30000UL;

// ---- активное удержание угла (команда ph, fw24) ----
// Доводка выше выравнивает колесо ОДИН раз после поворота. Удержание — то же
// сравнение с потенциометром, но продолжается всё время, пока оно включено:
// отвели колесо рукой — оно само возвращается к заданному углу. Порог шире
// доводки и с подтверждением, чтобы шум АЦП не раскачивал мотор; шаг медленный
// (18 °/с): оператор видит, что колесо едет, и успевает убрать руку.
const float POT_HOLD_DEADBAND_DEG = 2.0f;        // мёртвая зона удержания
const uint16_t POT_HOLD_CONFIRM_MS = 400;        // смещение должно продержаться
const uint16_t POT_HOLD_STEP_PERIOD_US = 400;    // ≈ 18 °/с (2500 шагов/с)
const float POT_HOLD_MAX_DEG = 15.0f;            // больше — колесо двинули руками
const uint8_t POT_HOLD_MAX_PASSES = 6;           // подходов подряд, дальше пауза
const uint16_t POT_HOLD_PAUSE_MS = 3000;         // пауза после серии подходов
// Счётчик шагов привязывается к датчику только в пределах доверия, как в
// updateFeedback. Удержание разрешает себе ещё мёртвую зону: ручной сдвиг на
// 2…15° оно само возвращает, и расхождение шагов с датчиком равно этому сдвигу,
// а не вранью датчика. Больше — уже расхождение, и удержание выключается.
const float POT_HOLD_REATTACH_DEG = POT_TRUST_DEG + POT_HOLD_DEADBAND_DEG;

// Наклон потенциометра — свойство железа, а не сессии: между включениями он не
// меняется. Без сохранения доводка после каждой перезагрузки молча выключалась
// (pot_calibrated = false), колесо снова ехало вслепую, и пропущенные шаги
// никто не замечал. Слоты 0…1 свободны.
const uint16_t EEPROM_POT_MAGIC_SLOT = 2;
const uint16_t EEPROM_POT_SLOPE_SLOT = 3;   // 4 байта, float, little-endian
const uint8_t EEPROM_POT_MAGIC = 0x51;      // «q» — наклон измерен

// Два независимых CRC-слота: последовательность, роль и поправка в шагах.
// 2…6 заняты потенциометром; 16…28 и 32…44 принадлежат полному нулю.
// Маркер записывается ПОСЛЕДНИМ: обрыв питания оставляет предыдущий слот.
const uint16_t EEPROM_ZERO_SLOTS[2] = {16, 32};
const uint8_t EEPROM_ZERO_MARKER = 0xA7;
const uint8_t EEPROM_ZERO_VERSION = 1;
const uint8_t EEPROM_ZERO_RECORD_SIZE = 13;
int32_t full_zero_steps = 0;
uint32_t full_zero_generation = 0;
int8_t full_zero_slot = -1;
bool full_zero_storage_fault = false;
uint32_t zero_reply_id = 0;
uint8_t zero_reply_status = 0;
int32_t zero_reply_proposed = 0;
uint32_t zero_reply_started = 0;
uint32_t zero_reply_last = 0;
uint8_t zero_reply_operation = 0;
// Короткое отдельное сообщение в существующем CRC-протоколе.
uint8_t wheelIdentityCode();
uint16_t telemetryCrc16(const char* data, uint16_t size);
// Удержание угла (ph) выключают калибровки и ноль — их код идёт раньше.
void stopPotHold();

// ---- тяга BLDC: драйвер RioRand ZS-Z11H (hoverboard-мотор) ----
// Штатная библиотека Servo выдаёт на вход P сигнал около 50 Гц. Значение
// write() — число из шкалы Servo, а не измеренные обороты и не скважность P.
// При команде 0 драйвер выключается по BRAKE/STOP; контура оборотов нет.
const uint8_t DRIVE_SERVO_MAX_VALUE = 180;      // шкала прежней команды t
const uint8_t DRIVE_DIRECT_MAX_VALUE = 150;     // прямое значение с бортового экрана
// 1 % = 1,8 значения шкалы (180 / 100). В целых десятых, чтобы не тащить float
// в горячую часть: 18 десятых на процент.
const uint16_t DRIVE_SERVO_TENTHS_PER_PERCENT = 18;
// Предел прежней команды t — 100 % шкалы Servo, а не скважность и не обороты:
// 100 % = значение write(180), 1 % ≈ write(1,8). Константа прошивки.
const uint8_t DRIVE_MAX_PERCENT = 100;
const uint16_t DRIVE_COMMAND_TIMEOUT_MS = 650; // нет heartbeat → значение 0 и тормоз

// Число изменений SC на оборот конкретного колеса. Для типичного hoverboard
// с 15 парами полюсов — 90; проверить по одному обороту на реальном моторе.
const uint16_t TACH_EDGES_PER_REV = 90;
static_assert(TACH_EDGES_PER_REV >= 1 && TACH_EDGES_PER_REV <= 1000, "SC edges per revolution must be 1..1000");
const uint16_t TACH_SAMPLE_PERIOD_MS = 500;
const uint16_t TACH_MIN_EDGE_US = 150;     // отсев очень коротких помех на SC
const uint32_t TACH_MAX_SILENCE_US = 1500000UL; // после паузы показываем 0
const uint32_t TACH_MIN_SILENCE_US = 300000UL;
// Зеркальные колёса. Корпус симметричный, поэтому правое колесо при том же
// уровне DIR крутится в другую сторону относительно робота. По умолчанию
// прошивка сама понимает это по имени колеса: FR и RR — зеркальные.
// Значение можно зафиксировать вручную: 1 — зеркалить всегда, 0 — никогда.
#ifndef DRIVE_MIRRORED
#define DRIVE_MIRRORED -1
#endif

// v20: отдельное защищённое руление на ходу для клавиатурного режима.
// v21: короткая полная телеметрия с CRC и совместимый подробный кадр.
// Старое поле tach остаётся выключенным для совместимости со старым сервером.
// v24: команда ph — активное удержание угла по потенциометру, бит 0x8000 и ph=
const uint8_t FIRMWARE_PROTOCOL = 25;          // нейтраль удалена, n только тормозит

// ---- состояние руля (общие с прерыванием поля — volatile) ----
volatile int32_t current_step = 0;
volatile int32_t target_step = 0;
volatile bool is_moving = false;
volatile bool pulse_high = false;
volatile int8_t step_dir = 1;
volatile uint8_t half_period_ticks = 1;
volatile uint8_t tick_count = 0;

// Прерывание считает принятые переходы и интервалы. Счётчик монотонный по
// модулю 2^32, сбрасывается только при перезагрузке; знак SC не измеряет.
// Прошивка по нему не регулирует и не включает тягу.
volatile uint32_t tach_edges_total = 0;
volatile uint32_t tach_last_edge_us = 0;
volatile uint32_t tach_last_period_us = 0;
volatile uint32_t tach_interval_sum_us = 0;
volatile uint16_t tach_interval_count = 0;
volatile bool tach_has_edge = false;
uint32_t tach_last_sample_ms = 0;
uint32_t tach_display_rpm_x10 = 0;
uint16_t tach_display_hz = 0;

const uint8_t OPTO_WATCH_NONE = 0;
const uint8_t OPTO_WATCH_ACTIVE = 1;   // остановиться, когда датчик сработает
const uint8_t OPTO_WATCH_CLEAR = 2;    // остановиться, когда датчик освободится
volatile uint8_t opto_watch = OPTO_WATCH_NONE;
volatile uint8_t opto_match = 0;
volatile bool opto_event = false;
volatile int32_t opto_event_step = 0;

const uint8_t HOME_NONE = 0;
const uint8_t HOME_MANUAL = 1;
const uint8_t HOME_OPTO = 2;

const uint8_t CAL_IDLE = 0;
const uint8_t CAL_FAST_PLUS = 1;       // быстрый поиск вправо
const uint8_t CAL_FAST_MINUS = 2;      // быстрый поиск влево
const uint8_t CAL_EXIT_PLUS = 3;       // из флажка вправо, пока датчик не освободится
const uint8_t CAL_CLEAR_PLUS = 4;      // ещё запас вправо
const uint8_t CAL_SLOW_MINUS = 5;      // медленно влево до срабатывания: кромка справа
const uint8_t CAL_EXIT_MINUS = 6;      // из флажка влево
const uint8_t CAL_CLEAR_MINUS = 7;     // ещё запас влево
const uint8_t CAL_SLOW_PLUS = 8;       // медленно вправо до срабатывания: кромка слева
const uint8_t CAL_GO_ZERO = 9;         // на найденный ноль

const uint8_t CAL_OK = 0;
const uint8_t CAL_ERR_NOT_FOUND = 1;   // датчик не сработал в зоне поиска
const uint8_t CAL_ERR_STUCK = 2;       // датчик не освобождается
const uint8_t CAL_ERR_EDGE = 3;        // кромка не найдена при медленном подходе
const uint8_t CAL_ERR_ABORTED = 4;     // прервано командой s
const uint8_t CAL_ERR_TIMEOUT = 5;     // дольше CALIB_TIMEOUT_MS
const uint8_t CAL_ERR_SPREAD = 6;      // кромки между подходами расходятся больше CALIB_MAX_EDGE_SPREAD_DEG

// Биты состояния модуля: поля телеметрии @TLM.
const uint16_t STATUS_MOVING = 0x01;
const uint16_t STATUS_ZERO = 0x02;
const uint16_t STATUS_CALIB = 0x04;
const uint16_t STATUS_OPTO = 0x08;
const uint16_t STATUS_CYCLE = 0x10;
const uint16_t STATUS_HOME_OPTO = 0x20;
const uint16_t STATUS_V2 = 0x40;       // признак кадра этой версии
const uint16_t STATUS_POT_MODE = 0x1000;  // режим с потенциометром
const uint16_t STATUS_FULL_ZERO_FAULT = 0x4000;  // сохранённая поправка не заслуживает доверия
const uint16_t STATUS_POT_MODE_SUPPORTED = 0x2000;
const uint16_t STATUS_POT = 0x80;      // потенциометр откалиброван, доводка включена
// fw24: активное удержание угла (ph 1). Биты 8–11 заняты кодом ошибки
// калибровки (err=), поэтому 0x0100–0x0800 свободными НЕ были; свободен старший
// 0x8000 — он и занят удержанием.
const uint16_t STATUS_POT_HOLD = 0x8000;
// биты 8–11: код ошибки калибровки; биты 12–15 — режим потенциометра.
// Счётчик кадров в состояние НЕ входит: в v3 это отдельное поле кадра.

bool zero_set = false;
uint8_t home_source = HOME_NONE;
uint8_t calib_state = CAL_IDLE;
uint8_t calib_error = CAL_OK;
uint32_t calib_started_ms = 0;
int32_t calib_edges_plus[CALIB_SLOW_PASSES];   // кромки при подходе справа (движение влево), по подходам
int32_t calib_edges_minus[CALIB_SLOW_PASSES];  // кромки при подходе слева (движение вправо), по подходам
uint8_t calib_plus_count = 0;
uint8_t calib_minus_count = 0;
bool cycle_active = false;
bool cycle_to_end = true;
int32_t cycle_start_step = 0;
int32_t cycle_end_step = 0;
bool move_report_pending = false;      // напечатать «Цель достигнута» после поворота
bool resume_allowed = false;           // g продолжит поворот, прерванный командой s

bool drive_active = false;
int8_t drive_percent = 0;
uint32_t last_drive_command_ms = 0;
// Tagged b remains the acknowledgement for live steering and recovery.
// Legacy neutral telemetry fields remain in the protocol for compatibility;
// this firmware never enters neutral and old n commands only brake.
uint32_t brake_id = 0;
uint32_t brake_id_ms = 0;
bool neutral_active = false;
bool neutral_inhibit = false;
uint32_t neutral_id = 0;
// A live keyboard session starts only from its own tagged STOP and cannot be
// revived after STOP/watchdog. Ordinary w/t/v keep their original interlocks.
uint32_t live_id = 0;
uint32_t live_seq = 0;
int32_t live_target_step = 0;
const uint16_t LIVE_START_TIMEOUT_MS = 6000;

// Тяга: какие проценты просили и какое значение сейчас на входе «P».
// Значение — шкала Servo.write: 0…DRIVE_SERVO_MAX_VALUE (0 — мотор не тянет).
uint8_t drive_servo_value = 0;     // что реально написано в Servo.write
bool drive_mirrored = false;       // это колесо стоит зеркально

char tx_buf[TX_BUFFER_SIZE];
uint16_t tx_length = 0;
uint16_t tx_position = 0;

// Проверка EEPROM не использует имена USB-портов. Даже после перепрошивки с
// другой MODULE_ID запись старой физической роли не применяется молча.
struct FullZeroRecord { uint32_t generation; int32_t steps; };

bool readFullZeroSlot(uint8_t slot, FullZeroRecord* record) {
  uint8_t raw[EEPROM_ZERO_RECORD_SIZE];
  for (uint8_t i = 0; i < sizeof(raw); ++i)
    raw[i] = eeprom_read_byte((const uint8_t*)(uintptr_t)(EEPROM_ZERO_SLOTS[slot] + i));
  if (raw[0] != EEPROM_ZERO_MARKER || raw[1] != EEPROM_ZERO_VERSION ||
      raw[2] == 0 || raw[2] != wheelIdentityCode()) return false;
  const uint16_t stored = (uint16_t)raw[11] | ((uint16_t)raw[12] << 8);
  if (telemetryCrc16((const char*)raw + 1, 10) != stored) return false;
  memcpy(&record->generation, raw + 3, 4);
  memcpy(&record->steps, raw + 7, 4);
  const int32_t max_steps = (int32_t)lroundf(FULL_ZERO_MAX_OFFSET_DEG * STEPS_PER_DEGREE);
  return record->steps >= -max_steps && record->steps <= max_steps;
}

bool fullZeroSlotBlank(uint8_t slot) {
  bool erased_ff = true, erased_zero = true;
  for (uint8_t i = 0; i < EEPROM_ZERO_RECORD_SIZE; ++i) {
    const uint8_t b = eeprom_read_byte((const uint8_t*)(uintptr_t)(EEPROM_ZERO_SLOTS[slot] + i));
    if (b != 0xFF) erased_ff = false;
    if (b != 0) erased_zero = false;  // память симулятора / чистая нулевая EEPROM
  }
  return erased_ff || erased_zero;
}

void loadFullZero() {
  FullZeroRecord a, b;
  const bool valid_a = readFullZeroSlot(0, &a), valid_b = readFullZeroSlot(1, &b);
  full_zero_steps = 0;
  full_zero_generation = 0;
  full_zero_slot = -1;
  full_zero_storage_fault = false;
  // A partially written record and a damaged commit marker are indistinguishable.
  // Do not silently roll back to an older physical alignment in either case;
  // require explicit service recovery and calibration instead.
  for (uint8_t slot = 0; slot < 2; ++slot) {
    const bool valid = slot == 0 ? valid_a : valid_b;
    if (!valid && !fullZeroSlotBlank(slot)) full_zero_storage_fault = true;
  }
  if (valid_a || valid_b) {
    const bool use_b = valid_b && (!valid_a || (int32_t)(b.generation - a.generation) > 0);
    const FullZeroRecord& chosen = use_b ? b : a;
    full_zero_steps = chosen.steps;
    full_zero_generation = chosen.generation;
    full_zero_slot = use_b ? 1 : 0;
  } else if (!fullZeroSlotBlank(0) || !fullZeroSlotBlank(1)) {
    // Повреждённая память или запись чужой роли — не считать её нулевой.
    full_zero_storage_fault = true;
  }
}

bool persistFullZero(int32_t steps) {
  const uint8_t slot = full_zero_slot == 0 ? 1 : 0;
  uint8_t raw[EEPROM_ZERO_RECORD_SIZE] = {0};
  raw[0] = EEPROM_ZERO_MARKER;
  raw[1] = EEPROM_ZERO_VERSION;
  raw[2] = wheelIdentityCode();
  const uint32_t generation = full_zero_generation + 1;
  memcpy(raw + 3, &generation, 4);
  memcpy(raw + 7, &steps, 4);
  const uint16_t crc = telemetryCrc16((const char*)raw + 1, 10);
  raw[11] = (uint8_t)crc;
  raw[12] = (uint8_t)(crc >> 8);
  const uint16_t base = EEPROM_ZERO_SLOTS[slot];
  eeprom_update_byte((uint8_t*)(uintptr_t)base, 0); // прежний маркер недействителен
  if (eeprom_read_byte((const uint8_t*)(uintptr_t)base) != 0) return false;
  for (uint8_t i = 1; i < sizeof(raw); ++i)
    eeprom_update_byte((uint8_t*)(uintptr_t)(base + i), raw[i]);
  // Не фиксировать запись при отказе EEPROM или неверной роли.
  for (uint8_t i = 1; i < sizeof(raw); ++i)
    if (eeprom_read_byte((const uint8_t*)(uintptr_t)(base + i)) != raw[i]) return false;
  if (raw[2] == 0) return false;
  eeprom_update_byte((uint8_t*)(uintptr_t)base, EEPROM_ZERO_MARKER);
  FullZeroRecord verified;
  if (!readFullZeroSlot(slot, &verified) || verified.generation != generation || verified.steps != steps)
    return false;
  full_zero_steps = steps;
  full_zero_generation = generation;
  full_zero_slot = slot;
  return true;
}

// ---------------------------------------------------------------------------
// Вывод в USB без блокировки loop(): строка копируется в буфер и уходит в порт
// по мере освобождения передатчика. Нет места — строка пропускается.
void txAppend(const char* data, uint16_t length) {
  if (tx_position >= tx_length) {
    tx_position = 0;
    tx_length = 0;
  }
  if (length == 0 || (uint32_t)tx_length + length > sizeof(tx_buf)) return;
  memcpy(tx_buf + tx_length, data, length);
  tx_length += length;
}

uint16_t txFree() {
  if (tx_position >= tx_length) return sizeof(tx_buf);
  return (uint16_t)(sizeof(tx_buf) - tx_length);
}

void txPump() {
  while (tx_position < tx_length && Serial.availableForWrite() > 0) {
    Serial.write((uint8_t)tx_buf[tx_position++]);
  }
}

// Сообщение для человека: «# FL: текст». Телеметрия начинается с @TLM, поэтому
// сервер такие строки не путает с данными, а пишет в журнал бортового экрана.
void vnote(const char* module, const char* format_P, va_list args) {
  char line[176];
  int n = snprintf_P(line, sizeof(line) - 2, PSTR("# %s: "), module);
  if (n < 0) return;
  if (n > (int)sizeof(line) - 3) n = (int)sizeof(line) - 3;
  const int m = vsnprintf_P(line + n, sizeof(line) - 2 - (size_t)n, format_P, args);
  if (m < 0) return;
  n += m;
  if (n > (int)sizeof(line) - 3) n = (int)sizeof(line) - 3;
  line[n++] = '\r';
  line[n++] = '\n';
  txAppend(line, (uint16_t)n);
}

void noteModule(const char* module, const char* format_P, ...) {
  va_list args;
  va_start(args, format_P);
  vnote(module, format_P, args);
  va_end(args);
}

void note(const char* format_P, ...) {
  va_list args;
  va_start(args, format_P);
  vnote(MODULE_ID, format_P, args);
  va_end(args);
}

// value в десятых (decimals = 1) или сотых (decimals = 2) → "-12.50"
void formatFixed(long value, uint8_t decimals, char* out, size_t out_size) {
  const unsigned long scale = decimals == 1 ? 10UL : 100UL;
  const unsigned long magnitude = value < 0 ? (unsigned long)(-value) : (unsigned long)value;
  if (decimals == 1) {
    snprintf_P(out, out_size, PSTR("%s%lu.%01lu"), value < 0 ? "-" : "",
               magnitude / scale, magnitude % scale);
  } else {
    snprintf_P(out, out_size, PSTR("%s%lu.%02lu"), value < 0 ? "-" : "",
               magnitude / scale, magnitude % scale);
  }
}

void formatDegrees(int32_t steps, char* out, size_t out_size) {
  formatFixed(lroundf((float)steps * 100.0f / STEPS_PER_DEGREE), 2, out, out_size);
}

int32_t degreesToSteps(float degrees) {
  return (int32_t)lroundf(degrees * STEPS_PER_DEGREE);
}

bool parseFloatToken(const char* text, float* out) {
  if (!text || !*text) return false;
  char* end = nullptr;
  const double value = strtod(text, &end);
  if (end == text || *end != '\0' || !isfinite(value)) return false;
  *out = (float)value;
  return true;
}

bool parseLongToken(const char* text, long* out) {
  if (!text || !*text) return false;
  char* end = nullptr;
  const long value = strtol(text, &end, 10);
  if (end == text || *end != '\0') return false;
  *out = value;
  return true;
}

// Тахометр SC: считаем оба фронта (CHANGE), иначе 90 переходов превратятся
// в 45 и показание будет вдвое меньше. Прерывание ничего не меняет в приводе.
void tachometerISR() {
  const uint32_t now = (uint32_t)micros();
  if (!tach_has_edge) {
    tach_has_edge = true;
    tach_last_edge_us = now;
    ++tach_edges_total;                 // первый переход тоже составляет путь
    return;
  }
  const uint32_t interval = now - tach_last_edge_us;  // корректно при переполнении micros()
  if (interval < TACH_MIN_EDGE_US) return;
  tach_last_edge_us = now;
  ++tach_edges_total;                   // дребезг не попадает в одометрию
  if (interval > TACH_MAX_SILENCE_US) {
    // После долгой паузы первый фронт — новая точка отсчёта, не интервал.
    tach_last_period_us = 0;
    tach_interval_sum_us = 0;
    tach_interval_count = 0;
    return;
  }
  tach_last_period_us = interval;
  if (tach_interval_count < UINT16_MAX && tach_interval_sum_us <= UINT32_MAX - interval) {
    tach_interval_sum_us += interval;
    ++tach_interval_count;
  }
}

void updateTachDisplay() {
  const uint32_t now_ms = millis();
  if ((uint32_t)(now_ms - tach_last_sample_ms) < TACH_SAMPLE_PERIOD_MS) return;
  tach_last_sample_ms = now_ms;

  // На 8-битной Mega четырёхбайтовые значения из ISR читаются атомарно.
  const uint8_t saved_sreg = SREG;
  cli();
  const uint32_t sum = tach_interval_sum_us;
  const uint16_t count = tach_interval_count;
  const uint32_t last = tach_last_edge_us;
  const uint32_t period = tach_last_period_us;
  const bool seen = tach_has_edge;
  tach_interval_sum_us = 0;
  tach_interval_count = 0;
  SREG = saved_sreg;

  if (count && sum) {
    // RPM × 10 = 600 000 000 / (переходов на оборот × средний интервал, мкс).
    const uint64_t denominator = (uint64_t)TACH_EDGES_PER_REV * sum;
    tach_display_rpm_x10 = (uint32_t)(((uint64_t)600000000UL * count + denominator / 2) / denominator);
  }
  uint32_t silence = period >= TACH_MAX_SILENCE_US / 3 ? TACH_MAX_SILENCE_US : period * 3;
  if (silence < TACH_MIN_SILENCE_US) silence = TACH_MIN_SILENCE_US;
  const uint32_t age = (uint32_t)((uint32_t)micros() - last);
  if (!seen || !period || age > silence) {
    // Нет переходов: колесо может стоять, но обрыв SC выглядит точно так же.
    tach_display_rpm_x10 = 0;
  }
  // Забываем старую точку после паузы: иначе через полный оборот micros()
  // (примерно 71 минута) первый фронт ошибочно выглядел бы коротким интервалом.
  // Первому фронту без периода даём до 1,5 с дождаться второго. Повторно
  // проверяем метку под защитой — ISR мог получить новый фронт после снимка.
  if (seen && age > (period ? silence : TACH_MAX_SILENCE_US)) {
    const uint8_t reset_sreg = SREG;
    cli();
    if (tach_has_edge && tach_last_edge_us == last) {
      tach_has_edge = false;
      tach_last_period_us = 0;
    }
    SREG = reset_sreg;
  }
  tach_display_hz = (uint16_t)((tach_display_rpm_x10 * TACH_EDGES_PER_REV + 300UL) / 600UL);
}

// Recent SC edges are checked independently of the 500 ms RPM display.
// A single edge counts as recent for up to 1.5 s until a period is known.
// Silence cannot distinguish a stopped wheel from a disconnected SC wire.
bool tachMotionRecent() {
  const uint8_t saved_sreg = SREG;
  cli();
  const uint32_t last = tach_last_edge_us;
  const uint32_t period = tach_last_period_us;
  const bool seen = tach_has_edge;
  SREG = saved_sreg;
  if (!seen) return false;
  uint32_t silence = TACH_MAX_SILENCE_US;
  if (period) {
    silence = period >= TACH_MAX_SILENCE_US / 3 ? TACH_MAX_SILENCE_US : period * 3;
    if (silence < TACH_MIN_SILENCE_US) silence = TACH_MIN_SILENCE_US;
  }
  return (uint32_t)((uint32_t)micros() - last) <= silence;
}

// ---------------------------------------------------------------------------
// Шаги: Timer2 в режиме CTC, 16 МГц / 8 / 100 = 20 кГц, тик 50 мкс.
// Тяга идёт через библиотеку Servo (на Mega она берёт Timer5), руль — Timer2:
// таймеры не пересекаются.
bool optoActive() {
  const int level = digitalRead(OPTO_PIN);
  return OPTO_ACTIVE_LOW ? level == LOW : level == HIGH;
}

void setupStepTimer() {
  noInterrupts();
  TCCR2A = (1 << WGM21);            // CTC: сброс счётчика по совпадению с OCR2A
  TCCR2B = (1 << CS21);             // предделитель 8: 16 МГц / 8 / 100 = 20 кГц
  OCR2A = 99;                       // 100 тиков по 50 мкс, ровно как раньше
  TCNT2 = 0;
  TIMSK2 |= (1 << OCIE2A);
  interrupts();
}

// Полпериода шага = STEP_PERIOD_US / 100 тиков: 100 мкс → 50 мкс HIGH и 50 мкс
// LOW, ровно 10 кГц, как micros()-генератор проверенного скетча. Шаг считается
// по спаду PUL; начатый импульс при остановке доводится до конца и засчитывается.
ISR(TIMER2_COMPA_vect) {
  if (opto_watch != OPTO_WATCH_NONE) {
    if (optoActive() == (opto_watch == OPTO_WATCH_ACTIVE)) {
      if (++opto_match >= OPTO_DEBOUNCE_TICKS) {
        opto_watch = OPTO_WATCH_NONE;
        opto_event = true;
        opto_event_step = current_step + (pulse_high ? step_dir : 0);
        is_moving = false;
      }
    } else {
      opto_match = 0;
    }
  }
  if (!is_moving) {
    tick_count = 0;
    if (pulse_high) {
      digitalWrite(STEP_PUL_PIN, LOW);
      pulse_high = false;
      current_step += step_dir;
    }
    return;
  }
  if (current_step == target_step) {
    is_moving = false;
    tick_count = 0;
    return;
  }
  if (++tick_count < half_period_ticks) return;
  tick_count = 0;
  if (!pulse_high) {
    digitalWrite(STEP_PUL_PIN, HIGH);
    pulse_high = true;
  } else {
    digitalWrite(STEP_PUL_PIN, LOW);
    pulse_high = false;
    current_step += step_dir;
    if (current_step == target_step) is_moving = false;
  }
}

int32_t stepNow() {
  noInterrupts();
  const int32_t value = current_step;
  interrupts();
  return value;
}

int32_t targetNow() {
  noInterrupts();
  const int32_t value = target_step;
  interrupts();
  return value;
}

bool motorBusy() {
  noInterrupts();
  const bool busy = is_moving || pulse_high;
  interrupts();
  return busy;
}

// Остановить ход из loop(). Начатый импульс прерывание доведёт за ≤ 50 мкс.
void haltMotor() {
  noInterrupts();
  is_moving = false;
  opto_watch = OPTO_WATCH_NONE;
  interrupts();
  for (uint8_t i = 0; i < 30 && motorBusy(); ++i) delayMicroseconds(10);
}

void startMotor(int32_t target, uint16_t period_us, uint8_t watch) {
  haltMotor();
  const int32_t current = stepNow();
  const int8_t direction = target >= current ? 1 : -1;
  digitalWrite(STEP_ENA_PIN, STEP_ENABLE_LEVEL);
  digitalWrite(STEP_DIR_PIN, direction > 0 ? STEP_DIR_PLUS_LEVEL : STEP_DIR_MINUS_LEVEL);
  delayMicroseconds(10);  // DIR раньше первого фронта PUL (TB6600: не меньше 5 мкс)
  uint16_t ticks = (uint16_t)((period_us + 50U) / 100U);
  if (ticks < 1) ticks = 1;
  if (ticks > 255) ticks = 255;
  noInterrupts();
  step_dir = direction;
  half_period_ticks = (uint8_t)ticks;
  tick_count = 0;
  target_step = target;
  opto_match = 0;
  opto_event = false;
  opto_watch = watch;
  is_moving = target != current;
  interrupts();
}

// ---------------------------------------------------------------------------
// Потенциометр положения колеса — абсолютный датчик угла на A0.
//
// Ноль запоминается автоматически, когда задан ноль руля (k или z). Команда q
// измеряет наклон: колесо едет в 0°, −60° и +60°, по двум точкам считается
// «отсчётов АЦП на градус». Только после q включается доводка: после каждого
// поворота прошивка сравнивает угол с потенциометром и делает до
// POT_CORRECTION_MAX_PASSES поправок. Без q датчик показывает угол по номиналу
// 1023/270, но в управление не вмешивается.
const uint16_t POT_CAL_SETTLE_MS = 120;   // механика успокаивается после остановки
const uint8_t POT_CAL_SAMPLES = 8;        // отсчётов АЦП на точку калибровки

const uint8_t POT_CAL_IDLE = 0;
const uint8_t POT_CAL_TO_ZERO = 1;        // в 0° перед замерами
const uint8_t POT_CAL_TO_MINUS = 2;       // в −60°
const uint8_t POT_CAL_TO_PLUS = 3;        // в +60°
const uint8_t POT_CAL_BACK = 4;           // обратно в 0°

int16_t pot_raw = 0;                      // фильтрованное значение АЦП 0…1023
bool pot_enabled = true;                 // pm 0: управление только по шагам
bool pot_sampled = false;
bool pot_railed = false;                  // 0/1023 — обрыв, КЗ или упор
bool pot_zero_valid = false;              // есть привязка к нулю руля
bool pot_calibrated = false;              // наклон измерен командой q
float pot_zero_raw = 0.0f;                // АЦП в 0° руля
float pot_counts_per_degree = POT_NOMINAL_COUNTS_PER_DEG;
uint32_t last_pot_sample_ms = 0;
uint8_t pot_cal_state = POT_CAL_IDLE;
uint32_t pot_cal_started_ms = 0;
uint32_t pot_cal_wait_ms = 0;
float pot_cal_zero_raw = 0.0f;
float pot_cal_minus_raw = 0.0f;
float pot_cal_plus_raw = 0.0f;
bool pot_cal_ok = false;
bool feedback_pending = false;            // после поворота ждём доводку
uint8_t feedback_passes = 0;
uint32_t feedback_wait_ms = 0;
int32_t feedback_target_step = 0;
// Активное удержание угла (ph). Цель удержания — намеренная команда (w/d/h/g),
// а не текущее положение: доводка и удержание её не переписывают.
bool pot_hold = false;                    // ph 1; после старта платы — выключено
int32_t pot_hold_target_step = 0;         // угол, который держим
uint8_t pot_hold_passes = 0;              // подходов подряд без результата
uint16_t pot_hold_retries = 0;            // сколько раз упирались в POT_HOLD_MAX_PASSES
uint32_t pot_hold_wait_ms = 0;            // пауза после остановки перед замером
uint32_t pot_hold_scan_ms = 0;            // не читать АЦП чаще POT_SAMPLE_PERIOD_MS
uint32_t pot_hold_confirm_ms = 0;         // с какого времени смещение подтверждается
uint32_t pot_hold_pause_until_ms = 0;     // пауза после серии подходов

bool potRawOnRail(int16_t raw) {
  return raw <= POT_RAIL_MARGIN || raw >= POT_ADC_MAX - POT_RAIL_MARGIN;
}

int16_t potReadAverage(uint8_t count) {
  if (count == 0) count = 1;
  uint16_t sum = 0;
  for (uint8_t i = 0; i < count; ++i) sum += (uint16_t)analogRead(POT_PIN);
  return (int16_t)((sum + count / 2) / count);
}

// Свежий замер после остановки: фильтр не успевает за ходом, поэтому для
// доводки берём среднее из четырёх отсчётов сразу, без EMA.
int16_t potMeasureRaw() {
  const int16_t raw = potReadAverage(4);
  pot_raw = raw;
  pot_sampled = true;
  pot_railed = potRawOnRail(raw);
  return raw;
}

// Один отсчёт раз в POT_SAMPLE_PERIOD_MS + экспоненциальный фильтр 1/4.
// 10 мс при 75°/с — это 0,75° запаздывания, а шум АЦП падает вчетверо.
void updatePot() {
  if (!pot_enabled) return;
  const uint32_t now = millis();
  if ((uint32_t)(now - last_pot_sample_ms) < POT_SAMPLE_PERIOD_MS) return;
  last_pot_sample_ms = now;
  const int16_t raw = (int16_t)analogRead(POT_PIN);
  if (!pot_sampled) {
    pot_raw = raw;
    pot_sampled = true;
  } else {
    pot_raw = (int16_t)(((int32_t)pot_raw * ((1 << POT_FILTER_SHIFT) - 1) + raw +
                         (1 << (POT_FILTER_SHIFT - 1))) >> POT_FILTER_SHIFT);
  }
  pot_railed = potRawOnRail(pot_raw);
}

float potAngleDeg() {
  if (!pot_zero_valid || pot_counts_per_degree == 0.0f) return 0.0f;
  return ((float)pot_raw - pot_zero_raw) / pot_counts_per_degree;
}

bool potFeedbackAllowed() {
  return pot_enabled && pot_calibrated && pot_zero_valid && !pot_railed && zero_set;
}

// Ноль руля задан (k или z) — запомнить, где стоит движок потенциометра.
// Наклон (отсчёты/градус), измеренный q, при повторном нуле сохраняется.
void potCaptureZero() {
  if (!pot_enabled) return;
  const int16_t raw = potReadAverage(POT_CAL_SAMPLES);
  pot_raw = raw;
  pot_sampled = true;
  if (potRawOnRail(raw)) {
    pot_zero_valid = false;
    pot_calibrated = false;
    pot_railed = true;
    note(PSTR("потенциометр A0: %d — на краю, доводка выключена"), (int)raw);
    return;
  }
  pot_zero_raw = raw;
  pot_zero_valid = true;
  pot_railed = false;
  if (!pot_calibrated) pot_counts_per_degree = POT_NOMINAL_COUNTS_PER_DEG;
  note(PSTR("потенциометр A0: 0° = %d, %s"), (int)raw,
       pot_calibrated ? "наклон сохранён" : "q — точная калибровка");
}

float potSlopeFromEeprom() {
  if (eeprom_read_byte((const uint8_t*)(uint16_t)EEPROM_POT_MAGIC_SLOT) != EEPROM_POT_MAGIC) return 0.0f;
  uint8_t bytes[4];
  for (uint8_t i = 0; i < sizeof(bytes); ++i) {
    bytes[i] = eeprom_read_byte((const uint8_t*)(uintptr_t)(EEPROM_POT_SLOPE_SLOT + i));
  }
  float slope;
  memcpy(&slope, bytes, sizeof(slope));
  if (slope < POT_CAL_MIN_COUNTS_PER_DEG || slope > POT_CAL_MAX_COUNTS_PER_DEG) return 0.0f;
  return slope;
}

void potSlopeToEeprom(float slope) {
  uint8_t bytes[4];
  memcpy(bytes, &slope, sizeof(slope));
  for (uint8_t i = 0; i < sizeof(bytes); ++i) {
    eeprom_update_byte((uint8_t*)(uintptr_t)(EEPROM_POT_SLOPE_SLOT + i), bytes[i]);
  }
  eeprom_update_byte((uint8_t*)(uint16_t)EEPROM_POT_MAGIC_SLOT, EEPROM_POT_MAGIC);
}

// Провал q значит, что датчик себя не подтвердил: прежний наклон доверия
// больше не заслуживает, иначе следующая загрузка достанет его из памяти.
void potSlopeForget() {
  eeprom_update_byte((uint8_t*)(uint16_t)EEPROM_POT_MAGIC_SLOT, 0);
}

void potBootNote() {
  const float saved_slope = potSlopeFromEeprom();
  if (saved_slope > 0.0f) {
    pot_counts_per_degree = saved_slope;
    pot_calibrated = true;
  }
  const int16_t raw = potReadAverage(POT_CAL_SAMPLES);
  pot_raw = raw;
  pot_sampled = true;
  pot_railed = potRawOnRail(raw);
  if (pot_railed) {
    note(PSTR("потенциометр A0: %d — на краю, проверьте провод"), (int)raw);
  } else {
    note(PSTR("потенциометр A0: %d — ноль: k/z%s"), (int)raw,
         pot_calibrated ? ", наклон из EEPROM" : ", калибровка: q");
  }
}

// p показывает и удержание: включено ли, какой угол держим и сколько подходов.
void potPrintHoldStatus() {
  if (!pot_hold) {
    note(PSTR("Удержание угла: выключено (ph 1 — включить)"));
    return;
  }
  char target[16];
  formatDegrees(pot_hold_target_step, target, sizeof(target));
  note(PSTR("Удержание угла: включено · цель %s° · подходов %u/%u · попыток %u"),
       target, (unsigned)pot_hold_passes, (unsigned)POT_HOLD_MAX_PASSES,
       (unsigned)pot_hold_retries);
}

void potPrintStatus() {
  if (!pot_enabled) { note(PSTR("Без потенциометра: угол по шагам")); return; }
  potMeasureRaw();                     // p — свежий замер, а не фильтр с задержкой
  if (pot_zero_valid && !pot_railed) {
    char angle[16];
    formatFixed(lroundf(potAngleDeg() * 100.0f), 2, angle, sizeof(angle));
    note(PSTR("Потенциометр A0: %d = %s°%s"), (int)pot_raw, angle,
         pot_calibrated ? " (наклон измерен)" : " (номинал, q)");
  } else if (pot_railed) {
    note(PSTR("Потенциометр A0: %d — на краю, проверьте провод"), (int)pot_raw);
  } else {
    note(PSTR("Потенциометр A0: %d — нет нуля (k или z), затем q"), (int)pot_raw);
  }
}

void startPotCalMove(uint8_t state, float degrees) {
  pot_cal_state = state;
  pot_cal_wait_ms = 0;
  startMotor(degreesToSteps(degrees), STEP_PERIOD_US, OPTO_WATCH_NONE);
}

bool startPotCalibration() {
  if (full_zero_storage_fault) { note(PSTR("ОШИБКА EEPROM полного нуля")); return false; }
  if (!pot_enabled) { note(PSTR("Сначала pm 1 — включить потенциометр")); return false; }
  if (drive_active) {
    note(PSTR("потенциометр: включена тяга — сначала b или s"));
    return false;
  }
  if (calib_state != CAL_IDLE) {
    note(PSTR("потенциометр: идёт калибровка руля"));
    return false;
  }
  if (pot_cal_state != POT_CAL_IDLE) {
    note(PSTR("калибровка потенциометра уже идёт"));
    return false;
  }
  if (!zero_set) {
    note(PSTR("потенциометр: сначала ноль — k (по датчику) или z"));
    return false;
  }
  if (motorBusy() || cycle_active) {
    note(PSTR("потенциометр: сначала остановите колесо (s)"));
    return false;
  }
  if (pot_railed) {
    note(PSTR("потенциометр A0: %d — на краю, проверьте провод"), (int)pot_raw);
    return false;
  }
  feedback_pending = false;
  resume_allowed = false;
  move_report_pending = false;
  stopPotHold();           // q (калибровка датчика) выключает удержание
  pot_cal_ok = false;
  pot_cal_started_ms = millis();
  note(PSTR("Калибровка потенциометра: 0°, −%d°, +%d°..."),
       (int)POT_CAL_POINT_DEG, (int)POT_CAL_POINT_DEG);
  startPotCalMove(POT_CAL_TO_ZERO, 0.0f);
  return true;
}

void updatePotCalibration() {
  if (pot_cal_state == POT_CAL_IDLE) return;
  if ((uint32_t)(millis() - pot_cal_started_ms) > POT_CAL_TIMEOUT_MS) {
    pot_cal_state = POT_CAL_IDLE;
    haltMotor();
    noInterrupts();
    target_step = current_step;
    interrupts();
    note(PSTR("ОШИБКА потенциометра: не уложилась по времени"));
    return;
  }
  if (motorBusy()) {
    pot_cal_wait_ms = 0;
    return;
  }
  if (pot_cal_wait_ms == 0) {
    pot_cal_wait_ms = millis() + POT_CAL_SETTLE_MS;
    if (pot_cal_wait_ms == 0) pot_cal_wait_ms = 1;
    return;
  }
  if ((int32_t)(millis() - pot_cal_wait_ms) < 0) return;

  switch (pot_cal_state) {
    case POT_CAL_TO_ZERO:
      pot_cal_zero_raw = (float)potReadAverage(POT_CAL_SAMPLES);
      startPotCalMove(POT_CAL_TO_MINUS, -POT_CAL_POINT_DEG);
      break;
    case POT_CAL_TO_MINUS:
      pot_cal_minus_raw = (float)potReadAverage(POT_CAL_SAMPLES);
      startPotCalMove(POT_CAL_TO_PLUS, POT_CAL_POINT_DEG);
      break;
    case POT_CAL_TO_PLUS: {
      pot_cal_plus_raw = (float)potReadAverage(POT_CAL_SAMPLES);
      const float slope = (pot_cal_plus_raw - pot_cal_minus_raw) /
                          (2.0f * POT_CAL_POINT_DEG);
      const float magnitude = fabsf(slope);
      const bool rails = potRawOnRail((int16_t)pot_cal_zero_raw) ||
                         potRawOnRail((int16_t)pot_cal_minus_raw) ||
                         potRawOnRail((int16_t)pot_cal_plus_raw);
      if (rails || magnitude < POT_CAL_MIN_COUNTS_PER_DEG ||
          magnitude > POT_CAL_MAX_COUNTS_PER_DEG) {
        pot_cal_ok = false;
        pot_calibrated = false;
        potSlopeForget();
        pot_zero_valid = false;
        note(PSTR("ОШИБКА потенциометра: нет сигнала или неверный ход"));
      } else {
        pot_cal_ok = true;
        pot_zero_raw = pot_cal_zero_raw;
        pot_counts_per_degree = slope;
        pot_zero_valid = true;
        pot_calibrated = true;
        potSlopeToEeprom(slope);
        char text[16];
        formatFixed(lroundf(slope * 100.0f), 2, text, sizeof(text));
        note(PSTR("Потенциометр: %s отсч/°, 0° = %d"), text, (int)pot_cal_zero_raw);
      }
      startPotCalMove(POT_CAL_BACK, 0.0f);
      break;
    }
    case POT_CAL_BACK:
      pot_cal_state = POT_CAL_IDLE;
      if (pot_cal_ok) {
        note(PSTR("Потенциометр: калибровка завершена, доводка включена"));
      }
      break;
    default:
      pot_cal_state = POT_CAL_IDLE;
      break;
  }
}

// После поворота: сравнить угол с потенциометром и до 3 раз довернуть.
// error = измерено − цель; чтобы уменьшить измеренное, колесо едет на −error.
// Затем счётчик шагов привязывается к измеренному углу, чтобы deg= в
// телеметрии было реальным положением колеса.
void updateFeedback() {
  if (!feedback_pending) return;
  if (calib_state != CAL_IDLE || pot_cal_state != POT_CAL_IDLE || cycle_active) {
    feedback_pending = false;
    return;
  }
  if (motorBusy()) {
    feedback_wait_ms = 0;
    return;
  }
  const uint32_t now = millis();
  if (feedback_wait_ms == 0) {
    feedback_wait_ms = now + POT_CORRECTION_SETTLE_MS;
    if (feedback_wait_ms == 0) feedback_wait_ms = 1;
    return;
  }
  if ((int32_t)(now - feedback_wait_ms) < 0) return;

  potMeasureRaw();
  const float actual = potAngleDeg();
  const float wanted = (float)feedback_target_step / STEPS_PER_DEGREE;
  const float error = actual - wanted;
  // Датчик доворачивает колесо на сантиметры, а не возит его по всей шкале.
  // Если он расходится с целью сильнее POT_TRUST_DEG, верить ему нельзя:
  // доводка догоняла бы именно датчик и утаскивала колесо на десятки градусов
  // от команды (оператор видит «повернулось на 4° вместо 35°»), а последовавшая
  // привязка счётчика шагов к датчику заставляла телеметрию отрапортовать
  // успех при колесе совсем не там. Колесо остаётся там, куда его привели
  // шаги, а расхождение честно печатается.
  if (!pot_railed && fabsf(error) > POT_TRUST_DEG) {
    char text[16];
    formatFixed(lroundf(error * 100.0f), 2, text, sizeof(text));
    note(PSTR("Потенциометр: расхождение %s° — доводка отключена; проверьте колесо или q"), text);
    noInterrupts();
    target_step = feedback_target_step;
    interrupts();
    feedback_pending = false;
    feedback_passes = 0;
    return;
  }
  if (!pot_railed && fabsf(error) > POT_CORRECTION_DEADBAND_DEG &&
      feedback_passes < POT_CORRECTION_MAX_PASSES) {
    ++feedback_passes;
    char text[16];
    formatFixed(lroundf(error * 100.0f), 2, text, sizeof(text));
    note(PSTR("Потенциометр: доводка %s° (проход %d/%d)"), text,
         (int)feedback_passes, (int)POT_CORRECTION_MAX_PASSES);
    const int32_t correction = degreesToSteps(-error);
    if (correction != 0) {
      target_step = stepNow() + correction;
      startMotor(target_step, STEP_PERIOD_US, OPTO_WATCH_NONE);
      feedback_wait_ms = 0;
      return;
    }
  }

  const float step_angle = (float)stepNow() / STEPS_PER_DEGREE;
  // Счётчик шагов привязываем к датчику только в пределах доверия: иначе одна
  // врущая q молча перепишет положение колеса и телеметрия начнёт врать следом.
  if (pot_zero_valid && !pot_railed &&
      fabsf(actual - step_angle) > POT_RESYNC_DEG &&
      fabsf(actual - step_angle) <= POT_TRUST_DEG) {
    noInterrupts();
    current_step = degreesToSteps(actual);
    interrupts();
  }
  noInterrupts();
  target_step = feedback_target_step;
  interrupts();
  if (feedback_passes > 0) {
    char text[16];
    formatFixed(lroundf(error * 100.0f), 2, text, sizeof(text));
    note(PSTR("Потенциометр: остаток %s°"), text);
  }
  feedback_pending = false;
  feedback_passes = 0;
}

// ---------------------------------------------------------------------------
// Активное удержание угла (команда ph, fw24).
//
// Доводка выравнивает колесо один раз после поворота и на этом заканчивается:
// отвели колесо рукой — оно остаётся там. Удержание продолжает сравнение с
// потенциометром всё время, пока оно включено, и медленно возвращает колесо к
// заданному углу (18 °/с): оператор видит движение и успевает убрать руку.
//
// Решение принимается только по АЦП и только при готовом датчике (pm 1 + q +
// ноль). Ход идёт через общий startMotor(), поэтому s, b, watchdog 650 мс и
// E-STOP гасят удержание теми же путями, что и любой поворот.

// Цель удержания — намеренная команда (w/d/h/g), а не текущее положение:
// поправка удержания её не переписывает.
bool potHoldAllowed() {
  return pot_hold && pot_enabled && pot_calibrated && pot_zero_valid && !pot_railed &&
         !motorBusy() && !feedback_pending && drive_percent == 0 &&
         calib_state == CAL_IDLE && pot_cal_state == POT_CAL_IDLE && !cycle_active &&
         !neutral_active && !neutral_inhibit;
}

// Выключить удержание и вернуть цель намеренной команды.
void stopPotHold() {
  if (!pot_hold) return;
  pot_hold = false;
  pot_hold_passes = 0;
  pot_hold_retries = 0;
  pot_hold_confirm_ms = 0;
  pot_hold_wait_ms = 0;
  pot_hold_pause_until_ms = 0;
  if (!motorBusy()) {
    noInterrupts();
    target_step = pot_hold_target_step;
    interrupts();
  }
}

// ph 1: включить удержание. Калибровку, в отличие от pm, НЕ сбрасывает.
bool startPotHold() {
  if (!pot_enabled) {
    note(PSTR("Удержание: сначала pm 1 — включить потенциометр"));
    return false;
  }
  if (!pot_calibrated || !pot_zero_valid) {
    note(PSTR("Удержание: нужен ноль руля и калибровка q — без датчика его нет"));
    return false;
  }
  potMeasureRaw();
  if (pot_railed) {
    note(PSTR("потенциометр A0: %d — на краю, проверьте провод"), (int)pot_raw);
    return false;
  }
  const int32_t target = targetNow();
  const float error = potAngleDeg() - (float)target / STEPS_PER_DEGREE;
  if (fabsf(error) > POT_HOLD_MAX_DEG) {
    char text[16];
    formatFixed(lroundf(error * 100.0f), 2, text, sizeof(text));
    note(PSTR("Удержание: колесо отличается от цели на %s° — сначала w или h"), text);
    return false;
  }
  pot_hold = true;
  pot_hold_target_step = target;
  pot_hold_passes = 0;
  pot_hold_retries = 0;
  pot_hold_confirm_ms = 0;
  pot_hold_wait_ms = 0;
  pot_hold_pause_until_ms = 0;
  pot_hold_scan_ms = millis();
  char angle[16];
  formatDegrees(target, angle, sizeof(angle));
  note(PSTR("Удержание включено: держу %s° — колесо возвращается само"), angle);
  return true;
}

void updatePotHold() {
  if (!pot_hold) return;
  // Режим потенциометра или калибровку сбросили — держать больше нечего.
  if (!pot_enabled || !pot_calibrated || !pot_zero_valid ||
      calib_state != CAL_IDLE || pot_cal_state != POT_CAL_IDLE || cycle_active) {
    stopPotHold();
    return;
  }
  // Тяга, нейтраль и чужая калибровка удержание приостанавливают, но не выключают.
  if (motorBusy() || feedback_pending || drive_percent != 0 ||
      neutral_active || neutral_inhibit) {
    pot_hold_wait_ms = 0;
    pot_hold_confirm_ms = 0;
    return;
  }
  if (!potHoldAllowed()) return;
  const uint32_t now = millis();
  if ((int32_t)(now - pot_hold_pause_until_ms) < 0) return;   // пауза серии подходов
  if ((uint32_t)(now - pot_hold_scan_ms) < POT_SAMPLE_PERIOD_MS) return;
  pot_hold_scan_ms = now;
  if (pot_hold_wait_ms == 0) {
    pot_hold_wait_ms = now + POT_CORRECTION_SETTLE_MS;
    if (pot_hold_wait_ms == 0) pot_hold_wait_ms = 1;
    return;
  }
  if ((int32_t)(now - pot_hold_wait_ms) < 0) return;          // механика успокаивается

  potMeasureRaw();
  if (pot_railed) return;                    // край датчика — не наша забота
  const float actual = potAngleDeg();
  const float wanted = (float)pot_hold_target_step / STEPS_PER_DEGREE;
  const float error = actual - wanted;
  const float magnitude = fabsf(error);

  // Потолок реакции: такой сдвиг — это уже рука оператора, а не люфт. Догонять
  // его медленным ходом опасно (колесо поедет под рукой) — выключаемся.
  if (magnitude > POT_HOLD_MAX_DEG) {
    char text[16];
    formatFixed(lroundf(magnitude * 100.0f), 2, text, sizeof(text));
    note(PSTR("Удержание: сдвинуто вручную на %s° (> %d°) — отключено, повторите команду"),
         text, (int)POT_HOLD_MAX_DEG);
    stopPotHold();
    return;
  }

  if (magnitude <= POT_HOLD_DEADBAND_DEG) {
    pot_hold_confirm_ms = 0;
    // Один контрольный замер после остановки: колесо на месте. Счётчик шагов
    // привязываем к датчику в пределах доверия (как в updateFeedback): ручной
    // сдвиг датчик объясняет, а расхождение больше POT_HOLD_REATTACH_DEG — нет,
    // и тогда честнее выключить удержание, чем молча переписать положение.
    const float step_angle = (float)stepNow() / STEPS_PER_DEGREE;
    const float gap = actual - step_angle;
    if (fabsf(gap) > POT_RESYNC_DEG) {
      if (fabsf(gap) <= POT_HOLD_REATTACH_DEG) {
        noInterrupts();
        current_step = degreesToSteps(actual);
        interrupts();
      } else {
        char text[16];
        formatFixed(lroundf(gap * 100.0f), 2, text, sizeof(text));
        note(PSTR("Потенциометр: расхождение %s° — удержание отключено; проверьте колесо или q"), text);
        stopPotHold();
        return;
      }
    }
    pot_hold_passes = 0;
    noInterrupts();
    target_step = pot_hold_target_step;
    interrupts();
    return;
  }

  // Смещение должно продержаться POT_HOLD_CONFIRM_MS: шум АЦП и толчок корпуса
  // не должны раскачивать мотор.
  if (pot_hold_confirm_ms == 0) {
    pot_hold_confirm_ms = now;
    if (pot_hold_confirm_ms == 0) pot_hold_confirm_ms = 1;
    return;
  }
  if ((int32_t)(now - pot_hold_confirm_ms) < (int32_t)POT_HOLD_CONFIRM_MS) return;

  // Шаги должны вести колесо. Если счётчик ушёл от цели дальше потолка, а
  // датчик всё ещё спорит, колесо не едет: упор, заклинивание или рука на
  // колесе. Дальше толкать нельзя — выключаемся с тем же сообщением о
  // расхождении, что и доводка.
  if (labs(stepNow() - pot_hold_target_step) > degreesToSteps(POT_HOLD_MAX_DEG)) {
    char text[16];
    formatFixed(lroundf(error * 100.0f), 2, text, sizeof(text));
    note(PSTR("Потенциометр: расхождение %s° — удержание отключено; проверьте колесо или q"), text);
    stopPotHold();
    return;
  }

  if (pot_hold_passes >= POT_HOLD_MAX_PASSES) {
    // Колесо не идёт (упор, заклинивание, рука на колесе): пауза и счётчик,
    // а не бесконечная серия подходов.
    pot_hold_passes = 0;
    pot_hold_confirm_ms = 0;
    if (pot_hold_retries < 0xFFFF) ++pot_hold_retries;
    pot_hold_pause_until_ms = now + POT_HOLD_PAUSE_MS;
    note(PSTR("Удержание: %u подходов подряд без результата — пауза %u мс, попыток %u"),
         (unsigned)POT_HOLD_MAX_PASSES, (unsigned)POT_HOLD_PAUSE_MS,
         (unsigned)pot_hold_retries);
    return;
  }
  const int32_t correction = degreesToSteps(-error);
  if (correction == 0) return;
  ++pot_hold_passes;
  pot_hold_confirm_ms = 0;
  startMotor(stepNow() + correction, POT_HOLD_STEP_PERIOD_US, OPTO_WATCH_NONE);
  pot_hold_wait_ms = 0;
}

// ---------------------------------------------------------------------------
// Калибровка по оптодатчику. Флажок находится быстрым ходом в пределах ±125°
// от старта (вправо 125°, потом влево 250°; упор потенциометра — ±130°).
// Затем каждая кромка снимается
// CALIB_SLOW_PASSES раз медленным подходом снаружи: справа налево и слева направо,
// вперемешку. Ноль — середина между средними кромками (или кромка, см.
// CALIB_ZERO_AT_CENTER) плюс CALIB_ZERO_OFFSET_DEG. Разброс кромок больше
// CALIB_MAX_EDGE_SPREAD_DEG — ошибка 6, ноль не ставится.
void copyCalibErrorText(uint8_t error, char* out, size_t out_size) {
  const char* text;
  switch (error) {
    case CAL_ERR_NOT_FOUND: text = PSTR("датчик не найден в ±125° от старта"); break;
    case CAL_ERR_STUCK: text = PSTR("датчик не освобождается (залип или флажок шире 30°)"); break;
    case CAL_ERR_EDGE: text = PSTR("кромка не найдена при медленном подходе"); break;
    case CAL_ERR_SPREAD: text = PSTR("кромки расходятся между подходами"); break;
    case CAL_ERR_ABORTED: text = PSTR("прервана командой s"); break;
    case CAL_ERR_TIMEOUT: text = PSTR("не уложилась по времени"); break;
    default: text = PSTR("нет ошибок"); break;
  }
  strncpy_P(out, text, out_size - 1);
  out[out_size - 1] = '\0';
}

void calibrationStep(uint8_t state, float degrees, uint16_t period_us, uint8_t watch) {
  calib_state = state;
  startMotor(stepNow() + degreesToSteps(degrees), period_us, watch);
}

bool startCalibration() {
  if (full_zero_storage_fault) {
    note(PSTR("ОШИБКА EEPROM полного нуля или роль платы изменилась — проверьте память"));
    return false;
  }
  if (drive_active) {
    note(PSTR("калибровка отклонена: включена тяга (сначала b или s)"));
    return false;
  }
  if (calib_state != CAL_IDLE) {
    note(PSTR("Калибровка уже запущена!"));
    return false;
  }
  if (pot_cal_state != POT_CAL_IDLE) {
    note(PSTR("сначала дождитесь калибровки потенциометра или s"));
    return false;
  }
  cycle_active = false;
  resume_allowed = false;
  move_report_pending = false;
  feedback_pending = false;
  stopPotHold();           // k обнуляет ноль — держать прежний угол нельзя
  zero_set = false;
  pot_zero_valid = false;
  home_source = HOME_NONE;
  calib_error = CAL_OK;
  calib_started_ms = millis();
  calib_plus_count = 0;
  calib_minus_count = 0;
  if (optoActive()) {
    note(PSTR("Калибровка: датчик уже закрыт — выхожу из флажка вправо"));
    calibrationStep(CAL_EXIT_PLUS, CALIB_MAX_FLAG_DEGREES, STEP_PERIOD_US, OPTO_WATCH_CLEAR);
  } else {
    note(PSTR("Калибровка: быстрый поиск вправо на %d°..."), (int)CALIB_HALF_RANGE_DEG);
    calibrationStep(CAL_FAST_PLUS, CALIB_HALF_RANGE_DEG, STEP_PERIOD_US, OPTO_WATCH_ACTIVE);
  }
  return true;
}

void failCalibration(uint8_t error) {
  haltMotor();
  noInterrupts();
  target_step = current_step;
  interrupts();
  calib_state = CAL_IDLE;
  calib_error = error;
  zero_set = false;
  home_source = HOME_NONE;
  pot_zero_valid = false;
  feedback_pending = false;
  char text[112];
  copyCalibErrorText(error, text, sizeof(text));
  note(PSTR("ОШИБКА калибровки: %s"), text);
}

// Среднее по подходам (округление к ближайшему, половины — от нуля).
int32_t meanSteps(const int32_t* values, uint8_t count) {
  if (count == 0) return 0;
  int32_t sum = 0;
  for (uint8_t i = 0; i < count; ++i) sum += values[i];
  return sum >= 0 ? (sum + count / 2) / count : -((-sum + count / 2) / count);
}

// Разброс кромок между подходами (макс − мин).
int32_t spreadSteps(const int32_t* values, uint8_t count) {
  if (count == 0) return 0;
  int32_t low = values[0];
  int32_t high = values[0];
  for (uint8_t i = 1; i < count; ++i) {
    if (values[i] < low) low = values[i];
    if (values[i] > high) high = values[i];
  }
  return high - low;
}

uint8_t calibrationPassesDone() {
  return (uint8_t)(calib_plus_count + calib_minus_count);
}

void finishCalibrationEdges() {
  haltMotor();
  // Кромки с разных подходов должны совпадать: иначе датчик или механика врут,
  // и ноль ставить нельзя.
  const int32_t limit = degreesToSteps(CALIB_MAX_EDGE_SPREAD_DEG);
  const int32_t spread_plus = spreadSteps(calib_edges_plus, calib_plus_count);
  const int32_t spread_minus = spreadSteps(calib_edges_minus, calib_minus_count);
  if (spread_plus > limit || spread_minus > limit) {
    failCalibration(CAL_ERR_SPREAD);
    return;
  }
  const int32_t edge_plus = meanSteps(calib_edges_plus, calib_plus_count);
  const int32_t edge_minus = meanSteps(calib_edges_minus, calib_minus_count);
  int32_t zero_at = edge_minus;
  if (CALIB_ZERO_AT_CENTER) {
    const int32_t sum = edge_plus + edge_minus;
    zero_at = sum >= 0 ? (sum + 1) / 2 : -((1 - sum) / 2);
  }
  zero_at += degreesToSteps(CALIB_ZERO_OFFSET_DEG) + full_zero_steps;
  char width[16];
  char shift[16];
  char spread_a[16];
  char spread_b[16];
  formatDegrees(edge_plus - edge_minus, width, sizeof(width));
  formatDegrees(zero_at, shift, sizeof(shift));
  formatDegrees(spread_plus, spread_a, sizeof(spread_a));
  formatDegrees(spread_minus, spread_b, sizeof(spread_b));
  note(PSTR("Калибровка: кромки найдены, ширина флажка %s°, разброс %s°/%s°, ноль на %s°"),
       width, spread_a, spread_b, shift);
  noInterrupts();
  current_step -= zero_at;   // сохранённый физический ноль относительно флажка
  target_step = current_step;
  interrupts();
  calib_state = CAL_GO_ZERO;
  startMotor(0, STEP_PERIOD_US, OPTO_WATCH_NONE);
}

void updateCalibration() {
  if (calib_state == CAL_IDLE) return;
  if ((uint32_t)(millis() - calib_started_ms) > CALIB_TIMEOUT_MS) {
    failCalibration(CAL_ERR_TIMEOUT);
    return;
  }
  noInterrupts();
  const bool event = opto_event;
  const int32_t event_step = opto_event_step;
  const bool busy = is_moving || pulse_high;
  opto_event = false;
  interrupts();
  if (!event && busy) return;

  // Порядок подходов: медленно справа налево, затем слева направо, и так
  // CALIB_SLOW_PASSES раз каждый. Между подходами колесо выходит из флажка
  // на сторону, откуда пришло, — следующий подход снова идёт от края.
  switch (calib_state) {
    case CAL_FAST_PLUS:
      if (event) {
        note(PSTR("Калибровка: датчик найден справа, уточняю кромки..."));
        calibrationStep(CAL_EXIT_PLUS, CALIB_MAX_FLAG_DEGREES, STEP_PERIOD_US, OPTO_WATCH_CLEAR);
      } else {
        note(PSTR("Калибровка: справа датчика нет, ищу влево на %d°..."),
             (int)(2.0f * CALIB_HALF_RANGE_DEG));
        calibrationStep(CAL_FAST_MINUS, -2.0f * CALIB_HALF_RANGE_DEG, STEP_PERIOD_US,
                        OPTO_WATCH_ACTIVE);
      }
      break;
    case CAL_FAST_MINUS:
      if (event) {
        note(PSTR("Калибровка: датчик найден слева, уточняю кромки..."));
        calibrationStep(CAL_EXIT_PLUS, CALIB_MAX_FLAG_DEGREES, STEP_PERIOD_US, OPTO_WATCH_CLEAR);
      } else {
        failCalibration(CAL_ERR_NOT_FOUND);
      }
      break;
    case CAL_EXIT_PLUS:
      if (event) {
        calibrationStep(CAL_CLEAR_PLUS, CALIB_CLEARANCE_DEGREES, STEP_PERIOD_US, OPTO_WATCH_NONE);
      } else {
        failCalibration(CAL_ERR_STUCK);
      }
      break;
    case CAL_CLEAR_PLUS:
      calibrationStep(CAL_SLOW_MINUS, -(CALIB_CLEARANCE_DEGREES + CALIB_SLOW_SEARCH_DEGREES),
                      CALIB_STEP_PERIOD_US, OPTO_WATCH_ACTIVE);
      break;
    case CAL_SLOW_MINUS:
      if (event && calib_plus_count < CALIB_SLOW_PASSES) {
        calib_edges_plus[calib_plus_count++] = event_step;
        note(PSTR("Калибровка: кромка справа найдена (подход %d из %d)"),
             (int)calib_plus_count, (int)CALIB_SLOW_PASSES);
        calibrationStep(CAL_EXIT_MINUS, -CALIB_MAX_FLAG_DEGREES, STEP_PERIOD_US, OPTO_WATCH_CLEAR);
      } else {
        failCalibration(CAL_ERR_EDGE);
      }
      break;
    case CAL_EXIT_MINUS:
      if (event) {
        calibrationStep(CAL_CLEAR_MINUS, -CALIB_CLEARANCE_DEGREES, STEP_PERIOD_US, OPTO_WATCH_NONE);
      } else {
        failCalibration(CAL_ERR_STUCK);
      }
      break;
    case CAL_CLEAR_MINUS:
      calibrationStep(CAL_SLOW_PLUS, CALIB_CLEARANCE_DEGREES + CALIB_SLOW_SEARCH_DEGREES,
                      CALIB_STEP_PERIOD_US, OPTO_WATCH_ACTIVE);
      break;
    case CAL_SLOW_PLUS:
      if (event && calib_minus_count < CALIB_SLOW_PASSES) {
        calib_edges_minus[calib_minus_count++] = event_step;
        note(PSTR("Калибровка: кромка слева найдена (подход %d из %d)"),
             (int)calib_minus_count, (int)CALIB_SLOW_PASSES);
        if (calibrationPassesDone() >= 2 * CALIB_SLOW_PASSES) {
          finishCalibrationEdges();
        } else {
          calibrationStep(CAL_EXIT_PLUS, CALIB_MAX_FLAG_DEGREES, STEP_PERIOD_US, OPTO_WATCH_CLEAR);
        }
      } else {
        failCalibration(CAL_ERR_EDGE);
      }
      break;
    case CAL_GO_ZERO:
      calib_state = CAL_IDLE;
      calib_error = CAL_OK;
      zero_set = true;
      home_source = HOME_OPTO;
      potCaptureZero();
      note(PSTR("Калибровка ЗАВЕРШЕНА! Точка 0 установлена по датчику."));
      break;
    default:
      failCalibration(CAL_ERR_ABORTED);
      break;
  }
}


// ---------------------------------------------------------------------------
// Качание (c), обычные повороты (d, h, w, g), ноль (z), стоп (s).
bool steeringAllowed() {
  if (full_zero_storage_fault) { note(PSTR("ОШИБКА EEPROM полного нуля")); return false; }
  if (drive_active) {
    note(PSTR("руль заблокирован: включена тяга — сначала b или s"));
    return false;
  }
  if (calib_state != CAL_IDLE) {
    note(PSTR("идёт калибровка — дождитесь конца или отправьте s"));
    return false;
  }
  if (pot_cal_state != POT_CAL_IDLE) {
    note(PSTR("идёт калибровка потенциометра — s для отмены"));
    return false;
  }
  return true;
}

void startPlainMove(int32_t target, bool report) {
  const int32_t limit = degreesToSteps(STEER_TRAVEL_LIMIT_DEG);
  const int32_t sensor_target = target + (home_source == HOME_OPTO ? full_zero_steps : 0);
  if (target > limit || target < -limit || sensor_target > limit || sensor_target < -limit) {
    char text[16];
    formatDegrees(target, text, sizeof(text));
    note(PSTR("цель %s° вне хода ±%d°"), text, (int)STEER_TRAVEL_LIMIT_DEG);
    return;
  }
  cycle_active = false;
  feedback_pending = potFeedbackAllowed();
  feedback_target_step = target;
  feedback_passes = 0;
  feedback_wait_ms = 0;
  // Намеренная команда задаёт угол, который держит удержание (ph), если оно
  // включено. Поправки доводки и удержания цель не переписывают.
  pot_hold_target_step = target;
  pot_hold_passes = 0;
  pot_hold_confirm_ms = 0;
  pot_hold_pause_until_ms = 0;   // новая команда снимает паузу серии подходов
  startMotor(target, STEP_PERIOD_US, OPTO_WATCH_NONE);
  resume_allowed = true;
  move_report_pending = report && motorBusy();
}

void startCycle(float degrees) {
  haltMotor();
  const int32_t start = stepNow();
  const int32_t delta = degreesToSteps(degrees);
  const int32_t limit = degreesToSteps(STEER_TRAVEL_LIMIT_DEG);
  const int32_t sensor_center = start + (home_source == HOME_OPTO ? full_zero_steps : 0);
  if (start + delta > limit || start - delta < -limit ||
      sensor_center + delta > limit || sensor_center - delta < -limit) {
    note(PSTR("качание %d° выходит за ход ±%d°"), (int)degrees, (int)STEER_TRAVEL_LIMIT_DEG);
    return;
  }
  cycle_start_step = start;
  cycle_end_step = start + delta;
  cycle_to_end = true;
  cycle_active = true;
  resume_allowed = false;
  move_report_pending = false;
  feedback_pending = false;
  startMotor(cycle_end_step, STEP_PERIOD_US, OPTO_WATCH_NONE);
  char text[16];
  formatFixed(lroundf(degrees * 100.0f), 2, text, sizeof(text));
  note(PSTR("ЦИКЛ качания на %s°"), text);
}

void stopCycle() {
  if (!cycle_active) {
    note(PSTR("Цикл и так выключен."));
    return;
  }
  cycle_active = false;
  haltMotor();
  noInterrupts();
  target_step = current_step;
  interrupts();
  char angle[16];
  formatDegrees(stepNow(), angle, sizeof(angle));
  note(PSTR("ЦИКЛ ВЫКЛ. Угол: %s°"), angle);
}

void updateCycle() {
  if (!cycle_active || motorBusy()) return;
  cycle_to_end = !cycle_to_end;
  startMotor(cycle_to_end ? cycle_end_step : cycle_start_step, STEP_PERIOD_US, OPTO_WATCH_NONE);
}

void updateMoveReport() {
  if (!move_report_pending || motorBusy()) return;
  move_report_pending = false;
  char angle[16];
  formatDegrees(stepNow(), angle, sizeof(angle));
  note(PSTR("Цель достигнута. Угол: %s°"), angle);
}

bool setZeroHere() {
  if (full_zero_storage_fault) { note(PSTR("ОШИБКА EEPROM полного нуля")); return false; }
  if (drive_active || calib_state != CAL_IDLE || pot_cal_state != POT_CAL_IDLE) {
    note(PSTR("ноль не задан: %s"),
         drive_active ? "включена тяга"
                      : (calib_state != CAL_IDLE ? "идёт калибровка" : "идёт калибровка потенциометра"));
    return false;
  }
  cycle_active = false;
  feedback_pending = false;
  stopPotHold();          // z задаёт новое начало отсчёта — держать старое нельзя
  haltMotor();
  noInterrupts();
  current_step = 0;
  target_step = 0;
  interrupts();
  pot_hold_target_step = 0;
  zero_set = true;
  home_source = HOME_MANUAL;
  calib_error = CAL_OK;
  resume_allowed = false;
  move_report_pending = false;
  potCaptureZero();
  note(PSTR("ОБНУЛЕНА. Ноль задан вручную в текущем положении."));
  return true;
}

// ---------------------------------------------------------------------------
// Выход на драйвер: аппаратный ШИМ (вход «P» на D3), DIR, BRAKE, STOP.
// Настроек нет — только константы железа (см. блок «тяга BLDC»).

// Зеркальное ли это колесо. FR и RR стоят на другой стороне корпуса, поэтому
// «вперёд» у них — противоположный уровень DIR. Имя колеса уже вписано в
// прошивку (MODULE_ID), так что определяется само, без настроек.
bool driveMirrorByModule() {
#if DRIVE_MIRRORED == 1
  return true;
#elif DRIVE_MIRRORED == 0
  return false;
#else
  return strcasecmp_P(MODULE_ID, PSTR("FR")) == 0 ||
         strcasecmp_P(MODULE_ID, PSTR("RR")) == 0;
#endif
}

// Уровень DIR для «вперёд» у этого колеса: у зеркального он перевёрнут.
uint8_t driveForwardLevel() {
  const bool flip = drive_mirrored;
  return flip ? (BLDC_DIR_FORWARD_LEVEL == HIGH ? LOW : HIGH) : BLDC_DIR_FORWARD_LEVEL;
}

// Библиотека Servo даёт на D3 сигнал около 50 Гц; драйвер использует его
// скважность. Выбранное значение передаётся в write() без пересчёта.
Servo drive_servo;

void setupDriveServo() {
  drive_mirrored = driveMirrorByModule();
  drive_servo.attach(BLDC_SPEED_PIN);   // «P» драйвера, D3
  drive_servo.write(0);                 // ещё есть импульсы; выходы отключены отдельно
  drive_servo_value = 0;
}

// Значение Servo.write, а не скважность на P и не фактические обороты.
void driveWriteServo(uint8_t value) {
  if (value > DRIVE_SERVO_MAX_VALUE) value = DRIVE_SERVO_MAX_VALUE;
  drive_servo.write(value);
  drive_servo_value = value;
}

// Процент команды → значение шкалы Servo: 1 % = 1,8, 100 % = 180.
uint8_t driveValueForPercent(int8_t percent) {
  const uint32_t magnitude = (uint32_t)abs((int)percent);
  uint32_t value = (magnitude * DRIVE_SERVO_TENTHS_PER_PERCENT + 5) / 10;
  if (value > DRIVE_SERVO_MAX_VALUE) value = DRIVE_SERVO_MAX_VALUE;
  return (uint8_t)value;
}

// Значение шкалы в промилле — для телеметрии (duty=) и журнала.
uint16_t driveValuePermille() {
  return (uint16_t)((uint32_t)drive_servo_value * 1000UL / DRIVE_SERVO_MAX_VALUE);
}

// Тормоз: BRAKE = 1 включает тормоз драйвера, 0 — отпускает.
void driveSetBrake(bool active) {
  digitalWrite(BLDC_BRAKE_PIN, active ? BLDC_BRAKE_ACTIVE_LEVEL
                                      : (BLDC_BRAKE_ACTIVE_LEVEL == HIGH ? LOW : HIGH));
}

// STOP драйвера: 1 — выходы разрешены, 0 — выключены (свободный выбег).
// Пока тяги нет (старт платы, «b», watchdog), драйвер выключен.
void driveSetStop(bool stopped) {
  digitalWrite(BLDC_STOP_PIN, stopped ? BLDC_STOP_DISABLE_LEVEL
                                      : BLDC_STOP_ENABLE_LEVEL);
}

void printDriveInfo() {
  // Строка должна влезть в буфер строки (176 байт с кириллицей по 2 байта):
  // поэтому проценты словами, без «%%» — они и так висят на экране.
  note(PSTR("Двигатель: Servo D3 50 Гц · значение %u из %u · тяга до %u %% · %s"),
       (unsigned)drive_servo_value, (unsigned)DRIVE_SERVO_MAX_VALUE,
       (unsigned)DRIVE_MAX_PERCENT, drive_mirrored ? "зеркальное" : "прямое");
  note(PSTR("SC D19: %lu.%lu об/мин · %u переходов/с (только показ)"),
       (unsigned long)(tach_display_rpm_x10 / 10), (unsigned long)(tach_display_rpm_x10 % 10),
       (unsigned)tach_display_hz);
}

// ---------------------------------------------------------------------------
// Тяга BLDC: только при заданном нуле и стоящем руле, с watchdog 650 мс.
bool localDriveAllowed() {
  // A stopped step motor can still be waiting for potentiometer correction.
  // Do not start percentage traction until that automatic steering is done.
  return !full_zero_storage_fault && zero_set && !motorBusy() && !feedback_pending && calib_state == CAL_IDLE &&
         pot_cal_state == POT_CAL_IDLE && !cycle_active;
}

void applyDriveCommand(int8_t percent) {
  // Процент > 0 — вперёд: DIR в «своём» уровне колеса (у зеркального FR/RR он
  // перевёрнут). Процент < 0 — назад: противоположный уровень.
  const bool forward = percent >= 0;
  const uint8_t ahead = driveForwardLevel();
  const uint8_t direction = forward ? ahead : (ahead == HIGH ? LOW : HIGH);
  const bool reversing = drive_active && ((percent > 0) != (drive_percent > 0));
  if (!drive_active || reversing) {
    // Сначала снимаем тягу и тормозим, потом меняем DIR — иначе смена
    // направления приходится на вращающийся мотор (у драйвера это рывок).
    driveWriteServo(0);
    driveSetBrake(true);
    driveSetStop(true);
    digitalWrite(BLDC_DIR_PIN, direction);
    delayMicroseconds(100);
  }
  digitalWrite(BLDC_DIR_PIN, direction);
  driveSetBrake(false);                       // тормоз отпущен
  driveSetStop(false);                        // драйвер разрешён на время тяги
  // Как в проверенном скетче: значение на «P» пишется сразу, без разгона и без
  // контура. Плавность набора даёт сам драйвер — ему этот вход привычен.
  driveWriteServo(driveValueForPercent(percent));
  drive_percent = percent;
  drive_active = percent != 0;
  brake_id = 0;
  last_drive_command_ms = millis();
  if (!drive_active) {                // «t 0» — сразу снять тягу и затормозить
    driveSetBrake(true);
    driveSetStop(true);
  }
}

void stopDriveLocal() {
  // STOP, b, старый n, watchdog 650 мс и E-STOP сервера гасят активное
  // удержание угла: оно не отдельный путь движения, а тот же startMotor().
  stopPotHold();
  // In live mode STOP/watchdog must also cancel a steering move; a delayed
  // heartbeat from that session must not restart either actuator.
  if (live_id != 0) {
    haltMotor();
    feedback_pending = false;
    move_report_pending = false;
    resume_allowed = false;
  }
  live_id = 0;
  live_seq = 0;
  driveWriteServo(0);                // Servo продолжает давать короткий импульс
  driveSetBrake(true);               // тормоз: колесо не катится
  driveSetStop(true);                // выходы драйвера выключены
  drive_percent = 0;
  drive_active = false;
  neutral_active = false;
  neutral_id = 0;
  brake_id = 0;
  brake_id_ms = 0;
}

// v: число ползунка без пересчёта идёт в Servo.write на D3. Направление
// задаётся отдельно через DIR; ноль руля и тахометр в этом режиме не участвуют.
void applyDirectDrive(uint8_t value, bool forward) {
  if (value == 0 || full_zero_storage_fault) {
    stopDriveLocal();
    return;
  }
  const uint8_t ahead = driveForwardLevel();
  const uint8_t direction = forward ? ahead : (ahead == HIGH ? LOW : HIGH);
  if (drive_active && digitalRead(BLDC_DIR_PIN) != direction) {
    // Прежде чем менять DIR, снять предыдущее значение и включить тормоз.
    driveWriteServo(0);
    driveSetBrake(true);
    driveSetStop(true);
    delayMicroseconds(100);
  }
  digitalWrite(BLDC_DIR_PIN, direction);
  driveSetBrake(false);
  driveSetStop(false);
  driveWriteServo(value);
  // Старое поле телеметрии: только индикация, не участвует в Servo.write.
  drive_percent = (int8_t)(((uint16_t)value * 100U + 90U) / 180U);
  if (!forward) drive_percent = -drive_percent;
  drive_active = true;
  brake_id = 0;
  last_drive_command_ms = millis();
}

bool applyLocalDrive(int8_t percent) {
  if (percent == 0) {
    stopDriveLocal();
    return true;
  }
  if (abs((int)percent) > (int)DRIVE_MAX_PERCENT || !localDriveAllowed() ||
      (drive_active && ((percent > 0) != (drive_percent > 0)))) {
    stopDriveLocal();
    return false;
  }
  applyDriveCommand(percent);
  return true;
}

void updateDriveWatchdog() {
  if ((drive_active || neutral_active) &&
      (uint32_t)(millis() - last_drive_command_ms) > DRIVE_COMMAND_TIMEOUT_MS) {
    stopDriveLocal();
    note(PSTR("нет команды дольше 650 мс — выходы выключены, тормоз"));
  }
}

// ---------------------------------------------------------------------------
uint16_t moduleStatus() {
  uint16_t status = STATUS_V2;
  // Between correction passes the motor is temporarily still, but steering
  // may resume automatically. The server must not treat that pause as arrival.
  if (motorBusy() || feedback_pending) status |= STATUS_MOVING;
  if (zero_set) status |= STATUS_ZERO;
  if (calib_state != CAL_IDLE || pot_cal_state != POT_CAL_IDLE) status |= STATUS_CALIB;
  if (optoActive()) status |= STATUS_OPTO;
  if (cycle_active) status |= STATUS_CYCLE;
  if (zero_set && home_source == HOME_OPTO) status |= STATUS_HOME_OPTO;
  if (potFeedbackAllowed()) status |= STATUS_POT;
  if (pot_hold) status |= STATUS_POT_HOLD;   // fw24: активное удержание угла
  status |= STATUS_POT_MODE_SUPPORTED;  // поддержка переключения режима
  if (pot_enabled) status |= STATUS_POT_MODE;
  if (full_zero_storage_fault) status |= STATUS_FULL_ZERO_FAULT;
  status |= (uint16_t)(calib_error & 0x0F) << 8;
  return status;
}

void printModuleStatus() {
  char current[16];
  char target[16];
  formatDegrees(stepNow(), current, sizeof(current));
  formatDegrees(targetNow(), target, sizeof(target));
  const char* zero = !zero_set ? "не задан" : (home_source == HOME_OPTO ? "по датчику" : "вручную");
  const char* state = calib_state != CAL_IDLE ? "КАЛИБРОВКА" : (cycle_active ? "ЦИКЛ" : (motorBusy() ? "ДВИЖ" : "СТОИТ"));
  note(PSTR("Текущий: %s° | Целевой: %s° [%s] · ноль %s · датчик %s · тяга %d%%"),
       current, target, state, zero, optoActive() ? "закрыт" : "свободен", (int)drive_percent);
  potPrintStatus();
  potPrintHoldStatus();
  printDriveInfo();
}

// Команды одного рулевого модуля (проверенный скетч). Плата принимает их со
// своего USB — сервер шлёт адресную команду на порт нужного колеса, а любую
// плату можно проверить на столе отдельно от остальных.
//   k | calib      калибровка по оптодатчику
//   q              калибровка потенциометра A0: 0°, −60°, +60° (доводка по датчику)
//   ph 0|1         активное удержание угла по потенциометру (после старта — 0)
//   pm 0|1         режим потенциометра (сбрасывает калибровку q)
//   z | zero       ноль в текущем положении (вручную)
//   h              в ноль           s   стоп всего (руль, калибровка, цикл, тяга)
//   g              продолжить поворот, прерванный s
//   d <°> f|b      повернуть на угол: f — вправо (+), b — влево (−)
//   c <°> | c c    качание на угол / выключить качание
//   w <°>          абсолютный угол (нужен ноль, предел ±90°) — команда сервера
//   v <0…150>      прямое значение Servo.write с бортового экрана
//   t <%> | b      прежняя команда тяги / тормоз
//   b <id>         подтверждённый тормоз; старый n — только торможение
//   p              состояние
void stopEverything(bool quiet) {
  const bool cycling = cycle_active;
  const bool pot_cal = pot_cal_state != POT_CAL_IDLE;
  if (calib_state != CAL_IDLE) failCalibration(CAL_ERR_ABORTED);
  cycle_active = false;
  haltMotor();
  stopPotHold();          // s выключает активное удержание так же, как доводку
  stopDriveLocal();
  move_report_pending = false;
  feedback_pending = false;
  if (pot_cal) {
    pot_cal_state = POT_CAL_IDLE;
    note(PSTR("калибровка потенциометра прервана"));
  }
  if (cycling) resume_allowed = false;
  if (!quiet) {
    char angle[16];
    formatDegrees(stepNow(), angle, sizeof(angle));
    note(PSTR("ПАУЗА. Угол: %s° (руль стоит, тяга выключена)"), angle);
  }
}

// status: 1 = preflight ready, 2 = committed and read back; 3 = not optical,
// 4 = busy/SC/neutral, 5 = outside ±20°, 6 = storage error. All responses are
// CRC-protected and carry both persisted and proposed offsets in motor steps.
void handleFullZeroRequest(uint32_t id, bool commit) {
  if (id == zero_reply_id && zero_reply_operation == (commit ? 2 : 1)) {
    zero_reply_started = millis();  // повтор ACK, без повторной записи
    return;
  }
  zero_reply_id = id;
  zero_reply_operation = commit ? 2 : 1;
  zero_reply_started = millis();
  zero_reply_last = 0;
  zero_reply_proposed = full_zero_steps + stepNow();
  const int32_t limit = degreesToSteps(FULL_ZERO_MAX_OFFSET_DEG);
  if (full_zero_storage_fault) zero_reply_status = 6;
  else if (!zero_set || home_source != HOME_OPTO) zero_reply_status = 3;
  else if (drive_active || drive_percent || neutral_inhibit || live_id ||
           calib_state != CAL_IDLE || pot_cal_state != POT_CAL_IDLE || cycle_active ||
           motorBusy() || feedback_pending || tachMotionRecent() || tach_display_rpm_x10 > 10)
    zero_reply_status = 4;
  else if (zero_reply_proposed < -limit || zero_reply_proposed > limit) zero_reply_status = 5;
  else if (!commit) zero_reply_status = 1;
  else if (!persistFullZero(zero_reply_proposed)) {
    full_zero_storage_fault = true; // block all traction until service/reboot
    zero_reply_status = 6;
  } else {
    // Новая система координат сразу действует для w/j/манёвров/всех режимов.
    noInterrupts();
    current_step = 0;
    target_step = 0;
    interrupts();
    potCaptureZero();
    zero_reply_status = 2;
    note(PSTR("Полный ноль сохранён в EEPROM"));
  }
}

void handleModuleCommand(char* line) {
  char* save = nullptr;
  char* command = strtok_r(line, " \t", &save);
  if (!command) return;
  char* arg1 = strtok_r(nullptr, " \t", &save);
  char* arg2 = strtok_r(nullptr, " \t", &save);
  char* extra = strtok_r(nullptr, " \t", &save);

  // На нейтрали запрещены даже прямые команды Servo и руления. Нулевые
  // команды остаются аварийным тормозом; STOP/b всегда имеют приоритет.
  if (neutral_inhibit && strcasecmp_P(command, PSTR("n")) != 0 &&
      strcasecmp_P(command, PSTR("b")) != 0 &&
      strcasecmp_P(command, PSTR("s")) != 0 &&
      strcasecmp_P(command, PSTR("p")) != 0) {
    long value = -1;
    if ((strcasecmp_P(command, PSTR("t")) == 0 || strcasecmp_P(command, PSTR("v")) == 0) &&
        arg1 && parseLongToken(arg1, &value) && value == 0) stopDriveLocal();
    return;
  }

  // No old-style command may take over a live session. STOP still wins; a
  // fresh tagged brake is needed before another controller can start.
  if (live_id != 0 && strcasecmp_P(command, PSTR("j")) != 0 &&
      strcasecmp_P(command, PSTR("b")) != 0 &&
      strcasecmp_P(command, PSTR("s")) != 0 &&
      strcasecmp_P(command, PSTR("p")) != 0) {
    stopDriveLocal();
    return;
  }

  if (strcasecmp_P(command, PSTR("zr")) == 0) {
    stopPotHold();          // сервисная правка нуля: держать прежний угол нельзя
    // Явное сервисное восстановление только после повреждения памяти/смены
    // роли, на неподвижной плате без нуля. Не принимать случайную команду.
    if (!arg1 || strcmp(arg1, "CONFIRM") || arg2 || extra || !full_zero_storage_fault ||
        zero_set || drive_active || drive_percent || motorBusy() || feedback_pending ||
        calib_state != CAL_IDLE || pot_cal_state != POT_CAL_IDLE || cycle_active ||
        tachMotionRecent() || tach_display_rpm_x10 > 10) return;
    for (uint8_t slot = 0; slot < 2; ++slot)
      for (uint8_t i = 0; i < EEPROM_ZERO_RECORD_SIZE; ++i)
        eeprom_update_byte((uint8_t*)(uintptr_t)(EEPROM_ZERO_SLOTS[slot] + i), 0);
    loadFullZero();
    note(full_zero_storage_fault ? PSTR("ОШИБКА: EEPROM полного нуля не очищена") :
                                  PSTR("Повреждённая память полного нуля очищена; выполните k и настройку заново"));
  } else if (strcasecmp_P(command, PSTR("zq")) == 0 || strcasecmp_P(command, PSTR("zc")) == 0) {
    stopPotHold();          // поправка полного нуля меняет отсчёт шагов
    long id = 0;
    if (!arg1 || arg2 || extra || !parseLongToken(arg1, &id) || id <= 0 || id >= 2147483647L) return;
    handleFullZeroRequest((uint32_t)id, strcasecmp_P(command, PSTR("zc")) == 0);
  } else if (strcasecmp_P(command, PSTR("k")) == 0 || strcasecmp_P(command, PSTR("calib")) == 0) {
    startCalibration();
  } else if (strcasecmp_P(command, PSTR("pm")) == 0) {
    if (!arg1 || arg2 || (strcmp(arg1, "0") && strcmp(arg1, "1"))) {
      note(PSTR("Шаблон: pm 0|1")); return;
    }
    if (motorBusy() || drive_percent != 0 || calib_state != CAL_IDLE ||
        pot_cal_state != POT_CAL_IDLE || cycle_active) {
      note(PSTR("Смена режима: сначала s")); return;
    }
    const bool enabled = arg1[0] == '1';
    if (enabled != pot_enabled) {
      stopPotHold();          // смена режима сбрасывает калибровку — и удержание
      pot_enabled = enabled;
      pot_calibrated = false;
      pot_zero_valid = false;
      pot_sampled = false;
      feedback_pending = false;
      resume_allowed = false;
      if (enabled) potMeasureRaw();  // ноль АЦП измерит q в положении 0°
    }
    note(pot_enabled ? PSTR("С потенциометром: q для доводки") : PSTR("Без потенциометра: угол по шагам"));
  } else if (strcasecmp_P(command, PSTR("ph")) == 0) {
    // Активное удержание угла (fw24). Отдельная команда, потому что pm
    // сбрасывает калибровку: частый переключатель «доводка вкл/выкл» так
    // непригоден. Условия те же, что у pm: не busy и не на ходу.
    if (!arg1 || arg2 || (strcmp(arg1, "0") && strcmp(arg1, "1"))) {
      note(PSTR("Шаблон: ph 0|1")); return;
    }
    // Выключение не ждёт «сначала s»: пока удержание само подтягивает угол,
    // плата занята, и запрет оставил бы оператора без выключателя.
    if (arg1[0] == '0') {
      if (pot_hold) {
        stopPotHold();
        note(PSTR("Удержание выключено"));
      } else {
        note(PSTR("Удержание и так выключено"));
      }
      return;
    }
    if (motorBusy() || drive_percent != 0 || calib_state != CAL_IDLE ||
        pot_cal_state != POT_CAL_IDLE || cycle_active) {
      note(PSTR("Удержание: сначала s — идёт движение или калибровка")); return;
    }
    startPotHold();            // отказ печатает причину, калибровку не трогает
  } else if (strcasecmp_P(command, PSTR("q")) == 0) {
    startPotCalibration();
  } else if (strcasecmp_P(command, PSTR("s")) == 0) {
    // The computer can omit the redundant human-readable pause message;
    // regular 's' keeps its existing monitor output and identical STOP action.
    const bool quiet = arg1 && !arg2 && !extra && strcmp(arg1, "q") == 0;
    stopEverything(quiet);
  } else if (strcasecmp_P(command, PSTR("z")) == 0 || strcasecmp_P(command, PSTR("zero")) == 0) {
    setZeroHere();
  } else if (strcasecmp_P(command, PSTR("h")) == 0) {
    if (!steeringAllowed()) return;
    if (stepNow() == 0 && !motorBusy()) {
      note(PSTR("Уже в 0°."));
      return;
    }
    if (!zero_set) note(PSTR("ноль не задан — еду в положение включения (k — калибровка по датчику)"));
    note(PSTR("Домой: %s..."), stepNow() < 0 ? "ВПЕРЕД" : "НАЗАД");
    startPlainMove(0, true);
  } else if (strcasecmp_P(command, PSTR("g")) == 0) {
    if (!steeringAllowed()) return;
    if (!resume_allowed || motorBusy() || targetNow() == stepNow()) {
      note(PSTR("Уже в цели."));
      return;
    }
    note(PSTR("ПРОДОЛЖЕНИЕ..."));
    startPlainMove(targetNow(), true);
  } else if (strcasecmp_P(command, PSTR("d")) == 0) {
    float degrees = 0.0f;
    if (!arg1 || !arg2 || extra) {
      note(PSTR("Шаблон: d [градусы] [f/b]"));
      return;
    }
    if (!parseFloatToken(arg1, &degrees) || degrees <= 0.0f) {
      note(PSTR("Ошибка: Угол > 0!"));
      return;
    }
    if (degrees > MANUAL_MOVE_LIMIT_DEG) {
      note(PSTR("Ошибка: не больше 360° за одну команду"));
      return;
    }
    const char direction = (char)tolower((unsigned char)arg2[0]);
    if (direction != 'f' && direction != 'b') {
      note(PSTR("Ошибка направления! f или b"));
      return;
    }
    if (!steeringAllowed()) return;
    haltMotor();
    const int32_t steps = degreesToSteps(degrees);
    char text[16];
    formatFixed(lroundf(degrees * 100.0f), 2, text, sizeof(text));
    note(direction == 'f' ? PSTR("ВПЕРЕД (F) на %s°") : PSTR("НАЗАД (B) на %s°"), text);
    startPlainMove(stepNow() + (direction == 'f' ? steps : -steps), true);
  } else if (strcasecmp_P(command, PSTR("c")) == 0) {
    if (!arg1 || arg2) {
      note(PSTR("Шаблон: c [градусы] или c c"));
      return;
    }
    if (strcasecmp_P(arg1, PSTR("c")) == 0) {
      stopCycle();
      return;
    }
    float degrees = 0.0f;
    if (!parseFloatToken(arg1, &degrees) || degrees <= 0.0f) {
      note(PSTR("Ошибка: Угол > 0!"));
      return;
    }
    if (degrees > MANUAL_MOVE_LIMIT_DEG) {
      note(PSTR("Ошибка: не больше 360° за одну команду"));
      return;
    }
    if (!steeringAllowed()) return;
    startCycle(degrees);
  } else if (strcasecmp_P(command, PSTR("w")) == 0) {
    float degrees = 0.0f;
    if (!arg1 || arg2) {
      note(PSTR("Шаблон: w [градусы]"));
      return;
    }
    if (strcasecmp_P(arg1, PSTR("zero")) == 0) {
      setZeroHere();
      return;
    }
    if (strcasecmp_P(arg1, PSTR("calib")) == 0) {
      startCalibration();
      return;
    }
    if (!parseFloatToken(arg1, &degrees) || fabsf(degrees) > STEER_LIMIT_DEG) {
      note(PSTR("w: угол вне ±%d°"), (int)STEER_LIMIT_DEG);
      return;
    }
    if (!zero_set) {
      note(PSTR("w: ноль не задан — сначала k (по датчику) или z"));
      return;
    }
    if (!steeringAllowed()) return;
    startPlainMove(degreesToSteps(degrees), false);
  } else if (strcasecmp_P(command, PSTR("j")) == 0) {
    // j <brake-id> <sequence> <percent> <absolute-angle>
    // A live session can only start at rest, at the already-confirmed angle.
    // After that, its own monotonic heartbeats may move the steering while
    // traction continues. STOP/watchdog invalidate the ID and halt both.
    char* angle_token = strtok_r(nullptr, " \t", &save);
    char* trailing = strtok_r(nullptr, " \t", &save);
    long requested_id = 0, requested_seq = 0, percent = 0;
    float degrees = 0.0f;
    if (!arg1 || !arg2 || !extra || !angle_token || trailing ||
        !parseLongToken(arg1, &requested_id) || requested_id <= 0 || requested_id >= 2147483647L ||
        !parseLongToken(arg2, &requested_seq) || requested_seq <= 0 || requested_seq >= 2147483647L ||
        !parseLongToken(extra, &percent) || percent == 0 ||
        percent < -(long)DRIVE_MAX_PERCENT || percent > (long)DRIVE_MAX_PERCENT ||
        !parseFloatToken(angle_token, &degrees) || fabsf(degrees) > STEER_LIMIT_DEG ||
        full_zero_storage_fault || !zero_set || calib_state != CAL_IDLE || pot_cal_state != POT_CAL_IDLE || cycle_active) {
      stopDriveLocal();
      return;
    }
    const int32_t target = degreesToSteps(degrees);
    if (live_id == 0) {
      if (brake_id != (uint32_t)requested_id ||
          (uint32_t)(millis() - brake_id_ms) > LIVE_START_TIMEOUT_MS ||
          drive_active || motorBusy() || feedback_pending ||
          tach_display_rpm_x10 > 10 || tachMotionRecent() ||
          labs(target - stepNow()) > degreesToSteps(1.5f)) {
        stopDriveLocal();
        return;
      }
      live_id = (uint32_t)requested_id;
      // The already-confirmed angle may differ by less than 1.5°. Do not
      // unexpectedly start a correction on the very first traction packet.
      live_target_step = target;
    } else {
      if (live_id != (uint32_t)requested_id ||
          (uint32_t)(millis() - last_drive_command_ms) > DRIVE_COMMAND_TIMEOUT_MS ||
          !drive_active || ((percent > 0) != (drive_percent > 0))) {
        stopDriveLocal();
        return;
      }
      if ((uint32_t)requested_seq <= live_seq) return;  // never refresh a stale packet
    }
    if (target != live_target_step) {
      live_target_step = target;
      startPlainMove(target, false);
    }
    live_seq = (uint32_t)requested_seq;
    applyDriveCommand((int8_t)percent);
  } else if (strcasecmp_P(command, PSTR("t")) == 0) {
    long percent = 0;
    if (!arg1 || arg2 || !parseLongToken(arg1, &percent) ||
        percent < -(long)DRIVE_MAX_PERCENT || percent > (long)DRIVE_MAX_PERCENT) {
      stopDriveLocal();
      return;
    }
    applyLocalDrive((int8_t)percent);
  } else if (strcasecmp_P(command, PSTR("v")) == 0) {
    long value = 0;
    const bool forward = !arg2 || strcasecmp_P(arg2, PSTR("f")) == 0;
    const bool backward = arg2 && strcasecmp_P(arg2, PSTR("b")) == 0;
    if (!arg1 || extra || !parseLongToken(arg1, &value) ||
        value < 0 || value > (long)DRIVE_DIRECT_MAX_VALUE || (!forward && !backward)) {
      stopDriveLocal();
      return;
    }
    applyDirectDrive((uint8_t)value, forward);
  } else if (strcasecmp_P(command, PSTR("n")) == 0) {
    // Legacy freewheel requests, including delayed heartbeats, must never
    // release the brake. Treat any form of n as a best-effort STOP instead.
    stopDriveLocal();
  } else if (strcasecmp_P(command, PSTR("b")) == 0) {
    stopDriveLocal();
    // Только после применения тормоза подтверждаем точный идентификатор b.
    // Обычный b остаётся совместимым и сбрасывает прежнее подтверждение.
    long requested_id = 0;
    // Exclude LONG_MAX: strtol may return it for an overflowing token.
    brake_id = (arg1 && !arg2 && !extra && parseLongToken(arg1, &requested_id) &&
                requested_id > 0 && requested_id < 2147483647L) ? (uint32_t)requested_id : 0;
    if (brake_id != 0) neutral_inhibit = false;
    brake_id_ms = millis();
  } else if (strcasecmp_P(command, PSTR("p")) == 0) {
    printModuleStatus();
  } else {
    note(PSTR("Неизв. команда: %s"), command);
  }
}

void steeringSetup() {
  // Сначала безопасные уровни в выходных регистрах, потом включаем выходы:
  // при старте нет ни тяги, ни лишнего шага, драйвер выключен, тормоз взведён.
  digitalWrite(BLDC_SPEED_PIN, LOW);
  digitalWrite(BLDC_DIR_PIN, BLDC_DIR_FORWARD_LEVEL);
  digitalWrite(BLDC_BRAKE_PIN, BLDC_BRAKE_ACTIVE_LEVEL);
  digitalWrite(BLDC_STOP_PIN, BLDC_STOP_DISABLE_LEVEL);
  pinMode(BLDC_DIR_PIN, OUTPUT);
  pinMode(BLDC_BRAKE_PIN, OUTPUT);
  pinMode(BLDC_STOP_PIN, OUTPUT);
  // Servo работает с 0, а BRAKE/STOP отдельно держат выходы выключенными.
  setupDriveServo();
  driveSetBrake(true);
  driveSetStop(true);

  pinMode(OPTO_PIN, INPUT_PULLUP);
  pinMode(TACH_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(TACH_PIN), tachometerISR, CHANGE);
  tach_last_sample_ms = millis();
  pinMode(POT_PIN, INPUT);          // без подтяжки: потенциометр — делитель 5 В/GND
  analogReference(DEFAULT);         // опора АЦП = 5 В платы, как питание потенциометра
  digitalWrite(STEP_PUL_PIN, LOW);
  digitalWrite(STEP_DIR_PIN, STEP_DIR_PLUS_LEVEL);
  digitalWrite(STEP_ENA_PIN, STEP_ENABLE_LEVEL);  // как в проверенном скетче: сразу HIGH
  pinMode(STEP_PUL_PIN, OUTPUT);
  pinMode(STEP_DIR_PIN, OUTPUT);
  pinMode(STEP_ENA_PIN, OUTPUT);

  setupStepTimer();
  loadFullZero();
  last_drive_command_ms = millis();
  last_pot_sample_ms = millis();
}

void steeringLoop() {
  updateDriveWatchdog();
  updatePot();
  updateTachDisplay();  // только телеметрия, не управление тягой

  updateCalibration();
  updatePotCalibration();
  updateCycle();
  updateMoveReport();
  updateFeedback();
  updatePotHold();   // активное удержание угла (ph), только после доводки
  txPump();
}
// ============================ STEERING CORE END ============================

// ==================== USB: команды и телеметрия колеса =====================
// Каждое колесо — своя плата со своим USB: сервер открывает все четыре порта,
// использует только вручную выбранный USB-порт. Здесь же
// страховка прошивки: команда с именем чужого колеса не выполняется.
char serial_line[48];
uint8_t serial_length = 0;
bool serial_overflow = false;
uint32_t serial_last_char_ms = 0;
// Обрывок строки без \n дольше секунды — мусор (наводка, сброс порта, эхо):
// выбрасываем, иначе он склеится со следующей командой и «съест» её.
const uint16_t SERIAL_LINE_TIMEOUT_MS = 1000;
// Compact frames carry ALL control/safety fields; the full text frame remains
// available to older servers and serial monitors. At the worst permitted rate,
// 160/20 ms + 384/200 ms = 9920 bytes/s, below 115200-baud 8N1 payload capacity
// (11520 bytes/s), leaving headroom for occasional human-readable messages.
const uint16_t FAST_TELEMETRY_PERIOD_MS = 30;
const uint16_t FAST_TELEMETRY_MIN_SPACING_MS = 20;
const uint16_t FULL_TELEMETRY_PERIOD_MS = 200;
const uint16_t FAST_TELEMETRY_LINE_CAPACITY = 160;
const uint16_t TELEMETRY_LINE_CAPACITY = 384;
static_assert(TX_BUFFER_SIZE >= TELEMETRY_LINE_CAPACITY, "TX buffer too small for telemetry");
uint32_t last_telemetry_ms = 0;
uint32_t last_fast_telemetry_ms = 0;
bool telemetry_urgent = false;
bool last_steering_busy = false;
bool last_sc_recent = false;
uint32_t last_sc_recent_check_ms = 0;

// Имя модуля в команде «w <имя> …»: своё колесо, ALL, чужое колесо или не имя.
const uint8_t MOD_UNKNOWN = 0;
const uint8_t MOD_MINE = 1;
const uint8_t MOD_OTHER = 2;
const uint8_t MOD_ALL = 3;

uint8_t classifyModuleToken(const char* token) {
  if (!token) return MOD_UNKNOWN;
  if (strcasecmp_P(token, PSTR(MODULE_ID)) == 0) return MOD_MINE;
  if (strcasecmp_P(token, PSTR("ALL")) == 0) return MOD_ALL;
  if (strcasecmp_P(token, PSTR("FL")) == 0 || strcasecmp_P(token, PSTR("FR")) == 0 ||
      strcasecmp_P(token, PSTR("RL")) == 0 || strcasecmp_P(token, PSTR("RR")) == 0) {
    return MOD_OTHER;
  }
  return MOD_UNKNOWN;
}

void printHelp() {
  note(PSTR("команды: k, q, ph 1|0, c [°], c c, d [°] [f/b], h, s, g, z, p, ?"));
  note(PSTR("поворот: w [FL] 12.5 | w zero | w calib · тяга: v [FL] 0…%u [f/b], b"),
       (unsigned)DRIVE_DIRECT_MAX_VALUE);
  note(PSTR("удержание угла: ph 1 — включить, ph 0 — выключить (нужны pm 1 и q)"));
  note(PSTR("Servo D3; SC D19: %u переходов/об, счётчик без направления"), (unsigned)TACH_EDGES_PER_REV);
}

// CRC-16/Modbus, computed over the exact ASCII payload before the CRC field.
// CRC detects line corruption; it is not authentication or a physical E-STOP.
uint16_t telemetryCrc16(const char* data, uint16_t size) {
  uint16_t crc = 0xFFFF;
  for (uint16_t i = 0; i < size; ++i) {
    crc ^= (uint8_t)data[i];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      crc = (crc & 1) ? (crc >> 1) ^ 0xA001U : crc >> 1;
    }
  }
  return crc;
}

bool appendCheckedFrame(char* line, uint16_t capacity, int length, bool full) {
  if (length <= 0 || length >= (int)capacity) return false;
  const uint16_t crc = telemetryCrc16(line, (uint16_t)length);
  const int tail = full
      ? snprintf_P(line + length, capacity - (uint16_t)length, PSTR(" crc=%04X\r\n"), (unsigned)crc)
      : snprintf_P(line + length, capacity - (uint16_t)length, PSTR(" %04X\r\n"), (unsigned)crc);
  if (tail <= 0 || tail >= (int)(capacity - (uint16_t)length)) return false;
  txAppend(line, (uint16_t)(length + tail));
  return true;
}

// Numeric role in the CRC-protected compact frame. An invalid MODULE_ID is 0
// and the server refuses to identify the board; never guess from a USB port.
uint8_t wheelIdentityCode() {
  if (strcasecmp_P(MODULE_ID, PSTR("FL")) == 0) return 1;
  if (strcasecmp_P(MODULE_ID, PSTR("FR")) == 0) return 2;
  if (strcasecmp_P(MODULE_ID, PSTR("RL")) == 0) return 3;
  if (strcasecmp_P(MODULE_ID, PSTR("RR")) == 0) return 4;
  return 0;
}

// @Z is emitted separately, not spliced into a newer fast safety snapshot.
// It is repeated only briefly; after reboot request IDs are forgotten.
bool appendFullZeroReply() {
  char line[96];
  const int n = snprintf_P(line, sizeof(line), PSTR("@Z %u %u %lu %u %ld %ld"),
      (unsigned)FIRMWARE_PROTOCOL, (unsigned)wheelIdentityCode(), (unsigned long)zero_reply_id,
      (unsigned)zero_reply_status, (long)full_zero_steps, (long)zero_reply_proposed);
  return appendCheckedFrame(line, sizeof(line), n, false);
}

// The compact record contains the same safety and diagnostic state as @TLM;
// no acknowledgement is combined with an older steering/SC snapshot.
bool appendFastTelemetry() {
  const uint16_t status = moduleStatus();
  const long deg_c = lroundf((float)stepNow() * 100.0f / STEPS_PER_DEGREE);
  const long tgt_c = lroundf((float)targetNow() * 100.0f / STEPS_PER_DEGREE);
  const uint8_t saved_sreg = SREG;
  cli();
  const uint32_t edges = tach_edges_total;
  SREG = saved_sreg;
  char line[FAST_TELEMETRY_LINE_CAPACITY];
  const int n = snprintf_P(line, sizeof(line),
      PSTR("@F %u %u %ld %ld %u %d %u %u %lu %u %u %lu %u %lu %lu %u %lu %lu %lu"),
      (unsigned)FIRMWARE_PROTOCOL, (unsigned)wheelIdentityCode(), deg_c, tgt_c, (unsigned)status, (int)drive_percent,
      (unsigned)DRIVE_MAX_PERCENT, (unsigned)drive_servo_value, (unsigned long)tach_display_rpm_x10,
      (unsigned)tach_display_hz, (unsigned)TACH_EDGES_PER_REV, (unsigned long)edges,
      (unsigned)tachMotionRecent(), (unsigned long)brake_id, (unsigned long)neutral_id,
      (unsigned)neutral_inhibit, (unsigned long)live_id, (unsigned long)live_seq,
      (unsigned long)millis());
  return appendCheckedFrame(line, sizeof(line), n, false);
}

// The role is inside the CRC, not inferred from a USB path or human log.
void appendTelemetry() {
  const uint16_t status = moduleStatus();
  char deg[16];
  char tgt[16];
  char line[TELEMETRY_LINE_CAPACITY];
  formatDegrees(stepNow(), deg, sizeof(deg));
  formatDegrees(targetNow(), tgt, sizeof(tgt));
  const char* home = !(status & STATUS_ZERO) ? "none"
      : ((status & STATUS_HOME_OPTO) ? "opto" : "manual");
  // 32-битное чтение ISR должно быть атомарным на 8-битном AVR.
  const uint8_t saved_sreg = SREG;
  cli();
  const uint32_t edges = tach_edges_total;
  SREG = saved_sreg;
  // Старый сервер по-прежнему видит tach=0; новый может явно использовать
  // sc_count для одометрии, не смешивая его с историческим rpm/tach.
  const int n = snprintf_P(line, sizeof(line),
      PSTR("@TLM mod=%s deg=%s tgt=%s moving=%d cal=%d cycle=%d calib=%d opto=%d home=%s err=%u drive=%d fw=%u pot=%d pm=%d ph=%d zfault=%d tach=0 dmax=%u sv=%u duty=%u sc_rpm=%lu.%lu sc_hz=%u sc_ppr=%u sc_count=%lu sc_recent=%u brake_id=%lu neutral_id=%lu neutral_lock=%u live_id=%lu live_seq=%lu t=%lu"),
      MODULE_ID, deg, tgt, (status & STATUS_MOVING) ? 1 : 0, (status & STATUS_ZERO) ? 1 : 0,
      (status & STATUS_CYCLE) ? 1 : 0, (status & STATUS_CALIB) ? 1 : 0, (status & STATUS_OPTO) ? 1 : 0,
      home, (unsigned)((status >> 8) & 0x0F), (int)drive_percent, (unsigned)FIRMWARE_PROTOCOL,
      (status & STATUS_POT) ? 1 : 0,
      (status & STATUS_POT_MODE_SUPPORTED) ? ((status & STATUS_POT_MODE) ? 1 : 0) : -1,
      (status & STATUS_POT_HOLD) ? 1 : 0,
      (status & STATUS_FULL_ZERO_FAULT) ? 1 : 0,
      (unsigned)DRIVE_MAX_PERCENT, (unsigned)drive_servo_value,
      (unsigned)driveValuePermille(), (unsigned long)(tach_display_rpm_x10 / 10),
      (unsigned long)(tach_display_rpm_x10 % 10), (unsigned)tach_display_hz,
      (unsigned)TACH_EDGES_PER_REV, (unsigned long)edges, (unsigned)tachMotionRecent(),
      (unsigned long)brake_id, (unsigned long)neutral_id, (unsigned)neutral_inhibit,
      (unsigned long)live_id, (unsigned long)live_seq, (unsigned long)millis());
  appendCheckedFrame(line, sizeof(line), n, true);
}

// Общая точка входа USB: «w [FL] …» разбирается на имя колеса и команду ядра,
// остальное уходит в handleModuleCommand как есть.
void handleWheelCommand(char* line) {
  char work[48];
  strncpy(work, line, sizeof(work) - 1);
  work[sizeof(work) - 1] = '\0';
  char* save = nullptr;
  char* command = strtok_r(work, " \t", &save);
  if (!command) return;
  if (strcasecmp_P(command, PSTR("?")) == 0 || strcasecmp_P(command, PSTR("help")) == 0) {
    printHelp();
    return;
  }
  // v [колесо] значение [f/b]. Имя снимается, число не преобразуется.
  if (strcasecmp_P(command, PSTR("v")) == 0) {
    char* value = strtok_r(nullptr, " \t", &save);
    const uint8_t kind = classifyModuleToken(value);
    if (kind == MOD_OTHER) return;
    if (kind == MOD_MINE || kind == MOD_ALL) value = strtok_r(nullptr, " \t", &save);
    char* direction = strtok_r(nullptr, " \t", &save);
    char* extra = strtok_r(nullptr, " \t", &save);
    if (!value || extra) {
      stopDriveLocal();
      return;
    }
    char local[32];
    const int written = direction
        ? snprintf_P(local, sizeof(local), PSTR("v %s %s"), value, direction)
        : snprintf_P(local, sizeof(local), PSTR("v %s"), value);
    if (written < 0 || written >= (int)sizeof(local)) {
      stopDriveLocal();
      return;
    }
    handleModuleCommand(local);
    return;
  }
  // Адресная прежняя команда t принимает своё имя, чужое — игнорирует.
  if (strcasecmp_P(command, PSTR("t")) == 0) {
    char* arg1 = strtok_r(nullptr, " \t", &save);
    const uint8_t kind = classifyModuleToken(arg1);
    if (kind == MOD_OTHER) return;
    if (kind == MOD_MINE || kind == MOD_ALL) {
      char* arg2 = strtok_r(nullptr, " \t", &save);
      char* extra = strtok_r(nullptr, " \t", &save);
      if (!arg2 || extra) {
        note(PSTR("Шаблон: t [FL] -%u…%u (0 — стоп); b — тормоз"),
             (unsigned)DRIVE_MAX_PERCENT, (unsigned)DRIVE_MAX_PERCENT);
        return;
      }
      char local[16];
      const int written = snprintf_P(local, sizeof(local), PSTR("t %s"), arg2);
      if (written < 0 || written >= (int)sizeof(local)) {
        stopDriveLocal();
        return;
      }
      handleModuleCommand(local);
      return;
    }
    if (kind == MOD_UNKNOWN && arg1 != nullptr && isalpha((unsigned char)arg1[0]) &&
        strtok_r(nullptr, " \t", &save)) {
      // «t FX 8» — не имя колеса и не число: подсказываем, какие имена есть.
      note(PSTR("неизвестный модуль %s (есть FL, FR, RL, RR, ALL)"), arg1);
      return;
    }
    // «t», «t 8» — прежняя команда на это колесо.
    handleModuleCommand(line);
    return;
  }
  if (strcasecmp_P(command, PSTR("w")) == 0) {
    char* arg1 = strtok_r(nullptr, " \t", &save);
    char* arg2 = strtok_r(nullptr, " \t", &save);
    char* extra = strtok_r(nullptr, " \t", &save);
    const uint8_t kind = classifyModuleToken(arg1);
    if (kind == MOD_OTHER) return;   // команда чужого колеса — молча пропускаем
    if (kind == MOD_MINE || kind == MOD_ALL) {
      if (!arg2 || extra) {
        note(PSTR("Шаблон: w [FL] 12.5 | w zero | w calib"));
        return;
      }
      // «w FL z» и «w FL k» — короткие имена, как в прежнем мастере.
      char local[32];
      if (strcasecmp_P(arg2, PSTR("z")) == 0) {
        strcpy_P(local, PSTR("w zero"));
      } else if (strcasecmp_P(arg2, PSTR("k")) == 0) {
        strcpy_P(local, PSTR("w calib"));
      } else {
        snprintf_P(local, sizeof(local), PSTR("w %s"), arg2);
      }
      handleModuleCommand(local);
      return;
    }
    if (kind == MOD_UNKNOWN && arg2) {
      note(PSTR("неизвестный модуль %s (есть FL, FR, RL, RR, ALL)"), arg1);
      return;
    }
    // «w 12.5», «w zero», «w calib» — своя команда без имени колеса.
    handleModuleCommand(line);
    return;
  }
  handleModuleCommand(line);
  if (strcasecmp_P(command, PSTR("p")) == 0) {
    note(PSTR("колесо %s, прошивка v%u (USB)"), MODULE_ID, (unsigned)FIRMWARE_PROTOCOL);
  }
}

void readSerialLines() {
  if ((serial_length > 0 || serial_overflow) &&
      (uint32_t)(millis() - serial_last_char_ms) > SERIAL_LINE_TIMEOUT_MS) {
    serial_length = 0;
    serial_overflow = false;
  }
  while (Serial.available() > 0) {
    const char ch = (char)Serial.read();
    serial_last_char_ms = millis();
    if (ch == '\n' || ch == '\r') {
      if (serial_overflow) {
        note(PSTR("слишком длинная строка — пропущена"));
      } else if (serial_length > 0) {
        serial_line[serial_length] = '\0';
        if (serial_line[0] == '@') {
          // Любой @ — входное эхо/мусор, не запрос определения колеса.
        } else if (serial_line[0] != '#') {
          handleWheelCommand(serial_line);
          // The next frame represents the result, not just receipt of bytes.
          // Repeated heartbeats are rate-limited together with normal frames.
          telemetry_urgent = true;
        }
      }
      serial_length = 0;
      serial_overflow = false;
    } else if (serial_length < sizeof(serial_line) - 1) {
      serial_line[serial_length++] = ch;
    } else {
      serial_overflow = true;
    }
  }
}

void setup() {
  Serial.begin(115200);
  steeringSetup();
  last_telemetry_ms = last_fast_telemetry_ms = millis();
  note(PSTR("--- КОЛЕСО %s: руль v%u, USB 115200; ноль не задан — k или z ---"),
       MODULE_ID, (unsigned)FIRMWARE_PROTOCOL);
  potBootNote();
  printHelp();
}

void loop() {
  readSerialLines();
  steeringLoop();
  // Completion of a move (including potentiometer correction) is as important
  // as a command ACK. Do not wait for the next periodic frame to report it.
  const bool steering_busy = motorBusy() || feedback_pending;
  if (steering_busy != last_steering_busy) {
    last_steering_busy = steering_busy;
    telemetry_urgent = true;
  }
  const uint32_t now = millis();
  if ((uint32_t)(now - last_sc_recent_check_ms) >= 10) {
    last_sc_recent_check_ms = now;
    const bool recent = tachMotionRecent();
    if (recent != last_sc_recent) {
      last_sc_recent = recent;
      telemetry_urgent = true;
    }
  }
  const uint16_t interval = telemetry_urgent ? FAST_TELEMETRY_MIN_SPACING_MS : FAST_TELEMETRY_PERIOD_MS;
  if ((uint32_t)(now - last_fast_telemetry_ms) >= interval && txFree() >= FAST_TELEMETRY_LINE_CAPACITY) {
    // A frame must fit whole. If TX is busy, retain the urgent request and
    // retry on the next loop instead of dropping the ACK or blocking control.
    if (appendFastTelemetry()) {
      last_fast_telemetry_ms = now;
      telemetry_urgent = false;
    }
  }
  if ((uint32_t)(now - last_telemetry_ms) >= FULL_TELEMETRY_PERIOD_MS &&
      txFree() >= TELEMETRY_LINE_CAPACITY) {
    appendTelemetry();  // old servers ignore the additional CRC field
    last_telemetry_ms = now;
  }
  if (zero_reply_id && (uint32_t)(now - zero_reply_started) < 5000UL &&
      (uint32_t)(now - zero_reply_last) >= 200 && txFree() >= 96) {
    if (appendFullZeroReply()) zero_reply_last = now;
  }
  txPump();
}
