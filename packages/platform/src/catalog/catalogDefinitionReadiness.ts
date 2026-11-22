import { validateCatalogSubscriptionProfile, type CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import type { CatalogRegistryObservation } from "@openlup/core/readiness";
import type { PgQueryExecutor } from "../data/index.js";
import type { CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import { catalogSubscriptionProfileIdentity, readInstalledCatalogSubscriptionProfile } from "./installedSubscriptionProfiles.js";

/** Read-only, uncached live-binding probe. Profile declarations require the migration owner executor.
 * Reference-only checks require an owner or BYPASSRLS reader for both tables.
 * @experimental
 */
export async function observeCatalogDefinitionReadiness(
  readExecutor: PgQueryExecutor, registry: CatalogProductTypeRegistry, database: string,
  profiles?: readonly CatalogSubscriptionProfileV1[],
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
  const referencedVersions = await Promise.all(result.bindings.map(async row => {
    const definition = registry.resolve(row);
    const registryDigest = definition ? catalogDefinitionDigest(definition) : null;
    const ref = definition?.subscriptionProfileRef;
    const binding = { ...row, registryDigest };
    if (!profiles || !ref || result.restricted !== false) return binding;

    const local = profiles.find(profile => profile.key === ref.key && profile.version === ref.version);
    const installed = local ? await readInstalledCatalogSubscriptionProfile(readExecutor, ref) : null;
    if (!local || !installed) return { ...binding, profileBindingIssue: { ...ref, reason: "profile_binding_missing" as const } };
    const declared = validateCatalogSubscriptionProfile(local);
    if ("issue" in declared || installed.profileDigest !== catalogSubscriptionProfileIdentity(declared.profile).profileDigest) {
      return { ...binding, profileBindingIssue: { ...ref, reason: "profile_binding_mismatch" as const } };
    }
    return binding;
  }));
  return { database, complete: result.restricted === false, referencedVersions };
}

/** Opt-in catalogue write guard. Probe failures propagate and the supplied write is never called.
 * @experimental
 */
export function createCatalogDefinitionWriteGuard(
  readExecutor: PgQueryExecutor, registry: CatalogProductTypeRegistry, profiles?: readonly CatalogSubscriptionProfileV1[],
) {
  return async <T>(write: () => Promise<T>): Promise<T> => {
    const observation = await observeCatalogDefinitionReadiness(readExecutor, registry, "catalogue-write", profiles);
    if (observation.complete === false || observation.referencedVersions.some(ref => ref.definitionDigest === null || ref.registryDigest !== ref.definitionDigest)) {
      throw Object.assign(new Error("registry_missing_referenced_version"), { code: "registry_missing_referenced_version" });
    }
    const profile = observation.referencedVersions.find(ref => ref.profileBindingIssue)?.profileBindingIssue;
    if (profile) {
      const fix = "Bind the matching installed subscription profile declaration in the catalogue profile binding.";
      throw Object.assign(new Error(`${profile.reason}: ${profile.key}@${profile.version}. ${fix}`), {
        code: "catalog_profile_binding_invalid", reason: profile.reason, profileKey: profile.key, profileVersion: profile.version, fix,
      });
    }
    return write();
  };
}
