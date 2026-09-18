-- pgTAP: Valid catalog-observation timestamps are nondeterministic metadata,
-- while malformed provenance and every other durable quote dimension drift.

BEGIN;
SELECT plan(20);

CREATE FUNCTION pg_temp.strict_v2_quote_line(p_at_time jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'sku', 'QUOTE-OBSERVATION-SKU',
    'quantity', 2,
    'unitPriceGross', jsonb_build_object('currency', 'XTS', 'amountMinor', 1340),
    'lineSubtotalGross', jsonb_build_object('currency', 'XTS', 'amountMinor', 2680),
    'pricingComponents', jsonb_build_array(jsonb_build_object(
      'scope', 'line', 'componentType', 'base_unit', 'amountMinor', 1490, 'reasonCode', 'catalog_base'
    )),
    'catalogFacts', jsonb_build_object(
      'version', 'catalog_facts_v2',
      'skuId', '55559000-0000-4000-8000-000000000001',
      'documentRevisionId', '66669000-0000-4000-8000-000000000001',
      'documentDigest', repeat('d', 64),
      'basePriceEntryId', 'base-price-entry-1490',
      'policyRevisionId', '77779000-0000-4000-8000-000000000001',
      'policyDigest', repeat('e', 64),
      'mode', 'subscription',
      'atTime', p_at_time,
      'currency', 'XTS',
      'resolvedUnitAmountMinor', 1340,
      'resolvedLineAmountMinor', 2680,
      'baseUnitAmountMinor', 1490
    )
  );
$$;

CREATE FUNCTION pg_temp.strict_v1_quote_line(p_at_time jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'sku', 'QUOTE-OBSERVATION-SKU',
    'quantity', 2,
    'unitPriceGross', jsonb_build_object('currency', 'XTS', 'amountMinor', 1340),
    'lineSubtotalGross', jsonb_build_object('currency', 'XTS', 'amountMinor', 2680),
    'pricingComponents', jsonb_build_array(jsonb_build_object(
      'scope', 'line', 'componentType', 'base_unit', 'amountMinor', 1490, 'reasonCode', 'catalog_base'
    )),
    'catalogFacts', jsonb_build_object(
      'version', 'catalog_facts_v1',
      'skuId', '55559000-0000-4000-8000-000000000001',
      'documentRevisionId', '66669000-0000-4000-8000-000000000001',
      'documentDigest', repeat('d', 64),
      'basePriceEntryId', 'base-price-entry-1490',
      'resolvedPriceEntryId', 'resolved-price-entry-1340',
      'mode', 'subscription',
      'atTime', p_at_time,
      'currency', 'XTS',
      'resolvedUnitAmountMinor', 1340,
      'resolvedLineAmountMinor', 2680,
      'baseUnitAmountMinor', 1490
    )
  );
$$;

CREATE FUNCTION pg_temp.variant_lines(p_quote_line jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_array(jsonb_build_object(
    'variantId', '55559000-0000-0000-0000-000000000001', 'qty', 2, 'quoteLine', p_quote_line
  ));
$$;

CREATE FUNCTION pg_temp.repriced_lines(p_quote_line jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_array(jsonb_build_object('lineId', '51609000-0000-0000-0000-000000000001', 'quoteLine', p_quote_line));
$$;

SELECT is(
  public.customer_self_service_quote_repriced_lines(pg_temp.repriced_lines(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00+23:00'::text))
  )),
  public.customer_self_service_quote_repriced_lines(pg_temp.repriced_lines(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T08:00:00Z'::text))
  )),
  'the repriced projection normalizes a source-valid v2 +23:00 observation'
);

SELECT is(
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
    pg_temp.strict_v1_quote_line(to_jsonb('2026-09-03T10:00+23:00'::text))
  )),
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
    pg_temp.strict_v1_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text))
  )),
  'the variant projection normalizes a source-valid historical v1 +23:00 observation'
);

SELECT is(
  (
    WITH projections(actual, expected) AS (
      VALUES
        (public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(to_jsonb('quote-line-scalar'::text))), pg_temp.variant_lines(to_jsonb('quote-line-scalar'::text))),
        (public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(jsonb_build_array('quote-line-array'::text))), pg_temp.variant_lines(jsonb_build_array('quote-line-array'::text))),
        (public.customer_self_service_quote_repriced_lines(pg_temp.repriced_lines(to_jsonb('quote-line-scalar'::text))), pg_temp.repriced_lines(to_jsonb('quote-line-scalar'::text))),
        (public.customer_self_service_quote_repriced_lines(pg_temp.repriced_lines(jsonb_build_array('quote-line-array'::text))), pg_temp.repriced_lines(jsonb_build_array('quote-line-array'::text)))
    )
    SELECT count(*)::bigint FROM projections WHERE actual = expected
  ),
  4::bigint,
  'scalar and array quoteLine values pass unchanged through both direct projections'
);

