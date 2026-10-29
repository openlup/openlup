import { defaultExclude, defineConfig } from "vitest/config";
import { defaultClientConditions, defaultServerConditions } from "vite";
import react from "@vitejs/plugin-react";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { env as processEnvironment } from "node:process";
import path from "path";
import { flatTestTimeoutMs, type DurationSections } from "./scripts/ci-vitest-duration-keys.ts";

// The wrapper pins only its own child; a nested invocation gets a new identity.
const disposableRunKey = Symbol.for("openlup.disposable.run");
process[disposableRunKey] ??= processEnvironment.OPENLUP_DISPOSABLE_RUN_FROM_WRAPPER ?? randomUUID();
processEnvironment.OPENLUP_DISPOSABLE_RUN = process[disposableRunKey];
delete processEnvironment.OPENLUP_DISPOSABLE_RUN_FROM_WRAPPER;

const isCoverageRun = process.argv.includes("--coverage");
const isCoverageShard = process.env.VITEST_COVERAGE_SHARD === "1";
const useSerialCoverage = isCoverageRun && process.env.VITEST_COVERAGE_SERIAL === "1";
const useCiCoverageWorkers = isCoverageRun && process.env.CI === "true" && !useSerialCoverage;
const useSummaryCoverageReporter = process.env.VITEST_COVERAGE_SUMMARY_ONLY === "1" || process.env.CI === "true";
const coverageReportsDirectory = process.env.VITEST_COVERAGE_DIR ?? "./coverage";
const buildOutDir = process.env.OPENLUP_BUILD_OUT_DIR ?? "dist";

// Optional external duration pins are read once in this main-process config
// and provided to src/test/setup.ts. Without OPENLUP_VITEST_DURATIONS_FILE,
// test/hook timeouts keep their flat defaults. The public tree supplies no
// duration updater or planner. See CONTRIBUTING.md#test-scope-and-diagnostics.
const repositoryRoot = process.cwd();
const durationManifestFile = process.env.OPENLUP_VITEST_DURATIONS_FILE;
const durationManifest: DurationSections = durationManifestFile
  ? (JSON.parse(readFileSync(durationManifestFile, "utf8")) as DurationSections)
  : { defaultDurationMs: 0, durationsMs: {} };

// Exact-path test exclusion. `OPENLUP_VITEST_EXCLUDE_FILE` names a file holding one
// repository-relative test path per line; every listed file is dropped from the
// run.
//
// Apply exclusions inside both projects: root CLI --exclude does not propagate
// to these projects. ci-test-scope.mjs supplies conservative exact-path selections;
// see CONTRIBUTING.md#extend-tooling-selection-conservatively.
// Refuse glob-only metacharacters (* ? { }); escape literal filename characters
// ([ ] ( ) ! + @ |), including dynamic-route names such as api/bff/[...path].test.ts.
// Malformed entries refuse instead of silently changing the selected scope.
const GLOB_ONLY_METACHARACTERS = /[*?{}]/;
const LITERAL_PATH_METACHARACTERS = /[[\]()!+@|]/g;

function readExactExclusions(): string[] {
  const source = process.env.OPENLUP_VITEST_EXCLUDE_FILE;
  if (!source) return [];
  const files = readFileSync(source, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const file of files) {
    if (file.startsWith("-") || file.startsWith("/") || file.includes("\\")
      || file.split("/").includes("..") || GLOB_ONLY_METACHARACTERS.test(file)
      || !/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) {
      throw new Error(`invalid exact Vitest exclusion: ${file}`);
    }
  }
  return files.map((file) => file.replace(LITERAL_PATH_METACHARACTERS, (character) => `\\${character}`));
}

const exactExclusions = readExactExclusions();

