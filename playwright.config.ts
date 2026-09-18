import { defineConfig, devices } from "@playwright/test";

const rawBaseUrl =
  process.env.ADMIN_OMS_PREVIEW_SMOKE_BASE_URL ??
  process.env.HIDDEN_PREVIEW_HEALTH_BASE_URL ??
  process.env.ACCOUNTING_PREVIEW_SMOKE_BASE_URL ??
  "http://127.0.0.1:4173";

const bypassToken =
  process.env.ADMIN_OMS_PREVIEW_VERCEL_BYPASS_TOKEN ??
  process.env.HIDDEN_ROUTE_SMOKE_VERCEL_BYPASS_TOKEN ??
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: "./tests/preview",
  testMatch: ["admin-oms-preview.spec.ts"],
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  // Retry once in CI to absorb preview-environment flakiness; keep local runs
  // at zero so flakes stay visible during development.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "test-results/admin-oms-preview",
  use: {
    baseURL: origin(rawBaseUrl),
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
      name: "mobile-chromium-readonly",
      use: { ...devices["Pixel 5"] },
    },
  ],
});

function origin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}
