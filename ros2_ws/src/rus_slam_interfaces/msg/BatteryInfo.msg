# Сводное состояние тяговой батареи (по данным модулей)
std_msgs/Header header
float32 voltage            # напряжение шины, В
float32 current            # суммарный ток, А
float32 soc_percent        # оценка заряженности, % (по напряжению 12S LiFePO4)
uint8 level                # 3=норма, 2=низкий, 1=критический, 0=авария
