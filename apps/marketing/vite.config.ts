import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    env: {
      VITE_APP_URL: 'https://app.monapp.com',
      VITE_ROOT_DOMAIN: 'monapp.com',
    },
  },
});
