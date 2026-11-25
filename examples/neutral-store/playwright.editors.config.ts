import { defineConfig } from '@playwright/test';

/** Component characterization only: API responses in this file's specs are synthetic. */
export default defineConfig({
  testDir: './browser',testMatch: 'editor-components.spec.ts',workers: 1,fullyParallel: false,
  // Explicit budgets for shared hosted runners instead of the 30 s / 5 s defaults.
  timeout: 60_000,expect: { timeout: 10_000 },
  use: { headless: true,trace: 'off',screenshot: 'off',video: 'off' },
  projects: ['supplements','coffee'].map((id,index) => ({ name: id,use: { baseURL: `http://127.0.0.1:${44319+index}` } })),
  webServer: ['supplements','coffee'].map((id,index) => ({
    command: `node --experimental-strip-types host/server.ts --configuration ${id} --port ${44319+index} --listen 127.0.0.1`,
    url: `http://127.0.0.1:${44319+index}/api/config`,reuseExistingServer: false,timeout: 30000,
  })),
});
