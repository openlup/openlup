-- pgTAP: append-only, privacy-safe promotion claim transition evidence.
BEGIN;
SELECT plan(74);

SELECT has_table('public', 'promotion_code_claim_events',
  'promotion claim transition ledger exists');
SELECT ok(NOT EXISTS (
  SELECT 1
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'promotion_code_claim_events'
     AND column_name IN (
       'client_id', 'code', 'code_normalized', 'email', 'metadata',
       'amount', 'amount_minor', 'money', 'payload', 'error'
     )
), 'ledger schema has no client id, raw code, PII, money or free-form payload column');

INSERT INTO public.promotion_codes (
  id, code, name, scopes, valid_from, valid_to, status
) VALUES (
  'e6100000-0000-4000-8000-000000000001',
  'EVENTS-TEST',
  'Claim events test',
  ARRAY['one_time'],
  now() - interval '1 hour',
  now() + interval '1 day',
  'active'
);

INSERT INTO public.commerce_orders (
  id, order_number, status, currency, subtotal_cents, discount_cents,
  shipping_cents, shipping_discount_cents, tax_cents, total_cents
) VALUES
  ('e6200000-0000-4000-8000-000000000001', 'PROMO-EVENT-1', 'draft', 'PLN', 1000, 0, 0, 0, 0, 1000),
  ('e6200000-0000-4000-8000-000000000002', 'PROMO-EVENT-2', 'draft', 'PLN', 1000, 0, 0, 0, 0, 1000),
  ('e6200000-0000-4000-8000-000000000003', 'PROMO-EVENT-3', 'draft', 'PLN', 1000, 0, 0, 0, 0, 1000);

INSERT INTO public.promotion_code_claims (
  id, promotion_code_id, order_id, status, reserved_at, expires_at
) VALUES (
  'e6300000-0000-4000-8000-000000000001',
  'e6100000-0000-4000-8000-000000000001',
  'e6200000-0000-4000-8000-000000000001',
  'reserved',
  now() - interval '1 hour',
  now() + interval '1 hour'
);

SELECT is((
  SELECT count(*)::integer
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'
), 1, 'claim insertion appends one event');
SELECT is((
  SELECT jsonb_build_object(
    'kind', transition_kind,
    'from', from_status,
    'to', to_status,
    'reason', safe_reason
  )
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'
), '{"kind":"reserved","from":null,"to":"reserved","reason":"claim_reserved"}'::jsonb,
  'initial reservation records only a closed transition and safe reason');

UPDATE public.promotion_code_claims
   SET updated_at = now()
 WHERE id = 'e6300000-0000-4000-8000-000000000001';
SELECT is((
  SELECT count(*)::integer
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'
), 1, 'a write without a status transition appends no event');

UPDATE public.promotion_code_claims
   SET status = 'released',
       released_at = now(),
       release_reason = 'order_cancelled',
       updated_at = now()
 WHERE id = 'e6300000-0000-4000-8000-000000000001';
SELECT is((
  SELECT transition_kind
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'
   ORDER BY occurred_at DESC, id DESC LIMIT 1
), 'released', 'reserved to released records a release transition');
SELECT is((
  SELECT safe_reason
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'
   ORDER BY occurred_at DESC, id DESC LIMIT 1
), 'order_cancelled', 'known cancellation is retained as a bounded safe reason');

UPDATE public.promotion_code_claims
   SET status = 'redeemed',
       redeemed_at = now(),
       released_at = NULL,
       release_reason = NULL,
       updated_at = now()
 WHERE id = 'e6300000-0000-4000-8000-000000000001';
SELECT is((
  SELECT transition_kind
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'
   ORDER BY occurred_at DESC, id DESC LIMIT 1
), 'late_paid', 'released to redeemed is classified separately as late paid');
SELECT is((
  SELECT safe_reason
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'
   ORDER BY occurred_at DESC, id DESC LIMIT 1
), 'late_paid_after_order_cancelled',
  'late paid classification sees OLD release reason before PR4 clears it');
