import { defineConfig, devices } from "@playwright/test";

/**
 * Subscription self-service E2E suite config.
 *
 * Separate from the admin-oms (`playwright.config.ts`) and checkout
 * (`playwright.checkout.config.ts`) suites so it runs and reports independently.
 * The spec is fully env-gated and skips when the hidden-preview base URL +
 * customer token + Supabase service creds are absent, so this config is safe to
 * register everywhere. Base URL falls back to the shared preview env chain.
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
