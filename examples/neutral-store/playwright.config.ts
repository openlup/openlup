import { defineConfig } from '@playwright/test';

const configurations = [
  { id: 'supplements', port: 4319 },
  { id: 'coffee', port: 4320 },
];

export default defineConfig({
  testDir: './browser',
  // Editor proofs use their component or installed-database configuration.
  testIgnore: ['**/editor-components.spec.ts', '**/subscription-journeys.spec.ts', '**/subscription-api.spec.ts'],
  // Care journeys use the private fixtures created by ./lifecycle browser.
  grepInvert: /database subscription care/,
  workers: 1,
  fullyParallel: false,
  use: { headless: true, trace: 'off', screenshot: 'off', video: 'off' },
  projects: configurations.map(({ id, port }) => ({
    name: id, use: { baseURL: `http://127.0.0.1:${port}` },
  })),
  webServer: configurations.map(({ id, port }) => ({
    command: `node --experimental-strip-types host/server.ts --configuration ${id} --port ${port} --listen 127.0.0.1`,
    url: `http://127.0.0.1:${port}/api/config`,
    reuseExistingServer: false,
    timeout: 30000,
  })),
});
