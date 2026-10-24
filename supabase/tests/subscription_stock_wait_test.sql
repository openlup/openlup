-- pgTAP: exact-basket stock wait, transactional notices and same-obligation recovery.
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
CREATE TEMP TABLE _sw_order_snapshot AS SELECT '{
    "contractVersion":"commerce.v0","source":"subscription.own_engine.v0",
    "status":"pending_payment","paymentStatus":"pending","currency":"XTS",
    "taxIncluded":true,
    "lines":[{
      "sku":"STOCK-WAIT-A","productSlug":"stock-wait-test","quantity":1,
      "unitPriceGross":{"amountMinor":1000,"currency":"XTS"},
      "lineSubtotalGross":{"amountMinor":1000,"currency":"XTS"},
      "tax":{"vatRateBps":800,
        "netAmount":{"amountMinor":926,"currency":"XTS"},
        "vatAmount":{"amountMinor":74,"currency":"XTS"},
        "grossAmount":{"amountMinor":1000,"currency":"XTS"}}
    },{
      "sku":"STOCK-WAIT-B","productSlug":"stock-wait-test","quantity":1,
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
INSERT INTO public.catalog_products (
  id, slug, status, name, ingredients, allergens, marketing_content
) VALUES (
  'cb000000-0000-4000-8000-000000000001', 'stock-wait-test', 'active',
  'Canonical renewal', ARRAY['test']::text[], ARRAY[]::text[], '{}'::jsonb
);
INSERT INTO public.catalog_skus (
  id, product_id, sku, title, pet_type, status, net_weight_g, format_code,
  unit_form_code, kcal_per_unit, feeding_grams_per_unit, sellable_standalone,
  sellable_in_subscription, min_order_qty
) VALUES
(
  'cb000000-0000-4000-8000-000000000002',
  'cb000000-0000-4000-8000-000000000001',
  'STOCK-WAIT-A', 'Canonical renewal SKU A', 'dog', 'active', 400, 'can',
  'can', 400, 400, true, true, 1
),
(
  'cb000000-0000-4000-8000-000000000005',
  'cb000000-0000-4000-8000-000000000001',
  'STOCK-WAIT-B', 'Canonical renewal SKU B', 'dog', 'active', 800, 'can',
  'can', 400, 400, true, true, 1
);
SELECT public.fulfillment_provider_upsert_stock_current(
  'stock-wait-test-stock-1',
  (SELECT provider FROM managed_stock_fixture),
  'STOCK-WAIT-A',
  10, 0, 0,
  now(),
  now() + interval '6 hours',
  'stock-wait-test-stock-run-1',
  '{"source":"canonical_order_money_test"}'::jsonb
);
SELECT public.fulfillment_provider_upsert_stock_current(
  'stock-wait-test-stock-2',
  (SELECT provider FROM managed_stock_fixture),
  'STOCK-WAIT-B',
  10, 0, 0,
  now(),
  now() + interval '6 hours',
  'stock-wait-test-stock-run-1',
  '{"source":"canonical_order_money_test"}'::jsonb
);
INSERT INTO public.clients (id, email)
VALUES ('cb000000-0000-4000-8000-000000000003', 'stock-wait-test@example.invalid');
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, size_constraint, currency, region_code, status,
  next_cycle_at, started_at, edit_window_hours, template_version,
  payment_method_ref, payment_method_kind, timezone
) VALUES (
  'cb000000-0000-4000-8000-000000000004',
  'cb000000-0000-4000-8000-000000000003',
  14, '{"kind":"unit_count","value":2}'::jsonb, 'XTS', 'ZZ', 'active',
  '2026-08-01T10:00:00Z', '2026-07-01T10:00:00Z', 72, 1,
  'pm_canonical', 'card', 'UTC'
);
INSERT INTO public.subscription_lines (
  subscription_id, variant_id, qty, sort_order, is_addon, template_version, line_metadata
) VALUES
(
  'cb000000-0000-4000-8000-000000000004',
  'cb000000-0000-4000-8000-000000000002',
  1, 1, false, 1, '{}'::jsonb
),
(
  'cb000000-0000-4000-8000-000000000004',
  'cb000000-0000-4000-8000-000000000005',
  1, 2, false, 1, '{}'::jsonb
);


CREATE TEMP TABLE _sw_input AS SELECT jsonb_build_object(
 'subscriptionId','cb000000-0000-4000-8000-000000000004',
 'scheduledAt','2026-08-01T10:00:00Z','cycleNumber',1,'idempotencyKey','stock-wait-test-cycle',
 'templateSnapshot',public.subscription_current_template_snapshot('cb000000-0000-4000-8000-000000000004'),
 'pricingSnapshot','{"source":"canonical_order_money_test"}'::jsonb,'orderSnapshot',
(SELECT snapshot FROM _sw_order_snapshot)) AS input,
 '{"subscriptionId":"cb000000-0000-4000-8000-000000000004","clientId":"cb000000-0000-4000-8000-000000000003","nextCycleAt":"2026-08-01T10:00:00Z","providerKind":"example"}'::jsonb AS due;

SELECT public.subscription_delivery_alignment_admit_renewal('cb000000-0000-4000-8000-000000000004','2026-08-01T10:00:00Z',now());
CREATE TEMP TABLE _sw_started AS SELECT public.subscription_stock_wait_admit(input,due,now()) result FROM _sw_input;
SELECT is((SELECT (result->>'waiting')::boolean FROM _sw_started),true,'confirmed shortage establishes a wait');
SELECT is((SELECT jsonb_array_length(deficits) FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),2,'all required product deficits are recorded');
SELECT is((SELECT count(*)::integer FROM public.subscription_cycles WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),0,'initial shortage has no partial cycle');
SELECT is((SELECT count(*)::integer FROM public.commerce_orders WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),0,'initial shortage has no partial order');
SELECT is((SELECT status FROM public.subscriptions WHERE id='cb000000-0000-4000-8000-000000000004'),'active','subscription stays active');
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE event_type='subscription_stock_wait.started' AND aggregate_id=(SELECT (result->>'caseId')::uuid FROM _sw_started)),1,'one transactional waiting notice');
SELECT is((public.subscription_stock_wait_read((SELECT (result->>'caseId')::uuid FROM _sw_started))->>'waitingNoticeRelevant')::boolean,true,'current matching active wait notice is relevant');
UPDATE public.subscriptions SET status='paused' WHERE id='cb000000-0000-4000-8000-000000000004';
SELECT is((public.subscription_stock_wait_read((SELECT (result->>'caseId')::uuid FROM _sw_started))->>'waitingNoticeRelevant')::boolean,false,'customer pause makes unsent waiting mail obsolete before cron');
UPDATE public.subscriptions SET status='cancelled' WHERE id='cb000000-0000-4000-8000-000000000004';
SELECT is((public.subscription_stock_wait_read((SELECT (result->>'caseId')::uuid FROM _sw_started))->>'waitingNoticeRelevant')::boolean,false,'cancellation makes unsent waiting mail obsolete before cron');
UPDATE public.subscriptions SET status='active',next_cycle_at='2026-08-15T10:00:00Z' WHERE id='cb000000-0000-4000-8000-000000000004';
SELECT is((public.subscription_stock_wait_read((SELECT (result->>'caseId')::uuid FROM _sw_started))->>'waitingNoticeRelevant')::boolean,false,'superseded anchor makes unsent waiting mail obsolete before cron');
UPDATE public.subscriptions SET next_cycle_at='2026-08-01T10:00:00Z' WHERE id='cb000000-0000-4000-8000-000000000004';
SELECT is((public.subscription_stock_wait_summary('waiting')->>'totalCount')::integer,1,'global admin summary counts all matching cases');
SELECT is((public.subscription_stock_wait_summary('waiting')#>>'{productTotals,0,affectedCases}')::integer,1,'admin summary includes per-product affected-case count');

UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=4 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku='STOCK-WAIT-A';
SELECT public.subscription_stock_wait_admit(input,due,now()) FROM _sw_input;
SELECT is((SELECT jsonb_array_length(deficits) FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),1,'partial restock updates complete remaining deficit');
SELECT is((SELECT count(*)::integer FROM public.commerce_orders WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),0,'partial restock still creates no order');
UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=4 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku='STOCK-WAIT-B';
SELECT public.subscription_delivery_alignment_admit_renewal('cb000000-0000-4000-8000-000000000004','2026-08-01T10:00:00Z',now());
CREATE TEMP TABLE _sw_recovered AS SELECT public.subscription_stock_wait_admit(input,due,now()) result FROM _sw_input;
SELECT is((SELECT state FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),'stock_secured','complete basket secured before payment');
SELECT is((SELECT count(*)::integer FROM public.subscription_cycles WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),1,'exactly one original cycle');
SELECT is((SELECT count(*)::integer FROM public.commerce_payment_attempts a JOIN public.commerce_payment_intents i ON i.id=a.payment_intent_id WHERE i.subscription_id='cb000000-0000-4000-8000-000000000004'),0,'reservation does not create a provider attempt');
SELECT is(public.subscription_stock_wait_mark_resumed((SELECT replace(result#>>'{subscriptionCycleOrder,orderId}','order_','')::uuid FROM _sw_recovered)),NULL::jsonb,'unpaid reservation cannot announce resumed realization');
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_candidates(50,now()) candidate WHERE candidate->>'subscriptionId'='cb000000-0000-4000-8000-000000000004'),1,'unpaid pending cycle is rediscovered privately');
SELECT public.subscription_stock_wait_admit(input,due,now()) FROM _sw_input;
SELECT is((SELECT count(*)::integer FROM public.commerce_orders WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),1,'replay does not duplicate the order');
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE event_type='subscription_stock_wait.started' AND aggregate_id=(SELECT (result->>'caseId')::uuid FROM _sw_started)),1,'replay retains one waiting obligation');
SELECT ok(NOT has_function_privilege('authenticated','public.subscription_stock_wait_admit(jsonb,jsonb,timestamptz)','EXECUTE'),'browser cannot authorize wait/reservation');
SELECT ok(NOT has_table_privilege('authenticated','public.subscription_stock_wait_cases','SELECT'),'browser cannot enumerate private cases');
SELECT ok(NOT has_table_privilege('openlup_mcp_reader','public.subscription_stock_wait_cases','SELECT'),'generic MCP reader cannot read raw frozen baskets or notice envelopes');
SELECT ok(NOT has_function_privilege('openlup_mcp_reader','public.subscription_stock_wait_read(uuid)','EXECUTE'),'generic MCP reader cannot bypass the private case projection boundary');
SELECT is(public.communication_email_delivery_template_for_event(event_type),template_slug,event_type||': exact template mapping')
FROM (VALUES('subscription_stock_wait.started','subscription-stock-wait-started'),
 ('subscription_stock_wait.resumed','subscription-stock-wait-resumed')) mappings(event_type,template_slug);
SELECT ok(event_type=ANY(private.outbox_resend_event_types()),event_type||': event reaches delivery obligations')
FROM (VALUES('subscription_stock_wait.started'),('subscription_stock_wait.resumed')) mappings(event_type);

SELECT is((SELECT result->>'error' FROM _sw_recovered),NULL::text,'full restock has no hidden technical refusal');
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='cb000000-0000-4000-8000-000000000004'),'2026-08-01T10:00:00Z'::timestamptz,'long wait never parks or rewrites original schedule');
SELECT is((SELECT result#>'{snapshots,orderSnapshot}' FROM (SELECT public.subscription_stock_wait_frozen('cb000000-0000-4000-8000-000000000004','2026-08-01T10:00:00Z') result) f),(SELECT input->'orderSnapshot' FROM _sw_input),'frozen discounted cycle basket survives recovery');
SELECT public.inventory_release_reservation('sw-expire-'||r.id::text,r.id,'test_expired','{}') FROM public.inventory_reservations r
 JOIN public.commerce_orders o ON o.id=r.order_id WHERE o.subscription_id='cb000000-0000-4000-8000-000000000004' AND r.status='reserved';
UPDATE public.fulfillment_provider_stock_current SET provider_for_sale_quantity=0 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku='STOCK-WAIT-B';
SELECT public.subscription_stock_wait_admit(input,due,now()) FROM _sw_input;
SELECT is((SELECT state FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),'waiting','existing unpaid graph losing holds enters same wait');
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations r JOIN public.commerce_orders o ON o.id=r.order_id WHERE o.subscription_id='cb000000-0000-4000-8000-000000000004' AND r.status='reserved'),0,'short basket does not retain new partial reacquisitions');
UPDATE public.fulfillment_provider_stock_current SET stale_after=now()-interval '1 second' WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku='STOCK-WAIT-A';
CREATE TEMP TABLE _sw_stale AS SELECT public.subscription_stock_wait_admit(input,due,now()) result FROM _sw_input;
SELECT is((SELECT result->>'error' FROM _sw_stale),'stock_wait_check_failed','stale stock is actionable technical failure');
SELECT is((SELECT block_reason FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),'stock_wait_check_failed','technical check cannot leave a healthy case');
UPDATE public.fulfillment_provider_stock_current SET stale_after=now()+interval '6 hours',provider_for_sale_quantity=4 WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku IN ('STOCK-WAIT-A','STOCK-WAIT-B');
SELECT public.subscription_stock_wait_admit(input,due,now()) FROM _sw_input;
SELECT is((SELECT count(*)::integer FROM public.commerce_orders WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),1,'expired-hold recovery reuses existing graph');
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations r JOIN public.commerce_order_items item ON item.id=r.order_item_id
 WHERE item.order_id=(SELECT order_id FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004') AND r.status='reserved'),2,'reacquired holds retain real order-item ownership');
UPDATE public.subscription_cycles SET renewal_quarantined_until=now()+interval '1 hour' WHERE subscription_id='cb000000-0000-4000-8000-000000000004';
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_candidates(50,now()) row WHERE row->>'subscriptionId'='cb000000-0000-4000-8000-000000000004'),0,'private recovery respects active quarantine');
SELECT is((SELECT public.subscription_stock_wait_admit(input,due,now())->>'error' FROM _sw_input),'stock_wait_check_failed','admission race cannot bypass active quarantine');
UPDATE public.subscription_cycles SET renewal_quarantined_until=now()-interval '1 second' WHERE subscription_id='cb000000-0000-4000-8000-000000000004';
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_candidates(50,now()) row WHERE row->>'subscriptionId'='cb000000-0000-4000-8000-000000000004'),1,'elapsed quarantine permits ordinary recovery');

