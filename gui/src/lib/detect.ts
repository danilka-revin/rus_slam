// Демо-поток распознавания объектов (YOLOv8-стиль): цикл светофора,
// случайные обнаружения (знак СТОП, пешеход, переход) с box'ами в NDC
// координатах кадра и уверенность conf. Позже — реальные detections с ROS 2.

import type { SimEvent } from './simulator'

export type DetId = 'stop' | 'ped' | 'cross' | 'tl'
export type TlState = 'green' | 'yellow' | 'red'

export interface Detection {
  id: DetId
  en: string
  ru: string
  color: string
  conf: number
  box: { x: number; y: number; w: number; h: number }
}

export const TL_COLOR: Record<TlState, string> = {
  green: '#3ddc84',
  yellow: '#ffd166',
  red: '#ff5d55',
}

export const TL_LABEL: Record<TlState, string> = {
  green: 'GREEN',
  yellow: 'YELLOW',
  red: 'RED',
}

const BASE_BOX: Record<DetId, { x: number; y: number; w: number; h: number }> = {
  stop: { x: 0.17, y: 0.36, w: 0.11, h: 0.2 },
  ped: { x: 0.66, y: 0.28, w: 0.09, h: 0.4 },
  cross: { x: 0.34, y: 0.7, w: 0.34, h: 0.18 },
  tl: { x: 0.5, y: 0.4, w: 0.07, h: 0.3 },
}

export class Detector {
  tl: TlState = 'green'
  active: Detection[] = []
  t = 0

  private tlT = 0
  private life: Partial<Record<DetId, number>> = {}
  private nextSpawn: Partial<Record<DetId, number>> = { stop: 2, ped: 4, cross: 3 }
  private events: SimEvent[] = []

  takeEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }

  private emit(msg: string, level: SimEvent['level']): void {
    this.events.push({ msg, level })
  }

  tick(dt: number): void {
    this.t += dt

    // цикл светофора: зелёный 7 с → жёлтый 2 с → красный 7 с
    this.tlT += dt
    const dur = this.tl === 'green' ? 7 : this.tl === 'yellow' ? 2 : 7
    if (this.tlT >= dur) {
      this.tlT = 0
      this.tl = this.tl === 'green' ? 'yellow' : this.tl === 'yellow' ? 'red' : 'green'
      if (this.tl === 'green') this.emit('Светофор: ЗЕЛЁНЫЙ — движение разрешено', 'ok')
      else if (this.tl === 'yellow') this.emit('Светофор: ЖЁЛТЫЙ — приготовиться', 'warn')
      else this.emit('Светофор: КРАСНЫЙ — движение запрещено', 'err')
    }

    // детекции: старение + случайное появление
    const activeIds = new Set<DetId>()
    const keep: Detection[] = []
    for (const d of this.active) {
      if (d.id === 'tl') {
        activeIds.add('tl')
        keep.push({ ...d, color: TL_COLOR[this.tl] })
        continue
      }
      const left = (this.life[d.id] ?? 0) - dt
      if (left <= 0) continue
      this.life[d.id] = left
      activeIds.add(d.id)
      const jx = Math.sin(this.t * 0.9 + d.box.x * 9) * 0.006
      const jy = Math.cos(this.t * 0.7 + d.box.y * 7) * 0.004
      keep.push({ ...d, box: { ...d.box, x: d.box.x + jx, y: d.box.y + jy } })
    }
    this.active = keep

    const spawn = (id: Exclude<DetId, 'tl'>, ru: string, en: string, color: string): void => {
      const conf = 0.9 + Math.random() * 0.09
      this.active.push({ id, ru, en, color, conf, box: { ...BASE_BOX[id] } })
      this.life[id] = 4 + Math.random() * 4
      this.nextSpawn[id] = 9 + Math.random() * 12
      if (id === 'ped') this.emit('Обнаружено препятствие: пешеход на переходе', 'warn')
      else if (id === 'stop') this.emit('Распознан знак «СТОП»', 'info')
    }

    if (!activeIds.has('stop') && (this.nextSpawn.stop ?? 0) <= 0) {
      spawn('stop', 'Знак «СТОП»', 'STOP sign', '#ff6b63')
    } else {
      this.nextSpawn.stop = (this.nextSpawn.stop ?? 0) - dt
    }
    if (!activeIds.has('ped') && (this.nextSpawn.ped ?? 0) <= 0) {
      spawn('ped', 'Пешеход', 'Pedestrian', '#ffd166')
    } else {
      this.nextSpawn.ped = (this.nextSpawn.ped ?? 0) - dt
    }
    if (!activeIds.has('cross') && (this.nextSpawn.cross ?? 0) <= 0) {
      spawn('cross', 'Пешеходный переход', 'Crosswalk', '#38e0e0')
    } else {
      this.nextSpawn.cross = (this.nextSpawn.cross ?? 0) - dt
    }
    // светофор виден почти всегда (появляется, если пропал)
    if (!activeIds.has('tl')) {
      this.active.push({
        id: 'tl',
        ru: 'Светофор',
        en: 'Traffic light',
        color: TL_COLOR[this.tl],
        conf: 0.95 + Math.random() * 0.04,
        box: { ...BASE_BOX.tl },
      })
    }
  }
}
