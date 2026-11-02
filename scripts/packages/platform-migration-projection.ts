/** Generated projection only: canonical manifest and issued SQL remain the owners. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

export function checkPlatformMigrationProjection(root: string, update = false): string[] {
  // Pre-build policy tooling must remain runnable before workspace dist exists.
  // Ship its validator/selection as a checked exact copy, with one authoring owner.
  const owner = readFileSync(resolve(root, "scripts/platform-migration-manifest.ts"));
  const target = resolve(root, "packages/platform/src/migrations/catalog.ts");
  if (update) writeFileSync(target, owner);
  const codeErrors: string[] = [];
  try { if (!owner.equals(readFileSync(target))) codeErrors.push("packaged migration selection drift: scripts/platform-migration-manifest.ts"); }
  catch { codeErrors.push("packaged migration selection missing: scripts/platform-migration-manifest.ts"); }
  const catalog = JSON.parse(readFileSync(resolve(root, "config/platform-migration-manifest.json"), "utf8"));
  const entries = new Map<string, { file: string; sha256: string }>();
  for (const plan of [catalog, catalog.qualified, catalog.qualifiedAdmin].filter(Boolean)) {
    for (const entry of [plan.baseline, ...plan.forward]) {
      if (!/^db\/platform\/migrations\/[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/u.test(entry.file)) throw new Error(`invalid canonical migration: ${entry.file}`);
      const prior = entries.get(entry.file);
      if (prior && prior.sha256 !== entry.sha256) throw new Error(`inconsistent canonical migration: ${entry.file}`);
      entries.set(entry.file, entry);
    }
  }
  const migrations = [...entries.values()].sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    .map(entry => ({ file: basename(entry.file), source: entry.file, sha256: entry.sha256 }));
  const projection = JSON.stringify({ schemaVersion: 1, catalog, migrations }, null, 2) + "\n";
  const path = resolve(root, "packages/platform/sql/manifest.json"), errors: string[] = [...codeErrors];
  if (update) writeFileSync(path, projection);
  try { if (readFileSync(path, "utf8") !== projection) errors.push("packaged platform migration manifest drift: regenerate the package projection (packages/platform/README.md)"); }
  catch { errors.push("packaged platform migration manifest missing: regenerate the package projection (packages/platform/README.md)"); }
  for (const entry of migrations) {
    const bytes = readFileSync(resolve(root, entry.source));
    if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) { errors.push(`canonical migration SHA-256 mismatch: ${entry.source}`); continue; }
    const destination = resolve(root, "packages/platform/sql", entry.file);
    if (update) writeFileSync(destination, bytes);
    try { if (!bytes.equals(readFileSync(destination))) errors.push(`packaged migration drift: ${entry.source}`); }
    catch { errors.push(`packaged migration missing: ${entry.source}`); }
  }
  return errors;
}
