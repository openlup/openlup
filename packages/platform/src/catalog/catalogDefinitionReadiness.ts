import type { CatalogSubscriptionProfileResolver } from "@openlup/core/catalog";
import { observeCatalogSubscriptionCadenceBound } from "./observeProfileCadenceBound.js";
import type { CatalogRegistryObservation } from "@openlup/core/readiness";
import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import { hasInstalledSubscriptionProfile } from "./installedSubscriptionProfiles.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";

/** Read-only, uncached live-binding probe. Requires an owner or BYPASSRLS reader for both tables.
 * @experimental
 */
export async function observeCatalogDefinitionReadiness(
  readExecutor: PgQueryExecutor, registry: CatalogProductTypeRegistry, database: string,
  profiles?: CatalogSubscriptionProfileResolver,
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
  let installedBound: number | null | undefined;
  const referencedVersions = [];
  for (const row of result.bindings) {
    const definition = registry.resolve(row);
    let registryDigest = definition ? catalogDefinitionDigest(definition) : null;
    if (definition?.subscriptionProfileRef) {
      const resolved = profiles?.resolve(definition.subscriptionProfileRef);
      if (resolved?.bound && installedBound === undefined) installedBound = await observeCatalogSubscriptionCadenceBound(readExecutor);
      if (!resolved?.bound || installedBound == null || Math.max(...resolved.profile.allowedCadenceDays) > installedBound
        || !await hasInstalledSubscriptionProfile(readExecutor, definition.subscriptionProfileRef, resolved)) {
        registryDigest = null;
      }
    }
    referencedVersions.push({ ...row, registryDigest });
  }
  return { database, complete: result.restricted === false, referencedVersions };
}

/** Opt-in catalogue write guard. Probe failures propagate and the supplied write is never called.
 * @experimental
 */
export function createCatalogDefinitionWriteGuard(readExecutor: PgQueryExecutor, registry: CatalogProductTypeRegistry) {
  return async <T>(write: () => Promise<T>): Promise<T> => {
    const observation = await observeCatalogDefinitionReadiness(readExecutor, registry, "catalogue-write");
    if (observation.complete === false || observation.referencedVersions.some(ref => ref.definitionDigest === null || ref.registryDigest !== ref.definitionDigest)) {
      throw Object.assign(new Error("registry_missing_referenced_version"), { code: "registry_missing_referenced_version" });
    }
    return write();
  };
}