// Local runs default to 37.5% of cores, which is 6 of 16 on the measured host.
// That keeps overlapping runs on one shared machine and Docker engine
// responsive: against 75%, 6 workers halved host load for about 2% more
// whole-suite time and were faster when two runs overlapped (see
// docs/platform/plans/disposable-docker-test-resources.md). Vitest turns the
// percentage into a worker count from the available cores, with a minimum of
// one. Vitest reads VITEST_MAX_WORKERS as an integer worker count, so set it to
// a number like "4" to override per machine; scripts/run-vitest.mjs resolves a
// percentage in it to a count first. CI is intentionally left
// untouched so the dedicated coverage-shard worker counts below stay
// authoritative; see CONTRIBUTING.md#test-scope-and-diagnostics.
const localWorkerCap =
  process.env.VITEST_MAX_WORKERS ?? (process.env.CI === "true" ? undefined : "37.5%");

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: buildOutDir,
  },
  test: {
    // Environment routing lives in projects below. A Node-project test needing
    // DOM opts in with @vitest-environment jsdom; see the canonical testing guide.
    globals: true,
    globalSetup: ["./tests/setup/disposable-docker.ts"],
    // Only this config runs in the Vitest main process. Workers are forked with their
    // own argv (`[node, workers/forks.js]`), so a setup file cannot see `--coverage`
    // for itself — `src/test/setup.ts` reads this to widen the testing-library async
    // budget for the contended coverage lane.
    provide: { coverageRun: isCoverageRun, durationManifest, repositoryRoot },
    setupFiles: ["./tests/setup/scrub-git-env.ts", "./src/test/setup.ts"],
    // RR-L4: this is the FLOOR, not the ceiling. `src/test/setup.ts` runs once per
    // test file and raises it to `1.5 x` that file's pinned cost in
    // the duration manifest; a file the manifest does not weigh keeps
    // exactly these values. The constants moved to the module both readers share so
    // the floor a budget is computed against cannot drift from the one set here.
    testTimeout: flatTestTimeoutMs(isCoverageRun),
    hookTimeout: flatTestTimeoutMs(isCoverageRun),
    // Product-test failures are deterministic evidence and are never retried.
    // The public wrapper/workflow adds no automatic infrastructure retry.
    retry: 0,
    // Keep serial coverage available for explicit reproduction. CI uses two
    // workers so V8 coverage does not collapse into the very slow single-worker
    // path on hosted runners.
    fileParallelism: useSerialCoverage ? false : undefined,
    maxWorkers: useSerialCoverage ? 1 : useCiCoverageWorkers ? 2 : localWorkerCap,
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: [
            "api/**/*.{test,spec}.ts",
            "mcp/**/*.{test,spec}.ts",
            "scripts/**/*.{test,spec}.ts",
            "server/**/*.{test,spec}.ts",
            "packages/outbox/test/**/*.{test,spec}.ts",
            "packages/platform/test/**/*.{test,spec}.ts",
            // src logic tests; the dom project owns the excluded trees below.
            "src/**/*.{test,spec}.ts",
            // Golden-master harness (Platform Portability): deterministic dispatcher contract.
            // Narrow glob so Playwright specs under tests/preview/ stay out of vitest.
            "tests/golden-master/**/*.{test,spec}.ts",
            // W10: node-postgres RLS round-trip (docker-gated, self-skips when no daemon).
            "tests/postgres/**/*.{test,spec}.ts",
            "tests/platform/**/*.{test,spec}.ts",
            // Only checkout helper .test.ts files; adjacent Playwright .spec.ts
            // journeys retain their explicit browser runner.
            "tests/preview/checkout/helpers/**/*.test.ts",
          ],
          exclude: [
            ...exactExclusions,
            "**/node_modules/**",
            "src/components/**",
            "src/hooks/**",
            "src/test/**",
          ],
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: [
            "src/**/*.{test,spec}.tsx",
            "src/components/**/*.{test,spec}.ts",
            "src/hooks/**/*.{test,spec}.ts",
            "src/test/**/*.{test,spec}.ts",
            // Cross-boundary browser/application gates may exercise src and
            // injected server fakes without living inside either domain.
            "tests/stripe/**/*.{test,spec}.tsx",
          ],
          // Spelled out only so the exact exclusions above can be appended; the
          // rest is Vitest's own default, which this project used implicitly.
          exclude: [...defaultExclude, ...exactExclusions],
        },
      },
    ],
    coverage: {
      provider: "v8",
      reporter: isCoverageShard
        ? ["json"]
        : useSummaryCoverageReporter
        ? ["json-summary"]
        : ["text", "html", "json-summary"],
      processingConcurrency: useSerialCoverage ? 1 : undefined,
      reportsDirectory: coverageReportsDirectory,
      thresholds: isCoverageShard ? undefined : {
        statements: 80,
        branches: 65,
        functions: 75,
        lines: 80,
      },
      include: [
        "api/**/*.ts",
        "server/**/*.ts",
        "src/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/*.test.{ts,tsx}",
        "**/*.spec.{ts,tsx}",
        // Product coverage owns only api/server/src (the include list
        // above). V8 can still report imported files outside `include`, so keep
        // the non-product test/tooling roots explicitly out of the denominator.
        "mcp/**",
        "scripts/**",
        "tests/**",
        // The extracted package owns a stricter package-local coverage/no-zero gate.
        "packages/core/**",
        "src/test/**",
        // Pure transport declarations contain no executable behavior. Runtime
        // implementations and every Vercel adapter remain instrumented.
        "server/_lib/types/**",
        "src/vite-env.d.ts",
        "src/integrations/supabase/types.ts",
        "src/components/ui/**",
        // Dev-only visual harnesses (DEV-gated routes, never in prod bundles):
        // they render real components with fixtures for diffing, not coverage targets.
        "**/__harness__/**",
      ],
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    conditions: [...defaultClientConditions],
  },
  ssr: {
    noExternal: ["@openlup/core"],
    resolve: {
      conditions: [...defaultServerConditions],
    },
  },
});
