import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const api = `http://localhost:${process.env.PORT ?? 8787}`;

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': api, '/world': api },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
