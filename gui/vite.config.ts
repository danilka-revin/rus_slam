import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Пульт роботa: статичное SPA, ограничений по origin нет —
// подходит и для preview-прокси, и для раздачи рядом с ROS 2 bridge.
export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
  preview: { host: '0.0.0.0', port: 5173, allowedHosts: true },
})
