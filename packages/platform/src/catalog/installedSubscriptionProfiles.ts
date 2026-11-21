import { canonicalCatalogSubscriptionProfileJson, type CatalogSubscriptionProfileRef,
  type CatalogSubscriptionProfileV1, type InstalledCatalogSubscriptionProfile } from "@openlup/core/catalog";
import { createHash } from "node:crypto";
import type { PgQueryExecutor } from "../data/index.js";

// Callers hash only the normalized declaration returned by the Core validator.
export function catalogSubscriptionProfileIdentity(profile: CatalogSubscriptionProfileV1): InstalledCatalogSubscriptionProfile {
  return {
    profileKey: profile.key, profileVersion: profile.version,
    profileDigest: createHash("sha256").update(canonicalCatalogSubscriptionProfileJson(profile)).digest("hex"),
    policyRef: profile.policyRef, policyDigest: profile.policyDigest,
  };
}

/** Read one exact installed identity using the migration owner executor.
 * @experimental
 */
export async function readInstalledCatalogSubscriptionProfile(
  db: PgQueryExecutor, ref: CatalogSubscriptionProfileRef,
): Promise<InstalledCatalogSubscriptionProfile | null> {
  const { rows } = await db.query(
    "SELECT public.catalog_subscription_profile_identity($1::text, $2::integer) AS identity",
    [ref.key, ref.version],
  );
  return rows[0].identity as InstalledCatalogSubscriptionProfile | null;
}
