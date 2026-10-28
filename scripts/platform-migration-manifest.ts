import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

export const PLATFORM_MIGRATION_DIRECTORY = "db/platform/migrations";
export const PLATFORM_MIGRATION_MANIFEST = "config/platform-migration-manifest.json";
export const PLATFORM_BASELINE_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/00000000000000_platform_baseline.sql`;
export const QUALIFIED_BASELINE_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/q2_00000000000000_platform_baseline.sql`;
export const QUALIFIED_ACTOR_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/q2_20260810180001_self_host_actor_auth.sql`;
export const QUALIFIED_ACQUISITION_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/q2_20260816140000_acquisition_case_foundation.sql`;
export const QUALIFIED_RUNTIME_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/q2_20261026130000_runtime_capabilities.sql`;
export const QUALIFIED_IMPORT_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/q2_20261026140000_retained_client_subscription_import.sql`;
export const QUALIFIED_RUNTIME_COMPLETION_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/q2_20261028100000_runtime_capability_completion.sql`;
const LEGACY_ACTOR_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/20260810180001_self_host_actor_auth.sql`;
const LEGACY_ACQUISITION_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/20260816140000_acquisition_case_foundation.sql`;
const QUALIFIED_AFTER_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/20261026120000_account_support_operator_authority.sql`;
const QUALIFIED_FILES = new Set([QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE, QUALIFIED_IMPORT_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE]);
const PLATFORM_FILE_RE = /^db\/platform\/migrations\/[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;
export type AddedMigration = { file: string; content: string };
export type PlatformMigrationManifestEntry = { file: string; sha256: string };
export type PlatformMigrationPlan = { schemaVersion: 1; baseline: PlatformMigrationManifestEntry; forward: PlatformMigrationManifestEntry[]; objectInventorySha256: string };
export type PlatformQualifiedBindingShape = { migrationIsBootstrap: boolean; hasRestore: boolean };
type QualifiedInventories = {
  bootstrapMigrator: { runtimeOnly?: string; withRestore: string };
  separateMigrator: { runtimeOnly?: string; withRestore: string };
};
export type PlatformMigrationManifest = PlatformMigrationPlan | (Omit<PlatformMigrationPlan, "schemaVersion"> & {
  schemaVersion: 2;
  qualified: Omit<PlatformMigrationPlan, "schemaVersion" | "objectInventorySha256"> & { objectInventorySha256: QualifiedInventories };
});
export type PlatformMigrationGeneration = "legacy" | "qualified-v2";
export type PlatformManifestInput = { manifest: unknown; migrations: readonly AddedMigration[]; objectInventoryPayload?: string };
export type PlatformMigrationCatalog = { migrations: AddedMigration[]; errors: string[] };

export function isPlatformMigrationPath(file: string): boolean { return PLATFORM_FILE_RE.test(file); }
export function isQualifiedPlatformMigrationPath(file: string): boolean { return QUALIFIED_FILES.has(file); }
export function sha256(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}
function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function parsePlatformEntry(value: unknown, label: string, errors: string[]): PlatformMigrationManifestEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !hasOnlyKeys(value as Record<string, unknown>, ["file", "sha256"])) { errors.push(`${label}: expected exactly { file, sha256 }`); return null; }
  const entry = value as Record<string, unknown>;
  if (typeof entry.file !== "string" || !isPlatformMigrationPath(entry.file)) errors.push(`${label}.file: must be a direct .sql file under ${PLATFORM_MIGRATION_DIRECTORY}/`);
  if (!isSha256(entry.sha256)) errors.push(`${label}.sha256: must be a lowercase 64-hex SHA-256 digest`);
  return typeof entry.file === "string" && isSha256(entry.sha256) ? { file: entry.file, sha256: entry.sha256 } : null;
}

