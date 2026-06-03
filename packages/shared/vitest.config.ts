import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Shared tests are pure-function contract tests (zod schemas,
    // classifiers, drift guards). No DB, no spawn, no network — the
    // 5s default is plenty.
    testTimeout: 5_000,
  },
});
