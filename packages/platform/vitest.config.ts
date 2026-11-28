import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/payments/**/*.ts", "src/subscriptions/**/*.ts"],
      reporter: ["text", "json-summary"],
      thresholds: {
        statements: 61,
        branches: 59,
        functions: 67,
        lines: 64,
      },
    },
  },
});
