/** Effective-authority SQL is isolated from the incumbent exported statements. */
const ANCHORS = `SELECT pe.unit_price_minor FROM public.price_entries pe
  WHERE pe.variant_id = s.id AND pe.price_list_id = %LIST% AND pe.active
    AND pe.min_qty = 1 AND pe.amount_kind = 'gross'
    AND pe.valid_from <= $3::timestamptz AND (pe.valid_to IS NULL OR pe.valid_to > $3::timestamptz)
    AND (pe.mode = $4::text OR (pe.mode = 'any' AND NOT EXISTS (
      SELECT 1 FROM public.price_entries exact WHERE exact.variant_id = s.id
        AND exact.price_list_id = pe.price_list_id AND exact.active AND exact.min_qty = 1
        AND exact.amount_kind = 'gross' AND exact.mode = $4::text
        AND exact.valid_from <= $3::timestamptz AND (exact.valid_to IS NULL OR exact.valid_to > $3::timestamptz))))`;
const FACTS = `s.status AS sku_status, s.sellable_standalone, s.sellable_in_subscription,
  s.net_weight_g, pr.status AS product_status,
  (pr.primary_sku_id IS NOT NULL AND revision.id IS NOT NULL) AS document_ready,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('issuer', identifier.issuer, 'normalizedValue', identifier.normalized_value,
    'kind', identifier.identifier_kind, 'packKind', identifier.pack_kind, 'packQuantity', identifier.quantity, 'isPrimary', identifier.is_primary))
    FROM public.catalog_sku_identifiers identifier WHERE identifier.catalog_sku_id = s.id), '[]'::jsonb) AS identifiers`;
const REFERENCE = `(SELECT (array_agg(candidate.unit_price_minor))[1] FROM (${ANCHORS}) candidate)`;
const COUNT = `(SELECT count(*) FROM (${ANCHORS}) candidate)`;
export const COMPONENT_SQL = `
  SELECT c.bundle_id, s.sku, s.title, pr.slug AS product_slug, s.id AS variant_id,
    c.quantity, c.is_addon, c.sort_order, ${FACTS},
    ${REFERENCE.replace("%LIST%", "$2::uuid")} AS reference_unit_price_minor,
    ${COUNT.replace("%LIST%", "$2::uuid")} AS reference_price_count
  FROM public.catalog_bundle_components c
  JOIN public.catalog_skus s ON s.id = c.catalog_sku_id
  JOIN public.catalog_products pr ON pr.id = s.product_id
  LEFT JOIN public.catalog_product_document_revisions revision ON revision.id = pr.current_document_revision_id AND revision.product_id = pr.id
  WHERE c.bundle_id = $1::uuid ORDER BY c.sort_order, s.sku`;
export const FEED_COMPONENT_SQL = `
  SELECT c.bundle_id, s.sku, s.title, pr.slug AS product_slug, s.id AS variant_id,
    c.quantity, c.is_addon, c.sort_order, ${FACTS},
    ${REFERENCE.replace("%LIST%", "selected.price_list_id")} AS reference_unit_price_minor,
    ${COUNT.replace("%LIST%", "selected.price_list_id")} AS reference_price_count
  FROM unnest($1::uuid[], $2::uuid[]) AS selected(bundle_id, price_list_id)
  JOIN public.catalog_bundle_components c ON c.bundle_id = selected.bundle_id
  JOIN public.catalog_skus s ON s.id = c.catalog_sku_id
  JOIN public.catalog_products pr ON pr.id = s.product_id
  LEFT JOIN public.catalog_product_document_revisions revision ON revision.id = pr.current_document_revision_id AND revision.product_id = pr.id
  ORDER BY c.bundle_id, c.sort_order, s.sku`;
export const PRICE_SQL = `
  SELECT p.mode, p.price_list_id, p.target_price_minor, list.currency, p.amount_kind, p.active, p.valid_from, p.valid_to
  FROM public.catalog_bundle_prices p JOIN public.price_lists list ON list.id = p.price_list_id
  WHERE p.bundle_id = $1::uuid ORDER BY p.valid_from DESC`;
export const OWN_LIST_SQL = `
  SELECT list.id, list.currency, list.region_code, p.mode
  FROM public.catalog_bundle_prices p JOIN public.price_lists list ON list.id = p.price_list_id
  WHERE p.bundle_id = $1::uuid AND p.active AND p.amount_kind = 'gross'
    AND (p.mode = $2::text OR p.mode = 'any') AND list.status = 'active'
    AND p.valid_from <= $3::timestamptz AND (p.valid_to IS NULL OR p.valid_to > $3::timestamptz)
    AND list.valid_from <= $3::timestamptz AND (list.valid_to IS NULL OR list.valid_to > $3::timestamptz)
  ORDER BY p.valid_from DESC`;
export const CURRENCY_LIST_SQL = `
  SELECT id, currency, region_code FROM public.price_lists
  WHERE currency = $1::text AND status = 'active' AND ($2::text IS NULL OR region_code = $2::text)
    AND valid_from <= $3::timestamptz AND (valid_to IS NULL OR valid_to > $3::timestamptz)`;
export const FEED_SQL = `
  SELECT b.id, b.code, b.title, b.fulfillment_mode, p.mode, p.target_price_minor, p.price_list_id, list.currency, list.region_code
  FROM public.catalog_bundles b
  JOIN public.catalog_bundle_prices p ON p.bundle_id = b.id AND p.active
  JOIN public.price_lists list ON list.id = p.price_list_id
  WHERE b.status = 'active' AND p.amount_kind = 'gross' AND p.target_price_minor > 0
    AND list.status = 'active' AND ($1::text IS NULL OR list.currency = $1::text)
    AND ($2::text IS NULL OR list.region_code = $2::text) AND (p.mode = $4::text OR p.mode = 'any')
    AND p.valid_from <= $3::timestamptz AND (p.valid_to IS NULL OR p.valid_to > $3::timestamptz)
    AND list.valid_from <= $3::timestamptz AND (list.valid_to IS NULL OR list.valid_to > $3::timestamptz)
  ORDER BY b.code, p.valid_from DESC`;

const SUMMARY_COLUMNS = `b.id, b.code, b.title, b.status, b.fulfillment_mode, b.updated_at,
  b.composition_constraint, b.metadata,
  (SELECT count(*) FROM public.catalog_bundle_components c WHERE c.bundle_id = b.id) AS component_count,
  EXISTS (SELECT 1 FROM public.catalog_bundle_prices p JOIN public.price_lists list ON list.id = p.price_list_id
    WHERE p.bundle_id = b.id AND p.active AND p.amount_kind = 'gross' AND p.target_price_minor > 0
      AND p.mode IN ('one_time', 'any') AND list.status = 'active'
      AND p.valid_from <= CURRENT_TIMESTAMP AND (p.valid_to IS NULL OR p.valid_to > CURRENT_TIMESTAMP)
      AND list.valid_from <= CURRENT_TIMESTAMP AND (list.valid_to IS NULL OR list.valid_to > CURRENT_TIMESTAMP)) AS has_active_target_price`;
export const DETAIL_SQL = `SELECT ${SUMMARY_COLUMNS} FROM public.catalog_bundles b WHERE b.code = $1`;
export const LIST_SQL = `SELECT ${SUMMARY_COLUMNS} FROM public.catalog_bundles b
  WHERE ($1::text = 'all' OR b.status = $1::text)
    AND ($2::text IS NULL OR b.code ILIKE '%' || $2 || '%' OR b.title ILIKE '%' || $2 || '%')
  ORDER BY b.code LIMIT $3 OFFSET $4`;
