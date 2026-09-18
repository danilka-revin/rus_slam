// Окно «что видит робот»: демо-режим — рейкастинг от позиции робота
// (отвечает на движение и поворот); при заданном URL потока — <video>.

import { useEffect, useRef, useState } from 'react'
import { drawCamera } from '../lib/cameraRender'
import { CAMERA_COLUMNS, type Settings } from '../lib/settings'
import type { Simulator } from '../lib/simulator'
import { IconExpand, IconGrid, IconSnapshot } from './icons'

interface Props {
  sim: Simulator
  settings: Settings
  patch: (p: Partial<Settings>) => void
  onFps: (fps: number) => void
}

export function CameraView({ sim, settings, patch, onFps }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const feedRef = useRef<HTMLDivElement>(null)
  const timeRef = useRef<HTMLSpanElement>(null)
  const [videoErr, setVideoErr] = useState(false)
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const cols = CAMERA_COLUMNS[settings.cameraQuality]

  useEffect(() => {
    let raf = 0
    let frames = 0
    let fpsT = performance.now()

    const loop = () => {
      raf = requestAnimationFrame(loop)
      const canvas = canvasRef.current
      if (!canvas) return
      const w = canvas.width
      const h = canvas.height
      if (w === 0 || h === 0) return
      // не рендерим, когда окно скрыто тумблером
      if (canvas.offsetParent === null) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      const s = settingsRef.current
      drawCamera(ctx, w, h, sim.map, sim.robot, w, {
        grid: s.camGrid,
        hud: s.camHud,
        accent: s.accent,
        t: sim.robot.t,
      })
      if (timeRef.current) {
        const d = new Date()
        timeRef.current.textContent = d.toLocaleTimeString('ru-RU')
      }
      frames++
      const now = performance.now()
      if (now - fpsT > 800) {
        onFps(Math.round((frames * 1000) / (now - fpsT)))
        frames = 0
        fpsT = now
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [sim, onFps, cols])

  const snapshot = () => {
    let src: CanvasImageSource
    let sw = 1280
    let sh = 720
    const canvas = canvasRef.current
    const off = document.createElement('canvas')
    if (canvas && canvas.offsetParent !== null) {
      sw = canvas.width
      sh = canvas.height
      src = canvas
    } else {
      // окно карты активно — снимаем с симуляции
      sw = 960
      sh = 540
      off.width = sw
      off.height = sh
      const ctx = off.getContext('2d')!
      drawCamera(ctx, sw, sh, sim.map, sim.robot, sw, {
        grid: settings.camGrid,
        hud: settings.camHud,
        accent: settings.accent,
        t: sim.robot.t,
      })
      src = off
    }
    const out = document.createElement('canvas')
    out.width = sw
    out.height = sh
    const ctx = out.getContext('2d')!
    ctx.drawImage(src, 0, 0, sw, sh)
    const a = document.createElement('a')
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    a.download = `rus-slam_cam1_${stamp}.png`
    a.href = out.toDataURL('image/png')
    a.click()
  }

  const fullscreen = () => {
    const el = feedRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen().catch(() => undefined)
  }

  return (
    <div className="camera-inner">
      <div className="feed-wrap">
        <div className="feed" ref={feedRef}>
          {settings.cameraUrl ? (
            !videoErr && (
              <video
                src={settings.cameraUrl}
                autoPlay
                muted
                playsInline
                onError={() => setVideoErr(true)}
              />
            )
          ) : (
            <canvas ref={canvasRef} width={cols * 2} height={Math.round((cols * 2 * 9) / 16)} />
          )}

          <div className="overlay" />
          <div className={settings.cameraUrl && videoErr ? 'live offline' : 'live'}>
            <i />
            {settings.cameraUrl ? (videoErr ? 'НЕТ СИГНАЛА' : 'LIVE') : 'DEMO'}
          </div>
          <div className="feed-tag">
            <span>CAM-1 • фронтальная</span>
            <span ref={timeRef}>--:--:--</span>
          </div>
          <div className="feed-bottom">
            <div className="map-chip">
              {settings.cameraUrl
                ? 'внешний поток'
                : `деморежим • ${cols * 2}×${Math.round((cols * 2 * 9) / 16)} • 65° FOV`}
            </div>
          </div>
        </div>
      </div>

      <div className="camera-tools">
        <button className="tool-btn" onClick={snapshot}>
          <IconSnapshot />
          Снимок
        </button>
        <button className="tool-btn" onClick={fullscreen}>
          <IconExpand />
          Во весь экран
        </button>
        <button
          className={settings.camGrid ? 'tool-btn active' : 'tool-btn'}
          onClick={() => patch({ camGrid: !settings.camGrid })}
        >
          <IconGrid />
          Сетка
        </button>
        <span className="grow" />
        <span style={{ alignSelf: 'center', fontSize: '0.7rem', color: 'var(--muted)' }}>
          URL потока (HLS/WebM) задаётся в «Кастомизации»
        </span>
      </div>

      <div className="camera-stats">
        <span>
          Камера<b>CAM-1 фронтальная</b>
        </span>
        <span>
          Режим<b>{settings.cameraUrl ? 'поток' : 'демо (рейкастинг)'}</b>
        </span>
        <span>
          Качество<b>{settings.cameraQuality === 'low' ? 'низкое' : settings.cameraQuality === 'mid' ? 'среднее' : 'высокое'}</b>
        </span>
        <span>
          Обновление<b>≈ 30 Гц</b>
        </span>
        <span>
          Задержка<b>~0 мс</b>
        </span>
      </div>
    </div>
  )
}
