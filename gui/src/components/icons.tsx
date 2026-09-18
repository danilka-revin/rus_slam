// Компактные SVG-иконки в духе lucide (только нужные).
import type { SVGProps } from 'react'

type P = SVGProps<SVGSVGElement> & { size?: number }

function base({ size = 16, ...rest }: P): P {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
    ...rest,
  }
}

export const IconRobot = (p: P) => (
  <svg {...base(p)}>
    <rect x="5" y="8" width="14" height="10" rx="2" />
    <circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none" />
    <path d="M12 6.6V8" />
    <circle cx="9.5" cy="13" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="14.5" cy="13" r="1.2" fill="currentColor" stroke="none" />
    <path d="M2 12v3M22 12v3" />
  </svg>
)

export const IconMap = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2Z" />
    <path d="M9 4v14M15 6v14" />
  </svg>
)

export const IconCamera = (p: P) => (
  <svg {...base(p)}>
    <rect x="2" y="7" width="14" height="10" rx="2" />
    <path d="m16 10 6-3v10l-6-3" />
  </svg>
)

export const IconSliders = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h13M20 18h0" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="19" cy="18" r="2" />
  </svg>
)

export const IconActivity = (p: P) => (
  <svg {...base(p)}>
    <path d="M22 12h-4l-3 8-6-16-3 8H2" />
  </svg>
)

export const IconHistory = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5" />
    <path d="M12 7v5l3 3" />
  </svg>
)

export const IconRoute = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="19" r="2.5" />
    <circle cx="18" cy="5" r="2.5" />
    <path d="M8.5 19H15a3.5 3.5 0 0 0 0-7H9a3.5 3.5 0 0 1 0-7h6.5" />
  </svg>
)

export const IconBattery = (p: P) => (
  <svg {...base(p)}>
    <rect x="2" y="7" width="17" height="10" rx="2" />
    <path d="M22 11v2" />
    <path d="M5 10.5v3M8 10.5v3M11 10.5v3" />
  </svg>
)

export const IconGauge = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 15 8.5 8.5" />
    <path d="M20.5 15.5a9 9 0 1 0-17 0" />
  </svg>
)

export const IconPlus = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
)

export const IconMinus = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
)

export const IconFit = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
  </svg>
)

export const IconCrosshair = (p: P) => (
  <svg {...base(p)}>
    <circle cx="12" cy="12" r="7" />
    <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
  </svg>
)

export const IconSnapshot = (p: P) => (
  <svg {...base(p)}>
    <path d="M21 15V8a2 2 0 0 0-2-2h-3l-2-3H10L8 6H5a2 2 0 0 0-2 2v12h18v-5" />
    <circle cx="12" cy="13" r="3.5" />
  </svg>
)

export const IconExpand = (p: P) => (
  <svg {...base(p)}>
    <path d="M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5" />
  </svg>
)

export const IconX = (p: P) => (
  <svg {...base(p)}>
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
)

export const IconReset = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 12a9 9 0 1 1 2.6 6.4" />
    <path d="M3 22v-5h5" />
  </svg>
)

export const IconGrid = (p: P) => (
  <svg {...base(p)}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
  </svg>
)