CREATE TEMP TABLE _sw_stock_a AS SELECT * FROM public.fulfillment_provider_stock_current WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku='STOCK-WAIT-A';
DELETE FROM public.fulfillment_provider_stock_current WHERE provider_kind=(SELECT provider FROM managed_stock_fixture) AND sku='STOCK-WAIT-A';
CREATE TEMP TABLE _sw_missing AS SELECT public.subscription_stock_wait_admit(input,due,now()) result FROM _sw_input;
SELECT is((SELECT result->>'error' FROM _sw_missing),'stock_wait_check_failed','missing provider authority is not a normal shortage');
INSERT INTO public.fulfillment_provider_stock_current SELECT * FROM _sw_stock_a;
SELECT public.inventory_release_reservation('sw-fault-release-'||r.id::text,r.id,'test_expired','{}') FROM public.inventory_reservations r
 JOIN public.commerce_orders o ON o.id=r.order_id WHERE o.subscription_id='cb000000-0000-4000-8000-000000000004' AND r.status='reserved';
-- Fail the second sorted SKU, after the first has actually been reacquired.
CREATE FUNCTION pg_temp.stock_wait_arbitrary_fault() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.sku_id='cb000000-0000-4000-8000-000000000005'::uuid THEN
  RAISE EXCEPTION 'synthetic unrelated check violation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;$$;
