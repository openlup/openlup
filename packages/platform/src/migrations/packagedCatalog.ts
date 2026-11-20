// Module-relative assets; catalog paths remain the canonical ledger identities.
import { readFileSync } from "node:fs";
import { evaluatePlatformMigrationManifestMetadata, type PlatformMigrationManifest, type PlatformMigrationManifestEntry } from "./catalog.js";

type PackagedManifest = {
  schemaVersion: 1;
  catalog: PlatformMigrationManifest;
  migrations: (PlatformMigrationManifestEntry & { source: string })[];
};

/** Read the packaged projection without opening any SQL assets. */
export function readPackagedPlatformManifest(): { projection: PackagedManifest | null; errors: string[] } {
  try {
    const projection = JSON.parse(readFileSync(new URL("../../sql/manifest.json", import.meta.url), "utf8")) as PackagedManifest;
    if (projection.schemaVersion !== 1 || !Array.isArray(projection.migrations)) throw new Error("invalid projection");
    const errors = evaluatePlatformMigrationManifestMetadata(projection.catalog);
    if (errors.length) return { projection: null, errors };
    return { projection, errors: [] };
  } catch (error) {
    return { projection: null, errors: [`packaged platform migration manifest refused: ${String(error)}`] };
  }
}

/** @internal Position in the canonical portable migration rail. */
export function packagedPlatformMigrationPosition(catalogPath: string, sha256: string): number {
  const { projection, errors } = readPackagedPlatformManifest();
  if (!projection) throw new Error(errors.join("; "));
  const entries = [projection.catalog.baseline, ...projection.catalog.forward];
  const index = entries.findIndex(entry => entry.file === catalogPath);
  if (index < 0 || entries[index]!.sha256 !== sha256)
    throw new Error(`packaged platform migration position refused: ${catalogPath}`);
  return index;
}

export function readPackagedPlatformCatalog(): {
  migrations: { file: string; content: string }[]; errors: string[]; manifest: PlatformMigrationManifest | null;
} {
  const migrations: { file: string; content: string }[] = [];
  const { projection, errors } = readPackagedPlatformManifest();
  if (!projection) return { migrations, errors, manifest: null };
  for (const entry of projection.migrations) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/u.test(entry.file) || entry.source !== `db/platform/migrations/${entry.file}`) {
      errors.push(`packaged platform migration path refused: ${entry.source}`);
      continue;
    }
    try { migrations.push({ file: entry.source, content: readFileSync(new URL(`../../sql/${entry.file}`, import.meta.url), "utf8") }); }
    catch { errors.push(`packaged platform migration missing or unreadable: ${entry.source}`); }
  }
  return { migrations, errors, manifest: projection.catalog };
}
