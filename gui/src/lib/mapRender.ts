// Рендер карты территории (canvas, без зависимостей):
// фон/сетка, дорожная сеть с осевыми, здания, штрихованная зона,
// маршрут миссии, точки A/B, робот RB-01 с лидаром в носовой точке,
// шлейф, облако точек скана, масштабная линейка.

import {
  BUILDINGS,
  OBSTACLES,
  POINTS,
  ROADS,
  pointById,
  WORLD,
  ZONE,
} from './territory'
import type { Simulator } from './simulator'
import { hexToRgb, type MapStyle } from './settings'

export interface MapCamera {
  cx: number // мировая точка в центре экрана, м
  cy: number
  ppm: number // пикселей на метр
}

export interface Palette {
  outer: string
  bg: string
  gridMinor: string
  gridMajor: string
  road: string
  roadLine: string
  building: string
  buildingLine: string
  buildingText: string
  zone: string
  zoneLine: string
  zoneHatch: string
  node: string
  nodeText: string
  border: string
  accent: string
  accentSoft: string
  scan: string
  trail: string
  danger: string
}

function shade(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex)
  return `rgb(${r * f | 0}, ${g * f | 0}, ${b * f | 0})`
}

export function mapPalette(style: MapStyle, accent: string): Palette {
  if (style === 'dark') {
    return {
      outer: '#0a0f15',
      bg: '#0d141c',
      gridMinor: 'rgba(148,180,205,0.05)',
      gridMajor: 'rgba(148,180,205,0.1)',
      road: '#1a2632',
      roadLine: 'rgba(150,178,204,0.42)',
      building: '#121c26',
      buildingLine: '#2a3a48',
      buildingText: 'rgba(152,174,196,0.8)',
      zone: 'rgba(56,224,224,0.04)',
      zoneLine: 'rgba(56,224,224,0.4)',
      zoneHatch: 'rgba(56,224,224,0.16)',
      node: 'rgba(150,178,204,0.85)',
      nodeText: 'rgba(172,192,210,0.85)',
      border: 'rgba(148,180,205,0.22)',
      accent,
      accentSoft: `rgba(${hexToRgb(accent).join(',')},0.14)`,
      scan: `rgba(${hexToRgb(accent).join(',')},0.5)`,
      trail: `rgba(${hexToRgb(accent).join(',')},0.4)`,
      danger: '#ff5d55',
    }
  }
  const a = shade(accent, 0.55)
  return {
    outer: '#e9eded',
    bg: '#f5f8f7',
    gridMinor: 'rgba(23,33,29,0.05)',
    gridMajor: 'rgba(23,33,29,0.11)',
    road: '#dbe3df',
    roadLine: 'rgba(23,33,29,0.42)',
    building: '#e6ebe8',
    buildingLine: '#b6c2bc',
    buildingText: 'rgba(23,33,29,0.62)',
    zone: 'rgba(41,120,120,0.05)',
    zoneLine: 'rgba(41,120,120,0.55)',
    zoneHatch: 'rgba(41,120,120,0.25)',
    node: 'rgba(23,33,29,0.6)',
    nodeText: 'rgba(23,33,29,0.68)',
    border: 'rgba(23,33,29,0.3)',
    accent: a,
    accentSoft: `rgba(${hexToRgb(accent).join(',')},0.18)`,
    scan: `rgba(${hexToRgb(a).join(',')},0.55)`,
    trail: `rgba(${hexToRgb(a).join(',')},0.45)`,
    danger: '#d8443c',
  }
}

export function fitCamera(w: number, h: number): MapCamera {
  const pad = 50
  const ppm = Math.min((w - pad * 2) / WORLD.w, (h - pad * 2) / WORLD.h)
  return { cx: WORLD.w / 2, cy: WORLD.h / 2, ppm }
}

function toScreen(x: number, y: number, cam: MapCamera, w: number, h: number): [number, number] {
  return [w / 2 + (x - cam.cx) * cam.ppm, h / 2 - (y - cam.cy) * cam.ppm]
}

export interface MapDrawOptions {
  showGrid: boolean
  showTrail: boolean
  showScan: boolean
  markerScale: number
  pointA: string
  pointB: string
}

