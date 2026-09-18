// Симулятор робота RB-01 на территории НТЦ:
//  - движение по дорожной сети (граф, Дейкстра) — патруль и задания;
//  - конечный автомат миссии «программа» из блоков:
//      А → Б → открыть отсек → ожидание → закрыть отсек → ожидание →
//      возврат на А → ожидание задания;
//  - E-STOP, отсек (closed/opening/open/closing), телеметрия;
//  - 360°-скан лидара ЛДС-01 (установлен сверху спереди по центру,
//    см. URDF lidar_joint x=0.32) лучами castRay из territory.ts.
// Позже заменяется мостом ROS 2 — интерфейс сохраняется.

import {
  castRay,
  PATROL,
  pointById,
  shortestPath,
  type PointDef,
} from './territory'

export const LIDAR_OFFSET_X = 0.32 // м от центра корпуса к носу
export const ROBOT_NAME = 'RB-01'
export const ROBOT_SPEED = 3.5 // м/с (≈ 12.6 км/ч)

export type SectionState = 'closed' | 'opening' | 'open' | 'closing'
export type Phase = 'patrol' | 'drive_b' | 'open' | 'wait1' | 'close' | 'wait2' | 'drive_a' | 'idle'

export interface SimEvent {
  msg: string
  level: 'ok' | 'err' | 'warn' | 'info'
}

export interface RobotState {
  x: number
  y: number
  heading: number
  vx: number
  vy: number
  battery: number
  odom: number
  t: number
}

export interface Mission {
  code: string
  from: string
  to: string
  routeB: PointDef[]
  routeA: PointDef[]
  lenB: number
  lenA: number
  traveledB: number
  traveledA: number
  phase: Phase
  phaseT: number
  mi: number // индекс waypoint на текущем участке
}

export interface ScanPoint { x: number; y: number }

function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * k
}

function pathLen(pts: PointDef[]): number {
  let l = 0
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return l
}

export class Simulator {
  readonly robot: RobotState
  estop = false
  mission: Mission | null = null
  section: SectionState = 'closed'
  trail: { x: number; y: number }[] = []
  scan: ScanPoint[] = []
  sweep = 0
  actionDur: number
  waitDur: number

  private patrolIdx = 0
  private events: SimEvent[] = []
  private lastTrail: { x: number; y: number } | null = null
  private scanAccum = 0

  constructor() {
    const start = pointById('ktp')
    this.robot = { x: start.x, y: start.y, heading: 0, vx: 0, vy: 0, battery: 95, odom: 0, t: 0 }
    this.actionDur = 3
    this.waitDur = 3
  }

  get phase(): Phase {
    return this.mission ? this.mission.phase : 'patrol'
  }

  get moving(): boolean {
    if (this.estop) return false
    const p = this.phase
    return p === 'drive_b' || p === 'drive_a' || p === 'patrol'
  }

  pushEvent(msg: string, level: SimEvent['level']): void {
    this.events.push({ msg, level })
  }

  takeEvents(): SimEvent[] {
    const e = this.events
    this.events = []
    return e
  }

  startMission(code: string, fromId: string, toId: string): void {
    const routeB = shortestPath(fromId, toId).map(pointById)
    const routeA = shortestPath(toId, fromId).map(pointById)
    this.mission = {
      code,
      from: fromId,
      to: toId,
      routeB,
      routeA,
      lenB: pathLen(routeB),
      lenA: pathLen(routeA),
      traveledB: 0,
      traveledA: 0,
      phase: 'drive_b',
      phaseT: 0,
      mi: 1,
    }
    this.section = 'closed'
    this.pushEvent(
      `Задание ${code}: ${pointById(fromId).name} → ${pointById(toId).name}`,
      'info',
    )
  }

  toggleEstop(): void {
    this.estop = !this.estop
    if (this.estop) this.pushEvent('ЭКСТРЕННАЯ ОСТАНОВКА (E-STOP)', 'err')
    else this.pushEvent('E-STOP сброшен — движение возобновлено', 'ok')
  }

  lidarPos(): { x: number; y: number } {
    const r = this.robot
    return {
      x: r.x + Math.cos(r.heading) * LIDAR_OFFSET_X,
      y: r.y + Math.sin(r.heading) * LIDAR_OFFSET_X,
    }
  }

