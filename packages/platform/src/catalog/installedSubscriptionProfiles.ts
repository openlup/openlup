import { createHash } from "node:crypto";
import { validateCatalogSubscriptionProfile, type CatalogSubscriptionProfileRef, type CatalogSubscriptionProfileV1 } from "@openlup/core/catalog";
import type { PgQueryExecutor } from "../data/index.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";

export async function hasInstalledSubscriptionProfile(db: PgQueryExecutor,
  ref: CatalogSubscriptionProfileRef, resolved: { profile: CatalogSubscriptionProfileV1; digest: string }): Promise<boolean> {
  const validated = validateCatalogSubscriptionProfile(resolved.profile);
  if ("issue" in validated || createHash("sha256").update(JSON.stringify(validated.profile)).digest("hex") !== resolved.digest) return false;
  const { rows } = await db.query(`SELECT DISTINCT p AS profile FROM public.catalog_definition_installs i
    CROSS JOIN LATERAL jsonb_array_elements(i.receipt->'subscriptionProfileDefinitions') p
    WHERE p->>'key'=$1 AND p->'version'=to_jsonb($2::integer)`, [ref.key, ref.version]);
  return rows.length === 1 && canonicalCatalogDraftJson(rows[0].profile) === canonicalCatalogDraftJson(validated.profile);
}
