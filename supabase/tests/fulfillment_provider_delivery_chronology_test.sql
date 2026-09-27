-- pgTAP: provider delivery occurrence time is the canonical delivered_at.

BEGIN;
SELECT plan(29);

INSERT INTO public.clients (id, email, first_name, last_name)
VALUES (
  '72000000-0000-0000-0000-000000000001',
  'provider-chronology@example.invalid',
  'Provider', 'Chronology'
);

INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
VALUES (
  '72000000-0000-0000-0000-000000000002',
  '72000000-0000-0000-0000-000000000001',
  'shipping', 'ul. Czasowa 1', 'Warszawa', '00-001', 'PL'
);

INSERT INTO public.providers (kind, capability, display_name, status)
VALUES ('omnipack', 'fulfillment', 'OmniPack', 'active')
ON CONFLICT (kind) DO NOTHING;

INSERT INTO public.commerce_orders (
  id, client_id, order_number, status, mode, currency, subtotal_cents, total_cents
) VALUES
  (
    '72000000-0000-0000-0000-000000000011',
    '72000000-0000-0000-0000-000000000001',
    'PROVIDER-CHRONOLOGY-1', 'fulfillment_pending', 'one_time', 'PLN', 1000, 1000
  ),
  (
    '72000000-0000-0000-0000-000000000012',
    '72000000-0000-0000-0000-000000000001',
    'PROVIDER-CHRONOLOGY-2', 'fulfillment_pending', 'one_time', 'PLN', 1000, 1000
  );

INSERT INTO public.commerce_fulfillment_orders (
  id, order_id, client_id, shipping_address_id, create_idempotency_key,
  status, provider_kind, shipping_address_snapshot, handed_over_at
) VALUES
  (
    '72000000-0000-0000-0000-000000000021',
    '72000000-0000-0000-0000-000000000011',
    '72000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000002',
    'provider-chronology-fulfillment-1', 'handed_over', 'omnipack', '{}'::jsonb, now()
  ),
  (
    '72000000-0000-0000-0000-000000000022',
    '72000000-0000-0000-0000-000000000012',
    '72000000-0000-0000-0000-000000000001',
    '72000000-0000-0000-0000-000000000002',
    'provider-chronology-fulfillment-2', 'handed_over', 'omnipack', '{}'::jsonb, now()
  );

INSERT INTO public.shipment_external_refs (
  order_id, provider_kind, provider_tracking_id, active
) VALUES
  ('72000000-0000-0000-0000-000000000011', 'omnipack', 'CHRONOLOGY-TRACK-1', true),
  ('72000000-0000-0000-0000-000000000012', 'omnipack', 'CHRONOLOGY-TRACK-2', true);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.commerce_fulfillment_record_tracking_event(text,uuid,text,text,jsonb,uuid,jsonb)',
    'EXECUTE'
  ),
  'anon cannot record provider delivery chronology'
);
SELECT ok(
  NOT has_function_privilege(
    'authenticated',
    'public.commerce_fulfillment_record_tracking_event(text,uuid,text,text,jsonb,uuid,jsonb)',
    'EXECUTE'
  ),
  'authenticated cannot record provider delivery chronology'
);
SELECT ok(
  has_function_privilege(
    'service_role',
    'public.commerce_fulfillment_record_tracking_event(text,uuid,text,text,jsonb,uuid,jsonb)',
    'EXECUTE'
  ),
  'service role retains tracking RPC access'
);

SELECT is(
  public.commerce_fulfillment_record_tracking_event(
    'provider-chronology-delivered-1',
    '72000000-0000-0000-0000-000000000021',
    'delivered', 'CHRONOLOGY-TRACK-1',
    '{"occurredAt":"2026-07-15T13:45:07+02:00"}'::jsonb
  )->>'replayed',
  'false',
  'first delivered evidence records an operation'
);
SELECT is(
  (SELECT delivered_at FROM public.commerce_fulfillment_orders
    WHERE id = '72000000-0000-0000-0000-000000000021'),
  '2026-07-15T11:45:07Z'::timestamptz,
  'first delivery uses the valid explicit-zone provider time'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_operations
    WHERE fulfillment_order_id = '72000000-0000-0000-0000-000000000021'
      AND operation_type = 'tracking_event_recorded'),
  1,
  'first delivery writes exactly one tracking operation'
);

