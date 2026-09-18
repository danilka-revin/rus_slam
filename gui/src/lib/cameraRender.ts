// «Живой» вид с фронтальной камеры CAM-01: рейкастинг по территории
// (здания, препятствия, граница) из позиции/направления робота.
// Поверх — bounding box'ы детекций (demo YOLOv8) с подписями и conf.

import { castRay } from './territory'
import type { RobotState } from './simulator'
import type { Detection } from './detect'

export const CAM_FOV_DEG = 87

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
  robot: RobotState,
  dets: Detection[],
  opts: CameraDrawOptions,
): void {
  const horizon = h / 2
  const tanHalfFov = Math.tan((CAM_FOV_DEG * Math.PI) / 180 / 2)

  // потолок и пол
  const ceil = ctx.createLinearGradient(0, 0, 0, horizon)
  ceil.addColorStop(0, '#04070a')
  ceil.addColorStop(1, '#131d26')
  ctx.fillStyle = ceil
  ctx.fillRect(0, 0, w, horizon)

  const floor = ctx.createLinearGradient(0, horizon, 0, h)
  floor.addColorStop(0, '#101820')
  floor.addColorStop(1, '#2a3945')
  ctx.fillStyle = floor
  ctx.fillRect(0, horizon, w, h - horizon)

  // колонки рейкастинга
  const cols = Math.max(64, Math.round(w / 2))
  const cosA = Math.cos(robot.heading)
  const sinA = Math.sin(robot.heading)

  for (let i = 0; i < cols; i++) {
    const camX = (2 * (i / (cols - 1)) - 1) * tanHalfFov
    const dx = cosA - sinA * camX
    const dy = sinA + cosA * camX
    const t = castRay(robot.x, robot.y, dx, dy, 400)

    const rayLen = Math.hypot(dx, dy) || 1
    const perp = Math.max(0.05, t * ((dx * cosA + dy * sinA) / rayLen))
    if (perp > 250) continue

    const lineH = h / perp
    const top = horizon - lineH / 2
    const shade = Math.max(0, Math.min(1, 1.2 - perp / 60))
    const g = 24 + 120 * shade
    const br = ctx.createLinearGradient(0, top, 0, top + lineH)
    br.addColorStop(0, `rgb(${g * 0.5 | 0}, ${g * 0.62 | 0}, ${g * 0.72 | 0})`)
    br.addColorStop(0.5, `rgb(${g * 0.82 | 0}, ${g | 0}, ${g * 1.12 | 0})`)
    br.addColorStop(1, `rgb(${g * 0.34 | 0}, ${g * 0.44 | 0}, ${g * 0.52 | 0})`)
    ctx.fillStyle = br
    ctx.fillRect(i, top, w / cols + 1, lineH)
  }

  // виньетка
  const vg = ctx.createRadialGradient(w / 2, h / 2, h * 0.35, w / 2, h / 2, h * 0.95)
  vg.addColorStop(0, 'rgba(0,0,0,0)')
  vg.addColorStop(1, 'rgba(0,0,0,0.45)')
  ctx.fillStyle = vg
  ctx.fillRect(0, 0, w, h)

  // шум
  ctx.globalAlpha = 0.055
  ctx.fillStyle = '#fff'
  for (let i = 0; i < 220; i++) {
    ctx.fillRect(Math.random() * w, Math.random() * h, 1, 1)
  }
  ctx.globalAlpha = 1

  // развёртка
  const sy = (opts.t * 42) % (h + 30) - 15
  ctx.fillStyle = 'rgba(255,255,255,0.04)'
  ctx.fillRect(0, sy, w, 2)

  // сетка-сетка
  if (opts.grid) {
    ctx.strokeStyle = 'rgba(160,190,210,0.09)'
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

  // HUD-уголки
  if (opts.hud) {
    ctx.strokeStyle = opts.accent
    ctx.globalAlpha = 0.75
    ctx.lineWidth = 2
    const m = 12
    const L = 18
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
    ctx.beginPath()
    ctx.arc(w / 2, h / 2, 5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // детекции: box + подпись + conf
  ctx.font = '600 10px Inter, Arial, sans-serif'
  for (const d of dets) {
    const bx = d.box.x * w
    const by = d.box.y * h
    const bw = d.box.w * w
    const bh = d.box.h * h
    ctx.strokeStyle = d.color
    ctx.lineWidth = 1.4
    ctx.strokeRect(bx, by, bw, bh)
    // уголки
    const c = 6
    ctx.lineWidth = 2.4
    ctx.beginPath()
    ctx.moveTo(bx, by + c)
    ctx.lineTo(bx, by)
    ctx.lineTo(bx + c, by)
    ctx.moveTo(bx + bw - c, by)
    ctx.lineTo(bx + bw, by)
    ctx.lineTo(bx + bw, by + c)
    ctx.moveTo(bx + bw, by + bh - c)
    ctx.lineTo(bx + bw, by + bh)
    ctx.lineTo(bx + bw - c, by + bh)
    ctx.moveTo(bx + c, by + bh)
    ctx.lineTo(bx, by + bh)
    ctx.lineTo(bx, by + bh - c)
    ctx.stroke()
    // подпись
    const label = `${d.en}  ${d.conf.toFixed(2)}`
    const tw = ctx.measureText(label).width + 10
    const ly = by - 15 < 2 ? by + 4 : by - 15
    ctx.fillStyle = 'rgba(4,8,10,0.82)'
    ctx.fillRect(bx, ly, tw, 13)
    ctx.fillStyle = d.color
    ctx.textAlign = 'left'
    ctx.fillText(label, bx + 5, ly + 10)
  }
  ctx.textAlign = 'left'
}
