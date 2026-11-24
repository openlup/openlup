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
  buildQuarantineRetryArgs,
  buildShardCommand,
  buildShardExecutionPlan,
  fallbackDurationMs,
  formatQuarantineBanner,
  listVitestFiles,
  loadShardWeights,
  parseShardArgs,
  partitionShards,
  runShardInvocations,
} from "./ci-vitest-shard.mjs";

describe("ci-vitest-shard", () => {
  it("parses valid CLI arguments and refuses malformed invocations", () => {
    expect(parseShardArgs(["--shard", "4", "--total", "8"])).toEqual({
      shard: 4,
      total: 8,
      weightsPath: DEFAULT_WEIGHTS_PATH,
      quarantinePath: DEFAULT_QUARANTINE_PATH,
      printFiles: false,
      skipPretest: false,
      extraArgs: [],
    });
    expect(parseShardArgs([
      "--shard=2",
      "--total=8",
      "--weights=custom.json",
      "--quarantine=custom-q.json",
      "--print-files",
      "--skip-pretest",
      "--",
      "--reporter=dot",
    ])).toEqual({
      shard: 2,
      total: 8,
      weightsPath: "custom.json",
      quarantinePath: "custom-q.json",
      printFiles: true,
      skipPretest: true,
      extraArgs: ["--reporter=dot"],
    });
    expect(() => parseShardArgs([])).toThrow(/Usage:/);
    expect(() => parseShardArgs(["--shard", "0", "--total", "8"])).toThrow(/between 1 and 8/);
    expect(() => parseShardArgs(["--shard", "9", "--total", "8"])).toThrow(/between 1 and 8/);
    expect(() => parseShardArgs(["--shard", "1", "--total", "0"])).toThrow(/Usage:/);
    expect(() => parseShardArgs(["--shard", "1", "--total", "8", "--quarantine="])).toThrow(/--quarantine/);
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
});
