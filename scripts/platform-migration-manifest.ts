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
export const ADMIN_BASELINE_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/qa_00000000000000_platform_baseline.sql`;
export const ADMIN_ACTOR_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/qa_20260810180001_self_host_actor_auth.sql`;
export const ADMIN_ACQUISITION_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/qa_20260816140000_acquisition_case_foundation.sql`;
export const ADMIN_RUNTIME_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/qa_20261026130000_runtime_capabilities.sql`;
export const ADMIN_IMPORT_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/qa_20261026140000_retained_client_subscription_import.sql`;
const LEGACY_ACTOR_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/20260810180001_self_host_actor_auth.sql`;
const LEGACY_ACQUISITION_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/20260816140000_acquisition_case_foundation.sql`;
const QUALIFIED_AFTER_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/20261026120000_account_support_operator_authority.sql`;
const ADMIN_FILES = new Set([ADMIN_BASELINE_FILE, ADMIN_ACTOR_FILE, ADMIN_ACQUISITION_FILE, ADMIN_RUNTIME_FILE, ADMIN_IMPORT_FILE]);
const QUALIFIED_FILES = new Set([QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE, QUALIFIED_IMPORT_FILE, QUALIFIED_RUNTIME_COMPLETION_FILE, ...ADMIN_FILES]);
const PLATFORM_FILE_RE = /^db\/platform\/migrations\/[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;
export type AddedMigration = { file: string; content: string };
export type PlatformMigrationManifestEntry = { file: string; sha256: string };
export type PlatformMigrationPlan = { schemaVersion: 1; baseline: PlatformMigrationManifestEntry; forward: PlatformMigrationManifestEntry[]; objectInventorySha256: string };
export type PlatformQualifiedBindingShape = { migrationIsBootstrap: boolean; hasRestore: boolean };
type QualifiedInventories = {
  bootstrapMigrator: { runtimeOnly?: string; withRestore: string };
  separateMigrator: { runtimeOnly?: string; withRestore: string };
};
type QualifiedPlan = Omit<PlatformMigrationPlan, "schemaVersion" | "objectInventorySha256"> & { objectInventorySha256: QualifiedInventories };
type AdminPlan = Omit<PlatformMigrationPlan, "schemaVersion" | "objectInventorySha256"> & { objectInventorySha256: { installerManaged: string; operatorProvisioned: string } };
export type PlatformMigrationManifest = PlatformMigrationPlan | (Omit<PlatformMigrationPlan, "schemaVersion"> & {
  schemaVersion: 2;
  qualified: QualifiedPlan;
}) | (Omit<PlatformMigrationPlan, "schemaVersion"> & {
  schemaVersion: 3;
  qualified: QualifiedPlan;
  qualifiedAdmin: AdminPlan;
});
export type PlatformMigrationGeneration = "legacy" | "qualified-v2" | "qualified-admin";
export type PlatformAdminBindingShape = { roleMode: "installer-managed" | "operator-provisioned" };
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

/** Validate every canonical generation before selecting one for the unchanged executor. */
export function evaluatePlatformMigrationManifest(input: PlatformManifestInput): string[] {
  const raw = input.manifest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || ![2, 3].includes((raw as { schemaVersion: number }).schemaVersion)) return evaluatePlan(input, PLATFORM_BASELINE_FILE, true);
  const manifest = raw as Record<string, unknown>;
  const adminPresent = manifest.schemaVersion === 3;
  if (!hasOnlyKeys(manifest, ["schemaVersion", "baseline", "forward", "objectInventorySha256", "qualified", ...(adminPresent ? ["qualifiedAdmin"] : [])])) return ["platform migration manifest: expected exactly the selected generation keys"];
  const qualified = manifest.qualified;
  const planKeys = ["baseline", "forward", "objectInventorySha256"];
  if (!qualified || typeof qualified !== "object" || Array.isArray(qualified) || !hasOnlyKeys(qualified as Record<string, unknown>, planKeys)) return ["platform migration manifest.qualified: expected exactly { baseline, forward, objectInventorySha256 }"];
  const q = qualified as Record<string, unknown>;
  const inventories = q.objectInventorySha256;
  const withImport = Array.isArray(q.forward) && q.forward.some(entry => entry && typeof entry === "object" && (entry as { file?: unknown }).file === QUALIFIED_IMPORT_FILE);
  if (!inventories || typeof inventories !== "object" || Array.isArray(inventories)
    || !hasOnlyKeys(inventories as Record<string, unknown>, ["bootstrapMigrator", "separateMigrator"])
    || Object.values(inventories).some(value => !value || typeof value !== "object" || Array.isArray(value)
      || !hasOnlyKeys(value as Record<string, unknown>, withImport ? ["withRestore"] : ["runtimeOnly", "withRestore"])
      || !Object.values(value).every(isSha256))) return ["qualified inventory requires the exact supported binding-shape SHA-256 digests"];
  let admin: Record<string, unknown> | undefined;
  if (adminPresent) {
    const value = manifest.qualifiedAdmin;
    if (!value || typeof value !== "object" || Array.isArray(value) || !hasOnlyKeys(value as Record<string, unknown>, planKeys)) return ["qualifiedAdmin requires the exact plan keys"];
    admin = value as Record<string, unknown>;
    const hashes = admin.objectInventorySha256;
    if (!hashes || typeof hashes !== "object" || Array.isArray(hashes)
      || !hasOnlyKeys(hashes as Record<string, unknown>, ["installerManaged", "operatorProvisioned"])
      || !Object.values(hashes).every(isSha256)) return ["qualifiedAdmin requires the two exact role-mode inventory digests"];
  }
  if (input.objectInventoryPayload !== undefined) return ["qualified inventory payload requires an explicit selected binding shape"];
  const legacy = { schemaVersion: 1, baseline: manifest.baseline, forward: manifest.forward, objectInventorySha256: manifest.objectInventorySha256 };
  const selected = { schemaVersion: 1, ...q, objectInventorySha256: (inventories as QualifiedInventories).bootstrapMigrator.withRestore };
  const selectedAdmin = admin && { schemaVersion: 1, ...admin, objectInventorySha256: (admin.objectInventorySha256 as { installerManaged: string }).installerManaged };
  const entries = (value: Record<string, unknown>): string[] => [value.baseline, ...(Array.isArray(value.forward) ? value.forward : [])]
    .flatMap(entry => entry && typeof entry === "object" && typeof (entry as Record<string, unknown>).file === "string" ? [(entry as { file: string }).file] : []);
  const legacyFiles = new Set(entries(legacy)), qFiles = new Set(entries(selected)), aFiles = new Set(selectedAdmin ? entries(selectedAdmin) : []);
  const errors = [
    ...evaluatePlan({ manifest: legacy, migrations: input.migrations.filter(({ file }) => legacyFiles.has(file)) }, PLATFORM_BASELINE_FILE, true),
    ...evaluatePlan({ manifest: selected, migrations: input.migrations.filter(({ file }) => qFiles.has(file)) }, QUALIFIED_BASELINE_FILE, false),
    ...(selectedAdmin ? evaluatePlan({ manifest: selectedAdmin, migrations: input.migrations.filter(({ file }) => aFiles.has(file)) }, ADMIN_BASELINE_FILE, false) : []),
  ];
  const union = new Set([...legacyFiles, ...qFiles, ...aFiles]);
  for (const { file } of input.migrations) if (!union.has(file)) errors.push(`platform migration manifest: unmanifested catalog file ${file}`);
  if (errors.length) return errors;
  const current = raw as Exclude<PlatformMigrationManifest, PlatformMigrationPlan>;
  function qualifiedOrder(plan: QualifiedPlan | AdminPlan, baseline: string, actor: string, acquisition: string, runtime: string, retainedImport: string, files: Set<string>, requireImport: boolean) {
    const replacements = new Map([[actor, LEGACY_ACTOR_FILE], [acquisition, LEGACY_ACQUISITION_FILE]]);
    const tails = new Set([runtime, retainedImport, QUALIFIED_RUNTIME_COMPLETION_FILE]);
    const shared = plan.forward.filter(({ file }) => !tails.has(file));
    if (shared.length !== current.forward.length || shared.some((entry, index) => {
      const legacyEntry = current.forward[index]!;
      return replacements.has(entry.file) ? replacements.get(entry.file) !== legacyEntry.file : JSON.stringify(entry) !== JSON.stringify(legacyEntry);
    })) errors.push("qualified plan must reuse the complete legacy order with only its two exact bootstrap replacements");
    for (const file of [actor, acquisition, runtime, ...(requireImport ? [retainedImport, QUALIFIED_RUNTIME_COMPLETION_FILE] : [])]) if (!files.has(file)) errors.push(`qualified plan is missing ${file}`);
    const own = new Set([baseline, actor, acquisition, runtime, retainedImport, QUALIFIED_RUNTIME_COMPLETION_FILE]);
    if ([...files].some(file => !legacyFiles.has(file) && !own.has(file))) errors.push("qualified plan contains a wrong-generation fresh identity");
    const at = (file: string) => plan.forward.findIndex(row => row.file === file);
    if (at(QUALIFIED_AFTER_FILE) < 0 || at(runtime) <= at(QUALIFIED_AFTER_FILE)) errors.push("qualified runtime capabilities must follow the complete ownership closure");
    if (at(retainedImport) >= 0 && at(retainedImport) <= at(runtime)) errors.push("qualified retained import must follow runtime role sealing");
    if (at(QUALIFIED_RUNTIME_COMPLETION_FILE) >= 0 && (at(retainedImport) < 0 || at(QUALIFIED_RUNTIME_COMPLETION_FILE) <= at(retainedImport) || at(QUALIFIED_RUNTIME_COMPLETION_FILE) !== plan.forward.length - 1)) errors.push("qualified runtime completion must follow retained import");
    if (requireImport && (at(runtime) !== current.forward.length || at(retainedImport) !== current.forward.length + 1
      || at(QUALIFIED_RUNTIME_COMPLETION_FILE) !== current.forward.length + 2)) errors.push("qualified 91-unit tails must follow the complete shared order exactly");
  }
  qualifiedOrder(current.qualified, QUALIFIED_BASELINE_FILE, QUALIFIED_ACTOR_FILE, QUALIFIED_ACQUISITION_FILE, QUALIFIED_RUNTIME_FILE, QUALIFIED_IMPORT_FILE, qFiles, current.schemaVersion === 3);
  if (current.schemaVersion === 3) {
    qualifiedOrder(current.qualifiedAdmin, ADMIN_BASELINE_FILE, ADMIN_ACTOR_FILE, ADMIN_ACQUISITION_FILE, ADMIN_RUNTIME_FILE, ADMIN_IMPORT_FILE, aFiles, true);
    if (!qFiles.has(QUALIFIED_RUNTIME_COMPLETION_FILE)) errors.push("the issued runtime completion tail must be selected by both qualified plans");
  }
  if ([...legacyFiles].some(isQualifiedPlatformMigrationPath)) errors.push("legacy migration plan cannot select a qualified identity");
  return errors;
}

