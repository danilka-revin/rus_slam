// «Живой» вид с фронтальной камеры: рейкастинг по той же сетке карты,
// откуда берёт данные SLAM. Выглядит как реальный поток и реагирует
// на движение робота. При наличии cameraUrl компонент показывает <video>.

import { type RobotState, type WorldMap } from './simulator'

export interface CameraDrawOptions {
  grid: boolean
  hud: boolean
  accent: string
  t: number
}

export function drawCamera(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  map: WorldMap,
  robot: RobotState,
  cols: number,
  opts: CameraDrawOptions,
): void {
  const horizon = h / 2
  const tanHalfFov = Math.tan((65 * Math.PI) / 180 / 2)

  // Небо/потолок и пол — вертикальные градиенты
  const ceil = ctx.createLinearGradient(0, 0, 0, horizon)
  ceil.addColorStop(0, '#05080a')
  ceil.addColorStop(1, '#141d18')
  ctx.fillStyle = ceil
  ctx.fillRect(0, 0, w, horizon)

  const floor = ctx.createLinearGradient(0, horizon, 0, h)
  floor.addColorStop(0, '#131b16')
  floor.addColorStop(1, '#2a3630')
  ctx.fillStyle = floor
  ctx.fillRect(0, horizon, w, h - horizon)

  // Колонки рейкастинга
  const cosA = Math.cos(robot.heading)
  const sinA = Math.sin(robot.heading)
  const cell = map.cell
  const colsMap = Math.round(map.w / cell)
  const rowsMap = Math.round(map.h / cell)
  const grid = map.grid

  for (let i = 0; i < cols; i++) {
    const camX = (2 * (i / (cols - 1)) - 1) * tanHalfFov
    // направление луча в мировых координатах
    const dx = cosA - sinA * camX
    const dy = sinA + cosA * camX

    // DDA
    let mapX = Math.floor(robot.x / cell)
    let mapY = Math.floor(robot.y / cell)
    const stepX = dx > 0 ? 1 : -1
    const stepY = dy > 0 ? 1 : -1
    const tDeltaX = dx !== 0 ? cell / Math.abs(dx) : 1e30
    const tDeltaY = dy !== 0 ? cell / Math.abs(dy) : 1e30
    let tMaxX = dx > 0 ? ((mapX + 1) * cell - robot.x) / dx : dx < 0 ? (mapX * cell - robot.x) / -dx : 1e30
    let tMaxY = dy > 0 ? ((mapY + 1) * cell - robot.y) / dy : dy < 0 ? (mapY * cell - robot.y) / -dy : 1e30
    let side = 0
    let hit = false
    for (let it = 0; it < 500; it++) {
      if (tMaxX < tMaxY) {
        mapX += stepX
        if (mapX < 0 || mapX >= colsMap) break
        tMaxX += tDeltaX
        side = 0
      } else {
        mapY += stepY
        if (mapY < 0 || mapY >= rowsMap) break
        tMaxY += tDeltaY
        side = 1
      }
      if (grid[mapY * colsMap + mapX]) {
        hit = true
        break
      }
    }

    if (!hit) continue
    const rawT = hit && side === 0 ? tMaxX - tDeltaX : tMaxY - tDeltaY
    // перпендикулярная дистанция — без перспективного сжатия по углам
    const rayLen = Math.hypot(dx, dy) || 1
    const perp = Math.max(0.05, rawT * ((dx * cosA + dy * sinA) / rayLen))
    if (perp > 20) continue

    const lineH = h / perp
    const top = horizon - lineH / 2
    const shade = Math.max(0, Math.min(1, 1.15 - perp / 14))
    const base = 30 + 95 * shade
    const g = base * (side === 0 ? 1 : 0.82)
    const br = ctx.createLinearGradient(0, top, 0, top + lineH)
    br.addColorStop(0, `rgb(${g * 0.55 | 0}, ${g * 0.72 | 0}, ${g * 0.6 | 0})`)
    br.addColorStop(0.5, `rgb(${g * 0.8 | 0}, ${g * 1.0 | 0}, ${g * 0.82 | 0})`)
    br.addColorStop(1, `rgb(${g * 0.35 | 0}, ${g * 0.48 | 0}, ${g * 0.38 | 0})`)
    ctx.fillStyle = br
    ctx.fillRect(i, top, w / cols + 1, lineH)
  }

  // Виньетка
  const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.95)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.42)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, w, h)

  // Шум видеопотока
  ctx.globalAlpha = 0.06
  ctx.fillStyle = '#fff'
  for (let i = 0; i < 240; i++) {
    ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1)
  }
  ctx.globalAlpha = 1

  // Бегущая строка развёртки
  const sy = (opts.t * 46) % (h + 30) - 15
  ctx.fillStyle = 'rgba(255,255,255,0.035)'
  ctx.fillRect(0, sy, w, 2)

  // HUD
  if (opts.grid) {
    ctx.strokeStyle = 'rgba(213,255,69,0.10)'
    ctx.lineWidth = 1
    for (let i = 1; i < 3; i++) {
      const gx = (w / 3) * i
      const gy = (h / 3) * i
      ctx.beginPath()
      ctx.moveTo(gx, 0)
      ctx.lineTo(gx, h)
      ctx.moveTo(0, gy)
      ctx.lineTo(w, gy)
      ctx.stroke()
    }
  }
  if (opts.hud) {
    ctx.strokeStyle = opts.accent
    ctx.globalAlpha = 0.8
    ctx.lineWidth = 2
    const m = 14
    const L = 20
    // угловые скобки
    ctx.beginPath()
    ctx.moveTo(m, m + L)
    ctx.lineTo(m, m)
    ctx.lineTo(m + L, m)
    ctx.moveTo(w - m - L, m)
    ctx.lineTo(w - m, m)
    ctx.lineTo(w - m, m + L)
    ctx.moveTo(w - m, h - m - L)
    ctx.lineTo(w - m, h - m)
    ctx.lineTo(w - m - L, h - m)
    ctx.moveTo(m + L, h - m)
    ctx.lineTo(m, h - m)
    ctx.lineTo(m, h - m - L)
    ctx.stroke()
    // центр
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }
}
