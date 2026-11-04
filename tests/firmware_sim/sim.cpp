// Хост-симуляция прошивки колеса motor_wheel: четыре независимые платы
// (FL/FR/RL/RR), каждая со своим USB и прошивкой СВОЕГО колеса; связь — только UART.
//
// Сборка и запуск (это делает tests/test_firmware.py):
//   g++ -std=c++17 -I tests/firmware_sim/stubs tests/firmware_sim/sim.cpp -o sim
//   ./sim            — все сценарии (каждый в своём процессе, как после сброса)
//   ./sim moves      — один сценарий
//   ./sim tlm_dump   — вывести @TLM всех четырёх колёс (для разбора сервером)
//   ./sim pty /tmp/wheel — четыре колеса за псевдотерминалами /tmp/wheel-FL…
#include "arduino_sim.h"

#include <chrono>
#include <fcntl.h>
#include <functional>
#include <sstream>
#include <sys/wait.h>
#include <termios.h>
#include <thread>
#include <unistd.h>

sim::Board board_fl, board_fr, board_rl, board_rr;

namespace wheel_fl {
#define SIM_BOARD board_fl
#define MODULE_ID "FL"
#include "board_prelude.h"
#include "../../firmware/motor_wheel/motor_wheel.ino"
#undef SIM_BOARD
}  // namespace wheel_fl
#undef MODULE_ID
#undef TX_BUFFER_SIZE

namespace wheel_fr {
#define SIM_BOARD board_fr
#define MODULE_ID "FR"
#include "board_prelude.h"
#include "../../firmware/motor_wheel/motor_wheel.ino"
#undef SIM_BOARD
}  // namespace wheel_fr
#undef MODULE_ID
#undef TX_BUFFER_SIZE

namespace wheel_rl {
#define SIM_BOARD board_rl
#define MODULE_ID "RL"
#include "board_prelude.h"
#include "../../firmware/motor_wheel/motor_wheel.ino"
#undef SIM_BOARD
}  // namespace wheel_rl
#undef MODULE_ID
#undef TX_BUFFER_SIZE

namespace wheel_rr {
#define SIM_BOARD board_rr
#define MODULE_ID "RR"
#include "board_prelude.h"
#include "../../firmware/motor_wheel/motor_wheel.ino"
#undef SIM_BOARD
}  // namespace wheel_rr
#undef MODULE_ID
#undef TX_BUFFER_SIZE

static int failures = 0;

#define CHECK(cond, ...)                                                   \
  do {                                                                     \
    if (!(cond)) {                                                         \
      ++failures;                                                          \
      std::fprintf(stderr, "  FAIL %s:%d: %s — ", __FILE__, __LINE__, #cond); \
      std::fprintf(stderr, __VA_ARGS__);                                   \
      std::fprintf(stderr, "\n");                                          \
    }                                                                      \
  } while (0)

static void bind_boards() {
  board_fl.name = "FL";
  board_fl.setup_fn = wheel_fl::setup;
  board_fl.loop_fn = wheel_fl::loop;
  board_fl.isr_fn = wheel_fl::TIMER2_COMPA_vect_handler;
  board_fr.name = "FR";
  board_fr.setup_fn = wheel_fr::setup;
  board_fr.loop_fn = wheel_fr::loop;
  board_fr.isr_fn = wheel_fr::TIMER2_COMPA_vect_handler;
  board_rl.name = "RL";
  board_rl.setup_fn = wheel_rl::setup;
  board_rl.loop_fn = wheel_rl::loop;
  board_rl.isr_fn = wheel_rl::TIMER2_COMPA_vect_handler;
  board_rr.name = "RR";
  board_rr.setup_fn = wheel_rr::setup;
  board_rr.loop_fn = wheel_rr::loop;
  board_rr.isr_fn = wheel_rr::TIMER2_COMPA_vect_handler;
}

static void boot(std::vector<sim::Board*> list) {
  sim::boards = list;
  // слейвы раньше мастера: шина готова к первому опросу
  for (auto it = list.rbegin(); it != list.rend(); ++it) {
    (*it)->reset_stats();
    (*it)->setup_fn();
  }
  sim::run_for_ms(5);
}

static bool wait_until(const std::function<bool()>& predicate, double timeout_ms) {
  const int64_t end = sim::now_us + (int64_t)(timeout_ms * 1000.0);
  while (sim::now_us < end) {
    if (predicate()) return true;
    sim::run_for_ms(1);
  }
  return predicate();
}

static bool has(const sim::Board& board, const char* text) {
  return board.serial.output.find(text) != std::string::npos;
}

// Выход на драйвер RioRand ZS-Z11H — вход «P» управляется как сервопривод
// постоянного вращения: штатная библиотека Servo даёт 50 Гц, значение write
// 0…180 — это 0…100 % шкалы тяги (как в проверенном на железе скетче
// «Servo mk1; mk1.attach(9); mk1.write(40)»). Контура оборотов нет: сколько
// процентов попросили, столько и стоит на входе «P».
//
// Едет ли колесо, видно по линиям драйвера: BRAKE (D5) отпущен, STOP (D2)
// разрешает выходы. В покое наоборот — тормоз взведён, драйвер выключен.
static bool thrust_on(const sim::Board& board) {
  return board.level[5] == LOW && board.level[2] == HIGH;
}

// Значение на входе «P» (0…180) и оно же в промилле шкалы (0…1000).
static int servo_value(const sim::Board& board) { return board.servo_value; }
static int duty_permille(const sim::Board& board) { return board.duty_permille(); }

// Стоит ли колесо: тормоз взведён, драйвер выключен, скважность нулевая.
static bool drive_idle(const sim::Board& board) {
  return board.level[5] == HIGH && board.level[2] == LOW && duty_permille(board) == 0;
}


static long count(const sim::Board& board, const char* text) {
  long n = 0;
  size_t pos = 0;
  while ((pos = board.serial.output.find(text, pos)) != std::string::npos) {
    ++n;
    pos += std::strlen(text);
  }
  return n;
}

// То же, но только в хвосте вывода (после отметки) — «сколько раз с момента…».
static long count_since(const sim::Board& board, const char* text, size_t from) {
  long n = 0;
  size_t pos = from;
  while ((pos = board.serial.output.find(text, pos)) != std::string::npos) {
    ++n;
    pos += std::strlen(text);
  }
  return n;
}

struct FastFrame {
  unsigned firmware = 0, identity = 0, status = 0, maximum = 0, servo = 0, hz = 0, ppr = 0, recent = 0, neutral_lock = 0;
  long deg = 0, target = 0;
  int drive = 0;
  unsigned long rpm10 = 0, edges = 0, brake = 0, neutral = 0, live = 0, sequence = 0, time = 0;
};

static bool latest_fast_frame(const sim::Board& board, FastFrame* out) {
  const size_t start = board.serial.output.rfind("@F ");
  if (start == std::string::npos) return false;
  const size_t end = board.serial.output.find("\r\n", start);
  if (end == std::string::npos) return false;
  const std::string line = board.serial.output.substr(start, end - start);
  const size_t split = line.rfind(' ');
  if (split == std::string::npos || line.size() - split != 5) return false;
  const std::string payload = line.substr(0, split);
  char* tail = nullptr;
  const unsigned long expected = std::strtoul(line.c_str() + split + 1, &tail, 16);
  if (!tail || *tail || expected != wheel_fr::telemetryCrc16(payload.c_str(), (uint16_t)payload.size())) return false;
  std::istringstream input(payload);
  std::string prefix;
  input >> prefix >> out->firmware >> out->identity >> out->deg >> out->target >> out->status >> out->drive
        >> out->maximum >> out->servo >> out->rpm10 >> out->hz >> out->ppr >> out->edges
        >> out->recent >> out->brake >> out->neutral >> out->neutral_lock >> out->live >> out->sequence >> out->time;
  return !input.fail() && prefix == "@F";
}

static void check_signals(const sim::Board& board) {
  CHECK(board.dir_setup_violations == 0, "%s: DIR сменился позже чем за 5 мкс до PUL (%ld)",
        board.name, board.dir_setup_violations);
  CHECK(board.steps_while_disabled == 0, "%s: шаги при ENA != HIGH (%ld)", board.name,
        board.steps_while_disabled);
  CHECK(board.min_high_us >= 50, "%s: импульс PUL короче 50 мкс (%lld)", board.name,
        (long long)board.min_high_us);
}

// ---------------------------------------------------------------- один модуль
#define FR wheel_fr

static bool fr_idle() { return FR::calib_state == FR::CAL_IDLE && !FR::motorBusy(); }

static void calibrate_fr(double timeout_ms = 30000) {
  board_fr.serial.send("k");
  sim::run_for_ms(2);
  CHECK(FR::calib_state != FR::CAL_IDLE || FR::calib_error != FR::CAL_OK || FR::zero_set,
        "калибровка не началась");
  CHECK(wait_until(fr_idle, timeout_ms), "калибровка не закончилась за %.0f мс", timeout_ms);
}

static bool fr_settled() {
  return FR::calib_state == FR::CAL_IDLE && FR::pot_cal_state == FR::POT_CAL_IDLE &&
         !FR::motorBusy() && !FR::feedback_pending;
}

static bool fr_pot_idle() {
  return FR::pot_cal_state == FR::POT_CAL_IDLE && !FR::motorBusy();
}

static void calibrate_pot_fr() {
  board_fr.serial.send("q");
  sim::run_for_ms(2);
  CHECK(FR::pot_cal_state != FR::POT_CAL_IDLE, "q не запустила калибровку потенциометра");
  CHECK(wait_until(fr_pot_idle, 30000), "калибровка потенциометра не закончилась");
  CHECK(FR::pot_calibrated && FR::pot_zero_valid, "потенциометр не откалиброван: cal=%d zero=%d",
        FR::pot_calibrated, FR::pot_zero_valid);
}

static void scenario_boot() {
  boot({&board_fr});
  CHECK(board_fr.level[8] == HIGH, "ENA должен быть HIGH сразу после включения");
  CHECK(board_fr.level[6] == LOW, "PUL в покое LOW");
  CHECK(board_fr.mode[18] == INPUT_PULLUP, "D18 — INPUT_PULLUP");
  CHECK(!FR::zero_set, "ноль после включения не задан");
  CHECK(has(board_fr, "--- КОЛЕСО FR:"), "приветствие колеса: %s", board_fr.serial.output.c_str());
  CHECK(has(board_fr, "потенциометр A0: 512"), "потенциометр A0 прочитан: %s",
        board_fr.serial.output.c_str());
  CHECK(board_fr.level[5] == HIGH, "BLDC: тормоз включён после старта");
  CHECK(board_fr.level[2] == LOW, "BLDC: драйвер выключен (STOP = 0) после старта");
  CHECK(board_fr.mode[3] == OUTPUT, "D3 — выход сигнала Servo");
  CHECK(board_fr.servo_running(), "Servo подключён к D3 и выдаёт 50 Гц");
  CHECK(board_fr.servo_pin == 3, "сигнал тяги идёт на D3 (вход «P»), а не на %u",
        (unsigned)board_fr.servo_pin);
  CHECK(servo_value(board_fr) == 0, "значение 0 — мотор не тянет (%d)",
        servo_value(board_fr));
}

static void scenario_calib_left() {
  board_fr.phys = -4000;                 // колесо на −30°, флажок в [−200, 200]
  boot({&board_fr});
  const int64_t started = sim::now_us;
  calibrate_fr();
  const double seconds = (sim::now_us - started) / 1e6;
  CHECK(FR::zero_set && FR::home_source == FR::HOME_OPTO && FR::calib_error == FR::CAL_OK,
        "ноль по датчику: zero=%d home=%d err=%d", FR::zero_set, FR::home_source, FR::calib_error);
  CHECK(std::labs(board_fr.phys) <= 1, "колесо в середине флажка, phys=%ld", board_fr.phys);
  CHECK(FR::stepNow() == 0, "счётчик в нуле: %ld", (long)FR::stepNow());
  CHECK(has(board_fr, "Калибровка ЗАВЕРШЕНА!"), "нет сообщения о завершении");
  CHECK(has(board_fr, "ширина флажка 3.00°"), "ширина флажка 400 шагов = 3.00°: %s",
        board_fr.serial.output.c_str());
  CHECK(seconds < 60.0, "калибровка шла %.1f с", seconds);
  CHECK(board_fr.min_period_us == 100, "рабочий шаг 100 мкс (10 кГц), а min период %lld",
        (long long)board_fr.min_period_us);
  CHECK(!has(board_fr, "ищу влево"), "датчик слева от колеса находится поиском вправо");
  check_signals(board_fr);
}

static void scenario_calib_right() {
  board_fr.phys = 3000;                  // флажок левее: вправо 135° пусто, потом влево
  boot({&board_fr});
  calibrate_fr();
  CHECK(has(board_fr, "справа датчика нет, ищу влево на 250°"), "переход к поиску влево");
  CHECK(has(board_fr, "датчик найден слева"), "датчик найден поиском влево");
  CHECK(FR::zero_set && std::labs(board_fr.phys) <= 1, "ноль найден: phys=%ld", board_fr.phys);
  CHECK(std::labs(board_fr.phys_max - (3000 + 16667)) <= 2, "сначала прошёл вправо 125°: max=%ld", board_fr.phys_max);
  check_signals(board_fr);
}

static void scenario_calib_inside() {
  board_fr.phys = 50;                    // старт внутри флажка
  boot({&board_fr});
  calibrate_fr();
  CHECK(has(board_fr, "датчик уже закрыт"), "старт с закрытым датчиком");
  CHECK(FR::zero_set && std::labs(board_fr.phys) <= 1, "ноль найден: phys=%ld", board_fr.phys);
  check_signals(board_fr);
}

static void scenario_calib_far_left() {
  board_fr.phys = -13000;                // −97.5°: ещё в зоне поиска вправо
  boot({&board_fr});
  calibrate_fr();
  CHECK(FR::zero_set && std::labs(board_fr.phys) <= 1, "ноль найден: phys=%ld", board_fr.phys);
}

static void scenario_calib_out_of_range() {
  board_fr.phys = -19000;                // −142.5°: флажок за пределом ±135° от старта
  boot({&board_fr});
  calibrate_fr();
  CHECK(!FR::zero_set && FR::calib_error == FR::CAL_ERR_NOT_FOUND, "ошибка «не найден»: err=%d",
        FR::calib_error);
  CHECK(has(board_fr, "ОШИБКА калибровки: датчик не найден"), "текст ошибки");
  CHECK(std::labs(board_fr.phys - (-19000 - 16667)) <= 2, "вправо 125° и влево 250°: phys=%ld",
        board_fr.phys);
  CHECK(!FR::motorBusy(), "мотор остановлен");
}

static void scenario_calib_no_sensor() {
  board_fr.opto_present = false;
  boot({&board_fr});
  calibrate_fr();
  CHECK(FR::calib_error == FR::CAL_ERR_NOT_FOUND && !FR::zero_set, "без датчика — ошибка");
  CHECK(std::labs(board_fr.phys_max - 16667) <= 2 && std::labs(board_fr.phys_min + 16667) <= 2,
        "ход поиска +125°/−250° (±125° от старта): min=%ld max=%ld", board_fr.phys_min,
        board_fr.phys_max);
  sim::run_for_ms(200);
  CHECK(std::labs(board_fr.phys + 16667) <= 2 && !FR::motorBusy(), "после ошибки колесо стоит");
}

static void scenario_calib_stuck() {
  board_fr.opto_stuck = true;
  boot({&board_fr});
  calibrate_fr();
  CHECK(FR::calib_error == FR::CAL_ERR_STUCK && !FR::zero_set, "залипший датчик: err=%d",
        FR::calib_error);
  CHECK(std::labs(board_fr.phys - 4000) <= 1, "выход из флажка ограничен 30°: phys=%ld", board_fr.phys);
}

static void scenario_calib_abort() {
  board_fr.phys = -8000;
  boot({&board_fr});
  board_fr.serial.send("k");
  sim::run_for_ms(30);
  board_fr.serial.send("s");
  sim::run_for_ms(5);
  const long stopped_at = board_fr.phys;
  CHECK(FR::calib_state == FR::CAL_IDLE && FR::calib_error == FR::CAL_ERR_ABORTED,
        "s отменяет калибровку");
  CHECK(has(board_fr, "прервана командой s") && has(board_fr, "ПАУЗА."), "сообщения об отмене");
  sim::run_for_ms(300);
  CHECK(board_fr.phys == stopped_at, "после s колесо не едет: %ld → %ld", stopped_at, board_fr.phys);
  board_fr.serial.send("g");
  sim::run_for_ms(50);
  CHECK(board_fr.phys == stopped_at, "g не продолжает отменённую калибровку");
  board_fr.serial.send("k");
  sim::run_for_ms(2);
  CHECK(FR::calib_state != FR::CAL_IDLE, "после отмены калибровку можно запустить снова");
  CHECK(wait_until(fr_idle, 30000) && FR::zero_set, "повторная калибровка прошла");
}

static void scenario_calib_asymmetric() {
  board_fr.flag_lo = 100;                // флажок [0.75°, 6.75°], середина 500 шагов
  board_fr.flag_hi = 900;
  board_fr.hysteresis = 30;
  board_fr.phys = 6000;
  boot({&board_fr});
  calibrate_fr();
  CHECK(FR::zero_set && std::labs(board_fr.phys - 500) <= 1,
        "ноль — середина флажка (гистерезис не сдвигает): phys=%ld", board_fr.phys);
}

// Флажок на краю диапазона, поиск с обеих сторон. Ход руля не выходит за ±135°.
static void scenario_calib_full_range_plus() {
  board_fr.flag_lo = 15800;              // флажок при +118.5°, найдётся быстрым ходом вправо
  board_fr.flag_hi = 16200;
  boot({&board_fr});
  calibrate_fr();
  CHECK(FR::zero_set && has(board_fr, "датчик найден справа"), "найден справа");
  CHECK(std::labs(board_fr.phys - 16000) <= 1, "ноль в середине флажка: phys=%ld", board_fr.phys);
  CHECK(board_fr.phys_max <= 18000 + 2 && board_fr.phys_min >= -18000 - 2,
        "ход не вышел за ±135°: min=%ld max=%ld", board_fr.phys_min, board_fr.phys_max);
  check_signals(board_fr);
}

static void scenario_calib_full_range_minus() {
  board_fr.flag_lo = -16200;             // флажок при −121.5°: вправо 135° пусто, ищем влево 270°
  board_fr.flag_hi = -15800;
  boot({&board_fr});
  calibrate_fr();
  CHECK(FR::zero_set && has(board_fr, "датчик найден слева"), "найден слева");
  CHECK(std::labs(board_fr.phys - (-16000)) <= 1, "ноль в середине флажка: phys=%ld", board_fr.phys);
  CHECK(board_fr.phys_max <= 18000 + 2 && board_fr.phys_min >= -18000 - 2,
        "ход не вышел за ±135°: min=%ld max=%ld", board_fr.phys_min, board_fr.phys_max);
  check_signals(board_fr);
}

// Срабатывание датчика сдвигается на +60, 0, −60 шагов (до 0.45°) от подхода к подходу.
// Один подход дал бы ноль со сдвигом на 30 шагов; среднее по трём подходам каждой
// кромки сдвиги гасит: ноль попадает в середину флажка.
static void scenario_calib_passes_averaged() {
  board_fr.flag_shift_script = {60, 0, -60};
  board_fr.phys = 0;
  boot({&board_fr});
  calibrate_fr();
  CHECK(FR::zero_set && FR::calib_error == FR::CAL_OK, "калибровка прошла: err=%d", FR::calib_error);
  CHECK(count(board_fr, "кромка справа найдена") == 3 && count(board_fr, "кромка слева найдена") == 3,
        "по три подхода на каждую кромку: справа %ld, слева %ld",
        count(board_fr, "кромка справа найдена"), count(board_fr, "кромка слева найдена"));
  CHECK(std::labs(board_fr.phys) <= 2, "среднее гасит сдвиги подходов: phys=%ld", board_fr.phys);
  check_signals(board_fr);
}

// Кромки с разных подходов расходятся на 300 шагов (2.25°) — больше допуска 2°.
// Ноль не ставим: ошибка 6.
static void scenario_calib_spread_error() {
  board_fr.flag_shift_script = {150, 0, -150};
  board_fr.phys = 0;
  boot({&board_fr});
  calibrate_fr();
  CHECK(!FR::zero_set && FR::calib_error == FR::CAL_ERR_SPREAD, "ошибка разброса: err=%d zero=%d",
        FR::calib_error, FR::zero_set);
  CHECK(has(board_fr, "кромки расходятся между подходами"), "текст ошибки разброса");
  CHECK(!FR::motorBusy(), "мотор остановлен");
}

static void scenario_moves() {
  board_fr.phys = -2500;
  boot({&board_fr});
  calibrate_fr();
  board_fr.reset_stats();

  board_fr.serial.send("w 12.5");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == 1667; }, 1000),
        "w 12.5 → 1667 шагов, сейчас %ld", (long)FR::stepNow());
  CHECK(board_fr.phys == 1667, "колесо на 12.5°: phys=%ld", board_fr.phys);

  // Предел абсолютной команды — ±100° (STEER_LIMIT_DEG): боковой ход (90°) и
  // запас до 100° колесу доступны, угол вне предела его не двигает, возврат в
  // рабочее положение — тоже.
  board_fr.serial.send("w 90");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == 12000; }, 3000),
        "w 90 → 12000 шагов, сейчас %ld", (long)FR::stepNow());
  CHECK(board_fr.phys == 12000, "колесо на 90°: phys=%ld", board_fr.phys);

  // 100° — новый потолок: колесо обязано доехать, а не быть отклонённым.
  board_fr.serial.send("w 100");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == 13333; }, 3000),
        "w 100 → 13333 шага, сейчас %ld", (long)FR::stepNow());
  CHECK(board_fr.phys == 13333, "колесо на 100°: phys=%ld", board_fr.phys);

  board_fr.serial.send("w 101");
  sim::run_for_ms(50);
  CHECK(board_fr.phys == 13333 && has(board_fr, "угол вне ±100°"), "w 101 отклонена");

  board_fr.serial.send("w -100");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == -13333; }, 5000),
        "w -100 → -13333 шага, сейчас %ld", (long)FR::stepNow());
  CHECK(board_fr.phys == -13333, "колесо на −100°: phys=%ld", board_fr.phys);

  board_fr.serial.send("w 12.5");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == 1667; }, 5000),
        "возврат на 12.5° после ±100°, сейчас %ld", (long)FR::stepNow());
  CHECK(board_fr.phys == 1667, "колесо снова на 12.5°: phys=%ld", board_fr.phys);

  const int64_t started = sim::now_us;
  board_fr.serial.send("d 10 f");
  sim::run_for_ms(2);
  CHECK(wait_until([] { return !FR::motorBusy(); }, 1000), "d 10 f закончилась");
  const double ms = (sim::now_us - started) / 1000.0;
  CHECK(board_fr.phys == 3000, "d 10 f → +1333 шага: phys=%ld", board_fr.phys);
  CHECK(ms > 130.0 && ms < 140.0, "1333 шага по 100 мкс ≈ 133 мс, а заняло %.1f мс", ms);
  CHECK(has(board_fr, "ВПЕРЕД (F) на 10.00°") && has(board_fr, "Цель достигнута. Угол: 22.50°"),
        "сообщения как в проверенном скетче: %s", board_fr.serial.output.c_str());

  board_fr.serial.send("d 5 b");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == 2333; }, 1000),
        "d 5 b → 2333, сейчас %ld", (long)FR::stepNow());
  board_fr.serial.send("d 10");
  board_fr.serial.send("d -5 f");
  board_fr.serial.send("d 5 x");
  sim::run_for_ms(50);
  CHECK(has(board_fr, "Шаблон: d [градусы] [f/b]"), "d без направления");
  CHECK(has(board_fr, "Ошибка: Угол > 0!"), "отрицательный угол, как в скетче");
  CHECK(has(board_fr, "Ошибка направления! f или b"), "неверное направление");
  CHECK(board_fr.phys == 2333, "ошибочные команды не двигают колесо");

  board_fr.serial.send("d 200 f");
  sim::run_for_ms(5);
  CHECK(has(board_fr, "вне хода ±125°"), "предел хода отклоняет d 200: %s",
        board_fr.serial.output.c_str());
  CHECK(board_fr.phys == 2333, "предел хода не двигает колесо");

  board_fr.serial.send("h");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == 0; }, 1000), "h → 0");
  CHECK(board_fr.phys == 0, "колесо прямо: phys=%ld", board_fr.phys);
  board_fr.serial.send("p");
  sim::run_for_ms(5);
  CHECK(has(board_fr, "Текущий: 0.00° | Целевой: 0.00° [СТОИТ] · ноль по датчику"), "p: %s",
        board_fr.serial.output.c_str());
  check_signals(board_fr);
}

