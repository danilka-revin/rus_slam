// Левая панель: «ПАНЕЛЬ ЗАКАЗОВ» — точки A/B, отправка задания,
// экстренная остановка, статус робота и отсека.

import {
  SELECTABLE_POINTS,
  pointById,
} from '../lib/territory'
import type { SectionState } from '../lib/simulator'
import { IconPower, IconSend, IconSwap, IconTarget } from './icons'

interface Props {
  aId: string
  bId: string
  onA: (id: string) => void
  onB: (id: string) => void
  onSwap: () => void
  onSend: () => void
  estop: boolean
  onEstop: () => void
  section: SectionState
  statusText: string
  taskCode: string
}

export const SECTION_LABEL: Record<SectionState, string> = {
  closed: 'ЗАКРЫТ',
  opening: 'ОТКРЫВАЕТСЯ…',
  open: 'ОТКРЫТ',
  closing: 'ЗАКРЫВАЕТСЯ…',
}

export function DispatchPanel({
  aId,
  bId,
  onA,
  onB,
  onSwap,
  onSend,
  estop,
  onEstop,
  section,
  statusText,
  taskCode,
}: Props) {
  return (
    <section className="panel">
      <div className="pt">
        <IconTarget size={14} />
        <h3>Панель заказов</h3>
        <span className="sub">{taskCode}</span>
      </div>
      <div className="dp-body">
        <label className="dp-label">Точка отправления (A)</label>
        <div className="dp-selectrow">
          <select className="select" value={aId} onChange={(e) => onA(e.target.value)}>
            {SELECTABLE_POINTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button className="dp-swap" onClick={onSwap} title="Поменять A и B местами">
            <IconSwap size={15} />
          </button>
        </div>

        <label className="dp-label">Точка назначения (B)</label>
        <div className="dp-selectrow">
          <select className="select" value={bId} onChange={(e) => onB(e.target.value)}>
            {SELECTABLE_POINTS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <button className="btn btn-primary" onClick={onSend} disabled={aId === bId}>
          <IconSend size={14} />
          Отправить задание
        </button>
        <button className={`btn btn-estop${estop ? ' active' : ''}`} onClick={onEstop}>
          <IconPower size={14} />
          {estop ? 'Остановлено — сбросить E-STOP' : 'Экстренная остановка (E-STOP)'}
        </button>

        <div className="dp-status">
          <span className="tag">
            <i className={section === 'open' || section === 'opening' ? 'on' : ''} />
            отсек: {SECTION_LABEL[section]}
          </span>
          <span className="tag">{statusText}</span>
        </div>

        <p className="dp-note">
          Маршрут прокладывается автоматически по дорожной сети территории. Кликните по точке
          на карте, чтобы назначить пункт Б. Схема: движение А → Б, открыть отсек,
          ожидание, закрыть отсек, ожидание, возврат на точку А. Пробел — E-STOP.
        </p>
      </div>
    </section>
  )
}

export function pointName(id: string): string {
  return pointById(id).name
}