SELECT isnt(
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text))
  )),
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(jsonb_set(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)),
    '{catalogFacts}',
    (pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text))->'catalogFacts') - 'atTime'
  ))),
  'valid versus missing observation time remains strict drift'
);

SELECT isnt(
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text))
  )),
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(jsonb_set(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)),
    '{catalogFacts,atTime}', 'null'::jsonb
  ))),
  'valid versus null observation time remains strict drift'
);

SELECT isnt(
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text))
  )),
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(jsonb_set(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)),
    '{catalogFacts,atTime}', '42'::jsonb
  ))),
  'valid versus non-string observation time remains strict drift'
);

SELECT isnt(
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text))
  )),
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(jsonb_set(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)),
    '{catalogFacts,atTime}', to_jsonb('not-an-iso-observation'::text)
  ))),
  'valid versus invalid-string observation time remains strict drift'
);

SELECT isnt(
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text))
  )),
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(jsonb_set(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)),
    '{catalogFacts}',
    (pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text))->'catalogFacts') - 'documentDigest'
  ))),
  'a timestamp in an otherwise malformed catalog-facts object is not normalized'
);

SELECT isnt(
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(jsonb_set(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text)),
    '{catalogFacts}',
    (pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text))->'catalogFacts') - 'documentDigest'
  ))),
  public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(jsonb_set(
    pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)),
    '{catalogFacts}',
    (pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text))->'catalogFacts') - 'documentDigest'
  ))),
  'different malformed observations retain their original strict comparison'
);

SELECT is(
  (
    WITH malformed_catalog_fact_paths(path, malformed_value) AS (
      VALUES
        (ARRAY['catalogFacts', 'skuId']::text[], to_jsonb('55559000-0000-0000-0000-000000000001'::text)),
        (ARRAY['catalogFacts', 'documentRevisionId']::text[], to_jsonb('66669000-0000-0000-0000-000000000001'::text)),
        (ARRAY['catalogFacts', 'policyRevisionId']::text[], to_jsonb('77779000-0000-0000-0000-000000000001'::text)),
        (ARRAY['catalogFacts', 'resolvedUnitAmountMinor']::text[], to_jsonb(9007199254740992::numeric)),
        (ARRAY['catalogFacts', 'resolvedLineAmountMinor']::text[], to_jsonb(9007199254740992::numeric)),
        (ARRAY['catalogFacts', 'baseUnitAmountMinor']::text[], to_jsonb(9007199254740992::numeric))
    )
    SELECT count(*)::bigint
    FROM malformed_catalog_fact_paths
    WHERE (
      public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
        jsonb_set(pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text)), path, malformed_value)
      )) = public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
        jsonb_set(pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)), path, malformed_value)
      ))
      OR public.customer_self_service_quote_repriced_lines(pg_temp.repriced_lines(
        jsonb_set(pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text)), path, malformed_value)
      )) = public.customer_self_service_quote_repriced_lines(pg_temp.repriced_lines(
        jsonb_set(pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)), path, malformed_value)
      ))
    )
  ),
  0::bigint,
  'source-invalid UUID and unsafe-integer forms retain observation-time drift in both projections'
);

