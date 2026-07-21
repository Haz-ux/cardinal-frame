import { defineConfig } from '@playwright/test';

export default defineConfig({
 testDir: './e2e',
 timeout: 30000,
 retries: 0,
 use: {
 baseURL: 'http://localhost:3000',
 headless: true,
 screenshot: 'only-on-failure',
 trace: 'on-first-retry',
 extraHTTPHeaders: { 'X-Test-Mode': '1' },
 },
 projects: [
 {
 name: 'chromium',
 use: { browserName: 'chromium' },
 },
 ],
 webServer: {
 command: 'NODE_ENV=test node src/server/server.mjs',
 port: 3000,
 reuseExistingServer: true,
 },
});
