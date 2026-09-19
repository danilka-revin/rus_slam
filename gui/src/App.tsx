import { useCallback, useEffect, useRef, useState } from 'react'
import './styles.css'
import { CameraFeed } from './components/CameraFeed'
import { Customizer } from './components/Customizer'
import { DispatchPanel, pointName } from './components/DispatchPanel'
import { Header, type HeaderTele } from './components/Header'
import { IconEye } from './components/icons'
import { MapPanel } from './components/MapPanel'
import { SchemePanel } from './components/SchemePanel'
import { VisionPanel } from './components/VisionPanel'
import { Detector } from './lib/detect'
import { nowTime, type LogEntry } from './lib/logtypes'
import {
  hexToRgb,
  loadSettings,
  resetSettings,
  saveSettings,
  type Settings,
  type ViewMode,
} from './lib/settings'
import { ROBOT_NAME, Simulator, type SectionState } from './lib/simulator'
import { pointById } from './lib/territory'

interface Tele extends HeaderTele {
  battery: number
  section: SectionState
  statusText: string
  taskCode: string
  missionActive: boolean
  odom: number
}

const STATUS: Record<string, string> = {
  patrol: 'автопатруль',
  drive_b: 'движение к B',
  open: 'открытие отсека',
  wait1: 'ожидание',
  close: 'закрытие отсека',
  wait2: 'ожидание',
  drive_a: 'возврат на A',
  idle: 'ожидание задания',
}