  tick(dt: number): void {
    const r = this.robot
    r.t += dt
    this.sweep = (r.t * 1.4) % (2 * Math.PI)

    if (this.estop) {
      r.vx = 0
      r.vy = 0
      return
    }

    let tx: number = r.x
    let ty: number = r.y
    let advance = false

    const m = this.mission
    if (m) {
      switch (m.phase) {
        case 'drive_b':
        case 'drive_a': {
          const route = m.phase === 'drive_b' ? m.routeB : m.routeA
          const wp = route[m.mi]
          if (!wp) {
            this.completeLeg(m)
            return
          }
          tx = wp.x
          ty = wp.y
          advance = true
          break
        }
        case 'open':
          m.phaseT += dt
          if (m.phaseT >= this.actionDur) {
            this.section = 'open'
            m.phase = 'wait1'
            m.phaseT = 0
            this.pushEvent('Отсек открыт — ожидание', 'ok')
          }
          return
        case 'wait1':
          m.phaseT += dt
          if (m.phaseT >= this.waitDur) {
            this.section = 'closing'
            m.phase = 'close'
            m.phaseT = 0
            this.pushEvent('Закрытие отсека', 'info')
          }
          return
        case 'close':
          m.phaseT += dt
          if (m.phaseT >= this.actionDur) {
            this.section = 'closed'
            m.phase = 'wait2'
            m.phaseT = 0
            this.pushEvent('Отсек закрыт — ожидание', 'ok')
          }
          return
        case 'wait2':
          m.phaseT += dt
          if (m.phaseT >= this.waitDur) {
            m.phase = 'drive_a'
            m.phaseT = 0
            m.mi = 1
            this.pushEvent(`Возврат на точку ${pointById(m.from).name}`, 'info')
          }
          return
        case 'idle':
          return
        case 'patrol':
          break
      }
    } else {
      const wp = pointById(PATROL[this.patrolIdx])
      tx = wp.x
      ty = wp.y
      advance = true
    }

    // движение к целевой точке
    const dx = tx - r.x
    const dy = ty - r.y
    const dist = Math.hypot(dx, dy)

    if (advance && dist < 2.5) {
      const arrived = m
        ? m.phase === 'drive_b'
          ? m.mi >= m.routeB.length - 1
          : m.mi >= m.routeA.length - 1
        : this.patrolIdx >= PATROL.length - 1
      if (arrived) {
        this.completeLeg(m)
        return
      }
      if (m) m.mi += 1
      else this.patrolIdx = (this.patrolIdx + 1) % PATROL.length
    }

    const len = dist || 1
    r.vx = (dx / len) * ROBOT_SPEED
    r.vy = (dy / len) * ROBOT_SPEED
    const step = ROBOT_SPEED * dt
    r.x += r.vx * dt
    r.y += r.vy * dt
    r.heading = lerpAngle(r.heading, Math.atan2(r.vy, r.vx), 1 - Math.exp(-dt * 2.2))
    r.odom += step
    r.battery = Math.max(0, r.battery - dt * 0.006)

    if (m && m.phase === 'drive_b') m.traveledB += step
    if (m && m.phase === 'drive_a') m.traveledA += step

    // шлейф
    if (!this.lastTrail) this.lastTrail = { x: r.x, y: r.y }
    else if (Math.hypot(r.x - this.lastTrail.x, r.y - this.lastTrail.y) > 4) {
      this.trail.push({ x: r.x, y: r.y })
      if (this.trail.length > 220) this.trail.shift()
      this.lastTrail = { x: r.x, y: r.y }
    }

    // скан лидара — 8 Гц
    this.scanAccum += dt
    if (this.scanAccum >= 0.125) {
      this.scanAccum = 0
      this.scanNow()
    }
  }

  private completeLeg(m: Mission | null): void {
    if (m) {
      switch (m.phase) {
        case 'drive_b':
          m.phase = 'open'
          m.phaseT = 0
          this.section = 'opening'
          this.pushEvent(`Робот на точке ${pointById(m.to).name} — открытие отсека`, 'info')
          break
        case 'drive_a':
          m.phase = 'idle'
          m.phaseT = 0
          this.pushEvent(
            `Робот ${ROBOT_NAME} на точке ${pointById(m.from).name} — ожидание задания`,
            'ok',
          )
          break
        default:
          break
      }
    } else {
      this.patrolIdx = (this.patrolIdx + 1) % PATROL.length
    }
  }

  /** 360° скан из носовой точки лидара. */
  scanNow(): void {
    const { x: ox, y: oy } = this.lidarPos()
    const pts: ScanPoint[] = []
    const rays = 180
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      const t = castRay(ox, oy, dx, dy, 150)
      const n = 1 + (Math.random() - 0.5) * 0.02
      pts.push({ x: ox + dx * t * n, y: oy + dy * t * n })
    }
    this.scan = pts
  }
}