SELECT is((
  SELECT claim_expires_at
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'
   ORDER BY occurred_at DESC, id DESC LIMIT 1
), (
  SELECT expires_at
    FROM public.promotion_code_claims
   WHERE id = 'e6300000-0000-4000-8000-000000000001'
),
  'each event carries the claim expiry used for stale-reservation analysis');
SELECT is((
  SELECT release_reason
    FROM public.promotion_code_claims
   WHERE id = 'e6300000-0000-4000-8000-000000000001'
), NULL, 'ledger recording does not interfere with the canonical claim update');

INSERT INTO public.promotion_code_claims (
  id, promotion_code_id, order_id, status, expires_at
) VALUES (
  'e6300000-0000-4000-8000-000000000002',
  'e6100000-0000-4000-8000-000000000001',
  'e6200000-0000-4000-8000-000000000002',
  'reserved',
  now() + interval '1 hour'
);
UPDATE public.promotion_code_claims
   SET status = 'redeemed', redeemed_at = now(), updated_at = now()
 WHERE id = 'e6300000-0000-4000-8000-000000000002';
SELECT is((
  SELECT jsonb_build_object(
    'kind', transition_kind,
    'from', from_status,
    'to', to_status,
    'reason', safe_reason
  )
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000002'
   ORDER BY occurred_at DESC, id DESC LIMIT 1
), '{"kind":"redeemed","from":"reserved","to":"redeemed","reason":"claim_redeemed"}'::jsonb,
  'ordinary paid transition remains distinct from late paid');

UPDATE public.promotion_code_claims
   SET status = 'released',
       redeemed_at = NULL,
       released_at = now(),
       release_reason = 'simulated_drift',
       updated_at = now()
 WHERE id = 'e6300000-0000-4000-8000-000000000002';
SELECT is((
  SELECT jsonb_build_object(
    'kind', transition_kind,
    'from', from_status,
    'to', to_status,
    'reason', safe_reason
  )
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000002'
   ORDER BY occurred_at DESC, id DESC LIMIT 1
), '{"kind":"released","from":"redeemed","to":"released","reason":"claim_released"}'::jsonb,
  'repair-compatible redeemed to released drift records bounded evidence without blocking the write');
UPDATE public.promotion_code_claims
   SET status = 'redeemed',
       redeemed_at = now(),
       released_at = NULL,
       release_reason = NULL,
       updated_at = now()
 WHERE id = 'e6300000-0000-4000-8000-000000000002';

INSERT INTO public.promotion_code_claims (
  id, promotion_code_id, order_id, status, expires_at
) VALUES (
  'e6300000-0000-4000-8000-000000000003',
  'e6100000-0000-4000-8000-000000000001',
  'e6200000-0000-4000-8000-000000000003',
  'reserved',
  now() + interval '1 hour'
);
UPDATE public.promotion_code_claims
   SET status = 'released',
       released_at = now(),
       release_reason = 'customer-email-secret@example.invalid',
       updated_at = now()
 WHERE id = 'e6300000-0000-4000-8000-000000000003';
SELECT is((
  SELECT safe_reason
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000003'
   ORDER BY occurred_at DESC, id DESC LIMIT 1
), 'claim_released', 'arbitrary release input maps to a bounded generic reason');
SELECT ok(NOT EXISTS (
  SELECT 1
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000003'
     AND row_to_json(promotion_code_claim_events)::text ILIKE '%customer-email-secret%'
), 'arbitrary release input is never copied into transition evidence');
UPDATE public.promotion_code_claims
   SET status = 'redeemed',
       redeemed_at = now(),
       released_at = NULL,
       release_reason = NULL,
       updated_at = now()
 WHERE id = 'e6300000-0000-4000-8000-000000000003';
SELECT is((
  SELECT safe_reason
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000003'
   ORDER BY occurred_at DESC, id DESC LIMIT 1
), 'late_paid_after_release', 'late paid after an arbitrary release remains privacy safe');

SELECT throws_ok(
  $$UPDATE public.promotion_code_claim_events SET safe_reason = 'claim_redeemed' WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'$$,
  '55000', 'promotion_code_claim_event_append_only',
  'ledger events cannot be updated');