CREATE TRIGGER stock_wait_arbitrary_fault BEFORE INSERT ON public.inventory_reservations FOR EACH ROW EXECUTE FUNCTION pg_temp.stock_wait_arbitrary_fault();
CREATE TEMP TABLE _sw_fault AS SELECT public.subscription_stock_wait_admit(input,due,now()) result FROM _sw_input;
SELECT is((SELECT result->>'error' FROM _sw_fault),'stock_wait_check_failed','arbitrary 23514 cannot authorize healthy supply waiting');
SELECT is((SELECT count(*)::integer FROM public.inventory_reservations r JOIN public.commerce_orders o ON o.id=r.order_id WHERE o.subscription_id='cb000000-0000-4000-8000-000000000004' AND r.status='reserved'),0,'technical reacquisition rollback retains no new partial holds');
DROP TRIGGER stock_wait_arbitrary_fault ON public.inventory_reservations;
SELECT public.subscription_stock_wait_admit(input,due,now()) FROM _sw_input;
INSERT INTO public.commerce_payment_intents(target_kind,order_id,subscription_id,subscription_cycle_id,payment_id,status,amount_cents,currency)
SELECT 'subscription_cycle',o.id,o.subscription_id,o.subscription_cycle_id,p.id,'created',o.total_cents,o.currency
 FROM public.commerce_orders o JOIN public.commerce_payments p ON p.order_id=o.id WHERE o.subscription_id='cb000000-0000-4000-8000-000000000004';
