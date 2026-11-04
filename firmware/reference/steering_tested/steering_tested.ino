#include <Wire.h>

const int SLAVE_ADDRESSES[] = {2, 3, 4}; 
const int NUM_SLAVES = 3;

// --- Распиновка ---
const int PUL = 6;
const int DIR = 7;
const int ENA = 8;
const int OPTO_PIN = 18;

// --- Настройки скорости ---
const unsigned long STEP_PERIOD_US = 100;
const unsigned long CALIB_STEP_PERIOD_US = 2000;
const float STEPS_PER_DEGREE = 133.333333;

// --- Настройки калибровки ---
const int CALIB_SEARCH_DEGREES = 100;
const int CALIB_SLOW_SEARCH_DEGREES = 20;
const bool OPTO_ACTIVE_LOW = true;

// --- Переменные состояния мотора ---
volatile long current_step = 0;
volatile long target_step = 0;
volatile bool is_moving = false;

// --- Переменные циклического режима ---
bool is_cycling = false;
long cycle_start_step = 0;
long cycle_offset_steps = 0;
bool cycle_direction_forward = true;

unsigned long last_step_time = 0;
bool pulse_state = false;
unsigned long step_period_current = STEP_PERIOD_US;

String inputString = "";

// --- Машина состояний калибровки ---
enum CalibState {
  CALIB_IDLE,
  CALIB_FAST_RIGHT,
  CALIB_FAST_LEFT,
  CALIB_SLOW_RIGHT,
  CALIB_SLOW_LEFT,
  CALIB_MOVE_TO_ZERO
};

volatile CalibState calib_state = CALIB_IDLE;
long calib_right_edge = 0;
long calib_left_edge = 0;
long calib_zero_point = 0;
long calib_start_step = 0;  // Позиция в начале фазы поиска

void processCommand(String cmd);
void handleCalibration();

void setup() {
  Serial.begin(115200);
  inputString.reserve(64);
  
  Wire.begin();
  Wire.setClock(400000);
  
  pinMode(PUL, OUTPUT);
  pinMode(DIR, OUTPUT);
  pinMode(ENA, OUTPUT);
  digitalWrite(ENA, HIGH);
  
  pinMode(OPTO_PIN, INPUT_PULLUP);
  
  Serial.println(F("--- MASTER: Система с калибровкой ---"));
  Serial.println(F("Команды: c [градусы], c c, d [градусы] [f/b], h, s, g, p, z, k"));
}

void loop() {
  if (calib_state != CALIB_IDLE) {
    handleCalibration();
  }
  
  long local_current, local_target;
  bool local_moving;
  unsigned long current_period;
  noInterrupts();
  local_current = current_step;
  local_target = target_step;
  local_moving = is_moving;
  current_period = step_period_current;
  interrupts();

  if (local_moving && (local_current != local_target)) {
    unsigned long now = micros();
    if (now - last_step_time >= (current_period / 2)) {
      last_step_time = now;
      pulse_state = !pulse_state;
      digitalWrite(PUL, pulse_state);
      if (!pulse_state) {
        noInterrupts();
        if (target_step > current_step) current_step++;
        else current_step--;
        local_current = current_step;
        interrupts();
        
        if (local_current == local_target) {
          noInterrupts();
          is_moving = false;
          interrupts();
          
          if (is_cycling) {
            if (cycle_direction_forward) {
              digitalWrite(DIR, HIGH); 
              noInterrupts();
              target_step = cycle_start_step;
              is_moving = true;
              interrupts();
              cycle_direction_forward = false;
            } else {
              digitalWrite(DIR, LOW); 
              noInterrupts();
              target_step = cycle_start_step + cycle_offset_steps;
              is_moving = true;
              interrupts();
              cycle_direction_forward = true;
            }
          } else if (calib_state == CALIB_IDLE) {
            float current_angle = (float)local_current / STEPS_PER_DEGREE;
            Serial.print(F("Цель достигнута. Угол: "));
            Serial.print(current_angle, 2);
            Serial.println(F("°"));
          }
        }
      }
    }
  }

  while (Serial.available() > 0) {
    char inChar = (char)Serial.read();
    if (inChar == '\n' || inChar == '\r') {
      inputString.trim();
      if (inputString.length() > 0) {
        for (int i = 0; i < NUM_SLAVES; i++) {
          Wire.beginTransmission(SLAVE_ADDRESSES[i]);
          Wire.write(inputString.c_str());
          Wire.endTransmission();
        }
        processCommand(inputString);
      }
      inputString = "";
    } else {
      if (inputString.length() < 60) inputString += inChar;
    }
  }
}

