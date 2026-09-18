import { createHash } from "node:crypto";

/**
 * One key form, five readers. `config/ci-vitest-durations.json` is written by
 * `update-ci-vitest-durations.ts`, read by `ci-vitest-groups.ts` for both lanes,
 * by `src/test/setup.ts` for the per-file timeout budget and by
 * `ci-vitest-duration-reporter.ts` for budget pressure. A key minted in one place
 * and parsed in another is exactly the seam a digest key can silently break, so
 * every one of them goes through this module.
 */

/** `vitest.config.ts` flat ceilings; a derived budget can only raise them. */
export const FLAT_TEST_TIMEOUT_MS = 10_000;
export const FLAT_COVERAGE_TEST_TIMEOUT_MS = 30_000;
/** RR-L4: a file's ceiling is 1.5x what the manifest says the whole file costs. */
export const BUDGET_FACTOR = 1.5;
/** Intent stop condition: a budget above 3x its pre-programme pin is reported. */
export const BUDGET_BOUND_FACTOR = 3;
/** Reported by the duration reporter so budgets can shrink, not only grow. */
export const BUDGET_PRESSURE_RATIO = 0.8;
/**
 * Intent decision 3 of the coverage-lane programme. One file this expensive is what
 * makes a single shard the pole, and the manifest is the only place that can explain
 * one: a cost above this ceiling has to be covered by a pin large enough for it. Two
 * readers apply that one rule -- the declaration-site scan in `ci-vitest-groups.test.ts`
 * and the merged hosted observation in `merge-ci-vitest-telemetry.ts` -- and in wave 1
 * both of them only report.
 */
export const FILE_COST_CEILING_MS = 120_000;
export const DIGEST_KEY_PREFIX = "sha256:";
const DIGEST_KEY_HEX_LENGTH = 16;
const REPIN_COMMAND = "./openlup ci durations --fetch 10 --write";

/** The manifest as its readers need it; `ci-vitest-groups.ts` owns the full type. */
export type DurationSections = {
  defaultDurationMs: number;
  durationsMs: Record<string, number>;
  toolingDurationsMs?: Record<string, number>;
};

export function flatTestTimeoutMs(coverageRun: boolean): number {
  return coverageRun ? FLAT_COVERAGE_TEST_TIMEOUT_MS : FLAT_TEST_TIMEOUT_MS;
}

/**
 * Decision 3 of the red-runs intent. A repository-relative test path that spells a
 * counted brand term cannot be a manifest key, because the manifest is a counted
 * OSS surface on a family with no brand headroom. Its digest is: it names exactly
 * one file, adds no term, and is stable across runs and machines.
 */
export function digestKeyForPath(path: string): string {
  return `${DIGEST_KEY_PREFIX}${createHash("sha256").update(path).digest("hex").slice(0, DIGEST_KEY_HEX_LENGTH)}`;
}

export function isDigestKey(key: string): boolean {
  return new RegExp(`^${DIGEST_KEY_PREFIX}[0-9a-f]{${DIGEST_KEY_HEX_LENGTH}}$`).test(key);
}

export function spellsBrandTerm(value: string, brandTerms: readonly string[]): boolean {
  return brandTerms.some((term) => value.toLowerCase().includes(term.toLowerCase()));
}