SELECT throws_ok(
  $$DELETE FROM public.promotion_code_claim_events WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'$$,
  '55000', 'promotion_code_claim_event_append_only',
  'ledger events cannot be deleted');
SELECT throws_ok(
  $$INSERT INTO public.promotion_code_claim_events (
      claim_id, code_id, order_id, transition_kind, from_status, to_status,
      safe_reason, claim_expires_at
    ) VALUES (
      gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'reserved', NULL,
      'reserved', 'unbounded_reason', now()
    )$$,
  '23514', NULL,
  'database CHECK rejects a reason outside the closed vocabulary');

SELECT ok(NOT has_table_privilege('anon', 'public.promotion_code_claim_events', 'SELECT'),
  'anon cannot read claim events');
SELECT ok(NOT has_table_privilege('authenticated', 'public.promotion_code_claim_events', 'SELECT'),
  'authenticated clients cannot read claim events');
SELECT ok(has_table_privilege('service_role', 'public.promotion_code_claim_events', 'SELECT'),
  'service role can read operational claim evidence');
SELECT ok(NOT has_table_privilege('service_role', 'public.promotion_code_claim_events', 'INSERT'),
  'service role cannot insert synthetic claim history');
SELECT ok(NOT has_table_privilege('service_role', 'public.promotion_code_claim_events', 'UPDATE'),
  'service role cannot update claim history');
SELECT ok(NOT has_table_privilege('service_role', 'public.promotion_code_claim_events', 'DELETE'),
  'service role cannot delete claim history');
SELECT ok((
  SELECT relrowsecurity
    FROM pg_class
   WHERE oid = 'public.promotion_code_claim_events'::regclass
), 'claim events have RLS enabled with no client policy');
SELECT is((
  SELECT count(*)::integer
    FROM pg_policies
   WHERE schemaname = 'public'
     AND tablename = 'promotion_code_claim_events'
     AND roles && ARRAY['public', 'anon', 'authenticated']::name[]
), 0, 'claim events expose no RLS client policy');
SELECT is((
  SELECT count(*)::integer
    FROM public.promotion_code_claim_events
   WHERE claim_id = 'e6300000-0000-4000-8000-000000000001'
), 3, 'reservation, release and late-paid evidence remain exactly once');

SELECT ok(has_function_privilege(
  'service_role', 'public.cleanup_preview_promotion_claim_events(uuid[])', 'EXECUTE'
), 'service role can invoke the narrow preview event cleanup');
SELECT ok(NOT has_function_privilege(
  'authenticated', 'public.cleanup_preview_promotion_claim_events(uuid[])', 'EXECUTE'
), 'authenticated clients cannot invoke preview event cleanup');
SELECT ok(
  pg_get_functiondef('public.cleanup_preview_promotion_claim_events(uuid[])'::regprocedure)
    LIKE '%private.production_database_fingerprint_matches()%',
  'preview cleanup checks the production fingerprint independently of cron state');
SELECT lives_ok(
  $$SELECT public.cleanup_preview_promotion_claim_events(
      ARRAY['e6200000-0000-4000-8000-000000000003'::uuid]
    )$$,
  'preview cleanup can remove events for an explicit order outside production');
SELECT is((
  SELECT count(*)::integer FROM public.promotion_code_claim_events
   WHERE order_id = 'e6200000-0000-4000-8000-000000000003'
), 0, 'preview cleanup removes claim events before their order fixture');
SELECT ok(EXISTS (
  SELECT 1 FROM public.promotion_code_claims
   WHERE id = 'e6300000-0000-4000-8000-000000000003'
), 'preview event cleanup does not mutate claim lifecycle state');
UPDATE private.platform_cron_environment
SET expected_system_identifier = (pg_control_system()).system_identifier::text,
    expected_server_addr = inet_server_addr(),
    expected_server_port = inet_server_port(),
    external_cron_enabled = false
