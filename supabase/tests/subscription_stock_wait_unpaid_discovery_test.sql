-- pgTAP: real pre-provider graphs survive discovery, freeze, races and restock.
-- All catalog/mandate rows are synthetic and rolled back; no PSP or mail sender.
BEGIN;
SELECT no_plan();
-- Selected managed test profile prerequisites, matching canonical_order_money_test.sql.
INSERT INTO public.commerce_settings(key,value_text,value_minor) VALUES
 ('settlement_currency','XTS',NULL),('settlement_region','ZZ',NULL),('min_product_payable_minor',NULL,1)
ON CONFLICT(key) DO UPDATE SET value_text=EXCLUDED.value_text,value_minor=EXCLUDED.value_minor;
INSERT INTO public.variant_formats(code,display_name) VALUES('can','Synthetic can') ON CONFLICT(code) DO NOTHING;
INSERT INTO public.variant_unit_forms(code,display_name) VALUES('can','Synthetic can') ON CONFLICT(code) DO NOTHING;
-- Read the installed, approved provider binding rather than duplicating its vendor literal.
-- The real-PG harness separately binds these units to their immutable registry digests.
CREATE TEMP TABLE managed_stock_fixture AS SELECT
 (regexp_match(pg_get_functiondef('public.inventory_available_to_promise(uuid,timestamptz,boolean)'::regprocedure),
  $binding$stock.provider_kind='([^']+)'$binding$))[1] AS provider,
 (regexp_match(pg_get_functiondef('public.inventory_reserve_order(text,uuid,uuid,uuid,uuid,integer,text,text,timestamptz,jsonb,text)'::regprocedure),
  $binding$WHERE code = '([^']+)'$binding$))[1] AS location;
-- Explicit synthetic provider/location prerequisite; no live provider access.
INSERT INTO public.providers(kind,capability,display_name,status,enabled_for_region)
VALUES((SELECT provider FROM managed_stock_fixture),'fulfillment','Synthetic stock wait','active',ARRAY['ZZ']) ON CONFLICT(kind) DO NOTHING;
INSERT INTO public.inventory_locations(code,display_name,kind,status,region,fulfillable,provider_kind)
VALUES((SELECT location FROM managed_stock_fixture),'Synthetic stock wait','third_party_logistics','active','ZZ',true,(SELECT provider FROM managed_stock_fixture))
ON CONFLICT(code) DO NOTHING;
INSERT INTO public.catalog_products (
  id, slug, status, name, ingredients, allergens, marketing_content
) VALUES (
  'ce000000-0000-4000-8000-000000000001', 'unpaid-wait-test', 'active',
  'Canonical renewal', ARRAY['test']::text[], ARRAY[]::text[], '{}'::jsonb
);
INSERT INTO public.catalog_skus (
  id, product_id, sku, title, pet_type, status, net_weight_g, format_code,
  unit_form_code, kcal_per_unit, feeding_grams_per_unit, sellable_standalone,
  sellable_in_subscription, min_order_qty
) VALUES
(
  'ce000000-0000-4000-8000-000000000002',
  'ce000000-0000-4000-8000-000000000001',
  'UNPAID-WAIT-A', 'Canonical renewal SKU A', 'dog', 'active', 400, 'can',
  'can', 400, 400, true, true, 1
),
(
  'ce000000-0000-4000-8000-000000000005',
  'ce000000-0000-4000-8000-000000000001',
  'UNPAID-WAIT-B', 'Canonical renewal SKU B', 'dog', 'active', 800, 'can',
  'can', 400, 400, true, true, 1
);
SELECT public.fulfillment_provider_upsert_stock_current(
  'unpaid-wait-test-stock-1',
  (SELECT provider FROM managed_stock_fixture),
  'UNPAID-WAIT-A',
  10, 0, 0,
  now(),
  now() + interval '6 hours',
  'unpaid-wait-test-stock-run-1',
  '{"source":"canonical_order_money_test"}'::jsonb
);
SELECT public.fulfillment_provider_upsert_stock_current(
  'unpaid-wait-test-stock-2',
  (SELECT provider FROM managed_stock_fixture),
  'UNPAID-WAIT-B',
  10, 0, 0,
  now(),
  now() + interval '6 hours',
  'unpaid-wait-test-stock-run-1',
  '{"source":"canonical_order_money_test"}'::jsonb
);
INSERT INTO public.clients (id, email)
VALUES ('ce000000-0000-4000-8000-000000000003', 'unpaid-wait-test@example.invalid');
UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=100
 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku IN ('UNPAID-WAIT-A','UNPAID-WAIT-B');