SELECT is(
  (
    WITH malformed_entry_paths(path, malformed_value) AS (
      VALUES
        (ARRAY['catalogFacts', 'basePriceEntryId']::text[], E'\t'::text),
        (ARRAY['catalogFacts', 'basePriceEntryId']::text[], U&'\FEFF'::text),
        (ARRAY['catalogFacts', 'basePriceEntryId']::text[], repeat(U&'\+01F600', 61)),
        (ARRAY['catalogFacts', 'resolvedPriceEntryId']::text[], E'\t'::text),
        (ARRAY['catalogFacts', 'resolvedPriceEntryId']::text[], U&'\FEFF'::text),
        (ARRAY['catalogFacts', 'resolvedPriceEntryId']::text[], repeat(U&'\+01F600', 61))
    )
    SELECT count(*)::bigint
    FROM malformed_entry_paths
    WHERE (
      public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
        jsonb_set(pg_temp.strict_v1_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text)), path, to_jsonb(malformed_value))
      )) = public.customer_self_service_quote_variant_qty_lines(pg_temp.variant_lines(
        jsonb_set(pg_temp.strict_v1_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)), path, to_jsonb(malformed_value))
      ))
      OR public.customer_self_service_quote_repriced_lines(pg_temp.repriced_lines(
        jsonb_set(pg_temp.strict_v1_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text)), path, to_jsonb(malformed_value))
      )) = public.customer_self_service_quote_repriced_lines(pg_temp.repriced_lines(
        jsonb_set(pg_temp.strict_v1_quote_line(to_jsonb('2026-09-03T10:01:00Z'::text)), path, to_jsonb(malformed_value))
      ))
    )
  ),
  0::bigint,
  'Zod-trim-invalid and UTF-16-overlength entry IDs retain observation-time drift in both projections'
);

SELECT is(
  (
    WITH baseline AS (
      SELECT pg_temp.variant_lines(pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text))) AS value
    ), altered AS (
      SELECT jsonb_set(value, '{0,variantId}', to_jsonb('55559000-0000-0000-0000-000000000002'::text)) AS value FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,qty}', '3'::jsonb) FROM baseline
      UNION ALL SELECT value || value FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,quoteLine,sku}', to_jsonb('QUOTE-OBSERVATION-SKU-CHANGED'::text)) FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,quoteLine,unitPriceGross,amountMinor}', '1350'::jsonb) FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,quoteLine,catalogFacts,resolvedUnitAmountMinor}', '1350'::jsonb) FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,quoteLine,pricingComponents,0,amountMinor}', '1500'::jsonb) FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,quoteLine,catalogFacts,basePriceEntryId}', to_jsonb('base-price-entry-changed'::text)) FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,quoteLine,catalogFacts,documentRevisionId}', to_jsonb('66669000-0000-4000-8000-000000000002'::text)) FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,quoteLine,catalogFacts,documentDigest}', to_jsonb(repeat('f', 64))) FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,quoteLine,catalogFacts,policyRevisionId}', to_jsonb('77779000-0000-4000-8000-000000000002'::text)) FROM baseline
      UNION ALL SELECT jsonb_set(value, '{0,quoteLine,catalogFacts,policyDigest}', to_jsonb(repeat('a', 64))) FROM baseline
    )
    SELECT count(*)::bigint
    FROM baseline, altered
    WHERE public.customer_self_service_quote_variant_qty_lines(baseline.value)
        = public.customer_self_service_quote_variant_qty_lines(altered.value)
  ),
  0::bigint,
  'SKU/variant, quantity, structure, unit/resolved money, pricing, remaining facts, document, and policy deltas remain drift'
);

INSERT INTO auth.users (id) VALUES ('a6090000-0000-0000-0000-000000000001');
INSERT INTO public.clients (id, email, auth_user_id) VALUES
  ('c6090000-0000-0000-0000-000000000001', 'quote-observation@example.invalid', 'a6090000-0000-0000-0000-000000000001');
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, template_version, edit_window_hours, payment_method_ref
) VALUES (
  '5b609000-0000-0000-0000-000000000001', 'c6090000-0000-0000-0000-000000000001', 28, 'AAA', 'active',
  '2026-10-01T00:00:00Z', 1, 24, 'pm_quote_observation'
);
SET LOCAL session_replication_role = replica;
INSERT INTO public.subscription_lines (id, subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata) VALUES
  ('51609000-0000-0000-0000-000000000001', '5b609000-0000-0000-0000-000000000001', '55559000-0000-0000-0000-000000000001', 4, 1, false, 1, '{}'::jsonb),
  ('51609000-0000-0000-0000-000000000002', '5b609000-0000-0000-0000-000000000001', '55559000-0000-0000-0000-000000000002', 1, 2, true, 1, '{}'::jsonb);
SET LOCAL session_replication_role = origin;

