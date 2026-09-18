// Шапка: бренд НТЦ АВТОВАЗ, вкладки «Карта / Камера» по центру,
// чипы телеметрии справа (связь, батарея, скорость, LiDAR, часы).

import { IconBattery, IconCamera, IconGauge, IconMap, IconRobot, IconSliders } from './icons'
import type { ViewMode } from '../lib/settings'

export interface HeaderTele {
  battery: number
  speedKmh: number
  clock: string
  estop: boolean
  lidarOk: boolean
}

interface Props {
  view: ViewMode
  onView: (v: ViewMode) => void
  onCustomize: () => void
  tele: HeaderTele
}

export function Header({ view, onView, onCustomize, tele }: Props) {
  return (
    <header>
      <div className="brand">
        <div className="brandmark">
          <IconRobot size={20} />
        </div>
        <div className="brand-txt">
          <b>НТЦ АВТОВАЗ</b>
          <small>Диспетчер автономной логистики</small>
        </div>
      </div>

      {/* Вкладки быстрого переключения окон — по центру шапки */}
      <div className="view-toggle" role="tablist" aria-label="Окно дисплея">
        <button
          role="tab"
          aria-selected={view === 'map'}
          className={view === 'map' ? 'active' : ''}
          onClick={() => onView('map')}
          title="Карта лидара (клавиша 1)"
        >
          <IconMap />
          <span>Карта</span>
        </button>
        <button
          role="tab"
          aria-selected={view === 'camera'}
          className={view === 'camera' ? 'active' : ''}
          onClick={() => onView('camera')}
          title="Вид с камеры (клавиша 2)"
        >
          <IconCamera />
          <span>Камера</span>
        </button>
      </div>

      <div className="chips">
        <span className="chip" title="Состояние связи (демо)">
          <i className={`dot ${tele.estop ? 'red' : 'amber'}`} />
          {tele.estop ? (
            <b className="danger">E-STOP</b>
          ) : (
            <>
              Демо <span className="dim">(имитация ROS 2)</span>
            </>
          )}
        </span>
        <span className="chip" title="Батарея">
          <IconBattery size={13} />
          <b>{tele.battery.toFixed(0)}%</b>
        </span>
        <span className="chip" title="Скорость">
          <IconGauge size={13} />
          Скорость: <b>{tele.speedKmh.toFixed(1)} км/ч</b>
        </span>
        <span className="chip" title="Лидар ЛДС-01">
          <i className={`dot ${tele.lidarOk ? 'green' : 'red'}`} />
          LiDAR <b>{tele.lidarOk ? 'OK' : '—'}</b>
        </span>
        <span className="chip chip-clock">{tele.clock}</span>
        <button className="chip chip-btn" onClick={onCustomize} title="Кастомизация (K)">
          <IconSliders size={13} />
          Настройки
        </button>
      </div>
    </header>
  )
}
