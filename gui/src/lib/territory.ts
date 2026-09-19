// Территория НТЦ: размеры, именованные точки, дорожная сеть, здания,
// зона тестирования, малые препятствия + лучи (raycast) для лидара/камеры
// и кратчайший путь по графу дорог (Дейкстра).

export const WORLD = { w: 600, h: 340 } // метры

export interface PointDef {
  id: string
  name: string
  x: number
  y: number
  selectable: boolean
}

export const POINTS: PointDef[] = [
  { id: 'ktp', name: 'КТП', x: 110, y: 215, selectable: true },
  { id: 'sklad', name: 'Склад', x: 470, y: 88, selectable: true },
  { id: 'adm', name: 'Администрация', x: 300, y: 262, selectable: true },
  { id: 'zone', name: 'Зона тестирования', x: 496, y: 266, selectable: true },
  { id: 'j1', name: 'Развилка (Ц)', x: 330, y: 150, selectable: false },
  { id: 'jr', name: 'Развилка (В)', x: 520, y: 170, selectable: false },
  { id: 'edge_e', name: 'Выезд', x: 592, y: 170, selectable: false },
]

export const pointById = (id: string): PointDef => POINTS.find((p) => p.id === id)!

export const SELECTABLE_POINTS = POINTS.filter((p) => p.selectable)

/** Дороги — рёбра графа между точками. */
export const ROADS: [string, string][] = [
  ['ktp', 'j1'],
  ['j1', 'sklad'],
  ['j1', 'adm'],
  ['j1', 'jr'],
  ['jr', 'zone'],
  ['jr', 'edge_e'],
]

/** Здания (препятствия, с подписью). Координаты: x,y — левый верхний угол. */
export const BUILDINGS: { name: string; x: number; y: number; w: number; h: number }[] = [
  { name: 'СКЛАД №2', x: 410, y: 14, w: 165, h: 60 },
  { name: 'АДМИНИСТРАЦИЯ', x: 252, y: 276, w: 104, h: 40 },
  { name: 'КТП', x: 66, y: 226, w: 88, h: 36 },
]

/** Зона тестирования — штриховка, проезжаемая. */
export const ZONE = { name: 'ЗОНА ТЕСТИРОВАНИЯ', x: 432, y: 236, w: 128, h: 64 }

/** Малые препятствия (освещение/конусы) вдоль дорог — дают текстуру скану. */
export const OBSTACLES: { x: number; y: number; s: number }[] = [
  { x: 214, y: 190, s: 1.4 },
  { x: 226, y: 174, s: 1.4 },
  { x: 394, y: 127, s: 1.4 },
  { x: 406, y: 111, s: 1.4 },
  { x: 307, y: 212, s: 1.4 },
  { x: 323, y: 200, s: 1.4 },
  { x: 419, y: 168, s: 1.4 },
  { x: 431, y: 152, s: 1.4 },
  { x: 500, y: 224, s: 1.4 },
  { x: 516, y: 212, s: 1.4 },
]

// ------------------------------- рейкастинг --------------------------------

interface Rect { x: number; y: number; w: number; h: number }

const RECTS: Rect[] = [
  ...BUILDINGS.map((b) => ({ x: b.x, y: b.y, w: b.w, h: b.h })),
  ...OBSTACLES.map((o) => ({ x: o.x - o.s / 2, y: o.y - o.s / 2, w: o.s, h: o.s })),
]

/**
 * Расстояние до первого препятствия (здание/препятствие/граница мира)
 * по лучу (ox,oy) в направлении (dx,dy). Нормировка направления не обязательна.
 */
export function castRay(ox: number, oy: number, dx: number, dy: number, maxDist: number): number {
  let t = maxDist

  // границы мира
  if (dx > 1e-9) t = Math.min(t, (WORLD.w - ox) / dx)
  else if (dx < -1e-9) t = Math.min(t, -ox / dx)
  if (dy > 1e-9) t = Math.min(t, (WORLD.h - oy) / dy)
  else if (dy < -1e-9) t = Math.min(t, -oy / dy)
  if (t <= 0) return 0.01

  // прямоугольники (slab-метод)
  for (const r of RECTS) {
    let tmin = 0
    let tmax = t
    if (Math.abs(dx) < 1e-9) {
      if (ox < r.x || ox > r.x + r.w) continue
    } else {
      let t1 = (r.x - ox) / dx
      let t2 = (r.x + r.w - ox) / dx
      if (t1 > t2) [t1, t2] = [t2, t1]
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) continue
    }
    if (Math.abs(dy) < 1e-9) {
      if (oy < r.y || oy > r.y + r.h) continue
    } else {
      let t1 = (r.y - oy) / dy
      let t2 = (r.y + r.h - oy) / dy
      if (t1 > t2) [t1, t2] = [t2, t1]
      tmin = Math.max(tmin, t1)
      tmax = Math.min(tmax, t2)
      if (tmin > tmax) continue
    }
    if (tmin >= 0 && tmin < t) t = tmin
  }
  return Math.max(0.01, t)
}

// ------------------------------ граф дорог --------------------------------

function roadLength(a: string, b: string): number {
  const pa = pointById(a)
  const pb = pointById(b)
  return Math.hypot(pa.x - pb.x, pa.y - pb.y)
}

/** Кратчайший маршрут по дорожной сети: список id точек от a до b (включая их). */
export function shortestPath(a: string, b: string): string[] {
  if (a === b) return [a]
  const adj = new Map<string, { to: string; len: number }[]>()
  for (const [u, v] of ROADS) {
    const l = roadLength(u, v)
    if (!adj.has(u)) adj.set(u, [])
    if (!adj.has(v)) adj.set(v, [])
    adj.get(u)!.push({ to: v, len: l })
    adj.get(v)!.push({ to: u, len: l })
  }
  const dist = new Map<string, number>([[a, 0]])
  const prev = new Map<string, string>()
  const visited = new Set<string>()
  const nodes = POINTS.map((p) => p.id)
  for (;;) {
    let u: string | null = null
    let best = Infinity
    for (const n of nodes) {
      if (visited.has(n)) continue
      const d = dist.get(n) ?? Infinity
      if (d < best) {
        best = d
        u = n
      }
    }
    if (u === null || u === b) break
    visited.add(u)
    for (const e of adj.get(u) ?? []) {
      const nd = best + e.len
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd)
        prev.set(e.to, u)
      }
    }
  }
  const path: string[] = []
  let cur: string | undefined = b
  while (cur) {
    path.unshift(cur)
    cur = prev.get(cur)
  }
  return path.length > 1 && path[0] === a ? path : [a, b]
}

/** Демопатруль: замкнутый цикл по дорожной сети от КТП. */
export const PATROL: string[] = ['ktp', 'j1', 'sklad', 'j1', 'adm', 'j1', 'ktp']
