// The typed native forward publishes this exact version marker inside the
// existing owner-controlled admission function, alongside the live SKU guard.
const NATIVE_TYPED_QUANTITY_GUARD = `EXISTS (
  SELECT 1 FROM pg_catalog.pg_trigger AS guard
  JOIN pg_catalog.pg_proc AS admission ON admission.oid = guard.tgfoid
  WHERE guard.tgrelid = pg_catalog.to_regclass('public.catalog_skus')
    AND guard.tgname = 'catalog_skus_publication_facts_admitted'
    AND guard.tgfoid = pg_catalog.to_regprocedure('public.catalog_publication_admit()')
    AND guard.tgtype = 21 AND guard.tgqual IS NULL
    AND guard.tgconstraint <> 0 AND guard.tgdeferrable AND guard.tginitdeferred
    AND guard.tgenabled IN ('O', 'A')
    AND pg_catalog.strpos(admission.prosrc, E'\\n-- openlup:native-catalog-quantity-v2:live-guard\\n') > 0
)`;

export function catalogTypedQuantitySql(publicationFacts: string): string {
  return `(COALESCE(${publicationFacts}->'quantityVersion' = '2'::jsonb, false) AND ${NATIVE_TYPED_QUANTITY_GUARD})`;
}

/** Native SQL predicate for a row aliased as `sku`. Use only in server-owned SQL. @experimental */
export const CATALOG_SKU_REQUIRES_QUANTITY_V2_SQL = catalogTypedQuantitySql("sku.publication_facts");
