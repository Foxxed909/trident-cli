import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
      '/api': 'http://127.0.0.1:7777',
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
