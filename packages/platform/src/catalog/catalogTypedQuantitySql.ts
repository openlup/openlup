// The native forward adds this revision metadata in the same transaction that
// installs the deferred live marker guard. Looking at schema metadata preserves
// the runtime's column grants and keeps classification off on the predecessor.
const NATIVE_TYPED_QUANTITY_SCHEMA = `EXISTS (
  SELECT 1 FROM pg_catalog.pg_attribute
  WHERE attrelid = pg_catalog.to_regclass('public.catalog_sku_revisions')
    AND attname = 'net_content_storage' AND atttypid = 'pg_catalog.text'::pg_catalog.regtype AND NOT attisdropped
)`;

export function catalogTypedQuantitySql(publicationFacts: string): string {
  return `(COALESCE(${publicationFacts}->'quantityVersion' = '2'::jsonb, false) AND ${NATIVE_TYPED_QUANTITY_SCHEMA})`;
}