INSERT INTO public.commerce_payment_attempts(payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency,provider_attempt_id)
SELECT i.id,i.payment_id,'example','sw-durable-attempt','failed',i.amount_cents,i.currency,'sw-provider-ack' FROM public.commerce_payment_intents i WHERE i.subscription_id='cb000000-0000-4000-8000-000000000004';
UPDATE public.subscription_cycles SET status='retry_scheduled',next_retry_at=now(),retry_attempt=1 WHERE subscription_id='cb000000-0000-4000-8000-000000000004';
SELECT is(public.subscription_stock_wait_frozen('cb000000-0000-4000-8000-000000000004','2026-08-01T10:00:00Z'),NULL::jsonb,'provider egress never freezes retry entitlement at attempt zero');
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_candidates(50,now()) row WHERE row->>'subscriptionId'='cb000000-0000-4000-8000-000000000004'),0,'supply recovery excludes provider-owned obligation');
SELECT is((SELECT count(*)::integer FROM public.subscription_stock_wait_normal_due(50,now()) row WHERE row->>'subscriptionId'='cb000000-0000-4000-8000-000000000004'),1,'ordinary dunning remains discoverable after recovery decline');
-- Settle through the real payment-control applicator after stock recovery.
SELECT public.commerce_payment_control_record_attempt('sw-paid-attempt',
 (SELECT id FROM public.commerce_payment_intents WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),
 'example','sw-provider-paid',NULL,'processing',NULL,'{}','{}');