static void scenario_pot_calibration() {
  board_fr.phys = 2500;                  // колесо не в нуле: q сначала едет в 0
  boot({&board_fr});
  calibrate_fr();
  CHECK(FR::pot_zero_valid && !FR::pot_calibrated,
        "после k ноль потенциометра есть, наклон ещё нет");
  CHECK(has(board_fr, "потенциометр A0: 0° = 512"), "ноль потенциометра записан: %s",
        board_fr.serial.output.c_str());
  calibrate_pot_fr();
  CHECK(std::labs(board_fr.phys) <= 1, "q вернула колесо в 0: phys=%ld", board_fr.phys);
  CHECK(std::fabs(FR::pot_counts_per_degree - 1023.0 / 270.0) < 0.05,
        "наклон %.4f отсч/°", FR::pot_counts_per_degree);
  CHECK(FR::moduleStatus() & FR::STATUS_POT, "бит STATUS_POT в кадре состояния");
  CHECK(has(board_fr, "Потенциометр: 3.78 отсч/°, 0° = 512"),
        "наклон и ноль напечатаны: %s", board_fr.serial.output.c_str());
  CHECK(has(board_fr, "калибровка завершена, доводка включена"), "сообщение о завершении q");
  board_fr.serial.send("p");
  sim::run_for_ms(5);
  CHECK(has(board_fr, "Потенциометр A0: 512 = 0.00° (наклон измерен)"), "p: %s",
        board_fr.serial.output.c_str());
}

static void scenario_pot_feedback() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  board_fr.pot_bias_steps = 600;         // датчик показывает на 4.5° больше колеса
  board_fr.serial.send("w 10");
  sim::run_for_ms(2);
  CHECK(wait_until(fr_settled, 3000), "w 10 с доводкой не закончилась");
  CHECK(std::fabs(FR::potAngleDeg() - 10.0f) < 0.8f,
        "доводка вывела датчик на 10°: %.2f (phys=%ld)", FR::potAngleDeg(), board_fr.phys);
  CHECK(has(board_fr, "Потенциометр: доводка"), "сообщение о доводке: %s",
        board_fr.serial.output.c_str());
  CHECK(has(board_fr, "Потенциометр: остаток"), "сообщение об остатке");
  CHECK(std::labs(FR::stepNow() - 1333) <= 10, "счётчик привязан к датчику: %ld",
        (long)FR::stepNow());
  board_fr.serial.send("w 0");
  sim::run_for_ms(2);
  CHECK(wait_until(fr_settled, 3000), "w 0 с доводкой не закончилась");
  CHECK(std::fabs(FR::potAngleDeg()) < 0.8f, "доводка вернула на 0: %.2f", FR::potAngleDeg());
  CHECK(std::labs(FR::stepNow()) <= 10, "счётчик снова в нуле: %ld", (long)FR::stepNow());
}

// ---- активное удержание угла по потенциометру (ph, fw24) ----
// Рука оператора: колесо поворачивается, а счётчик шагов об этом не знает.
static void manual_shift(double degrees) {
  board_fr.phys += (long)std::lround(degrees * board_fr.phys_per_degree);
}

// Колесо не идёт за шагами: вниз его держит упор (stall_phys выше текущего).
static void block_wheel_downwards() {
  board_fr.stall_enabled = true;
  board_fr.stall_phys = board_fr.phys + 10;
}

static void scenario_pot_hold() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  CHECK(!FR::pot_hold, "после старта платы удержание выключено");
  board_fr.serial.send("p");
  sim::run_for_ms(5);
  CHECK(has(board_fr, "Удержание угла: выключено"),
        "p печатает выключенное удержание: %s", board_fr.serial.output.c_str());

  board_fr.serial.output.clear();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(FR::pot_hold, "ph 1 включает удержание: %s", board_fr.serial.output.c_str());
  CHECK(has(board_fr, "Удержание включено"), "подтверждение включения");
  CHECK((FR::moduleStatus() & FR::STATUS_POT_HOLD) != 0, "бит 0x8000 в состоянии модуля");
  CHECK((FR::moduleStatus() & FR::STATUS_POT) != 0, "доводка после ph 1 не пропала");
  CHECK((FR::moduleStatus() & 0x0F00) == 0, "флаг удержания не сдвинул код ошибки калибровки");
  FastFrame fast;
  sim::run_for_ms(40);
  CHECK(latest_fast_frame(board_fr, &fast) && (fast.status & FR::STATUS_POT_HOLD),
        "бит удержания в коротком кадре @F");
  board_fr.serial.output.clear();
  sim::run_for_ms(250);
  CHECK(has(board_fr, " ph=1 "), "@TLM несёт ph=1: %s", board_fr.serial.output.c_str());
  board_fr.serial.send("p");
  sim::run_for_ms(5);
  CHECK(has(board_fr, "Удержание угла: включено") && has(board_fr, "цель 0.00°"),
        "p печатает включённое удержание: %s", board_fr.serial.output.c_str());

  // Ручной сдвиг на 5°: колесо само возвращается в пределах ±1°.
  board_fr.serial.output.clear();
  board_fr.min_period_us = 1000000;
  manual_shift(5.0);
  sim::run_for_ms(60);
  CHECK(std::fabs(FR::potAngleDeg()) > 4.5f, "сдвиг 5° виден датчику: %.2f", FR::potAngleDeg());
  const long steps_before = board_fr.steps;
  CHECK(wait_until([] { return !FR::motorBusy() && std::fabs(FR::potAngleDeg()) <= 1.0f; }, 8000),
        "удержание вернуло колесо после сдвига 5°: %.2f°", FR::potAngleDeg());
  CHECK(board_fr.steps > steps_before, "колесо действительно ехало, а не просто ждало");
  sim::run_for_ms(150);          // контрольный замер и привязка счётчика
  CHECK(FR::pot_hold, "после возврата удержание осталось включено");
  CHECK(std::labs(FR::stepNow()) <= FR::degreesToSteps(1.5f),
        "счётчик шагов снова совпадает с датчиком: %ld", (long)FR::stepNow());
  CHECK(!has(board_fr, "сдвинуто вручную"), "сдвиг 5° не считается ручным уходом");
  CHECK(!has(board_fr, "расхождение"), "датчик в пределах доверия — расхождения нет");
  // Медленный ход удержания: 18 °/с, а не рабочие 75 °/с.
  CHECK(board_fr.min_period_us >= 300, "шаг удержания медленный: %lld мкс",
        (long long)board_fr.min_period_us);
  check_signals(board_fr);

  // Границы: 1.9° — ещё мёртвая зона, мотор не трогаем.
  board_fr.serial.output.clear();
  const long steps_in_deadband = board_fr.steps;
  manual_shift(1.9);
  sim::run_for_ms(1200);
  CHECK(board_fr.steps == steps_in_deadband, "в мёртвой зоне шагов не прибавилось");
  CHECK(!FR::motorBusy() && FR::pot_hold, "меньше 2° удержание не двигает колесо");
  const long phys_in_deadband = board_fr.phys;
  CHECK(std::labs(phys_in_deadband) > 100, "колесо осталось на месте: phys=%ld",
        phys_in_deadband);
  // Чуть больше порога — удержание снова догоняет.
  manual_shift(0.5);
  sim::run_for_ms(50);
  CHECK(wait_until([] { return !FR::motorBusy() && std::fabs(FR::potAngleDeg()) <= 2.0f; }, 8000),
        "сдвиг больше 2° снова догоняется: %.2f", FR::potAngleDeg());
  CHECK(std::labs(board_fr.phys) < std::labs(phys_in_deadband), "мотор поехал за мёртвой зоной");

  board_fr.serial.send("ph 0");
  sim::run_for_ms(5);
  CHECK(!FR::pot_hold, "ph 0 выключает удержание");
  CHECK((FR::moduleStatus() & FR::STATUS_POT_HOLD) == 0, "бит удержания снят");
}

static void scenario_pot_hold_limit() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(FR::pot_hold, "удержание включено");

  // Ручной сдвиг на 30° — за потолком реакции POT_HOLD_MAX_DEG.
  board_fr.serial.output.clear();
  manual_shift(30.0);
  CHECK(wait_until([] { return !FR::pot_hold; }, 5000), "сдвиг 30° выключает удержание");
  CHECK(has(board_fr, "сдвинуто вручную на"), "note о ручном сдвиге: %s",
        board_fr.serial.output.c_str());
  CHECK(has(board_fr, "повторите команду"), "note предлагает повторить команду");
  CHECK((FR::moduleStatus() & FR::STATUS_POT_HOLD) == 0, "бит удержания снят");
  const long phys = board_fr.phys;
  sim::run_for_ms(300);
  CHECK(board_fr.phys == phys, "колесо за рукой не погналось: phys=%ld", board_fr.phys);

  // ph 1 при сдвинутом колесе отказывает: цель удержания — намеренная команда.
  board_fr.serial.output.clear();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(!FR::pot_hold, "ph 1 при расхождении с целью отклонена");
  CHECK(has(board_fr, "отличается от цели на"), "note с причиной: %s",
        board_fr.serial.output.c_str());
}

// Колесо упёрлось и не идёт за шагами: удержание не толкает его бесконечно.
static void scenario_pot_hold_stall() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(FR::pot_hold, "удержание включено");
  manual_shift(3.0);
  block_wheel_downwards();
  board_fr.serial.output.clear();
  CHECK(wait_until([] { return !FR::pot_hold; }, 20000),
        "колесо не идёт — удержание выключается");
  CHECK(has(board_fr, "расхождение"), "note о расхождении: %s", board_fr.serial.output.c_str());
  CHECK(board_fr.steps_lost > 0, "модель действительно держала колесо: потерь %ld",
        board_fr.steps_lost);
}

