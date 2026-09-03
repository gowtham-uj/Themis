import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const proxy = {
  '/api': {
    target: 'http://127.0.0.1:8080',
    changeOrigin: true,
  },
}

// Vite hashes bundle names by content, so an edit that leaves the output byte
// count and hash inputs unchanged can reuse a filename a browser already
// cached. Stamping the build time into the name makes every deploy a new URL.
const build = Date.now().toString(36)

export default defineConfig({
  define: { __BUILD_ID__: JSON.stringify(build) },
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5173, proxy },
  preview: { host: '0.0.0.0', port: 5173, proxy },
  build: {
    rollupOptions: {
      output: {
        entryFileNames: `assets/[name]-${build}-[hash].js`,
        chunkFileNames: `assets/[name]-${build}-[hash].js`,
        assetFileNames: `assets/[name]-${build}-[hash][extname]`,
      },
    },
  },
})