WHERE id = true;
SELECT ok(private.production_database_fingerprint_matches(),
  'production fingerprint remains true when external cron is disabled');
SELECT throws_ok(
  $$SELECT public.cleanup_preview_promotion_claim_events(
      ARRAY['e6200000-0000-4000-8000-000000000001'::uuid]
    )$$,
  '42501', 'preview_promotion_claim_event_cleanup_forbidden_in_production',
  'preview cleanup stays closed on the production fingerprint during a cron kill switch');

SELECT has_index(
  'public', 'promotion_code_claim_events', 'idx_promotion_code_claim_events_occurred',
  'watchdog event window has an occurred-at index');
SELECT has_index(
  'public', 'promotion_code_claims', 'idx_promotion_code_claims_health_status_expiry',
  'exact active-capacity and stale reads have a status/expiry index');
SELECT has_index(
  'public', 'commerce_orders', 'idx_commerce_orders_promotion_v2_health',
  'persisted promotion-money reconciliation has a v2-order partial index');
SELECT ok(
  obj_description('public.idx_promotion_code_claim_events_occurred'::regclass)
    LIKE '%p_since%LIMIT <= 100%',
  'event index documents the bounded range and evidence cap used by EXPLAIN review');
SELECT ok(
  obj_description('public.idx_promotion_code_claims_health_status_expiry'::regclass)
    LIKE '%reserved + redeemed%stale-reservation%',
  'claim index documents exact capacity and stale-reservation access paths');
SELECT ok(
  obj_description('public.idx_commerce_orders_promotion_v2_health'::regclass)
    LIKE '%persisted-money%exact immutable broad v2-evidence predicate%',
  'v2-order index documents bounded persisted-only reconciliation');
SELECT ok((
  SELECT pg_get_expr(indexes.indpred, indexes.indrelid) =
    'private.promotion_order_has_v2_evidence(metadata)'
  FROM pg_index indexes
  WHERE indexes.indexrelid = 'public.idx_commerce_orders_promotion_v2_health'::regclass
), 'v2-order partial index uses the exact broad immutable RPC predicate');
SELECT ok(has_function_privilege(
  'service_role',
  'private.promotion_order_has_v2_evidence(jsonb)',
  'EXECUTE'
), 'service role can evaluate the private v2-evidence index predicate');
SELECT ok(
  NOT has_function_privilege(
    'anon',
    'private.promotion_order_has_v2_evidence(jsonb)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'private.promotion_order_has_v2_evidence(jsonb)',
    'EXECUTE'
  ),
  'browser roles cannot execute the private v2-evidence index predicate'
);
SET LOCAL ROLE service_role;
SELECT lives_ok(
  $$INSERT INTO public.commerce_orders (
      id, order_number, status, currency, subtotal_cents, discount_cents,
      shipping_cents, shipping_discount_cents, tax_cents, total_cents
    ) VALUES (
      'e6200000-0000-4000-8000-000000000099',
      'PROMO-SERVICE-ROLE-INDEX',
      'draft', 'PLN', 1000, 0, 0, 0, 0, 1000
    )$$,
  'service-role order insert can maintain the promotion v2 health index'
);
RESET ROLE;

INSERT INTO public.promotion_codes (
  id, code, name, scopes, valid_from, valid_to, status,
  redemption_limit_global, redemption_limit_per_customer
) VALUES (
  'e6100000-0000-4000-8000-000000000002',
  'CAP-TEST',
  'Capacity test',
  ARRAY['one_time'],
  now() - interval '1 hour',
  now() + interval '1 day',
  'active',
  1,
  1
);
INSERT INTO public.clients (id, email) VALUES (
  'e6400000-0000-4000-8000-000000000001',
  'capacity-private@example.invalid'
);
INSERT INTO public.commerce_orders (
  id, order_number, status, currency, subtotal_cents, discount_cents,
  shipping_cents, shipping_discount_cents, tax_cents, total_cents
) VALUES
  ('e6200000-0000-4000-8000-000000000004', 'PROMO-CAP-1', 'draft', 'PLN', 1000, 0, 0, 0, 0, 1000),
  ('e6200000-0000-4000-8000-000000000005', 'PROMO-CAP-2', 'draft', 'PLN', 1000, 0, 0, 0, 0, 1000);
