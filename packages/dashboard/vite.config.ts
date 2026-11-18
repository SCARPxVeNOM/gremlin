import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // The CLI serves the built dashboard; in dev, proxy the API to a running `gremlin dash`.
  server: { proxy: { '/api': 'http://127.0.0.1:4777' } },
  build: { outDir: '../gremlin/dist/dashboard', emptyOutDir: true },
})