// Колесо едет, но до цели не доходит (люфт/помеха): 6 подходов, потом пауза.
static void scenario_pot_hold_passes() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(FR::pot_hold, "удержание включено");
  manual_shift(2.3);
  block_wheel_downwards();
  sim::run_for_ms(60);
  board_fr.serial.output.clear();
  CHECK(wait_until([] { return FR::pot_hold_retries > 0; }, 20000),
        "после серии подходов — пауза и счётчик");
  CHECK(has(board_fr, "подходов подряд без результата"),
        "note о серии подходов: %s", board_fr.serial.output.c_str());
  CHECK(FR::pot_hold, "пауза не выключает удержание: попыток %u",
        (unsigned)FR::pot_hold_retries);
  CHECK((FR::moduleStatus() & FR::STATUS_POT_HOLD) != 0, "бит удержания остался");
  // В паузе мотор не дёргается: колесо стоит.
  const long steps = board_fr.steps;
  sim::run_for_ms(500);
  CHECK(board_fr.steps == steps, "в паузе удержание не двигает колесо");
}

static void scenario_pot_hold_guard() {
  boot({&board_fr});
  calibrate_fr();                       // ноль есть, q нет
  board_fr.serial.output.clear();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(!FR::pot_hold, "ph 1 без q отклонена");
  CHECK(has(board_fr, "нужен ноль руля и калибровка q"), "note с причиной: %s",
        board_fr.serial.output.c_str());
  CHECK(FR::pot_zero_valid && !FR::pot_calibrated, "отказ ph не сбросил калибровку");

  board_fr.serial.send("pm 0");
  sim::run_for_ms(5);
  board_fr.serial.output.clear();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(!FR::pot_hold, "без режима потенциометра удержания нет");
  CHECK(has(board_fr, "сначала pm 1"), "note про pm 1: %s", board_fr.serial.output.c_str());

  board_fr.serial.send("pm 1");
  sim::run_for_ms(5);
  calibrate_pot_fr();
  board_fr.serial.send("ph 2");
  sim::run_for_ms(5);
  CHECK(has(board_fr, "Шаблон: ph 0|1"), "неверный аргумент ph отклонён");
  board_fr.serial.send("ph 1 0");
  sim::run_for_ms(5);
  CHECK(!FR::pot_hold, "лишний аргумент ph отклонён");

  board_fr.serial.send("w 10");
  sim::run_for_ms(5);
  board_fr.serial.output.clear();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(!FR::pot_hold, "ph 1 на ходу отклонена");
  CHECK(has(board_fr, "сначала s"), "note про остановку: %s", board_fr.serial.output.c_str());
  CHECK(wait_until(fr_settled, 3000), "поворот закончился");
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(FR::pot_hold, "после остановки ph 1 проходит");
  CHECK(FR::pot_calibrated && FR::pot_zero_valid, "калибровка при включении сохранена");
}

static void scenario_pot_hold_stop() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  const char* commands[] = {"b", "z", "k", "q", "s"};
  for (const char* command : commands) {
    board_fr.serial.send("ph 1");
    sim::run_for_ms(5);
    CHECK(FR::pot_hold, "ph 1 включает удержание перед «%s»", command);
    board_fr.serial.send(command);
    sim::run_for_ms(5);
    CHECK(!FR::pot_hold, "команда «%s» выключает удержание", command);
    CHECK(wait_until(fr_settled, 30000), "«%s» закончилась", command);
  }
  // A legacy n is now a STOP: it turns hold off but never releases BRAKE.
  board_fr.serial.send("b 5");
  sim::run_for_ms(2);
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(FR::pot_hold, "ph 1 включена перед старой командой n");
  const long releases = board_fr.brake_releases;
  board_fr.serial.send("n 5");
  sim::run_for_ms(5);
  CHECK(!FR::pot_hold && !FR::neutral_active && drive_idle(board_fr) &&
        board_fr.brake_releases == releases, "старый n выключает удержание и только тормозит");
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(FR::pot_hold, "старая команда не запирает обычное удержание");
  board_fr.serial.send("s");
  sim::run_for_ms(5);
}

// Выключение удержания не ждёт «сначала s»: пока колесо само подтягивает угол,
// плата занята, и запрет оставил бы оператора без выключателя.
static void scenario_pot_hold_off_busy() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(FR::pot_hold, "удержание включено перед ручным сдвигом");
  board_fr.min_period_us = 1000000;
  manual_shift(5.0);
  CHECK(wait_until([] { return FR::motorBusy(); }, 4000),
        "удержание начало подтягивать угол");
  board_fr.serial.output.clear();
  board_fr.serial.send("ph 0");
  sim::run_for_ms(5);
  CHECK(!FR::pot_hold, "ph 0 на ходу выключает удержание: %s",
        board_fr.serial.output.c_str());
  CHECK(has(board_fr, "Удержание выключено"), "подтверждение выключения");
  CHECK(!has(board_fr, "сначала s"), "выключение не требует «сначала s»");
  CHECK((FR::moduleStatus() & FR::STATUS_POT_HOLD) == 0, "бит удержания снят сразу");
  CHECK(wait_until([] { return !FR::motorBusy(); }, 5000), "текущий подход закончился");
  sim::run_for_ms(200);
  const long steps_after = board_fr.steps;
  manual_shift(5.0);
  sim::run_for_ms(2000);
  CHECK(board_fr.steps == steps_after, "после ph 0 колесо за рукой не едет");
  // Включить на ходу по-прежнему нельзя — но и это не мешает выключению.
  board_fr.serial.send("w 20");
  sim::run_for_ms(2);
  board_fr.serial.output.clear();
  board_fr.serial.send("ph 1");
  sim::run_for_ms(5);
  CHECK(!FR::pot_hold && has(board_fr, "сначала s"), "ph 1 на ходу отклонена");
  CHECK(wait_until(fr_settled, 30000), "w 20 закончилась");
}

static void scenario_pot_mode() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  board_fr.serial.send("pm 0");
  sim::run_for_ms(5);
  CHECK(!FR::pot_enabled && !FR::potFeedbackAllowed(), "pm 0 disables feedback");
  CHECK((FR::moduleStatus() & 0x3000) == 0x2000, "mode off reported");
  board_fr.pot_bias_steps = 6000;
  const int16_t raw = FR::pot_raw;
  board_fr.serial.send("w 10");
  sim::run_for_ms(5);
  board_fr.serial.send("pm 1");
  sim::run_for_ms(5);
  CHECK(!FR::pot_enabled, "cannot switch during motion");
  CHECK(wait_until(fr_settled, 3000), "open loop move completes");
  CHECK(FR::stepNow() == FR::degreesToSteps(10), "open loop target reached");
  CHECK(FR::pot_raw == raw, "disabled ADC ignored");
  board_fr.serial.send("q");
  sim::run_for_ms(5);
  CHECK(FR::pot_cal_state == FR::POT_CAL_IDLE, "q rejected when disabled");
  board_fr.serial.send("pm 2");
  sim::run_for_ms(5);
  CHECK(!FR::pot_enabled, "invalid mode rejected");
  board_fr.serial.send("pm 1");
  sim::run_for_ms(5);
  CHECK(FR::pot_enabled && !FR::pot_calibrated, "enable requires fresh calibration");
  CHECK((FR::moduleStatus() & 0x3000) == 0x3000, "mode on reported");
}

static void scenario_pot_unplugged() {
  board_fr.pot_present = false;
  boot({&board_fr});
  CHECK(has(board_fr, "потенциометр A0: 1023 — на краю"), "boot без датчика: %s",
        board_fr.serial.output.c_str());
  calibrate_fr();
  CHECK(FR::zero_set && !FR::pot_zero_valid && !FR::pot_calibrated,
        "без потенциометра ноль руля есть, доводки нет");
  board_fr.serial.send("q");
  sim::run_for_ms(5);
  CHECK(FR::pot_cal_state == FR::POT_CAL_IDLE, "q без датчика отклонена");
  CHECK(has(board_fr, "на краю, проверьте провод"), "сообщение об обрыве");
  board_fr.serial.send("w 10");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == 1333; }, 1000),
        "повороты без потенциометра работают, сейчас %ld", (long)FR::stepNow());
  CHECK(board_fr.phys == 1333, "phys=%ld", board_fr.phys);
}

static void scenario_swing() {
  boot({&board_fr});
  board_fr.serial.send("z");
  sim::run_for_ms(2);
  board_fr.reset_stats();
  board_fr.serial.send("c 20");
  sim::run_for_ms(1500);
  CHECK(board_fr.phys_min == 0 && board_fr.phys_max == 2667, "качание 0…20°: %ld…%ld",
        board_fr.phys_min, board_fr.phys_max);
  CHECK(FR::cycle_active, "цикл идёт");
  board_fr.serial.send("c c");
  sim::run_for_ms(5);
  const long at = board_fr.phys;
  sim::run_for_ms(300);
  CHECK(!FR::cycle_active && board_fr.phys == at, "c c останавливает качание");
  CHECK(has(board_fr, "ЦИКЛ качания на 20.00°") && has(board_fr, "ЦИКЛ ВЫКЛ. Угол:"), "сообщения цикла");
  board_fr.serial.send("c c");
  sim::run_for_ms(5);
  CHECK(has(board_fr, "Цикл и так выключен."), "повторное c c");
}

static void scenario_pause_resume() {
  boot({&board_fr});
  board_fr.serial.send("z");
  board_fr.serial.send("d 90 f");        // 12000 шагов ≈ 1,2 с
  sim::run_for_ms(300);
  board_fr.serial.send("s");
  sim::run_for_ms(5);
  const long paused = board_fr.phys;
  CHECK(paused > 2000 && paused < 4000, "стоп на ходу: phys=%ld", paused);
  CHECK(FR::stepNow() == paused, "счётчик совпадает с колесом после s: %ld vs %ld",
        (long)FR::stepNow(), paused);
  board_fr.serial.send("g");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == 12000; }, 2000),
        "g довёл до цели, сейчас %ld", (long)FR::stepNow());
  CHECK(board_fr.phys == 12000 && has(board_fr, "ПРОДОЛЖЕНИЕ..."), "phys=%ld", board_fr.phys);
  board_fr.serial.send("g");
  sim::run_for_ms(5);
  CHECK(has(board_fr, "Уже в цели."), "g без прерванного хода");
}

static void scenario_zero_manual() {
  board_fr.phys = 700;
  boot({&board_fr});
  board_fr.serial.send("w 5");
  sim::run_for_ms(20);
  CHECK(has(board_fr, "w: ноль не задан"), "w без нуля отклонена");
  CHECK(board_fr.phys == 700, "без нуля абсолютная команда не двигает колесо");
  board_fr.serial.send("z");
  sim::run_for_ms(2);
  CHECK(FR::zero_set && FR::home_source == FR::HOME_MANUAL && FR::stepNow() == 0, "z — ручной ноль");
  CHECK((FR::moduleStatus() & FR::STATUS_HOME_OPTO) == 0, "ручной ноль не помечен как датчик");
  board_fr.serial.send("w -5");
  CHECK(wait_until([] { return !FR::motorBusy() && FR::stepNow() == -667; }, 1000), "w -5 после z");
  CHECK(board_fr.phys == 700 - 667, "phys=%ld", board_fr.phys);
}

static void scenario_drive() {
  boot({&board_fr});
  board_fr.serial.send("t 8");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr) && board_fr.level[5] == HIGH, "без нуля тяга запрещена");
  board_fr.serial.send("z");
  board_fr.serial.send("t 8");
  sim::run_for_ms(5);
  CHECK(thrust_on(board_fr),
        "t 8 → тормоз снят и драйвер разрешён: BRAKE=%u STOP=%u",
        (unsigned)board_fr.level[5], (unsigned)board_fr.level[2]);
  board_fr.serial.send("d 5 f");
  sim::run_for_ms(20);
  CHECK(board_fr.phys == 0 && has(board_fr, "руль заблокирован: включена тяга"), "при тяге руль не крутится");
  for (int i = 0; i < 5; ++i) {
    board_fr.serial.send("t 8");
    sim::run_for_ms(200);
  }
  CHECK(FR::drive_active && thrust_on(board_fr),
        "heartbeat каждые 200 мс держит тягу");
  sim::run_for_ms(700);
  CHECK(!FR::drive_active && drive_idle(board_fr) && board_fr.level[5] == HIGH &&
            board_fr.level[2] == LOW,
        "watchdog 650 мс: нейтраль, тормоз, драйвер выключен");
  CHECK(has(board_fr, "нет команды дольше 650 мс"), "сообщение watchdog");
  // A tagged b is acknowledged only after applying the brake. A plain b
  // invalidates that ACK; an old STOP cannot confirm a newer one.
  board_fr.serial.send("b 123456");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr) && FR::brake_id == 123456, "tagged brake acknowledged after stop");
  sim::run_for_ms(260);
  CHECK(has(board_fr, "brake_id=123456"), "tagged brake is present in telemetry");
  board_fr.serial.send("b");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr) && FR::brake_id == 0, "ordinary b clears stale ACK");
  board_fr.serial.send("b bad");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr) && FR::brake_id == 0, "malformed tag still brakes");
  board_fr.serial.send("t 8");
  board_fr.serial.send("t -8");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr) && board_fr.level[5] == HIGH, "реверс без остановки — тормоз");
  board_fr.serial.send("t 101");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr), "t 101 — больше 100 % не бывает, тормоз");
  board_fr.serial.send("t 8");
  sim::run_for_ms(5);
  board_fr.serial.send("s");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr) && board_fr.level[5] == HIGH, "s выключает и тягу");
}

// Прямая тяга с бортового экрана: никакого пересчёта и зависимости от руля/SC.
static void scenario_direct_servo() {
  boot({&board_fl, &board_fr});
  CHECK(!FR::zero_set, "ноль руля после включения не задан");
  board_fr.serial.send("d 10 f");
  sim::run_for_ms(2);
  CHECK(FR::motorBusy(), "руль движется до прямой команды");
  board_fr.serial.send("v 40");
  sim::run_for_ms(2);
  CHECK(FR::motorBusy() && servo_value(board_fr) == 40 && thrust_on(board_fr),
        "v 40 без нуля и при движении руля → Servo.write(40), got %d", servo_value(board_fr));
  CHECK(drive_idle(board_fl), "другая плата не затронута");

  for (int value = 0; value <= 150; ++value) {
    char command[16];
    std::snprintf(command, sizeof(command), "v %d", value);
    board_fr.serial.send(command);
    sim::run_for_ms(2);
    CHECK(servo_value(board_fr) == value, "v %d → Servo.write(%d), got %d",
          value, value, servo_value(board_fr));
    CHECK(value == 0 ? drive_idle(board_fr) : thrust_on(board_fr),
          "v %d: уровни BRAKE/STOP", value);
  }

  // Ни отсутствие нуля, ни молчащий SC не гасят прямое значение: только
  // heartbeat, а не какой-либо датчик, поддерживает watchdog в 650 мс.
  for (int i = 0; i < 20; ++i) {
    board_fr.serial.send("v 150");
    sim::run_for_ms(200);
    CHECK(servo_value(board_fr) == 150 && thrust_on(board_fr),
          "v 150 держится без тахометра, тик %d", i);
  }
  CHECK(has(board_fr, "sv=150 "), "в телеметрии фактическое Servo.write(150)");
  sim::run_for_ms(700);
  CHECK(drive_idle(board_fr) && !FR::drive_active, "без heartbeat watchdog ставит 0");

  board_fl.serial.send("v FR 75");
  board_fr.serial.send("v FR 75");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fl) && servo_value(board_fr) == 75,
        "адресная v FR 75 не трогает FL");
  for (const char* invalid : {"v -1", "v 151", "v 1.5", "v abc", "v 50 60"}) {
    board_fr.serial.send("v 40");
    sim::run_for_ms(2);
    board_fr.serial.send(invalid);
    sim::run_for_ms(2);
    CHECK(drive_idle(board_fr), "неверная команда %s не включает мотор", invalid);
  }
  board_fr.serial.send("v 1");
  sim::run_for_ms(2);
  CHECK(FR::drive_active && servo_value(board_fr) == 1, "минимум — именно Servo.write(1)");
  board_fr.serial.send("b");
  sim::run_for_ms(2);
  CHECK(drive_idle(board_fr), "b выключает прямую тягу");
}

static std::vector<sim::Board*> all_boards();