INSERT INTO public.subscription_quote_previews (
  subscription_id, client_id, created_by_auth_user_id, action, quote_hash, template_version,
  expires_at, request_payload, quote_snapshot, totals, metadata, created_at, updated_at
) VALUES (
  '5b609000-0000-0000-0000-000000000001', 'c6090000-0000-0000-0000-000000000001',
  'a6090000-0000-0000-0000-000000000001', 'update_addon_quantity', repeat('9', 64), 1,
  '2026-09-04T10:00:00Z'::timestamptz,
  jsonb_build_object('action', 'update_addon_quantity', 'variantId', '55559000-0000-0000-0000-000000000002', 'qty', 2),
  jsonb_build_object('repricedLines', pg_temp.repriced_lines(pg_temp.strict_v2_quote_line(to_jsonb('2026-09-03T10:00:00Z'::text)))),
  '{}'::jsonb, '{"source":"pgtap"}'::jsonb,
  '2026-09-03T09:55:00Z'::timestamptz, '2026-09-03T09:55:00Z'::timestamptz
);

SELECT throws_ok(
  $q$
    SELECT public.customer_self_service_apply_subscription_action(
      'a6090000-0000-0000-0000-000000000001',
      'quote-observation-scalar-apply',
      '5b609000-0000-0000-0000-000000000001',
      'update_addon_quantity',
      jsonb_build_object(
        'acceptedQuoteHash', repeat('9', 64),
        'expectedTemplateVersion', 1,
        'variantId', '55559000-0000-0000-0000-000000000002',
        'qty', 2,
        'repricedLines', pg_temp.repriced_lines(to_jsonb('quote-line-scalar'::text))
      ),
      '2026-09-03T10:00:00Z'::timestamptz
    )
  $q$,
  'customer_self_service_quote_drift',
  'a scalar quoteLine causes apply-level quote drift before mutation'
);

SELECT is(
  (SELECT status FROM public.subscription_quote_previews WHERE quote_hash = repeat('9', 64)),
  'previewed',
  'a scalar quoteLine apply leaves the preview unaccepted'
);

SELECT is(
  (SELECT qty FROM public.subscription_lines WHERE id = '51609000-0000-0000-0000-000000000002'),
  1,
  'a scalar quoteLine apply leaves the subscription template line unchanged'
);

SELECT is(
  (SELECT template_version FROM public.subscriptions WHERE id = '5b609000-0000-0000-0000-000000000001'),
  1,
  'a scalar quoteLine apply leaves the subscription template version unchanged'
);

SELECT is(
  (
    SELECT count(*)::integer
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN ('customer_self_service_quote_repriced_lines', 'customer_self_service_quote_variant_qty_lines')
      AND pg_get_function_identity_arguments(procedure.oid) = 'p_lines jsonb'
  ),
  2,
  'both effective helpers retain their exact public signature'
);

SELECT is(
  (
    SELECT string_agg(
      format('%s|%s|%s|%s|%s|%s', procedure.proname, language.lanname, procedure.provolatile,
        procedure.prosecdef, pg_get_userbyid(procedure.proowner), array_to_string(procedure.proconfig, ';')
      ),
      '|' ORDER BY procedure.proname
    )
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    JOIN pg_language AS language ON language.oid = procedure.prolang
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN ('customer_self_service_quote_repriced_lines', 'customer_self_service_quote_variant_qty_lines')
  ),
  'customer_self_service_quote_repriced_lines|sql|i|f|postgres|search_path=public, pg_catalog|customer_self_service_quote_variant_qty_lines|sql|i|f|postgres|search_path=public, pg_catalog',
  'both effective helpers retain SQL, IMMUTABLE, invoker, postgres-owner, and fixed-search-path attributes'
);

SELECT ok(
  (
    SELECT string_agg(
      format('%s|%s|%s|%s', procedure.proname,
        has_function_privilege('anon', procedure.oid, 'EXECUTE'),
        has_function_privilege('authenticated', procedure.oid, 'EXECUTE'),
        has_function_privilege('service_role', procedure.oid, 'EXECUTE')
      ),
      '|' ORDER BY procedure.proname
    )
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN ('customer_self_service_quote_repriced_lines', 'customer_self_service_quote_variant_qty_lines')
  ) = 'customer_self_service_quote_repriced_lines|t|t|t|customer_self_service_quote_variant_qty_lines|t|t|t',
  'effective ACLs retain the inherited browser and service-role execution without migration ACL churn'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc AS procedure
    JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname IN ('customer_self_service_quote_repriced_lines', 'customer_self_service_quote_variant_qty_lines')
      AND NOT has_function_privilege('service_role', procedure.oid, 'EXECUTE')
  ),
  'effective ACLs retain service-role execution for both quote-line helpers'
);

SELECT * FROM finish();
ROLLBACK;