INSERT INTO public.promotion_code_claims (
  id, promotion_code_id, order_id, client_id, status, reserved_at, expires_at
) VALUES
  (
    'e6300000-0000-4000-8000-000000000004',
    'e6100000-0000-4000-8000-000000000002',
    'e6200000-0000-4000-8000-000000000004',
    'e6400000-0000-4000-8000-000000000001',
    'reserved', now() - interval '2 hours', now() - interval '30 minutes'
  ),
  (
    'e6300000-0000-4000-8000-000000000005',
    'e6100000-0000-4000-8000-000000000002',
    'e6200000-0000-4000-8000-000000000005',
    'e6400000-0000-4000-8000-000000000001',
    'reserved', now(), now() + interval '1 hour'
  );

-- Build persisted snapshots without invoking the live checkout triggers: these
-- are intentionally malformed reconciliation fixtures, not executable quotes.
SET LOCAL session_replication_role = replica;
UPDATE public.commerce_orders
SET discount_cents = 800,
    total_cents = 200,
    metadata = jsonb_build_object(
      'promotionEngineVersion', 'promotion-engine.v2',
      -- Full-set comparison: one expected id is deliberately absent from claims.
      'promotionCodeIds', jsonb_build_array(
        'e6100000-0000-4000-8000-000000000001',
        'e6100000-0000-4000-8000-000000000002'
      ),
      'promotionProductDiscountMinor', 800,
      'promotionShippingDiscountMinor', 0,
      'quoteSnapshot', jsonb_build_object('quote', jsonb_build_object(
        'discounts', jsonb_build_array(
          jsonb_build_object(
            'promotionEngineVersion', 'promotion-engine.v2',
            'reasonCode', 'promotion_code_v2',
            'promotionCodeId', 'e6100000-0000-4000-8000-000000000001',
            'appliesTo', 'order_total',
            'amountOffMinor', 400
          ),
          jsonb_build_object(
            'promotionEngineVersion', 'promotion-engine.v2',
            'reasonCode', 'promotion_code_v2',
            'promotionCodeId', 'e6100000-0000-4000-8000-000000000002',
            'appliesTo', 'order_total',
            'amountOffMinor', 400
          )
        )
      ))
    )
WHERE id = 'e6200000-0000-4000-8000-000000000004';
UPDATE public.commerce_orders
SET status = 'paid',
    discount_cents = 950,
    total_cents = 50,
    metadata = jsonb_build_object(
      'promotionEngineVersion', 'promotion-engine.v2',
      'promotionCodeIds', jsonb_build_array('e6100000-0000-4000-8000-000000000002'),
      'promotionProductDiscountMinor', 950,
      'promotionShippingDiscountMinor', 0,
      'quoteSnapshot', jsonb_build_object('quote', jsonb_build_object(
        'discounts', jsonb_build_array(jsonb_build_object(
          'promotionEngineVersion', 'promotion-engine.v2',
          'reasonCode', 'promotion_code_v2',
          'promotionCodeId', 'e6100000-0000-4000-8000-000000000002',
          'appliesTo', 'order_total',
          'amountOffMinor', 950
        ))
      ))
    )
