# Телеметрия одного поворотно-тягового модуля
std_msgs/Header header
uint8 module_id            # 1=FL, 2=FR, 3=RL, 4=RR
bool enabled               # приводы под моментом
bool homed                 # найден нулевой азимут
bool fault                 # неисправность модуля
float32 steer_angle        # фактический угол модуля, рад
float32 wheel_speed        # линейная скорость колеса, м/с (по энкодеру)
float32 battery_voltage    # напряжение силовой шины, В
float32 current            # ток мотор-колеса, А
