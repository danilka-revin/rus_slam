// Правая колонка: «МОНИТОРИНГ И ЗРЕНИЕ» (камера),
// «РАСПОЗНАВАНИЕ ОБЪЕКТОВ» (YOLOv-8), «ЖУРНАЛ СОБЫТИЙ» (ROSOUT).

import { CAM_FOV_DEG } from '../lib/cameraRender'
import { TL_LABEL, type Detector } from '../lib/detect'
import type { Settings } from '../lib/settings'
import type { Simulator } from '../lib/simulator'
import type { LogEntry } from '../lib/logtypes'
import { CameraFeed } from './CameraFeed'
import { IconEye, IconHistory, IconTarget } from './icons'

interface Props {
  sim: Simulator
  det: Detector
  settings: Settings
  view: 'map' | 'camera'
  events: LogEntry[]
  onFps: (fps: number) => void
}

export function VisionPanel({ sim, det, settings, view, events, onFps }: Props) {
  return (
    <>
      {view === 'map' && (
        <section className="panel">
          <div className="pt">
            <IconEye size={14} />
            <h3>Мониторинг и зрение</h3>
            <span className="sub">CAM-01 • LIVE</span>
          </div>
          <CameraFeed sim={sim} det={det} settings={settings} onFps={onFps} />
          <div className="feed-bar">
            <span>
              {settings.cameraUrl ? 'поток' : 'ROS 2 / image_topic (демо)'} • <b>30 FPS</b>
            </span>
            <span className="feed-bar-r">
              FOV {CAM_FOV_DEG}° • <b>1920×1080</b>
            </span>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="pt">
          <IconTarget size={14} />
          <h3>Распознавание объектов</h3>
          <span className="sub">YOLOv-8</span>
        </div>
        <div className="det-list">
          {det.active.length === 0 && <div className="det-empty">объектов нет</div>}
          {det.active.slice(0, 4).map((d) => (
            <div className="det" key={d.id}>
              <i className="det-dot" style={{ background: d.color }} />
              <div className="det-names">
                <b>{d.ru}</b>
                <small>
                  {d.en}
                  {d.id === 'tl' ? ` — ${TL_LABEL[det.tl]}` : ''}
                </small>
              </div>
              <span className="det-conf" style={{ color: d.color }}>
                {d.conf.toFixed(2)}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="panel log-panel">
        <div className="pt">
          <IconHistory size={14} />
          <h3>Журнал событий</h3>
          <span className="sub">ROSOUT</span>
        </div>
        <div className="log">
          {events.length === 0 && <div className="det-empty">событий нет</div>}
          {events.map((e, i) => (
            <div className="log-row" key={`${e.time}-${i}`}>
              <time>{e.time}</time>
              <span className={`msg ${e.level}`}>{e.msg}</span>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