export default function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [view, setView] = useState<ViewMode>('map')
  const [customOpen, setCustomOpen] = useState(false)
  const [aId, setAId] = useState('ktp')
  const [bId, setBId] = useState('sklad')
  const [events, setEvents] = useState<LogEntry[]>([])
  const [tele, setTele] = useState<Tele>({
    battery: 95,
    speedKmh: 0,
    clock: '',
    estop: false,
    lidarOk: true,
    section: 'closed',
    statusText: 'автопатруль',
    taskCode: '—',
    missionActive: false,
    odom: 0,
  })

  // источники данных живут вне React-цикла
  const simRef = useRef<Simulator | null>(null)
  if (!simRef.current) simRef.current = new Simulator()
  const sim = simRef.current
  const detRef = useRef<Detector | null>(null)
  if (!detRef.current) detRef.current = new Detector()
  const det = detRef.current
  const taskN = useRef(0)
  const fpsRef = useRef(0)

  const patch = useCallback((p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p })), [])

  // durations миссии из настроек — на каждый тик
  useEffect(() => {
    sim.actionDur = settings.actionDur
    sim.waitDur = settings.waitDur
  }, [sim, settings.actionDur, settings.waitDur])

  const pushLog = useCallback((list: { msg: string; level: LogEntry['level'] }[]) => {
    if (list.length === 0) return
    const t = nowTime()
    setEvents((prev) =>
      [
        ...list.map((e) => ({ ...e, time: t })),
        ...prev,
      ].slice(0, 80),
    )
  }, [])

  // тик симуляции + детекций: 10 Гц
  useEffect(() => {
    const id = window.setInterval(() => {
      sim.tick(0.1)
      det.tick(0.1)
      pushLog([...sim.takeEvents(), ...det.takeEvents()])
    }, 100)
    return () => window.clearInterval(id)
  }, [sim, det, pushLog])

  // запуск: инициализация + демо-задание через 2 с
  const bootRef = useRef(false)
  useEffect(() => {
    if (bootRef.current) return
    bootRef.current = true
    pushLog([
      { msg: 'Система инициализирована — ROS 2 граф (демо)', level: 'ok' },
      { msg: 'Камера CAM-01: поток активен (1920×1080 @ 30 FPS)', level: 'info' },
      { msg: `Робот ${ROBOT_NAME} на позиции: ${pointById('ktp').name}. Готов к приёму задач`, level: 'ok' },
    ])
    const t = window.setTimeout(() => sendTaskRef.current(), 2000)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sendTask = useCallback(() => {
    if (aId === bId) return
    taskN.current += 1
    const code = `RS-${String(taskN.current).padStart(2, '0')}`
    sim.startMission(code, aId, bId)
  }, [sim, aId, bId])
  const sendTaskRef = useRef(sendTask)
  sendTaskRef.current = sendTask

  const toggleEstop = useCallback(() => sim.toggleEstop(), [sim])

  const onPointPick = useCallback(
    (id: string) => {
      setBId(id)
      pushLog([{ msg: `Назначена точка B: ${pointById(id).name}`, level: 'info' }])
    },
    [pushLog],
  )

  // тема / акцент / шрифт → CSS
  useEffect(() => {
    const root = document.documentElement
    const dark =
      settings.theme === 'dark' ||
      (settings.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
    root.dataset.theme = dark ? 'dark' : 'light'
    root.dataset.font = settings.font
    const [r, g, b] = hexToRgb(settings.accent)
    root.style.setProperty('--accent', settings.accent)
    root.style.setProperty('--accent-rgb', `${r} ${g} ${b}`)
  }, [settings.theme, settings.accent, settings.font])

  useEffect(() => saveSettings(settings), [settings])

  // клавиатура: 1 — карта, 2 — камера, K — кастомизация, Space — E-STOP
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.key === '1') setView('map')
      else if (e.key === '2') setView('camera')
      else if (e.key.toLowerCase() === 'k' || e.key.toLowerCase() === 'л') setCustomOpen((v) => !v)
      else if (e.key === 'Escape') setCustomOpen(false)
      else if (e.code === 'Space') {
        e.preventDefault()
        toggleEstop()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleEstop])

  // телеметрия 4 Гц
  useEffect(() => {
    const id = window.setInterval(() => {
      const r = sim.robot
      setTele({
        battery: r.battery,
        speedKmh: Math.hypot(r.vx, r.vy) * 3.6,
        clock: new Date().toLocaleTimeString('ru-RU'),
        estop: sim.estop,
        lidarOk: true,
        section: sim.section,
        statusText: sim.estop ? 'E-STOP' : STATUS[sim.phase],
        taskCode: sim.mission ? sim.mission.code : '—',
        missionActive: !!sim.mission && sim.mission.phase !== 'idle',
        odom: r.odom,
      })
    }, 250)
    return () => window.clearInterval(id)
  }, [sim])

  const onFps = useCallback((f: number) => {
    fpsRef.current = f
  }, [])

  return (
    <div className="app">
      <Header
        view={view}
        onView={setView}
        onCustomize={() => setCustomOpen((v) => !v)}
        tele={{
          battery: tele.battery,
          speedKmh: tele.speedKmh,
          clock: tele.clock,
          estop: tele.estop,
          lidarOk: tele.lidarOk,
        }}
      />

      <div className="cols">
        {/* левая колонка: заказы + схема */}
        <div className="col col-left">
          <DispatchPanel
            aId={aId}
            bId={bId}
            onA={setAId}
            onB={setBId}
            onSwap={() => {
              setAId(bId)
              setBId(aId)
            }}
            onSend={sendTask}
            estop={tele.estop}
            onEstop={toggleEstop}
            section={tele.section}
            statusText={tele.statusText.toUpperCase()}
            taskCode={tele.taskCode}
          />
          <SchemePanel
            mission={sim.mission}
            estop={tele.estop}
            actionDur={settings.actionDur}
            waitDur={settings.waitDur}
          />
        </div>

        {/* центр: карта или камера */}
        <div className="col col-center">
          {view === 'map' ? (
            <MapPanel
              sim={sim}
              settings={settings}
              patch={patch}
              onFps={onFps}
              pointA={aId}
              pointB={bId}
              onPointPick={onPointPick}
            />
          ) : (
            <section className="panel cam-panel">
              <div className="pt">
                <IconEye size={14} />
                <h3>Мониторинг и зрение</h3>
                <span className="sub">
                  CAM-01 • {settings.cameraUrl ? 'поток' : 'LIVE (демо)'} •{' '}
                  {pointName(sim.mission?.to ?? aId)}
                </span>
              </div>
              <CameraFeed sim={sim} det={det} settings={settings} big onFps={onFps} />
              <div className="feed-bar">
                <span>
                  {settings.cameraUrl ? 'поток' : 'ROS 2 / image_topic (демо)'} • <b>30 FPS</b>
                </span>
                <span className="feed-bar-r">
                  {fpsRef.current > 0 ? `${fpsRef.current} fps рендер • ` : ''}
                  FOV 87° • <b>1920×1080</b>
                </span>
              </div>
            </section>
          )}
        </div>

        {/* правая колонка: зрение + журнал */}
        <div className="col col-right">
          <VisionPanel sim={sim} det={det} settings={settings} view={view} events={events} onFps={onFps} />
        </div>
      </div>

      <Customizer
        open={customOpen}
        onClose={() => setCustomOpen(false)}
        settings={settings}
        patch={patch}
        onReset={() => setSettings(resetSettings())}
      />
    </div>
  )
}