function evaluatePlan(input: PlatformManifestInput, baselineFile: string, ordered: boolean): string[] {
  const errors: string[] = [];
  const raw = input.manifest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !hasOnlyKeys(raw as Record<string, unknown>, ["schemaVersion", "baseline", "forward", "objectInventorySha256"])) return ["platform migration manifest: expected exactly { schemaVersion, baseline, forward, objectInventorySha256 }"];
  const manifest = raw as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) errors.push("platform migration manifest.schemaVersion: expected 1");
  const baseline = parsePlatformEntry(manifest.baseline, "platform migration manifest.baseline", errors);
  if (baseline?.file !== baselineFile) errors.push(`platform migration manifest.baseline.file: expected ${baselineFile}`);
  if (!Array.isArray(manifest.forward)) errors.push("platform migration manifest.forward: expected an array");
  const forward = Array.isArray(manifest.forward) ? manifest.forward.map((entry, index) => parsePlatformEntry(entry, `platform migration manifest.forward[${index}]`, errors)) : [];
  if (!isSha256(manifest.objectInventorySha256)) errors.push("platform migration manifest.objectInventorySha256: must be a lowercase 64-hex SHA-256 digest");
  if (!baseline || forward.some((entry) => entry === null)) return errors;
  const entries = [baseline, ...(forward as PlatformMigrationManifestEntry[])];
  const files = entries.map((entry) => entry.file);
  const uniqueFiles = new Set(files);
  if (uniqueFiles.size !== files.length) errors.push("platform migration manifest: duplicate migration filename");
  const forwardFiles = forward.map((entry) => entry?.file ?? "");
  if (ordered && forwardFiles.some((file, index) => index > 0 && file <= forwardFiles[index - 1])) errors.push("platform migration manifest.forward: entries must be in strict filename order");
  const migrationByFile = new Map(input.migrations.map((migration) => [migration.file, migration.content]));
  const actualFiles = [...migrationByFile.keys()].sort();
  const expectedFiles = [...uniqueFiles].sort();
  for (const file of expectedFiles) if (!migrationByFile.has(file)) errors.push(`platform migration manifest: missing catalog file ${file}`);
  for (const file of actualFiles) if (!uniqueFiles.has(file)) errors.push(`platform migration manifest: unmanifested catalog file ${file}`);
  for (const entry of entries) { const content = migrationByFile.get(entry.file); if (content !== undefined && sha256(content) !== entry.sha256) errors.push(`platform migration manifest: SHA-256 mismatch for ${entry.file}`); }
  if (input.objectInventoryPayload !== undefined && isSha256(manifest.objectInventorySha256) && sha256(input.objectInventoryPayload) !== manifest.objectInventorySha256) errors.push("platform migration manifest: object inventory SHA-256 mismatch");
  return errors;
}

