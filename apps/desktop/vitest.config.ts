import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/renderer/**/*.test.ts', 'src/main/**/*.test.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  resolve: {
    alias: {
      '@': new URL('./src/renderer', import.meta.url).pathname,
    },
  },
});
