import { createHash } from "node:crypto";

/**
 * Duration-manifest key and timeout helpers shared by `vitest.config.ts`,
 * `src/test/setup.ts`, and `scripts/ci-vitest-shard.mjs`.
 */

/** `vitest.config.ts` flat ceilings; a derived budget can only raise them. */
export const FLAT_TEST_TIMEOUT_MS = 10_000;
export const FLAT_COVERAGE_TEST_TIMEOUT_MS = 30_000;
/**
 * Hosted runners share CPU across parallel jobs; tooling tests that take 5-7 s
 * locally were measured at 10.1-13.7 s there. The hosted floor keeps a hung test
 * failing in seconds while absorbing that contention without per-test bounds.
 */
export const FLAT_HOSTED_TEST_TIMEOUT_MS = 30_000;
/** RR-L4: a file's ceiling is 1.5x what the manifest says the whole file costs. */
export const BUDGET_FACTOR = 1.5;
export const DIGEST_KEY_PREFIX = "sha256:";
const DIGEST_KEY_HEX_LENGTH = 16;

/** Shape consumed by the optional public timeout reader and weighted sharder. */
export type DurationSections = {
  defaultDurationMs: number;
  durationsMs: Record<string, number>;
  toolingDurationsMs?: Record<string, number>;
};

export function flatTestTimeoutMs(coverageRun: boolean, hostedCi = false): number {
  if (coverageRun) return FLAT_COVERAGE_TEST_TIMEOUT_MS;
  return hostedCi ? FLAT_HOSTED_TEST_TIMEOUT_MS : FLAT_TEST_TIMEOUT_MS;
}

/**
 * Stable SHA-256 digest key for a repository-relative test path that carries a
 * counted brand/provider term and therefore cannot appear verbatim in a neutral
 * manifest.
 */
export function digestKeyForPath(path: string): string {
  return `${DIGEST_KEY_PREFIX}${createHash("sha256").update(path).digest("hex").slice(0, DIGEST_KEY_HEX_LENGTH)}`;
}

export function isDigestKey(key: string): boolean {
  return new RegExp(`^${DIGEST_KEY_PREFIX}[0-9a-f]{${DIGEST_KEY_HEX_LENGTH}}$`).test(key);
}

/** Both key forms of one file, in the order a reader should try them. */
export function manifestKeyCandidates(path: string): [string, string] {
  return [path, digestKeyForPath(path)];
}

export function pinnedDurationMs(
  section: Readonly<Record<string, number>> | undefined,
  path: string,
): number | undefined {
  if (!section) return undefined;
  for (const key of manifestKeyCandidates(path)) {
    const value = section[key];
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  }
  return undefined;
}

/**
 * A file's pin, whichever lane weighed it. A reader at test time does not know
 * which lane is running it, and the two sections never name the same file, so the
 * larger of the two is the only answer that is right in both lanes.
 */
export function pinnedFileDurationMs(manifest: DurationSections, path: string): number | undefined {
  const values = [pinnedDurationMs(manifest.durationsMs, path), pinnedDurationMs(manifest.toolingDurationsMs, path)]
    .filter((value): value is number => value !== undefined);
  return values.length === 0 ? undefined : Math.max(...values);
}

/**
 * REQ-1. The flat ceiling is the floor, so an unpinned file is exactly as it was.
 * The pin is a whole-FILE duration while this is a PER-TEST ceiling, which is what
 * keeps a budget from becoming a suppression: reaching it takes one test as
 * expensive as everything the file did when it was measured.
 */
export function deriveTestTimeoutMs(manifest: DurationSections, path: string, flatMs: number): number {
  const pinned = pinnedFileDurationMs(manifest, path);
  return pinned === undefined ? flatMs : Math.max(flatMs, Math.ceil(pinned * BUDGET_FACTOR));
}
