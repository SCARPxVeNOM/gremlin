import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// VITE_SNAPSHOT=1 builds the read-only copy for a static host instead (scripts/snapshot.mjs fills in its data).
const snapshot = process.env.VITE_SNAPSHOT === '1'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: snapshot ? './' : '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // The CLI serves the built dashboard; in dev, proxy the API to a running `gremlin dash`.
  server: { proxy: { '/api': 'http://127.0.0.1:4777' } },
  build: { outDir: snapshot ? 'dist-snapshot' : '../gremlin/dist/dashboard', emptyOutDir: true },
})