// Число ползунка должно оставаться тем же для каждого направления и платы.
static void scenario_direct_directions() {
  boot(all_boards());
  for (sim::Board* board : all_boards()) {
    CHECK(board->servo_pin == 3 && board->servo_running(), "%s: Servo на D3", board->name);
    CHECK(board->tach_fn != nullptr && board->tach_irq == 4 && board->tach_mode == CHANGE &&
          board->mode[19] == INPUT_PULLUP, "%s: SC на D19 считает оба фронта", board->name);
  }
  for (const char direction : {'f', 'b'}) {
    for (int value = 0; value <= 150; ++value) {
      char command[20];
      std::snprintf(command, sizeof(command), "v %d %c", value, direction);
      for (sim::Board* board : all_boards()) board->serial.send(command);
      sim::run_for_ms(2);
      for (sim::Board* board : all_boards()) {
        CHECK(servo_value(*board) == value,
              "%s %s: Servo.write(%d), получено %d", board->name, command, value, servo_value(*board));
        CHECK(value == 0 ? drive_idle(*board) : thrust_on(*board),
              "%s %s: уровни STOP/BRAKE", board->name, command);
      }
      if (value) {
        const uint8_t left = direction == 'f' ? HIGH : LOW;
        const uint8_t right = direction == 'f' ? LOW : HIGH;
        CHECK(board_fl.level[4] == left && board_rl.level[4] == left &&
              board_fr.level[4] == right && board_rr.level[4] == right,
              "%s: правильное направление с учётом зеркальных колёс", command);
      }
    }
  }
  board_fl.serial.send("v FR 40 f");
  board_fr.serial.send("v FR 40 f");
  sim::run_for_ms(5);
  CHECK(servo_value(board_fl) == 150 && servo_value(board_fr) == 40,
        "адресная команда меняет только FR и сохраняет число");
  board_fr.serial.send("v FR 40 b");
  sim::run_for_ms(5);
  CHECK(servo_value(board_fr) == 40 && board_fr.level[4] == HIGH,
        "реверс FR меняет DIR, но не число 40");
  for (const char* invalid : {"v 40 x", "v 40 f extra", "v FR 40 b extra", "v -40 b"}) {
    board_fr.serial.send(invalid);
    sim::run_for_ms(2);
    CHECK(drive_idle(board_fr), "%s: неверное направление или значение останавливает", invalid);
  }
}

static void scenario_serial_garbage() {
  boot({&board_fl, &board_fr, &board_rl, &board_rr});
  for (const char* chunk : {"@TLM deg=0.00 tgt=0.00 mov", "\x07\xff#"}) {
    for (const char* p = chunk; *p; ++p) board_fl.serial.input.push_back((uint8_t)*p);
    sim::run_for_ms(1200);               // обрывок без \n висит дольше секунды
  }
  board_fl.serial.send("k");
  sim::run_for_ms(5);
  CHECK(wheel_fl::calib_state != wheel_fl::CAL_IDLE, "после мусора в порту команда k всё равно выполнена");
  board_fl.serial.send("@TLM deg=0.00 tgt=0.00 moving=0 cal=0");
  board_fl.serial.send("# FL: эхо сообщения");
  sim::run_for_ms(5);
  CHECK(!has(board_fl, "Неизв. команда: @TLM") && !has(board_fl, "Неизв. команда: #"),
        "эхо телеметрии и сообщений не считается командой");
  board_fl.serial.send("d 1");            // частичный ввод человека с паузами < 1 с
  sim::run_for_ms(5);
  CHECK(has(board_fl, "Шаблон: d [градусы] [f/b]"), "обычные ошибки по-прежнему видны");
}


// ---------------------------------------------------------------- вся система
#define M wheel_fl
static std::vector<sim::Board*> all_boards() { return {&board_fl, &board_fr, &board_rl, &board_rr}; }

static bool all_idle() {
  return M::calib_state == M::CAL_IDLE && !M::motorBusy() &&
         wheel_fr::calib_state == wheel_fr::CAL_IDLE && !wheel_fr::motorBusy() &&
         wheel_rl::calib_state == wheel_rl::CAL_IDLE && !wheel_rl::motorBusy() &&
         wheel_rr::calib_state == wheel_rr::CAL_IDLE && !wheel_rr::motorBusy();
}

static bool all_zero() { return M::zero_set && wheel_fr::zero_set && wheel_rl::zero_set && wheel_rr::zero_set; }

static bool all_pot_idle() {
  return M::pot_cal_state == M::POT_CAL_IDLE && wheel_fr::pot_cal_state == wheel_fr::POT_CAL_IDLE &&
         wheel_rl::pot_cal_state == wheel_rl::POT_CAL_IDLE && wheel_rr::pot_cal_state == wheel_rr::POT_CAL_IDLE &&
         !M::motorBusy() && !wheel_fr::motorBusy() && !wheel_rl::motorBusy() && !wheel_rr::motorBusy();
}

// Сервер шлёт «k» на каждый порт: каждое колесо калибруется само.
static void calibrate_all() {
  board_fl.phys = -3000;
  board_fr.phys = 2500;                  // справа от флажка: поиск влево
  board_rl.phys = 40;                    // внутри флажка
  board_rr.phys = -9000;
  board_rr.flag_lo = 300;                // у RR флажок смещён: ноль будет на 500 шагах
  board_rr.flag_hi = 700;
  boot(all_boards());
  sim::run_for_ms(300);
  for (sim::Board* board : all_boards()) board->serial.send("k");
  sim::run_for_ms(5);
  CHECK(wait_until(all_idle, 30000), "калибровка всех колёс закончилась");
  sim::run_for_ms(300);                  // телеметрия всех четырёх колёс
}

// Identity is part of the telemetry and is covered by its CRC.
static void scenario_identity() {
  boot(all_boards());
  for (sim::Board* board : all_boards()) board->serial.send("@ID");
  sim::run_for_ms(300);
  for (sim::Board* board : all_boards()) {
    CHECK(!has(*board, "@ID"), "no discovery answer");
    const std::string role = std::string("@TLM mod=") + board->name + " deg=";
    CHECK(board->serial.output.find(role) != std::string::npos && has(*board, "crc="),
          "checksummed identity in telemetry for %s", board->name);
  }
  board_fl.serial.send("w RR 90");
  sim::run_for_ms(200);
  CHECK(wheel_fl::stepNow() == 0, "legacy foreign command ignored");
}

static void scenario_system_calibrate_all() {
  calibrate_all();
  CHECK(all_zero(), "ноль задан у всех: FL=%d FR=%d RL=%d RR=%d", M::zero_set, wheel_fr::zero_set,
        wheel_rl::zero_set, wheel_rr::zero_set);
  CHECK(std::labs(board_fl.phys) <= 1 && std::labs(board_fr.phys) <= 1 && std::labs(board_rl.phys) <= 1 &&
        std::labs(board_rr.phys - 500) <= 1,
        "колёса на нулях датчиков: %ld %ld %ld %ld", board_fl.phys, board_fr.phys, board_rl.phys,
        board_rr.phys);
  for (sim::Board* board : all_boards()) {
    const std::string tag = std::string("@TLM mod=") + board->name + " deg=0.00 tgt=0.00 moving=0 cal=1 cycle=0 calib=0";
    CHECK(board->serial.output.find(tag) != std::string::npos,
          "телеметрия %s после калибровки: %s", board->name, board->serial.output.c_str());
    const std::string done = std::string("# ") + board->name + ": Калибровка ЗАВЕРШЕНА!";
    CHECK(board->serial.output.find(done) != std::string::npos,
          "%s сам сообщает о калибровке", board->name);
    CHECK(has(*board, "home=opto err=0") && has(*board, "fw=25"), "поля home/err/fw в @TLM %s",
          board->name);
    check_signals(*board);
  }
}

static void scenario_system_server_commands() {
  calibrate_all();
  // Адресная команда с именем чужого колеса не выполняется.
  board_fl.serial.send("w FR 12.5");
  sim::run_for_ms(300);
  CHECK(wheel_fr::stepNow() == 0 && wheel_fl::stepNow() == 0,
        "w FR 12.5, пришедшая на FL, никого не крутит");
  // Своя команда — крутит только своё колесо.
  board_fr.serial.send("w FR 12.5");
  CHECK(wait_until([] { return !wheel_fr::motorBusy() && wheel_fr::stepNow() == 1667; }, 3000),
        "w FR 12.5 на своём порту: FR=%ld", (long)wheel_fr::stepNow());
  CHECK(wheel_fl::stepNow() == 0 && wheel_rl::stepNow() == 0, "остальные не тронуты");
  sim::run_for_ms(300);                  // телеметрия FR: tgt=12.50 в кадре
  CHECK(has(board_fr, "@TLM mod=FR deg=12.50 tgt=12.50 moving=0 cal=1"), "телеметрия FR на 12.5°");
  board_fl.serial.send("w FL -7");
  CHECK(wait_until([] { return !wheel_fl::motorBusy() && wheel_fl::stepNow() == -933; }, 3000),
        "w FL -7 — своё колесо: %ld", (long)wheel_fl::stepNow());
  board_rl.serial.send("w RL zero");
  sim::run_for_ms(50);
  CHECK(wheel_rl::home_source == wheel_rl::HOME_MANUAL, "w RL zero — ручной ноль RL");
  board_rr.serial.send("w RR calib");
  sim::run_for_ms(5);
  CHECK(wheel_rr::calib_state != wheel_rr::CAL_IDLE, "w RR calib запускает калибровку RR");
  CHECK(wait_until([] { return wheel_rr::calib_state == wheel_rr::CAL_IDLE; }, 30000) &&
        wheel_rr::home_source == wheel_rr::HOME_OPTO, "RR откалиброван заново");
  board_fr.serial.send("w XX 5");
  board_fl.serial.send("w FL 101");
  sim::run_for_ms(20);
  CHECK(has(board_fr, "неизвестный модуль XX"), "неизвестный модуль");
  CHECK(has(board_fl, "# FL: w: угол вне ±100°"), "предел угла у сервера");
  // Безымянная команда «w 90» работает на любом порту: так прошивают с руки.
  board_fr.serial.send("w 90");
  CHECK(wait_until([] { return !wheel_fr::motorBusy() && wheel_fr::stepNow() == 12000; }, 5000),
        "w 90 → 12000 шагов, сейчас %ld", (long)wheel_fr::stepNow());
  board_fr.serial.send("w FR 100");
  CHECK(wait_until([] { return !wheel_fr::motorBusy() && wheel_fr::stepNow() == 13333; }, 5000),
        "w FR 100 → 13333 шага, сейчас %ld", (long)wheel_fr::stepNow());
  board_fr.serial.send("w FR z");
  sim::run_for_ms(20);
  CHECK(wheel_fr::home_source == wheel_fr::HOME_MANUAL, "короткое w FR z — ручной ноль");
  board_fr.serial.send("w FR k");
  CHECK(wait_until([] { return wheel_fr::calib_state == wheel_fr::CAL_IDLE; }, 30000),
        "короткое w FR k — калибровка");
}

static void send_drive_heartbeat(int percent, int times) {
  char command[16];
  std::snprintf(command, sizeof(command), "t %d", percent);
  for (int i = 0; i < times; ++i) {
    for (sim::Board* board : all_boards()) board->serial.send(command);
    sim::run_for_ms(200);
  }
}

// Одинаковый импульс на входе «P» всех четырёх плат.
static bool all_thrust() {
  return thrust_on(board_fl) && thrust_on(board_fr) && thrust_on(board_rl) &&
         thrust_on(board_rr);
}

static bool all_wheels_stopped() {
  return drive_idle(board_fl) && drive_idle(board_fr) && drive_idle(board_rl) &&
         drive_idle(board_rr);
}

static void scenario_system_drive() {
  calibrate_all();
  send_drive_heartbeat(8, 3);
  CHECK(all_thrust(), "t 8 на все четыре порта: тяга у всех четырёх");
  for (sim::Board* board : all_boards()) board->serial.send("b");
  sim::run_for_ms(10);
  CHECK(all_wheels_stopped() && board_fl.level[5] == HIGH && board_rr.level[5] == HIGH,
        "b — нейтраль, тормоз и выключенный драйвер у всех");
  // Плата без нуля тягу не берёт: у каждой платы свой fail-safe.
  wheel_rl::zero_set = false;
  send_drive_heartbeat(8, 2);
  CHECK(drive_idle(board_rl) && thrust_on(board_fl) && thrust_on(board_fr),
        "RL без нуля не едет, остальные едут");
  wheel_rl::zero_set = true;
  send_drive_heartbeat(8, 1);
  CHECK(all_thrust(), "нули вернули — тяга снова у всех");
  sim::run_for_ms(800);
  CHECK(all_wheels_stopped(), "без heartbeat все стоят: нейтраль по watchdog");
  CHECK(has(board_fl, "нет команды дольше 650 мс"), "watchdog объяснён в журнале FL");
}

static void scenario_system_broadcast() {
  calibrate_all();
  for (sim::Board* board : all_boards()) board->serial.send("d 10 f");
  sim::run_for_ms(5);                    // команды обработаны — все в движении
  CHECK(wait_until(all_idle, 2000), "d 10 f у всех закончилась");
  CHECK(wheel_fl::stepNow() == 1333 && wheel_fr::stepNow() == 1333 && wheel_rl::stepNow() == 1333 &&
            wheel_rr::stepNow() == 1333,
        "рассылка на все порты — все четыре колеса +10°");
  for (sim::Board* board : all_boards()) board->serial.send("d 90 b");
  sim::run_for_ms(200);
  for (sim::Board* board : all_boards()) board->serial.send("s");
  sim::run_for_ms(5);
  const long fl = board_fl.phys;
  const long rr = board_rr.phys;
  sim::run_for_ms(300);
  CHECK(board_fl.phys == fl && board_rr.phys == rr, "s останавливает все колёса");
  for (sim::Board* board : all_boards()) board->serial.send("h");
  sim::run_for_ms(5);
  CHECK(wait_until(all_idle, 3000), "h у всех закончилась");
  CHECK(wheel_fl::stepNow() == 0 && wheel_fr::stepNow() == 0 && wheel_rl::stepNow() == 0 &&
            wheel_rr::stepNow() == 0,
        "h — все в нуле");
  board_rl.serial.send("p");
  sim::run_for_ms(5);
  CHECK(has(board_rl, "# RL: Текущий: 0.00° | Целевой: 0.00° [СТОИТ]"), "p показывает своё колесо");
  CHECK(has(board_rl, "колесо RL, прошивка v25"), "p называет колесо и прошивку");
  for (sim::Board* board : all_boards()) board->serial.send("pm 0");
  sim::run_for_ms(600);
  CHECK(!M::pot_enabled && !wheel_fr::pot_enabled && !wheel_rl::pot_enabled && !wheel_rr::pot_enabled,
        "pm 0 доходит до всех четырёх плат");
  CHECK(has(board_fl, "pm=0"), "disabled mode is in telemetry");
  for (sim::Board* board : all_boards()) board->serial.send("pm 1");
  sim::run_for_ms(600);
  CHECK(M::pot_enabled && wheel_fr::pot_enabled && wheel_rl::pot_enabled && wheel_rr::pot_enabled,
        "pm 1 доходит до всех четырёх плат");
  CHECK(has(board_fl, "pm=1"), "enabled mode is in telemetry");
}

// Пресет бортового экрана — это четыре команды подряд: FL, FR, RL, RR с
// интервалом в десятки миллисекунд (экран шлёт их по очереди, не дожидаясь
// окончания поворота). Проверяем, что мастер раздаёт всю пачку и что последнее
// в ней колесо не теряется: жалоба «RR всегда ничего не исполняет» означала бы,
// что четвёртая команда до слейва не доходит.
// Доводка по потенциометру доворачивает колесо на единицы градусов (люфт, увод),
// а не возит его по всей шкале. Если датчик расходится с целью сильно — сбился
// его ноль, изношена дорожка или не сделана q, — верить ему нельзя: раньше
// доводка догоняла именно датчик и утаскивала колесо на десятки градусов от
// команды («повернулось на 4° вместо 35°»), а привязка счётчика шагов к датчику
// заставляла телеметрию отрапортовать успех при колесе совсем не там.
static void scenario_pot_distrust() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  // Датчик «уехал» относительно колеса на 31°: так выглядит сбившийся ноль.
  board_fr.pot_bias_steps = 4133;
  board_fr.serial.send("w 35");
  sim::run_for_ms(2);
  CHECK(wait_until(fr_settled, 8000), "w 35 не закончилась");
  // Колесо осталось там, куда его привели шаги, а не там, где видит датчик.
  CHECK(board_fr.phys == 4667, "колесо на 35° (4667 шагов), а не %ld", board_fr.phys);
  CHECK(FR::stepNow() == 4667, "счётчик шагов не переписан датчиком: %ld",
        (long)FR::stepNow());
  CHECK(has(board_fr, "расхождение 31.08"), "расхождение названо оператору: %s",
        board_fr.serial.output.c_str());
  CHECK(has(board_fr, "доводка отключена"), "доводка честно отключена: %s",
        board_fr.serial.output.c_str());
  // В пределах доверия датчик по-прежнему доворачивает колесо (см. pot_feedback).
}

// Заклинивание колеса: драйвер продолжает получать импульсы, а колесо стоит.
// Прошивка считает СГЕНЕРИРОВАННЫЕ импульсы (current_step += step_dir), поэтому
// открытый контур по шагам уверен, что цель достигнута. Без откалиброванного
// потенциометра заметить это нечем — телеметрия рапортует 35° при колесе на 4°.
static void scenario_stalled_wheel_without_pot() {
  boot({&board_fr});
  calibrate_fr();
  board_fr.stall_enabled = true;
  board_fr.stall_phys = 533;                 // колесо клинит на 4°
  board_fr.serial.output.clear();
  board_fr.serial.send("w 35");
  sim::run_for_ms(2);
  CHECK(wait_until(fr_settled, 8000), "w 35 не закончилась");
  CHECK(board_fr.phys == 533, "колесо заклинило на 533 шагах, а не %ld", board_fr.phys);
  CHECK(board_fr.steps_lost > 4000, "потерянные импульсы посчитаны: %ld",
        board_fr.steps_lost);
  CHECK(FR::stepNow() == 4667, "счётчик шагов рапортует 35°: %ld", (long)FR::stepNow());
  CHECK(!FR::pot_calibrated, "без q доводка выключена — расхождение некому заметить");
}

