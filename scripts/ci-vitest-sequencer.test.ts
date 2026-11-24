import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { TestSpecification, Vitest } from "vitest/node";
import { digestKeyForPath, type DurationSections } from "./ci-vitest-duration-keys.ts";
import {
  DEFAULT_POSTGRES_DURATION_MS,
  DEFAULT_WEIGHTS_PATH,
  WeightedSequencer,
  fallbackSequencerDurationMs,
  loadSequencerWeights,
  sortTestSpecificationsByWeight,
} from "./ci-vitest-sequencer.ts";

function makeSpec(rootDir: string, relativePath: string): TestSpecification {
  return { moduleId: resolve(rootDir, relativePath) } as unknown as TestSpecification;
}

describe("ci-vitest-sequencer", () => {
  it("sorts heaviest pinned files first regardless of alphabetical order or file size, supporting digest keys", () => {
    const rootDir = "/repo";
    const manifest: DurationSections = {
      defaultDurationMs: 100,
      durationsMs: {
        "api/small-fast.test.ts": 250,
        [digestKeyForPath("src/digest-heavy.test.ts")]: 120_000,
        "tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts": 506_000,
        "tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts": 502_000,
      },
    };
    const input = [
      makeSpec(rootDir, "api/small-fast.test.ts"),
      makeSpec(rootDir, "src/digest-heavy.test.ts"),
      makeSpec(rootDir, "tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts"),
      makeSpec(rootDir, "tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts"),
    ];
    const snapshot = [...input];

    const sorted = sortTestSpecificationsByWeight(input, manifest, rootDir);

    expect(input).toEqual(snapshot);
    expect(sorted.map((spec) => spec.moduleId)).toEqual([
      resolve(rootDir, "tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts"),
      resolve(rootDir, "tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts"),
      resolve(rootDir, "src/digest-heavy.test.ts"),
      resolve(rootDir, "api/small-fast.test.ts"),
    ]);
  });

  it("assigns defaultDurationMs to unweighed files and tie-breaks deterministically by code-unit order", () => {
    const rootDir = "/repo";
    const manifest: DurationSections = {
      defaultDurationMs: 500,
      durationsMs: {
        "z/lighter-than-default.test.ts": 100,
        "z/heavier-than-default.test.ts": 900,
        "m/equal-to-default.test.ts": 500,
      },
    };
    const input = [
      makeSpec(rootDir, "z/lighter-than-default.test.ts"),
      makeSpec(rootDir, "src/unweighed-b.test.ts"),
      makeSpec(rootDir, "src/Unweighed-A.test.ts"),
      makeSpec(rootDir, "m/equal-to-default.test.ts"),
      makeSpec(rootDir, "z/heavier-than-default.test.ts"),
    ];

    const sorted = sortTestSpecificationsByWeight(input, manifest, rootDir);

    expect(sorted.map((spec) => spec.moduleId)).toEqual([
      resolve(rootDir, "z/heavier-than-default.test.ts"),
      resolve(rootDir, "m/equal-to-default.test.ts"),
      // Code-unit order places uppercase 'U' (0x55) before lowercase 'u' (0x75).
      resolve(rootDir, "src/Unweighed-A.test.ts"),
      resolve(rootDir, "src/unweighed-b.test.ts"),
      resolve(rootDir, "z/lighter-than-default.test.ts"),
    ]);
  });

  it("schedules unpinned tests/postgres files ahead of fast unit tests using the PostgreSQL fallback weight", () => {
    const rootDir = "/repo";
    expect(fallbackSequencerDurationMs("tests/postgres/unpinned.test.ts", 11)).toBe(DEFAULT_POSTGRES_DURATION_MS);
    expect(fallbackSequencerDurationMs("src/unpinned.test.ts", 11)).toBe(11);
    const manifest: DurationSections = {
      defaultDurationMs: 11,
      durationsMs: {
        "src/medium.test.ts": 5_000,
        "tests/postgres/pinned-heavy.test.ts": 90_000,
      },
    };
    const sorted = sortTestSpecificationsByWeight(
      [
        makeSpec(rootDir, "src/medium.test.ts"),
        makeSpec(rootDir, "tests/postgres/unpinned-new.test.ts"),
        makeSpec(rootDir, "tests/postgres/pinned-heavy.test.ts"),
      ],
      manifest,
      rootDir,
    );
    expect(sorted.map((spec) => spec.moduleId)).toEqual([
      resolve(rootDir, "tests/postgres/pinned-heavy.test.ts"),
      resolve(rootDir, "tests/postgres/unpinned-new.test.ts"),
      resolve(rootDir, "src/medium.test.ts"),
    ]);
  });

  it("falls back cleanly when the weights manifest file is missing", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "ci-vitest-sequencer-missing-"));
    try {
      const manifest = loadSequencerWeights(DEFAULT_WEIGHTS_PATH, emptyDir);
      expect(manifest).toEqual({ defaultDurationMs: 1, durationsMs: {} });

      const sequencer = new WeightedSequencer({ config: { root: emptyDir } } as unknown as Vitest);
      const specs = [
        makeSpec(emptyDir, "z/second.test.ts"),
        makeSpec(emptyDir, "a/first.test.ts"),
      ];
      await expect(sequencer.sort(specs)).resolves.toEqual([
        makeSpec(emptyDir, "a/first.test.ts"),
        makeSpec(emptyDir, "z/second.test.ts"),
      ]);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("falls back cleanly when the weights manifest is malformed or has invalid schema fields", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "ci-vitest-sequencer-invalid-"));
    try {
      const brokenJson = join(tempDir, "broken.json");
      writeFileSync(brokenJson, "{not-valid-json");
      expect(loadSequencerWeights(brokenJson, tempDir)).toEqual({ defaultDurationMs: 1, durationsMs: {} });

      const nonPositiveDefault = join(tempDir, "non-positive.json");
      writeFileSync(nonPositiveDefault, JSON.stringify({ defaultDurationMs: 0, durationsMs: {} }));
      expect(loadSequencerWeights(nonPositiveDefault, tempDir)).toEqual({ defaultDurationMs: 1, durationsMs: {} });

      const arrayDurations = join(tempDir, "array-durations.json");
      writeFileSync(arrayDurations, JSON.stringify({ defaultDurationMs: 100, durationsMs: [] }));
      expect(loadSequencerWeights(arrayDurations, tempDir)).toEqual({ defaultDurationMs: 100, durationsMs: {} });
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("instantiates WeightedSequencer against the repository manifest and sorts heaviest files first", async () => {
    const rootDir = process.cwd();
    const sequencer = new WeightedSequencer({ config: { root: rootDir } } as unknown as Vitest);
    const manifest = loadSequencerWeights(DEFAULT_WEIGHTS_PATH, rootDir);
    const ranked = Object.entries(manifest.durationsMs ?? {})
      .filter(([path, ms]) => Number.isFinite(ms) && ms > 0 && statSync(resolve(rootDir, path), { throwIfNoEntry: false })?.isFile())
      .sort(([, left], [, right]) => left - right);
    const [light] = ranked;
    const heavy = ranked.at(-1);
    const medium = light && heavy && ranked.find(([, ms]) => light[1] < ms && ms < heavy[1]);
    if (!light || !medium || !heavy) throw new Error("The repository weights need three distinct durations for existing files");

    const sorted = await sequencer.sort([
      makeSpec(rootDir, light[0]),
      makeSpec(rootDir, medium[0]),
      makeSpec(rootDir, heavy[0]),
    ]);

    expect(sorted[0].moduleId).toBe(resolve(rootDir, heavy[0]));
  });
});
