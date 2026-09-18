-- pgTAP: durable subscription petfood-surface ratchet.
--
-- Purpose: catch live-schema or ad-hoc SQL drift that migration-diff lint cannot see.
-- Run via: scripts/local-supabase-db-test.sh / npm run test:db:local

BEGIN;
SELECT plan(10);

CREATE TEMP TABLE _durable_petfood_pins (
  surface text NOT NULL,
  token text NOT NULL
) ON COMMIT DROP;

INSERT INTO _durable_petfood_pins (surface, token) VALUES
  ('event_type', 'subscription.customer_self_service.swap_recipe'),
  ('event_type', 'subscription.customer_self_service.update_recipe_mix'),
  ('event_type', 'subscription.customer_self_service.set_portion_mode'),
  ('size_constraint_key', 'value'),
  ('size_constraint_key', 'mode'),
  ('size_constraint_key', 'portionFactor'),
  ('raise_exception', 'customer_self_service_invalid_recipe_set'),
  ('raise_exception', 'customer_self_service_recipe_total_mismatch'),
  ('raise_exception', 'customer_self_service_invalid_recipe_qty'),
  ('raise_exception', 'customer_self_service_invalid_portion_mode');

INSERT INTO public.clients (id, email)
VALUES ('c3a00000-0000-0000-0000-000000000001', 'durable-petfood-ratchet@example.invalid');

INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, status, next_cycle_at, size_constraint
) VALUES (
  '5b0a0000-0000-0000-0000-0000000000c3',
  'c3a00000-0000-0000-0000-000000000001',
  28,
  'PLN',
  'active',
  '2026-09-01T00:00:00Z',
  '{"value":28,"mode":"topper","portionFactor":0.5}'::jsonb
);

INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES
  (
    '5b0a0000-0000-0000-0000-0000000000c3',
    'subscription.customer_self_service.swap_recipe',
    'durable-petfood-ratchet-swap',
    '{}'::jsonb,
    now()
  ),
  (
    '5b0a0000-0000-0000-0000-0000000000c3',
    'subscription.customer_self_service.update_recipe_mix',
    'durable-petfood-ratchet-mix',
    '{}'::jsonb,
    now()
  ),
  (
    '5b0a0000-0000-0000-0000-0000000000c3',
    'subscription.customer_self_service.set_portion_mode',
    'durable-petfood-ratchet-portion',
    '{}'::jsonb,
    now()
  );

SELECT ok(
  (SELECT count(*) > 0
     FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name LIKE 'subscription%'),
  'durable petfood ratchet scans subscription-owned table columns');

SELECT ok(
  (SELECT count(*) > 0
     FROM pg_constraint c
     JOIN pg_class rel ON rel.oid = c.conrelid
     JOIN pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public'
      AND rel.relname LIKE 'subscription%'
      AND c.contype = 'c'),
  'durable petfood ratchet scans subscription-owned CHECK constraints');

SELECT ok(
  (SELECT count(*) > 0
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (p.proname LIKE 'customer_self_service%' OR p.proname LIKE 'subscription_%')),
  'durable petfood ratchet scans subscription/customer self-service functions');

SELECT is(
  (SELECT count(*)::int
     FROM public.subscription_events
    WHERE subscription_id = '5b0a0000-0000-0000-0000-0000000000c3'
      AND event_type IN (
        'subscription.customer_self_service.swap_recipe',
        'subscription.customer_self_service.update_recipe_mix',
        'subscription.customer_self_service.set_portion_mode'
      )),
  3,
  'fixture emits every currently pinned legacy petfood event_type');

SELECT is(
  (SELECT count(*)::int
     FROM jsonb_object_keys((
       SELECT size_constraint
         FROM public.subscriptions
        WHERE id = '5b0a0000-0000-0000-0000-0000000000c3'
     )) AS key
    WHERE key IN ('value', 'mode', 'portionFactor')),
  3,
  'fixture materializes the pinned size_constraint keys');

WITH hits AS (
  SELECT c.table_name, c.column_name, (m)[2] AS token
    FROM information_schema.columns c
    CROSS JOIN LATERAL regexp_matches(
      c.column_name,
      '(^|[^[:alnum:]_])(kcal_per_[[:alnum:]_]+|daily_kcal|dailyKcal|portionFactor|recipe_mix|portion_mode|swap_recipe|update_recipe_mix|set_portion_mode|kcal|recipe|portion|feeding|topper|pet_type)($|[^[:alnum:]_])',
      'gi'
    ) AS m
   WHERE c.table_schema = 'public'
     AND c.table_name LIKE 'subscription%'
)
SELECT is(
  (SELECT count(*)::int FROM hits),
  0,
  'subscription-owned column identifiers contain no unpinned petfood tokens');