WHERE id = 'e6200000-0000-4000-8000-000000000005';
INSERT INTO public.commerce_orders (
  id, order_number, status, currency, subtotal_cents, discount_cents,
  shipping_cents, shipping_discount_cents, tax_cents, total_cents,
  created_at, metadata
) VALUES (
  'e6200000-0000-4000-8000-000000000006', 'PROMO-OLD-DRAFT', 'draft', 'PLN',
  1000, 800, 0, 0, 0, 200, now() - interval '2 days',
  jsonb_build_object(
    'promotionEngineVersion', 'promotion-engine.v2',
    'promotionCodeIds', jsonb_build_array('e6100000-0000-4000-8000-000000000002'),
    'promotionProductDiscountMinor', 800,
    'promotionShippingDiscountMinor', 0,
    'quoteSnapshot', jsonb_build_object('quote', jsonb_build_object(
      'discounts', jsonb_build_array(jsonb_build_object(
        'promotionEngineVersion', 'promotion-engine.v2',
        'reasonCode', 'promotion_code_v2',
        'promotionCodeId', 'e6100000-0000-4000-8000-000000000002',
        'appliesTo', 'order_total',
        'amountOffMinor', 800
      ))
    ))
  )
);
INSERT INTO public.commerce_orders (
  id, order_number, status, currency, subtotal_cents, discount_cents,
  shipping_cents, shipping_discount_cents, tax_cents, total_cents, metadata
) VALUES (
  'e6200000-0000-4000-8000-000000000007', 'PROMO-MARKER-REMOVED', 'paid', 'PLN',
  1000, 800, 0, 0, 0, 200,
  jsonb_build_object(
    'promotionProductDiscountMinor', 800,
    'promotionShippingDiscountMinor', 0,
    'quoteSnapshot', jsonb_build_object('quote', jsonb_build_object(
      'discounts', jsonb_build_array(jsonb_build_object(
        'promotionEngineVersion', 'promotion-engine.v2',
        'reasonCode', 'promotion_code_v2',
        'promotionCodeId', 'e6100000-0000-4000-8000-000000000002',
        'appliesTo', 'order_total',
        'amountOffMinor', 800
      ))
    ))
  )
);
INSERT INTO public.commerce_orders (
  id, order_number, status, currency, subtotal_cents, discount_cents,
  shipping_cents, shipping_discount_cents, tax_cents, total_cents, metadata
) VALUES
  (
    'e6200000-0000-4000-8000-000000000008', 'OFFER-V2-NO-CODE', 'paid', 'PLN',
    1000, 500, 0, 0, 0, 500,
    jsonb_build_object(
      'promotionEngineVersion', 'promotion-engine.v2',
      'quoteSnapshot', jsonb_build_object('quote', jsonb_build_object(
        'discounts', jsonb_build_array(jsonb_build_object(
          'promotionEngineVersion', 'promotion-engine.v2',
          'reasonCode', 'automatic_subscription_discount',
          'appliesTo', 'order_total',
          'amountOffMinor', 500
        ))
      ))
    )
  ),
  (
    'e6200000-0000-4000-8000-000000000009', 'PROMO-PARTIAL-METADATA', 'paid', 'PLN',
    1000, 800, 0, 0, 0, 200,
    jsonb_build_object(
      'promotionEngineVersion', 'promotion-engine.v2',
      'promotionCodeIds', jsonb_build_array(
        'e6100000-0000-4000-8000-000000000002'
      )
    )
  );
SET LOCAL session_replication_role = origin;
UPDATE public.promotion_code_claims
SET status = 'redeemed', redeemed_at = now(), updated_at = now()
WHERE id = 'e6300000-0000-4000-8000-000000000005';

-- Volume fixture: the aggregate scans only the effective <=24 hour occurred_at range and
-- the operator evidence projection must remain bounded independently of volume.
INSERT INTO public.promotion_code_claim_events (
  claim_id, code_id, order_id, transition_kind, from_status, to_status,
  safe_reason, claim_expires_at, occurred_at
)
SELECT
  gen_random_uuid(),
  'e6100000-0000-4000-8000-000000000002',
  gen_random_uuid(),
  'late_paid',
  'released',
  'redeemed',
  'late_paid_after_release',
  now() - interval '1 hour',
  now() - (series * interval '1 second')
FROM generate_series(1, 120) AS series;

CREATE TEMP TABLE _promotion_health AS
SELECT public.commerce_promotion_health_snapshot(
  now() - interval '1 hour',
  now() - interval '15 minutes',
  10
) AS snapshot;

SELECT is((SELECT snapshot->>'contractVersion' FROM _promotion_health),
  'promotion-health.v1', 'health RPC exposes a versioned closed contract');
