import { defineConfig, devices } from "@playwright/test";

import { baseURL, bypassToken } from "./tests/preview/account/helpers/env.ts";

/**
 * Account + client-facing a11y suite config.
 *
 * Sibling to `playwright.checkout.config.ts` so the preview suites run and
 * report independently. Base URL + bypass header resolution is shared via
 * `tests/preview/account/helpers/env.ts`, which adds the
 * `ACCOUNT_PREVIEW_BASE_URL` first-precedence override on top of the shared
 * preview env chain. Runs serial (workers:1) across desktop, mobile, and tablet
 * viewports.
 */

export default defineConfig({
  testDir: "./tests/preview/account",
  testMatch: ["**/*.spec.ts"],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // These routes are read-only (no order mint / no quota burn), but keep retries
  // at 0 to match the checkout suite's determinism contract.
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/account-preview",
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
    // Retained staging projects; scripts/deploy-hidden-preview-sonner is absent
    // from the public tree. These targets establish no runnable public proof.
    // Never inherit the global bypass header or credential-bearing capture settings.
    {
      name: "sonner-chromium",
      testDir: "./scripts/deploy-hidden-preview-sonner",
      testMatch: "account-sonner.browser.ts",
      use: { ...devices["Desktop Chrome"], extraHTTPHeaders: {}, trace: "off", screenshot: "off", video: "off" },
    },
    {
      name: "sonner-webkit",
      testDir: "./scripts/deploy-hidden-preview-sonner",
      testMatch: "account-sonner.browser.ts",
      use: { ...devices["Desktop Safari"], extraHTTPHeaders: {}, trace: "off", screenshot: "off", video: "off" },
    },
    // The customer-diagnostic staging spec is shipped and selected here; its
    // former staging runner is absent. Running it needs explicit candidate and
    // prerequisite evidence. See CONTRIBUTING.md#test-scope-and-diagnostics.
    {
      name: "customer-diagnostic",
      testDir: "./tests/preview/customer-diagnostic",
      // Bounded deadline for the shipped ordered, multi-route staging journey.
      timeout: 600_000,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 1000 },
        baseURL: origin(process.env.CUSTOMER_DIAGNOSTIC_STAGING_URL ?? baseURL),
      },
    },
  ],
});

/** Reduce a supplied candidate URL to its origin; a malformed value is left for the runner to refuse. */
function origin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}
