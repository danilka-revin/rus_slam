// «СХЕМА ЗАДАНИЯ» — миссия как программа из блоков:
// А → Б → открыть отсек → ожидание → закрыть отсек → ожидание →
// возврат на А → ожидание задания. Активный блок подсвечен,
// пройденные отмечены, у активных — прогресс-бар.

import type { Mission } from '../lib/simulator'
import { pointName } from './DispatchPanel'
import { IconBox, IconCheck, IconFlow } from './icons'

interface Props {
  mission: Mission | null
  estop: boolean
  actionDur: number
  waitDur: number
}

interface Block {
  id: string
  label: string
  meta: string
}

function buildBlocks(m: Mission | null, actionDur: number, waitDur: number): Block[] {
  const from = m ? pointName(m.from) : 'А'
  const to = m ? pointName(m.to) : 'Б'
  const lenB = m ? `${Math.round(m.lenB)} м` : '—'
  const lenA = m ? `${Math.round(m.lenA)} м` : '—'
  return [
    { id: 'drive_b', label: `Движение ${from} → ${to}`, meta: `${lenB} по дорожной сети` },
    { id: 'open', label: 'Открыть отсек', meta: `${actionDur} с` },
    { id: 'wait1', label: 'Ожидание', meta: `${waitDur} с` },
    { id: 'close', label: 'Закрыть отсек', meta: `${actionDur} с` },
    { id: 'wait2', label: 'Ожидание', meta: `${waitDur} с` },
    { id: 'drive_a', label: `Возврат ${to} → ${from}`, meta: `${lenA} по дорожной сети` },
    { id: 'idle', label: 'Ожидание задания', meta: `на точке ${from}` },
  ]
}

function phaseOf(m: Mission | null): string {
  return m ? m.phase : 'patrol'
}

export function SchemePanel({ mission, estop, actionDur, waitDur }: Props) {
  const blocks = buildBlocks(mission, actionDur, waitDur)
  const phase = phaseOf(mission)
  const idleAllDone = mission !== null && phase === 'idle'

  const statusOf = (id: string): 'done' | 'active' | 'pending' => {
    if (!mission) return 'pending'
    if (idleAllDone && id !== 'idle') return 'done'
    const order = ['drive_b', 'open', 'wait1', 'close', 'wait2', 'drive_a', 'idle']
    const cur = order.indexOf(phase)
    const idx = order.indexOf(id)
    if (idx < cur) return 'done'
    if (idx === cur) return 'active'
    return 'pending'
  }

  const progressOf = (id: string): number => {
    if (!mission || statusOf(id) !== 'active') return 0
    const m = mission
    switch (id) {
      case 'drive_b':
        return m.lenB > 0 ? Math.min(1, m.traveledB / m.lenB) : 1
      case 'drive_a':
        return m.lenA > 0 ? Math.min(1, m.traveledA / m.lenA) : 1
      case 'open':
      case 'close':
        return Math.min(1, m.phaseT / Math.max(0.1, actionDur))
      case 'wait1':
      case 'wait2':
        return Math.min(1, m.phaseT / Math.max(0.1, waitDur))
      default:
        return 0
    }
  }

  const metaDetail = (id: string): string => {
    if (!mission) return ''
    const m = mission
    if (id === 'drive_b') return `осталось ${Math.max(0, Math.round(m.lenB - m.traveledB))} м`
    if (id === 'drive_a') return `осталось ${Math.max(0, Math.round(m.lenA - m.traveledA))} м`
    if (id === 'idle') return 'ожидание'
    return ''
  }

  return (
    <section className="panel scheme">
      <div className="pt">
        <IconFlow size={14} />
        <h3>Схема задания</h3>
        <span className="sub">
          {mission ? `${mission.code} • ${pointName(mission.from)} → ${pointName(mission.to)}` : 'автопатруль'}
        </span>
      </div>

      {estop && (
        <div className="estop-banner">
          <IconBox size={13} />
          E-STOP: движение остановлено
        </div>
      )}

      <div className="scheme-list">
        {blocks.map((b, i) => {
          const st = statusOf(b.id)
          const prog = progressOf(b.id)
          return (
            <div key={b.id}>
              {i > 0 && <div className="s-conn" />}
              <div className={`sblock ${st}`}>
                <div className="s-idx">{st === 'done' ? <IconCheck size={11} /> : i + 1}</div>
                <div className="s-body">
                  <b>{b.label}</b>
                  <small>
                    {b.meta}
                    {st === 'active' && metaDetail(b.id) ? ` • ${metaDetail(b.id)}` : ''}
                  </small>
                  {st === 'active' && (
                    <div className="s-prog">
                      <i style={{ width: `${(prog * 100).toFixed(0)}%` }} />
                    </div>
                  )}
                </div>
                <div className="s-state">{st === 'done' ? '✓' : st === 'active' ? '…' : ''}</div>
              </div>
            </div>
          )
        })}
        {!mission && (
          <p className="scheme-note">
            Задание не назначено — робот выполняет автопатруль. Отправьте задание из панели
            заказов выше.
          </p>
        )}
      </div>
    </section>
  )
}
