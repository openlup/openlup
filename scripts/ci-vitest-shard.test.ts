import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env as processEnvironment } from "node:process";
import { describe, expect, it } from "vitest";
import { digestKeyForPath } from "./ci-vitest-duration-keys.ts";
import {
  DEFAULT_POSTGRES_DURATION_MS,
  DEFAULT_QUARANTINE_PATH,
  DEFAULT_WEIGHTS_PATH,
  SHARD_PLAN_SCHEMA_VERSION,
  buildQuarantineRetryArgs,
  buildShardCommand,
  buildShardExecutionPlan,
  buildShardPlan,
  digestFileContents,
  fallbackDurationMs,
  formatQuarantineBanner,
  listVitestFiles,
  loadShardPlan,
  loadShardWeights,
  parseShardArgs,
  partitionShards,
  resolveExcludeDigest,
  runShardInvocations,
  writeShardPlan,
} from "./ci-vitest-shard.mjs";
import {
  MAX_FLAKY_RETRY_FILES,
  argsForFiles,
  decideFileRetry,
  jsonReportArgs,
  readFailedFiles,
  readReportFiles,
  readRunErrors,
  settleFileRetry,
} from "./ci-vitest-shard.mjs";
import RunErrorsReporter, { RUN_ERRORS_REPORT_ENV } from "./ci-vitest-run-errors-reporter.mjs";

