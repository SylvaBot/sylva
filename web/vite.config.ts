import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev:web` serves the dashboard with hot reload on :5173 and sends
// API, sign in and socket requests to the Worker on :8787 (`npm run dev`).
const worker = 'http://localhost:8787';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: false },
  server: {
    proxy: {
      '/v1': { target: worker, ws: true },
      '/auth': worker,
      '/overlay': worker,
    },
  },
});