void handleCalibration() {
  bool opto_triggered;
  if (OPTO_ACTIVE_LOW) {
    opto_triggered = (digitalRead(OPTO_PIN) == LOW);
  } else {
    opto_triggered = (digitalRead(OPTO_PIN) == HIGH);
  }
  
  long local_current;
  noInterrupts();
  local_current = current_step;
  interrupts();
  
  switch (calib_state) {
    case CALIB_FAST_RIGHT:
      if (opto_triggered) {
        noInterrupts();
        calib_right_edge = current_step;
        is_moving = false;
        interrupts();
        
        Serial.print(F("Калибровка: Быстрый поиск вправо - найдено на шаге "));
        Serial.println(calib_right_edge);
        
        step_period_current = CALIB_STEP_PERIOD_US;
        digitalWrite(DIR, HIGH);
        noInterrupts();
        target_step = current_step - (long)(CALIB_SLOW_SEARCH_DEGREES * STEPS_PER_DEGREE);
        is_moving = true;
        interrupts();
        calib_state = CALIB_SLOW_RIGHT;
      } else {
        long steps_done = local_current - calib_start_step;
        if (steps_done > (long)(CALIB_SEARCH_DEGREES * STEPS_PER_DEGREE)) {
          Serial.println(F("Калибровка: Не найдено вправо, едем влево на 200°..."));
          noInterrupts();
          is_moving = false;
          interrupts();
          
          digitalWrite(DIR, HIGH);
          noInterrupts();
          calib_start_step = current_step;
          target_step = current_step - (long)(2 * CALIB_SEARCH_DEGREES * STEPS_PER_DEGREE);
          is_moving = true;
          interrupts();
          calib_state = CALIB_FAST_LEFT;
        }
      }
      break;
      
    case CALIB_FAST_LEFT:
      if (opto_triggered) {
        noInterrupts();
        calib_left_edge = current_step;
        is_moving = false;
        interrupts();
        
        Serial.print(F("Калибровка: Быстрый поиск влево - найдено на шаге "));
        Serial.println(calib_left_edge);
        
        step_period_current = CALIB_STEP_PERIOD_US;
        digitalWrite(DIR, LOW);
        noInterrupts();
        target_step = current_step + (long)(CALIB_SLOW_SEARCH_DEGREES * STEPS_PER_DEGREE);
        is_moving = true;
        interrupts();
        calib_state = CALIB_SLOW_LEFT;
      }
      break;
      
    case CALIB_SLOW_RIGHT:
      if (opto_triggered) {
        noInterrupts();
        calib_right_edge = current_step;
        is_moving = false;
        interrupts();
        
        Serial.print(F("Калибровка: Медленный подход справа - точная точка "));
        Serial.println(calib_right_edge);
        
        digitalWrite(DIR, HIGH);
        noInterrupts();
        target_step = current_step - (long)(2 * CALIB_SLOW_SEARCH_DEGREES * STEPS_PER_DEGREE);
        is_moving = true;
        interrupts();
        calib_state = CALIB_SLOW_LEFT;
      }
      break;
      
    case CALIB_SLOW_LEFT:
      if (opto_triggered) {
        noInterrupts();
        calib_left_edge = current_step;
        is_moving = false;
        interrupts();
        
        Serial.print(F("Калибровка: Медленный подход слева - точная точка "));
        Serial.println(calib_left_edge);
        
        calib_zero_point = (calib_right_edge + calib_left_edge) / 2;
        Serial.print(F("Калибровка: Точка 0 = "));
        Serial.println(calib_zero_point);
        
        step_period_current = STEP_PERIOD_US;
        if (calib_zero_point > current_step) {
          digitalWrite(DIR, LOW);
        } else {
          digitalWrite(DIR, HIGH);
        }
        noInterrupts();
        target_step = calib_zero_point;
        is_moving = true;
        interrupts();
        calib_state = CALIB_MOVE_TO_ZERO;
      }
      break;
      
    case CALIB_MOVE_TO_ZERO:
      if (local_current == target_step && !is_moving) {
        noInterrupts();
        current_step = 0;
        target_step = 0;
        is_moving = false;
        interrupts();
        
        calib_state = CALIB_IDLE;
        Serial.println(F("Калибровка ЗАВЕРШЕНА! Точка 0 установлена."));
      }
      break;
      
    default:
      break;
  }
}

