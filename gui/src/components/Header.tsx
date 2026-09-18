import { IconCamera, IconMap, IconSliders } from './icons'
import type { ViewMode } from '../lib/settings'

interface Props {
  view: ViewMode
  onView: (v: ViewMode) => void
  onCustomize: () => void
}

export function Header({ view, onView, onCustomize }: Props) {
  return (
    <header>
      <div>
        <h1>Пульт робота «РУС-SLAM»</h1>
        <p>
          Лидар ЛДС-01 (сверху спереди по центру) • камера • крабовый ход — демо-режим
        </p>
      </div>

      {/* Тумблер быстрого переключения окон — по центру шапки */}
      <div className="view-toggle" role="tablist" aria-label="Окно дисплея">
        <button
          role="tab"
          aria-selected={view === 'map'}
          className={view === 'map' ? 'active' : ''}
          onClick={() => onView('map')}
          title="Карта SLAM (клавиша 1)"
        >
          <IconMap />
          <span>Карта</span>
          <kbd>1</kbd>
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
          <kbd>2</kbd>
        </button>
      </div>

      <div className="head-actions">
        <button className="icon-btn accent" onClick={onCustomize} title="Кастомизация (K)">
          <IconSliders />
          <span>Кастомизация</span>
        </button>
      </div>
    </header>
  )
}
