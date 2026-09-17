# Обнаруженный дорожный знак
std_msgs/Header header
string class_id            # "stop" | "pedestrian_crossing" | "speed_bump" | "unknown"
float32 confidence         # 0.0..1.0
float32 distance           # оценка дистанции до знака, м (−1 если неизвестна)
int32 x                    # область интереса на изображении
int32 y
int32 width
int32 height
