-- pgTAP: seed-commerce-v2 preserves current custom regional prices.
-- The guarded local DB wrapper injects the canonical seed at each marked line.

BEGIN;
-- SEED_COMMERCE_V2_INCLUDE
SELECT plan(4);

CREATE TEMP TABLE _seed_scope ON COMMIT DROP AS
SELECT list.id, list.region_code, list.currency
FROM public.price_lists list
JOIN public.price_entries one_time ON one_time.price_list_id = list.id
JOIN public.price_entries subscription ON subscription.price_list_id = list.id
  AND subscription.variant_id = one_time.variant_id
WHERE list.status = 'active' AND list.valid_from <= now() AND (list.valid_to IS NULL OR list.valid_to > now())
  AND one_time.mode = 'one_time' AND one_time.min_qty = 1 AND one_time.unit_price_minor = 1490
  AND one_time.amount_kind = 'gross' AND one_time.active = true AND one_time.valid_from <= now()
  AND (one_time.valid_to IS NULL OR one_time.valid_to > now())
  AND subscription.mode = 'subscription' AND subscription.min_qty = 1 AND subscription.unit_price_minor = 1340
  AND subscription.amount_kind = 'gross' AND subscription.active = true AND subscription.valid_from <= now()
  AND (subscription.valid_to IS NULL OR subscription.valid_to > now())
ORDER BY list.valid_from DESC, list.id DESC
LIMIT 1;

CREATE TEMP TABLE _seed_variants ON COMMIT DROP AS
SELECT row_number() OVER (ORDER BY entry.variant_id)::integer AS ordinal, entry.variant_id AS id
FROM public.price_entries entry
JOIN _seed_scope scope ON scope.id = entry.price_list_id
WHERE entry.mode = 'one_time' AND entry.min_qty = 1 AND entry.unit_price_minor = 1490
  AND entry.amount_kind = 'gross' AND entry.active = true AND entry.valid_from <= now()
  AND (entry.valid_to IS NULL OR entry.valid_to > now())
ORDER BY entry.variant_id
LIMIT 2;

UPDATE public.price_lists list
SET status = 'archived'
FROM _seed_scope scope
WHERE (list.region_code, list.currency) = (scope.region_code, scope.currency)
  AND list.status = 'active' AND list.valid_from <= now()
  AND (list.valid_to IS NULL OR list.valid_to > now());

CREATE TEMP TABLE _custom_list (id uuid) ON COMMIT DROP;
WITH inserted_list AS (
  INSERT INTO public.price_lists (name, region_code, currency, status, valid_from)
  SELECT 'seed-current-custom', region_code, currency, 'active', now() - interval '1 microsecond'
  FROM _seed_scope
  RETURNING id
)
INSERT INTO _custom_list SELECT id FROM inserted_list;

INSERT INTO public.price_entries (
  price_list_id, variant_id, mode, min_qty, unit_price_minor, amount_kind, active, valid_from
)
SELECT list.id, variant.id,
  CASE variant.ordinal WHEN 1 THEN 'one_time' ELSE 'any' END,
  1, CASE variant.ordinal WHEN 1 THEN 1590 ELSE 1690 END, 'gross', true,
  now() - interval '1 microsecond'
FROM _custom_list list CROSS JOIN _seed_variants variant;

-- SEED_COMMERCE_V2_INCLUDE

CREATE TEMP VIEW _current_prices AS
SELECT entry.variant_id, entry.mode, entry.min_qty, entry.unit_price_minor, entry.valid_from
FROM public.price_entries entry
JOIN public.price_lists list ON list.id = entry.price_list_id
JOIN _seed_scope scope ON (list.region_code, list.currency) = (scope.region_code, scope.currency)
WHERE list.status = 'active' AND list.valid_from <= now() AND (list.valid_to IS NULL OR list.valid_to > now())
  AND entry.active = true AND entry.valid_from <= now() AND (entry.valid_to IS NULL OR entry.valid_to > now());

SELECT is(
  (SELECT price.unit_price_minor FROM _current_prices price JOIN _seed_variants variant ON variant.id = price.variant_id
   WHERE variant.ordinal = 1 AND price.mode = 'one_time' AND price.min_qty <= 1
   ORDER BY price.min_qty DESC, price.valid_from DESC LIMIT 1),
  1590, 'direct current selection preserves the custom price'
);
SELECT is(
  (SELECT count(*)::integer FROM _current_prices price JOIN _seed_variants variant ON variant.id = price.variant_id
   WHERE variant.ordinal = 1 AND price.mode = 'one_time' AND price.min_qty = 1 AND price.unit_price_minor = 1490),
  0, 'direct custom price prevents a seeded default'
);
SELECT is(
  COALESCE(
    (SELECT price.unit_price_minor FROM _current_prices price JOIN _seed_variants variant ON variant.id = price.variant_id
     WHERE variant.ordinal = 2 AND price.mode = 'one_time' AND price.min_qty <= 1
     ORDER BY price.min_qty DESC, price.valid_from DESC LIMIT 1),
    (SELECT price.unit_price_minor FROM _current_prices price JOIN _seed_variants variant ON variant.id = price.variant_id
     WHERE variant.ordinal = 2 AND price.mode = 'any' AND price.min_qty <= 1
     ORDER BY price.min_qty DESC, price.valid_from DESC LIMIT 1)
  ),
  1690, 'fallback selection preserves the custom any price'
);
SELECT is(
  (SELECT count(*)::integer FROM _current_prices price JOIN _seed_variants variant ON variant.id = price.variant_id
   WHERE variant.ordinal = 2 AND price.mode IN ('one_time', 'subscription')
     AND price.min_qty = 1 AND price.unit_price_minor IN (1490, 1340)),
  0, 'any price prevents seeded direct defaults for both requested modes'
);

SELECT * FROM finish();
ROLLBACK;
