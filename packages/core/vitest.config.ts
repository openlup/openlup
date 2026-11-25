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
    // Match root vitest.config.ts coverage floor (30 s) without an environment read
    // so V8 coverage runs on 4-vCPU runners do not starve exhaustive unit tests at 5 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
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
