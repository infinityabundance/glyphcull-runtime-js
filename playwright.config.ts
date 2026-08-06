import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './test/browser',
  timeout: 60000,
  fullyParallel: true,
  use: {
    ...devices['Desktop Chrome'],
  },
  webServer: {
    command: 'node scripts/browser-harness/server.mjs',
    port: 4187,
    reuseExistingServer: !process.env.CI,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
