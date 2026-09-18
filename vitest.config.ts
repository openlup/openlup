import { defaultExclude, defineConfig } from "vitest/config";
import { defaultClientConditions, defaultServerConditions } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import path from "path";
import { flatTestTimeoutMs, type DurationSections } from "./scripts/ci-vitest-duration-keys.ts";

const isCoverageRun = process.argv.includes("--coverage");
const isCoverageShard = process.env.VITEST_COVERAGE_SHARD === "1";
const useSerialCoverage = isCoverageRun && process.env.VITEST_COVERAGE_SERIAL === "1";
const useCiCoverageWorkers = isCoverageRun && process.env.CI === "true" && !useSerialCoverage;
const useSummaryCoverageReporter = process.env.VITEST_COVERAGE_SUMMARY_ONLY === "1" || process.env.CI === "true";
const coverageReportsDirectory = process.env.VITEST_COVERAGE_DIR ?? "./coverage";
const buildOutDir = process.env.OPENLUP_BUILD_OUT_DIR ?? "dist";

// RR-L4: the per-file timeout budget's weights, read ONCE here in the main process
// and handed to workers through `provide`.
//
// Two constraints shape this. A setup file cannot read the manifest itself: under
// the coverage lane its `import.meta.url` is not a file: URL, so a filesystem read
// from there throws for every test file in the run. And this config file is a
// RETAINED (published) source while `config/ci-vitest-durations.json` is a
// WITHHELD one, so naming that path here would put a read of a file the published
// tree does not have into the published tree - `oss-split-rehearsal` refuses it,
// and it is right to.
//
// So the path arrives the same way `OPENLUP_VITEST_EXCLUDE_FILE` does, from a caller
// that is allowed to know it. With no variable set - a published tree, or a bare
// `npx vitest` - there are no weights and every file keeps the flat ceiling, which
// is exactly the behaviour before budgets existed.
const repositoryRoot = process.cwd();
const durationManifestFile = process.env.OPENLUP_VITEST_DURATIONS_FILE;
const durationManifest: DurationSections = durationManifestFile
  ? (JSON.parse(readFileSync(durationManifestFile, "utf8")) as DurationSections)
  : { defaultDurationMs: 0, durationsMs: {} };

// Exact-path test exclusion. `OPENLUP_VITEST_EXCLUDE_FILE` names a file holding one
// repository-relative test path per line; every listed file is dropped from the
// run.
//
// ⛔ THIS IS THE ONLY LEVEL THAT WORKS. Vitest 4 copies a closed allow-list of
// CLI options into each entry of `projects` (`resolveProjects` in vitest's
// cli-api chunk: logHeapUsage, allowOnly, sequence, testTimeout, pool, globals,
// retry, bail, isolate, fileParallelism and ten more). `exclude` is not on that
// list, so a root-level `--exclude` never reaches any project and is silently
// dropped. Measured on this tree, not inferred: an otherwise identical config
// WITHOUT `projects` takes `vitest list server/domains/catalog --exclude <one
// file>` from 8 files to 7; WITH `projects` it stays at 8. `scripts/run-vitest.mjs`
// pushed that flag for years and every caller believed it was skipping files.
//
// An unusable entry throws here rather than being ignored, so a run that cannot
// honour the exclusion fails loudly instead of quietly running the file.
//
// Metacharacters are split into two classes, because an exclusion entry is a
// literal path and this repository really does ship test files whose names are
// dynamic route segments: `api/bff/[...path].test.ts`, `api/c/[slug].test.ts`,
// `server/bff/catalog/products/[slug].test.ts` and two more.
//
//   REFUSED: `*`, `?`, `{`, `}` - these mean "this caller sent a glob". No file
//   in this tree is named with them, so a loud refusal stays the honest answer
//   and `scripts/vitest-exclusion-contract.test.ts` still pins it.
//
//   ESCAPED: `[ ] ( ) ! + @ |` - these do occur in real filenames here. Measured
//   on this tree, not inferred: `exclude` reaches tinyglobby's `ignore` (and
//   `picomatch.isMatch` for the runtime file check), where an UNESCAPED
//   `api/bff/[...path].test.ts` is a bracket expression that excludes NOTHING -
//   `globSync(["api/**/*.{test,spec}.ts"], { ignore: [thatPath] })` still
//   returns 97 files, while the escaped form returns 96 and drops exactly that
//   one file. Rejecting them instead, as this function used to, made those five
//   paths permanently unexcludable, which the exact coverage-shard selection in
//   `scripts/ci-vitest-runner.ts` needs. Escaping is a no-op for every path
//   without them, so existing callers are unaffected.
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

