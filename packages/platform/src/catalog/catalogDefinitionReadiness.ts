import type { CatalogRegistryObservation } from "@openlup/core/readiness";
import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";

/** Read-only, uncached live-binding probe. Requires an owner or BYPASSRLS reader for both tables. */
export async function observeCatalogDefinitionReadiness(
  readExecutor: PgQueryExecutor, registry: CatalogProductTypeRegistry, database: string,
): Promise<CatalogRegistryObservation> {
  const { rows } = await readExecutor.query(
    `SELECT row_security_active('public.catalog_products') OR row_security_active('public.catalog_type_versions') AS restricted,
       COALESCE((SELECT jsonb_agg(binding) FROM (
         SELECT DISTINCT p.type_key AS key, p.type_version AS version, t.definition_digest AS "definitionDigest"
         FROM public.catalog_products p LEFT JOIN public.catalog_type_versions t
           ON t.type_key = p.type_key AND t.version = p.type_version
         WHERE p.type_key IS NOT NULL ORDER BY p.type_key, p.type_version
       ) binding), '[]'::jsonb) AS bindings`,
  );
  const result = rows[0] as { restricted: boolean; bindings: { key: string; version: number; definitionDigest: string | null }[] };
  return { database, complete: result.restricted === false, referencedVersions: result.bindings.map(row => {
    const definition = registry.resolve(row);
    return { ...row, registryDigest: definition ? catalogDefinitionDigest(definition) : null };
  }) };
}

/** Opt-in catalogue write guard. Probe failures propagate and the supplied write is never called. */
export function createCatalogDefinitionWriteGuard(readExecutor: PgQueryExecutor, registry: CatalogProductTypeRegistry) {
  return async <T>(write: () => Promise<T>): Promise<T> => {
    const observation = await observeCatalogDefinitionReadiness(readExecutor, registry, "catalogue-write");
    if (observation.complete === false || observation.referencedVersions.some(ref => ref.definitionDigest === null || ref.registryDigest !== ref.definitionDigest)) {
      throw Object.assign(new Error("registry_missing_referenced_version"), { code: "registry_missing_referenced_version" });
    }
    return write();
  };
}
