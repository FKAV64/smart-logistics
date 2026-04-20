import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['team-005.hackaton.sivas.edu.tr'],
    proxy: {
      // Any request starting with /api will be forwarded to the Gateway container
      '/api': {
        target: 'http://gateway:3000', // Use the internal Docker network name
        changeOrigin: true,
        ws: true, // IMPORTANT: This tells Vite to proxy WebSockets too!
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
})