SELECT is(
  public.commerce_fulfillment_record_tracking_event(
    'provider-chronology-delivered-1',
    '72000000-0000-0000-0000-000000000021',
    'delivered', 'CHRONOLOGY-TRACK-1',
    '{"occurredAt":"2026-07-15T10:45:07Z"}'::jsonb
  )->>'replayed',
  'true',
  'same-key replay remains a replay'
);
SELECT is(
  (SELECT delivered_at FROM public.commerce_fulfillment_orders
    WHERE id = '72000000-0000-0000-0000-000000000021'),
  '2026-07-15T10:45:07Z'::timestamptz,
  'same-key replay can correct delivered_at earlier'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_operations
    WHERE fulfillment_order_id = '72000000-0000-0000-0000-000000000021'
      AND operation_type = 'tracking_event_recorded'),
  1,
  'same-key correction does not add an operation'
);

SELECT is(
  public.commerce_fulfillment_record_tracking_event(
    'provider-chronology-delivered-earlier-different-key',
    '72000000-0000-0000-0000-000000000021',
    'delivered', 'CHRONOLOGY-TRACK-1',
    '{"occurredAt":"2026-07-15T09:45:07Z"}'::jsonb
  )->>'replayed',
  'true',
  'delivered evidence with a different key remains a state replay'
);
SELECT is(
  (SELECT delivered_at FROM public.commerce_fulfillment_orders
    WHERE id = '72000000-0000-0000-0000-000000000021'),
  '2026-07-15T09:45:07Z'::timestamptz,
  'different-key replay can correct delivered_at earlier'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_operations
    WHERE fulfillment_order_id = '72000000-0000-0000-0000-000000000021'
      AND operation_type = 'tracking_event_recorded'),
  1,
  'different-key correction preserves one operation'
);

SELECT is(
  public.commerce_fulfillment_record_tracking_event(
    'provider-chronology-delivered-later',
    '72000000-0000-0000-0000-000000000021',
    'delivered', 'CHRONOLOGY-TRACK-1',
    '{"occurredAt":"2026-07-15T20:45:07Z"}'::jsonb
  )->>'replayed',
  'true',
  'later delivered evidence is replayed'
);
SELECT is(
  (SELECT delivered_at FROM public.commerce_fulfillment_orders
    WHERE id = '72000000-0000-0000-0000-000000000021'),
  '2026-07-15T09:45:07Z'::timestamptz,
  'later evidence cannot move delivered_at forward'
);

SELECT is(
  public.commerce_fulfillment_record_tracking_event(
    'provider-chronology-delivered-malformed-replay',
    '72000000-0000-0000-0000-000000000021',
    'delivered', 'CHRONOLOGY-TRACK-1',
    '{"occurredAt":"not-a-provider-time"}'::jsonb
  )->>'replayed',
  'true',
  'malformed different-key delivery remains a state replay'
);
SELECT is(
  (SELECT delivered_at FROM public.commerce_fulfillment_orders
    WHERE id = '72000000-0000-0000-0000-000000000021'),
  '2026-07-15T09:45:07Z'::timestamptz,
  'malformed replay cannot replace known provider chronology with replay time'
);

SELECT is(
  public.commerce_fulfillment_record_tracking_event(
    'provider-chronology-delivered-fallback',
    '72000000-0000-0000-0000-000000000022',
    'delivered', 'CHRONOLOGY-TRACK-2',
    '{"occurredAt":"2026-07-15T12:00:00"}'::jsonb
  )->>'replayed',
  'false',
  'a timestamp without an explicit zone still records delivery'
);
SELECT is(
  (SELECT delivered_at FROM public.commerce_fulfillment_orders
    WHERE id = '72000000-0000-0000-0000-000000000022'),
  now(),
  'missing-zone provider time safely falls back to database time'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_operations
    WHERE fulfillment_order_id = '72000000-0000-0000-0000-000000000022'
      AND operation_type = 'tracking_event_recorded'),
  1,
  'fallback delivery writes one tracking operation'
);