/** Validate the canonical union, including SQL outside the selected generation. */
export function evaluatePlatformMigrationManifest(input: PlatformManifestInput): string[] {
  const raw = input.manifest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as Record<string, unknown>).schemaVersion !== 2) return evaluatePlan(input, PLATFORM_BASELINE_FILE, true);
  const manifest = raw as Record<string, unknown>;
  if (!hasOnlyKeys(manifest, ["schemaVersion", "baseline", "forward", "objectInventorySha256", "qualified"])) return ["platform migration manifest v2: expected exactly { schemaVersion, baseline, forward, objectInventorySha256, qualified }"];
  const qualified = manifest.qualified;
  if (!qualified || typeof qualified !== "object" || Array.isArray(qualified)
    || !hasOnlyKeys(qualified as Record<string, unknown>, ["baseline", "forward", "objectInventorySha256"])) return ["platform migration manifest.qualified: expected exactly { baseline, forward, objectInventorySha256 }"];
  const inventories = (qualified as Record<string, unknown>).objectInventorySha256;
  const withImport = Array.isArray((qualified as Record<string, unknown>).forward)
    && ((qualified as Record<string, unknown>).forward as unknown[]).some(entry => entry && typeof entry === "object" && (entry as { file?: unknown }).file === QUALIFIED_IMPORT_FILE);
  if (!inventories || typeof inventories !== "object" || Array.isArray(inventories)
    || !hasOnlyKeys(inventories as Record<string, unknown>, ["bootstrapMigrator", "separateMigrator"])
    || Object.values(inventories).some(value => !value || typeof value !== "object" || Array.isArray(value)
      || !hasOnlyKeys(value as Record<string, unknown>, withImport ? ["withRestore"] : ["runtimeOnly", "withRestore"])
      || !Object.values(value).every(isSha256))) return ["qualified inventory requires the exact supported binding-shape SHA-256 digests"];
  if (input.objectInventoryPayload !== undefined) return ["qualified inventory payload requires an explicit selected binding shape"];
  const legacy = { schemaVersion: 1, baseline: manifest.baseline, forward: manifest.forward, objectInventorySha256: manifest.objectInventorySha256 };
  const selected = { schemaVersion: 1, ...qualified, objectInventorySha256: (inventories as QualifiedInventories).bootstrapMigrator.withRestore };
  const entries = (value: Record<string, unknown>): string[] => [value.baseline, ...(Array.isArray(value.forward) ? value.forward : [])]
    .flatMap(entry => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).file === "string" ? [(entry as { file: string }).file] : []);
  const legacyFiles = new Set(entries(legacy)), qualifiedFiles = new Set(entries(selected));
  const errors = [
    ...evaluatePlan({ manifest: legacy, migrations: input.migrations.filter(({ file }) => legacyFiles.has(file)) }, PLATFORM_BASELINE_FILE, true),
    ...evaluatePlan({ manifest: selected, migrations: input.migrations.filter(({ file }) => qualifiedFiles.has(file)), objectInventoryPayload: input.objectInventoryPayload }, QUALIFIED_BASELINE_FILE, false),
  ];
  const union = new Set([...legacyFiles, ...qualifiedFiles]);
  for (const { file } of input.migrations) if (!union.has(file)) errors.push(`platform migration manifest: unmanifested catalog file ${file}`);
  if (errors.length) return errors;
  const current = raw as PlatformMigrationManifest & { schemaVersion: 2 };
  const replacements = new Map([[QUALIFIED_ACTOR_FILE, LEGACY_ACTOR_FILE], [QUALIFIED_ACQUISITION_FILE, LEGACY_ACQUISITION_FILE]]);
  const shared = current.qualified.forward.filter(({ file }) => file !== QUALIFIED_RUNTIME_FILE && file !== QUALIFIED_IMPORT_FILE && file !== QUALIFIED_RUNTIME_COMPLETION_FILE);
  if (shared.length !== current.forward.length || shared.some((entry, index) => {
    const legacyEntry = current.forward[index]!;
    return replacements.has(entry.file) ? replacements.get(entry.file) !== legacyEntry.file : JSON.stringify(entry) !== JSON.stringify(legacyEntry);
  })) errors.push("qualified migration plan must reuse the complete legacy order with only the two exact bootstrap replacements");
  for (const file of [QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE]) if (!qualifiedFiles.has(file)) errors.push(`qualified migration plan is missing ${file}`);
  if ([...qualifiedFiles].some(file => !legacyFiles.has(file) && !QUALIFIED_FILES.has(file))) errors.push("qualified migration plan contains an unsupported fresh-only identity");
  if ([...legacyFiles].some(file => isQualifiedPlatformMigrationPath(file))) errors.push("legacy migration plan cannot select a qualified identity");
  const runtimePosition = current.qualified.forward.findIndex(({ file }) => file === QUALIFIED_RUNTIME_FILE);
  const afterPosition = current.qualified.forward.findIndex(({ file }) => file === QUALIFIED_AFTER_FILE);
  if (afterPosition < 0 || runtimePosition <= afterPosition) errors.push("qualified runtime capabilities must follow the complete ownership closure");
  const importPosition = current.qualified.forward.findIndex(({ file }) => file === QUALIFIED_IMPORT_FILE);
  if (importPosition >= 0 && importPosition <= runtimePosition) errors.push("qualified retained import must follow runtime role sealing");
  const completionPosition = current.qualified.forward.findIndex(({ file }) => file === QUALIFIED_RUNTIME_COMPLETION_FILE);
  if (completionPosition >= 0 && (importPosition < 0 || completionPosition <= importPosition || completionPosition !== current.qualified.forward.length - 1)) errors.push("qualified runtime completion must be the final tail after retained import");
  return errors;
}

/** Normalize one validated generation for the unchanged package-owned executor. */
export function selectPlatformMigrationManifest(manifest: PlatformMigrationManifest, generation: PlatformMigrationGeneration, binding?: PlatformQualifiedBindingShape): PlatformMigrationPlan {
  if (generation === "legacy") return { schemaVersion: 1, baseline: manifest.baseline, forward: manifest.forward, objectInventorySha256: manifest.objectInventorySha256 };
  if (generation !== "qualified-v2" || manifest.schemaVersion !== 2) throw new Error("qualified-v2 requires the explicit canonical v2 manifest");
  if (!binding || typeof binding.migrationIsBootstrap !== "boolean" || typeof binding.hasRestore !== "boolean"
    || !hasOnlyKeys(binding, ["migrationIsBootstrap", "hasRestore"])) throw new Error("qualified-v2 requires the exact declared binding shape");
  const hashes = manifest.qualified.objectInventorySha256[binding.migrationIsBootstrap ? "bootstrapMigrator" : "separateMigrator"];
  const expected = hashes[binding.hasRestore ? "withRestore" : "runtimeOnly"];
  if (expected === undefined) throw new Error("qualified retained import requires an explicit restore login binding");
  return { schemaVersion: 1, ...manifest.qualified, objectInventorySha256: expected };
}

