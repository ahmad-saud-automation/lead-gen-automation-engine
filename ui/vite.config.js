import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Builds into ../webapp/dist. FastAPI serves that folder, so there is still only one
// thing to start: start-app.bat. `npm run dev` proxies the API to the running app so the
// UI can be worked on with hot reload without a second copy of the backend.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  build: {
    outDir: '../webapp/dist',
    emptyOutDir: true,
    // one small app - a single bundle loads faster locally than many chunks
    chunkSizeWarningLimit: 1200,
  },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:8771' },
  },
})