SELECT public.commerce_payment_control_apply_result('sw-paid-result',
 (SELECT id FROM public.commerce_payment_intents WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),
 NULL,'succeeded',now(),NULL);
SELECT is((SELECT next_cycle_at FROM public.subscriptions WHERE id='cb000000-0000-4000-8000-000000000004'),
 '2026-08-01T10:00:00Z'::timestamptz+make_interval(days=>greatest(0,floor(extract(epoch FROM
 (now()-'2026-08-01T10:00:00Z'::timestamptz))/86400)::integer)+14),
 'late stock-recovery settlement shifts the original cycle later by lateness plus cadence');
SELECT is((SELECT status FROM public.subscriptions WHERE id='cb000000-0000-4000-8000-000000000004'),
 'active','late stock-recovery settlement never pauses service');
SELECT public.subscription_stock_wait_candidates(50,now());
SELECT is((SELECT state FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'),'stock_secured','payment anchor advance cannot close pending realized notice');
SELECT throws_ok($$SELECT public.subscription_stock_wait_mark_resumed((SELECT order_id FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'))$$,'P0001','stock_wait_realization_admission_missing','paid without recorded fulfillment retries completion');
INSERT INTO public.addresses(id,client_id,kind,line1,city,postal_code) VALUES('cb000000-0000-4000-8000-000000000099','cb000000-0000-4000-8000-000000000003','shipping','Synthetic 1','Fixture City','00-001');
UPDATE public.commerce_orders SET shipping_address_id='cb000000-0000-4000-8000-000000000099' WHERE subscription_id='cb000000-0000-4000-8000-000000000004';
SELECT lives_ok($$SELECT public.commerce_fulfillment_create_order('sw-local-fulfillment',(SELECT order_id FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'))$$,'real fulfillment authority admits recovered item reservations');
INSERT INTO public.commerce_order_holds(order_id,reason,idempotency_key) SELECT order_id,'manual_support','sw-test-held-replay' FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004';
SELECT throws_ok($$SELECT public.subscription_stock_wait_mark_resumed((SELECT order_id FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'))$$,'P0001','stock_wait_realization_active_hold','fulfillment replay cannot bypass a new independent hold');
UPDATE public.commerce_order_holds SET status='released',released_at=now() WHERE idempotency_key='sw-test-held-replay';
SELECT is(public.subscription_stock_wait_mark_resumed((SELECT order_id FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'))->>'state','resumed','paid secured recorded fulfillment authorizes resumed');
SELECT is(public.subscription_stock_wait_mark_resumed((SELECT order_id FROM public.subscription_stock_wait_cases WHERE subscription_id='cb000000-0000-4000-8000-000000000004'))->>'state','resumed','completion replay verifies same fulfillment');
SELECT is((SELECT count(*)::integer FROM public.outbox_events WHERE event_type='subscription_stock_wait.resumed' AND aggregate_id=(SELECT (result->>'caseId')::uuid FROM _sw_started)),1,'completion replay retains one resumed notice');
SELECT is(public.communication_email_delivery_purpose_for_event('subscription_stock_wait.started'),'transactional','stock waiting never becomes marketing');
UPDATE public.subscription_delivery_alignment_control SET mode='auto_align' WHERE singleton;
UPDATE public.subscriptions SET next_cycle_at='2026-08-15T10:00:00Z' WHERE id='cb000000-0000-4000-8000-000000000004';
SELECT is((public.subscription_delivery_alignment_admit_renewal('cb000000-0000-4000-8000-000000000004','2026-08-15T10:00:00Z',now())->>'allowed')::boolean,false,'long delayed paid parcel blocks catch-up renewal before delivery');

-- More waits than one batch are deliberately older than an ordinary renewal.
UPDATE public.subscriptions SET status='paused' WHERE id='cb000000-0000-4000-8000-000000000004';
INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,status,next_cycle_at)
SELECT ('cb100000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'cb000000-0000-4000-8000-000000000003',14,'XTS','active','2026-07-01T10:00:00Z' FROM generate_series(1,60) n;
INSERT INTO public.subscription_stock_wait_cases(subscription_id,client_id,scheduled_at,state,cycle_number,due_snapshot,template_snapshot,pricing_snapshot,order_snapshot,fingerprint,deficits,last_checked_at)
SELECT id,client_id,next_cycle_at,'waiting',1,jsonb_build_object('subscriptionId',id,'clientId',client_id,'nextCycleAt',next_cycle_at),'{}','{}','{}','synthetic','[]',now()-interval '1 hour' FROM public.subscriptions WHERE id::text LIKE 'cb100000%';
INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,status,next_cycle_at) VALUES('cb200000-0000-4000-8000-000000000001','cb000000-0000-4000-8000-000000000003',14,'XTS','active','2026-09-01T10:00:00Z');
SELECT is((SELECT row->>'subscriptionId' FROM public.subscription_stock_wait_normal_due(1,now()) row LIMIT 1),'cb200000-0000-4000-8000-000000000001','over-batch older waits cannot starve ordinary renewal');
CREATE TEMP TABLE _sw_first_candidate AS SELECT row->>'subscriptionId' id FROM public.subscription_stock_wait_candidates(1,now()) row;
UPDATE public.subscription_stock_wait_cases SET last_checked_at=now() WHERE subscription_id=(SELECT id::uuid FROM _sw_first_candidate);
SELECT isnt((SELECT row->>'subscriptionId' FROM public.subscription_stock_wait_candidates(1,now()) row),(SELECT id FROM _sw_first_candidate),'checked waits rotate behind unchecked backlog');
CREATE TEMP TABLE _sw_selected_batch AS SELECT row->>'subscriptionId' id FROM public.subscription_stock_wait_candidates(50,now()) row;
SELECT ok(EXISTS(SELECT 1 FROM public.subscription_stock_wait_candidates(50,now()) row WHERE NOT EXISTS(SELECT 1 FROM _sw_selected_batch selected WHERE selected.id=row->>'subscriptionId')),'unprocessed operator-blocked wait selections cannot starve the remaining backlog');
SELECT is((SELECT min(last_checked_at) FROM public.subscription_stock_wait_cases WHERE subscription_id::text LIKE 'cb100000%'),now()-interval '1 hour','discovery rotation never fabricates fresh inventory evidence');
SELECT is(public.subscription_stock_wait_bind_notice((SELECT (result->>'caseId')::uuid FROM _sw_started),(SELECT id FROM public.outbox_events WHERE aggregate_id=(SELECT (result->>'caseId')::uuid FROM _sw_started) AND event_type='subscription_stock_wait.started'),'{"from":"fixture@example.invalid","to":"original@example.invalid","subject":"wait","html":"first"}'),'{"from":"fixture@example.invalid","to":"original@example.invalid","subject":"wait","html":"first"}'::jsonb,'notice freezes first outbound envelope');
SELECT is(public.subscription_stock_wait_bind_notice((SELECT (result->>'caseId')::uuid FROM _sw_started),(SELECT id FROM public.outbox_events WHERE aggregate_id=(SELECT (result->>'caseId')::uuid FROM _sw_started) AND event_type='subscription_stock_wait.started'),'{"from":"fixture@example.invalid","to":"changed@example.invalid","subject":"wait","html":"changed"}')->>'html','first','ambiguous notice retry cannot change original outbound bytes');
SELECT * FROM finish();
ROLLBACK;
