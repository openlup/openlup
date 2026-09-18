import { defineConfig, devices } from "@playwright/test";

const rawBaseUrl =
  process.env.PROMOTION_ROLLOUT_SMOKE_BASE_URL ??
  process.env.ADMIN_OMS_PREVIEW_SMOKE_BASE_URL ??
  "http://127.0.0.1:4173";

const bypassToken =
  process.env.ADMIN_OMS_PREVIEW_VERCEL_BYPASS_TOKEN ??
  process.env.HIDDEN_ROUTE_SMOKE_VERCEL_BYPASS_TOKEN ??
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: "./tests/preview",
  testMatch: ["promotion-code-center-preview.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  outputDir: "test-results/promotion-code-center-preview",
  use: {
    baseURL: origin(rawBaseUrl),
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    extraHTTPHeaders: bypassToken ? { "x-vercel-protection-bypass": bypassToken } : {},
  },
  projects: [{
    name: "desktop-chromium",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
  }],
});

function origin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}
