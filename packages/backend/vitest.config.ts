import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Each test gets its own in-memory DB; no need for parallelism limits
    // beyond vitest defaults. Tests that spawn child processes set their
    // own timeouts.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
