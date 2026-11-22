import type { CatalogSubscriptionProfileRef, InstalledCatalogSubscriptionProfile } from "@openlup/core/catalog";
import type { PgQueryExecutor } from "../data/index.js";

/** Read the exact installed profile and policy pins using the native migration-owner executor.
 * @experimental
 */
export async function readInstalledCatalogSubscriptionProfile(
  readExecutor: PgQueryExecutor, ref: CatalogSubscriptionProfileRef,
): Promise<InstalledCatalogSubscriptionProfile | null> {
  const { rows } = await readExecutor.query(
    "SELECT public.catalog_subscription_profile_identity($1::text, $2::integer) AS identity",
    [ref.key, ref.version],
  );
  return (rows[0]?.identity as InstalledCatalogSubscriptionProfile | null | undefined) ?? null;
}
