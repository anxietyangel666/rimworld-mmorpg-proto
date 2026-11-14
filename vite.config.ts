import { defineConfig } from 'vite';

// The browser client lives in /client; the game server serves the built bundle
// and the WebSocket endpoint from one port, so a single URL is the whole game.
export default defineConfig({
  root: 'client',
  build: { outDir: '../dist/client', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1500 },
  server: { proxy: { '/ws': { target: 'ws://localhost:8080', ws: true } } },
});