// То же заклинивание, но потенциометр откалиброван: датчик видит настоящие 4°,
// расхождение с целью больше POT_TRUST_DEG, и оператору честно говорят, что
// колесо не там. Доводка при этом не пытается «догнать» цель через датчик.
static void scenario_stalled_wheel_with_pot() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  board_fr.stall_enabled = true;
  board_fr.stall_phys = 533;
  board_fr.serial.output.clear();
  board_fr.serial.send("w 35");
  sim::run_for_ms(2);
  CHECK(wait_until(fr_settled, 8000), "w 35 не закончилась");
  CHECK(board_fr.phys == 533, "колесо на 533 шагах: %ld", board_fr.phys);
  CHECK(has(board_fr, "расхождение"), "заклинивание названо оператору: %s",
        board_fr.serial.output.c_str());
  CHECK(has(board_fr, "доводка отключена"), "доводка честно отключена: %s",
        board_fr.serial.output.c_str());
}

// Наклон потенциометра — свойство железа, а не сессии. Пока он жил только в
// RAM, доводка после каждой перезагрузки молча выключалась (pot_calibrated =
// false), и колесо снова ездило вслепую. Теперь q достаточно выполнить один раз.
static void scenario_pot_slope_survives_reboot() {
  boot({&board_fr});
  calibrate_fr();
  calibrate_pot_fr();
  const float slope = FR::pot_counts_per_degree;
  CHECK(slope > 0.0f, "наклон измерен");
  // Перезагрузка платы. setup() не обнуляет глобалы скетча (в реальном AVR их
  // сбрасывает старт процессора), поэтому RAM-состояние pot гасим руками —
  // иначе pot_calibrated доживёт с прошлой калибровки и сценарий пройдёт
  // впустую, ничего не проверив.
  FR::pot_calibrated = false;
  FR::pot_zero_valid = false;
  FR::pot_counts_per_degree = FR::POT_NOMINAL_COUNTS_PER_DEG;
  board_fr.serial.output.clear();
  FR::setup();
  sim::run_for_ms(10);
  CHECK(FR::pot_calibrated, "наклон восстановлен из EEPROM без повторной q");
  CHECK(FR::pot_counts_per_degree == slope, "наклон тот же: %f != %f",
        (double)FR::pot_counts_per_degree, (double)slope);
  CHECK(has(board_fr, "наклон из EEPROM"), "оператору сказано, что наклон из памяти: %s",
        board_fr.serial.output.c_str());
}


// Пресет бортового экрана — это четыре адресные команды подряд: FL, FR, RL, RR
// с интервалом в десятки миллисекунд, каждая на свой порт. Последнее в пачке
// колесо (RR) не должно теряться: жалоба «RR всегда ничего не исполняет»
// означала бы, что четвёртая команда до платы не доходит.
static void scenario_preset_burst() {
  calibrate_all();
  const long rr_zero = (long)wheel_rr::stepNow();
  board_fl.serial.send("w FL 90");
  sim::run_for_ms(15);
  board_fr.serial.send("w FR 90");
  sim::run_for_ms(15);
  board_rl.serial.send("w RL 90");
  sim::run_for_ms(15);
  board_rr.serial.send("w RR 90");
  CHECK(wait_until(all_idle, 20000), "все четыре колеса доехали и остановились");
  CHECK(wheel_fl::stepNow() == 12000, "FL: 90° — это 12000 шагов, а не %ld", (long)wheel_fl::stepNow());
  CHECK(wheel_fr::stepNow() == 12000, "FR: %ld шагов", (long)wheel_fr::stepNow());
  CHECK(wheel_rl::stepNow() == 12000, "RL: %ld шагов", (long)wheel_rl::stepNow());
  CHECK((long)wheel_rr::stepNow() == rr_zero + 12000,
        "RR — последний в пачке — доехал: %ld шагов от нуля %ld",
        (long)wheel_rr::stepNow(), rr_zero);
  for (sim::Board* board : all_boards()) {
    CHECK(has(*board, "tgt=90.00"),
          "цель 90° в телеметрии %s видна экрану: %s", board->name,
          board->serial.output.c_str());
    check_signals(*board);
  }
}

// Identical instant encoded both ways for the server's cross-protocol test.
static void scenario_snapshot_dump() {
  boot({&board_fr});
  board_fr.serial.send("z");
  board_fr.serial.send("b 42");
  sim::run_for_ms(5);
  board_fr.serial.send("j 42 2 20 0");
  board_fr.serial.send("j 42 3 20 25");
  sim::run_for_ms(10);
  board_fr.tach_change();
  sim::run_for_ms(1);
  board_fr.serial.output.clear();
  wheel_fr::tx_position = wheel_fr::tx_length = 0;
  wheel_fr::appendFastTelemetry();
  wheel_fr::appendTelemetry();
  wheel_fr::txPump();
  std::fwrite(board_fr.serial.output.data(), 1, board_fr.serial.output.size(), stdout);
}

static void scenario_tlm_dump() {
  calibrate_all();
  for (sim::Board* board : all_boards()) board->serial.send("q");
  sim::run_for_ms(5);                    // команды обработаны — калибровка идёт
  CHECK(wait_until(all_pot_idle, 30000), "калибровка потенциометров всех колёс");
  board_fr.serial.send("w FR 12.5");
  sim::run_for_ms(700);
  for (sim::Board* board : all_boards()) {
    std::printf("PORT %s\n", board->name);
    std::fwrite(board->serial.output.data(), 1, board->serial.output.size(), stdout);
  }
}

// ./sim pty /tmp/wheel — четыре колеса в реальном времени за псевдотерминалами
// /tmp/wheel-FL … /tmp/wheel-RR: задайте вручную RC_WHEEL_FL/FR/RL/RR_PORT и видит настоящую логику прошивки — для ручной проверки без железа.
static int run_pty(const char* link_base) {
  bind_boards();  // имена нужны уже при создании ссылок на псевдотерминалы
  struct Link {
    int fd;
    std::string path;
    size_t sent = 0;
  };
  std::vector<Link> links;
  for (sim::Board* board : all_boards()) {
    const int fd = posix_openpt(O_RDWR | O_NOCTTY);
    if (fd < 0 || grantpt(fd) != 0 || unlockpt(fd) != 0) {
      std::perror("posix_openpt");
      return 2;
    }
    // Сторона робота сразу в raw-режиме: без эха телеметрии обратно в «сервер».
    const int slave = open(ptsname(fd), O_RDWR | O_NOCTTY);
    if (slave >= 0) {
      termios mode;
      if (tcgetattr(slave, &mode) == 0) {
        cfmakeraw(&mode);
        tcsetattr(slave, TCSANOW, &mode);
      }
      close(slave);
    }
    Link link;
    link.fd = fd;
    link.path = std::string(link_base) + "-" + board->name;
    unlink(link.path.c_str());
    if (symlink(ptsname(fd), link.path.c_str()) != 0) {
      std::perror("symlink");
      return 2;
    }
    fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
    links.push_back(link);
  }
  board_fl.phys = -3000;
  board_fr.phys = 2500;
  board_rl.phys = 40;
  board_rr.phys = -9000;
  // Test-only initial EEPROM corruption, applied before the firmware boots.
  if (const char* bad_zero = std::getenv("RC_SIM_BAD_ZERO")) {
    const std::string selected = std::string(",") + bad_zero + ",";
    for (sim::Board* board : all_boards()) {
      if (selected.find(std::string(",") + board->name + ",") != std::string::npos)
        board->eeprom[16] = 0x42;  // non-empty invalid full-zero slot
    }
  }
  // Simulate an EEPROM that remains unwritable during service recovery.
  if (const char* failed_eeprom = std::getenv("RC_SIM_EEPROM_FAIL")) {
    const std::string selected = std::string(",") + failed_eeprom + ",";
    for (sim::Board* board : all_boards())
      if (selected.find(std::string(",") + board->name + ",") != std::string::npos)
        board->eeprom_writes_left = 0;
  }
  boot(all_boards());
  // Тест может независимо подать на четыре входа фиксированные частоты SC.
  // По умолчанию переходов нет, модель зависимости от Servo не создаётся.
  if (const char* frequencies = std::getenv("RC_SIM_SC_HZ")) {
    unsigned hz[4] = {0, 0, 0, 0};
    if (std::sscanf(frequencies, "%u,%u,%u,%u", &hz[0], &hz[1], &hz[2], &hz[3]) == 4) {
      const auto boards = all_boards();
      for (size_t i = 0; i < boards.size(); ++i) {
        if (hz[i] && hz[i] <= 10000) {
          boards[i]->tach_period_us = 1000000LL / hz[i];
          boards[i]->tach_next_edge_us = sim::now_us + boards[i]->tach_period_us;
        }
      }
    }
  }
  // Только для интеграционных тестов: искусственная модель SC следует
  // команде тяги. Это не модель инерции, сцепления или реальных моторов.
  const bool follow_drive = std::getenv("RC_SIM_SC_FOLLOW_DRIVE") != nullptr;
  std::printf("колёса: %s-FL … %s-RR → псевдотерминалы\n", link_base, link_base);
  std::fflush(stdout);
  const auto wall_start = std::chrono::steady_clock::now();
  const int64_t sim_start = sim::now_us;
  for (;;) {
    std::vector<sim::Board*> boards = all_boards();
    for (size_t i = 0; i < links.size(); ++i) {
      char buffer[256];
      const ssize_t got = read(links[i].fd, buffer, sizeof(buffer));
      for (ssize_t j = 0; j < got; ++j) boards[i]->serial.input.push_back((uint8_t)buffer[j]);
    }
    if (follow_drive) {
      const int values[4] = {wheel_fl::drive_percent, wheel_fr::drive_percent,
                             wheel_rl::drive_percent, wheel_rr::drive_percent};
      const bool active[4] = {wheel_fl::drive_active, wheel_fr::drive_active,
                              wheel_rl::drive_active, wheel_rr::drive_active};
      for (size_t i = 0; i < boards.size(); ++i) {
        const int hz = active[i] ? std::abs(values[i]) * 12 : 0;
        const int64_t period = hz ? 1000000LL / hz : 0;
        if (period && !boards[i]->tach_period_us) boards[i]->tach_next_edge_us = sim::now_us + period;
        boards[i]->tach_period_us = period;
      }
    }
    sim::run_for_ms(10);
    for (size_t i = 0; i < links.size(); ++i) {
      const std::string& out = boards[i]->serial.output;
      if (out.size() > links[i].sent) {
        const ssize_t written = write(links[i].fd, out.data() + links[i].sent, out.size() - links[i].sent);
        if (written > 0) links[i].sent += (size_t)written;
      }
    }
    std::this_thread::sleep_until(wall_start + std::chrono::microseconds(sim::now_us - sim_start));
  }
}

// Драйвер скорости — RioRand ZS-Z11H: вход «P» (ШИМ 0…100 %), DIR, BRAKE, STOP.
// Настроек у тяги нет: проценты переводятся в серво-импульс по константам
// прошивки, а команда «m» (прежняя настройка) больше не принимается.
static void scenario_drive_hardware() {
  boot({&board_fr});
  board_fr.serial.send("z");
  sim::run_for_ms(2);

  // SC включён только в диагностическом канале, не в старой одометрии.
  CHECK(board_fr.tach_fn != nullptr && board_fr.tach_irq == 4 && board_fr.tach_mode == CHANGE &&
        board_fr.mode[19] == INPUT_PULLUP, "прерывание SC подключено на оба фронта D19");
  sim::run_for_ms(300);
  CHECK(has(board_fr, "tach=0") && has(board_fr, "sc_rpm=0.0") && has(board_fr, "sc_ppr=90"),
        "@TLM несёт отдельное значение SC; старый режим выключен: %s",
        board_fr.serial.output.c_str());
  CHECK(has(board_fr, "duty=0 "), "в @TLM нулевая скважность покоя: %s",
        board_fr.serial.output.c_str());
  CHECK(has(board_fr, "dmax=100"), "в @TLM предел тяги 100 %: %s",
        board_fr.serial.output.c_str());
  CHECK((int)wheel_fr::DRIVE_MAX_PERCENT == 100, "предел тяги — 100 %: %u",
        (unsigned)wheel_fr::DRIVE_MAX_PERCENT);
  // Шкала та же, что в проверенном скетче: Servo.write 0…180 — это 0…100 % тяги.
  CHECK((int)wheel_fr::DRIVE_SERVO_MAX_VALUE == 180, "верх шкалы — 180, а не %u",
        (unsigned)wheel_fr::DRIVE_SERVO_MAX_VALUE);
  CHECK((int)wheel_fr::DRIVE_SERVO_TENTHS_PER_PERCENT == 18, "1 %% = 1,8 значения: %u",
        (unsigned)wheel_fr::DRIVE_SERVO_TENTHS_PER_PERCENT);
  // Сигнал выдаёт библиотека Servo на D3 — вход «P» драйвера.
  CHECK(board_fr.mode[3] == OUTPUT && board_fr.servo_running() && board_fr.servo_pin == 3,
        "Servo работает на D3: mode=%u pin=%u", (unsigned)board_fr.mode[3],
        (unsigned)board_fr.servo_pin);

  // Прямая связь «процент → значение», без разгона и поиска: как в скетче.
  board_fr.serial.send("t 10");
  sim::run_for_ms(2);
  CHECK(thrust_on(board_fr), "t 10 — тяга включена");
  CHECK(servo_value(board_fr) == 18, "10 %% — это значение 18 на «P»: %d",
        servo_value(board_fr));

  // Предел прошивки — 100 % шкалы, то есть значение 180.
  board_fr.serial.send("b");
  sim::run_for_ms(2);
  board_fr.serial.send("t 100");
  sim::run_for_ms(2);
  CHECK(thrust_on(board_fr), "t 100 (предел) принимается: BRAKE=%u STOP=%u",
        (unsigned)board_fr.level[5], (unsigned)board_fr.level[2]);
  CHECK(servo_value(board_fr) == 180, "100 %% — это верх шкалы 180: %d",
        servo_value(board_fr));
  CHECK(board_fr.servo_pulse_us() == 2400, "и импульс 2,4 мс: %d мкс",
        board_fr.servo_pulse_us());

  // Выше шкалы плата команду не берёт и гасит выход: 101 % … 120 %.
  for (int percent = 101; percent <= 120; ++percent) {
    char command[12];
    snprintf(command, sizeof(command), "t %d", percent);
    board_fr.serial.send("t 100");
    sim::run_for_ms(2);
    board_fr.serial.send(command);
    sim::run_for_ms(2);
    CHECK(drive_idle(board_fr), "t %d выше шкалы 100 %% — выход погашен, значение %d",
          percent, servo_value(board_fr));
  }

  // Весь рабочий диапазон 1 % … 100 %: значение на «P» растёт вместе с процентом
  // и никогда не выходит за шкалу 0…180.
  int previous = 0;
  for (int percent = 1; percent <= 100; ++percent) {
    char command[12];
    snprintf(command, sizeof(command), "t %d", percent);
    board_fr.serial.send("b");
    sim::run_for_ms(2);
    board_fr.serial.send(command);
    sim::run_for_ms(2);
    CHECK(thrust_on(board_fr), "t %d — тяга включена", percent);
    const int value = servo_value(board_fr);
    CHECK(value >= previous && value <= 180,
          "t %d: значение %d в шкале и не меньше прошлого (%d)", percent, value, previous);
    CHECK(value == (percent * 18 + 5) / 10, "t %d: значение %d вместо %d",
          percent, value, (percent * 18 + 5) / 10);
    previous = value;
  }

  // Назад — то же самое, только другой уровень DIR.
  board_fr.serial.send("b");
  sim::run_for_ms(2);
  const uint8_t forward_dir = board_fr.level[4];
  board_fr.serial.send("t -100");
  sim::run_for_ms(2);
  CHECK(thrust_on(board_fr) && board_fr.level[4] != forward_dir,
        "t -100: тяга включена, DIR перевёрнут");
  board_fr.serial.send("b");
  sim::run_for_ms(2);

  // Настроек больше нет: «m» — неизвестная команда, а не тихая смена выходов.
  const size_t before = board_fr.serial.output.size();
  board_fr.serial.send("m trim 1600");
  board_fr.serial.send("m max 6");
  board_fr.serial.send("m ppr 60");
  sim::run_for_ms(2);
  const std::string tail = board_fr.serial.output.substr(before);
  CHECK(tail.find("Неизв. команда: m") != std::string::npos,
        "«m …» больше не настройка: %s", tail.c_str());
  board_fr.serial.send("t 10");
  sim::run_for_ms(2);
  CHECK(thrust_on(board_fr), "после «m» тяга включается по-прежнему: %d %%·10",
        duty_permille(board_fr));
  board_fr.serial.send("b");
  sim::run_for_ms(2);

  // В покое драйвер выключен и заторможен — это и есть безопасное состояние.
  CHECK(board_fr.level[2] == LOW && board_fr.level[5] == HIGH,
        "в покое STOP = 0 (выходы выключены), BRAKE = 1");
  board_fr.serial.send("t 5");
  sim::run_for_ms(2);
  CHECK(board_fr.level[2] == HIGH && board_fr.level[5] == LOW,
        "на время тяги: STOP = 1 (разрешено), BRAKE = 0 (отпущен)");
  board_fr.serial.send("b");
  sim::run_for_ms(2);
  CHECK(board_fr.level[2] == LOW && board_fr.level[5] == HIGH &&
            duty_permille(board_fr) == 0,
        "стоп: выходы выключены, тормоз взведён, скважность нулевая");
}

