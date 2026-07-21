import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.{js,mjs}'],
    testTimeout: 15000,
    hookTimeout: 15000,
    // Sequential — each test file gets its own process + temp DB
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: false },
    },
  },
});
