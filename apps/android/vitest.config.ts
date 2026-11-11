import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { '@': new URL('../../packages/app-ui/src', import.meta.url).pathname } },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