/** Normalize one validated generation for the unchanged package-owned executor. */
export function selectPlatformMigrationManifest(manifest: PlatformMigrationManifest, generation: PlatformMigrationGeneration, binding?: PlatformQualifiedBindingShape | PlatformAdminBindingShape): PlatformMigrationPlan {
  if (generation === "legacy") return { schemaVersion: 1, baseline: manifest.baseline, forward: manifest.forward, objectInventorySha256: manifest.objectInventorySha256 };
  if (generation === "qualified-admin") {
    if (manifest.schemaVersion !== 3 || !binding || !hasOnlyKeys(binding, ["roleMode"]) || !("roleMode" in binding)
      || !["installer-managed", "operator-provisioned"].includes(binding.roleMode)) throw new Error("qualified-admin requires its exact canonical plan and role-mode binding");
    return { schemaVersion: 1, ...manifest.qualifiedAdmin, objectInventorySha256: manifest.qualifiedAdmin.objectInventorySha256[binding.roleMode === "installer-managed" ? "installerManaged" : "operatorProvisioned"] };
  }
  if (generation !== "qualified-v2" || manifest.schemaVersion === 1) throw new Error("qualified-v2 requires the explicit canonical v2 manifest");
  if (!binding || !hasOnlyKeys(binding, ["migrationIsBootstrap", "hasRestore"]) || !("migrationIsBootstrap" in binding)
    || typeof binding.migrationIsBootstrap !== "boolean" || typeof binding.hasRestore !== "boolean") throw new Error("qualified-v2 requires the exact declared binding shape");
  const hashes = manifest.qualified.objectInventorySha256[binding.migrationIsBootstrap ? "bootstrapMigrator" : "separateMigrator"];
  const expected = hashes[binding.hasRestore ? "withRestore" : "runtimeOnly"];
  if (expected === undefined) throw new Error("qualified retained import requires an explicit restore login binding");
  return { schemaVersion: 1, ...manifest.qualified, objectInventorySha256: expected };
}

