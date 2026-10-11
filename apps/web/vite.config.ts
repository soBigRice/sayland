import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), plugins: [react()],
  server: { port: 4310, strictPort: true, host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:4311' } },
  build: { outDir: '../../dist/web', emptyOutDir: true },
});
