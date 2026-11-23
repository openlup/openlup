/** Only facts validated by the existing JSON envelope reader are exposed here. */
export interface InventoryEnvelope {
  value: {
    current: Record<string, unknown>;
    historical: unknown;
  };
  before: string;
  after: string;
}

export interface MigrationRelocation {
  oldPath: string;
  newPath: string;
  oldMirror: string;
  newMirror: string;
  oldSlot: string;
  newSlot: string;
  oldBasename: string;
  newBasename: string;
}

export interface SqlFootprint {
  rows: Set<string>;
  relations: Set<string>;
  functions: Set<string>;
  roles: Set<string>;
  indexes: Set<string>;
  triggers: Set<string>;
  views: Set<string>;
  policies: Set<string>;
  flags: Set<string>;
}

export const INVENTORY_PATH: string;
export const MIGRATION_REGISTRIES: string[];
export function inventoryEnvelope(source: string): InventoryEnvelope;
export function inventoryOnlyCurrent(base: string, left: string, right: string, committed: string): boolean;
export function migrationRegistryUnion(
  path: string,
  baseSource: string,
  leftSource: string,
  rightSource: string,
  inventorySource?: string,
): string;
export function nextUtcMigrationSlot(afterSlot: string): string;
export function planRelocatedSlots(
  prAddedPaths: readonly string[],
  mainMigrationPaths: readonly string[],
  allExistingPaths?: readonly string[],
): MigrationRelocation[];
export function splitSqlStatements(sql: string): string[];
export function extractSqlFootprint(sqlText: string): SqlFootprint;
export function extractSlotMetadataFootprint(slot: Record<string, unknown>): SqlFootprint;
export function assertDisjointRelocationFootprints(
  prSlots: readonly Record<string, unknown>[],
  mainSlots: readonly Record<string, unknown>[],
  prSqlTexts: readonly string[],
  mainSqlTexts: readonly string[],
): void;
export function assertNoStaleRelocationRefs(
  relocations: readonly MigrationRelocation[],
  filesByPath: Iterable<readonly [string, string]>,
): void;
export function rewriteMigrationRegistryForRelocation(
  path: string,
  leftSource: string,
  relocations: readonly MigrationRelocation[],
): string;
export function rewriteCatalogForRelocation(
  leftSource: string,
  relocations: readonly MigrationRelocation[],
): string;
export function validateRelocationPlan(input: {
  baseForwardsSource: string;
  headForwardsSource: string;
  mainForwardsSource: string;
  prSqlAdded: readonly string[];
  prSqlModifiedOrDeleted: readonly string[];
  mainSqlAdded: readonly string[];
  mainSqlModifiedOrDeleted: readonly string[];
  mainAllMigrationPaths: readonly string[];
  allExistingPaths: readonly string[];
  prSqlBlobsByPath: ReadonlyMap<string, string>;
  prMirrorBlobsByPath: ReadonlyMap<string, string>;
  mainSqlBlobsByPath: ReadonlyMap<string, string>;
  prNonCarrierFilesByPath: ReadonlyMap<string, string>;
}): MigrationRelocation[];
