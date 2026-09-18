// Рендер карты SLAM на canvas: панорамирование, зум, робот с лидаром
// в носовой точке (сверху спереди по центру), вращающийся луч, шлейф, скан.

import { LIDAR_OFFSET_X, BODY_L, BODY_W, type Simulator, type WorldMap } from './simulator'
import { hexToRgb, type MapStyle } from './settings'

export interface MapCamera {
  cx: number // мировая точка в центре экрана, м
  cy: number
  ppm: number // пикселей на метр
}

export interface Palette {
  free: string
  walls: string
  border: string
  gridMinor: string
  gridMajor: string
  trail: string
  scan: string
  robotBody: string
  robotLine: string
  wheels: string
  lidar: string
  lidarCore: string
  goal: string
  text: string
}

export function mapPalette(style: MapStyle, accent: string): Palette {
  if (style === 'dark') {
    return {
      free: '#0f1713',
      walls: '#46584d',
      border: 'rgba(255,255,255,0.14)',
      gridMinor: 'rgba(255,255,255,0.05)',
      gridMajor: 'rgba(255,255,255,0.11)',
      trail: accent,
      scan: accent,
      robotBody: '#1d2b24',
      robotLine: 'rgba(233,240,236,0.85)',
      wheels: '#0a100d',
      lidar: accent,
      lidarCore: '#17251f',
      goal: accent,
      text: 'rgba(233,240,236,0.65)',
    }
  }
  return {
    free: '#f4f7f5',
    walls: '#47544c',
    border: 'rgba(23,33,29,0.25)',
    gridMinor: 'rgba(23,33,29,0.06)',
    gridMajor: 'rgba(23,33,29,0.13)',
    trail: '#4a7c2e',
    scan: `rgba(${hexToRgb(accent).join(',')},0.55)`,
    robotBody: '#17251f',
    robotLine: '#fff',
    wheels: '#0a100d',
    lidar: '#5e9668',
    lidarCore: '#fff',
    goal: '#c18722',
    text: 'rgba(23,33,29,0.55)',
  }
}

export function fitCamera(map: WorldMap, w: number, h: number): MapCamera {
  const pad = 40
  const ppm = Math.min((w - pad * 2) / map.w, (h - pad * 2) / map.h)
  return { cx: map.w / 2, cy: map.h / 2, ppm }
}

function toScreen(x: number, y: number, cam: MapCamera, w: number, h: number): [number, number] {
  return [w / 2 + (x - cam.cx) * cam.ppm, h / 2 - (y - cam.cy) * cam.ppm]
}

function toWorld(px: number, py: number, cam: MapCamera, w: number, h: number): [number, number] {
  return [cam.cx + (px - w / 2) / cam.ppm, cam.cy - (py - h / 2) / cam.ppm]
}

export interface MapDrawOptions {
  showGrid: boolean
  showTrail: boolean
  showScan: boolean
  markerScale: number
}

export function drawMap(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  sim: Simulator,
  cam: MapCamera,
  pal: Palette,
  opts: MapDrawOptions,
): void {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = pal.free
  ctx.fillRect(0, 0, w, h)

  const map = sim.map
  const [mx0, my0] = toScreen(0, map.h, cam, w, h) // левый-нижний угол карты
  const [mx1, my1] = toScreen(map.w, 0, cam, w, h) // правый-верхний

  // --- сетка (каждый 1 м / 5 м) ---
  if (opts.showGrid) {
    const xStart = Math.max(0, toWorld(0, 0, cam, w, h)[0])
    const xEnd = Math.min(map.w, toWorld(w, 0, cam, w, h)[0])
    const yStart = Math.max(0, toWorld(0, h, cam, w, h)[1])
    const yEnd = Math.min(map.h, toWorld(0, 0, cam, w, h)[1])
    ctx.lineWidth = 1
    for (let gx = Math.ceil(xStart); gx <= Math.floor(xEnd); gx++) {
      const [sx] = toScreen(gx, 0, cam, w, h)
      ctx.strokeStyle = gx % 5 === 0 ? pal.gridMajor : pal.gridMinor
      ctx.beginPath()
      ctx.moveTo(sx, my1)
      ctx.lineTo(sx, my0)
      ctx.stroke()
    }
    for (let gy = Math.ceil(yStart); gy <= Math.floor(yEnd); gy++) {
      const [, sy] = toScreen(0, gy, cam, w, h)
      ctx.strokeStyle = gy % 5 === 0 ? pal.gridMajor : pal.gridMinor
      ctx.beginPath()
      ctx.moveTo(mx0, sy)
      ctx.lineTo(mx1, sy)
      ctx.stroke()
    }
  }

  // --- стены (занятые ячейки) ---
  const cellPx = map.cell * cam.ppm
  if (cellPx > 0.8) {
    ctx.fillStyle = pal.walls
    const cols = Math.round(map.w / map.cell)
    for (let ry = 0; ry < Math.round(map.h / map.cell); ry++) {
      for (let cx2 = 0; cx2 < cols; cx2++) {
        if (!map.grid[ry * cols + cx2]) continue
        const [sx, sy] = toScreen(cx2 * map.cell, (ry + 1) * map.cell, cam, w, h)
        ctx.fillRect(sx, sy, cellPx + 0.5, cellPx + 0.5)
      }
    }
  }

  // рамка карты
  ctx.strokeStyle = pal.border
  ctx.lineWidth = 1.5
  ctx.strokeRect(mx0, my1, mx1 - mx0, my0 - my1)

  // --- шлейф ---
  if (opts.showTrail && sim.trail.length > 1) {
    ctx.strokeStyle = pal.trail
    ctx.globalAlpha = 0.65
    ctx.lineWidth = 2
    ctx.lineJoin = 'round'
    ctx.beginPath()
    const [sx, sy] = toScreen(sim.trail[0].x, sim.trail[0].y, cam, w, h)
    ctx.moveTo(sx, sy)
    for (const p of sim.trail) {
      const [px, py] = toScreen(p.x, p.y, cam, w, h)
      ctx.lineTo(px, py)
    }
    ctx.stroke()
    ctx.globalAlpha = 1
  }

  // --- точки скана лидара ---
  if (opts.showScan) {
    ctx.fillStyle = pal.scan
    for (const p of sim.scan) {
      const [px, py] = toScreen(p.x, p.y, cam, w, h)
      ctx.fillRect(px - 1, py - 1, 2, 2)
    }
  }

  // --- следующая цель ---
  {
    const [gx, gy] = sim.nextWaypoint
    const [px, py] = toScreen(gx, gy, cam, w, h)
    const s = (5 + Math.sin(sim.robot.t * 4) * 1.5) * opts.markerScale
    ctx.save()
    ctx.translate(px, py)
    ctx.rotate(Math.PI / 4)
    ctx.strokeStyle = pal.goal
    ctx.lineWidth = 2
    ctx.strokeRect(-s / 2, -s / 2, s, s)
    ctx.restore()
  }

  // --- робот ---
  drawRobot(ctx, sim, cam, w, h, pal, opts.markerScale)

  // --- масштаб ---
  drawScaleBar(ctx, cam, pal, h)

  // --- компас ---
  drawCompass(ctx, pal, w)
}