CREATE TEMP TABLE _swu_order AS SELECT '{
    "contractVersion":"commerce.v0","source":"subscription.own_engine.v0",
    "status":"pending_payment","paymentStatus":"pending","currency":"XTS",
    "taxIncluded":true,
    "lines":[{
      "sku":"UNPAID-WAIT-A","productSlug":"unpaid-wait-test","quantity":1,
      "unitPriceGross":{"amountMinor":1000,"currency":"XTS"},
      "lineSubtotalGross":{"amountMinor":1000,"currency":"XTS"},
      "tax":{"vatRateBps":800,
        "netAmount":{"amountMinor":926,"currency":"XTS"},
        "vatAmount":{"amountMinor":74,"currency":"XTS"},
        "grossAmount":{"amountMinor":1000,"currency":"XTS"}}
    },{
      "sku":"UNPAID-WAIT-B","productSlug":"unpaid-wait-test","quantity":1,
      "unitPriceGross":{"amountMinor":2000,"currency":"XTS"},
      "lineSubtotalGross":{"amountMinor":2000,"currency":"XTS"},
      "tax":{"vatRateBps":800,
        "netAmount":{"amountMinor":1852,"currency":"XTS"},
        "vatAmount":{"amountMinor":148,"currency":"XTS"},
        "grossAmount":{"amountMinor":2000,"currency":"XTS"}}
    }],
    "totals":{
      "subtotalGross":{"amountMinor":3000,"currency":"XTS"},
      "discountTotalGross":{"amountMinor":900,"currency":"XTS"},
      "shippingGross":{"amountMinor":1500,"currency":"XTS"},
      "shippingDiscountGross":{"amountMinor":1500,"currency":"XTS"},
      "netTotal":{"amountMinor":1945,"currency":"XTS"},
      "taxTotal":{"amountMinor":155,"currency":"XTS"},
      "totalGross":{"amountMinor":2100,"currency":"XTS"}
    }
  }'::jsonb AS snapshot;
CREATE TEMP TABLE _swu (
 name text PRIMARY KEY, subscription_id uuid, literal text, input jsonb, due jsonb,
 response jsonb, cycle_id uuid, order_id uuid, payment_id uuid, frozen jsonb
);
CREATE FUNCTION pg_temp.swu_seed(p_name text,p_number integer,p_literal text DEFAULT '2026-08-01T10:00:00.000Z',p_create boolean DEFAULT true)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_sub uuid := ('ce000000-0000-4000-8000-'||lpad(p_number::text,12,'0'))::uuid;
 v_method text := 'pm_swu_'||v_sub::text; v_input jsonb; v_response jsonb; v_snapshot jsonb;
