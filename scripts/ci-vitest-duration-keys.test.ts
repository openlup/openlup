import { describe, expect, it } from "vitest";
import {
  BUDGET_FACTOR,
  FLAT_COVERAGE_TEST_TIMEOUT_MS,
  FLAT_TEST_TIMEOUT_MS,
  deriveTestTimeoutMs,
  digestKeyForPath,
  flatTestTimeoutMs,
  isDigestKey,
  manifestKeyCandidates,
  pinnedDurationMs,
  pinnedFileDurationMs,
  type DurationSections,
} from "./ci-vitest-duration-keys.ts";

describe("ci-vitest-duration-keys", () => {
  it("returns flat timeout floors for plain and coverage runs", () => {
    expect(flatTestTimeoutMs(false)).toBe(FLAT_TEST_TIMEOUT_MS);
    expect(flatTestTimeoutMs(true)).toBe(FLAT_COVERAGE_TEST_TIMEOUT_MS);
  });

  it("produces deterministic sha256 digest keys and recognizes them", () => {
    const path = "tests/example/heavy.test.ts";
    const digest = digestKeyForPath(path);
    expect(digest).toBe(digestKeyForPath(path));
    expect(isDigestKey(digest)).toBe(true);
    expect(isDigestKey(path)).toBe(false);
    expect(manifestKeyCandidates(path)).toEqual([path, digest]);
  });

  it("resolves pinned durations by plain path or digest key and ignores invalid values", () => {
    const plain = "tests/a.test.ts";
    const hashed = "tests/b.test.ts";
    const section: Record<string, number> = {
      [plain]: 4_200,
      [digestKeyForPath(hashed)]: 9_500,
      "tests/zero.test.ts": 0,
      "tests/neg.test.ts": -5,
      "tests/nan.test.ts": Number.NaN,
    };
    expect(pinnedDurationMs(section, plain)).toBe(4_200);
    expect(pinnedDurationMs(section, hashed)).toBe(9_500);
    expect(pinnedDurationMs(section, "tests/zero.test.ts")).toBeUndefined();
    expect(pinnedDurationMs(section, "tests/neg.test.ts")).toBeUndefined();
    expect(pinnedDurationMs(section, "tests/nan.test.ts")).toBeUndefined();
    expect(pinnedDurationMs(undefined, plain)).toBeUndefined();
  });

  it("derives per-test timeouts as max(flat, ceil(pinned * BUDGET_FACTOR))", () => {
    const manifest: DurationSections = {
      defaultDurationMs: 100,
      durationsMs: {
        "tests/fast.test.ts": 500,
        "tests/slow.test.ts": 20_000,
      },
      toolingDurationsMs: {
        "tests/slow.test.ts": 30_000,
      },
    };
    expect(pinnedFileDurationMs(manifest, "tests/slow.test.ts")).toBe(30_000);
    expect(deriveTestTimeoutMs(manifest, "tests/unlisted.test.ts", 10_000)).toBe(10_000);
    expect(deriveTestTimeoutMs(manifest, "tests/fast.test.ts", 10_000)).toBe(10_000);
    expect(deriveTestTimeoutMs(manifest, "tests/slow.test.ts", 10_000)).toBe(Math.ceil(30_000 * BUDGET_FACTOR));
  });
});
