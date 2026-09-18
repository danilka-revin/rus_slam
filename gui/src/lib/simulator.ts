// Демо-симуляция робота: карта-манифолд, кинематика 4WIS (крабовый ход),
// скан лидара ЛДС-01 (установлен сверху спереди по центру корпуса).
// Позже этот модуль заменится мостом ROS 2 (tf + scan + odom → WebSocket),
// интерфейсы остаются теми же.

export const LIDAR_OFFSET_X = 0.32 // метры от центра корпуса к носу (совпадает с URDF)
export const BODY_L = 0.75
export const BODY_W = 0.6

export interface WorldMap {
  w: number // ширина, м
  h: number // высота, м
  cell: number // размер ячейки, м
  grid: Uint8Array // 0 — свободно, 1 — занято
}

export interface RobotState {
  x: number
  y: number
  heading: number // рад, 0 = +X
  vx: number // мировые скорость, м/с
  vy: number
  battery: number // %
  odom: number // м
  t: number // с
}

export interface ScanPoint { x: number; y: number }

function fillRect(grid: Uint8Array, cols: number, cell: number, x0: number, y0: number, x1: number, y1: number): void {
  const c0 = Math.max(0, Math.floor(x0 / cell))
  const c1 = Math.min(cols - 1, Math.ceil(x1 / cell))
  const r0 = Math.max(0, Math.floor(y0 / cell))
  const r1 = Math.min(grid.length / cols - 1, Math.ceil(y1 / cell))
  for (let r = r0; r <= r1; r++)
    for (let c = c0; c <= c1; c++) grid[r * cols + c] = 1
}

/** Демо-карта: 24×16 м, стены, Л-образный коридор и стеллаж. */
export function makeDemoMap(): WorldMap {
  const w = 24
  const h = 16
  const cell = 0.2
  const cols = Math.round(w / cell)
  const rows = Math.round(h / cell)
  const grid = new Uint8Array(cols * rows)

  fillRect(grid, cols, cell, 0, 0, w, 0.2) // юг
  fillRect(grid, cols, cell, 0, h - 0.2, w, h) // север
  fillRect(grid, cols, cell, 0, 0, 0.2, h) // запад
  fillRect(grid, cols, cell, w - 0.2, 0, w, h) // восток
  fillRect(grid, cols, cell, 7, 0.2, 7.4, 10) // стена A
  fillRect(grid, cols, cell, 7, 10, 17, 10.4) // стена B
  fillRect(grid, cols, cell, 17, 8.5, 17.4, 12) // стена C
  fillRect(grid, cols, cell, 10.5, 2, 13.5, 4.5) // стеллаж

  return { w, h, cell, grid }
}

const WAYPOINTS: [number, number][] = [
  [2, 2],
  [12, 1.2],
  [16, 1.2],
  [16, 7],
  [20.5, 7],
  [20.5, 13.5],
  [2.5, 13.5],
]

function lerpAngle(a: number, b: number, k: number): number {
  let d = b - a
  while (d > Math.PI) d -= 2 * Math.PI
  while (d < -Math.PI) d += 2 * Math.PI
  return a + d * k
}

export class Simulator {
  readonly map: WorldMap
  robot: RobotState
  trail: { x: number; y: number }[] = []
  scan: ScanPoint[] = []
  sweep = 0 // рад, угол «бегущего» луча лидара
  private wpIndex = 0
  private lastTrail: { x: number; y: number } | null = null
  private scanAccum = 0

  constructor() {
    this.map = makeDemoMap()
    this.robot = { x: 2, y: 2, heading: 0, vx: 0, vy: 0, battery: 96.4, odom: 0, t: 0 }
  }

  get nextWaypoint(): [number, number] {
    return WAYPOINTS[this.wpIndex]
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

    const [tx, ty] = this.nextWaypoint
    let dx = tx - r.x
    let dy = ty - r.y
    const dist = Math.hypot(dx, dy)
    if (dist < 0.18) {
      this.wpIndex = (this.wpIndex + 1) % WAYPOINTS.length
      dx = WAYPOINTS[this.wpIndex][0] - r.x
      dy = WAYPOINTS[this.wpIndex][1] - r.y
    }
    const len = Math.hypot(dx, dy) || 1
    const speed = 0.9
    r.vx = (dx / len) * speed
    r.vy = (dy / len) * speed
    r.x += r.vx * dt
    r.y += r.vy * dt

    // Крабовая кинематика: корпус поворачивается к направлению движения с запаздыванием
    r.heading = lerpAngle(r.heading, Math.atan2(r.vy, r.vx), 1 - Math.exp(-dt * 2.0))

    r.odom += speed * dt
    r.battery = Math.max(0, r.battery - dt * 0.004)
    this.sweep = (r.t * Math.PI * 1.2) % (2 * Math.PI)

    if (!this.lastTrail) this.lastTrail = { x: r.x, y: r.y }
    else if (Math.hypot(r.x - this.lastTrail.x, r.y - this.lastTrail.y) > 0.25) {
      this.trail.push({ x: r.x, y: r.y })
      if (this.trail.length > 500) this.trail.shift()
      this.lastTrail = { x: r.x, y: r.y }
    }

    // Скан лидара — 8 Гц
    this.scanAccum += dt
    if (this.scanAccum >= 0.125) {
      this.scanAccum = 0
      this.scanNow()
    }
  }

  /** 360° скан: DDA-лучи из точки лидара (носовая, по центру). */
  scanNow(): void {
    const { x: ox, y: oy } = this.lidarPos()
    const pts: ScanPoint[] = []
    const rays = 180
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      const t = this.cast(ox, oy, dx, dy, 14)
      const n = 1 + (Math.random() - 0.5) * 0.03
      pts.push({ x: ox + dx * t * n, y: oy + dy * t * n })
    }
    this.scan = pts
  }

  private cast(ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
    const cell = this.map.cell
    const cols = Math.round(this.map.w / cell)
    const rows = Math.round(this.map.h / cell)
    const grid = this.map.grid

    let mapX = Math.floor(ox / cell)
    let mapY = Math.floor(oy / cell)
    const stepX = dx > 0 ? 1 : -1
    const stepY = dy > 0 ? 1 : -1
    const tDeltaX = dx !== 0 ? cell / Math.abs(dx) : Infinity
    const tDeltaY = dy !== 0 ? cell / Math.abs(dy) : Infinity
    let tMaxX =
      dx > 0 ? ((mapX + 1) * cell - ox) / dx : dx < 0 ? (mapX * cell - ox) / dx : Infinity
    let tMaxY =
      dy > 0 ? ((mapY + 1) * cell - oy) / dy : dy < 0 ? (mapY * cell - oy) / dy : Infinity

    for (let i = 0; i < 400; i++) {
      if (tMaxX < tMaxY) {
        mapX += stepX
        if (mapX < 0 || mapX >= cols) return Math.min(tMaxX, maxDist)
        const t = tMaxX
        tMaxX += tDeltaX
        if (grid[mapY * cols + mapX]) return Math.min(t, maxDist)
      } else {
        mapY += stepY
        if (mapY < 0 || mapY >= rows) return Math.min(tMaxY, maxDist)
        const t = tMaxY
        tMaxY += tDeltaY
        if (grid[mapY * cols + mapX]) return Math.min(t, maxDist)
      }
      if (Math.min(tMaxX, tMaxY) > maxDist) return maxDist
    }
    return maxDist
  }
}
