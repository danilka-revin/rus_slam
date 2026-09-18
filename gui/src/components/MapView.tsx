// Окно карты: canvas без зависимостей.
// Управление: ЛКМ/тач — сдвиг (pan), колесо / пинч — масштаб (zoom),
// двойной клик — приближение, кнопки +/−/вписать/следование за роботом.

import { useEffect, useRef } from 'react'
import { drawMap, fitCamera, mapPalette, type MapCamera } from '../lib/mapRender'
import type { Simulator } from '../lib/simulator'
import { type Settings } from '../lib/settings'
import { IconCrosshair, IconFit, IconMinus, IconPlus } from './icons'

interface Props {
  sim: Simulator
  settings: Settings
  patch: (p: Partial<Settings>) => void
  onFps: (fps: number) => void
}

export function MapView({ sim, settings, patch, onFps }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const camRef = useRef<MapCamera | null>(null)
  const fitPpmRef = useRef(30)
  const pointersRef = useRef(new Map<number, { x: number; y: number }>())
  const pinchRef = useRef<{ dist: number; mid: { x: number; y: number } } | null>(null)
  const hoverRef = useRef<{ x: number; y: number } | null>(null)
  const zoomChipRef = useRef<HTMLSpanElement>(null)
  const coordChipRef = useRef<HTMLSpanElement>(null)
  const followRef = useRef(settings.followRobot)
  followRef.current = settings.followRobot
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  // Главный цикл: следование за роботом + отрисовка
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

      const fit = fitCamera(sim.map, w, h)
      fitPpmRef.current = fit.ppm

      let cam = camRef.current
      if (!cam) {
        cam = { ...fit }
        camRef.current = cam
      }

      // плавное следование за роботом
      if (followRef.current) {
        cam.cx += (sim.robot.x - cam.cx) * 0.12
        cam.cy += (sim.robot.y - cam.cy) * 0.12
      }

      const s = settingsRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      drawMap(ctx, w, h, sim, cam, mapPalette(s.mapStyle, s.accent), {
        showGrid: s.showGrid,
        showTrail: s.showTrail,
        showScan: s.showScan,
        markerScale: s.markerScale,
      })

      // чипы
      if (zoomChipRef.current) {
        const z = cam.ppm / fitPpmRef.current
        zoomChipRef.current.textContent = `×${z >= 10 ? z.toFixed(0) : z.toFixed(1)}`
      }
      if (coordChipRef.current) {
        const p = hoverRef.current
        if (p) {
          const wx = cam.cx + (p.x - w / 2) / cam.ppm
          const wy = cam.cy - (p.y - h / 2) / cam.ppm
          coordChipRef.current.textContent = `x ${wx.toFixed(1)} м • y ${wy.toFixed(1)} м`
        } else {
          coordChipRef.current.textContent = `робот: x ${sim.robot.x.toFixed(1)} м • y ${sim.robot.y.toFixed(1)} м`
        }
      }

      // fps
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

  // Зум колесом — к курсору
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
      const min = fitPpmRef.current * 0.2
      const max = fitPpmRef.current * 14
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

  // Панорамирование / пинч
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    const worldAt = (px: number, py: number) => {
      const cam = camRef.current!
      const rect = wrap.getBoundingClientRect()
      return {
        x: cam.cx + (px - rect.left - rect.width / 2) / cam.ppm,
        y: cam.cy - (py - rect.top - rect.height / 2) / cam.ppm,
      }
    }

    const down = (e: PointerEvent) => {
      wrap.setPointerCapture(e.pointerId)
      pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (pointersRef.current.size === 2) {
        const [a, b] = [...pointersRef.current.values()]
        pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      }
      wrap.classList.add('panning')
    }

    const move = (e: PointerEvent) => {
      hoverRef.current = { x: e.clientX, y: e.clientY }
      const pts = pointersRef.current
      const cam = camRef.current
      if (!cam || !pts.has(e.pointerId)) return
      const prev = pts.get(e.pointerId)!
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pts.size === 1) {
        const dxw = (e.clientX - prev.x) / cam.ppm
        const dyw = (e.clientY - prev.y) / cam.ppm
        cam.cx -= dxw
        cam.cy += dyw
        followRef.current = false
        patch({ followRobot: false })
      } else if (pts.size === 2 && pinchRef.current) {
        const [a, b] = [...pts.values()]
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        const pinch = pinchRef.current
        if (pinch.dist > 0) {
          const factor = dist / pinch.dist
          const newPpm = Math.min(fitPpmRef.current * 14, Math.max(fitPpmRef.current * 0.2, cam.ppm * factor))
          const before = worldAt(pinch.mid.x, pinch.mid.y)
          cam.ppm = newPpm
          const after = worldAt(pinch.mid.x, pinch.mid.y)
          cam.cx += before.x - after.x
          cam.cy += before.y - after.y
          followRef.current = false
          patch({ followRobot: false })
        }
        pinchRef.current = { dist, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } }
      }
    }

    const up = (e: PointerEvent) => {
      pts.delete(e.pointerId)
      if (pts.size < 2) pinchRef.current = null
      if (pts.size === 0) wrap.classList.remove('panning')
    }

    const dbl = (e: MouseEvent) => {
      const cam = camRef.current
      if (!cam) return
      const rect = wrap.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      const wx = cam.cx + (px - rect.width / 2) / cam.ppm
      const wy = cam.cy - (py - rect.height / 2) / cam.ppm
      cam.ppm = Math.min(fitPpmRef.current * 14, cam.ppm * 1.6)
      cam.cx = wx - (px - rect.width / 2) / cam.ppm
      cam.cy = wy + (py - rect.height / 2) / cam.ppm
    }

    const leave = () => {
      hoverRef.current = null
    }

    const pts = pointersRef.current
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
  }, [patch])

  const zoomBy = (f: number) => {
    const cam = camRef.current
    if (!cam) return
    cam.ppm = Math.min(fitPpmRef.current * 14, Math.max(fitPpmRef.current * 0.2, cam.ppm * f))
  }

  const fitAll = () => {
    const wrap = wrapRef.current
    if (!wrap) return
    camRef.current = fitCamera(sim.map, wrap.clientWidth, wrap.clientHeight)
    patch({ followRobot: false })
  }

  return (
    <div
      className="map-wrap"
      ref={wrapRef}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} />

      <div className="map-chip tl">
        <span>
          zoom <b ref={zoomChipRef}>×1.0</b>
        </span>
        <span ref={coordChipRef}>робот: x 2.0 м • y 2.0 м</span>
      </div>

      <div className="map-controls">
        <button title="Приблизить" onClick={() => zoomBy(1.35)}>
          <IconPlus />
        </button>
        <button title="Отдалить" onClick={() => zoomBy(1 / 1.35)}>
          <IconMinus />
        </button>
        <button title="Вписать карту" onClick={fitAll}>
          <IconFit />
        </button>
        <button
          title="Следовать за роботом"
          className={settings.followRobot ? 'active' : ''}
          onClick={() => patch({ followRobot: !settings.followRobot })}
        >
          <IconCrosshair />
        </button>
      </div>

      <div className="map-chip br">ЛКМ — двигать • колесо / пинч — масштаб • 2×клик — ближе</div>
    </div>
  )
}