/** The selected source is union-validated before normalization. */
export function evaluateSelectedPlatformMigrationManifest(input: PlatformManifestInput, generation: PlatformMigrationGeneration): string[] {
  return evaluatePlan(input, generation === "legacy" ? PLATFORM_BASELINE_FILE : generation === "qualified-admin" ? ADMIN_BASELINE_FILE : QUALIFIED_BASELINE_FILE, generation === "legacy");
}

/** Shared PR/release prefix comparison; selection grants no permission to edit issued SQL. */
export function evaluatePlatformMigrationManifestHistory(previous: PlatformMigrationManifest, current: PlatformMigrationManifest, addedFiles: readonly string[]): string[] {
  const errors: string[] = [];
  if (current.schemaVersion < previous.schemaVersion || current.schemaVersion > 3
    || JSON.stringify(previous.baseline) !== JSON.stringify(current.baseline)
    || !Array.isArray(previous.forward) || !Array.isArray(current.forward)
    || JSON.stringify(current.forward.slice(0, previous.forward.length)) !== JSON.stringify(previous.forward)) return ["platform migration manifest must preserve the previous prefix"];
  if (previous.schemaVersion !== 1) {
    if (current.schemaVersion === 1 || JSON.stringify(previous.qualified.baseline) !== JSON.stringify(current.qualified.baseline)
      || JSON.stringify(current.qualified.forward.slice(0, previous.qualified.forward.length)) !== JSON.stringify(previous.qualified.forward)) errors.push("qualified migration manifest must preserve the previous prefix");
    else if (current.qualified.forward.length === previous.qualified.forward.length && JSON.stringify(current.qualified.objectInventorySha256) !== JSON.stringify(previous.qualified.objectInventorySha256)) errors.push("qualified inventory cannot change without an appended qualified forward");
  }
  if (previous.schemaVersion === 3) {
    if (current.schemaVersion !== 3 || JSON.stringify(previous.qualifiedAdmin.baseline) !== JSON.stringify(current.qualifiedAdmin.baseline)
      || JSON.stringify(current.qualifiedAdmin.forward.slice(0, previous.qualifiedAdmin.forward.length)) !== JSON.stringify(previous.qualifiedAdmin.forward)) errors.push("qualified-admin manifest must preserve the previous prefix");
    else if (current.qualifiedAdmin.forward.length === previous.qualifiedAdmin.forward.length && JSON.stringify(current.qualifiedAdmin.objectInventorySha256) !== JSON.stringify(previous.qualifiedAdmin.objectInventorySha256)) errors.push("qualified-admin inventory cannot change without an appended forward");
  }
  const files = (manifest: PlatformMigrationManifest): Set<string> => new Set([
    manifest.baseline.file, ...manifest.forward.map(({ file }) => file),
    ...(manifest.schemaVersion === 1 ? [] : [manifest.qualified.baseline.file, ...manifest.qualified.forward.map(({ file }) => file)]),
    ...(manifest.schemaVersion === 3 ? [manifest.qualifiedAdmin.baseline.file, ...manifest.qualifiedAdmin.forward.map(({ file }) => file)] : []),
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
