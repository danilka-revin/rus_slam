# Статус файлов PCB

`pcb/` — **инженерный архив проекта v1.0**, а не комплект для сборки текущего
робота. Пины платы не совпадают с прошивкой
[`firmware/motor_wheel`](../firmware/motor_wheel/motor_wheel.ino).

| Что | Расхождение |
| :--- | :--- |
| `CONNECTOR_PINOUTS.csv` | J_HALL → D2/D3/D18, J_ENC → D20/D21, J_HOME → D19, J_TB6600 → D4/D5/D6. В прошивке: Холлы и энкодер не подключены, оптодатчик — **D18**, потенциометр — **A0**, TB6600 — **D6/D7/D8** |
| `kicad_netlist.net` | содержит PWM_H* / PWM_L* на D8–D13 и HALL_* на D2/D3/D18 |
| `BOM.csv` | включает 6 × IRFB4110, FD6288Q, шунт, INA180 — для собственного инвертора |
| `SCHEMATIC_CIRCUIT_DESIGN.md` | расчёт силовой части собственного инвертора |
| `easyeda_schematic_guide.md` | инструкция разводки той же платы |

Актуальные распиновки: [`../docs/ELECTRICAL_AND_PINOUTS.md`](../docs/ELECTRICAL_AND_PINOUTS.md)
и [`../firmware/README.md`](../firmware/README.md).
