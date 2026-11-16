import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/** Separate from the application dev server: fixtures never proxy to a Lionscope server or device. */
export default defineConfig({
  root: fileURLToPath(new URL('./fixture/', import.meta.url)),
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 4178,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL('../../', import.meta.url))] },
  },
});