// Local runs default to 75% of cores so a test run never saturates the machine
// and leaves it unresponsive. The percentage is vitest-native and auto-scales:
// it floors at one worker on tiny machines and only meaningfully caps 8+ core
// boxes. Set VITEST_MAX_WORKERS (an integer like "4" or a percentage like
// "100%") to override per machine. CI is intentionally left untouched so the
// dedicated coverage-shard worker counts below stay authoritative. Local V8
// coverage is more CPU/I/O contention-sensitive than plain Vitest, so it uses a
// lower default cap that matches the weak-machine guidance in docs/TESTING.md.
const localWorkerCap =
  process.env.VITEST_MAX_WORKERS ??
  (process.env.CI === "true" ? undefined : isCoverageRun ? "50%" : "75%");

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: buildOutDir,
  },
  test: {
    // Verify W1: environment routing lives in `projects` below —
    // `environmentMatchGlobs` was removed in Vitest 4 and had become silently
    // ignored config, so every test (including server/scripts) ran in jsdom.
    // jsdom accounted for ~48% of coverage CPU while only ~90 of 441 src
    // .test.ts files touch the DOM. The two projects are disjoint: a .test.ts
    // that needs a DOM opts back in with a @vitest-environment jsdom pragma.
    globals: true,
    // Only this config runs in the Vitest main process. Workers are forked with their
    // own argv (`[node, workers/forks.js]`), so a setup file cannot see `--coverage`
    // for itself — `src/test/setup.ts` reads this to widen the testing-library async
    // budget for the contended coverage lane.
    provide: { coverageRun: isCoverageRun, durationManifest, repositoryRoot },
    setupFiles: ["./tests/setup/scrub-git-env.ts", "./src/test/setup.ts"],
    // RR-L4: this is the FLOOR, not the ceiling. `src/test/setup.ts` runs once per
    // test file and raises it to `1.5 x` that file's pinned cost in
    // `config/ci-vitest-durations.json`; a file the manifest does not weigh keeps
    // exactly these values. The constants moved to the module both readers share so
    // the floor a budget is computed against cannot drift from the one set here.
    testTimeout: flatTestTimeoutMs(isCoverageRun),
    hookTimeout: flatTestTimeoutMs(isCoverageRun),
    // Product-test failures are deterministic evidence and are never retried.
    // Infrastructure retries belong to the CI wrapper after explicit classification.
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
            // src logic tests; the dom project owns the excluded trees below.
            "src/**/*.{test,spec}.ts",
            // Golden-master harness (Platform Portability): deterministic dispatcher contract.
            // Narrow glob so Playwright specs under tests/preview/ stay out of vitest.
            "tests/golden-master/**/*.{test,spec}.ts",
            // W10: node-postgres RLS round-trip (docker-gated, self-skips when no daemon).
            "tests/postgres/**/*.{test,spec}.ts",
            "tests/platform/**/*.{test,spec}.ts",
            // Checkout preview FIXTURES only, and only `.test.ts`: the mailbox
            // generator is real logic (it decides what the fail-closed checkout
            // limiter counts) and needs a credential-free unit lane. Playwright's
            // own `testMatch: ["**/*.spec.ts"]` keeps the browser specs beside it
            // out of vitest, exactly as the two globs above intend.
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
        // Product coverage owns only api/server/src/supabase (the include list
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
        // pet-personalizer: feature module, tests planned as follow-up wave.
        // Exclude from threshold to unblock first ship.
        "src/pages/pet-personalizer/**",
        "src/components/pet-personalizer/**",
        "src/lib/pet-personalizer/**",
        "src/types/pet-personalizer.ts",
      ],
    },
  },
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
    // WITH `deployment-overlay`, deliberately. This checkout IS a deployment, and its
    // test tree is non-hosted openlup tooling, so it must resolve the owners that
    // `dev` and `build:*` resolve. A test tree that read the neutral example while the
    // build read the overlay would be exercising code that never ships.
    //
    // W6a first set this, `scripts/oss-core-scaffold.test.ts` refused it, and W6a removed
    // it in finalization - so its "deliberately WITHOUT" was a response to that pin, not
    // an independent ruling. The owner's option-A ruling settled it the other way and
    // authorized moving exactly that one expectation; the pin now states the condition is
    // a contract member and says why.
    //
    // It CANNOT be carried at the command level the way `dev`/`build:*` carry it: those
    // pass `--conditions` to a NATIVE config load, which is what lets `#email-presentation`
    // resolve and propagate through `emailPresentation.resolverConditions` in
    // `vite.config.ts`. Vitest resolves `#` specifiers through Vite's resolver off THIS
    // array, so `NODE_OPTIONS=--conditions=...` is inert for it - measured, not assumed.
    //
    // Publication is unaffected: the projected manifest carries no condition at all, so
    // this array cannot select an overlay in a published checkout.
    conditions: ["core-source", "deployment-overlay", ...defaultClientConditions],
  },
  ssr: {
    noExternal: ["@openlup/core"],
    resolve: {
      conditions: ["core-source", "deployment-overlay", ...defaultServerConditions],
    },
  },
});
