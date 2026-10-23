import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Mirrors WS_PATH / DEFAULT_DASHBOARD_PORT from @lionscope/protocol/wire. The protocol package ships
// TypeScript source, which the config loader can't import under plain Node.
const WS_PATH = '/ws';
const SERVER_PORT = 8701;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Origin is forwarded unchanged (no changeOrigin): the server allowlists the Vite dev origin.
      [WS_PATH]: { target: `ws://127.0.0.1:${SERVER_PORT}`, ws: true },
      // Layout Inspector screenshots (0.5.0).
      '/inspector': { target: `http://127.0.0.1:${SERVER_PORT}` },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Fonts ship as files, never data: URIs, so the server CSP can stay at font-src 'self'.
    assetsInlineLimit: 0,
  },
});
