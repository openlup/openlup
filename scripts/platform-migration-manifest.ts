import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";

export const PLATFORM_MIGRATION_DIRECTORY = "db/platform/migrations";
export const PLATFORM_MIGRATION_MANIFEST = "config/platform-migration-manifest.json";
export const PLATFORM_BASELINE_FILE = `${PLATFORM_MIGRATION_DIRECTORY}/00000000000000_platform_baseline.sql`;
const PLATFORM_FILE_RE = /^db\/platform\/migrations\/[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/;
export type AddedMigration = { file: string; content: string };
export type PlatformMigrationManifestEntry = { file: string; sha256: string };
export type PlatformMigrationManifest = { schemaVersion: 1; baseline: PlatformMigrationManifestEntry; forward: PlatformMigrationManifestEntry[]; objectInventorySha256: string };
export type PlatformManifestInput = { manifest: unknown; migrations: readonly AddedMigration[]; objectInventoryPayload?: string };
export type PlatformMigrationCatalog = { migrations: AddedMigration[]; errors: string[] };

export function isPlatformMigrationPath(file: string): boolean { return PLATFORM_FILE_RE.test(file); }
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

export function evaluatePlatformMigrationManifest(input: PlatformManifestInput): string[] {
  const errors: string[] = [];
  const raw = input.manifest;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || !hasOnlyKeys(raw as Record<string, unknown>, ["schemaVersion", "baseline", "forward", "objectInventorySha256"])) return ["platform migration manifest: expected exactly { schemaVersion, baseline, forward, objectInventorySha256 }"];
  const manifest = raw as Record<string, unknown>;
  if (manifest.schemaVersion !== 1) errors.push("platform migration manifest.schemaVersion: expected 1");
  const baseline = parsePlatformEntry(manifest.baseline, "platform migration manifest.baseline", errors);
  if (baseline?.file !== PLATFORM_BASELINE_FILE) errors.push(`platform migration manifest.baseline.file: expected ${PLATFORM_BASELINE_FILE}`);
  if (!Array.isArray(manifest.forward)) errors.push("platform migration manifest.forward: expected an array");
  const forward = Array.isArray(manifest.forward) ? manifest.forward.map((entry, index) => parsePlatformEntry(entry, `platform migration manifest.forward[${index}]`, errors)) : [];
  if (!isSha256(manifest.objectInventorySha256)) errors.push("platform migration manifest.objectInventorySha256: must be a lowercase 64-hex SHA-256 digest");
  if (!baseline || forward.some((entry) => entry === null)) return errors;
  const entries = [baseline, ...(forward as PlatformMigrationManifestEntry[])];
  const files = entries.map((entry) => entry.file);
  const uniqueFiles = new Set(files);
  if (uniqueFiles.size !== files.length) errors.push("platform migration manifest: duplicate migration filename");
  const forwardFiles = forward.map((entry) => entry?.file ?? "");
  if (forwardFiles.some((file, index) => index > 0 && file <= forwardFiles[index - 1])) errors.push("platform migration manifest.forward: entries must be in strict filename order");
  const migrationByFile = new Map(input.migrations.map((migration) => [migration.file, migration.content]));
  const actualFiles = [...migrationByFile.keys()].sort();
  const expectedFiles = [...uniqueFiles].sort();
  for (const file of expectedFiles) if (!migrationByFile.has(file)) errors.push(`platform migration manifest: missing catalog file ${file}`);
  for (const file of actualFiles) if (!uniqueFiles.has(file)) errors.push(`platform migration manifest: unmanifested catalog file ${file}`);
  for (const entry of entries) { const content = migrationByFile.get(entry.file); if (content !== undefined && sha256(content) !== entry.sha256) errors.push(`platform migration manifest: SHA-256 mismatch for ${entry.file}`); }
  if (input.objectInventoryPayload !== undefined && isSha256(manifest.objectInventorySha256) && sha256(input.objectInventoryPayload) !== manifest.objectInventorySha256) errors.push("platform migration manifest: object inventory SHA-256 mismatch");
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