// Искусственные переходы SC: равномерно за отведённое время, независимо от
// команд тяги. run_for_ms тикает loop() и окно замера оборотов (500 мс).
static void spin_tach(sim::Board* board, int edges, double over_ms) {
  if (edges <= 0) {
    sim::run_for_ms(over_ms);
    return;
  }
  const double step_ms = over_ms / (double)edges;
  for (int i = 0; i < edges; ++i) {
    sim::run_for_ms(step_ms);
    board->tach_change();
  }
}

// Проверяем команды и номинальную длительность импульса Servo, не выдумывая
// зависимость оборотов от значения: настоящий драйвер и мотор не моделируются.
static void scenario_drive_speed() {
  boot({&board_fr});
  board_fr.serial.send("z");
  sim::run_for_ms(2);
  CHECK(wheel_fr::DRIVE_MAX_PERCENT == 100, "верх старой шкалы — 100 %%");
  CHECK((int)wheel_fr::DRIVE_SERVO_MAX_VALUE == 180, "100 %% старой шкалы — write(180)");

  int previous_pulse = 0;
  for (int percent = 1; percent <= 100; ++percent) {
    char command[16];
    std::snprintf(command, sizeof(command), "t %d", percent);
    board_fr.serial.send(command);
    sim::run_for_ms(2);
    const int expected = (percent * 18 + 5) / 10;
    CHECK(servo_value(board_fr) == expected && thrust_on(board_fr),
          "t %d → Servo.write(%d), получено %d", percent, expected, servo_value(board_fr));
    CHECK(board_fr.servo_pulse_us() > previous_pulse,
          "разные значения Servo дают разные номинальные импульсы");
    previous_pulse = board_fr.servo_pulse_us();
  }

  // Новые значения меняются на лету без остановки и без пересчёта.
  board_fr.serial.send("v 2 f");
  sim::run_for_ms(2);
  CHECK(servo_value(board_fr) == 2 && board_fr.servo_pulse_us() == 564 && thrust_on(board_fr),
        "write(2) → около 564 мкс на D3");
  board_fr.serial.send("v 150 f");
  sim::run_for_ms(2);
  CHECK(servo_value(board_fr) == 150 && board_fr.servo_pulse_us() == 2090 && thrust_on(board_fr),
        "write(150) → около 2090 мкс на D3");
  board_fr.serial.send("v 2 f");
  sim::run_for_ms(2);
  CHECK(servo_value(board_fr) == 2 && board_fr.servo_pulse_us() == 564 && thrust_on(board_fr),
        "write(2) после write(150) → снова около 564 мкс");

  // Молчание SC более 3 с не обрывает старую команду: канал только для показа.
  for (int i = 0; i < 40; ++i) {
    board_fr.serial.send("t 100");
    sim::run_for_ms(200);
    CHECK(servo_value(board_fr) == 180 && thrust_on(board_fr),
          "SC не влияет на старую команду, тик %d", i);
  }
  CHECK(board_fr.tach_fn != nullptr, "SC считывается, но не управляет тягой");
  board_fr.serial.send("b");
  sim::run_for_ms(2);
}

// Зеркальные колёса: FR и RR стоят на другой стороне, поэтому «вперёд» у них —
// противоположный уровень DIR. Настраивать нечего: имя уже в прошивке.
static void scenario_mirrored_wheels() {
  boot(all_boards());
  for (sim::Board* board : all_boards()) board->serial.send("z");
  sim::run_for_ms(2);
  CHECK(!wheel_fl::drive_mirrored && !wheel_rl::drive_mirrored,
        "FL и RL — прямые колёса");
  CHECK(wheel_fr::drive_mirrored && wheel_rr::drive_mirrored,
        "FR и RR — зеркальные");

  // «Вперёд» у левого и правого борта — разные уровни DIR, но едут они в одну
  // сторону корпуса.
  for (sim::Board* board : all_boards()) board->serial.send("t 20");
  sim::run_for_ms(5);
  CHECK(board_fl.level[4] != board_fr.level[4],
        "«вперёд» FL и FR — разные уровни DIR: FL=%d FR=%d",
        board_fl.level[4], board_fr.level[4]);
  CHECK(board_rl.level[4] != board_rr.level[4],
        "«вперёд» RL и RR — разные уровни DIR: RL=%d RR=%d",
        board_rl.level[4], board_rr.level[4]);
  CHECK(board_fl.level[4] == board_rl.level[4],
        "левые колёса согласованы: FL=%d RL=%d", board_fl.level[4], board_rl.level[4]);
  CHECK(board_fr.level[4] == board_rr.level[4],
        "правые колёса согласованы: FR=%d RR=%d", board_fr.level[4], board_rr.level[4]);

  // «Назад» у зеркального — ровно наоборот от своего «вперёд».
  const uint8_t fr_forward = board_fr.level[4];
  board_fr.serial.send("b");
  sim::run_for_ms(2);
  board_fr.serial.send("t -20");
  sim::run_for_ms(5);
  CHECK(board_fr.level[4] != fr_forward, "«назад» у FR переворачивает DIR: %d",
        board_fr.level[4]);
  CHECK(wheel_fr::drive_active, "и тяга тоже включается: %d %%·10", duty_permille(board_fr));

  for (sim::Board* board : all_boards()) board->serial.send("b");
  sim::run_for_ms(5);
}

// Тяга одного колеса: сервер шлёт «t FL 8» на каждый порт, а колесо берёт
// только своё имя. Раньше на «t FL 8» плата видела второй аргумент и гасила
// выход — то есть адресная тяга не работала бы вовсе.
static void scenario_drive_one_wheel() {
  calibrate_all();
  board_fl.serial.send("t FL 8");
  sim::run_for_ms(2);
  CHECK(wheel_fl::drive_active && thrust_on(board_fl),
        "своё имя во «t FL 8» не мешает тяге: %d %%·10", duty_permille(board_fl));
  CHECK(!wheel_fr::drive_active && drive_idle(board_fr),
        "чужое имя «t FL 8» на FR ничего не включает: %d %%·10", duty_permille(board_fr));
  CHECK(!wheel_rr::drive_active && drive_idle(board_rr), "и на RR тоже");

  // Heartbeat идёт только на FL: остальные стоят, а через 650 мс FL встаёт сам.
  for (int i = 0; i < 3; ++i) {
    board_fl.serial.send("t FL 8");
    sim::run_for_ms(200);
  }
  CHECK(wheel_fl::drive_active, "heartbeat «t FL 8» держит только FL");
  sim::run_for_ms(700);
  CHECK(!wheel_fl::drive_active && drive_idle(board_fl), "без heartbeat FL встал по watchdog");

  // Разные колёса едут в разные стороны — так и делается разворот на месте.
  board_fl.serial.send("t FL 6");
  board_fr.serial.send("t FR -6");
  sim::run_for_ms(2);
  CHECK(wheel_fl::drive_active && wheel_fr::drive_active,
        "FL и FR едут одновременно");
  // FR — зеркальное колесо: «назад» у него это тот же уровень DIR, что «вперёд»
  // у FL, то есть физически колёса едут в одну сторону.
  CHECK(board_fl.level[4] == board_fr.level[4],
        "FL вперёд и FR назад — один уровень DIR: FL=%d FR=%d",
        board_fl.level[4], board_fr.level[4]);
  CHECK(drive_idle(board_rl) && drive_idle(board_rr), "RL и RR стоят");
  board_fl.serial.send("t FL 0");
  sim::run_for_ms(2);
  CHECK(!wheel_fl::drive_active && drive_idle(board_fl), "«t FL 0» — стоп только FL");
  CHECK(wheel_fr::drive_active, "FR продолжает ехать");
  for (sim::Board* board : all_boards()) board->serial.send("b");
  sim::run_for_ms(2);
  CHECK(!wheel_fr::drive_active && drive_idle(board_fr), "b — тормоз всем");

  // Имя без числа и чужое неизвестное имя честно объяснены оператору.
  board_fl.serial.send("t FL");
  board_fl.serial.send("t FX 8");
  sim::run_for_ms(2);
  CHECK(has(board_fl, "Шаблон: t [FL]"), "подсказка по «t FL» без числа");
  CHECK(has(board_fl, "неизвестный модуль FX"), "неизвестное имя колеса объяснено");
}

struct Scenario {
  const char* name;
  void (*fn)();
};

// SC — независимые искусственные переходы, не модель зависимости мотора от
// Servo. Проверяем полный путь D19 → прерывание → @TLM, отсутствие влияния на
// обе команды тяги и корректную остановку показания после прекращения импульсов.
static void scenario_tach_display() {
  boot(all_boards());
  const int hz[4] = {90, 180, 45, 0};
  const auto boards = all_boards();
  for (size_t i = 0; i < boards.size(); ++i) {
    sim::Board* board = boards[i];
    CHECK(board->mode[19] == INPUT_PULLUP && board->tach_irq == 4 &&
          board->tach_mode == CHANGE && board->tach_fn,
          "%s: оба фронта SC подключены к D19", board->name);
    if (hz[i]) {
      board->tach_period_us = 1000000LL / hz[i];
      board->tach_next_edge_us = sim::now_us + board->tach_period_us;
    }
  }
  sim::run_for_ms(2100);
  CHECK(std::abs((long)wheel_fl::tach_display_rpm_x10 - 600L) <= 3, "FL 90 Гц ≈ 60 об/мин: %lu", (unsigned long)wheel_fl::tach_display_rpm_x10);
  CHECK(std::abs((long)wheel_fr::tach_display_rpm_x10 - 1200L) <= 4, "FR 180 Гц ≈ 120 об/мин: %lu", (unsigned long)wheel_fr::tach_display_rpm_x10);
  CHECK(std::abs((long)wheel_rl::tach_display_rpm_x10 - 300L) <= 3, "RL 45 Гц ≈ 30 об/мин: %lu", (unsigned long)wheel_rl::tach_display_rpm_x10);
  CHECK(wheel_rr::tach_display_rpm_x10 == 0, "RR без переходов — 0");
  CHECK(std::abs((long)wheel_fl::tach_edges_total - 189L) <= 1, "FL считает каждый принятый фронт");
  CHECK(std::abs((long)wheel_fr::tach_edges_total - 378L) <= 1, "FR считает каждый принятый фронт");
  CHECK(std::abs((long)wheel_rl::tach_edges_total - 94L) <= 1, "RL считает каждый принятый фронт");
  CHECK(wheel_rr::tach_edges_total == 0, "RR без фронтов: счётчик 0");
  for (sim::Board* board : boards) {
    CHECK(drive_idle(*board), "%s: импульсы не включают тягу", board->name);
    CHECK(has(*board, "tach=0 ") && has(*board, "sc_rpm=") &&
          has(*board, "sc_hz=") && has(*board, "sc_ppr=90 ") && has(*board, "sc_count="),
          "%s: отдельные поля SC и выключенный старый тахометр", board->name);
    CHECK(!has(*board, " rpm=") && !has(*board, " hz=") && !has(*board, " ppr="),
          "%s: для старой одометрии обороты отсутствуют", board->name);
  }

  board_fr.serial.send("v 75 b");
  for (int i = 0; i < 25; ++i) {
    if (i == 8) board_fr.tach_period_us = 0;  // обрыв/остановка не гасит тягу
    board_fr.serial.send("v 75 b");
    sim::run_for_ms(200);
    CHECK(servo_value(board_fr) == 75 && thrust_on(board_fr),
          "SC не меняет Servo.write и линии драйвера, тик %d", i);
  }
  CHECK(wheel_fr::tach_display_rpm_x10 == 0, "при отсутствии переходов показание возвращается в 0");
  board_fr.serial.send("b");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr), "обычный СТОП работает независимо от SC");
  spin_tach(&board_fr, 90, 1000);
  CHECK(drive_idle(board_fr) && std::abs((long)wheel_fr::tach_display_rpm_x10 - 600L) <= 8,
        "вращение без тяги показывается, но не запускает мотор");

  // Один переход в секунду ≈ 0.67 об/мин: между окнами 500 мс показание
  // не должно прыгать в ноль, пока следующий переход ещё не пришёл.
  sim::run_for_ms(2000);
  spin_tach(&board_fr, 4, 4000);
  CHECK(wheel_fr::tach_display_rpm_x10 >= 6 && wheel_fr::tach_display_rpm_x10 <= 8,
        "медленное вращение ≈ 0.7 об/мин: %lu", (unsigned long)wheel_fr::tach_display_rpm_x10);
  sim::run_for_ms(2000);
  CHECK(wheel_fr::tach_display_rpm_x10 == 0, "медленное вращение после остановки → 0");

  // Короткий дребезг не меняет принятую метку времени.
  board_fr.tach_change();
  const uint32_t last = wheel_fr::tach_last_edge_us;
  const uint32_t count = wheel_fr::tach_edges_total;
  sim::advance(50);
  board_fr.tach_change();
  CHECK(wheel_fr::tach_last_edge_us == last && wheel_fr::tach_edges_total == count,
        "переход менее 150 мкс не меняет ни время, ни счётчик");
  wheel_fr::tach_edges_total = UINT32_MAX;
  sim::advance(1000);
  board_fr.tach_change();
  CHECK(wheel_fr::tach_edges_total == 0, "счётчик корректно переполняется по модулю 2^32");
}

static void scenario_tach_rollover() {
  boot({&board_fr});
  // micros() на AVR переполняется каждые 2^32 мкс; интервалы вычисляются
  // беззнаковым вычитанием и должны пережить границу.
  sim::now_us = 4294967296LL - 12000;
  sim::next_tick_us = sim::now_us + 50;
  wheel_fr::tach_last_sample_ms = (uint32_t)(sim::now_us / 1000);
  spin_tach(&board_fr, 100, 1000);
  CHECK(std::abs((long)wheel_fr::tach_display_rpm_x10 - 667L) <= 8,
        "после переполнения micros(): 100 Гц ≈ 66.7 об/мин, получено %lu",
        (unsigned long)wheel_fr::tach_display_rpm_x10);

  sim::run_for_ms(2000);
  CHECK(!wheel_fr::tach_has_edge && wheel_fr::tach_display_rpm_x10 == 0,
        "после паузы старая точка отсчёта сброшена");
  const uint32_t old_edge = wheel_fr::tach_last_edge_us;
  // Долгая остановка охватила полное переполнение micros(). Без сброса первый
  // фронт выглядел бы интервалом всего в 10 мс и дал бы ложные 66,7 об/мин.
  sim::now_us = ((sim::now_us / 4294967296LL) + 1) * 4294967296LL +
                (uint32_t)(old_edge + 10000UL);
  sim::next_tick_us = sim::now_us + 50;
  board_fr.tach_change();
  wheel_fr::updateTachDisplay();
  CHECK(wheel_fr::tach_display_rpm_x10 == 0,
        "первый фронт после долгой паузы не создаёт ложные обороты");
  spin_tach(&board_fr, 90, 1000);
  CHECK(std::abs((long)wheel_fr::tach_display_rpm_x10 - 600L) <= 8,
        "оборотомер возобновляет показ после паузы");
}

// Legacy freewheel commands may never release the brake, even transiently.
static void scenario_neutral() {
  const std::vector<sim::Board*> boards = all_boards();
  boot(boards);
  const char* requests[] = {"n", "n 42", "n 43", "N 42", "n -1", "n 42 extra"};
  for (const char* command : requests) {
    for (sim::Board* board : boards) board->serial.send("b 42");
    sim::run_for_ms(5);
    long releases[4];
    for (size_t i = 0; i < boards.size(); ++i) {
      CHECK(drive_idle(*boards[i]), "%s: tagged b тормозит", boards[i]->name);
      releases[i] = boards[i]->brake_releases;
      boards[i]->serial.send(command);
    }
    sim::run_for_ms(50);
    for (size_t i = 0; i < boards.size(); ++i) {
      FastFrame frame;
      CHECK(drive_idle(*boards[i]) && boards[i]->brake_releases == releases[i],
            "%s: «%s» не должен даже кратковременно отпускать тормоз", boards[i]->name, command);
      CHECK(latest_fast_frame(*boards[i], &frame) && frame.firmware == 25 &&
            frame.neutral == 0 && frame.neutral_lock == 0,
            "%s: нейтраль не отображается в телеметрии", boards[i]->name);
    }
  }

  // Normal direct traction still releases the brake while the driver is
  // enabled; a delayed legacy n stops it, and normal traction can start again.
  for (sim::Board* board : boards) board->serial.send("v 40 f");
  sim::run_for_ms(5);
  for (sim::Board* board : boards) {
    CHECK(thrust_on(*board) && servo_value(*board) == 40, "%s: обычная тяга работает", board->name);
    board->serial.send("n 42");
  }
  sim::run_for_ms(5);
  for (sim::Board* board : boards) {
    CHECK(drive_idle(*board), "%s: запоздавший n остановил тягу", board->name);
    board->serial.send("v 150 b");
  }
  sim::run_for_ms(5);
  for (sim::Board* board : boards) {
    CHECK(thrust_on(*board) && servo_value(*board) == 150, "%s: тяга после n работает", board->name);
    board->serial.send("b 99");
  }
  sim::run_for_ms(50);
  for (sim::Board* board : boards) {
    FastFrame frame;
    CHECK(drive_idle(*board) && latest_fast_frame(*board, &frame) && frame.brake == 99,
          "%s: tagged b тормозит и подтверждается", board->name);
  }
}

