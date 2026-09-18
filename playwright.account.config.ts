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
    // Required staging proof is isolated from the optional public a11y projects.
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
    // Wave 5's customer-diagnostic staging journey. It lives here rather than in a config
    // of its own because a new root `playwright.*.config.ts` is an unregistered root file
    // for `npm run oss:readiness -- --check`, and registering one would mean editing the
    // readiness scanner and its policy catalogue for a test lane.
    //
    // It reaches nothing else implicitly. The staging deploy invokes the two sonner
    // projects by name (`--project=sonner-chromium --project=sonner-webkit`) and
    // `smoke:account:preview:ui` passes an explicit `tests/preview/account/a11y.spec.ts`
    // file filter, which selects nothing under this project's own `testDir`. The runner
    // `scripts/staging-customer-diagnostic-journey.ts` selects it by `--project`.
    //
    // It keeps the shared `use` - the account suite's base URL chain and the
    // `x-vercel-protection-bypass` header an immutable candidate needs - and overrides only
    // the two things this journey owns: the candidate URL the runner already refused to
    // proceed without, and a longer per-test timeout for an ordered multi-route story.
    {
      name: "customer-diagnostic",
      testDir: "./tests/preview/customer-diagnostic",
      // The SUM of the eight legs' own bounded ceilings, not slack. Two of them drive the
      // whole shipped funnel - a refused checkout submit and a double card decline through
      // the Payment Element - and three rotate the diagnostic segment with a reload, which
      // the ingest's 20-per-minute per-segment admission cap makes mandatory rather than
      // optional. Every wait inside them is bounded, so the worst case IS this sum rather
      // than a hang; a healthy run finishes far below it.
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
