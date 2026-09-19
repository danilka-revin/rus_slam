// Панель кастомизации: тема, акцент, шрифт, карта, камера.
// Все параметры сохраняются в localStorage и применяются сразу.

import { ACCENTS, type Settings } from '../lib/settings'
import { IconReset, IconSliders, IconX } from './icons'
import type { CSSProperties, ReactNode } from 'react'

interface Props {
  open: boolean
  onClose: () => void
  settings: Settings
  patch: (p: Partial<Settings>) => void
  onReset: () => void
}

function Switch({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" checked={on} onChange={onChange} />
      <i />
    </label>
  )
}

function Row({
  title,
  hint,
  children,
  grow,
}: {
  title: string
  hint?: string
  children: ReactNode
  grow?: boolean
}) {
  return (
    <div className={`cz-row${grow ? ' grow' : ''}`}>
      <span>
        <b>{title}</b>
        {hint && <small>{hint}</small>}
      </span>
      {children}
    </div>
  )
}

function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.value} className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Customizer({ open, onClose, settings, patch, onReset }: Props) {
  return (
    <>
      <div className={`cz-backdrop${open ? ' open' : ''}`} onClick={onClose} />
      <aside className={`customizer${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="cz-head">
          <IconSliders size={18} />
          <div style={{ flex: 1 }}>
            <h2>Кастомизация</h2>
            <p>Все параметры сохраняются локально</p>
          </div>
          <button className="cz-close" onClick={onClose} title="Закрыть (Esc)">
            <IconX size={14} />
          </button>
        </div>

        <div className="cz-body">
          <div className="cz-section">
            <b>Внешний вид</b>
            <Row title="Тема" hint="Как в ZMK Vision: светлая / тёмная">
              <Seg
                value={settings.theme}
                onChange={(v) => patch({ theme: v })}
                options={[
                  { value: 'light', label: 'Светлая' },
                  { value: 'dark', label: 'Тёмная' },
                  { value: 'system', label: 'Авто' },
                ]}
              />
            </Row>
            <Row title="Акцентный цвет" hint="Лайм — фирменный">
              <div className="swatches">
                {ACCENTS.map((a) => (
                  <button
                    key={a.value}
                    className={`swatch${settings.accent === a.value ? ' active' : ''}`}
                    style={{ '--sw': a.value } as CSSProperties}
                    title={a.name}
                    onClick={() => patch({ accent: a.value })}
                  />
                ))}
              </div>
            </Row>
            <Row title="Размер шрифта">
              <Seg
                value={settings.font}
                onChange={(v) => patch({ font: v })}
                options={[
                  { value: 's', label: 'S' },
                  { value: 'm', label: 'M' },
                  { value: 'l', label: 'L' },
                ]}
              />
            </Row>
          </div>

          <div className="cz-section">
            <b>Карта</b>
            <Row title="Стиль карты">
              <Seg
                value={settings.mapStyle}
                onChange={(v) => patch({ mapStyle: v })}
                options={[
                  { value: 'light', label: 'Светлая' },
                  { value: 'dark', label: 'Тёмная' },
                ]}
              />
            </Row>
            <Row title="Следовать за роботом" hint="Автоцентрирование; сдвиг вручную отключает">
              <Switch on={settings.followRobot} onChange={() => patch({ followRobot: !settings.followRobot })} label="follow" />
            </Row>
            <Row title="Сетка в метрах">
              <Switch on={settings.showGrid} onChange={() => patch({ showGrid: !settings.showGrid })} label="grid" />
            </Row>
            <Row title="Шлейф пройденного пути">
              <Switch on={settings.showTrail} onChange={() => patch({ showTrail: !settings.showTrail })} label="trail" />
            </Row>
            <Row title="Точки скана лидара" hint="Облако точек с ЛДС-01, 8 Гц">
              <Switch on={settings.showScan} onChange={() => patch({ showScan: !settings.showScan })} label="scan" />
            </Row>
            <Row title={`Масштаб метки робота ×${settings.markerScale.toFixed(1)}`}>
              <input
                type="range"
                min={0.6}
                max={2}
                step={0.1}
                value={settings.markerScale}
                onChange={(e) => patch({ markerScale: Number(e.target.value) })}
              />
            </Row>
          </div>

          <div className="cz-section">
            <b>Задание (миссия)</b>
            <Row title={`Действие с отсек: ${settings.actionDur.toFixed(0)} с`} hint="Открытие / закрытие">
              <input
                type="range"
                min={1}
                max={8}
                step={1}
                value={settings.actionDur}
                onChange={(e) => patch({ actionDur: Number(e.target.value) })}
              />
            </Row>
            <Row title={`Ожидание: ${settings.waitDur.toFixed(0)} с`} hint="После открытия и после закрытия">
              <input
                type="range"
                min={0}
                max={15}
                step={1}
                value={settings.waitDur}
                onChange={(e) => patch({ waitDur: Number(e.target.value) })}
              />
            </Row>
          </div>

          <div className="cz-section">
            <b>Камера</b>
            <Row title="Качество демо-рендера" hint="Число строк рейкастинга">
              <Seg
                value={settings.cameraQuality}
                onChange={(v) => patch({ cameraQuality: v })}
                options={[
                  { value: 'low', label: 'Низкое' },
                  { value: 'mid', label: 'Среднее' },
                  { value: 'high', label: 'Высокое' },
                ]}
              />
            </Row>
            <Row title="Сетка-сетка (правило третей)">
              <Switch on={settings.camGrid} onChange={() => patch({ camGrid: !settings.camGrid })} label="camgrid" />
            </Row>
            <Row title="Подписи и уголки (HUD)">
              <Switch on={settings.camHud} onChange={() => patch({ camHud: !settings.camHud })} label="hud" />
            </Row>
            <Row
              title="URL видео-потока"
              hint="HLS/WebM из брелка. Пусто = демо-режим (поток робота подключается позже)"
              grow
            >
              <input
                className="cz-input"
                placeholder="https://…/stream.m3u8"
                value={settings.cameraUrl}
                onChange={(e) => patch({ cameraUrl: e.target.value })}
              />
            </Row>
          </div>

          <button className="cz-reset" onClick={onReset}>
            <IconReset size={14} />
            Сбросить к значениям по умолчанию
          </button>
        </div>
      </aside>
    </>
  )
}