describe("ci-vitest-shard", () => {
  it("parses valid CLI arguments and refuses malformed invocations", () => {
    expect(parseShardArgs(["--shard", "4", "--total", "8"])).toEqual({
      shard: 4,
      total: 8,
      weightsPath: DEFAULT_WEIGHTS_PATH,
      quarantinePath: DEFAULT_QUARANTINE_PATH,
      planPath: null,
      planOutPath: null,
      printFiles: false,
      skipPretest: false,
      extraArgs: [],
    });
    expect(parseShardArgs([
      "--shard=2",
      "--total=8",
      "--weights=custom.json",
      "--quarantine=custom-q.json",
      "--plan=plan.json",
      "--print-files",
      "--skip-pretest",
      "--",
      "--reporter=dot",
    ])).toEqual({
      shard: 2,
      total: 8,
      weightsPath: "custom.json",
      quarantinePath: "custom-q.json",
      planPath: "plan.json",
      planOutPath: null,
      printFiles: true,
      skipPretest: true,
      extraArgs: ["--reporter=dot"],
    });
    expect(parseShardArgs(["--total", "8", "--plan-out", ".context/scratch/plan.json"])).toEqual({
      shard: undefined,
      total: 8,
      weightsPath: DEFAULT_WEIGHTS_PATH,
      quarantinePath: DEFAULT_QUARANTINE_PATH,
      planPath: null,
      planOutPath: ".context/scratch/plan.json",
      printFiles: false,
      skipPretest: false,
      extraArgs: [],
    });
    expect(() => parseShardArgs([])).toThrow(/Usage:/);
    expect(() => parseShardArgs(["--shard", "0", "--total", "8"])).toThrow(/between 1 and 8/);
    expect(() => parseShardArgs(["--shard", "9", "--total", "8"])).toThrow(/between 1 and 8/);
    expect(() => parseShardArgs(["--shard", "1", "--total", "0"])).toThrow(/Usage:/);
    expect(() => parseShardArgs(["--shard", "1", "--total", "8", "--quarantine="])).toThrow(/--quarantine/);
    expect(() => parseShardArgs(["--shard", "1", "--total", "8", "--plan="])).toThrow(/--plan requires/);
    expect(() => parseShardArgs(["--total", "8", "--plan-out="])).toThrow(/--plan-out requires/);
    expect(() => parseShardArgs(["--shard", "1", "--total", "8", "--plan", "a.json", "--plan-out", "b.json"])).toThrow(/mutually exclusive/);
    expect(() => parseShardArgs(["--shard", "1", "--total", "8", "--plan-out", "b.json"])).toThrow(/cannot be combined with --shard/);
    expect(() => parseShardArgs(["--total", "8", "--plan-out", "b.json", "--skip-pretest"])).toThrow(/cannot be combined/);
    expect(() => parseShardArgs(["--shard", "1", "--total", "8", "--unknown"])).toThrow(/Unknown option/);
  });

  it("spawns npm test by default and direct run-vitest.mjs when --skip-pretest is set", () => {
    expect(buildShardCommand(["a.test.ts", "b.test.ts"], { platform: "linux", execPath: "/usr/bin/node" })).toEqual({
      command: "npm",
      args: ["test", "--", "a.test.ts", "b.test.ts"],
    });
    expect(buildShardCommand(["a.test.ts"], { skipPretest: true, extraArgs: ["--reporter=dot"], platform: "linux", execPath: "/usr/bin/node" })).toEqual({
      command: "/usr/bin/node",
      args: ["scripts/run-vitest.mjs", "run", "a.test.ts", "--reporter=dot"],
    });
  });

  it("partitions deterministically with LPT, lexicographical tie-breaking, and digest key lookup", () => {
    const manifest = {
      defaultDurationMs: 100,
      durationsMs: {
        "a.test.ts": 1000,
        [digestKeyForPath("b.test.ts")]: 900,
        "c.test.ts": 500,
        "d.test.ts": 500,
      },
    };
    const forward = partitionShards(["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts"], 2, manifest);
    const reversed = partitionShards(["e.test.ts", "d.test.ts", "c.test.ts", "b.test.ts", "a.test.ts"], 2, manifest);
    expect(forward).toEqual(reversed);
    expect(forward[0]).toEqual({
      shard: 1,
      estimatedDurationMs: 1500,
      files: ["a.test.ts", "d.test.ts"],
    });
    expect(forward[1]).toEqual({
      shard: 2,
      estimatedDurationMs: 1500,
      files: ["b.test.ts", "c.test.ts", "e.test.ts"],
    });
  });

  it("assigns the PostgreSQL fallback weight to unpinned tests/postgres files across shards", () => {
    expect(fallbackDurationMs("tests/postgres/newSuite.test.ts", 11)).toBe(DEFAULT_POSTGRES_DURATION_MS);
    expect(fallbackDurationMs("tests/postgres/newSuite.test.ts", 60_000)).toBe(60_000);
    expect(fallbackDurationMs("src/newUnit.test.ts", 11)).toBe(11);

    const manifest = { defaultDurationMs: 11, durationsMs: {} };
    const shards = partitionShards(
      ["tests/postgres/unpinnedA.test.ts", "tests/postgres/unpinnedB.test.ts", "src/fast.test.ts"],
      2,
      manifest,
    );
    expect(shards[0]!.files).toEqual(["src/fast.test.ts", "tests/postgres/unpinnedA.test.ts"]);
    expect(shards[0]!.estimatedDurationMs).toBe(DEFAULT_POSTGRES_DURATION_MS + 11);
    expect(shards[1]!.files).toEqual(["tests/postgres/unpinnedB.test.ts"]);
    expect(shards[1]!.estimatedDurationMs).toBe(DEFAULT_POSTGRES_DURATION_MS);
  });

  it("keeps config/vitest-shard-weights.json sorted with positive weights", () => {
    const manifest = loadShardWeights(DEFAULT_WEIGHTS_PATH);
    expect(manifest.defaultDurationMs).toBeGreaterThan(0);
    const keys = Object.keys(manifest.durationsMs);
    expect(keys.length).toBeGreaterThan(100);
    const sortedKeys = [...keys].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    expect(keys).toEqual(sortedKeys);
    for (const value of Object.values(manifest.durationsMs)) {
      expect(typeof value).toBe("number");
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });

  it("covers 100% of real repository test files across 8 shards with zero missing/duplicates and <= 1.15x imbalance", () => {
    const manifest = loadShardWeights(DEFAULT_WEIGHTS_PATH);
    const files = listVitestFiles();
    expect(files.length).toBeGreaterThan(2000);

    const shards = partitionShards(files, 8, manifest);
    expect(shards).toHaveLength(8);

    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const shard of shards) {
      expect(shard.files.length).toBeGreaterThan(0);
      for (const file of shard.files) {
        if (seen.has(file)) duplicates.push(file);
        seen.add(file);
      }
    }
    const missing = files.filter((file) => !seen.has(file));
    expect(duplicates).toEqual([]);
    expect(missing).toEqual([]);
    expect(seen.size).toBe(files.length);

    const weights = shards.map((shard) => shard.estimatedDurationMs);
    const ratio = Math.max(...weights) / Math.min(...weights);
    expect(ratio).toBeLessThanOrEqual(1.15);
  }, 30_000);

  it("respects OPENLUP_VITEST_EXCLUDE_FILE when listing files", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ci-vitest-shard-"));
    try {
      const excludedFile = "scripts/ci-vitest-duration-keys.test.ts";
      const excludeList = join(tempDir, "exclude.txt");
      writeFileSync(excludeList, `${excludedFile}\n`, "utf8");
      const files = listVitestFiles(process.cwd(), {
        ...processEnvironment,
        OPENLUP_VITEST_EXCLUDE_FILE: excludeList,
      });
      expect(files).not.toContain(excludedFile);
      expect(files).toContain("scripts/ci-vitest-shard.test.ts");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("rejects malformed weight manifests", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ci-vitest-shard-bad-"));
    try {
      const badPath = join(tempDir, "bad.json");
      writeFileSync(badPath, JSON.stringify({ defaultDurationMs: 0, durationsMs: {} }), "utf8");
      expect(() => loadShardWeights(badPath, tempDir)).toThrow(/defaultDurationMs/);
      // Confirm real manifest parses cleanly as JSON text too.
      expect(JSON.parse(readFileSync(DEFAULT_WEIGHTS_PATH, "utf8")).schemaVersion).toBe(1);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps a single Vitest invocation when quarantine entries are empty (INV-1)", () => {
    const emptyManifest = { version: 1, maxDurationDays: 7, entries: [] };
    const plan = buildShardExecutionPlan(["a.test.ts", "b.test.ts"], emptyManifest, {
      skipPretest: true,
      extraArgs: ["--reporter=dot"],
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    expect(plan.quarantinedEntries).toEqual([]);
    expect(plan.invocations).toEqual([
      {
        kind: "normal",
        files: ["a.test.ts", "b.test.ts"],
        command: "/usr/bin/node",
        args: ["scripts/run-vitest.mjs", "run", "a.test.ts", "b.test.ts", "--reporter=dot"],
      },
    ]);
  });

  it("splits active quarantined files into a second pass with --retry=2 and banner metadata", () => {
    const manifest = {
      version: 1,
      maxDurationDays: 7,
      entries: [
        {
          testPath: "b.test.ts",
          owner: "platform-ci",
          reason: "Socket race",
          trackingRef: "#404",
          addedAt: "2026-11-20T00:00:00Z",
          expiresAt: "2026-11-26T00:00:00Z",
        },
      ],
    };

    const plan = buildShardExecutionPlan(["a.test.ts", "b.test.ts", "c.test.ts"], manifest, {
      skipPretest: true,
      extraArgs: ["--reporter=dot"],
      platform: "linux",
      execPath: "/usr/bin/node",
    });
    expect(plan.quarantinedEntries).toHaveLength(1);
    expect(plan.invocations).toEqual([
      {
        kind: "normal",
        files: ["a.test.ts", "c.test.ts"],
        command: "/usr/bin/node",
        args: ["scripts/run-vitest.mjs", "run", "a.test.ts", "c.test.ts", "--reporter=dot"],
      },
      {
        kind: "quarantined",
        files: ["b.test.ts"],
        command: "/usr/bin/node",
        args: ["scripts/run-vitest.mjs", "run", "b.test.ts", "--reporter=dot", "--retry=2"],
      },
    ]);

    expect(buildQuarantineRetryArgs(["--retry=5"])).toEqual(["--retry=5"]);
    expect(buildQuarantineRetryArgs(["--retry", "3"])).toEqual(["--retry", "3"]);
    expect(buildQuarantineRetryArgs(["--reporter=dot"])).toEqual(["--reporter=dot", "--retry=2"]);

    const banner = formatQuarantineBanner(plan.quarantinedEntries);
    expect(banner).toContain("[ci-quarantine]");
    expect(banner).toContain("b.test.ts");
    expect(banner).toContain("platform-ci");
    expect(banner).toContain("#404");
    expect(banner).toContain("2026-11-26T00:00:00Z");

    const calls: string[][] = [];
    const passBoth = runShardInvocations(plan.invocations, {
      spawnImpl: (_cmd, args) => {
        calls.push(args);
        return { status: 0 };
      },
    });
    expect(passBoth).toBe(0);
    expect(calls).toHaveLength(2);

    const failNormal = runShardInvocations(plan.invocations, {
      spawnImpl: (_cmd, args) => ({ status: args.includes("--retry=2") ? 0 : 1 }),
    });
    expect(failNormal).toBe(1);

    const failQuarantined = runShardInvocations(plan.invocations, {
      spawnImpl: (_cmd, args) => ({ status: args.includes("--retry=2") ? 2 : 0 }),
    });
    expect(failQuarantined).toBe(2);
  });

  it("writes, verifies, and fails closed on stale or tampered precomputed shard plans", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ci-vitest-shard-plan-"));
    try {
      const weightsPath = join(tempDir, "weights.json");
      const excludePath = join(tempDir, "exclude.txt");
      const planPath = join(tempDir, "nested", "plan.json");
      const manifest = { defaultDurationMs: 100, durationsMs: { "a.test.ts": 1000, "b.test.ts": 500 } };
      writeFileSync(weightsPath, `${JSON.stringify(manifest)}\n`, "utf8");
      writeFileSync(excludePath, "ignored.test.ts\n", "utf8");

      const env = { OPENLUP_VITEST_EXCLUDE_FILE: excludePath };
      const weightsDigest = digestFileContents(weightsPath);
      const excludeDigest = resolveExcludeDigest(env, tempDir);
      expect(resolveExcludeDigest({}, tempDir)).toBe("none");

      expect(() => buildShardPlan([], 2, manifest, { weightsDigest, excludeDigest })).toThrow(/at least one test file/);
      const plan = buildShardPlan(["a.test.ts", "b.test.ts", "c.test.ts"], 2, manifest, { weightsDigest, excludeDigest });
      expect(plan.schemaVersion).toBe(SHARD_PLAN_SCHEMA_VERSION);
      writeShardPlan(planPath, plan, tempDir);

      const loaded = loadShardPlan(planPath, 2, { rootDir: tempDir, weightsPath, env });
      expect(loaded).toEqual(partitionShards(["a.test.ts", "b.test.ts", "c.test.ts"], 2, manifest));

      // Stale shard count, weights digest, or exclude digest must fail closed.
      expect(() => loadShardPlan(planPath, 3, { rootDir: tempDir, weightsPath, env })).toThrow(/built for 2 shards/);
      expect(() => loadShardPlan(planPath, 2, { rootDir: tempDir, weightsPath, env: {} })).toThrow(/excludeDigest/);

      writeFileSync(excludePath, "changed.test.ts\n", "utf8");
      expect(() => loadShardPlan(planPath, 2, { rootDir: tempDir, weightsPath, env })).toThrow(/excludeDigest/);
      writeFileSync(excludePath, "ignored.test.ts\n", "utf8");

      writeFileSync(weightsPath, `${JSON.stringify({ ...manifest, defaultDurationMs: 200 })}\n`, "utf8");
      expect(() => loadShardPlan(planPath, 2, { rootDir: tempDir, weightsPath, env })).toThrow(/weightsDigest/);
      writeFileSync(weightsPath, `${JSON.stringify(manifest)}\n`, "utf8");

      // Structural tampering: bad schemaVersion, duplicate files, path escape, non-canonical path, empty plan.
      const writeTampered = (patch: Record<string, unknown>) => {
        const bad = join(tempDir, "tampered.json");
        writeFileSync(bad, JSON.stringify({ ...plan, ...patch }), "utf8");
        return bad;
      };
      expect(() => loadShardPlan(writeTampered({ schemaVersion: 99 }), 2, { rootDir: tempDir, weightsPath, env })).toThrow(/schemaVersion/);
      expect(() => loadShardPlan(writeTampered({
        shards: [
          { shard: 1, estimatedDurationMs: 1000, files: ["a.test.ts"] },
          { shard: 2, estimatedDurationMs: 1000, files: ["a.test.ts"] },
        ],
      }), 2, { rootDir: tempDir, weightsPath, env })).toThrow(/duplicate test path/);
      expect(() => loadShardPlan(writeTampered({
        shards: [
          { shard: 1, estimatedDurationMs: 1000, files: ["../outside.test.ts"] },
          { shard: 2, estimatedDurationMs: 100, files: ["b.test.ts"] },
        ],
      }), 2, { rootDir: tempDir, weightsPath, env })).toThrow(/escapes repository root/);
      expect(() => loadShardPlan(writeTampered({
        shards: [
          { shard: 1, estimatedDurationMs: 1000, files: ["./a.test.ts"] },
          { shard: 2, estimatedDurationMs: 100, files: ["b.test.ts"] },
        ],
      }), 2, { rootDir: tempDir, weightsPath, env })).toThrow(/non-canonical test path/);
      expect(() => loadShardPlan(writeTampered({
        shards: [
          { shard: 1, estimatedDurationMs: 0, files: [] },
          { shard: 2, estimatedDurationMs: 0, files: [] },
        ],
      }), 2, { rootDir: tempDir, weightsPath, env })).toThrow(/0 test files/);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("consumes a precomputed --plan in CLI mode without invoking vitest list", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ci-vitest-shard-cli-"));
    try {
      const planPath = join(tempDir, "plan.json");
      const manifest = loadShardWeights(DEFAULT_WEIGHTS_PATH);
      const weightsDigest = digestFileContents(DEFAULT_WEIGHTS_PATH);
      const plan = buildShardPlan(
        ["scripts/ci-vitest-shard.test.ts", "scripts/ci-vitest-duration-keys.test.ts"],
        2,
        manifest,
        { weightsDigest, excludeDigest: "none" },
      );
      writeShardPlan(planPath, plan);

      // Run with an empty PATH so any accidental npx/vitest list invocation would fail immediately.
      const result = spawnSync(
        process.execPath,
        ["scripts/ci-vitest-shard.mjs", "--shard", "1", "--total", "2", "--plan", planPath, "--print-files"],
        { cwd: process.cwd(), encoding: "utf8", env: { PATH: "" } },
      );
      expect(result.status).toBe(0);
      expect(result.stdout.trim().split("\n")).toEqual(plan.shards[0]!.files);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe("ci-vitest-shard single file retry", () => {
  const clean = { unhandledErrors: 0, reason: "failed" };

  it("retries only between one and ten failed files", () => {
    expect(decideFileRetry(["a.test.ts"], { runErrors: clean })).toEqual({ retry: true, files: ["a.test.ts"], reason: null });
    const ten = Array.from({ length: MAX_FLAKY_RETRY_FILES }, (_, index) => `f${index}.test.ts`);
    expect(decideFileRetry(ten, { runErrors: clean }).retry).toBe(true);
    expect(decideFileRetry([...ten, "extra.test.ts"], { runErrors: clean })).toMatchObject({ retry: false, files: [] });
    expect(decideFileRetry(null, { runErrors: clean })).toMatchObject({ retry: false, reason: "no readable test report" });
  });

  it("never retries away an error no test file accounts for", () => {
    expect(decideFileRetry(["a.test.ts"], { runErrors: { unhandledErrors: 1, reason: "failed" } }))
      .toEqual({ retry: false, files: [], reason: "1 error(s) not tied to a test file" });
    expect(decideFileRetry(["a.test.ts"], { runErrors: { unhandledErrors: 0, reason: "interrupted" } }))
      .toMatchObject({ retry: false, reason: "the run was interrupted" });
    expect(decideFileRetry(["a.test.ts"], { runErrors: null }))
      .toMatchObject({ retry: false, reason: "no readable run-error report" });
    expect(decideFileRetry(["a.test.ts"])).toMatchObject({ retry: false, reason: "no readable run-error report" });
    expect(decideFileRetry([], { runErrors: clean }))
      .toMatchObject({ retry: false, reason: "non-zero exit with no failed test file" });
  });

  it("passes after the retry only on a clean exit with no failed file or unattributed error, listing every retried file as flaky", () => {
    const passed = { unhandledErrors: 0, reason: "passed" };
    expect(settleFileRetry(["a.test.ts", "b.test.ts"], { status: 0, failedFiles: [], passedFiles: ["a.test.ts", "b.test.ts"], runErrors: passed }))
      .toEqual({ pass: true, flaky: ["a.test.ts", "b.test.ts"] });
    expect(settleFileRetry(["a.test.ts"], { status: 1, failedFiles: ["a.test.ts"], runErrors: clean })).toEqual({ pass: false, flaky: [] });
    expect(settleFileRetry(["a.test.ts"], { status: 1, failedFiles: [], runErrors: clean })).toEqual({ pass: false, flaky: [] });
    expect(settleFileRetry(["a.test.ts"], { status: 0, failedFiles: null, runErrors: passed })).toEqual({ pass: false, flaky: [] });
    expect(settleFileRetry(["a.test.ts"], { status: 0, failedFiles: [], passedFiles: ["a.test.ts"], runErrors: null })).toEqual({ pass: false, flaky: [] });
    expect(settleFileRetry(["a.test.ts"], { status: 0, failedFiles: [], passedFiles: ["a.test.ts"], runErrors: { unhandledErrors: 1, reason: "passed" } }))
      .toEqual({ pass: false, flaky: [] });
  });

  it("fails the retry unless every retried file appears in the rerun's report as passed", () => {
    const passed = { unhandledErrors: 0, reason: "passed" };
    // Missing from the report.
    expect(settleFileRetry(["a.test.ts", "b.test.ts"], { status: 0, failedFiles: [], passedFiles: ["a.test.ts"], runErrors: passed }))
      .toEqual({ pass: false, flaky: [] });
    expect(settleFileRetry(["a.test.ts"], { status: 0, failedFiles: [], passedFiles: null, runErrors: passed })).toEqual({ pass: false, flaky: [] });
    const dir = mkdtempSync(join(tmpdir(), "ci-vitest-retry-passed-"));
    try {
      const report = join(dir, "report.json");
      writeFileSync(report, JSON.stringify({ testResults: [
        { name: join(dir, "a.test.ts"), status: "passed", assertionResults: [{ status: "passed" }, { status: "skipped" }] },
        { name: join(dir, "skipped.test.ts"), status: "passed", assertionResults: [{ status: "skipped" }] },
        { name: join(dir, "empty.test.ts"), status: "passed", assertionResults: [] },
        { name: join(dir, "b.test.ts"), status: "failed", assertionResults: [{ status: "failed" }] },
      ] }));
      const files = readReportFiles(report, dir)!;
      expect(files).toEqual({ failed: ["b.test.ts"], passed: ["a.test.ts"] });
      // Skipped or not run: the shard fails.
      for (const file of ["skipped.test.ts", "empty.test.ts"]) {
        expect(settleFileRetry([file], { status: 0, failedFiles: [], passedFiles: files.passed, runErrors: passed }))
          .toEqual({ pass: false, flaky: [] });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads failed files and run errors from their reports and refuses unreadable reports", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-vitest-retry-report-"));
    try {
      const report = join(dir, "report.json");
      writeFileSync(report, JSON.stringify({ testResults: [
        { name: join(dir, "b.test.ts"), status: "failed" },
        { name: join(dir, "a.test.ts"), status: "passed" },
        { name: join(dir, "sub/c.test.ts"), status: "failed" },
      ] }));
      expect(readFailedFiles(report, dir)).toEqual(["b.test.ts", "sub/c.test.ts"]);
      expect(readFailedFiles(join(dir, "missing.json"), dir)).toBeNull();
      writeFileSync(report, "{");
      expect(readFailedFiles(report, dir)).toBeNull();
      writeFileSync(report, JSON.stringify({ testResults: [{ name: join(dir, "..", "x.test.ts"), status: "failed" }] }));
      expect(readFailedFiles(report, dir)).toBeNull();

      const errors = join(dir, "errors.json");
      writeFileSync(errors, JSON.stringify({ unhandledErrors: 2, reason: "failed" }));
      expect(readRunErrors(errors)).toEqual({ unhandledErrors: 2, reason: "failed" });
      writeFileSync(errors, JSON.stringify({ reason: "failed" }));
      expect(readRunErrors(errors)).toBeNull();
      expect(readRunErrors(join(dir, "missing.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records unhandled errors and the run reason from Vitest's run end", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-vitest-run-errors-"));
    const path = join(dir, "errors.json");
    const previous = processEnvironment[RUN_ERRORS_REPORT_ENV];
    try {
      processEnvironment[RUN_ERRORS_REPORT_ENV] = path;
      new RunErrorsReporter().onTestRunEnd([], [new Error("unhandled rejection")], "failed");
      expect(readRunErrors(path)).toEqual({ unhandledErrors: 1, reason: "failed" });
    } finally {
      if (previous === undefined) delete processEnvironment[RUN_ERRORS_REPORT_ENV];
      else processEnvironment[RUN_ERRORS_REPORT_ENV] = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the default reporters next to the JSON and run-error reports and reruns only the failed files", () => {
    const runErrors = expect.stringMatching(/^--reporter=.*scripts\/ci-vitest-run-errors-reporter\.mjs$/u);
    expect(jsonReportArgs([], "/r.json", {})).toEqual(["--reporter=default", "--reporter=json", "--outputFile.json=/r.json", runErrors]);
    expect(jsonReportArgs([], "/r.json", { GITHUB_ACTIONS: "true" }))
      .toEqual(["--reporter=default", "--reporter=github-actions", "--reporter=json", "--outputFile.json=/r.json", runErrors]);
    expect(jsonReportArgs(["--reporter=dot"], "/r.json", {})).toEqual(["--reporter=json", "--outputFile.json=/r.json", runErrors]);
    const invocation = { kind: "normal", files: ["a.test.ts", "b.test.ts"], command: "node", args: ["run-vitest.mjs", "run", "a.test.ts", "b.test.ts", "--retry=2"] };
    expect(argsForFiles(invocation, ["b.test.ts"])).toEqual(["run-vitest.mjs", "run", "b.test.ts", "--retry=2"]);
  });

  type Attempt = { failed?: string[]; unhandledErrors?: number; status?: number };
  // Simulates Vitest: writes both reports for the files it was given and fails the listed ones.
  function fakeVitest(cwd: string, attempts: Attempt[]) {
    const calls: string[][] = [];
    const spawnImpl = (_command: string, args: string[], options: { env: Record<string, string> }) => {
      calls.push(args);
      const { failed = [], unhandledErrors = 0, status } = attempts[calls.length - 1] ?? {};
      const output = args.find((arg) => arg.startsWith("--outputFile.json="))!.slice("--outputFile.json=".length);
      const files = args.filter((arg) => arg.endsWith(".test.ts"));
      writeFileSync(output, JSON.stringify({ testResults: files.map((file) => ({
        name: join(cwd, file), status: failed.includes(file) ? "failed" : "passed",
        assertionResults: [{ status: failed.includes(file) ? "failed" : "passed" }] })) }));
      const exit = status ?? (failed.length > 0 || unhandledErrors > 0 ? 1 : 0);
      writeFileSync(options.env[RUN_ERRORS_REPORT_ENV], JSON.stringify({ unhandledErrors, reason: exit === 0 ? "passed" : "failed" }));
      return { status: exit };
    };
    return { calls, spawnImpl };
  }

  const invocation = (files: string[]) => [{ kind: "normal", files, command: "node", args: ["run-vitest.mjs", "run", ...files] }];

  it("reruns failed files once in the same job and reports them as flaky when they pass", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ci-vitest-retry-cwd-"));
    try {
      const { calls, spawnImpl } = fakeVitest(cwd, [{ failed: ["b.test.ts"] }, {}]);
      const flaky: string[][] = [];
      const status = runShardInvocations(invocation(["a.test.ts", "b.test.ts"]), {
        cwd, env: {}, spawnImpl, retryFailedFiles: true, reportFlaky: (names: string[]) => flaky.push(names), log: () => {},
      });
      expect(status).toBe(0);
      expect(calls).toHaveLength(2);
      expect(calls[1].filter((arg) => arg.endsWith(".test.ts"))).toEqual(["b.test.ts"]);
      expect(flaky).toEqual([["b.test.ts"]]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails without a further run on a failing retry, too many files, an unattributed error, or retry off", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ci-vitest-retry-cwd-"));
    try {
      const options = { cwd, env: {}, retryFailedFiles: true, reportFlaky: () => { throw new Error("unexpected"); }, log: () => {} };

      const again = fakeVitest(cwd, [{ failed: ["b.test.ts"] }, { failed: ["b.test.ts"] }]);
      expect(runShardInvocations(invocation(["a.test.ts", "b.test.ts"]), { ...options, spawnImpl: again.spawnImpl })).toBe(1);
      expect(again.calls).toHaveLength(2);

      const files = Array.from({ length: MAX_FLAKY_RETRY_FILES + 1 }, (_, index) => `f${index}.test.ts`);
      const many = fakeVitest(cwd, [{ failed: files }]);
      expect(runShardInvocations(invocation(files), { ...options, spawnImpl: many.spawnImpl })).toBe(1);
      expect(many.calls).toHaveLength(1);

      // A failed file alongside an unhandled error: the error must not be retried away.
      const unhandled = fakeVitest(cwd, [{ failed: ["a.test.ts"], unhandledErrors: 1 }, {}]);
      expect(runShardInvocations(invocation(["a.test.ts", "b.test.ts"]), { ...options, spawnImpl: unhandled.spawnImpl })).toBe(1);
      expect(unhandled.calls).toHaveLength(1);

      const unattributed = fakeVitest(cwd, [{ status: 1 }]);
      expect(runShardInvocations(invocation(["a.test.ts"]), { ...options, spawnImpl: unattributed.spawnImpl })).toBe(1);
      expect(unattributed.calls).toHaveLength(1);

      const local: string[][] = [];
      expect(runShardInvocations(invocation(["a.test.ts"]), {
        cwd, env: {}, spawnImpl: (_command: string, args: string[]) => { local.push(args); return { status: 1 }; },
      })).toBe(1);
      expect(local).toEqual([["run-vitest.mjs", "run", "a.test.ts"]]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