void processCommand(String cmd) {
  cmd.toLowerCase();
  
  if (cmd == "k") {
    if (calib_state != CALIB_IDLE) {
      Serial.println(F("Калибровка уже запущена!"));
      return;
    }
    
    is_cycling = false;
    noInterrupts();
    is_moving = false;
    interrupts();
    
    step_period_current = STEP_PERIOD_US;
    digitalWrite(DIR, LOW);
    
    noInterrupts();
    calib_start_step = current_step;
    target_step = current_step + (long)(CALIB_SEARCH_DEGREES * STEPS_PER_DEGREE);
    is_moving = true;
    interrupts();
    
    calib_state = CALIB_FAST_RIGHT;
    Serial.println(F("Калибровка: Быстрый поиск вправо на 100°..."));
  }
  else if (cmd.startsWith("c ")) {
    String param = cmd.substring(2);
    param.trim();
    if (param == "c") {
      if (is_cycling) {
        is_cycling = false;
        noInterrupts();
        is_moving = false;
        long copy_step = current_step;
        interrupts();
        float current_angle = (float)copy_step / STEPS_PER_DEGREE;
        Serial.print(F("ЦИКЛ ВЫКЛ. Угол: "));
        Serial.print(current_angle, 2);
        Serial.println(F("°"));
      } else {
        Serial.println(F("Цикл и так выключен."));
      }
    } else {
      float degrees = param.toFloat();
      if (degrees <= 0) {
        Serial.println(F("Ошибка: Угол > 0!"));
        return;
      }
      noInterrupts();
      cycle_start_step = current_step;
      interrupts();
      cycle_offset_steps = round(degrees * STEPS_PER_DEGREE);
      is_cycling = true;
      cycle_direction_forward = true;
      digitalWrite(DIR, LOW); 
      noInterrupts();
      target_step = cycle_start_step + cycle_offset_steps;
      is_moving = true;
      interrupts();
      Serial.print(F("ЦИКЛ качания на "));
      Serial.print(degrees, 2);
      Serial.println(F("°"));
    }
  }
  else if (cmd.startsWith("d ")) {
    is_cycling = false;
    int firstSpace = cmd.indexOf(' ');
    int secondSpace = cmd.indexOf(' ', firstSpace + 1);
    if (secondSpace == -1) {
      Serial.println(F("Шаблон: d [градусы] [f/b]"));
      return;
    }
    String degStr = cmd.substring(firstSpace + 1, secondSpace);
    String dirStr = cmd.substring(secondSpace + 1);
    degStr.trim();
    dirStr.trim();
    if (dirStr.length() > 1) dirStr = dirStr.substring(0, 1);
    float degrees = degStr.toFloat();
    if (degrees <= 0) {
      Serial.println(F("Ошибка: Угол > 0!"));
      return;
    }
    long steps = round(degrees * STEPS_PER_DEGREE);
    if (dirStr == "f") {
      digitalWrite(DIR, LOW);
      noInterrupts();
      target_step = current_step + steps;
      is_moving = true;
      interrupts();
      Serial.print(F("ВПЕРЕД (F) на "));
      Serial.print(degrees, 2);
      Serial.println(F("°"));
    }
    else if (dirStr == "b") {
      digitalWrite(DIR, HIGH);
      noInterrupts();
      target_step = current_step - steps;
      is_moving = true;
      interrupts();
      Serial.print(F("НАЗАД (B) на "));
      Serial.print(degrees, 2);
      Serial.println(F("°"));
    }
    else {
      Serial.println(F("Ошибка направления! f или b"));
    }
  }
  else if (cmd == "h") {
    is_cycling = false;
    noInterrupts();
    long current = current_step;
    interrupts();
    if (current == 0) {
      Serial.println(F("Уже в 0°."));
      return;
    }
    if (0 > current) {
      digitalWrite(DIR, LOW);
      Serial.println(F("Домой: ВПЕРЕД..."));
    } else {
      digitalWrite(DIR, HIGH);
      Serial.println(F("Домой: НАЗАД..."));
    }
    noInterrupts();
    target_step = 0;
    is_moving = true;
    interrupts();
  }
  else if (cmd == "s") {
    is_cycling = false;
    noInterrupts();
    is_moving = false;
    long copy_step = current_step;
    interrupts();
    float current_angle = (float)copy_step / STEPS_PER_DEGREE;
    Serial.print(F("ПАУЗА. Угол: "));
    Serial.print(current_angle, 2);
    Serial.println(F("°"));
  }
  else if (cmd == "g") {
    noInterrupts();
    if (current_step != target_step) {
      is_moving = true;
      Serial.println(F("ПРОДОЛЖЕНИЕ..."));
    } else {
      Serial.println(F("Уже в цели."));
    }
    interrupts();
  }
  else if (cmd == "p") {
    noInterrupts();
    long c = current_step;
    long t = target_step;
    bool m = is_moving;
    interrupts();
    Serial.print(F("Текущий: "));
    Serial.print((float)c / STEPS_PER_DEGREE, 2);
    if (is_cycling) {
      Serial.println(F("° [ЦИКЛ]"));
    } else {
      Serial.print(F("° | Целевой: "));
      Serial.print((float)t / STEPS_PER_DEGREE, 2);
      Serial.println(m ? F("° [ДВИЖ]") : F("° [СТОИТ]"));
    }
  }
  else if (cmd == "z") {
    is_cycling = false;
    noInterrupts();
    current_step = 0;
    target_step = 0;
    is_moving = false;
    interrupts();
    Serial.println(F("ОБНУЛЕНА."));
  }
  else {
    Serial.println(F("Неизв. команда"));
  }
}