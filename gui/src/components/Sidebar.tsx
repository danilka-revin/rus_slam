import { IconActivity, IconCamera, IconHistory, IconMap, IconRobot, IconRoute, IconSliders } from './icons'
import type { ViewMode } from '../lib/settings'

interface Props {
  view: ViewMode
  onView: (v: ViewMode) => void
  onCustomize: () => void
  customOpen: boolean
}

export function Sidebar({ view, onView, onCustomize, customOpen }: Props) {
  return (
    <aside className="side">
      <div className="brand">
        <div className="brandmark">
          <IconRobot size={24} />
        </div>
        <div>
          <b>RUS-SLAM</b>
          <small>НТЦ АВТОВАЗ • 4WIS / 4WID</small>
        </div>
      </div>

      <nav>
        <div className="nav-label">Окна</div>
        <button className={view === 'map' ? 'active' : ''} onClick={() => onView('map')}>
          <IconMap />
          <span>Карта SLAM</span>
        </button>
        <button className={view === 'camera' ? 'active' : ''} onClick={() => onView('camera')}>
          <IconCamera />
          <span>Камера робота</span>
        </button>

        <div className="nav-label">Операции</div>
        <button className={customOpen ? 'active' : ''} onClick={onCustomize}>
          <IconSliders />
          <span>Кастомизация</span>
        </button>
        <button className="soon" title="Скоро">
          <IconActivity />
          <span>Телеметрия</span>
          <em>скоро</em>
        </button>
        <button className="soon" title="Скоро">
          <IconRoute />
          <span>Маршруты</span>
          <em>скоро</em>
        </button>
        <button className="soon" title="Скоро">
          <IconHistory />
          <span>Журнал</span>
          <em>скоро</em>
        </button>
      </nav>

      <div className="side-status">
        <b>РОБОТ РУС-SLAM</b>
        <small>
          <span className="pulse" />
          демо-режим • 8 Гц скан
        </small>
      </div>

      <div className="profile">
        <div className="avatar">ОП</div>
        <div>
          <b>Оператор</b>
          <small>локальная сессия</small>
        </div>
      </div>
    </aside>
  )
}
