import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseSequencer, type TestSpecification, type Vitest } from "vitest/node";
import { pinnedDurationMs, type DurationSections } from "./ci-vitest-duration-keys.ts";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_WEIGHTS_PATH = "config/vitest-shard-weights.json";

const FALLBACK_MANIFEST: DurationSections = {
  defaultDurationMs: 1,
  durationsMs: {},
};

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function toPosixRelativePath(rootDir: string, moduleId: string): string {
  return relative(rootDir, resolve(rootDir, moduleId)).split("\\").join("/");
}

/**
 * Loads the shard-weight manifest used for intra-shard LPT test ordering.
 * Falls back to uniform weight (`defaultDurationMs: 1`) if the manifest is
 * absent so ad-hoc or minimal checkouts keep running without failing setup.
 */
export function loadSequencerWeights(
  weightsPath: string = DEFAULT_WEIGHTS_PATH,
  rootDir: string = REPOSITORY_ROOT,
): DurationSections {
  try {
    const raw = readFileSync(resolve(rootDir, weightsPath), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ...FALLBACK_MANIFEST, durationsMs: {} };
    }
    const candidate = parsed as Partial<DurationSections>;
    const defaultDurationMs =
      typeof candidate.defaultDurationMs === "number"
      && Number.isFinite(candidate.defaultDurationMs)
      && candidate.defaultDurationMs > 0
        ? candidate.defaultDurationMs
        : FALLBACK_MANIFEST.defaultDurationMs;
    const durationsMs =
      candidate.durationsMs && typeof candidate.durationsMs === "object" && !Array.isArray(candidate.durationsMs)
        ? candidate.durationsMs
        : {};
    return { defaultDurationMs, durationsMs };
  } catch {
    return { ...FALLBACK_MANIFEST, durationsMs: {} };
  }
}

/**
 * Orders test specifications longest-first (LPT) using pinned weights from the
 * duration manifest, breaking ties deterministically by repository-relative
 * POSIX path in UTF-16 code-unit order.
 */
export function sortTestSpecificationsByWeight<T extends Pick<TestSpecification, "moduleId">>(
  files: readonly T[],
  manifest: DurationSections,
  rootDir: string,
): T[] {
  const weighted = files.map((spec) => {
    const relativePath = toPosixRelativePath(rootDir, spec.moduleId);
    const weightMs = pinnedDurationMs(manifest.durationsMs, relativePath) ?? manifest.defaultDurationMs;
    return { spec, relativePath, weightMs };
  });

  weighted.sort(
    (left, right) => (right.weightMs - left.weightMs) || compareCodeUnits(left.relativePath, right.relativePath),
  );

  return weighted.map((entry) => entry.spec);
}

/**
 * Vitest sequencer that schedules the heaviest test files first within a run or
 * shard (Longest Processing Time first), preventing small wrapper files with
 * long runtime from starting at the tail and stranding idle workers.
 */
export class WeightedSequencer extends BaseSequencer {
  private readonly manifest: DurationSections;

  constructor(ctx: Vitest) {
    super(ctx);
    this.manifest = loadSequencerWeights(DEFAULT_WEIGHTS_PATH, ctx.config.root);
  }

  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    return sortTestSpecificationsByWeight(files, this.manifest, this.ctx.config.root);
  }
}