SELECT is(
  public.commerce_fulfillment_record_tracking_event(
    'provider-chronology-delivered-fallback',
    '72000000-0000-0000-0000-000000000022',
    'delivered', 'CHRONOLOGY-TRACK-2',
    '{"occurredAt":"2026-07-14T08:00:00Z"}'::jsonb
  )->>'replayed',
  'true',
  'timed evidence replays the timestamp-less delivery operation'
);
SELECT is(
  (SELECT delivered_at FROM public.commerce_fulfillment_orders
    WHERE id = '72000000-0000-0000-0000-000000000022'),
  '2026-07-14T08:00:00Z'::timestamptz,
  'timed replay corrects the database fallback to provider chronology'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_operations
    WHERE fulfillment_order_id = '72000000-0000-0000-0000-000000000022'
      AND operation_type = 'tracking_event_recorded'),
  1,
  'timed correction still preserves one tracking operation'
);

CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'provider_chronology_race_one',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'provider_chronology_race_two',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);

SELECT extensions.dblink_exec(
  'provider_chronology_race_one',
  $setup$
    INSERT INTO public.clients (id, email, first_name, last_name)
    VALUES (
      '72000000-0000-0000-0000-000000000101',
      'provider-chronology-race@example.invalid',
      'Provider', 'Race'
    );
    INSERT INTO public.addresses (id, client_id, kind, line1, city, postal_code, country)
    VALUES (
      '72000000-0000-0000-0000-000000000102',
      '72000000-0000-0000-0000-000000000101',
      'shipping', 'ul. Wyścigowa 1', 'Warszawa', '00-001', 'PL'
    );
    INSERT INTO public.commerce_orders (
      id, client_id, order_number, status, mode, currency, subtotal_cents, total_cents
    ) VALUES
      (
        '72000000-0000-0000-0000-000000000111',
        '72000000-0000-0000-0000-000000000101',
        'PROVIDER-CHRONOLOGY-RACE-1', 'fulfillment_pending', 'one_time', 'PLN', 1000, 1000
      ),
      (
        '72000000-0000-0000-0000-000000000112',
        '72000000-0000-0000-0000-000000000101',
        'PROVIDER-CHRONOLOGY-RACE-2', 'fulfillment_pending', 'one_time', 'PLN', 1000, 1000
      );
    INSERT INTO public.commerce_fulfillment_orders (
      id, order_id, client_id, shipping_address_id, create_idempotency_key,
      status, provider_kind, shipping_address_snapshot, handed_over_at
    ) VALUES
      (
        '72000000-0000-0000-0000-000000000121',
        '72000000-0000-0000-0000-000000000111',
        '72000000-0000-0000-0000-000000000101',
        '72000000-0000-0000-0000-000000000102',
        'provider-chronology-race-fulfillment-1', 'handed_over', 'omnipack', '{}'::jsonb, now()
      ),
      (
        '72000000-0000-0000-0000-000000000122',
        '72000000-0000-0000-0000-000000000112',
        '72000000-0000-0000-0000-000000000101',
        '72000000-0000-0000-0000-000000000102',
        'provider-chronology-race-fulfillment-2', 'handed_over', 'omnipack', '{}'::jsonb, now()
      );
    INSERT INTO public.shipment_external_refs (
      order_id, provider_kind, provider_tracking_id, active
    ) VALUES
      ('72000000-0000-0000-0000-000000000111', 'omnipack', 'CHRONOLOGY-RACE-1', true),
      ('72000000-0000-0000-0000-000000000112', 'omnipack', 'CHRONOLOGY-RACE-2', true);
    CREATE OR REPLACE FUNCTION public.pgtap_provider_chronology_race(
      p_fulfillment_order_id uuid,
      p_provider_tracking_id text
    ) RETURNS text
    LANGUAGE plpgsql
    SET search_path = public, pg_catalog
    AS $function$
    DECLARE
      v_result jsonb;
    BEGIN
      v_result := public.commerce_fulfillment_record_tracking_event(
        'provider-chronology-concurrent-collision',
        p_fulfillment_order_id,
        'delivered',
        p_provider_tracking_id,
        '{"occurredAt":"2026-07-15T13:45:07Z"}'::jsonb
      );
      RETURN 'ok:' || (v_result->>'replayed');
    EXCEPTION WHEN OTHERS THEN
      RETURN SQLSTATE || ':' || SQLERRM;
    END;
    $function$;
  $setup$
);

