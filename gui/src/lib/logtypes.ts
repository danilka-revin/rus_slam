// Общие типы журнала событий.
export interface LogEntry {
  time: string
  msg: string
  level: 'ok' | 'err' | 'warn' | 'info'
}

export function nowTime(): string {
  return new Date().toLocaleTimeString('ru-RU')
}
