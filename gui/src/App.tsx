import { useCallback, useEffect, useRef, useState } from 'react'
import './styles.css'
import { CameraView } from './components/CameraView'
import { Customizer } from './components/Customizer'
import { Header } from './components/Header'
import { IconActivity, IconBattery, IconGauge, IconRoute } from './components/icons'
import { MapView } from './components/MapView'
import { Sidebar } from './components/Sidebar'
import {
  hexToRgb,
  loadSettings,
  resetSettings,
  saveSettings,
  type Settings,
  type ViewMode,
} from './lib/settings'
import { Simulator } from './lib/simulator'

interface Telemetry {
  battery: number
  speed: number
  odom: number
  fps: number
  clock: string
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [view, setView] = useState<ViewMode>('map')
  const [customOpen, setCustomOpen] = useState(false)
  const [tele, setTele] = useState<Telemetry>({ battery: 96, speed: 0, odom: 0, fps: 0, clock: '' })

  // Симулятор живёт вне React-цикла — рендер читает его по rAF
  const simRef = useRef<Simulator | null>(null)
  if (!simRef.current) simRef.current = new Simulator()
  const sim = simRef.current
  const fpsRef = useRef({ map: 0, camera: 0 })

  const patch = useCallback((p: Partial<Settings>) => {
    setSettings((s) => ({ ...s, ...p }))
  }, [])

  const onReset = useCallback(() => {
    setSettings(resetSettings())
  }, [])

  // Тик симуляции: 10 Гц
  useEffect(() => {
    const id = window.setInterval(() => sim.tick(0.1), 100)
    return () => window.clearInterval(id)
  }, [sim])

  // Тема / акцент / шрифт → CSS
  useEffect(() => {
    const root = document.documentElement
    const dark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches)
    root.dataset.theme = dark ? 'dark' : 'light'
    root.dataset.font = settings.font
    const [r, g, b] = hexToRgb(settings.accent)
    root.style.setProperty('--accent', settings.accent)
    root.style.setProperty('--accent-rgb', `${r} ${g} ${b}`)
  }, [settings.theme, settings.accent, settings.font])

  // Персистентность
  useEffect(() => saveSettings(settings), [settings])

  // Клавиатура: 1 — карта, 2 — камера, K — кастомизация
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      if (e.key === '1') setView('map')
      else if (e.key === '2') setView('camera')
      else if (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'л') setCustomOpen((v) => !v)
      else if (e.key === 'Escape') setCustomOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Телеметрия для statusline — 2 Гц
  useEffect(() => {
    const id = window.setInterval(() => {
      setTele({
        battery: sim.robot.battery,
        speed: Math.hypot(sim.robot.vx, sim.robot.vy),
        odom: sim.robot.odom,
        fps: view === 'map' ? fpsRef.current.map : fpsRef.current.camera,
        clock: new Date().toLocaleTimeString('ru-RU'),
      })
    }, 500)
    return () => window.clearInterval(id)
  }, [sim, view])

  const onFpsMap = useCallback((f: number) => {
    fpsRef.current.map = f
  }, [])
  const onFpsCamera = useCallback((f: number) => {
    fpsRef.current.camera = f
  }, [])

  return (
    <div className="app">
      <Sidebar
        view={view}
        onView={setView}
        onCustomize={() => setCustomOpen(true)}
        customOpen={customOpen}
      />

      <main>
        <Header view={view} onView={setView} onCustomize={() => setCustomOpen((v) => !v)} />

        <div className="statusline">
          <div className="left">
            <span className="tag">
              <i />ДЕМО-РЕЖИМ
            </span>
            <b>Связь: имитация</b>
            <small>мост ROS 2 (tf + scan + camera) подключается следующим шагом</small>
          </div>
          <div className="chips">
            <span className="chip-stat" title="Батарея">
              <IconBattery size={13} />
              <b>{tele.battery.toFixed(0)}%</b>
            </span>
            <span className="chip-stat" title="Скорость">
              <IconGauge size={13} />
              <b>{tele.speed.toFixed(1)} м/с</b>
            </span>
            <span className="chip-stat" title="Пройдено">
              <IconRoute size={13} />
              <b>{tele.odom.toFixed(0)} м</b>
            </span>
            <span className="chip-stat" title="Кадры/с">
              <IconActivity size={13} />
              <b>{tele.fps} Гц</b>
            </span>
            <span className="chip-stat">{tele.clock}</span>
          </div>
        </div>

        <div className="stage">
          <div className={`panel map-panel${view === 'map' ? '' : ' hidden'}`}>
            <MapView sim={sim} settings={settings} patch={patch} onFps={onFpsMap} />
          </div>
          <div className={`panel camera-panel${view === 'camera' ? '' : ' hidden'}`}>
            <CameraView sim={sim} settings={settings} patch={patch} onFps={onFpsCamera} />
          </div>
        </div>
      </main>

      <Customizer
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        settings={settings}
        patch={patch}
        onReset={onReset}
      />
    </div>
  )
}