BEGIN
 INSERT INTO public.subscriptions(id,client_id,cadence_days,size_constraint,currency,region_code,status,next_cycle_at,
  started_at,edit_window_hours,template_version,payment_method_ref,payment_method_kind,timezone)
 VALUES(v_sub,'ce000000-0000-4000-8000-000000000003',14,'{"kind":"unit_count","value":2}','XTS','ZZ','active',
  p_literal::timestamptz,'2026-07-01T10:00:00Z',72,1,v_method,'card','UTC');
 INSERT INTO public.subscription_lines(subscription_id,variant_id,qty,sort_order,is_addon,template_version,line_metadata)
 VALUES(v_sub,'ce000000-0000-4000-8000-000000000002',1,1,false,1,'{}'),
  (v_sub,'ce000000-0000-4000-8000-000000000005',1,2,false,1,'{}');
 INSERT INTO public.commerce_payment_method_refs(client_id,subscription_id,provider_kind,method_kind,
  provider_customer_ref,provider_method_ref,status,active)
 VALUES('ce000000-0000-4000-8000-000000000003',v_sub,'example','card','cus_swu',v_method,'active',true);
 SELECT snapshot INTO v_snapshot FROM _swu_order;
 v_input:=jsonb_build_object('subscriptionId',v_sub,'scheduledAt',p_literal,'cycleNumber',1,
  'idempotencyKey','subscription:'||v_sub::text||':cycle:'||p_literal,
  'templateSnapshot',public.subscription_current_template_snapshot(v_sub),
  'pricingSnapshot',jsonb_build_object('contractVersion','commerce.v0','source','subscription.own_engine.v0',
   'subscriptionId',v_sub,'scheduledAt',p_literal,'cycleNumber',1,'totals',v_snapshot->'totals'),'orderSnapshot',v_snapshot);
 PERFORM public.subscription_delivery_alignment_admit_renewal(v_sub,p_literal::timestamptz,now());
 IF p_create THEN
  v_response:=public.subscription_create_cycle_order_with_outbox(v_input->>'idempotencyKey',v_sub,1,p_literal::timestamptz,
   v_input->'templateSnapshot',v_input->'pricingSnapshot',v_snapshot);
 END IF;
 INSERT INTO _swu(name,subscription_id,literal,input,response,cycle_id,order_id,payment_id)
 VALUES(p_name,v_sub,p_literal,v_input,v_response,(v_response#>>'{subscriptionCycleOrder,cycleId}')::uuid,
  replace(v_response#>>'{subscriptionCycleOrder,orderId}','order_','')::uuid,
  replace(v_response#>>'{subscriptionCycleOrder,paymentId}','payment_','')::uuid);
END; $$;
CREATE FUNCTION pg_temp.swu_refresh(p_name text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_row _swu%ROWTYPE; v_due jsonb;
BEGIN
 SELECT * INTO v_row FROM _swu WHERE name=p_name;
 SELECT candidate INTO v_due FROM public.subscription_stock_wait_candidates(50,now()) candidate
  WHERE candidate->>'subscriptionId'=v_row.subscription_id::text;
 UPDATE _swu SET due=v_due,frozen=public.subscription_stock_wait_frozen(v_row.subscription_id,v_row.literal::timestamptz) WHERE name=p_name;
END; $$;
CREATE FUNCTION pg_temp.swu_admit(p_name text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.subscription_stock_wait_admit(input,due,now()) FROM _swu WHERE name=p_name;
$$;
CREATE FUNCTION pg_temp.swu_candidates(p_name text) RETURNS integer LANGUAGE sql AS $$
 SELECT count(*)::integer FROM public.subscription_stock_wait_candidates(50,now()) candidate
 WHERE candidate->>'subscriptionId'=(SELECT subscription_id::text FROM _swu WHERE name=p_name);
$$;
CREATE FUNCTION pg_temp.swu_intent(p_name text) RETURNS jsonb LANGUAGE sql AS $$
 SELECT public.commerce_payment_control_create_intent(input->>'idempotencyKey'||':payment-intent','subscription_cycle',
  order_id,subscription_id,cycle_id,2100,'XTS',jsonb_build_object('source','subscription.renewal.cron.v0',
   'runtimeIdempotencyKey',input->>'idempotencyKey','cycleNumber',1,'scheduledAt',literal)) FROM _swu WHERE name=p_name;
$$;

-- Real raw creation reproduces a crash before any private case/intent exists.
SELECT pg_temp.swu_seed('crash',10,'2026-08-01T12:00:00+02:00');
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_normal_due(50,now()) candidate
 WHERE candidate->>'subscriptionId'=(SELECT subscription_id::text FROM _swu WHERE name='crash')),0,'ordinary pending exclusion is preserved');
SELECT is(pg_temp.swu_candidates('crash'),1,'private reader discovers a stocked no-case crash');
SELECT pg_temp.swu_refresh('crash');
SELECT is((SELECT due->>'nextCycleAt' FROM _swu WHERE name='crash'),'2026-08-01T12:00:00+02:00','alternate literal timestamp bytes survive discovery');
SELECT is((SELECT frozen->'case' FROM _swu WHERE name='crash'),'null'::jsonb,'no case is manufactured by freeze');
SELECT is((SELECT frozen->'binding' FROM _swu WHERE name='crash'),(SELECT due->'stockWaitRecovery' FROM _swu WHERE name='crash'),'selection binds the exact frozen graph');
SELECT is((SELECT frozen#>'{snapshots,templateSnapshot}' FROM _swu WHERE name='crash'),(SELECT input->'templateSnapshot' FROM _swu WHERE name='crash'),'freeze reads original template');
SELECT is((SELECT frozen#>'{snapshots,pricingSnapshot}' FROM _swu WHERE name='crash'),(SELECT input->'pricingSnapshot' FROM _swu WHERE name='crash'),'freeze reads original prices');
SELECT is((SELECT frozen#>'{snapshots,orderSnapshot}' FROM _swu WHERE name='crash'),(SELECT input->'orderSnapshot' FROM _swu WHERE name='crash'),'freeze reads original order agreement');
SELECT is(pg_temp.swu_admit('crash')#>>'{subscriptionCycleOrder,orderId}',(SELECT response#>>'{subscriptionCycleOrder,orderId}' FROM _swu WHERE name='crash'),'stocked crash replays original order');
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_cases WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='crash')),0,'stocked crash creates no wait');
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE event_type IN ('subscription_stock_wait.started','subscription_stock_wait.resumed')),0,'stocked crash creates no false wait notices');
SELECT is((SELECT count(*)::integer FROM public.commerce_payment_intents WHERE order_id=(SELECT order_id FROM _swu WHERE name='crash')),0,'stock admission does not create intent');

-- Future template edits cannot reprice an already-agreed pending graph.
UPDATE public.subscription_lines SET qty=2 WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='crash');
UPDATE public.subscriptions SET template_version=2 WHERE id=(SELECT subscription_id FROM _swu WHERE name='crash');
SELECT pg_temp.swu_refresh('crash');
SELECT is((SELECT frozen#>'{snapshots,templateSnapshot}' FROM _swu WHERE name='crash'),(SELECT input->'templateSnapshot' FROM _swu WHERE name='crash'),'future template edit retains locked cycle basket');
SELECT is(pg_temp.swu_admit('crash')#>>'{subscriptionCycleOrder,cycleId}',(SELECT cycle_id::text FROM _swu WHERE name='crash'),'template edit still replays same cycle');
SELECT is((SELECT total_cents FROM public.commerce_orders WHERE id=(SELECT order_id FROM _swu WHERE name='crash')),2100,'future template edit retains frozen price');

-- Expired original holds: shortage, partial restock and full restock reuse graph.
UPDATE public.inventory_reservations SET expires_at=now()-interval '2 hours'
 WHERE order_id=(SELECT order_id FROM _swu WHERE name='crash') AND status='reserved';
SELECT public.commerce_sweep_expired_retry_holds(now(),50);
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations
 WHERE order_id=(SELECT order_id FROM _swu WHERE name='crash') AND status='reserved'),0,
 'real expired reservations are released by the sweep before recovery');
UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=0 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku IN ('UNPAID-WAIT-A','UNPAID-WAIT-B');
CREATE TEMP TABLE _swu_preflight_refusal AS SELECT public.subscription_cycle_reservation_preflight(order_id,now()) result FROM _swu WHERE name='crash';
SELECT is((SELECT (result->>'ok')::boolean FROM _swu_preflight_refusal),false,'real inventory shortage refuses pre-charge reservation');
SELECT is((SELECT result->>'reason' FROM _swu_preflight_refusal),'reservation_preflight_blocked',
 'managed graph preserves its actual stock-refusal vocabulary');
SELECT is(pg_temp.swu_candidates('crash'),1,'expired unpaid holds remain rediscoverable');
SELECT pg_temp.swu_refresh('crash');
SELECT is((pg_temp.swu_admit('crash')->>'waiting')::boolean,true,'genuine complete-basket shortage creates durable wait');
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_cases WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='crash')),1,'one case adopts the original graph');
SELECT is((SELECT jsonb_array_length(deficits) FROM public.subscription_stock_wait_cases WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='crash')),2,'all original lines are deficits');
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE event_type='subscription_stock_wait.started'),1,'one started transition is committed');
UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=100 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku='UNPAID-WAIT-A';
SELECT pg_temp.swu_refresh('crash');
SELECT is((pg_temp.swu_admit('crash')->>'waiting')::boolean,true,'partial restock keeps original obligation waiting');
SELECT is((SELECT jsonb_array_length(deficits) FROM public.subscription_stock_wait_cases WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='crash')),1,'partial restock records remaining original line');
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations WHERE order_id=(SELECT order_id FROM _swu WHERE name='crash') AND status='reserved'),0,'partial restock acquires no partial basket');
UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=100 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku='UNPAID-WAIT-B';
SELECT pg_temp.swu_refresh('crash');
SELECT is((pg_temp.swu_admit('crash')->>'waiting')::boolean,false,'full restock secures the original obligation');
SELECT is(pg_temp.swu_admit('crash')#>>'{subscriptionCycleOrder,paymentId}',(SELECT response#>>'{subscriptionCycleOrder,paymentId}' FROM _swu WHERE name='crash'),'repeated restock replays original payment');
SELECT is((SELECT count(*)::integer FROM public.subscription_cycles WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='crash')),1,'repeated admission retains one cycle');
SELECT is((SELECT count(*)::integer FROM public.commerce_orders WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='crash')),1,'repeated admission retains one order');
SELECT is((SELECT count(*)::integer FROM public.commerce_payments WHERE order_id=(SELECT order_id FROM _swu WHERE name='crash')),1,'repeated admission retains one payment');
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations WHERE order_id=(SELECT order_id FROM _swu WHERE name='crash') AND status='reserved'),2,'both original item holds are secured');
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE event_type='subscription_stock_wait.started'),1,'restock replay emits no second started notice');
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE event_type='subscription_stock_wait.resumed'),0,'stock alone is not a resumed realization');

