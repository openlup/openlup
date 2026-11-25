CREATE OR REPLACE FUNCTION public.catalog_admission_derived_subscription_prices(
  p_currency text, p_quote jsonb, p_draft jsonb, p_at timestamptz
)
RETURNS integer[]
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  WITH lines AS (
    SELECT draft.position, draft.line, (p_quote#>'{quote,lines}') -> (draft.position - 1)::integer AS quoted
    FROM jsonb_array_elements(
      CASE WHEN jsonb_typeof(p_draft->'lines') = 'array' THEN p_draft->'lines' ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS draft(line, position)
  ), claims AS (
    SELECT *, line->'catalogFacts' AS facts, quoted->'catalogFacts' AS quoted_facts
    FROM lines
  ), paired AS (
    SELECT *,
      CASE WHEN pg_input_is_valid(facts->>'policyRevisionId', 'pg_catalog.uuid')
        THEN (facts->>'policyRevisionId')::uuid END AS policy_id,
      CASE WHEN pg_input_is_valid(facts->>'basePriceEntryId', 'pg_catalog.uuid')
        THEN (facts->>'basePriceEntryId')::uuid END AS base_id,
      CASE WHEN jsonb_typeof(line->'quantity') = 'number' AND pg_input_is_valid(line->>'quantity', 'pg_catalog.int4')
        THEN (line->>'quantity')::integer END AS quantity
    FROM claims
    WHERE facts->>'version' = 'catalog_facts_v2' AND quoted_facts->>'version' = 'catalog_facts_v2'
      AND quoted->'sku' = line->'sku' AND quoted->'quantity' = line->'quantity'
      AND p_quote#>>'{quote,currency}' = p_currency AND p_draft->>'currency' = p_currency
  ), policies AS MATERIALIZED (
    SELECT policy.*
    FROM (SELECT DISTINCT policy_id FROM paired) claimed
    JOIN public.subscription_price_policy_revisions policy ON policy.id = claimed.policy_id
    JOIN public.price_lists list ON list.id = policy.price_list_id
    WHERE isfinite(p_at)
      AND policy.channel = 'D2C' AND policy.currency = p_currency
      AND policy.effective_from <= p_at AND (policy.effective_to IS NULL OR policy.effective_to > p_at)
      AND list.region_code = policy.region_code AND list.currency = p_currency AND list.status = 'active'
      AND list.valid_from <= p_at AND (list.valid_to IS NULL OR list.valid_to > p_at)
      AND NOT EXISTS (
        SELECT 1 FROM public.price_lists other
        WHERE other.region_code = list.region_code AND other.currency = list.currency AND other.status = 'active'
          AND other.valid_from <= p_at AND (other.valid_to IS NULL OR other.valid_to > p_at)
          AND other.id <> list.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.subscription_price_policy_revisions other
        WHERE other.price_list_id = list.id AND other.region_code = policy.region_code
          AND other.currency = p_currency AND other.channel = 'D2C'
          AND other.effective_from <= p_at AND (other.effective_to IS NULL OR other.effective_to > p_at)
          AND other.id <> policy.id
      )
      AND policy.rounding_rule = 'FLOOR_TO_QUANTUM'
      AND policy.digest = public.catalog_price_setup_policy_digest(
        policy.id, policy.revision_no, policy.price_list_id, policy.region_code, policy.currency, policy.channel,
        policy.effective_from, CASE WHEN policy.closed_from_open THEN NULL ELSE policy.effective_to END,
        policy.discount_bps, policy.rounding_quantum_minor, policy.rounding_rule
      )
  ), verified AS (
    SELECT pair.position, price.unit
    FROM paired pair
    JOIN policies policy ON policy.id = pair.policy_id
    JOIN public.price_entries base ON base.id = pair.base_id AND base.price_list_id = policy.price_list_id
    JOIN public.catalog_skus sku ON sku.id = base.variant_id AND sku.sku = pair.line->>'sku'
    JOIN public.catalog_products product ON product.id = sku.product_id AND product.status = 'active'
    CROSS JOIN LATERAL (
      SELECT public.catalog_derive_subscription_unit_price(
        base.unit_price_minor, policy.discount_bps, policy.rounding_quantum_minor
      ) AS unit
    ) price
    CROSS JOIN LATERAL (
      SELECT jsonb_build_object(
        'baseUnitAmountMinor', base.unit_price_minor, 'policyDigest', policy.digest,
        'resolvedUnitAmountMinor', price.unit, 'resolvedLineAmountMinor', pair.quantity::bigint * price.unit,
        'currency', p_currency, 'mode', 'subscription'
      ) AS facts,
      jsonb_build_object('amountMinor', price.unit, 'currency', p_currency) AS unit_gross,
      jsonb_build_object('amountMinor', pair.quantity::bigint * price.unit, 'currency', p_currency) AS line_gross
    ) expected
    WHERE sku.status = 'active' AND sku.sellable_in_subscription AND pair.quantity >= greatest(1, sku.min_order_qty)
      AND (base.active OR (base.valid_to IS NOT NULL
        AND base.valid_to <= pg_catalog.date_trunc('milliseconds', pg_catalog.now())
        AND EXISTS (SELECT 1 FROM public.price_entries successor
          WHERE successor.price_list_id = base.price_list_id AND successor.variant_id = base.variant_id
            AND successor.mode = 'one_time' AND successor.min_qty = 1
            AND successor.valid_from = base.valid_to))) AND base.mode = 'one_time' AND base.min_qty = 1
      AND base.valid_from <= p_at AND (base.valid_to IS NULL OR base.valid_to > p_at)
      -- Count every effective base candidate before considering its amount kind.
      AND NOT EXISTS (
        SELECT 1 FROM public.price_entries other
        WHERE other.price_list_id = base.price_list_id AND other.variant_id = sku.id
          AND (other.active OR (other.valid_to IS NOT NULL
            AND other.valid_to <= pg_catalog.date_trunc('milliseconds', pg_catalog.now())
            AND EXISTS (SELECT 1 FROM public.price_entries successor
              WHERE successor.price_list_id = other.price_list_id AND successor.variant_id = other.variant_id
                AND successor.mode = 'one_time' AND successor.min_qty = 1
                AND successor.valid_from = other.valid_to))) AND other.mode = 'one_time' AND other.min_qty = 1
          AND other.valid_from <= p_at AND (other.valid_to IS NULL OR other.valid_to > p_at)
          AND other.id <> base.id
      )
      AND base.amount_kind = 'gross' AND price.unit > 0 AND pair.quantity::bigint * price.unit <= 2147483647
      AND lower(pair.facts->>'skuId') = sku.id::text AND lower(pair.quoted_facts->>'skuId') = sku.id::text
      AND lower(pair.quoted_facts->>'basePriceEntryId') = base.id::text
      AND lower(pair.quoted_facts->>'policyRevisionId') = policy.id::text
      AND pair.facts @> expected.facts AND pair.quoted_facts @> expected.facts
      AND pair.line->'unitPriceGross' = expected.unit_gross AND pair.quoted->'unitPriceGross' = expected.unit_gross
      AND pair.line->'lineSubtotalGross' = expected.line_gross AND pair.quoted->'lineSubtotalGross' = expected.line_gross
  )
  SELECT array_agg(verified.unit ORDER BY claims.position)
  FROM claims LEFT JOIN verified USING (position)
  HAVING bool_or(claims.facts->>'version' = 'catalog_facts_v2' OR claims.quoted_facts->>'version' = 'catalog_facts_v2')
$$;
