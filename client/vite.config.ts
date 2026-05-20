import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: process.env.VERCEL
    ? undefined
    : {
        proxy: {
          '/api': {
            target: 'http://127.0.0.1:4000',
            changeOrigin: true,
          },
        },
      },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test-setup.ts',
    testTimeout: 15000,
    exclude: ['dist/**', 'coverage/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});
