import { parseChangelogFragment, type ChangelogFragment } from "./changelog-fragments.ts";
import {
  collectApiSurfaceSummary,
  collectSettingsDelta,
  collectSqlDelta,
  type ApiSurfaceSummary,
  type SettingsDelta,
} from "./release-docs-pass.ts";

export { collectApiSurfaceSummary, collectSettingsDelta, collectSqlDelta };

export const RELEASE_INDEX_PATH = "packages/core/meta/release-index.json";
export const RELEASE_INDEX_MAX_RELEASES = 10;

export type ReleaseIndexSettingsDelta = SettingsDelta;

export type ReleaseIndexEntry = {
  version: string;
  previousVersion: string | null;
  actionRequired: boolean;
  subpathsAdded: string[];
  symbolsAdded: string[];
  symbolsDeprecated: string[];
  sqlAdded: string[];
  settingsDelta: ReleaseIndexSettingsDelta;
  starterEntriesCount: number;
};

export type ReleaseIndex = {
  schemaVersion: 1;
  currentVersion: string;
  releases: ReleaseIndexEntry[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const bytewise = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sortedUnique = (items: readonly string[]): string[] => [...new Set(items)].sort(bytewise);

function validateSettingsDelta(value: unknown, label: string): ReleaseIndexSettingsDelta {
  if (!isRecord(value) || !isStringArray(value.added) || !isStringArray(value.removed) || !isStringArray(value.changed)) {
    throw new Error(`${label}: settingsDelta must carry string arrays added, removed, and changed`);
  }
  return {
    added: [...value.added],
    removed: [...value.removed],
    changed: [...value.changed],
  };
}

function validateReleaseIndexEntry(value: unknown, label: string): ReleaseIndexEntry {
  if (!isRecord(value)) throw new Error(`${label}: entry must be an object`);
  if (typeof value.version !== "string" || !value.version) throw new Error(`${label}: version must be a non-empty string`);
  if (value.previousVersion !== null && typeof value.previousVersion !== "string") {
    throw new Error(`${label}: previousVersion must be a string or null`);
  }
  if (typeof value.actionRequired !== "boolean") throw new Error(`${label}: actionRequired must be a boolean`);
  if (!isStringArray(value.subpathsAdded)) throw new Error(`${label}: subpathsAdded must be a string array`);
  if (!isStringArray(value.symbolsAdded)) throw new Error(`${label}: symbolsAdded must be a string array`);
  if (!isStringArray(value.symbolsDeprecated)) throw new Error(`${label}: symbolsDeprecated must be a string array`);
  if (!isStringArray(value.sqlAdded)) throw new Error(`${label}: sqlAdded must be a string array`);
  if (!Number.isSafeInteger(value.starterEntriesCount) || (value.starterEntriesCount as number) < 0) {
    throw new Error(`${label}: starterEntriesCount must be a non-negative integer`);
  }
  return {
    version: value.version,
    previousVersion: value.previousVersion,
    actionRequired: value.actionRequired,
    subpathsAdded: [...value.subpathsAdded],
    symbolsAdded: [...value.symbolsAdded],
    symbolsDeprecated: [...value.symbolsDeprecated],
    sqlAdded: [...value.sqlAdded],
    settingsDelta: validateSettingsDelta(value.settingsDelta, label),
    starterEntriesCount: value.starterEntriesCount as number,
  };
}

export function parseReleaseIndex(source: string, label = RELEASE_INDEX_PATH): ReleaseIndex {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`${label}: invalid JSON (${error instanceof Error ? error.message : String(error)})`, { cause: error });
  }
  if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.currentVersion !== "string" || !parsed.currentVersion || !Array.isArray(parsed.releases)) {
    throw new Error(`${label}: expected schemaVersion 1, non-empty currentVersion, and releases array`);
  }
  return {
    schemaVersion: 1,
    currentVersion: parsed.currentVersion,
    releases: parsed.releases.map((entry, index) => validateReleaseIndexEntry(entry, `${label}: releases[${index}]`)),
  };
}

export function buildReleaseIndexEntry(input: {
  version: string;
  previousVersion: string | null;
  fragments: readonly ChangelogFragment[];
  apiSummary: ApiSurfaceSummary;
  sqlAdded: readonly string[];
  settingsDelta: ReleaseIndexSettingsDelta;
}): ReleaseIndexEntry {
  const parsedFragments = input.fragments.map((fragment) => parseChangelogFragment(fragment));
  const starterEntriesCount = parsedFragments.filter(({ meta }) => meta.audience === "starter").length;
  const hasActionRequiredFragment = parsedFragments.some(({ meta }) => meta.kind === "action_required");
  const hasBreakingApiChange = input.apiSummary.symbolsRemoved.length > 0 || input.apiSummary.subpathsRemoved.length > 0;
  const actionRequired = hasActionRequiredFragment || input.sqlAdded.length > 0 || hasBreakingApiChange;
  return {
    version: input.version,
    previousVersion: input.previousVersion,
    actionRequired,
    subpathsAdded: sortedUnique(input.apiSummary.subpathsAdded),
    symbolsAdded: sortedUnique(input.apiSummary.symbolsAdded),
    symbolsDeprecated: sortedUnique(input.apiSummary.symbolsDeprecated),
    sqlAdded: sortedUnique(input.sqlAdded),
    settingsDelta: {
      added: sortedUnique(input.settingsDelta.added),
      removed: sortedUnique(input.settingsDelta.removed),
      changed: sortedUnique(input.settingsDelta.changed),
    },
    starterEntriesCount,
  };
}

export function deriveReleaseIndexEntry(input: {
  root: string;
  version: string;
  previousVersion: string | null;
  since: string | undefined;
  targetRef?: string;
  fragments: readonly ChangelogFragment[];
}): ReleaseIndexEntry {
  const targetRef = input.targetRef ?? "HEAD";
  const apiSummary = collectApiSurfaceSummary(input.root, input.since, targetRef);
  const sqlAdded = collectSqlDelta(input.root, input.since, targetRef);
  const settingsDelta = collectSettingsDelta(input.root, input.since, targetRef);
  return buildReleaseIndexEntry({
    version: input.version,
    previousVersion: input.previousVersion,
    fragments: input.fragments,
    apiSummary,
    sqlAdded,
    settingsDelta,
  });
}

export function updateReleaseIndex(
  existing: ReleaseIndex | undefined,
  entry: ReleaseIndexEntry,
  maxReleases = RELEASE_INDEX_MAX_RELEASES,
): ReleaseIndex {
  const prior = (existing?.releases ?? []).filter((row) => row.version !== entry.version);
  return {
    schemaVersion: 1,
    currentVersion: entry.version,
    releases: [entry, ...prior].slice(0, maxReleases),
  };
}

export function formatReleaseIndex(index: ReleaseIndex): string {
  return `${JSON.stringify(index, null, 2)}\n`;
}