SELECT is((SELECT snapshot->>'historyCoverage' FROM _promotion_health),
  'post_migration_only', 'health RPC distinguishes no-backfill history from zero transitions');
SELECT is((SELECT snapshot#>>'{aggregates,capacity,definition}' FROM _promotion_health),
  'reserved_plus_redeemed', 'capacity explicitly counts reserved plus redeemed claims');
SELECT ok((SELECT (snapshot#>>'{aggregates,claims,activeCapacity}')::integer >= 5 FROM _promotion_health),
  'health RPC reports exact current capacity across reserved and redeemed claims');
SELECT ok((SELECT (snapshot#>>'{aggregates,claims,staleReserved}')::integer >= 1 FROM _promotion_health),
  'health RPC detects current stale reservations at the supplied boundary');
SELECT ok((SELECT (snapshot#>>'{aggregates,claims,staleBlockingCapacity}')::integer >= 1 FROM _promotion_health),
  'health RPC distinguishes stale reservations that currently block a configured limit');
SELECT ok((SELECT (snapshot#>>'{aggregates,capacity,overLimitCodes}')::integer >= 1 FROM _promotion_health),
  'health RPC detects a code whose exact active capacity exceeds its limit');
SELECT is((
  SELECT jsonb_build_object(
    'activeClaims', evidence->>'count',
    'limit', evidence->>'limit'
  )
  FROM _promotion_health,
       LATERAL jsonb_array_elements(snapshot->'evidence') AS evidence
  WHERE evidence->>'kind' = 'capacity_exceeded'
    AND evidence->>'scope' = 'global'
    AND evidence->>'promotionCodeId' = 'e6100000-0000-4000-8000-000000000002'
), '{"activeClaims":"2","limit":"1"}'::jsonb,
  'capacity evidence proves the exact reserved-plus-redeemed count without raw code');
SELECT ok((
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'evidence') AS evidence
    WHERE evidence->>'kind' = 'capacity_exceeded'
      AND evidence->>'scope' = 'customer'
      AND evidence->>'promotionCodeId' = 'e6100000-0000-4000-8000-000000000002'
      AND (evidence->>'count')::integer = 2
      AND (evidence->>'limit')::integer = 1
  ) FROM _promotion_health
), 'per-customer capacity is evaluated inside SQL with bounded opaque evidence');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM _promotion_health
  WHERE snapshot::text ILIKE '%capacity-private%'
     OR snapshot::text ILIKE '%e6400000-0000-4000-8000-000000000001%'
     OR jsonb_path_exists(snapshot, '$.**.clientId')
), 'customer capacity evidence never exposes client id or PII');
SELECT ok((
  SELECT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(snapshot->'evidence') AS evidence
    WHERE evidence->>'kind' = 'stale_reserved'
      AND evidence->>'claimId' = 'e6300000-0000-4000-8000-000000000004'
      AND (evidence->>'blockingCapacity')::boolean
  ) FROM _promotion_health
), 'bounded evidence includes an opaque stale claim');
SELECT is((SELECT jsonb_array_length(snapshot->'evidence') FROM _promotion_health), 10,
  'evidence stays at the requested cap under a 120-row late-paid fixture');
SELECT ok((SELECT (snapshot#>>'{transitionCounts24h,late_paid}')::integer >= 120 FROM _promotion_health),
  'time-window aggregate counts the full volume even when evidence is capped');
SELECT is((SELECT (snapshot#>>'{aggregates,missingClaimOrderCount}')::integer
  FROM _promotion_health),
  3, 'full-set comparison detects recent/paid missing claims but excludes old/no-code orders');
SELECT is((SELECT (snapshot#>>'{aggregates,promotionMoneyMismatchCount}')::integer
  FROM _promotion_health),
  3, 'persisted-money equations run only for code-specific CODM paid-like statuses');
SELECT ok((
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'moneyEvidence') AS item
    WHERE item->>'orderId' = 'e6200000-0000-4000-8000-000000000005'
      AND item->'mismatchCodes' ? 'promotion_product_floor'
  ) FROM _promotion_health
), 'bounded money evidence identifies the persisted 1 PLN floor violation');
SELECT ok((
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'moneyEvidence') AS item
    WHERE item->>'orderId' = 'e6200000-0000-4000-8000-000000000007'
      AND item->'mismatchCodes' ? 'promotion_claim_ids'
      AND item->'mismatchCodes' ? 'promotion_adjustments_invalid'
  ) FROM _promotion_health
), 'frozen v2 discounts remain detectable after marker/metadata ids and claims are removed');
SELECT ok((
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'moneyEvidence') AS item
    WHERE item->>'orderId' = 'e6200000-0000-4000-8000-000000000008'
  ) FROM _promotion_health
), 'offer-policy v2 automatic no-code order is excluded from code-money reconciliation');
SELECT ok((
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(snapshot->'moneyEvidence') AS item
    WHERE item->>'orderId' = 'e6200000-0000-4000-8000-000000000009'
      AND item->'mismatchCodes' ? 'promotion_adjustments_invalid'
      AND item->'mismatchCodes' ? 'promotion_claim_ids'
  ) FROM _promotion_health
), 'partial code-specific metadata remains detectable even without frozen discounts');
SELECT ok(NOT EXISTS (
  SELECT 1 FROM _promotion_health
  WHERE snapshot::text ILIKE ANY (ARRAY[
    '%EVENTS-TEST%', '%CAP-TEST%', '%customer-email-secret%',
    '%token%', '%amountMinor%', '%subtotal_cents%', '%discount_cents%'
  ])
), 'health snapshot contains no raw code, PII, token or money');

CREATE TEMP TABLE _promotion_money_only AS
SELECT public.commerce_promotion_health_snapshot(
  now() - interval '1 hour',
  now() - interval '15 minutes',
  10,
  false
) AS snapshot;
SELECT is((SELECT snapshot#>>'{aggregates,claims,activeCapacity}' FROM _promotion_money_only),
  '0', 'flag-off RPC skips current claim, capacity and event health projections');
SELECT ok((
  SELECT (snapshot#>>'{aggregates,promotionMoneyMismatchCount}')::integer = 3
    AND jsonb_array_length(snapshot->'evidence') = 0
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(snapshot->'moneyEvidence') AS item
      WHERE item->>'orderId' = 'e6200000-0000-4000-8000-000000000005'
        AND item->'mismatchCodes' ? 'promotion_product_floor'
    )
  FROM _promotion_money_only
), 'flag-off RPC still returns persisted v2 money integrity evidence only');
SELECT throws_ok(
  $$SELECT public.commerce_promotion_health_snapshot(now() - interval '26 hours', now(), 25)$$,
  '22023', 'promotion_health_snapshot_invalid_bounds',
  'health RPC rejects caller skew beyond the bounded 24-hour contract');
SELECT lives_ok(
  $$SELECT public.commerce_promotion_health_snapshot(
      now() - interval '24 hours', now(), 25
    )$$,
  'app now-minus-24h survives network skew while DB clamps the effective window');
SELECT throws_ok(
  $$SELECT public.commerce_promotion_health_snapshot(now() - interval '1 hour', now(), 101)$$,
  '22023', 'promotion_health_snapshot_invalid_bounds',
  'health RPC rejects evidence above the hard cap');
SELECT ok(has_function_privilege(
  'service_role',
  'public.commerce_promotion_health_snapshot(timestamptz,timestamptz,integer,boolean)',
  'EXECUTE'
), 'service role can execute the bounded health projection');
SELECT ok(NOT has_function_privilege(
  'authenticated',
  'public.commerce_promotion_health_snapshot(timestamptz,timestamptz,integer,boolean)',
  'EXECUTE'
), 'authenticated clients cannot execute the health projection');
SELECT is((
  SELECT provolatile::text
  FROM pg_proc
  WHERE oid = 'public.commerce_promotion_health_snapshot(timestamptz,timestamptz,integer,boolean)'::regprocedure
), 's', 'health projection is read-only stable and acquires no business lock');

SELECT * FROM finish();
ROLLBACK;
