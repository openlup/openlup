// Module-relative assets; catalog paths remain the canonical ledger identities.
import { readFileSync } from "node:fs";
import type { PlatformMigrationManifest, PlatformMigrationManifestEntry } from "./catalog.js";

type PackagedManifest = {
  schemaVersion: 1;
  catalog: PlatformMigrationManifest;
  migrations: (PlatformMigrationManifestEntry & { source: string })[];
};

export function readPackagedPlatformCatalog(): {
  migrations: { file: string; content: string }[]; errors: string[]; manifest: PlatformMigrationManifest | null;
} {
  const migrations: { file: string; content: string }[] = [], errors: string[] = [];
  let projection: PackagedManifest;
  try {
    projection = JSON.parse(readFileSync(new URL("../../sql/manifest.json", import.meta.url), "utf8")) as PackagedManifest;
    if (projection.schemaVersion !== 1 || !Array.isArray(projection.migrations) || !projection.catalog) throw new Error("invalid projection");
  } catch (error) {
    return { migrations, errors: [`packaged platform migration manifest refused: ${String(error)}`], manifest: null };
  }
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
