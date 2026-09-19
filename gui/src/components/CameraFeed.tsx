// Вид с камеры CAM-01: демо-рейкастинг от позиции робота (или <video>
// при заданном URL потока) + оверлеи REC / время. Используется и в правой
// колонке, и в центральному окне вкладки «Камера» (prop big).

import { useEffect, useRef, useState } from 'react'
import { CAM_FOV_DEG, drawCamera } from '../lib/cameraRender'
import { CAMERA_COLUMNS, type Settings } from '../lib/settings'
import type { Detector } from '../lib/detect'
import type { Simulator } from '../lib/simulator'

interface Props {
  sim: Simulator
  det: Detector
  settings: Settings
  big?: boolean
  onFps?: (fps: number) => void
}

export function CameraFeed({ sim, det, settings, big = false, onFps }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const [videoErr, setVideoErr] = useState(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const q = CAMERA_COLUMNS[settings.cameraQuality]
  const cols = big ? Math.max(640, q) : q

  useEffect(() => {
    let raf = 0
    let frames = 0
    let fpsT = performance.now()

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const canvas = canvasRef.current
      if (!canvas || canvas.offsetParent === null) return
      const w = canvas.width
      const h = canvas.height
      if (w === 0 || h === 0) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const s = settingsRef.current
      drawCamera(ctx, w, h, sim.robot, det.active, {
        grid: s.camGrid,
        hud: s.camHud,
        accent: s.accent,
        t: sim.robot.t,
      })
      if (timeRef.current) {
        const d = new Date()
        timeRef.current.textContent = d.toLocaleDateString('ru-RU') + ', ' + d.toLocaleTimeString('ru-RU')
      }
      frames++
      const now = performance.now()
      if (now - fpsT > 800) {
        onFps?.(Math.round((frames * 1000) / (now - fpsT)))
        frames = 0
        fpsT = now
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [sim, det, cols, onFps, big])

  const canvasW = cols * 2
  const canvasH = Math.round((canvasW * 9) / 16)

  return (
    <div className={`feed${big ? ' big' : ''}`}>
      {settings.cameraUrl ? (
        !videoErr && (
          <video src={settings.cameraUrl} autoPlay muted playsInline onError={() => setVideoErr(true)} />
        )
      ) : (
        <canvas ref={canvasRef} width={canvasW} height={canvasH} />
      )}
      <div className="rec">
        <i />
        {settings.cameraUrl ? (videoErr ? 'НЕТ СИГНАЛА' : 'LIVE') : 'REC'} — CAM-01
      </div>
      <span className="ftime" ref={timeRef}>
        --
      </span>
      <span className="feed-fov">FOV {CAM_FOV_DEG}°</span>
    </div>
  )
}
