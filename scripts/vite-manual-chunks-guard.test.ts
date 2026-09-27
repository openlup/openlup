import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig } from "vite";

/**
 * Regression guard for the account "blank spinner" stall (CJ01-AD / CJ-47…67).
 *
 * The stall was an init-order race caused by a hand-rolled `manualChunks(id)` in
 * vite.config.ts that split React into `vendor-react` while its dependents
 * (react-router, @tanstack/react-query) went into `vendor-data`/`vendor-ui`. That made
 * `vendor-react` import from `vendor-data`, so on a lazy in-account route transition the
 * chunks could execute out of order and throw `Cannot read properties of undefined
 * (reading 'default')` inside vendor-data, leaving the SPA stuck on a spinner.
 *
 * Rollup's automatic chunking orders shared dependencies correctly, so we removed the
 * manual split. If manual chunking is ever re-introduced it MUST NOT let one manual chunk
 * import another (esp. never split React from react-router / @tanstack). This guard fails
 * on any bare `manualChunks` so that re-introduction is a deliberate, reviewed decision.
 */
describe("vite manualChunks init-order guard", () => {
  it("keeps vite.config.ts free of a hand-rolled manualChunks vendor split", () => {
    const source = readFileSync(join(process.cwd(), "vite.config.ts"), "utf8");
    // Strip line comments so the explanatory comment mentioning manualChunks doesn't trip it.
    const code = source.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(
      /manualChunks/.test(code),
      "vite.config.ts reintroduced manualChunks. This caused the account blank-spinner init-order " +
        "race (see this guard's header). If you must chunk manually, ensure no manual chunk imports " +
        "another (never split React from react-router/@tanstack), then update this guard.",
    ).toBe(false);
  });

  it("keeps client dependency discovery enabled when LOCAL_BFF serves the lazy BFF", async () => {
    vi.stubEnv("LOCAL_BFF", "1");
    try {
      const config = await resolveConfig({ configFile: join(process.cwd(), "vite.config.ts") }, "serve");
      expect(config.optimizeDeps.noDiscovery).toBe(false);
      expect(config.optimizeDeps.entries).toEqual(["index.html"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
