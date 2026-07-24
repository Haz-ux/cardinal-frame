import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{js,mjs}'],
    testTimeout: 30000,
    hookTimeout: 60000,
    // Each test file gets its own process + temp DB
    pool: 'forks',
  },
});
