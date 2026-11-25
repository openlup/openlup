import { defineConfig } from "vitest/config";
import { defaultClientConditions, defaultServerConditions } from "vite";

export default defineConfig({
  resolve: {
    conditions: ["core-source", ...defaultClientConditions],
  },
  ssr: {
    noExternal: ["@openlup/core"],
    resolve: {
      conditions: ["core-source", ...defaultServerConditions],
    },
  },
  test: {
    environment: "node",
    include: ["smoke/**/*.test.ts", "test/**/*.test.ts"],
    // Match root vitest.config.ts hosted CI floor (30 s) so coverage runs on 4-vCPU runners
    // do not starve exhaustive unit tests at Vitest's 5 s default.
    testTimeout: process.env.CI === "true" ? 30_000 : 10_000,
    hookTimeout: process.env.CI === "true" ? 30_000 : 10_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 80,
        branches: 65,
        functions: 75,
        lines: 80,
      },
    },
  },
});
