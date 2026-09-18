import { defineConfig, devices } from "@playwright/test";

// The artifact this run hydrates; `tests/preview/ssg-hydration.spec.ts` reads the
// same variable for the documents it fulfills. `vite.config.ts` derives
// `build.outDir` from `OPENLUP_BUILD_OUT_DIR`, and `vite preview` serves that same
// `build.outDir` — so forwarding it is what keeps the served chunks and the read
// documents from ever coming out of two different builds.
const distDir = process.env.OPENLUP_SSG_DIST ?? "dist";

export default defineConfig({
  testDir: "./tests/preview",
  testMatch: ["ssg-hydration.spec.ts"],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  outputDir: "test-results/ssg-hydration",
  use: {
    baseURL: "http://127.0.0.1:4188",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npm exec -- vite preview --host 127.0.0.1 --port 4188 --strictPort",
    url: "http://127.0.0.1:4188",
    reuseExistingServer: false,
    timeout: 30_000,
    env: { OPENLUP_BUILD_OUT_DIR: distDir },
  },
  projects: [
    {
      name: "desktop-chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } },
    },
  ],
});
