// Кастомизация: все настройки GUI с персистентностью в localStorage.

export type ViewMode = 'map' | 'camera'
export type ThemeMode = 'light' | 'dark' | 'system'
export type FontScale = 's' | 'm' | 'l'
export type MapStyle = 'light' | 'dark'
export type CameraQuality = 'low' | 'mid' | 'high'

export interface Settings {
  theme: ThemeMode
  accent: string
  font: FontScale
  mapStyle: MapStyle
  followRobot: boolean
  showGrid: boolean
  showTrail: boolean
  showScan: boolean
  markerScale: number
  cameraQuality: CameraQuality
  cameraUrl: string
  camGrid: boolean
  camHud: boolean
}

export const ACCENTS: { name: string; value: string }[] = [
  { name: 'Лайм (фирменный)', value: '#d5ff45' },
  { name: 'Янтарь', value: '#ffc857' },
  { name: 'Бирюза', value: '#5fd4d4' },
  { name: 'Коралл', value: '#ff8175' },
  { name: 'Фиалка', value: '#b9a7ff' },
]

export const DEFAULT_SETTINGS: Settings = {
  theme: 'light',
  accent: '#d5ff45',
  font: 'm',
  mapStyle: 'dark',
  followRobot: true,
  showGrid: true,
  showTrail: true,
  showScan: true,
  markerScale: 1,
  cameraQuality: 'mid',
  cameraUrl: '',
  camGrid: true,
  camHud: true,
}

export const CAMERA_COLUMNS: Record<CameraQuality, number> = {
  low: 320,
  mid: 480,
  high: 640,
}

const KEY = 'rus-slam-gui:settings:v1'

function isNum(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max
}

function oneOf<T extends string>(v: unknown, list: readonly T[], fallback: T): T {
  return typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : fallback
}

function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v)
}

export function sanitizeSettings(raw: Partial<Settings>): Settings {
  const d = DEFAULT_SETTINGS
  return {
    theme: oneOf(raw.theme, ['light', 'dark', 'system'] as const, d.theme),
    accent: isHexColor(raw.accent) ? raw.accent : d.accent,
    font: oneOf(raw.font, ['s', 'm', 'l'] as const, d.font),
    mapStyle: oneOf(raw.mapStyle, ['light', 'dark'] as const, d.mapStyle),
    followRobot: typeof raw.followRobot === 'boolean' ? raw.followRobot : d.followRobot,
    showGrid: typeof raw.showGrid === 'boolean' ? raw.showGrid : d.showGrid,
    showTrail: typeof raw.showTrail === 'boolean' ? raw.showTrail : d.showTrail,
    showScan: typeof raw.showScan === 'boolean' ? raw.showScan : d.showScan,
    markerScale: isNum(raw.markerScale, 0.6, 2) ? raw.markerScale : d.markerScale,
    cameraQuality: oneOf(raw.cameraQuality, ['low', 'mid', 'high'] as const, d.cameraQuality),
    cameraUrl: typeof raw.cameraUrl === 'string' ? raw.cameraUrl.slice(0, 500) : d.cameraUrl,
    camGrid: typeof raw.camGrid === 'boolean' ? raw.camGrid : d.camGrid,
    camHud: typeof raw.camHud === 'boolean' ? raw.camHud : d.camHud,
  }
}

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) })
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* приватный режим — просто не сохраняем */
  }
}

export function resetSettings(): Settings {
  try {
    localStorage.removeItem(KEY)
  } catch {
    /* ignore */
  }
  return { ...DEFAULT_SETTINGS }
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) return [213, 255, 69]
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]
}
