-- pgTAP: two canonical order transactions racing for limit=1 serialize on code.
BEGIN;
SELECT plan(5);
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
SELECT extensions.dblink_connect(
  'promo_checkout_a',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'promo_checkout_b',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);

SELECT extensions.dblink_exec('promo_checkout_a', $setup$
  INSERT INTO public.clients (id, email) VALUES
    ('b1410000-0000-4000-8000-000000000001', 'promotion-race-a@example.invalid'),
    ('b1410000-0000-4000-8000-000000000002', 'promotion-race-b@example.invalid');
  INSERT INTO public.promotions (
    id, code, name, trigger_type, discount_type, discount_value,
    applies_to_kind, stacking_rule, status, promotion_engine_version,
    benefit_lane, benefit_kind, benefit_value_bps
  ) VALUES (
    'b1420000-0000-4000-8000-000000000001', 'V2:B142:RACE', 'Race 80',
    'coupon_code', 'percentage', 80, 'order_total', 'exclusive', 'draft',
    'promotion-engine.v2', 'product', 'target_percentage', 8000
  );
  INSERT INTO public.promotion_codes (
    id, code, name, scopes, valid_from, valid_to, status, revision,
    redemption_limit_global
  ) VALUES (
    'b1430000-0000-4000-8000-000000000001', 'RACE80', 'Race 80',
    ARRAY['one_time'], now() - interval '1 hour', now() + interval '1 day',
    'active', 1, 1
  );
  INSERT INTO public.promotion_code_bindings (promotion_code_id, promotion_id, lane)
  VALUES (
    'b1430000-0000-4000-8000-000000000001',
    'b1420000-0000-4000-8000-000000000001',
    'product'
  );

  CREATE OR REPLACE FUNCTION public.pgtap_try_promotion_order(
    p_idempotency_key text,
    p_client_id uuid,
    p_delay numeric
  ) RETURNS text
  LANGUAGE plpgsql
  AS $function$
  DECLARE
    v_quote jsonb;
    v_draft jsonb;
  BEGIN
    v_quote := jsonb_build_object(
      'contractVersion', 'commerce.v0',
      'quote', jsonb_build_object(
        'context', jsonb_build_object('mode', 'one_time'),
        'discounts', jsonb_build_array(jsonb_build_object(
          'promotionId', 'b1420000-0000-4000-8000-000000000001',
          'code', 'RACE80',
          'label', 'Race 80',
          'appliesTo', 'order_total',
          'amountOffMinor', 8000,
          'reasonCode', 'promotion_code_v2',
          'promotionEngineVersion', 'promotion-engine.v2',
          'promotionCodeRevision', 1,
          'promotionDefinitionFingerprint', private.commerce_promotion_definition_fingerprint(
            'b1430000-0000-4000-8000-000000000001',
            'b1420000-0000-4000-8000-000000000001'
          ),
          'floorApplied', false
        ))
      )
    );
    v_draft := jsonb_build_object(
      'contractVersion', 'commerce.v0',
      'source', 'commerce.order_draft.bff.v0',
      'status', 'draft',
      'paymentStatus', 'not_started',
      'currency', 'PLN',
      'taxIncluded', true,
      'lines', jsonb_build_array(jsonb_build_object(
        'sku', p_idempotency_key,
        'productSlug', 'promotion-race',
        'quantity', 1,
        'unitPriceGross', jsonb_build_object('amountMinor', 10000, 'currency', 'PLN'),
        'lineSubtotalGross', jsonb_build_object('amountMinor', 10000, 'currency', 'PLN'),
        'tax', jsonb_build_object(
          'vatRateBps', 800,
          'netAmount', jsonb_build_object('amountMinor', 9259, 'currency', 'PLN'),
          'vatAmount', jsonb_build_object('amountMinor', 741, 'currency', 'PLN'),
          'grossAmount', jsonb_build_object('amountMinor', 10000, 'currency', 'PLN')
        )
      )),
      'totals', jsonb_build_object(
        'subtotalGross', jsonb_build_object('amountMinor', 10000, 'currency', 'PLN'),
        'discountTotalGross', jsonb_build_object('amountMinor', 8000, 'currency', 'PLN'),
        'netTotal', jsonb_build_object('amountMinor', 1852, 'currency', 'PLN'),
        'taxTotal', jsonb_build_object('amountMinor', 148, 'currency', 'PLN'),
        'totalGross', jsonb_build_object('amountMinor', 2000, 'currency', 'PLN')
      )
    );
    PERFORM public.commerce_create_order_draft_with_outbox(
      p_idempotency_key, v_quote, v_draft, p_client_id
    );
    PERFORM pg_sleep(p_delay);
    RETURN 'ok';
  EXCEPTION WHEN OTHERS THEN
    RETURN SQLERRM;
  END
  $function$;
$setup$);

