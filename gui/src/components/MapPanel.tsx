// Центральное окно «КАРТА ЛИДАР»: canvas без зависимостей.
// Управление: ЛКМ/тач — сдвиг (pan), колесо / пинч — масштаб (zoom) к
// курсору, двойной клик — ближе, кнопки +/−/вписать/следование.
// Клик по именованной точке назначает её пунктом B.

import { useEffect, useRef } from 'react'
import { drawTerritory, fitCamera, mapPalette, type MapCamera } from '../lib/mapRender'
import { SELECTABLE_POINTS } from '../lib/territory'
import type { Simulator } from '../lib/simulator'
import { type Settings } from '../lib/settings'
import { IconCrosshair, IconFit, IconMap, IconMinus, IconPlus } from './icons'

interface Props {
  sim: Simulator
  settings: Settings
  patch: (p: Partial<Settings>) => void
  onFps: (fps: number) => void
  pointA: string
  pointB: string
  onPointPick: (id: string) => void
}

export function MapPanel({ sim, settings, patch, onFps, pointA, pointB, onPointPick }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const camRef = useRef<MapCamera | null>(null)
  const fitPpmRef = useRef(1)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null)
  const hoverRef = useRef<{ x: number; y: number } | null>(null)
  const downRef = useRef<{ x: number; y: number; t: number } | null>(null)
  const coordRef = useRef<HTMLSpanElement>(null)
  const zoomRef = useRef<HTMLSpanElement>(null)
  const followRef = useRef(settings.followRobot)
  followRef.current = settings.followRobot
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const ptsRef = useRef({ a: pointA, b: pointB })
  ptsRef.current = { a: pointA, b: pointB }

  useEffect(() => {
    let raf = 0
    let frames = 0
    let fpsT = performance.now()

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop)
      const wrap = wrapRef.current
      const canvas = canvasRef.current
      if (!wrap || !canvas) return
      const w = wrap.clientWidth
      const h = wrap.clientHeight
      if (w < 10 || h < 10) return

      const dpr = Math.min(2, window.devicePixelRatio || 1)
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
      }
      const ctx = canvas.getContext('2d')
      if (!ctx) return

      const fit = fitCamera(w, h)
      fitPpmRef.current = fit.ppm
      let cam = camRef.current
      if (!cam) {
        cam = { ...fit }
        camRef.current = cam
      }
      if (followRef.current) {
        cam.cx += (sim.robot.x - cam.cx) * 0.12
        cam.cy += (sim.robot.y - cam.cy) * 0.12
      }

      const s = settingsRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawTerritory(ctx, w, h, sim, cam, mapPalette(s.mapStyle, s.accent), {
        showGrid: s.showGrid,
        showTrail: s.showTrail,
        showScan: s.showScan,
        markerScale: s.markerScale,
        pointA: ptsRef.current.a,
        pointB: ptsRef.current.b,
      })

      if (zoomRef.current) {
        const z = cam.ppm / fitPpmRef.current
        zoomRef.current.textContent = `×${z >= 10 ? z.toFixed(0) : z.toFixed(1)}`
      }
      if (coordRef.current) {
        const r = sim.robot
        const deg = Math.round(((r.heading * 180) / Math.PI + 360) % 360)
        coordRef.current.textContent = `X ${Math.round(r.x)} • Y ${Math.round(r.y)} • θ ${deg}°`
      }

      frames++
      if (now - fpsT > 800) {
        onFps(Math.round((frames * 1000) / (now - fpsT)))
        frames = 0
        fpsT = now
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [sim, onFps])

  // зум колесом к курсору
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const cam = camRef.current
      if (!cam) return
      const rect = wrap.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const factor = Math.exp(-e.deltaY * 0.0014)
      const min = fitPpmRef.current * 0.3
      const max = fitPpmRef.current * 16
      const newPpm = Math.min(max, Math.max(min, cam.ppm * factor))
      const wx = cam.cx + (px - rect.width / 2) / cam.ppm
      const wy = cam.cy - (py - rect.height / 2) / cam.ppm
      cam.cx = wx - (px - rect.width / 2) / newPpm
      cam.cy = wy + (py - rect.height / 2) / newPpm
      cam.ppm = newPpm
    }
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => wrap.removeEventListener('wheel', onWheel)
  }, [])

  // пан / пинч / клик по точкам
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return
    const pts = pointersRef.current

    const worldAt = (clientX: number, clientY: number) => {
      const cam = camRef.current!
      const rect = wrap.getBoundingClientRect()
      return {
        x: cam.cx + (clientX - rect.left - rect.width / 2) / cam.ppm,
        y: cam.cy - (clientY - rect.top - rect.height / 2) / cam.ppm,
      }
    }

    const down = (e: PointerEvent) => {
      wrap.setPointerCapture(e.pointerId)
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })
      downRef.current = { x: e.clientX, y: e.clientY, t: performance.now() }
      if (pts.size === 2) {
        const [a, b] = [...pts.values()]
        pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      }
      wrap.classList.add('panning')
    }

    const move = (e: PointerEvent) => {
      hoverRef.current = { x: e.clientX, y: e.clientY }
      const cam = camRef.current
      if (!cam || !pts.has(e.pointerId)) return
      const prev = pts.get(e.pointerId)!
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pts.size === 1) {
        cam.cx -= (e.clientX - prev.x) / cam.ppm
        cam.cy += (e.clientY - prev.y) / cam.ppm
        if (followRef.current) {
          followRef.current = false
          patch({ followRobot: false })
        }
      } else if (pts.size === 2 && pinchRef.current) {
        const [a, b] = [...pts.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const pinch = pinchRef.current
        if (pinch.dist > 0) {
          const factor = dist / pinch.dist
          const newPpm = Math.min(
            fitPpmRef.current * 16,
            Math.max(fitPpmRef.current * 0.3, cam.ppm * factor),
          )
          const before = worldAt(pinch.mid.x, pinch.mid.y)
          cam.ppm = newPpm
          const after = worldAt(pinch.mid.x, pinch.mid.y)
          cam.cx += before.x - after.x
          cam.cy += before.y - after.y
          if (followRef.current) {
            followRef.current = false
            patch({ followRobot: false })
          }
        }
        pinchRef.current = { dist, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      }
    }

    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId)
      if (pts.size < 2) pinchRef.current = null
      if (pts.size === 0) wrap.classList.remove('panning')

      // клик (не перетаскивание) — назначение точки B
      const d = downRef.current
      if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 6 && performance.now() - d.t < 450) {
        const wpt = worldAt(e.clientX, e.clientY)
        for (const p of SELECTABLE_POINTS) {
          if (Math.hypot(p.x - wpt.x, p.y - wpt.y) < 12) {
            onPointPick(p.id)
            break
          }
        }
      }
      downRef.current = null
    }

    const dbl = (e: MouseEvent) => {
      const cam = camRef.current
      if (!cam) return
      const rect = wrap.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const wx = cam.cx + (px - rect.width / 2) / cam.ppm
      const wy = cam.cy - (py - rect.height / 2) / cam.ppm
      cam.ppm = Math.min(fitPpmRef.current * 16, cam.ppm * 1.6)
      cam.cx = wx - (px - rect.width / 2) / cam.ppm
      cam.cy = wy + (py - rect.height / 2) / cam.ppm
    }

    const leave = () => {
      hoverRef.current = null
    }

    wrap.addEventListener('pointerdown', down)
    wrap.addEventListener('pointermove', move)
    wrap.addEventListener('pointerup', up)
    wrap.addEventListener('pointercancel', up)
    wrap.addEventListener('pointerleave', leave)
    wrap.addEventListener('dblclick', dbl)
    return () => {
      wrap.removeEventListener('pointerdown', down)
      wrap.removeEventListener('pointermove', move)
      wrap.removeEventListener('pointerup', up)
      wrap.removeEventListener('pointercancel', up)
      wrap.removeEventListener('pointerleave', leave)
      wrap.removeEventListener('dblclick', dbl)
    }
  }, [patch, onPointPick])

  const zoomBy = (f: number) => {
    const cam = camRef.current
    if (!cam) return
    cam.ppm = Math.min(fitPpmRef.current * 16, Math.max(fitPpmRef.current * 0.3, cam.ppm * f))
  }

  const fitAll = () => {
    const wrap = wrapRef.current
    if (!wrap) return
    camRef.current = fitCamera(wrap.clientWidth, wrap.clientHeight)
    patch({ followRobot: false })
  }

  return (
    <section className="panel map-panel">
      <div className="pt">
        <IconMap size={14} />
        <h3>Карта лидар</h3>
        <span className="sub" ref={coordRef}>
          X 0 • Y 0 • θ 0°
        </span>
      </div>

      <div className="map-wrap" ref={wrapRef} onContextMenu={(e) => e.preventDefault()}>
        <canvas ref={canvasRef} />
        <div className="map-chip tl">
          <span>
            zoom <b ref={zoomRef}>×1.0</b>
          </span>
        </div>
        <div className="map-controls">
          <button title="Приблизить" onClick={() => zoomBy(1.35)}>
            <IconPlus size={15} />
          </button>
          <button title="Отдалить" onClick={() => zoomBy(1 / 1.35)}>
            <IconMinus size={15} />
          </button>
          <button title="Вписать территорию" onClick={fitAll}>
            <IconFit size={15} />
          </button>
          <button
            title="Следовать за роботом"
            className={settings.followRobot ? 'active' : ''}
            onClick={() => patch({ followRobot: !settings.followRobot })}
          >
            <IconCrosshair size={15} />
          </button>
        </div>
      </div>

      <div className="map-legend">
        <span>
          <i className="lg lg-robot" /> Робот RB-01
        </span>
        <span>
          <i className="lg lg-route" /> Маршрут
        </span>
        <span>
          <i className="lg lg-point" /> Точки (нажмите для назначения)
        </span>
        <span className="legend-hint">ЛКМ — двигать • колесо / пинч — масштаб</span>
      </div>
    </section>
  )
}