SELECT pg_advisory_lock(hashtextextended(
  'commerce-fulfillment-tracking|provider-chronology-concurrent-collision',
  0
));
SELECT extensions.dblink_send_query(
  'provider_chronology_race_one',
  $$SELECT public.pgtap_provider_chronology_race(
    '72000000-0000-0000-0000-000000000121', 'CHRONOLOGY-RACE-1'
  )$$
);
SELECT extensions.dblink_send_query(
  'provider_chronology_race_two',
  $$SELECT public.pgtap_provider_chronology_race(
    '72000000-0000-0000-0000-000000000122', 'CHRONOLOGY-RACE-2'
  )$$
);
SELECT pg_sleep(0.05);
SELECT is(
  extensions.dblink_is_busy('provider_chronology_race_one'),
  1,
  'first colliding writer waits at the idempotency-key lock'
);
SELECT is(
  extensions.dblink_is_busy('provider_chronology_race_two'),
  1,
  'second colliding writer waits at the same idempotency-key lock'
);
SELECT pg_advisory_unlock(hashtextextended(
  'commerce-fulfillment-tracking|provider-chronology-concurrent-collision',
  0
));

CREATE TEMP TABLE pgtap_provider_chronology_race_results (
  outcome text
) ON COMMIT DROP;
INSERT INTO pgtap_provider_chronology_race_results
SELECT result.outcome
  FROM extensions.dblink_get_result('provider_chronology_race_one') AS result(outcome text);
INSERT INTO pgtap_provider_chronology_race_results
SELECT result.outcome
  FROM extensions.dblink_get_result('provider_chronology_race_two') AS result(outcome text);
SELECT * FROM extensions.dblink_get_result('provider_chronology_race_one') AS drained(outcome text);
SELECT * FROM extensions.dblink_get_result('provider_chronology_race_two') AS drained(outcome text);

SELECT is(
  (SELECT count(*)::integer FROM pgtap_provider_chronology_race_results
    WHERE outcome = 'ok:false'),
  1,
  'exactly one colliding writer records delivery'
);
SELECT is(
  (SELECT count(*)::integer FROM pgtap_provider_chronology_race_results
    WHERE outcome = '23505:commerce_fulfillment_tracking_idempotency_conflict'),
  1,
  'the losing writer observes the committed idempotency conflict'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_orders
    WHERE id IN (
      '72000000-0000-0000-0000-000000000121',
      '72000000-0000-0000-0000-000000000122'
    ) AND status = 'delivered'),
  1,
  'only the winning fulfillment is mutated'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_orders
    WHERE id IN (
      '72000000-0000-0000-0000-000000000121',
      '72000000-0000-0000-0000-000000000122'
    ) AND status = 'handed_over'),
  1,
  'the losing fulfillment remains ready for a correctly keyed retry'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_fulfillment_operations
    WHERE idempotency_key = 'provider-chronology-concurrent-collision'),
  1,
  'colliding writers commit exactly one tracking operation'
);

SELECT extensions.dblink_exec(
  'provider_chronology_race_one',
  $cleanup$
    DROP FUNCTION public.pgtap_provider_chronology_race(uuid, text);
    DELETE FROM public.commerce_fulfillment_operations
      WHERE idempotency_key = 'provider-chronology-concurrent-collision';
    DELETE FROM public.shipment_external_refs
      WHERE order_id IN (
        '72000000-0000-0000-0000-000000000111',
        '72000000-0000-0000-0000-000000000112'
      );
    DELETE FROM public.commerce_fulfillment_orders
      WHERE id IN (
        '72000000-0000-0000-0000-000000000121',
        '72000000-0000-0000-0000-000000000122'
      );
    DELETE FROM public.commerce_orders
      WHERE id IN (
        '72000000-0000-0000-0000-000000000111',
        '72000000-0000-0000-0000-000000000112'
      );
    DELETE FROM public.addresses WHERE id = '72000000-0000-0000-0000-000000000102';
    DELETE FROM public.clients WHERE id = '72000000-0000-0000-0000-000000000101';
  $cleanup$
);
SELECT extensions.dblink_disconnect('provider_chronology_race_one');
SELECT extensions.dblink_disconnect('provider_chronology_race_two');

SELECT * FROM finish();
ROLLBACK;
