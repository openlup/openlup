import type { CatalogSubscriptionProfileRef, CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import type { PgQueryExecutor } from "../data/index.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";

export async function hasInstalledSubscriptionProfile(db: PgQueryExecutor,
  ref: CatalogSubscriptionProfileRef, profile: CatalogSubscriptionProfileV1): Promise<boolean> {
  const { rows } = await db.query(`SELECT DISTINCT p AS profile FROM public.catalog_definition_installs i
    CROSS JOIN LATERAL jsonb_array_elements(i.receipt->'subscriptionProfileDefinitions') p
    WHERE p->>'key'=$1 AND p->'version'=to_jsonb($2::integer)`, [ref.key, ref.version]);
  return rows.length === 1 && canonicalCatalogDraftJson(rows[0].profile) === canonicalCatalogDraftJson(profile);
}
