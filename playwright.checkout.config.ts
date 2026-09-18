import { defineConfig, devices } from "@playwright/test";

import { baseURL, bypassToken } from "./tests/preview/checkout/helpers/env.ts";

/**
 * Checkout E2E suite config.
 *
 * Separate from `playwright.config.ts` (admin-oms) so the two preview suites
 * run and report independently. Base URL + bypass header resolution is shared
 * via `tests/preview/checkout/helpers/env.ts`, which adds the
 * `CHECKOUT_PREVIEW_BASE_URL` first-precedence override on top of the existing
 * preview env chain. Runs serial (workers:1) across desktop, mobile, and tablet
 * viewports.
 */

export default defineConfig({
  testDir: "./tests/preview/checkout",
  testMatch: ["**/*.spec.ts"],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // No retries: a failed checkout test would re-mint orders and burn the preview's
  // per-IP checkout quota (10/hour). Genuine capacity blips (429/503) are handled
  // in-test by skipping, so a retry buys nothing and risks the quota.
  retries: 0,
  // `list` for humans; the second reporter is the fail-closed accounting for the
  // starter-offer skip (wave W4b) — it fails a run in which the acquisition offer
  // suppressed guarded checkout journeys, so a suite that proves nothing can no
  // longer report green. See tests/preview/checkout/helpers/starterOfferCoverage.ts.
  reporter: [["list"], ["./tests/preview/checkout/helpers/starterOfferCoverage.ts"]],
  outputDir: "test-results/checkout-preview",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: bypassToken ? { "x-vercel-protection-bypass": bypassToken } : {},
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "tablet-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 820, height: 1180 } },
    },
  ],
});
