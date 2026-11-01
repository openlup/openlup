import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './browser',
  workers: 1,
  fullyParallel: false,
  use: { baseURL: 'http://127.0.0.1:4319', headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: 'node --experimental-strip-types host/server.ts',
    url: 'http://127.0.0.1:4319/api/config',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