export function drawTerritory(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  sim: Simulator,
  cam: MapCamera,
  pal: Palette,
  opts: MapDrawOptions,
): void {
  ctx.clearRect(0, 0, w, h)
  ctx.fillStyle = pal.outer
  ctx.fillRect(0, 0, w, h)

  const [wx0, wy0] = toScreen(0, WORLD.h, cam, w, h)
  const [wx1, wy1] = toScreen(WORLD.w, 0, cam, w, h)

  // подложка территории
  ctx.fillStyle = pal.bg
  ctx.fillRect(wx0, wy1, wx1 - wx0, wy0 - wy1)

  // сетка 10 м / 50 м
  if (opts.showGrid) {
    ctx.lineWidth = 1
    for (let gx = 0; gx <= WORLD.w; gx += 10) {
      const [sx] = toScreen(gx, 0, cam, w, h)
      ctx.strokeStyle = gx % 50 === 0 ? pal.gridMajor : pal.gridMinor
      ctx.beginPath()
      ctx.moveTo(sx, wy1)
      ctx.lineTo(sx, wy0)
      ctx.stroke()
    }
    for (let gy = 0; gy <= WORLD.h; gy += 10) {
      const [, sy] = toScreen(0, gy, cam, w, h)
      ctx.strokeStyle = gy % 50 === 0 ? pal.gridMajor : pal.gridMinor
      ctx.beginPath()
      ctx.moveTo(wx0, sy)
      ctx.lineTo(wx1, sy)
      ctx.stroke()
    }
  }

  // зона тестирования (штриховка)
  {
    const [zx0, zy0] = toScreen(ZONE.x, ZONE.y + ZONE.h, cam, w, h)
    const zw = ZONE.w * cam.ppm
    const zh = ZONE.h * cam.ppm
    ctx.save()
    ctx.beginPath()
    ctx.rect(zx0, zy0 - zh, zw, zh)
    ctx.clip()
    ctx.fillStyle = pal.zone
    ctx.fillRect(zx0, zy0 - zh, zw, zh)
    ctx.strokeStyle = pal.zoneHatch
    ctx.lineWidth = 1
    for (let i = -zh; i < zw; i += 9) {
      ctx.beginPath()
      ctx.moveTo(zx0 + i, zy0)
      ctx.lineTo(zx0 + i + zh, zy0 - zh)
      ctx.stroke()
    }
    ctx.restore()
    ctx.setLineDash([5, 4])
    ctx.strokeStyle = pal.zoneLine
    ctx.strokeRect(zx0, zy0 - zh, zw, zh)
    ctx.setLineDash([])
    ctx.fillStyle = pal.zoneLine
    ctx.font = '600 10px Inter, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(ZONE.name, zx0 + zw / 2, zy0 - zh / 2 + 3)
  }

  // дороги + осевые
  ctx.lineCap = 'round'
  for (const [ua, vb] of ROADS) {
    const pa = pointById(ua)
    const pb = pointById(vb)
    const [ax, ay] = toScreen(pa.x, pa.y, cam, w, h)
    const [bx, by] = toScreen(pb.x, pb.y, cam, w, h)
    ctx.strokeStyle = pal.road
    ctx.lineWidth = Math.max(2.5, 9 * cam.ppm)
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
  }
  ctx.setLineDash([6, 9])
  ctx.lineWidth = 1.2
  ctx.strokeStyle = pal.roadLine
  for (const [ua, vb] of ROADS) {
    const pa = pointById(ua)
    const pb = pointById(vb)
    const [ax, ay] = toScreen(pa.x, pa.y, cam, w, h)
    const [bx, by] = toScreen(pb.x, pb.y, cam, w, h)
    ctx.beginPath()
    ctx.moveTo(ax, ay)
    ctx.lineTo(bx, by)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // здания
  for (const b of BUILDINGS) {
    const [bx, by] = toScreen(b.x, b.y + b.h, cam, w, h)
    const bw = b.w * cam.ppm
    const bh = b.h * cam.ppm
    ctx.fillStyle = pal.building
    ctx.fillRect(bx, by - bh, bw, bh)
    ctx.strokeStyle = pal.buildingLine
    ctx.lineWidth = 1
    ctx.strokeRect(bx, by - bh, bw, bh)
    if (bw > 70) {
      ctx.fillStyle = pal.buildingText
      ctx.font = '600 10px Inter, Arial, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(b.name, bx + bw / 2, by - bh / 2 + 3)
    }
  }

  // малые препятствия
  ctx.fillStyle = pal.buildingLine
  for (const o of OBSTACLES) {
    const [ox, oy] = toScreen(o.x, o.y, cam, w, h)
    const s = Math.max(2, o.s * cam.ppm)
    ctx.fillRect(ox - s / 2, oy - s / 2, s, s)
  }

  // точки скана лидара
  if (opts.showScan) {
    ctx.fillStyle = pal.scan
    for (const p of sim.scan) {
      const [px, py] = toScreen(p.x, p.y, cam, w, h)
      ctx.fillRect(px - 1, py - 1, 2, 2)
    }
  }

  // шлейф
  if (opts.showTrail && sim.trail.length > 1) {
    ctx.strokeStyle = pal.trail
    ctx.lineWidth = 1.5
    ctx.beginPath()
    const [sx, sy] = toScreen(sim.trail[0].x, sim.trail[0].y, cam, w, h)
    ctx.moveTo(sx, sy)
    for (const p of sim.trail) {
      const [px, py] = toScreen(p.x, p.y, cam, w, h)
      ctx.lineTo(px, py)
    }
    ctx.stroke()
  }

  // маршрут миссии: активное плечо ярче, второе — приглушённо
  const m = sim.mission
  if (m) {
    const dwell = m.phase !== 'drive_b' && m.phase !== 'drive_a'
    const bright = m.phase === 'drive_a' ? m.routeA : m.routeB
    const dim = m.phase === 'drive_a' ? m.routeB : m.routeA
    drawRoute(ctx, dim, cam, w, h, pal, dwell ? 0.18 : 0.3, false)
    drawRoute(ctx, bright, cam, w, h, pal, dwell ? 0.4 : 1, true)
  }

  // именованные точки
  ctx.textAlign = 'center'
  for (const p of POINTS) {
    const [px, py] = toScreen(p.x, p.y, cam, w, h)
    ctx.beginPath()
    ctx.arc(px, py, p.selectable ? 4.5 : 3, 0, Math.PI * 2)
    ctx.fillStyle = pal.bg
    ctx.fill()
    ctx.strokeStyle = pal.node
    ctx.lineWidth = 1.4
    ctx.stroke()
    if (!p.selectable) continue
    ctx.fillStyle = pal.nodeText
    ctx.font = '600 10px Inter, Arial, sans-serif'
    const above = p.id === 'adm' || p.id === 'zone'
    ctx.fillText(p.name.toUpperCase(), px, above ? py - 12 : py + 18)
  }

  // метки A / B
  {
    const pa = pointById(opts.pointA)
    const pb = pointById(opts.pointB)
    const [ax, ay] = toScreen(pa.x, pa.y, cam, w, h)
    ctx.strokeStyle = pal.accent
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.arc(ax, ay, 8, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = pal.accent
    ctx.font = '800 10px Inter, Arial, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('A', ax, ay + 3.5)

    const [bx, by] = toScreen(pb.x, pb.y, cam, w, h)
    const s = 7 + Math.sin(sim.robot.t * 4) * 1.8
    ctx.save()
    ctx.translate(bx, by)
    ctx.rotate(Math.PI / 4)
    ctx.strokeStyle = pal.accent
    ctx.lineWidth = 2
    ctx.strokeRect(-s / 2, -s / 2, s, s)
    ctx.restore()
    ctx.fillStyle = pal.accent
    ctx.fillText('B', bx + 15, by + 3.5)
  }

  // робот
  drawRobot(ctx, sim, cam, w, h, pal, opts.markerScale)

  // рамка территории
  ctx.strokeStyle = pal.border
  ctx.lineWidth = 1
  ctx.strokeRect(wx0, wy1, wx1 - wx0, wy0 - wy1)

  drawScaleBar(ctx, cam, pal, h)
}

function drawRoute(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  cam: MapCamera,
  w: number,
  h: number,
  pal: Palette,
  alpha: number,
  nodes: boolean,
): void {
  if (pts.length < 2) return
  ctx.save()
  ctx.globalAlpha = alpha
  ctx.strokeStyle = pal.accent
  ctx.lineWidth = 2
  ctx.setLineDash([10, 7])
  ctx.beginPath()
  const [sx, sy] = toScreen(pts[0].x, pts[0].y, cam, w, h)
  ctx.moveTo(sx, sy)
  for (let i = 1; i < pts.length; i++) {
    const [px, py] = toScreen(pts[i].x, pts[i].y, cam, w, h)
    ctx.lineTo(px, py)
  }
  ctx.stroke()
  ctx.setLineDash([])
  if (nodes) {
    for (let i = 1; i < pts.length - 1; i++) {
      const [px, py] = toScreen(pts[i].x, pts[i].y, cam, w, h)
      ctx.beginPath()
      ctx.arc(px, py, 3.5, 0, Math.PI * 2)
      ctx.fillStyle = pal.bg
      ctx.fill()
      ctx.stroke()
    }
  }
  ctx.restore()
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
  const R = 11 * scale
  const color = sim.estop ? pal.danger : pal.accent

  // область покрытия лидара + вращающийся луч
  ctx.save()
  ctx.translate(px, py)
  ctx.globalAlpha = 0.1
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.arc(0, 0, 34 * scale, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 0.6
  ctx.rotate(-sim.sweep)
  const g = ctx.createLinearGradient(0, 0, 34 * scale, 0)
  g.addColorStop(0, color)
  g.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.strokeStyle = g
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(0, 0)
  ctx.lineTo(34 * scale, 0)
  ctx.stroke()
  ctx.restore()

  // кольцо маркера
  ctx.beginPath()
  ctx.arc(px, py, R, 0, Math.PI * 2)
  ctx.fillStyle = pal.accentSoft
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.stroke()

  // корпус (направление = heading)
  ctx.save()
  ctx.translate(px, py)
  ctx.rotate(-r.heading)
  ctx.fillStyle = color
  roundRect(ctx, -5.5 * scale, -4 * scale, 11 * scale, 8 * scale, 2)
  ctx.fill()
  // стрелка носа
  ctx.beginPath()
  ctx.moveTo(8 * scale, 0)
  ctx.lineTo(4.5 * scale, -2.6 * scale)
  ctx.lineTo(4.5 * scale, 2.6 * scale)
  ctx.closePath()
  ctx.fill()
  // лидар в носовой точке (сверху спереди по центру)
  ctx.fillStyle = pal.bg
  ctx.beginPath()
  ctx.arc(2.6 * scale, 0, 1.6 * scale, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()

  // название робота
  ctx.fillStyle = color
  ctx.font = '700 10px Inter, Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('RB-01', px, py - R - 6)

  // индикатор отсека: закрыт — контур, открыт — заполнение с «крышками»
  const sy = py + R + 7
  ctx.strokeStyle = color
  ctx.fillStyle = sim.section === 'open' || sim.section === 'opening' ? color : 'transparent'
  ctx.lineWidth = 1.4
  if (sim.section === 'open' || sim.section === 'opening') {
    ctx.fillRect(px - 5, sy - 4, 4, 8)
    ctx.fillRect(px + 1, sy - 4, 4, 8)
    ctx.fillStyle = pal.bg
    ctx.fillRect(px - 1, sy - 4, 2, 8)
  } else {
    roundRect(ctx, px - 5, sy - 4, 10, 8, 1.5)
    ctx.stroke()
  }
}

function drawScaleBar(ctx: CanvasRenderingContext2D, cam: MapCamera, pal: Palette, h: number): void {
  const candidates = [10, 25, 50, 100, 200]
  let len = 10
  for (const c of candidates) if (c * cam.ppm <= 150) len = c
  const px = len * cam.ppm
  const x0 = 16
  const y0 = h - 18
  ctx.strokeStyle = pal.nodeText
  ctx.lineWidth = 1.6
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(x0 + px, y0)
  ctx.moveTo(x0, y0 - 4)
  ctx.lineTo(x0, y0 + 4)
  ctx.moveTo(x0 + px, y0 - 4)
  ctx.lineTo(x0 + px, y0 + 4)
  ctx.stroke()
  ctx.fillStyle = pal.nodeText
  ctx.font = '10px Inter, Arial, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(`${len} м`, x0 + px / 2, y0 - 6)
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