function drawRobot(
  ctx: CanvasRenderingContext2D,
  sim: Simulator,
  cam: MapCamera,
  w: number,
  h: number,
  pal: Palette,
  scale: number,
): void {
  const r = sim.robot
  const [px, py] = toScreen(r.x, r.y, cam, w, h)
  const k = cam.ppm * scale

  ctx.save()
  ctx.translate(px, py)
  ctx.rotate(-r.heading) // на экране Y вниз

  // область покрытия лидара
  ctx.strokeStyle = pal.lidar
  ctx.globalAlpha = 0.18
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(LIDAR_OFFSET_X * k, 0, 2.5 * k, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 1

  // вращающийся луч лидара
  ctx.save()
  ctx.translate(LIDAR_OFFSET_X * k, 0)
  ctx.rotate(-sim.sweep)
  const sweepLen = 1.6 * k
  const grad = ctx.createLinearGradient(0, 0, sweepLen, 0)
  grad.addColorStop(0, pal.lidar)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.strokeStyle = grad
  ctx.globalAlpha = 0.55
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(sweepLen, 0)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.restore()

  // колёса (4 независимых модуля)
  ctx.fillStyle = pal.wheels
  const wx = (BODY_L / 2 - 0.075) * k
  const wy = (BODY_W / 2 - 0.05) * k
  for (const [sx2, sy2] of [
    [wx, wy],
    [wx, -wy],
    [-wx, wy],
    [-wx, -wy],
  ]) {
    ctx.beginPath()
    ctx.arc(sx2, sy2, 0.06 * k, 0, Math.PI * 2)
    ctx.fill()
  }

  // корпус
  const bw = BODY_L * k
  const bh = BODY_W * k
  ctx.fillStyle = pal.robotBody
  ctx.strokeStyle = pal.robotLine
  ctx.lineWidth = 1.5
  roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 0.08 * k)
  ctx.fill()
  ctx.stroke()

  // стрелка носа
  ctx.fillStyle = pal.robotLine
  ctx.beginPath()
  ctx.moveTo(bw / 2 - 0.02 * k, 0)
  ctx.lineTo(bw / 2 - 0.14 * k, -0.09 * k)
  ctx.lineTo(bw / 2 - 0.14 * k, 0.09 * k)
  ctx.closePath()
  ctx.fill()

  // лидар — сверху спереди по центру
  ctx.fillStyle = pal.lidar
  ctx.beginPath()
  ctx.arc(LIDAR_OFFSET_X * k, 0, 0.075 * k, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = pal.lidarCore
  ctx.beginPath()
  ctx.arc(LIDAR_OFFSET_X * k, 0, 0.03 * k, 0, Math.PI * 2)
  ctx.fill()

  ctx.restore()
}

function drawScaleBar(ctx: CanvasRenderingContext2D, cam: MapCamera, pal: Palette, h: number): void {
  const candidates = [0.5, 1, 2, 5, 10]
  let len = 1
  for (const c of candidates) if (c * cam.ppm <= 150) len = c
  const px = len * cam.ppm
  const x0 = 16
  const y0 = h - 20
  ctx.strokeStyle = pal.text
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x0 + px, y0)
  ctx.moveTo(x0, y0 - 4)
  ctx.lineTo(x0, y0 + 4)
  ctx.moveTo(x0 + px, y0 - 4)
  ctx.lineTo(x0 + px, y0 + 4)
  ctx.stroke()
  ctx.fillStyle = pal.text
  ctx.font = '10px Inter, Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(`${len} м`, x0 + px / 2, y0 - 7)
  ctx.textAlign = 'left'
}

function drawCompass(ctx: CanvasRenderingContext2D, pal: Palette, w: number): void {
  const x = w - 26
  const y = 64
  ctx.save()
  ctx.translate(x, y)
  ctx.strokeStyle = pal.text
  ctx.fillStyle = pal.text
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.arc(0, 0, 12, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.moveTo(0, -8)
  ctx.lineTo(4, 4)
  ctx.lineTo(0, 1)
  ctx.lineTo(-4, 4)
  ctx.closePath()
  ctx.fill()
  ctx.font = '8px Inter, Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('N', 0, -14)
  ctx.restore()
  ctx.textAlign = 'left'
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}
