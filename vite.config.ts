import os from 'node:os'
import react from '@vitejs/plugin-react'
import { defineConfig, type PluginOption } from 'vite'

function resolveLanIp(): string {
  const networks = os.networkInterfaces()
  for (const iface of Object.values(networks)) {
    for (const net of iface ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address
      }
    }
  }
  return 'localhost'
}

const lanIp = resolveLanIp()

function lanUrlPlugin(): PluginOption {
  return {
    name: 'lan-url',
    configureServer(server) {
      server.middlewares.use('/__lan_url', (_req, res) => {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ url: `http://${lanIp}:5173` }))
      })
    }
  }
}

export default defineConfig({
  plugins: [react(), lanUrlPlugin()],
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        secure: false,
        rewrite: (path) => path.replace(/^\/api/, '')
      }
    }
  }
})