SELECT extensions.dblink_send_query(
  'promo_checkout_a',
  $q$SELECT public.pgtap_try_promotion_order(
    'promo-race-order-a', 'b1410000-0000-4000-8000-000000000001', 0.30
  )$q$
);
SELECT pg_sleep(0.03);
SELECT extensions.dblink_send_query(
  'promo_checkout_b',
  $q$SELECT public.pgtap_try_promotion_order(
    'promo-race-order-b', 'b1410000-0000-4000-8000-000000000002', 0
  )$q$
);
SELECT pg_sleep(0.03);

SELECT is(
  extensions.dblink_is_busy('promo_checkout_b'),
  1,
  'second canonical order waits on the promotion-code capacity lock');
SELECT is(
  (SELECT outcome FROM extensions.dblink_get_result('promo_checkout_a') AS result(outcome text)),
  'ok',
  'first concurrent canonical order wins');
SELECT count(*) FROM extensions.dblink_get_result('promo_checkout_a') AS drained(outcome text);
SELECT is(
  (SELECT outcome FROM extensions.dblink_get_result('promo_checkout_b') AS result(outcome text)),
  'promotion_code_global_limit_reached',
  'second concurrent canonical order loses deterministically');
SELECT count(*) FROM extensions.dblink_get_result('promo_checkout_b') AS drained(outcome text);
SELECT is(
  (SELECT count(*)::integer
     FROM public.promotion_code_claims
    WHERE promotion_code_id = 'b1430000-0000-4000-8000-000000000001'
      AND status IN ('reserved','redeemed')),
  1,
  'limit one has exactly one capacity-consuming claim');
SELECT is(
  (SELECT jsonb_build_object(
    'orders', count(DISTINCT o.id),
    'items', count(DISTINCT i.id),
    'outbox', count(DISTINCT e.id),
    'idempotency', count(DISTINCT k.id)
  )
   FROM public.commerce_orders o
   JOIN public.commerce_order_items i ON i.order_id = o.id
   LEFT JOIN public.outbox_events e
     ON e.aggregate_id = o.id AND e.event_type = 'commerce.order_draft.created'
   LEFT JOIN public.commerce_idempotency_keys k
     ON k.scope = 'commerce.order_draft.create'
    AND k.idempotency_key IN ('promo-race-order-a','promo-race-order-b')
   WHERE i.product_snapshot->>'sku' IN ('promo-race-order-a','promo-race-order-b')),
  '{"orders":1,"items":1,"outbox":1,"idempotency":1}'::jsonb,
  'the losing transaction leaves no partial canonical order graph');

SELECT extensions.dblink_exec('promo_checkout_a', $cleanup$
  DROP FUNCTION public.pgtap_try_promotion_order(text,uuid,numeric);
  DELETE FROM public.promotion_code_claims
   WHERE promotion_code_id = 'b1430000-0000-4000-8000-000000000001';
  DELETE FROM public.outbox_events
   WHERE aggregate_id IN (
     SELECT o.id FROM public.commerce_orders o
     JOIN public.commerce_order_items i ON i.order_id = o.id
     WHERE i.product_snapshot->>'sku' IN ('promo-race-order-a','promo-race-order-b')
   );
  DELETE FROM public.commerce_order_items
   WHERE product_snapshot->>'sku' IN ('promo-race-order-a','promo-race-order-b');
  DELETE FROM public.commerce_idempotency_keys
   WHERE scope = 'commerce.order_draft.create'
     AND idempotency_key IN ('promo-race-order-a','promo-race-order-b');
  DELETE FROM public.commerce_orders o
   WHERE NOT EXISTS (SELECT 1 FROM public.commerce_order_items i WHERE i.order_id = o.id)
     AND o.metadata#>>'{quoteSnapshot,quote,discounts,0,code}' = 'RACE80';
  DELETE FROM public.promotion_code_bindings
   WHERE promotion_code_id = 'b1430000-0000-4000-8000-000000000001';
  DELETE FROM public.promotion_codes
   WHERE id = 'b1430000-0000-4000-8000-000000000001';
  DELETE FROM public.promotions
   WHERE id = 'b1420000-0000-4000-8000-000000000001';
  DELETE FROM public.clients
   WHERE id IN (
     'b1410000-0000-4000-8000-000000000001',
     'b1410000-0000-4000-8000-000000000002'
   );
$cleanup$);
SELECT extensions.dblink_disconnect('promo_checkout_a');
SELECT extensions.dblink_disconnect('promo_checkout_b');
SELECT * FROM finish();
ROLLBACK;
