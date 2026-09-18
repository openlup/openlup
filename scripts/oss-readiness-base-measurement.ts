import { execFileSync } from "node:child_process";

import { selectsPath, type FamilySelectors } from "./oss-readiness-family-path.ts";

type Counts = Record<string, number>;
/** Injected so this module never imports the report back, and stays testable without git. */
type Classify = (file: string, bytes: Buffer) => { source: string | null; error: string | null };

/**
 * The blobs of every path this branch changed, read at `git merge-base origin/main HEAD`.
 * Two subprocesses, not the second 8k-path scan a whole-tree base measurement would cost.
 * `null` refuses attribution and the absolute rule stands; a path missing at the base maps
 * to `null` because it was added here and its base count is zero.
 *
 * `git diff <base>` with no second revision compares the base to the WORKING TREE, so a
 * dirty local verify attributes its own uncommitted edits rather than ignoring them.
 */
export function baseSourcesForChangedPaths(root: string, classify: Classify): Map<string, string | null> | null {
  try {
    const base = execFileSync("git", ["-C", root, "merge-base", "origin/main", "HEAD"], { encoding: "utf8" }).trim();
    if (!/^[0-9a-f]{40}$/.test(base)) return null;
    const changed = execFileSync("git", ["-C", root, "diff", "--name-only", "-z", base], { encoding: "utf8" }).split("\0").filter(Boolean);
    const sources = new Map<string, string | null>(changed.map((file) => [file, null] as const));
    if (changed.length === 0) return sources;
    const batch = execFileSync("git", ["-C", root, "cat-file", "--batch"], {
      input: changed.map((file) => `${base}:${file}\n`).join(""), maxBuffer: 512 * 1024 * 1024,
    });
    let offset = 0;
    for (const file of changed) {
      const newline = batch.indexOf(10, offset);
      if (newline < 0) return null;
      const header = batch.toString("utf8", offset, newline);
      if (header.endsWith(" missing")) { offset = newline + 1; continue; }
      const size = Number(header.split(" ")[2]);
      if (!Number.isInteger(size)) return null;
      const start = newline + 1;
      sources.set(file, classify(file, batch.subarray(start, start + size)).source);
      offset = start + size + 1;
    }
    return sources;
  } catch { return null; }
}

/**
 * What the merge-base tree would have measured for this family, reconstructed by
 * subtracting the delta of only the changed paths. Exact, not approximate: the whole-tree
 * counter is a plain sum over per-path counts, and an unchanged path is the same blob at
 * both revisions, so it cancels.
 *
 * `null` refuses attribution and the absolute rule stands — when the base blobs are
 * unreadable, or when this branch moved the family's own selectors, because a selector
 * change relocates whole path sets and a per-path delta would then be meaningless.
 */
export function previousCurrentFromChangedPaths(args: {
  baseSources: Map<string, string | null> | null;
  before: { prefixes: string[]; excludePrefixes: string[]; rootFiles: string[] } | undefined;
  family: FamilySelectors & { prefixes: string[]; excludePrefixes: string[]; rootFiles: string[] };
  categories: readonly string[];
  current: Counts;
  selectedPaths: string[];
  trackedFiles: string[];
  pathCounts: Map<string, Counts>;
  count: (file: string, source: string | null) => Counts;
}): Counts | null {
  const { baseSources, before, family, categories, current, selectedPaths, trackedFiles, pathCounts, count } = args;
  const same = (actual: readonly string[], expected: readonly string[]) => actual.join("\0") === expected.join("\0");
  if (!baseSources || before === undefined) return null;
  if (!same(family.prefixes, before.prefixes) || !same(family.excludePrefixes, before.excludePrefixes) || !same(family.rootFiles, before.rootFiles)) return null;
  const previous: Counts = Object.fromEntries(categories.map((category) => [category, current[category]]));
  const headSelected = new Set(selectedPaths), tracked = new Set(trackedFiles);
  for (const [file, baseSource] of baseSources) {
    // Counted at the base when selected here now, or deleted here and still named by the
    // selectors. Anything else is zero on both sides and cancels.
    if (!headSelected.has(file) && !(!tracked.has(file) && selectsPath(file, family))) continue;
    const beforeCounts = count(file, baseSource), afterCounts = pathCounts.get(file) ?? {};
    for (const category of categories) previous[category] += (beforeCounts[category] ?? 0) - (afterCounts[category] ?? 0);
  }
  return previous;
}

/** `skipped` means the absolute pre-attribution rule ran instead, never that a looser one passed. */
export function attributionStatus(baseSources: Map<string, string | null> | null, historyAvailable: boolean, skipReason: string | null): { status: "evaluated" | "skipped"; reason: string | null } {
  if (baseSources && historyAvailable) return { status: "evaluated", reason: null };
  return { status: "skipped", reason: baseSources ? skipReason : "the merge-base blobs of the changed paths are unreadable" };
}

/**
 * Where the base measurement may come from, and whether it may come at all.
 *
 * A caller supplying its own inventory or byte reader describes a tree that is NOT the
 * working tree, so a git-derived delta would attribute changes to a tree they are not in.
 * Refuse there and let the absolute rule run, which is the stricter of the two. Missing
 * this broke `./openlup verify` on a clean checkout after W-P2a, and only there: with no
 * changed paths the delta is zero, so a fixture's synthetic lag read as inherited.
 */
export function attributionSource(
  options: { inventory?: unknown; readFile?: unknown; baseSources?: Map<string, string | null> | null },
  read: () => Map<string, string | null> | null,
): { baseSources: Map<string, string | null> | null; syntheticReason: string | null } {
  if (options.baseSources !== undefined) return { baseSources: options.baseSources, syntheticReason: null };
  if (options.inventory !== undefined || options.readFile !== undefined) {
    return { baseSources: null, syntheticReason: "the caller supplied its own tree, so a git-derived delta would describe a different one" };
  }
  return { baseSources: read(), syntheticReason: null };
}
