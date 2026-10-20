/**
 * The statements the direct-Postgres bundle read adapter renders.
 *
 * They live beside the adapter rather than inside it because they are the part a
 * reader comes here to check — which relations are touched, which columns are
 * asked for, and how a component's reference price is resolved — and reading them
 * should not mean scrolling past the row marshalling that consumes them.
 */

export const SUMMARY_COLUMNS = `
  b.id, b.code, b.title, b.status, b.fulfillment_mode, b.updated_at,
  b.composition_constraint, b.metadata,
  (SELECT count(*) FROM public.catalog_bundle_components c WHERE c.bundle_id = b.id)
    AS component_count,
  EXISTS (SELECT 1 FROM public.catalog_bundle_prices p WHERE p.bundle_id = b.id AND p.active)
    AS has_active_target_price`;

export const LIST_FILTER = `
  WHERE ($1::text = 'all' OR b.status = $1::text)
    AND ($2::text IS NULL OR b.code ILIKE '%' || $2 || '%' OR b.title ILIKE '%' || $2 || '%')`;

export const LIST_SQL = `SELECT ${SUMMARY_COLUMNS} FROM public.catalog_bundles b ${LIST_FILTER}
  ORDER BY b.code LIMIT $3 OFFSET $4`;

export const COUNT_SQL = `SELECT count(*) AS total FROM public.catalog_bundles b ${LIST_FILTER}`;

export const DETAIL_SQL = `SELECT ${SUMMARY_COLUMNS} FROM public.catalog_bundles b WHERE b.code = $1`;

/**
 * The unit's reference price in ONE named list: the lowest tier that is active,
 * newest window first. A unit the list prices nothing for resolves to NULL rather
 * than dropping the component, so a caller sees an unpriced part instead of a
 * shorter bill of materials.
 */
export const REFERENCE_PRICE = `(
  SELECT pe.unit_price_minor FROM public.price_entries pe
   WHERE pe.variant_id = s.id AND pe.price_list_id = %LIST% AND pe.active
   ORDER BY pe.min_qty ASC, pe.valid_from DESC LIMIT 1)`;

export const COMPONENT_SQL = `
  SELECT c.bundle_id, s.sku, s.title, pr.slug AS product_slug, s.id AS variant_id,
         c.quantity, c.is_addon, c.sort_order,
         ${REFERENCE_PRICE.replace("%LIST%", "$2::uuid")} AS reference_unit_price_minor
    FROM public.catalog_bundle_components c
    JOIN public.catalog_skus s ON s.id = c.catalog_sku_id
    JOIN public.catalog_products pr ON pr.id = s.product_id
   WHERE c.bundle_id = $1::uuid
   ORDER BY c.sort_order, s.sku`;

// One statement for the whole feed: each bundle carries its own price list, so the
// per-bundle list is zipped in rather than looped over.
export const FEED_COMPONENT_SQL = `
  SELECT c.bundle_id, s.sku, s.title, pr.slug AS product_slug, s.id AS variant_id,
         c.quantity, c.is_addon, c.sort_order,
         ${REFERENCE_PRICE.replace("%LIST%", "selected.price_list_id")} AS reference_unit_price_minor
    FROM unnest($1::uuid[], $2::uuid[]) AS selected(bundle_id, price_list_id)
    JOIN public.catalog_bundle_components c ON c.bundle_id = selected.bundle_id
    JOIN public.catalog_skus s ON s.id = c.catalog_sku_id
    JOIN public.catalog_products pr ON pr.id = s.product_id
   ORDER BY c.bundle_id, c.sort_order, s.sku`;

export const PRICE_SQL = `
  SELECT p.mode, p.target_price_minor, list.currency, p.amount_kind, p.active,
         p.valid_from, p.valid_to
    FROM public.catalog_bundle_prices p
    JOIN public.price_lists AS list ON list.id = p.price_list_id
   WHERE p.bundle_id = $1::uuid
   ORDER BY p.valid_from DESC`;

export const OWN_LIST_SQL = `
  SELECT list.id, list.currency
    FROM public.catalog_bundle_prices p
    JOIN public.price_lists AS list ON list.id = p.price_list_id
   WHERE p.bundle_id = $1::uuid AND p.active AND ($2::text IS NULL OR p.mode = $2::text)
   ORDER BY p.valid_from DESC LIMIT 1`;

export const CURRENCY_LIST_SQL = `
  SELECT id, currency FROM public.price_lists
   WHERE currency = $1::text AND status = 'active'
   ORDER BY created_at DESC LIMIT 1`;

export const FEED_SQL = `
  SELECT b.id, b.code, b.title, b.fulfillment_mode, p.mode, p.target_price_minor,
         p.price_list_id, list.currency
    FROM public.catalog_bundles b
    JOIN public.catalog_bundle_prices p ON p.bundle_id = b.id AND p.active
    JOIN public.price_lists AS list ON list.id = p.price_list_id
   WHERE b.status = 'active' AND ($1::text IS NULL OR list.currency = $1::text)
   ORDER BY b.code, p.valid_from DESC`;

export const HISTORY_SQL = `
  SELECT id, bundle_code, action, before_state, after_state, created_at
    FROM public.catalog_bundle_write_events
   WHERE bundle_code = $1::text
   ORDER BY created_at DESC LIMIT $2 OFFSET $3`;

export const HISTORY_COUNT_SQL = `
  SELECT count(*) AS total FROM public.catalog_bundle_write_events WHERE bundle_code = $1::text`;
