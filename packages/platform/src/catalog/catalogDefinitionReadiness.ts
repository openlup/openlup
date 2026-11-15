import type { CatalogRegistryObservation } from "@openlup/core/readiness";
import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";

/** Read-only, uncached live-binding probe. The application owns observer permissions and database identity. */
export async function observeCatalogDefinitionReadiness(
  readExecutor: PgQueryExecutor, registry: CatalogProductTypeRegistry, database: string,
): Promise<CatalogRegistryObservation> {
  const { rows } = await readExecutor.query(
    `SELECT DISTINCT t.type_key AS key, t.version, t.definition_digest AS "definitionDigest"
     FROM public.catalog_products p JOIN public.catalog_type_versions t
       ON t.type_key = p.type_key AND t.version = p.type_version ORDER BY t.type_key, t.version`,
  );
  return { database, referencedVersions: rows.map(value => {
    const row = value as { key: string; version: number; definitionDigest: string };
    const definition = registry.resolve(row);
    return { ...row, registryDigest: definition ? catalogDefinitionDigest(definition) : null };
  }) };
}

/** Opt-in catalogue write guard. Probe failures propagate and the supplied write is never called. */
export function createCatalogDefinitionWriteGuard(readExecutor: PgQueryExecutor, registry: CatalogProductTypeRegistry) {
  return async <T>(write: () => Promise<T>): Promise<T> => {
    const observation = await observeCatalogDefinitionReadiness(readExecutor, registry, "catalogue-write");
    if (observation.referencedVersions.some(ref => ref.registryDigest !== ref.definitionDigest)) {
      throw Object.assign(new Error("registry_missing_referenced_version"), { code: "registry_missing_referenced_version" });
    }
    return write();
  };
}