// An edge must be noticed immediately, even before the 500 ms RPM sample.
static void scenario_recent_sc() {
  boot({&board_fr});
  board_fr.serial.send("z");
  sim::run_for_ms(200);
  CHECK(wheel_fr::tach_display_rpm_x10 == 0 && !wheel_fr::tachMotionRecent(),
        "начальное отсутствие импульсов не выдумывает вращение");
  board_fr.serial.output.clear();
  board_fr.tach_change();
  sim::run_for_ms(40);
  CHECK(wheel_fr::tach_display_rpm_x10 == 0 && wheel_fr::tachMotionRecent(),
        "первый импульс виден сразу, хотя RPM ещё не обновился");
  FastFrame recent_frame;
  CHECK(latest_fast_frame(board_fr, &recent_frame) && recent_frame.recent == 1 && recent_frame.rpm10 == 0,
        "переход SC публикуется до следующего окна RPM");
  board_fr.serial.send("b 901");
  sim::run_for_ms(2);
  board_fr.serial.send("n 901");
  sim::run_for_ms(2);
  CHECK(!wheel_fr::neutral_active && board_fr.level[5] == HIGH,
        "один недавний импульс блокирует нейтраль даже при RPM=0");
  sim::run_for_ms(1600);
  CHECK(!wheel_fr::tachMotionRecent(), "после достаточной тишины недавних импульсов нет");
  board_fr.serial.send("b 902");
  sim::run_for_ms(2);
  board_fr.serial.send("n 902");
  sim::run_for_ms(2);
  CHECK(!wheel_fr::neutral_active && board_fr.level[5] == HIGH,
        "после тишины старый n тоже не отпускает тормоз");

  // Hold time follows three periods, bounded to 300 ms..1500 ms.
  wheel_fr::tach_has_edge = true;
  wheel_fr::tach_last_edge_us = 100000;
  wheel_fr::tach_last_period_us = 50000;
  sim::now_us = 399999;
  CHECK(wheel_fr::tachMotionRecent(), "короткий период удерживает признак 300 мс");
  sim::now_us = 400001;
  CHECK(!wheel_fr::tachMotionRecent(), "после нижней границы признак очищен");
  wheel_fr::tach_last_period_us = 900000;
  sim::now_us = 1599999;
  CHECK(wheel_fr::tachMotionRecent(), "длинный период ограничен 1500 мс");
  sim::now_us = 1600001;
  CHECK(!wheel_fr::tachMotionRecent(), "после верхней границы признак очищен");

  // Unsigned micros arithmetic must survive its ~71-minute rollover.
  wheel_fr::tach_has_edge = true;
  wheel_fr::tach_last_edge_us = 0xFFFFFFF0UL;
  wheel_fr::tach_last_period_us = 100000;
  sim::now_us = 0x100000000LL + 10000;
  CHECK(wheel_fr::tachMotionRecent(), "свежий SC после переполнения micros()");
  sim::now_us += 400000;
  CHECK(!wheel_fr::tachMotionRecent(), "старый SC после переполнения micros()");
}

// Live steering is opt-in and bound to a fresh tagged STOP and a watchdog.
static void scenario_live_steering() {
  boot({&board_fr});
  board_fr.serial.send("z");
  sim::run_for_ms(5);
  board_fr.serial.send("j 101 1 20 0");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr) && wheel_fr::live_id == 0, "j без подтверждённого тормоза отклонён");

  board_fr.serial.send("b 101");
  sim::run_for_ms(5);
  board_fr.serial.send("j 101 1 20 25");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr), "первый запуск не меняет неподтверждённый угол");
  board_fr.serial.send("b 102");
  sim::run_for_ms(5);
  board_fr.serial.send("j 102 1 20 0.5");
  sim::run_for_ms(5);
  CHECK(thrust_on(board_fr) && !wheel_fr::motorBusy() && wheel_fr::live_id == 102 && wheel_fr::live_seq == 1,
        "старт на подтверждённом угле без неожиданной начальной коррекции");
  board_fr.serial.send("j 102 2 20 25");
  sim::run_for_ms(100);
  CHECK(thrust_on(board_fr) && wheel_fr::motorBusy() && wheel_fr::live_seq == 2,
        "руль поворачивается, а тяга остаётся включена");
  const int32_t first_step = wheel_fr::stepNow();
  board_fr.serial.send("j 102 1 20 -25");  // stale sequence cannot change target or refresh TTL
  sim::run_for_ms(10);
  CHECK(wheel_fr::live_target_step == wheel_fr::degreesToSteps(25) && wheel_fr::live_seq == 2,
        "устаревшая команда не меняет цель руля");
  board_fr.serial.send("j 102 3 20 25");
  sim::run_for_ms(100);
  CHECK(wheel_fr::stepNow() > first_step && thrust_on(board_fr),
        "одинаковый heartbeat не перезапускает ход руля");
  FastFrame live_frame;
  CHECK(latest_fast_frame(board_fr, &live_frame) && live_frame.live == 102 && live_frame.sequence == 3,
        "короткий кадр подтверждает сессию и порядковый номер");

  board_fr.serial.send("j 102 4 -20 25");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr) && !wheel_fr::motorBusy() && wheel_fr::live_id == 0,
        "реверс без STOP снимает тягу и останавливает руление");
  board_fr.serial.send("j 102 5 20 0");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr), "устаревший heartbeat не возобновляет тягу");

  board_fr.serial.send("z");
  board_fr.serial.send("b 103");
  sim::run_for_ms(5);
  board_fr.serial.send("j 103 1 20 0");
  board_fr.serial.send("j 103 2 20 90");
  sim::run_for_ms(100);
  CHECK(thrust_on(board_fr) && wheel_fr::motorBusy(), "подготовлен ход для проверки watchdog");
  sim::run_for_ms(660);
  CHECK(!thrust_on(board_fr) && !wheel_fr::motorBusy() && wheel_fr::live_id == 0,
        "watchdog останавливает и тягу, и руль");
  board_fr.serial.send("j 103 3 20 90");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr) && !wheel_fr::motorBusy(), "поздний j после watchdog не запускает моторы");

  board_fr.serial.send("z");
  board_fr.serial.send("b 104");
  sim::run_for_ms(5);
  board_fr.serial.send("j 104 1 20 0");
  board_fr.serial.send("j 104 2 20 90");
  sim::run_for_ms(30);
  board_fr.serial.send("b 105");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr) && !wheel_fr::motorBusy() && wheel_fr::brake_id == 105,
        "tagged STOP прерывает руление на ходу");
  board_fr.serial.send("j 104 3 20 90");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr), "старый j после нового STOP не возобновляет тягу");

  board_fr.serial.send("z");
  board_fr.serial.send("b 106");
  sim::run_for_ms(5);
  board_fr.serial.send("j 106 1 20 0");
  board_fr.serial.send("j 106 2 20 90");
  sim::run_for_ms(30);
  board_fr.serial.send("w -90");  // ordinary commands cannot take over live
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr) && !wheel_fr::motorBusy() && wheel_fr::live_id == 0,
        "обычная команда не перехватывает руление и останавливает live");
  board_fr.serial.send("j 106 3 20 90");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr), "heartbeat после перехвата не возобновляет тягу");

  board_fr.serial.send("z");
  board_fr.serial.send("b 109");
  sim::run_for_ms(5);
  board_fr.serial.send("j 109 1 20 0");
  board_fr.serial.send("j 109 2 20 90");
  sim::run_for_ms(30);
  CHECK(thrust_on(board_fr) && wheel_fr::motorBusy(), "руление на ходу работает до старого n");
  board_fr.serial.send("n 109");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr) && !wheel_fr::motorBusy() && wheel_fr::live_id == 0,
        "старый n останавливает тягу и руль во время WASD");
  board_fr.serial.send("j 109 3 20 90");
  sim::run_for_ms(5);
  CHECK(drive_idle(board_fr) && !wheel_fr::motorBusy(), "старый j не возобновляет движение после n");

  board_fr.serial.send("z");
  board_fr.serial.send("b 107");
  sim::run_for_ms(5);
  board_fr.tach_change();
  board_fr.serial.send("j 107 1 20 0");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr) && wheel_fr::tach_display_rpm_x10 == 0,
        "недавний SC блокирует первый live-старт, даже когда RPM ещё ноль");

  sim::run_for_ms(1600);
  board_fr.serial.send("z");
  board_fr.serial.send("b 108");
  sim::run_for_ms(5);
  wheel_fr::brake_id_ms = (uint32_t)millis() - wheel_fr::LIVE_START_TIMEOUT_MS - 1;
  board_fr.serial.send("j 108 1 20 0");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr), "старый tagged тормоз не разрешает первый live-пакет");
  board_fr.serial.send("b 109");
  sim::run_for_ms(5);
  board_fr.serial.send("j 109 1 20 0");
  sim::run_for_ms(5);
  wheel_fr::last_drive_command_ms = (uint32_t)millis() - wheel_fr::DRIVE_COMMAND_TIMEOUT_MS - 1;
  board_fr.serial.send("j 109 2 20 25");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr) && !wheel_fr::motorBusy(),
        "запоздавший heartbeat не обходит watchdog даже до его следующего тика");
}

static void scenario_quiet_stop() {
  boot({&board_fr});
  board_fr.serial.send("z");
  board_fr.serial.send("b 301");
  sim::run_for_ms(5);
  board_fr.serial.send("j 301 1 20 0");
  board_fr.serial.send("j 301 2 20 25");
  sim::run_for_ms(10);
  CHECK(thrust_on(board_fr) && wheel_fr::motorBusy(), "подготовлена тяга и руление");
  board_fr.serial.output.clear();
  board_fr.serial.send("s q\nb 302");
  sim::run_for_ms(5);
  CHECK(!thrust_on(board_fr) && !wheel_fr::motorBusy() && wheel_fr::brake_id == 302,
        "тихий STOP и tagged brake последовательно гасят тягу и руление");
  CHECK(!has(board_fr, "ПАУЗА."), "тихий STOP не задерживает ответ длинной обычной заметкой");
  board_fr.serial.send("s");
  sim::run_for_ms(5);
  CHECK(has(board_fr, "ПАУЗА."), "обычный s сохраняет текст монитора");
}

// Fast frames are bounded, CRC-checked and reflect applied STOP/steering state.
static void scenario_fast_telemetry() {
  boot({&board_fr});
  sim::run_for_ms(350);
  board_fr.serial.output.clear();
  wheel_fr::last_fast_telemetry_ms = wheel_fr::last_telemetry_ms = (uint32_t)millis();
  board_fr.serial.send("b 123");
  sim::run_for_ms(15);
  CHECK(!has(board_fr, "@F "), "частые быстрые кадры ограничены для UART");
  sim::run_for_ms(8);
  FastFrame fast;
  CHECK(latest_fast_frame(board_fr, &fast) && fast.brake == 123 && fast.drive == 0,
        "быстрый кадр подтверждает применённый STOP с CRC до длинного периода");
  CHECK(!has(board_fr, "@TLM "), "подтверждение не ждёт длинного кадра");

  // An occupied TX buffer must neither truncate nor forget the newest ACK.
  board_fr.serial.output.clear();
  board_fr.serial.writable = 0;
  wheel_fr::tx_position = 0;
  wheel_fr::tx_length = sizeof(wheel_fr::tx_buf) - wheel_fr::FAST_TELEMETRY_LINE_CAPACITY + 1;
  std::memset(wheel_fr::tx_buf, 'x', wheel_fr::tx_length);
  wheel_fr::tx_buf[wheel_fr::tx_length - 1] = '\n';
  wheel_fr::last_fast_telemetry_ms = wheel_fr::last_telemetry_ms = (uint32_t)millis();
  board_fr.serial.send("b 456");
  sim::run_for_ms(100);
  CHECK(wheel_fr::brake_id == 456 && wheel_fr::telemetry_urgent,
        "занятый TX не должен терять запрос подтверждения");
  CHECK(board_fr.serial.output.empty(), "при занятом TX нельзя выдать обрезанный кадр");
  board_fr.serial.writable = 63;
  sim::run_for_ms(5);
  CHECK(has(board_fr, "\n@F ") && latest_fast_frame(board_fr, &fast) && fast.brake == 456,
        "последний ACK отправлен целиком после освобождения TX");

  // Worst-case reservations and spacing keep a sustained command burst below
  // nominal 115200-baud 8N1 capacity even with regular compatibility frames.
  sim::run_for_ms(50);
  board_fr.serial.output.clear();
  wheel_fr::last_fast_telemetry_ms = wheel_fr::last_telemetry_ms = (uint32_t)millis();
  for (int i = 1; i <= 40; ++i) {
    board_fr.serial.send("b " + std::to_string(1000 + i));
    sim::run_for_ms(5);
  }
  sim::run_for_ms(35);
  CHECK(count(board_fr, "@F ") <= 12 && count(board_fr, "@TLM ") <= 2,
        "частые команды не должны забить UART кадрами: fast=%ld full=%ld",
        count(board_fr, "@F "), count(board_fr, "@TLM "));
  CHECK(latest_fast_frame(board_fr, &fast) && fast.brake == 1040,
        "последний короткий кадр содержит актуальный ACK");

  // Feedback settling is busy even if the stepper is temporarily stationary.
  wheel_fr::zero_set = true;
  wheel_fr::feedback_pending = true;
  wheel_fr::feedback_wait_ms = (uint32_t)millis() + 200;
  CHECK((wheel_fr::moduleStatus() & wheel_fr::STATUS_MOVING) != 0 && !wheel_fr::localDriveAllowed(),
        "пауза перед доводкой не является подтверждённой остановкой руля");
  board_fr.serial.send("b 2001");
  sim::run_for_ms(5);
  board_fr.serial.send("n 2001");
  sim::run_for_ms(5);
  CHECK(!wheel_fr::neutral_active && board_fr.level[5] == HIGH,
        "нейтраль не включается до завершения доводки");
  sim::run_for_ms(35);
  CHECK(latest_fast_frame(board_fr, &fast) && (fast.status & wheel_fr::STATUS_MOVING),
        "доводка публикуется как движущийся руль");
  board_fr.serial.output.clear();
  wheel_fr::feedback_pending = false;
  sim::run_for_ms(35);
  CHECK(latest_fast_frame(board_fr, &fast) && !(fast.status & wheel_fr::STATUS_MOVING),
        "завершение доводки публикуется без команды");

  board_fr.serial.output.clear();
  wheel_fr::last_fast_telemetry_ms = wheel_fr::last_telemetry_ms = (uint32_t)millis();
  sim::run_for_ms(200);
  CHECK(count(board_fr, "@F ") >= 6 && count(board_fr, "@F ") <= 7 && count(board_fr, "@TLM ") == 1,
        "без событий: короткие каждые 30 мс, совместимый полный каждые 200 мс");

  board_fr.serial.output.clear();
  sim::now_us = ((int64_t)UINT32_MAX - 10) * 1000;
  sim::next_tick_us = sim::now_us + 50;
  wheel_fr::last_fast_telemetry_ms = wheel_fr::last_telemetry_ms = (uint32_t)millis();
  board_fr.serial.send("b 3001");
  sim::run_for_ms(25);
  CHECK(latest_fast_frame(board_fr, &fast) && fast.brake == 3001 && fast.time < 50,
        "быстрое подтверждение переживает переполнение millis()");
}