-- Prepared local intent without provider work is replayed byte-for-byte.
SELECT pg_temp.swu_seed('intent',11);
SELECT pg_temp.swu_intent('intent');
SELECT pg_temp.swu_refresh('intent');
SELECT is(pg_temp.swu_candidates('intent'),1,'created intent with no attempt remains recoverable');
SELECT is(pg_temp.swu_admit('intent')#>>'{subscriptionCycleOrder,orderId}',(SELECT response#>>'{subscriptionCycleOrder,orderId}' FROM _swu WHERE name='intent'),'created-intent recovery preserves original order');
SELECT is((pg_temp.swu_intent('intent')#>>'{paymentIntent,replayed}')::boolean,true,'same emitted intent key and metadata replay original intent');
SELECT is((SELECT count(*)::integer FROM public.commerce_payment_intents WHERE order_id=(SELECT order_id FROM _swu WHERE name='intent')),1,'created-intent replay retains one intent');
UPDATE public.subscription_cycles SET retry_attempt=2,provider_attempt_sequence=3 WHERE id=(SELECT cycle_id FROM _swu WHERE name='intent');
SELECT pg_temp.swu_refresh('intent');
SELECT is((SELECT frozen#>>'{snapshots,retryAttempt}' FROM _swu WHERE name='intent'),'2','freeze preserves persisted retry identity');
SELECT is((SELECT frozen#>>'{snapshots,providerAttemptSequence}' FROM _swu WHERE name='intent'),'3','freeze preserves persisted provider sequence');

CREATE TEMP TABLE _swu_intent_key AS SELECT request_fingerprint FROM public.commerce_idempotency_keys
 WHERE scope='commerce.payment_intent.create' AND idempotency_key=(SELECT input->>'idempotencyKey'||':payment-intent' FROM _swu WHERE name='intent');
UPDATE public.commerce_idempotency_keys SET request_fingerprint='unsupported-created-intent'
 WHERE scope='commerce.payment_intent.create' AND idempotency_key=(SELECT input->>'idempotencyKey'||':payment-intent' FROM _swu WHERE name='intent');
SELECT throws_like($$SELECT public.subscription_stock_wait_frozen(subscription_id,literal::timestamptz) FROM _swu WHERE name='intent'$$,
 '%stock_wait_recovery_intent_invalid%','created status alone cannot authorize a different intent identity');
SELECT throws_like($$SELECT pg_temp.swu_admit('intent')$$,'%stock_wait_recovery_intent_invalid%','locked admission checks original intent fingerprint');
UPDATE public.commerce_idempotency_keys SET request_fingerprint=(SELECT request_fingerprint FROM _swu_intent_key)
 WHERE scope='commerce.payment_intent.create' AND idempotency_key=(SELECT input->>'idempotencyKey'||':payment-intent' FROM _swu WHERE name='intent');

-- Discovery/freeze/admit races never become current-price or provider bypass.
UPDATE public.commerce_payment_intents SET provider_payment_id='swu-provider-owned' WHERE order_id=(SELECT order_id FROM _swu WHERE name='intent');
SELECT is(pg_temp.swu_candidates('intent'),0,'provider reference excludes the graph');
SELECT is(public.subscription_stock_wait_frozen((SELECT subscription_id FROM _swu WHERE name='intent'),(SELECT literal::timestamptz FROM _swu WHERE name='intent')),NULL::jsonb,'provider reference after selection removes freeze');
SELECT throws_like($$SELECT pg_temp.swu_admit('intent')$$,'%stock_wait_recovery_%','provider reference after freeze fails locked admission');
UPDATE public.commerce_payment_intents SET provider_payment_id=NULL,status='processing' WHERE order_id=(SELECT order_id FROM _swu WHERE name='intent');
SELECT is(pg_temp.swu_candidates('intent'),0,'non-created intent is provider-owned');
SELECT throws_like($$SELECT pg_temp.swu_admit('intent')$$,'%stock_wait_recovery_%','non-created intent race cannot bypass');
UPDATE public.commerce_payment_intents SET status='created' WHERE order_id=(SELECT order_id FROM _swu WHERE name='intent');
UPDATE public.commerce_payments SET status='succeeded' WHERE id=(SELECT payment_id FROM _swu WHERE name='intent');
SELECT is(pg_temp.swu_candidates('intent'),0,'captured payment is excluded even if intent and order lag');
SELECT throws_like($$SELECT pg_temp.swu_admit('intent')$$,'%stock_wait_recovery_%','capture race fails admission while other statuses lag');
UPDATE public.commerce_payments SET status='pending',provider_payment_id='swu-provider-payment' WHERE id=(SELECT payment_id FROM _swu WHERE name='intent');
SELECT is(pg_temp.swu_candidates('intent'),0,'payment provider reference excludes uncaptured graph');
UPDATE public.commerce_payments SET provider_payment_id=NULL WHERE id=(SELECT payment_id FROM _swu WHERE name='intent');
SELECT pg_temp.swu_refresh('intent');
SELECT public.commerce_payment_control_prepare_provider_attempt('swu-provider-prepare-intent',
 (SELECT id FROM public.commerce_payment_intents WHERE order_id=(SELECT order_id FROM _swu WHERE name='intent')),
 'example','swu-provider-key','swu-request-fingerprint','off_session_payment',
 (SELECT payment_method_ref FROM public.subscriptions WHERE id=(SELECT subscription_id FROM _swu WHERE name='intent')),'{}');
SELECT is(pg_temp.swu_candidates('intent'),0,'durable prepared provider attempt excludes recovery');
SELECT throws_like($$SELECT pg_temp.swu_admit('intent')$$,'%stock_wait_recovery_%','attempt prepared after freeze wins locked admission');
SELECT is((SELECT count(*)::integer FROM public.commerce_payment_attempts WHERE payment_id=(SELECT payment_id FROM _swu WHERE name='intent')),1,'recovery creates no duplicate provider attempt');

-- Current membership/anchor and quarantine remain authoritative.
SELECT pg_temp.swu_seed('eligibility',12);
SELECT pg_temp.swu_refresh('eligibility');
UPDATE public.subscriptions SET status='paused' WHERE id=(SELECT subscription_id FROM _swu WHERE name='eligibility');
SELECT is(pg_temp.swu_candidates('eligibility'),0,'paused graph is excluded');
SELECT throws_like($$SELECT pg_temp.swu_admit('eligibility')$$,'%stock_wait_obligation_not_eligible%','pause after freeze rejects admission');
UPDATE public.subscriptions SET status='cancelled' WHERE id=(SELECT subscription_id FROM _swu WHERE name='eligibility');
SELECT is(pg_temp.swu_candidates('eligibility'),0,'cancelled graph is excluded');
UPDATE public.subscriptions SET status='active',next_cycle_at='2026-08-15T10:00:00Z' WHERE id=(SELECT subscription_id FROM _swu WHERE name='eligibility');
SELECT is(pg_temp.swu_candidates('eligibility'),0,'superseded graph is excluded');
SELECT throws_like($$SELECT pg_temp.swu_admit('eligibility')$$,'%stock_wait_obligation_not_eligible%','anchor race rejects admission');
UPDATE public.subscriptions SET next_cycle_at='2026-08-01T10:00:00Z' WHERE id=(SELECT subscription_id FROM _swu WHERE name='eligibility');
UPDATE public.subscription_cycles SET renewal_quarantined_until=now()+interval '1 hour' WHERE id=(SELECT cycle_id FROM _swu WHERE name='eligibility');
SELECT is(pg_temp.swu_candidates('eligibility'),0,'active quarantine excludes graph');
SELECT throws_like($$SELECT pg_temp.swu_admit('eligibility')$$,'%stock_wait_renewal_quarantined%','quarantine race rejects admission');
UPDATE public.subscription_cycles SET renewal_quarantined_until=now()-interval '1 second' WHERE id=(SELECT cycle_id FROM _swu WHERE name='eligibility');
SELECT is(pg_temp.swu_candidates('eligibility'),1,'elapsed quarantine recovers automatically');
SELECT throws_like($$SELECT public.subscription_stock_wait_admit(input,jsonb_set(due,'{clientId}','"ce000000-0000-4000-8000-000000000099"'),now()) FROM _swu WHERE name='eligibility'$$,
 '%stock_wait_obligation_not_eligible%','foreign client binding cannot authorize original graph');
UPDATE public.commerce_orders SET status='paid' WHERE id=(SELECT order_id FROM _swu WHERE name='eligibility');
SELECT is(pg_temp.swu_candidates('eligibility'),0,'paid order excludes recovery even if payment row lags');
UPDATE public.commerce_orders SET status='pending_payment' WHERE id=(SELECT order_id FROM _swu WHERE name='eligibility');
UPDATE public.subscription_cycles SET status='retry_scheduled',next_retry_at=now()-interval '1 hour' WHERE id=(SELECT cycle_id FROM _swu WHERE name='eligibility');
SELECT is(pg_temp.swu_candidates('eligibility'),0,'retry lane is not taken over by stock recovery');
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_normal_due(50,now()) candidate WHERE candidate->>'subscriptionId'=(SELECT subscription_id::text FROM _swu WHERE name='eligibility')),1,'ordinary retry semantics remain discoverable');
UPDATE public.subscriptions SET status='paused' WHERE id=(SELECT subscription_id FROM _swu WHERE name='eligibility');

-- Poison provenance fails one row, keeps rotation and reaches existing quarantine.
SELECT pg_temp.swu_seed('malformed',13);
UPDATE public.subscription_cycles SET engine_idempotency_key='subscription:'||subscription_id::text||':cycle:not-a-timestamp' WHERE id=(SELECT cycle_id FROM _swu WHERE name='malformed');
SELECT lives_ok($$SELECT public.subscription_stock_wait_candidates(50,now())$$,'malformed engine suffix does not poison the full reader');
SELECT is(pg_temp.swu_candidates('malformed'),1,'malformed graph retains a diagnostic row anchor');
SELECT throws_like($$SELECT public.subscription_stock_wait_frozen(subscription_id,literal::timestamptz) FROM _swu WHERE name='malformed'$$,
 '%stock_wait_recovery_identity_invalid%','malformed literal fails frozen provenance');
SELECT public.subscription_renewal_note_row_outcome(subscription_id,literal::timestamptz,'stock_wait_recovery_identity_invalid') FROM _swu WHERE name='malformed';
SELECT is((SELECT renewal_row_error_count FROM public.subscription_cycles WHERE id=(SELECT cycle_id FROM _swu WHERE name='malformed')),1,'refused provenance records existing row-failure evidence');
UPDATE public.subscription_cycles SET engine_idempotency_key=(SELECT input->>'idempotencyKey' FROM _swu WHERE name='malformed'),
 pricing_snapshot=jsonb_set(pricing_snapshot,'{scheduledAt}','"2026-08-01T10:00:00Z"') WHERE id=(SELECT cycle_id FROM _swu WHERE name='malformed');
SELECT throws_like($$SELECT public.subscription_stock_wait_frozen(subscription_id,literal::timestamptz) FROM _swu WHERE name='malformed'$$,
 '%stock_wait_recovery_identity_invalid%','same-instant literal repricing evidence cannot change emitted bytes');
UPDATE public.subscription_cycles SET pricing_snapshot=(SELECT input->'pricingSnapshot' FROM _swu WHERE name='malformed') WHERE id=(SELECT cycle_id FROM _swu WHERE name='malformed');
UPDATE public.commerce_orders SET metadata=metadata-'orderSnapshot' WHERE id=(SELECT order_id FROM _swu WHERE name='malformed');
SELECT throws_like($$SELECT public.subscription_stock_wait_frozen(subscription_id,literal::timestamptz) FROM _swu WHERE name='malformed'$$,
 '%stock_wait_recovery_snapshot_invalid%','missing original order snapshot cannot be rebuilt from current lines');
UPDATE public.commerce_orders SET metadata=metadata||jsonb_build_object('orderSnapshot',(SELECT input->'orderSnapshot' FROM _swu WHERE name='malformed')) WHERE id=(SELECT order_id FROM _swu WHERE name='malformed');
SELECT public.subscription_renewal_note_row_outcome(subscription_id,literal::timestamptz,'stock_wait_recovery_identity_invalid') FROM _swu WHERE name='malformed';
SELECT public.subscription_renewal_note_row_outcome(subscription_id,literal::timestamptz,'stock_wait_recovery_identity_invalid') FROM _swu WHERE name='malformed';
SELECT ok((SELECT renewal_quarantined_until>now() FROM public.subscription_cycles WHERE id=(SELECT cycle_id FROM _swu WHERE name='malformed')),'repeated refused provenance uses existing bounded quarantine');
SELECT is(pg_temp.swu_candidates('malformed'),0,'quarantined poison row does not occupy recovery slot');
UPDATE public.subscription_cycles SET renewal_quarantined_until=now()-interval '1 second' WHERE id=(SELECT cycle_id FROM _swu WHERE name='malformed');
SELECT is(pg_temp.swu_candidates('malformed'),1,'poison quarantine expiry restores autonomous discovery');
UPDATE public.subscriptions SET status='paused' WHERE id=(SELECT subscription_id FROM _swu WHERE name='malformed');

-- A pre-graph wait stays bound to today's template until its graph is created.
SELECT pg_temp.swu_seed('pregraph',15,'2026-08-01T10:00:00.000Z',false);
UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=0 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku IN ('UNPAID-WAIT-A','UNPAID-WAIT-B');
SELECT public.subscription_stock_wait_admit(input,jsonb_build_object('clientId','ce000000-0000-4000-8000-000000000003',
 'subscriptionId',subscription_id,'nextCycleAt',literal,'currency','XTS','providerKind','example'),now()) FROM _swu WHERE name='pregraph';
SELECT pg_temp.swu_refresh('pregraph');
SELECT is((SELECT due#>'{stockWaitRecovery,cycleId}' FROM _swu WHERE name='pregraph'),'null'::jsonb,'pre-graph case carries explicit nullable graph binding');
UPDATE public.subscription_lines SET qty=2 WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='pregraph');
SELECT is(pg_temp.swu_admit('pregraph')->>'error','stock_wait_check_failed','pre-graph wait retains current-template guard');
SELECT is((SELECT count(*)::integer FROM public.subscription_cycles WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='pregraph')),0,'template mismatch cannot mint a graph');
UPDATE public.subscription_lines SET qty=1 WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='pregraph');
UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=100 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku IN ('UNPAID-WAIT-A','UNPAID-WAIT-B');
SELECT pg_temp.swu_refresh('pregraph');
CREATE TEMP TABLE _swu_pregraph_admitted AS SELECT pg_temp.swu_admit('pregraph') result;
SELECT is((SELECT (result->>'waiting')::boolean FROM _swu_pregraph_admitted),false,'matching pre-graph case creates original agreed graph on restock');
SELECT ok((SELECT result#>>'{binding,cycleId}' IS NOT NULL FROM _swu_pregraph_admitted),'admission returns new original graph binding');
UPDATE _swu SET due=jsonb_set(due,'{stockWaitRecovery}',(SELECT result->'binding' FROM _swu_pregraph_admitted)) WHERE name='pregraph';
SELECT is(pg_temp.swu_admit('pregraph')#>>'{subscriptionCycleOrder,cycleId}',(SELECT result#>>'{subscriptionCycleOrder,cycleId}' FROM _swu_pregraph_admitted),'reservation recheck accepts updated same-graph binding');
SELECT pg_temp.swu_seed('normal',16,'2026-08-01T10:00:00.000Z',false);
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_normal_due(50,now()) candidate
 WHERE candidate->>'subscriptionId'=(SELECT subscription_id::text FROM _swu WHERE name='normal')),1,'new ordinary renewal still uses normal lane');
SELECT is(pg_temp.swu_candidates('normal'),0,'recovery does not manufacture a missing raw obligation');
UPDATE public.subscriptions SET status='paused' WHERE id=(SELECT subscription_id FROM _swu WHERE name='normal');

-- Current method evidence is refreshed instead of copied from old due snapshots.
UPDATE public.commerce_payment_method_refs SET active=false,status='revoked' WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='crash');
SELECT pg_temp.swu_refresh('crash');
SELECT is((SELECT (due->>'methodActive')::boolean FROM _swu WHERE name='crash'),false,'current revoked mandate evidence reaches unchanged charge preflight');
SELECT is((SELECT due->>'methodStatus' FROM _swu WHERE name='crash'),'revoked','reader does not revive the original method status');

-- Fair mixed recovery selection rotates even when no selected row is processed.
SELECT pg_temp.swu_seed('fair-uncased',14);
UPDATE public.subscription_stock_wait_cases SET last_selected_at=NULL WHERE subscription_id=(SELECT subscription_id FROM _swu WHERE name='crash');
UPDATE public.subscription_cycles SET updated_at=now()-interval '1 day' WHERE id=(SELECT cycle_id FROM _swu WHERE name='fair-uncased');
CREATE TEMP TABLE _swu_pick1 AS SELECT candidate FROM public.subscription_stock_wait_candidates(1,now()) candidate;
CREATE TEMP TABLE _swu_pick2 AS SELECT candidate FROM public.subscription_stock_wait_candidates(1,now()+interval '1 second') candidate;
SELECT is((SELECT candidate->>'subscriptionId' FROM _swu_pick1),(SELECT subscription_id::text FROM _swu WHERE name='crash'),'existing case receives a bounded recovery slot');
SELECT is((SELECT candidate->>'subscriptionId' FROM _swu_pick2),(SELECT subscription_id::text FROM _swu WHERE name='fair-uncased'),'unprocessed no-case graph receives next bounded slot');
SELECT ok((SELECT candidate ? 'stockWaitRecovery' FROM _swu_pick1),'existing case carries explicit provenance');
SELECT ok((SELECT candidate ? 'stockWaitRecovery' FROM _swu_pick2),'uncased graph carries explicit provenance');
-- More than one recovery batch rotates a mixed backlog without execution.
DO $$ BEGIN FOR n IN 1..51 LOOP PERFORM pg_temp.swu_seed('fair-many-'||n,100+n); END LOOP; END; $$;
CREATE TEMP TABLE _swu_batch1 AS SELECT candidate FROM public.subscription_stock_wait_candidates(50,now()+interval '2 seconds') candidate;
CREATE TEMP TABLE _swu_batch2 AS SELECT candidate FROM public.subscription_stock_wait_candidates(50,now()+interval '3 seconds') candidate;
SELECT is((SELECT count(*)::integer FROM _swu_batch1),50,'private recovery retains its bounded batch cap');
SELECT is((SELECT count(DISTINCT candidate->>'subscriptionId')::integer FROM
 (SELECT candidate FROM _swu_batch1 UNION ALL SELECT candidate FROM _swu_batch2) selected
 WHERE candidate->>'subscriptionId' IN(SELECT subscription_id::text FROM _swu WHERE name LIKE 'fair-many-%')),51,'all uncased backlog rows receive a slot across mixed batches');
SELECT is((SELECT count(*)::integer FROM public.commerce_payment_attempts),1,'only explicitly prepared synthetic attempt exists');
SELECT ok(NOT has_function_privilege('authenticated','public.subscription_stock_wait_frozen(uuid,timestamptz)','EXECUTE'),'replacement frozen reader remains private');
SELECT ok(NOT has_function_privilege('anon','public.subscription_stock_wait_candidates(integer,timestamptz)','EXECUTE'),'replacement candidate reader remains private');

SELECT * FROM finish();
ROLLBACK;
