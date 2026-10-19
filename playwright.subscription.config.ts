import { defineConfig, devices } from "@playwright/test";

/**
 * Retained subscription preview config. Its subscription-self-service.spec.ts
 * target is absent from the public tree. Use the shipped profile journeys in
 * docs/platform/SUBSCRIPTION_REFERENCE.md; this config establishes no proof.
 */

const baseURL =
  process.env.SUBSCRIPTION_E2E_BASE_URL ??
  process.env.HIDDEN_PREVIEW_HEALTH_BASE_URL ??
  "http://127.0.0.1:4173";

export default defineConfig({
  testDir: "./tests/preview",
  testMatch: ["subscription-self-service.spec.ts"],
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/subscription-preview",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