WITH hits AS (
  SELECT rel.relname, c.conname, pg_get_constraintdef(c.oid) AS definition, (m)[2] AS token
    FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
    CROSS JOIN LATERAL regexp_matches(
      pg_get_constraintdef(c.oid),
      '(^|[^[:alnum:]_])(kcal_per_[[:alnum:]_]+|daily_kcal|dailyKcal|portionFactor|recipe_mix|portion_mode|swap_recipe|update_recipe_mix|set_portion_mode|kcal|recipe|portion|feeding|topper|pet_type)($|[^[:alnum:]_])',
      'gi'
    ) AS m
   WHERE n.nspname = 'public'
     AND rel.relname LIKE 'subscription%'
     AND c.contype = 'c'
     AND NOT EXISTS (
       SELECT 1 FROM _durable_petfood_pins p
        WHERE p.surface = 'check_membership'
          AND lower(p.token) = lower((m)[2])
     )
)
SELECT is(
  (SELECT count(*)::int FROM hits),
  0,
  'subscription-owned CHECK constraints contain no unpinned petfood tokens');

WITH exception_codes AS (
  SELECT p.proname, (e)[1] AS code
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL regexp_matches(pg_get_functiondef(p.oid), 'RAISE\s+EXCEPTION\s+''([^'']+)''', 'gi') AS e
   WHERE n.nspname = 'public'
     AND (p.proname LIKE 'customer_self_service%' OR p.proname LIKE 'subscription_%')
),
hits AS (
  SELECT *
    FROM exception_codes
   WHERE code ~* '(^|[^[:alnum:]_])(kcal_per_[[:alnum:]_]+|daily_kcal|dailyKcal|portionFactor|recipe_mix|portion_mode|swap_recipe|update_recipe_mix|set_portion_mode|kcal|recipe|portion|feeding|topper|pet_type)($|[^[:alnum:]_])'
     AND NOT EXISTS (
       SELECT 1 FROM _durable_petfood_pins p
        WHERE p.surface = 'raise_exception'
          AND lower(p.token) = lower(exception_codes.code)
     )
)
SELECT is(
  (SELECT count(*)::int FROM hits),
  0,
  'subscription/customer self-service RAISE EXCEPTION codes contain no unpinned petfood tokens');

WITH hits AS (
  SELECT event_type
    FROM public.subscription_events
   WHERE subscription_id = '5b0a0000-0000-0000-0000-0000000000c3'
     AND event_type LIKE 'subscription.%'
     AND event_type ~* '(^|[^[:alnum:]_])(kcal_per_[[:alnum:]_]+|daily_kcal|dailyKcal|portionFactor|recipe_mix|portion_mode|swap_recipe|update_recipe_mix|set_portion_mode|kcal|recipe|portion|feeding|topper|pet_type)($|[^[:alnum:]_])'
     AND NOT EXISTS (
       SELECT 1 FROM _durable_petfood_pins p
        WHERE p.surface = 'event_type'
          AND lower(p.token) = lower(subscription_events.event_type)
     )
)
SELECT is(
  (SELECT count(*)::int FROM hits),
  0,
  'fixture-produced subscription event_types contain no unpinned petfood tokens');

WITH keys AS (
  SELECT key
    FROM public.subscriptions s
    CROSS JOIN LATERAL jsonb_object_keys(coalesce(s.size_constraint, '{}'::jsonb)) AS key
   WHERE s.id = '5b0a0000-0000-0000-0000-0000000000c3'
),
hits AS (
  SELECT key
    FROM keys
   WHERE key ~* '(^|[^[:alnum:]_])(kcal_per_[[:alnum:]_]+|daily_kcal|dailyKcal|portionFactor|recipe_mix|portion_mode|swap_recipe|update_recipe_mix|set_portion_mode|kcal|recipe|portion|feeding|topper|pet_type)($|[^[:alnum:]_])'
     AND NOT EXISTS (
       SELECT 1 FROM _durable_petfood_pins p
        WHERE p.surface = 'size_constraint_key'
          AND lower(p.token) = lower(keys.key)
     )
)
SELECT is(
  (SELECT count(*)::int FROM hits),
  0,
  'fixture-produced size_constraint keys contain no unpinned petfood tokens');

SELECT * FROM finish();
ROLLBACK;