/** The selected source is union-validated before normalization. */
export function evaluateSelectedPlatformMigrationManifest(input: PlatformManifestInput, generation: PlatformMigrationGeneration): string[] {
  return evaluatePlan(input, generation === "legacy" ? PLATFORM_BASELINE_FILE : QUALIFIED_BASELINE_FILE, generation === "legacy");
}

/** Shared PR/release prefix comparison; selection grants no permission to edit issued SQL. */
export function evaluatePlatformMigrationManifestHistory(previous: PlatformMigrationManifest, current: PlatformMigrationManifest, addedFiles: readonly string[]): string[] {
  const errors: string[] = [];
  if ((previous.schemaVersion !== current.schemaVersion && !(previous.schemaVersion === 1 && current.schemaVersion === 2))
    || JSON.stringify(previous.baseline) !== JSON.stringify(current.baseline)
    || !Array.isArray(previous.forward) || !Array.isArray(current.forward)
    || JSON.stringify(current.forward.slice(0, previous.forward.length)) !== JSON.stringify(previous.forward)) return ["platform migration manifest must preserve the previous prefix"];
  if (previous.schemaVersion === 2 && (current.schemaVersion !== 2
    || JSON.stringify(previous.qualified.baseline) !== JSON.stringify(current.qualified.baseline)
    || JSON.stringify(current.qualified.forward.slice(0, previous.qualified.forward.length)) !== JSON.stringify(previous.qualified.forward))) errors.push("qualified migration manifest must preserve the previous prefix");
  const files = (manifest: PlatformMigrationManifest): Set<string> => new Set([
    manifest.baseline.file, ...manifest.forward.map(({ file }) => file),
    ...(manifest.schemaVersion === 2 ? [manifest.qualified.baseline.file, ...manifest.qualified.forward.map(({ file }) => file)] : []),
  ]);
  const beforeFiles = files(previous), afterFiles = files(current);
  const appended = [...afterFiles].filter(file => !beforeFiles.has(file)).sort();
  if (JSON.stringify(appended) !== JSON.stringify([...addedFiles].sort())) errors.push("platform migration manifest must bind exactly the appended portable forwards and qualified units");
  if (current.forward.length === previous.forward.length && current.objectInventorySha256 !== previous.objectInventorySha256) errors.push("legacy object inventory cannot change without an appended legacy forward");
  if (appended.length === 0 && JSON.stringify(previous) !== JSON.stringify(current)) errors.push("platform migration manifest cannot change without an added migration");
  return errors;
}

export function readPlatformMigrationManifest(root: string): unknown | null {
  const manifestPath = `${root}/${PLATFORM_MIGRATION_MANIFEST}`;
  return existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
}
export function readPlatformMigrations(root: string): PlatformMigrationCatalog {
  const directory = `${root}/${PLATFORM_MIGRATION_DIRECTORY}`;
  if (!existsSync(directory)) return { migrations: [], errors: [] };
  const migrations: AddedMigration[] = [];
  const errors: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = `${PLATFORM_MIGRATION_DIRECTORY}/${entry.name}`;
    if (entry.isDirectory()) { errors.push(`platform migration catalog: nested directory is not allowed: ${file}`); continue; }
    if (!entry.isFile()) { errors.push(`platform migration catalog: unsupported entry: ${file}`); continue; }
    if (!entry.name.endsWith(".sql")) { errors.push(`platform migration catalog: non-SQL file is not allowed: ${file}`); continue; }
    migrations.push({ file, content: readFileSync(`${directory}/${entry.name}`, "utf8") });
  }
  return { migrations: migrations.sort((left, right) => left.file.localeCompare(right.file)), errors };
}
export function runPlatformMigrationManifestCheck(root = process.cwd(), objectInventoryPayload?: string): string[] {
  try {
    const { migrations, errors } = readPlatformMigrations(root);
    const manifest = readPlatformMigrationManifest(root);
    if (!manifest) return [...errors, `platform migration manifest missing at ${PLATFORM_MIGRATION_MANIFEST}`];
    return [...errors, ...evaluatePlatformMigrationManifest({ manifest, migrations, objectInventoryPayload })];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [`platform migration manifest check failed: ${message}`];
  }
}
