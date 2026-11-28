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
    // Allow 60 s under parallel install-packages CPU contention on 4-vCPU runners
    // so V8 coverage runs do not starve exhaustive unit tests at 30 s.
    testTimeout: 60_000,
    hookTimeout: 60_000,
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