/** The key a re-pin writes for one file: the path itself, or its digest. */
export function manifestKeyForPath(path: string, brandTerms: readonly string[]): string {
  return spellsBrandTerm(path, brandTerms) ? digestKeyForPath(path) : path;
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

/**
 * REQ-2. A test file the manifest cannot represent must be a named error, never a
 * silent default weight. Once a brand-spelling path is keyed by its digest, one
 * thing is left that can make a file unrepresentable: two files minting the same
 * key, where a weight would silently describe the wrong one. `brandTerms` is
 * optional because only a writer knows them, and a writer passes them to get the
 * stronger check that a key it is about to emit spells no term.
 */
export function unrepresentableTestFiles(
  paths: readonly string[],
  brandTerms: readonly string[] = [],
): string[] {
  const owners = new Map<string, string[]>();
  const violations: string[] = [];
  for (const path of paths) {
    const key = manifestKeyForPath(path, brandTerms);
    if (spellsBrandTerm(key, brandTerms)) violations.push(`${path}: its manifest key would spell a counted brand term`);
    owners.set(key, [...(owners.get(key) ?? []), path]);
  }
  for (const [key, files] of owners) {
    if (files.length > 1) violations.push(`${key}: minted by ${files.sort().join(" and ")}`);
  }
  return violations.sort();
}

export function assertManifestCanRepresent(paths: readonly string[], brandTerms: readonly string[] = []): void {
  const violations = unrepresentableTestFiles(paths, brandTerms);
  if (violations.length === 0) return;
  throw new Error(`Duration manifest cannot represent every test file:\n${violations.map((line) => `- ${line}`).join("\n")}\nRe-pin with \`${REPIN_COMMAND}\` after resolving the key above.`);
}

/** One file's cost, as either reader sees it: a declared timeout, or a measured duration. */
export type FileCostEntry = { path: string; costMs: number; line?: number };

/** A cost above the ceiling that no pin explains, with what it would take to explain it. */
export type FileCostCeilingBreach = {
  path: string;
  costMs: number;
  line?: number;
  budgetMs: number;
  coveringPinMs: number;
};

/**
 * Covered means the ceiling `src/test/setup.ts` derives for this file already reaches the
 * cost. Every cost above `FILE_COST_CEILING_MS` is above both flat floors, so the flat
 * term can never be the reason this answers yes -- only a pin can.
 */
export function pinCoversCost(manifest: DurationSections, path: string, costMs: number, flatMs: number): boolean {
  return deriveTestTimeoutMs(manifest, path, flatMs) >= costMs;
}

/** The smallest whole-file pin whose `BUDGET_FACTOR` budget reaches `costMs`. */
function coveringPinForCostMs(costMs: number): number {
  return Math.ceil(costMs / BUDGET_FACTOR);
}

/**
 * The rule itself, for either reader: the entries above the ceiling that no pin covers,
 * in the order they were given, each carrying the budget its file has today and the pin
 * that would cover it. An entry at or below the ceiling is not this rule's business, and
 * neither is one whose pin already explains the cost.
 */
export function ceilingBreaches(
  entries: readonly FileCostEntry[],
  manifest: DurationSections,
  flatMs: number,
): FileCostCeilingBreach[] {
  return entries.flatMap((entry) => {
    if (entry.costMs <= FILE_COST_CEILING_MS) return [];
    if (pinCoversCost(manifest, entry.path, entry.costMs, flatMs)) return [];
    return [{
      path: entry.path,
      costMs: entry.costMs,
      ...(entry.line === undefined ? {} : { line: entry.line }),
      budgetMs: deriveTestTimeoutMs(manifest, entry.path, flatMs),
      coveringPinMs: coveringPinForCostMs(entry.costMs),
    }];
  });
}

/** One coverage-lane set whose members must be packed into the same weighted group. */
export type AffinityGroup = { id: string; files: string[]; sharedCostMs: number };
/** A manifest as the coverage partition reads it: the weights plus its placement rules. */
export type PartitionManifest = DurationSections & { isolatedProductFiles?: readonly string[]; affinityGroups?: readonly AffinityGroup[] };
/** One affinity set collapsed into the single weighted item the packer places. */
export type AffinityPlaceholder = { key: string; files: string[]; weightMs: number };
/** The packer's inputs with every set collapsed, and what it takes to undo that. */
export type AffinityPacking = { inventory: string[]; weights: DurationSections; ignoredFiles: string[]; placeholders: AffinityPlaceholder[] };
/** Structurally the packer's group; the sharder owns the exported `WeightedGroup` name. */
type PackedGroup = { files: string[]; estimatedDurationMs: number };

const AFFINITY_KEY_PREFIX = "affinity-set:";
const AFFINITY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AFFINITY_PATH_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * The declaration's own shape, checked before anything reads an inventory: kebab-case
 * unique ids, at least two sorted unique member paths, a non-negative integer shared cost,
 * no path in two sets, and no member a singleton group already owns. A set of one would be
 * a no-op that reads like a rule, and a member that is also isolated is two placement rules
 * disagreeing about one file.
 */
export function parseAffinityGroups(value: unknown, isolatedFiles: readonly string[] = []): AffinityGroup[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Duration manifest affinityGroups must be an array");
  const isolated = new Set(isolatedFiles);
  const owners = new Map<string, string>();
  const ids = new Set<string>();
  return value.map((entry, index): AffinityGroup => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Duration manifest affinityGroups[${index}] must be an object`);
    const { id, files, sharedCostMs } = entry as { id: unknown; files: unknown; sharedCostMs: unknown };
    if (typeof id !== "string" || !AFFINITY_ID_PATTERN.test(id)) throw new Error(`Duration manifest affinity group id must be kebab-case: ${String(id)}`);
    if (ids.has(id)) throw new Error(`Duration manifest duplicates affinity group id: ${id}`);
    ids.add(id);
    if (typeof sharedCostMs !== "number" || !Number.isInteger(sharedCostMs) || sharedCostMs < 0) throw new Error(`Duration manifest affinity group ${id} sharedCostMs must be a non-negative integer`);
    if (!Array.isArray(files) || files.length < 2) throw new Error(`Duration manifest affinity group ${id} must name at least two files`);
    const members = files.map((file: unknown, position: number): string => {
      if (typeof file !== "string" || file.startsWith("/") || file.includes("\\") || file.split("/").includes("..") || !AFFINITY_PATH_PATTERN.test(file)) throw new Error(`Duration manifest affinity path must be a repository-relative test path: ${String(file)}`);
      if (position > 0 && String(files[position - 1]) >= file) throw new Error(`Duration manifest affinity group ${id} must name sorted, unique files: ${file}`);
      if (isolated.has(file)) throw new Error(`Duration manifest affinity group ${id} names an isolated product file: ${file}`);
      const owner = owners.get(file);
      if (owner !== undefined) throw new Error(`Duration manifest affinity groups ${owner} and ${id} both name: ${file}`);
      owners.set(file, id);
      return file;
    });
    return { id, files: members, sharedCostMs };
  });
}

/**
 * Wave 4's placement rule. Four coverage files share one process-wide scan cache
 * (`tests/setup/oss-readiness-run-cache.ts`): the first to ask pays for the scan and every
 * later member in the SAME Vitest main process reads the stored result. LPT weighs files
 * one at a time, so it spreads them over shards and each shard holding one pays again.
 *
 * A set is handed to the packer as ONE item instead, weighing its heaviest member's pin
 * plus `sharedCostMs` for each other member -- what a shard really costs once the followers
 * hit -- never the sum of the members' pins, which is what the lane pays while they are
 * apart. The item is placed by the same LPT pass as every other file, so nothing else about
 * the partition changes, and `expandAffinityGroups` puts the members back into whichever
 * group won it. Three fail-closed refusals: a member the tooling lane owns, a member the
 * inventory does not hold, and a set above an equal share of the non-isolated lane -- that
 * last one is the balance this rule must not spend, because a set heavier than a fair group
 * can only make the group that wins it the slowest one.
 */
export function planAffinityPacking(
  inventory: readonly string[], groupCount: number, manifest: PartitionManifest, ignoredFiles: readonly string[] = [],
): AffinityPacking {
  const isolated = new Set(manifest.isolatedProductFiles ?? []);
  const declared = parseAffinityGroups(manifest.affinityGroups, [...isolated]);
  if (declared.length === 0) return { inventory: [...inventory], weights: manifest, ignoredFiles: [...ignoredFiles], placeholders: [] };
  const present = new Set(inventory);
  const ignored = new Set(ignoredFiles);
  const durationOf = (file: string): number => pinnedDurationMs(manifest.durationsMs, file) ?? manifest.defaultDurationMs;
  const placeholders = declared.map((group): AffinityPlaceholder => {
    const foreign = group.files.filter((file) => ignored.has(file));
    if (foreign.length > 0) throw new Error(`Duration manifest affinity group ${group.id} names files owned by the tooling lane: ${foreign.join(", ")}`);
    const absent = group.files.filter((file) => !present.has(file));
    if (absent.length > 0) throw new Error(`Duration manifest affinity group ${group.id} names files outside the Vitest inventory: ${absent.join(", ")}`);
    const key = `${AFFINITY_KEY_PREFIX}${group.id}`;
    if (present.has(key)) throw new Error(`Duration manifest affinity group ${group.id} collides with an inventory path: ${key}`);
    return { key, files: [...group.files], weightMs: Math.max(...group.files.map(durationOf)) + group.sharedCostMs * (group.files.length - 1) };
  });
  const members = new Set(placeholders.flatMap((placeholder) => placeholder.files));
  const packedFiles = inventory.filter((file) => !members.has(file) && !isolated.has(file));
  const laneWeightMs = packedFiles.reduce((sum, file) => sum + durationOf(file), 0) + placeholders.reduce((sum, item) => sum + item.weightMs, 0);
  const shareMs = laneWeightMs / Math.max(groupCount - isolated.size, 1);
  const heavy = placeholders.filter((placeholder) => placeholder.weightMs > shareMs);
  if (heavy.length > 0) throw new Error(`Duration manifest affinity group weight exceeds an equal share (${Math.round(shareMs)}ms) of the coverage lane: ${heavy.map((item) => `${item.key}=${item.weightMs}ms`).join(", ")}`);
  return {
    inventory: [...packedFiles, ...inventory.filter((file) => isolated.has(file)), ...placeholders.map((item) => item.key)].sort(),
    weights: { ...manifest, durationsMs: { ...manifest.durationsMs, ...Object.fromEntries(placeholders.map((item) => [item.key, item.weightMs])) } },
    ignoredFiles: [...ignoredFiles, ...members],
    placeholders,
  };
}

/** Puts each set's members back where its collapsed item landed, and re-sorts that group. */
export function expandAffinityGroups<Group extends PackedGroup>(groups: Group[], packing: AffinityPacking): Group[] {
  if (packing.placeholders.length === 0) return groups;
  return groups.map((group): Group => ({
    ...group,
    files: group.files.flatMap((file) => packing.placeholders.find((item) => item.key === file)?.files ?? [file]).sort(),
  }));
}