// Both fw21 frames must fit as a whole and resume after TX congestion.
static void scenario_telemetry_capacity() {
  boot({&board_fr});
  wheel_fr::tx_position = wheel_fr::tx_length = 0;
  // Extreme widths, deliberately beyond real operating values, exercise the
  // longest formatting path (including the 32-bit millis rollover boundary).
  sim::now_us = 4294967295000LL;
  wheel_fr::current_step = -2000000;
  wheel_fr::target_step = 2000000;
  wheel_fr::drive_percent = -100;
  wheel_fr::drive_servo_value = 180;
  wheel_fr::tach_display_rpm_x10 = UINT32_MAX;
  wheel_fr::tach_display_hz = UINT16_MAX;
  wheel_fr::tach_edges_total = UINT32_MAX;
  wheel_fr::brake_id = INT32_MAX;
  wheel_fr::neutral_id = INT32_MAX - 1;
  wheel_fr::live_id = INT32_MAX - 1;
  wheel_fr::live_seq = INT32_MAX - 1;
  wheel_fr::appendTelemetry();
  const std::string full(wheel_fr::tx_buf, wheel_fr::tx_length);
  CHECK(!full.empty() && full.size() < wheel_fr::TELEMETRY_LINE_CAPACITY,
        "максимально длинный @TLM помещается в локальный буфер");
  CHECK(full.find("sc_rpm=429496729.5 sc_hz=65535 sc_ppr=90 sc_count=4294967295 sc_recent=0 brake_id=2147483647 neutral_id=2147483646 neutral_lock=0 live_id=2147483646 live_seq=2147483646 t=4294967295 crc=") != std::string::npos,
        "максимально длинный @TLM целиком, включая конец: %s", full.c_str());
  wheel_fr::tx_position = wheel_fr::tx_length = 0;
  CHECK(wheel_fr::appendFastTelemetry(), "максимальный быстрый кадр помещается");
  CHECK(wheel_fr::tx_length < wheel_fr::FAST_TELEMETRY_LINE_CAPACITY, "быстрый кадр меньше буфера");
  board_fr.serial.output.assign(wheel_fr::tx_buf, wheel_fr::tx_length);
  FastFrame fast;
  CHECK(latest_fast_frame(board_fr, &fast) && fast.brake == INT32_MAX && fast.edges == UINT32_MAX &&
        fast.live == INT32_MAX - 1 && fast.sequence == INT32_MAX - 1,
        "максимальный быстрый кадр целый и содержит верную CRC");

  // With one byte less than the reserved capacity the frame is skipped, not
  // truncated; once TX drains, the next period must deliver complete data.
  sim::now_us = 5000;
  wheel_fr::live_id = wheel_fr::live_seq = 0;
  wheel_fr::current_step = wheel_fr::target_step = 0;
  wheel_fr::drive_percent = wheel_fr::drive_servo_value = 0;
  wheel_fr::tach_display_rpm_x10 = wheel_fr::tach_display_hz = 0;
  wheel_fr::tx_position = 0;
  wheel_fr::tx_length = sizeof(wheel_fr::tx_buf) - wheel_fr::TELEMETRY_LINE_CAPACITY + 1;
  std::memset(wheel_fr::tx_buf, 'x', wheel_fr::tx_length);
  wheel_fr::tx_buf[wheel_fr::tx_length - 2] = '\r';
  wheel_fr::tx_buf[wheel_fr::tx_length - 1] = '\n';
  board_fr.serial.output.clear();
  board_fr.serial.writable = 0;  // имитируем переполненный аппаратный UART
  wheel_fr::last_fast_telemetry_ms = (uint32_t)millis();
  wheel_fr::last_telemetry_ms = (uint32_t)millis() - wheel_fr::FULL_TELEMETRY_PERIOD_MS;
  wheel_fr::loop();
  CHECK(board_fr.serial.output.empty() && wheel_fr::tx_position == 0 &&
        wheel_fr::tx_length == sizeof(wheel_fr::tx_buf) - wheel_fr::TELEMETRY_LINE_CAPACITY + 1,
        "при занятом TX кадр не обрезается и не дописывается в буфер");
  board_fr.serial.writable = 63;
  wheel_fr::last_telemetry_ms = (uint32_t)millis() - wheel_fr::FULL_TELEMETRY_PERIOD_MS;
  wheel_fr::loop();
  CHECK(has(board_fr, "\r\n@TLM mod=FR deg=") && has(board_fr, "sc_ppr=90 sc_count=") &&
        board_fr.serial.output.size() >= 2 &&
        board_fr.serial.output.substr(board_fr.serial.output.size() - 2) == "\r\n",
        "после освобождения TX телеметрия продолжается: %s", board_fr.serial.output.c_str());
}

// Full zero persists per board and is applied during, not before, k.
static void scenario_full_zero_reboot() {
  boot({&board_fr});
  calibrate_fr();
  board_fr.serial.send("w 1.3");
  sim::run_for_ms(3);
  CHECK(wait_until(fr_settled, 3000), "first correction settled");
  const long physical = board_fr.phys;
  board_fr.serial.send("zq 201");
  sim::run_for_ms(250);
  CHECK(FR::zero_reply_status == 1 && FR::zero_reply_id == 201, "preflight ready");
  CHECK(has(board_fr, "@Z 25 2 201 1 "), "checked preflight returned");
  board_fr.serial.send("zc 202");
  sim::run_for_ms(250);
  CHECK(FR::zero_reply_status == 2 && FR::full_zero_steps == physical && FR::stepNow() == 0,
        "EEPROM committed and coordinates rebased: %ld %ld %ld", (long)FR::full_zero_steps,
        physical, (long)FR::stepNow());
  CHECK(has(board_fr, "@Z 25 2 202 2 "), "checked commit returned");
  const uint32_t generation = FR::full_zero_generation;
  board_fr.serial.send("zc 202"); // retry is idempotent
  sim::run_for_ms(2);
  CHECK(FR::full_zero_generation == generation, "duplicate does not write EEPROM");

  // setup() does not reset globals in the simulator; reset session state just
  // as the AVR startup does, retaining only board EEPROM and physical position.
  FR::zero_set = false;
  FR::home_source = FR::HOME_NONE;
  FR::current_step = FR::target_step = 0;
  FR::full_zero_steps = 0;
  FR::full_zero_generation = 0;
  FR::setup();
  sim::run_for_ms(10);
  CHECK(FR::full_zero_steps == physical && !FR::zero_set && board_fr.phys == physical,
        "power-on loads trim, never starts movement");
  calibrate_fr();
  CHECK(FR::zero_set && FR::home_source == FR::HOME_OPTO && std::labs(board_fr.phys - physical) <= 1,
        "k returns to stored physical zero: %ld != %ld", board_fr.phys, physical);
  CHECK(FR::stepNow() == 0, "returned to corrected coordinate zero");

  board_fr.serial.send("w -0.4");
  sim::run_for_ms(3);
  CHECK(wait_until(fr_settled, 3000), "second correction settled");
  const long physical2 = board_fr.phys;
  board_fr.serial.send("zc 203");
  sim::run_for_ms(250);
  CHECK(FR::zero_reply_status == 2 && FR::full_zero_steps == physical2 && FR::stepNow() == 0,
        "recalibration adds new displacement to old offset");
  calibrate_fr();
  CHECK(std::labs(board_fr.phys - physical2) <= 1, "new offset used on next optical calibration");
}

static void scenario_full_zero_failures() {
  boot({&board_fr});
  board_fr.serial.send("zq 301");
  sim::run_for_ms(3);
  CHECK(FR::zero_reply_status == 3, "cannot save without optical calibration");
  board_fr.serial.send("z");
  board_fr.serial.send("zc 302");
  sim::run_for_ms(3);
  CHECK(FR::zero_reply_status == 3, "manual zero is not an optical reference");
  calibrate_fr();
  board_fr.serial.send("w 2.0");
  sim::run_for_ms(3);
  CHECK(wait_until(fr_settled, 3000), "move to first offset");
  board_fr.serial.send("zc 303");
  sim::run_for_ms(3);
  const int32_t old = FR::full_zero_steps;
  CHECK(FR::zero_reply_status == 2 && old != 0, "first offset committed");
  uint8_t backup[1024];
  std::memcpy(backup, board_fr.eeprom, sizeof(backup));
  // Interrupt at every byte of the alternating write. Loading after any cut
  // may select old or complete new, never an arbitrary intermediate value.
  for (int remaining = 0; remaining <= 15; ++remaining) {
    std::memcpy(board_fr.eeprom, backup, sizeof(backup));
    FR::loadFullZero();
    board_fr.eeprom_writes_left = remaining;
    const bool committed = FR::persistFullZero(old + 111);
    board_fr.eeprom_writes_left = -1;
    FR::loadFullZero();
    CHECK(FR::full_zero_steps == old || FR::full_zero_steps == old + 111,
          "interrupted EEPROM never selects arbitrary value cut=%d offset=%ld", remaining, (long)FR::full_zero_steps);
    if (committed) {
      CHECK(!FR::full_zero_storage_fault && FR::full_zero_steps == old + 111, "verified write survives reboot");
    } else if (!FR::fullZeroSlotBlank(1)) {
      CHECK(FR::full_zero_storage_fault, "partially written slot fails closed cut=%d", remaining);
    }
  }
  std::memcpy(board_fr.eeprom, backup, sizeof(backup));
  FR::loadFullZero();
  FR::current_step = FR::degreesToSteps(21.0f);
  FR::target_step = FR::current_step;
  board_fr.serial.send("zq 304");
  sim::run_for_ms(3);
  CHECK(FR::zero_reply_status == 5, "out-of-range proposed trim rejected");
  FR::current_step = 0;
  FR::target_step = 0;
  board_fr.eeprom_writes_left = 0;
  board_fr.serial.send("zc 305");
  sim::run_for_ms(3);
  CHECK(FR::zero_reply_status == 6 && FR::full_zero_storage_fault,
        "failed EEPROM commit latches fault immediately");
  board_fr.eeprom_writes_left = -1;
  std::memcpy(board_fr.eeprom, backup, sizeof(backup));
  FR::loadFullZero();
  // Corrupt the only valid slot: calibration must not silently use zero.
  board_fr.eeprom[FR::EEPROM_ZERO_SLOTS[FR::full_zero_slot] + 7] ^= 0x40;
  FR::loadFullZero();
  CHECK(FR::full_zero_storage_fault, "CRC corruption fails closed");
  CHECK(!FR::startCalibration(), "calibration refuses corrupted EEPROM");
  CHECK((FR::moduleStatus() & FR::STATUS_FULL_ZERO_FAULT) != 0, "fault reported in compact telemetry");
  board_fr.serial.send("v 15");
  sim::run_for_ms(3);
  CHECK(!FR::drive_active && drive_idle(board_fr), "direct Servo cannot bypass EEPROM fault");
  FR::zero_set = false;
  const long physical_before_fault_commands = board_fr.phys;
  board_fr.serial.send("z");
  board_fr.serial.send("d 10 f");
  board_fr.serial.send("q");
  sim::run_for_ms(4);
  CHECK(!FR::zero_set && !FR::motorBusy() && board_fr.phys == physical_before_fault_commands,
        "fault also blocks manual zero, steering and potentiometer calibration");
  // Even a stale/forged zero flag must not bypass fault through live WASD.
  FR::zero_set = true;
  FR::current_step = FR::target_step = 0;
  board_fr.serial.send("b 777");
  board_fr.serial.send("j 777 1 15 0");
  sim::run_for_ms(4);
  CHECK(!FR::drive_active && FR::live_id == 0 && drive_idle(board_fr),
        "tagged brake cannot bypass EEPROM fault via live WASD");
  // Service reset is an explicit, stationary, fault-only operation. It does not
  // touch the potentiometer slots; a new optical calibration is still required.
  FR::zero_set = false;
  FR::home_source = FR::HOME_NONE;
  board_fr.serial.send("zr wrong");
  sim::run_for_ms(3);
  CHECK(FR::full_zero_storage_fault, "no reset without exact confirmation");
  board_fr.serial.send("zr CONFIRM");
  sim::run_for_ms(3);
  CHECK(!FR::full_zero_storage_fault && FR::full_zero_steps == 0 && !FR::zero_set,
        "explicit service reset clears only failed trim");
}

static void scenario_full_zero_corrupt_latest() {
  boot({&board_fr});
  calibrate_fr();
  board_fr.serial.send("w 1");
  sim::run_for_ms(3);
  CHECK(wait_until(fr_settled, 3000), "first correction");
  board_fr.serial.send("zc 401");
  sim::run_for_ms(3);
  board_fr.serial.send("w 1");
  sim::run_for_ms(3);
  CHECK(wait_until(fr_settled, 3000), "second correction");
  board_fr.serial.send("zc 402");
  sim::run_for_ms(3);
  const uint8_t latest = (uint8_t)FR::full_zero_slot;
  FR::FullZeroRecord older;
  CHECK(FR::readFullZeroSlot(latest ^ 1, &older), "older slot exists");
  board_fr.eeprom[FR::EEPROM_ZERO_SLOTS[latest] + 7] ^= 0x01;
  FR::loadFullZero();
  CHECK(FR::full_zero_storage_fault, "bad committed newest CRC cannot silently fall back to old value");
  // An erased marker is indistinguishable from an interrupted write.
  board_fr.eeprom[FR::EEPROM_ZERO_SLOTS[latest] + 7] ^= 0x01;
  board_fr.eeprom[FR::EEPROM_ZERO_SLOTS[latest]] = 0;
  FR::loadFullZero();
  CHECK(FR::full_zero_storage_fault, "damaged marker cannot silently select the older valid slot");
}

static const Scenario SCENARIOS[] = {
    {"boot", scenario_boot},
    {"full_zero_reboot", scenario_full_zero_reboot},
    {"full_zero_failures", scenario_full_zero_failures},
    {"full_zero_corrupt_latest", scenario_full_zero_corrupt_latest},
    {"identity", scenario_identity},
    {"calib_left", scenario_calib_left},
    {"calib_right", scenario_calib_right},
    {"calib_inside", scenario_calib_inside},
    {"calib_far_left", scenario_calib_far_left},
    {"calib_out_of_range", scenario_calib_out_of_range},
    {"calib_no_sensor", scenario_calib_no_sensor},
    {"calib_stuck", scenario_calib_stuck},
    {"calib_abort", scenario_calib_abort},
    {"calib_asymmetric", scenario_calib_asymmetric},
    {"calib_full_range_plus", scenario_calib_full_range_plus},
    {"calib_full_range_minus", scenario_calib_full_range_minus},
    {"calib_passes_averaged", scenario_calib_passes_averaged},
    {"calib_spread_error", scenario_calib_spread_error},
    {"moves", scenario_moves},
    {"pot_calibration", scenario_pot_calibration},
    {"pot_feedback", scenario_pot_feedback},
    {"pot_unplugged", scenario_pot_unplugged},
    {"pot_mode", scenario_pot_mode},
    {"pot_hold", scenario_pot_hold},
    {"pot_hold_limit", scenario_pot_hold_limit},
    {"pot_hold_stall", scenario_pot_hold_stall},
    {"pot_hold_passes", scenario_pot_hold_passes},
    {"pot_hold_guard", scenario_pot_hold_guard},
    {"pot_hold_stop", scenario_pot_hold_stop},
    {"pot_hold_off_busy", scenario_pot_hold_off_busy},
    {"swing", scenario_swing},
    {"pause_resume", scenario_pause_resume},
    {"zero_manual", scenario_zero_manual},
    {"drive", scenario_drive},
    {"direct_servo", scenario_direct_servo},
    {"direct_directions", scenario_direct_directions},
    {"serial_garbage", scenario_serial_garbage},
    {"system_calibrate_all", scenario_system_calibrate_all},
    {"system_server_commands", scenario_system_server_commands},
    {"system_drive", scenario_system_drive},
    {"system_broadcast", scenario_system_broadcast},
    {"preset_burst", scenario_preset_burst},
    {"pot_distrust", scenario_pot_distrust},
    {"stalled_wheel_without_pot", scenario_stalled_wheel_without_pot},
    {"stalled_wheel_with_pot", scenario_stalled_wheel_with_pot},
    {"pot_slope_survives_reboot", scenario_pot_slope_survives_reboot},
    {"drive_hardware", scenario_drive_hardware},
    {"drive_one_wheel", scenario_drive_one_wheel},
    {"drive_speed", scenario_drive_speed},
    {"mirrored_wheels", scenario_mirrored_wheels},
    {"tach_display", scenario_tach_display},
    {"tach_rollover", scenario_tach_rollover},
    {"neutral", scenario_neutral},
    {"recent_sc", scenario_recent_sc},
    {"live_steering", scenario_live_steering},
    {"quiet_stop", scenario_quiet_stop},
    {"fast_telemetry", scenario_fast_telemetry},
    {"telemetry_capacity", scenario_telemetry_capacity},
};

static int run_one(const Scenario& scenario) {
  bind_boards();
  scenario.fn();
  if (failures) {
    std::fprintf(stderr, "%s: %d ошибок\n", scenario.name, failures);
    for (sim::Board* board : sim::boards) {
      std::fprintf(stderr, "--- вывод %s ---\n%s\n", board->name, board->serial.output.c_str());
    }
  }
  return failures ? 1 : 0;
}

int main(int argc, char** argv) {
  if (argc > 2 && std::strcmp(argv[1], "pty") == 0) return run_pty(argv[2]);
  if (argc > 1 && std::strcmp(argv[1], "snapshot_dump") == 0) {
    bind_boards();
    scenario_snapshot_dump();
    return failures ? 1 : 0;
  }
  if (argc > 1 && std::strcmp(argv[1], "tlm_dump") == 0) {
    bind_boards();
    scenario_tlm_dump();
    return failures ? 1 : 0;
  }
  int failed = 0;
  int ran = 0;
  for (const Scenario& scenario : SCENARIOS) {
    if (argc > 1 && std::strcmp(argv[1], scenario.name) != 0) continue;
    ++ran;
    std::fflush(stdout);
    const pid_t pid = fork();
    if (pid == 0) _exit(run_one(scenario));
    int status = 0;
    waitpid(pid, &status, 0);
    const bool ok = WIFEXITED(status) && WEXITSTATUS(status) == 0;
    std::printf("%-26s %s\n", scenario.name, ok ? "ok" : "FAIL");
    if (!ok) ++failed;
  }
  if (!ran) {
    std::fprintf(stderr, "нет сценария %s\n", argc > 1 ? argv[1] : "");
    return 2;
  }
  std::printf("%d/%d сценариев прошли\n", ran - failed, ran);
  return failed ? 1 : 0;
}
