-- pgTAP: additive promotion-code control plane, admin idempotency and claims.
BEGIN;
SELECT plan(102);

INSERT INTO public.admin_users (id,email,role,is_machine_actor) VALUES
  ('ac100000-0000-4000-8000-000000000001','promotion-admin@example.invalid','admin',false),
  ('ac100000-0000-4000-8000-000000000002','promotion-machine@example.invalid','admin',true);

SELECT lives_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','summer80','Summer 80',NULL::text,
  ARRAY['one_time','subscription_initial'],now()-interval '1 hour',now()+interval '1 day',
  0,10,1,'draft',
  '[{"lane":"product","kind":"target_percentage","valueBps":8000},
    {"lane":"shipping","kind":"free_shipping"}]'::jsonb,
  'ac100000-0000-4000-8000-000000000010','fingerprint-a','admin_console'
)$$, 'admin creates a two-lane code atomically');

SELECT is((SELECT code FROM public.promotion_codes WHERE code_normalized='SUMMER80'),
  'SUMMER80','manual code is normalized to uppercase');
SELECT is((SELECT revision FROM public.promotion_codes WHERE code_normalized='SUMMER80'),
  1,'new codes start at optimistic revision one');
SELECT is((SELECT count(*)::int FROM public.promotion_code_bindings pcb
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='SUMMER80'),2,'one code binds independent product and shipping benefits');
SELECT is((SELECT count(*)::int FROM public.promotions p
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_id=p.id
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='SUMMER80' AND p.status='draft'
    AND p.promotion_engine_version='promotion-engine.v2'),2,
  'new benefits remain dark to the live v1 evaluator');

SELECT is((SELECT (public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','IGNORED-CANDIDATE','Summer 80',NULL::text,
  ARRAY['one_time','subscription_initial'],now()-interval '1 hour',now()+interval '1 day',
  0,10,1,'draft',
  '[{"lane":"product","kind":"target_percentage","valueBps":8000},
    {"lane":"shipping","kind":"free_shipping"}]'::jsonb,
  'ac100000-0000-4000-8000-000000000010','fingerprint-a','admin_console'
))->>'idempotent'),'true','idempotent create returns the original result');
SELECT is((SELECT count(*)::int FROM public.promotion_codes WHERE code_normalized='SUMMER80'),1,
  'idempotent replay creates no duplicate code');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','SuMmEr80','Duplicate',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"fixed_amount","valueMinor":100}]'::jsonb,
  'ac100000-0000-4000-8000-000000000011','fingerprint-b','admin_console'
)$$,'23505',NULL,'case-insensitive duplicate code is rejected');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','ZERO-V2','Zero v2',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"fixed_amount","valueMinor":0}]'::jsonb,
  'ac100000-0000-4000-8000-000000000015','fingerprint-zero-v2','admin_console'
)$$,'22023','promotion_code_invalid_benefit_value',
  'v2 database RPC rejects a zero-value benefit');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','FRACTION-V2','Fraction v2',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"target_percentage","valueBps":5000.5}]'::jsonb,
  'ac100000-0000-4000-8000-000000000016','fingerprint-fraction-v2','admin_console'
)$$,'22023','promotion_code_invalid_benefit_value',
  'v2 database RPC rejects fractional basis points');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','MISSING-TARGET','Missing target',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"target_percentage"}]'::jsonb,
  'ac100000-0000-4000-8000-000000000017','fingerprint-missing-target','admin_console'
)$$,'22023','promotion_code_invalid_benefit_value',
  'v2 database RPC rejects a missing target percentage');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','MISSING-FIXED','Missing fixed',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"fixed_amount"}]'::jsonb,
  'ac100000-0000-4000-8000-000000000018','fingerprint-missing-fixed','admin_console'
)$$,'22023','promotion_code_invalid_benefit_value',
  'v2 database RPC rejects a missing fixed amount');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','FRACTION-FIXED','Fraction fixed',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"fixed_amount","valueMinor":100.5}]'::jsonb,
  'ac100000-0000-4000-8000-000000000019','fingerprint-fraction-fixed','admin_console'
)$$,'22023','promotion_code_invalid_benefit_value',
  'v2 database RPC rejects a fractional fixed amount');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','OVERSIZED-FIXED','Oversized fixed',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"fixed_amount","valueMinor":2147483648}]'::jsonb,
  'ac100000-0000-4000-8000-000000000020','fingerprint-oversized-fixed','admin_console'
)$$,'22023','promotion_code_invalid_benefit_value',
  'v2 database RPC rejects a fixed amount above the safe minor-unit cap');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.promotion_codes
  WHERE code_normalized IN (
    'ZERO-V2','FRACTION-V2','MISSING-TARGET','MISSING-FIXED',
    'FRACTION-FIXED','OVERSIZED-FIXED'
  )), 'invalid v2 definitions leave no promotion-code identity behind');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','A','Too short',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"fixed_amount","valueMinor":100}]'::jsonb,
  'ac100000-0000-4000-8000-000000000021','fingerprint-short-code','admin_console'
)$$,'22023','promotion_code_invalid_definition',
  'database RPC repeats the strict minimum code length contract');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','VIP 10','Whitespace',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"fixed_amount","valueMinor":100}]'::jsonb,
  'ac100000-0000-4000-8000-000000000022','fingerprint-space-code','admin_console'
)$$,'22023','promotion_code_invalid_definition',
  'database RPC rejects whitespace even when called without the BFF');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','10%OFF','Percent',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"fixed_amount","valueMinor":100}]'::jsonb,
  'ac100000-0000-4000-8000-000000000023','fingerprint-percent-code','admin_console'
)$$,'22023','promotion_code_invalid_definition',
  'database RPC rejects legacy-only punctuation for new v2 codes');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.admin_audit_events
  WHERE entity_type='promotion_code' AND new_value::text ILIKE '%SUMMER80%'),
  'raw code is absent from admin audit payloads');

SELECT is((SELECT count(*)::int FROM public.admin_promotion_codes_list(
  'ac100000-0000-4000-8000-000000000001','summer','all','all',NULL,NULL,25)),1,
  'list search is case-insensitive and server-side');
SELECT is((SELECT count(*)::int FROM public.admin_promotion_codes_list(
  'ac100000-0000-4000-8000-000000000001','%','all','all',NULL,NULL,25)),0,
  'list treats wildcard characters as a literal prefix');
SELECT throws_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000002','MACHINE-NO','Machine denied',NULL::text,
  ARRAY['one_time'],now(),NULL::timestamptz,0,NULL::integer,NULL::integer,'draft',
  '[{"lane":"product","kind":"fixed_amount","valueMinor":100}]'::jsonb,
  'ac100000-0000-4000-8000-000000000012','fingerprint-machine','admin_console'
)$$,'42501','promotion_code_human_required','database rejects machine mutations');

UPDATE public.promotion_codes
SET status='active',valid_from=now()-interval '2 hours',valid_to=now()-interval '1 hour'
WHERE code_normalized='SUMMER80';
SELECT ok((public.admin_promotion_code_definition(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='SUMMER80'))
  ->>'valid_to') IS NOT NULL,
  'definition returns valid_to so lifecycle activation checks can detect expiry');

INSERT INTO public.promotion_codes
  (id,code,name,scopes,valid_from,valid_to,status,redemption_limit_global)
VALUES ('ac200000-0000-4000-8000-000000000001','CLAIM-2','Claim lifecycle',
  ARRAY['one_time'],now()-interval '1 hour',now()+interval '1 day','active',2);
INSERT INTO public.commerce_orders
  (id,order_number,status,currency,subtotal_cents,discount_cents,shipping_cents,
   shipping_discount_cents,tax_cents,total_cents)
VALUES
  ('ac300000-0000-4000-8000-000000000001','PROMO-CLAIM-1','draft','PLN',1000,0,0,0,0,1000),
  ('ac300000-0000-4000-8000-000000000002','PROMO-CLAIM-2','draft','PLN',1000,0,0,0,0,1000);

SELECT is((public.commerce_promotion_code_claim(
  'ac200000-0000-4000-8000-000000000001','ac300000-0000-4000-8000-000000000001',
  now()+interval '1 hour'))->>'status','reserved','claim reserves capacity');
SELECT is((public.commerce_promotion_code_claim(
  'ac200000-0000-4000-8000-000000000001','ac300000-0000-4000-8000-000000000001',
  now()+interval '1 hour'))->>'idempotent','true','claim replay is idempotent');
SELECT is(public.commerce_promotion_code_redeem(
  'ac300000-0000-4000-8000-000000000001',now()),1,'redeem transitions one reservation');
SELECT is(public.commerce_promotion_code_redeem(
  'ac300000-0000-4000-8000-000000000001',now()),0,'redeem replay is a no-op');
SELECT is(public.commerce_promotion_code_release(
  'ac300000-0000-4000-8000-000000000001','refund'),0,
  'release never restores a redeemed claim');
SELECT is((public.commerce_promotion_code_claim(
  'ac200000-0000-4000-8000-000000000001','ac300000-0000-4000-8000-000000000002',
  now()+interval '1 hour'))->>'status','reserved','second order reserves remaining capacity');
SELECT is(public.commerce_promotion_code_release(
  'ac300000-0000-4000-8000-000000000002','checkout_cancelled'),1,
  'terminal cancellation releases a reservation');
SELECT is((SELECT status FROM public.promotion_code_claims
  WHERE order_id='ac300000-0000-4000-8000-000000000002'),'released',
  'released state remains auditable');

-- Simulate pre-migration v1 truth, including hostile/malformed eligibility and
-- an already-consumed redemption, then prove the idempotent backfill bridge.
INSERT INTO public.clients (id,email) VALUES
  ('ac600000-0000-4000-8000-000000000001','legacy-promo@example.invalid');
INSERT INTO public.commerce_orders
  (id,client_id,order_number,status,currency,subtotal_cents,discount_cents,shipping_cents,
   shipping_discount_cents,tax_cents,total_cents)
VALUES ('ac610000-0000-4000-8000-000000000001','ac600000-0000-4000-8000-000000000001',
  'PROMO-LEGACY-1','paid','PLN',1000,100,0,0,0,900),
  ('ac610000-0000-4000-8000-000000000002','ac600000-0000-4000-8000-000000000001',
  'PROMO-LEGACY-2','draft','PLN',1000,100,0,0,0,900),
  ('ac610000-0000-4000-8000-000000000003','ac600000-0000-4000-8000-000000000001',
  'PROMO-LEGACY-3','draft','PLN',1000,100,0,0,0,900);
INSERT INTO public.promotions (
  id,code,name,trigger_type,discount_type,discount_value,applies_to_kind,eligibility,
  status,promotion_engine_version,benefit_lane,benefit_kind,benefit_value_bps
) VALUES (
  'ac620000-0000-4000-8000-000000000001','LEGACY10','Legacy ten','coupon_code',
  'percentage',10,'order_total',
  '{"first_onetime_purchase":"true","first_subscription_purchase":"1","min_cart_minor":"999999999999999999999"}'::jsonb,
  'active','promotion-engine.v1','product','percentage',1000
);

SELECT lives_ok($$INSERT INTO public.promotions (
  id,code,name,trigger_type,discount_type,discount_value,applies_to_kind,status
) VALUES (
  'ac620000-0000-4000-8000-000000000010','A','Legacy short',
  'coupon_code','percentage',5,'order_total','active'
)$$,'legacy INSERT keeps accepting a one-character code');
SELECT lives_ok($$INSERT INTO public.promotions (
  id,code,name,trigger_type,discount_type,discount_value,applies_to_kind,status
) VALUES (
  'ac620000-0000-4000-8000-000000000011','VIP 10','Legacy whitespace',
  'coupon_code','percentage',5,'order_total','active'
)$$,'legacy INSERT keeps accepting whitespace in a code');
SELECT lives_ok($$INSERT INTO public.promotions (
  id,code,name,trigger_type,discount_type,discount_value,applies_to_kind,status
) VALUES (
  'ac620000-0000-4000-8000-000000000012','10%OFF','Legacy punctuation',
  'coupon_code','percentage',5,'order_total','active'
)$$,'legacy INSERT keeps accepting punctuation in a code');
SELECT is((SELECT count(*)::integer FROM public.promotion_codes
  WHERE code IN ('A','VIP 10','10%OFF')),3,
  'non-colliding legacy formats are projected without tightening their contract');

SELECT is((SELECT count(*)::integer
  FROM public.promotion_codes pc
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_code_id=pc.id
  WHERE pc.code_normalized='LEGACY10'
    AND pcb.promotion_id='ac620000-0000-4000-8000-000000000001'),
  1,'post-migration legacy INSERT immediately creates code identity and binding');
SELECT lives_ok($$INSERT INTO public.promotions (
  id,code,name,trigger_type,discount_type,discount_value,applies_to_kind,status
) VALUES (
  'ac620000-0000-4000-8000-000000000002','legacy10','Case collision',
  'coupon_code','percentage',5,'order_total','active'
)$$,'legacy INSERT survives a case-normalized code collision on the v1 path');
SELECT is((public.admin_promotion_codes_legacy_compatibility(
  'ac100000-0000-4000-8000-000000000001')->>'ready')::boolean,false,
  'compatibility handshake blocks Code Center takeover while a legacy row is unprojected');
SELECT is((public.admin_promotion_codes_legacy_compatibility(
  'ac100000-0000-4000-8000-000000000001')->>'unprojectedCount')::integer,1,
  'compatibility handshake reports the unprojected legacy row without exposing its code');
SELECT is((public.admin_promotion_codes_legacy_compatibility(
  'ac100000-0000-4000-8000-000000000001')->>'collisionGroupCount')::integer,1,
  'compatibility handshake reports one normalized collision group');
INSERT INTO public.promotion_redemptions
  (promotion_id,client_id,order_id,redeemed_at,amount_off_minor)
VALUES ('ac620000-0000-4000-8000-000000000001',NULL,
  'ac610000-0000-4000-8000-000000000001',now()-interval '1 day',100);
SELECT is((SELECT pcc.status FROM public.promotion_code_claims pcc
  JOIN public.promotion_codes pc ON pc.id=pcc.promotion_code_id
  WHERE pc.code_normalized='LEGACY10'
    AND pcc.order_id='ac610000-0000-4000-8000-000000000001'),
  'redeemed','live v1 redemption is immediately projected into a redeemed claim');

SELECT lives_ok($$SELECT public.promotion_codes_backfill_legacy();
  SELECT public.promotion_codes_backfill_legacy()$$,
  'legacy backfill is safe and exactly-once on repeated execution');
SELECT is((SELECT p.benefit_kind FROM public.promotions p WHERE p.code='LEGACY10'),
  'percentage','legacy percentage is never reinterpreted as target percentage');
SELECT is((SELECT scopes FROM public.promotion_codes WHERE code_normalized='LEGACY10'),
  ARRAY['one_time','subscription_initial']::text[],'both explicit first-order scopes survive backfill');
SELECT is((SELECT minimum_reference_minor FROM public.promotion_codes WHERE code_normalized='LEGACY10'),
  0,'unsafe oversized minimum eligibility fails closed to zero without cast failure');
SELECT is((SELECT count(*)::int FROM public.promotion_code_claims pcc
  JOIN public.promotion_codes pc ON pc.id=pcc.promotion_code_id
  WHERE pc.code_normalized='LEGACY10' AND pcc.status='redeemed'),1,
  'legacy redemption consumes capacity as a redeemed claim');
SELECT is((SELECT count(*)::int FROM public.promotion_code_claims pcc
  JOIN public.promotion_codes pc ON pc.id=pcc.promotion_code_id
  WHERE pc.code_normalized='LEGACY10'),1,'repeated backfill does not duplicate claims');
SELECT throws_ok($$INSERT INTO public.promotion_code_bindings(promotion_code_id,promotion_id,lane)
  VALUES ((SELECT id FROM public.promotion_codes WHERE code_normalized='SUMMER80'),
    'ac620000-0000-4000-8000-000000000001','product')$$,
  '23505',NULL,'database enforces one benefit binding per code lane');
SELECT is((SELECT pcc.client_id FROM public.promotion_code_claims pcc
  JOIN public.promotion_codes pc ON pc.id=pcc.promotion_code_id
  WHERE pc.code_normalized='LEGACY10'),'ac600000-0000-4000-8000-000000000001'::uuid,
  'backfill derives canonical claim client from the locked order truth');

UPDATE public.promotion_code_claims
SET status='released',redeemed_at=NULL,released_at=now(),release_reason='simulated_drift'
WHERE order_id='ac610000-0000-4000-8000-000000000001';
SELECT lives_ok($$SELECT public.promotion_codes_backfill_legacy()$$,
  'backfill repair accepts canonical paid truth over a stale released claim');
SELECT ok(EXISTS (SELECT 1 FROM public.promotion_code_claims
  WHERE order_id='ac610000-0000-4000-8000-000000000001'
    AND status='redeemed' AND redeemed_at IS NOT NULL
    AND released_at IS NULL AND release_reason IS NULL),
  'backfill repair restores redeemed state and clears stale release metadata');

SELECT is((public.commerce_promotion_code_claim(
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LEGACY10'),
  'ac610000-0000-4000-8000-000000000002',now()+interval '1 hour'))->>'status',
  'reserved','v2 claim bridge can reserve before a late v1 payment callback');
INSERT INTO public.promotion_redemptions
  (promotion_id,client_id,order_id,redeemed_at,amount_off_minor)
VALUES ('ac620000-0000-4000-8000-000000000001',NULL,
  'ac610000-0000-4000-8000-000000000002',now(),100);
SELECT ok(EXISTS (SELECT 1 FROM public.promotion_code_claims pcc
  WHERE pcc.order_id='ac610000-0000-4000-8000-000000000002'
    AND pcc.status='redeemed'
    AND pcc.client_id='ac600000-0000-4000-8000-000000000001'
    AND pcc.released_at IS NULL AND pcc.release_reason IS NULL),
  'canonical paid redemption wins over a reservation and derives client from order');

SELECT is((public.commerce_promotion_code_claim(
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LEGACY10'),
  'ac610000-0000-4000-8000-000000000003',now()+interval '1 hour'))->>'status',
  'reserved','a second late-payment fixture reserves successfully');
SELECT is(public.commerce_promotion_code_release(
  'ac610000-0000-4000-8000-000000000003','checkout_expired'),1,
  'the late-payment fixture enters released state');
INSERT INTO public.promotion_redemptions
  (promotion_id,client_id,order_id,redeemed_at,amount_off_minor)
VALUES ('ac620000-0000-4000-8000-000000000001',NULL,
  'ac610000-0000-4000-8000-000000000003',now(),100);
SELECT ok(EXISTS (SELECT 1 FROM public.promotion_code_claims pcc
  WHERE pcc.order_id='ac610000-0000-4000-8000-000000000003'
    AND pcc.status='redeemed' AND pcc.released_at IS NULL
    AND pcc.release_reason IS NULL),
  'canonical paid redemption wins over released claim and clears release metadata');
UPDATE public.commerce_orders SET status='refunded'
WHERE id='ac610000-0000-4000-8000-000000000003';
SELECT is((SELECT status FROM public.promotion_code_claims
  WHERE order_id='ac610000-0000-4000-8000-000000000003'),
  'redeemed','refund does not restore promotion-code capacity');

UPDATE public.promotions SET status='paused',
  eligibility='{"first_onetime_purchase":true,"min_cart_minor":"500"}'::jsonb,
  discount_value=20
WHERE code='LEGACY10';
SELECT is((SELECT status FROM public.promotion_codes WHERE code_normalized='LEGACY10'),
  'paused','legacy editor status mirrors into code projection');
SELECT is((SELECT scopes FROM public.promotion_codes WHERE code_normalized='LEGACY10'),
  ARRAY['one_time']::text[],'legacy editor eligibility mirrors scope projection');
SELECT is((SELECT minimum_reference_minor FROM public.promotion_codes WHERE code_normalized='LEGACY10'),
  500,'legacy editor eligibility mirrors minimum reference projection');
SELECT is((SELECT minimum_reference_minor FROM public.admin_promotion_codes_list(
  'ac100000-0000-4000-8000-000000000001','legacy10','all','all',NULL,NULL,25)),
  500,'list RPC returns the persisted non-zero minimum reference amount');
SELECT is((SELECT revision FROM public.promotion_codes WHERE code_normalized='LEGACY10'),
  2,'one legacy edit advances projection revision once');
SELECT is((SELECT (benefits->0->>'valueBps')::integer FROM public.admin_promotion_codes_list(
  'ac100000-0000-4000-8000-000000000001','legacy10','all','all',NULL,NULL,25)),
  2000,'list projects the benefit value changed by the legacy editor');
SELECT is((public.admin_promotion_code_definition(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LEGACY10'))
  ->'benefits'->0->>'valueBps')::integer,2000,
  'definition projects the benefit value changed by the legacy editor');

SELECT lives_ok($$SELECT public.admin_promotion_code_update(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LEGACY10'),2,
  '{"status":"active","redemptionLimitGlobal":5}'::jsonb,
  'ac100000-0000-4000-8000-000000000010','fingerprint-update','admin_console')$$,
  'new update RPC can mutate a bound live v1 coupon');
SELECT is((SELECT (public.admin_promotion_code_update(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LEGACY10'),2,
  '{"status":"active","redemptionLimitGlobal":5}'::jsonb,
  'ac100000-0000-4000-8000-000000000010','fingerprint-update','admin_console'))->>'idempotent'),
  'true','update replay returns its original result despite an advanced revision');
SELECT is((SELECT revision FROM public.promotion_codes WHERE code_normalized='LEGACY10'),
  3,'reverse mirror does not double-increment optimistic revision');
SELECT is((SELECT status FROM public.promotions WHERE code='LEGACY10'),
  'active','new update RPC mirrors lifecycle to live v1 promotion');
SELECT is((SELECT count(*)::int FROM public.admin_audit_events
  WHERE entity_type='promotion_code' AND idempotency_key IN (
    'create:ac100000-0000-4000-8000-000000000010',
    'update:ac100000-0000-4000-8000-000000000010')),2,
  'create and update audit idempotency namespaces cannot collide');
SELECT throws_ok($$SELECT public.admin_promotion_code_update(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LEGACY10'),2,
  '{"status":"paused"}'::jsonb,'ac100000-0000-4000-8000-000000000013',
  'fingerprint-stale','admin_console')$$,'P0001','promotion_code_revision_conflict',
  'stale optimistic revision is rejected');
SELECT throws_ok($$SELECT public.admin_promotion_code_update(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LEGACY10'),3,
  jsonb_build_object('validFrom',(now()+interval '2 days')::text,
    'validTo',(now()+interval '1 day')::text),
  'ac100000-0000-4000-8000-000000000014','fingerprint-window','admin_console')$$,
  '22023','promotion_code_invalid_validity_window',
  'database rejects an invalid resulting validity window before UPDATE');
UPDATE public.promotions SET status='archived' WHERE code='LEGACY10';
SELECT ok((SELECT count(*) FROM public.admin_promotion_codes_list(
  'ac100000-0000-4000-8000-000000000001',NULL,'expired_or_archived','all',NULL,NULL,25))>=1,
  'combined expired-or-archived filter includes archived projections');

SELECT lives_ok($$UPDATE public.promotions SET discount_type='percentage',discount_value=0
  WHERE code='LEGACY10'$$,
  'legacy editor keeps accepting a zero-value percentage');
SELECT is((SELECT (benefits->0->>'valueBps')::integer
  FROM public.admin_promotion_codes_list(
    'ac100000-0000-4000-8000-000000000001','legacy10','all','all',NULL,NULL,25)),
  0,'Code Center lists a legacy zero-value benefit without parse failure');
SELECT lives_ok($$UPDATE public.promotions SET discount_value=150
  WHERE code='LEGACY10'$$,
  'legacy editor keeps accepting percentages above one hundred');
SELECT is((SELECT (benefits->0->>'valueBps')::integer
  FROM public.admin_promotion_codes_list(
    'ac100000-0000-4000-8000-000000000001','legacy10','all','all',NULL,NULL,25)),
  15000,'Code Center preserves a representable legacy percentage above one hundred');
SELECT lives_ok($$UPDATE public.promotions
  SET discount_type='percentage',discount_value=10.005
  WHERE code='LEGACY10'$$,
  'legacy writer accepts a percentage not exactly representable in basis points');
SELECT is((SELECT benefits->0->>'validationState'
  FROM public.admin_promotion_codes_list(
    'ac100000-0000-4000-8000-000000000001','legacy10','all','all',NULL,NULL,25)),
  'unsupported_legacy_value','fractional legacy basis points are never rounded');
SELECT lives_ok($$UPDATE public.promotions
  SET discount_type='fixed_amount',discount_value=10.5
  WHERE code='LEGACY10'$$,
  'legacy writer accepts a fixed value not representable in minor units');
SELECT is((SELECT benefits->0->>'validationState'
  FROM public.admin_promotion_codes_list(
    'ac100000-0000-4000-8000-000000000001','legacy10','all','all',NULL,NULL,25)),
  'unsupported_legacy_value','fractional legacy minor units are never rounded');
SELECT lives_ok($$UPDATE public.promotions
  SET discount_type='fixed_amount',
      discount_value=1000000000000000000000000000000000000000
  WHERE code='LEGACY10'$$,
  'pathological value through the old writer is never blocked by additive metadata');
SELECT is((SELECT benefits->0->>'validationState'
  FROM public.admin_promotion_codes_list(
    'ac100000-0000-4000-8000-000000000001','legacy10','all','all',NULL,NULL,25)),
  'unsupported_legacy_value','list marks a pathological legacy value without failing');
SELECT is((public.admin_promotion_code_definition(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LEGACY10'))
  ->'benefits'->0->>'validationState'),
  'unsupported_legacy_value','definition marks a pathological legacy value without failing');

-- ===========================================================================
-- v2 status lockstep (migration 20260724141000): bound v2 promotion rows follow
-- their owning code's lifecycle, system-managed mirror rows stay untouched, and
-- the backfill is idempotent.
-- ===========================================================================

-- Create an ACTIVE code with a single v2 product benefit. Under the lockstep
-- create, the bound v2 promotion row must be created 'active', not stranded draft.
SELECT lives_ok($$SELECT public.admin_promotion_code_create(
  'ac100000-0000-4000-8000-000000000001','LOCKSTEP20','Lockstep 20',NULL::text,
  ARRAY['one_time','subscription_initial'],now()-interval '1 hour',now()+interval '1 day',
  0,NULL::integer,NULL::integer,'active',
  '[{"lane":"product","kind":"target_percentage","valueBps":2000}]'::jsonb,
  'ac100000-0000-4000-8000-000000000030','fingerprint-lockstep-create','admin_console'
)$$,'admin creates an active v2 code');
SELECT is((SELECT p.status FROM public.promotions p
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_id=p.id
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='LOCKSTEP20' AND p.promotion_engine_version='promotion-engine.v2'),
  'active','create mirrors the active code status onto its bound v2 promotion');

-- A system-managed v2 MIRROR row (v2_mirror_of set, no binding). Its legacy parent
-- is a benign automatic v1 offer with a name other than the seeded canonical so
-- the offer-policy trigger does not spawn its own twin.
INSERT INTO public.promotions (
  id,code,name,trigger_type,discount_type,discount_value,applies_to_kind,status
) VALUES (
  'ac700000-0000-4000-8000-000000000001',NULL,'Mirror Parent Offer','automatic',
  'percentage',50,'order_total','active'
);
INSERT INTO public.promotions (
  id,code,name,trigger_type,discount_type,discount_value,applies_to_kind,status,
  promotion_engine_version,benefit_lane,benefit_kind,benefit_value_bps,v2_mirror_of
) VALUES (
  'ac700000-0000-4000-8000-000000000002',NULL,'Mirror Parent Offer','automatic',
  'percentage',50,'order_total','paused','promotion-engine.v2','product',
  'target_percentage',5000,'ac700000-0000-4000-8000-000000000001'
);
SELECT is((SELECT count(*)::int FROM public.promotion_code_bindings
  WHERE promotion_id='ac700000-0000-4000-8000-000000000002'),0,
  'a v2 mirror row carries no promotion_code_binding');

-- Update code active->paused: the bound v2 row follows; the mirror stays untouched.
SELECT lives_ok($$SELECT public.admin_promotion_code_update(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LOCKSTEP20'),1,
  '{"status":"paused"}'::jsonb,
  'ac100000-0000-4000-8000-000000000031','fingerprint-lockstep-pause','admin_console')$$,
  'update pauses the active v2 code');
SELECT is((SELECT p.status FROM public.promotions p
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_id=p.id
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='LOCKSTEP20' AND p.promotion_engine_version='promotion-engine.v2'),
  'paused','pausing the code cascades to its bound v2 promotion');
SELECT is((SELECT status FROM public.promotions
  WHERE id='ac700000-0000-4000-8000-000000000002'),'paused',
  'the RPC update never touches an unbound v2 mirror row');

-- paused->active: the bound v2 row follows again.
SELECT lives_ok($$SELECT public.admin_promotion_code_update(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LOCKSTEP20'),2,
  '{"status":"active"}'::jsonb,
  'ac100000-0000-4000-8000-000000000032','fingerprint-lockstep-activate','admin_console')$$,
  'update reactivates the paused v2 code');
SELECT is((SELECT p.status FROM public.promotions p
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_id=p.id
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='LOCKSTEP20' AND p.promotion_engine_version='promotion-engine.v2'),
  'active','reactivating the code cascades to its bound v2 promotion');

-- Validity/limit changes cascade to the bound v2 row.
SELECT lives_ok($$SELECT public.admin_promotion_code_update(
  'ac100000-0000-4000-8000-000000000001',
  (SELECT id FROM public.promotion_codes WHERE code_normalized='LOCKSTEP20'),3,
  jsonb_build_object('validTo',(now()+interval '30 days')::text,
    'redemptionLimitGlobal',7,'redemptionLimitPerCustomer',2),
  'ac100000-0000-4000-8000-000000000033','fingerprint-lockstep-window','admin_console')$$,
  'update changes validity and limits');
SELECT is((SELECT p.redemption_limit_global FROM public.promotions p
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_id=p.id
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='LOCKSTEP20' AND p.promotion_engine_version='promotion-engine.v2'),
  7,'global redemption limit cascades to the bound v2 promotion');
SELECT is((SELECT p.redemption_limit_per_customer FROM public.promotions p
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_id=p.id
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='LOCKSTEP20' AND p.promotion_engine_version='promotion-engine.v2'),
  2,'per-customer redemption limit cascades to the bound v2 promotion');
SELECT is((SELECT p.valid_to FROM public.promotions p
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_id=p.id
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='LOCKSTEP20' AND p.promotion_engine_version='promotion-engine.v2'),
  (SELECT valid_to FROM public.promotion_codes WHERE code_normalized='LOCKSTEP20'),
  'validity window cascades to the bound v2 promotion');

-- The backfill repairs pre-lockstep rows. SUMMER80 was created draft and later had
-- its code row flipped active by a direct table UPDATE (above), so its bound v2
-- rows are still draft while the code is active — exactly the STAGING20 defect.
SELECT lives_ok($$UPDATE public.promotions p SET
    status = pc.status, valid_from = pc.valid_from, valid_to = pc.valid_to,
    redemption_limit_global = pc.redemption_limit_global,
    redemption_limit_per_customer = pc.redemption_limit_per_customer,
    updated_at = now()
  FROM public.promotion_code_bindings pcb
  JOIN public.promotion_codes pc ON pc.id = pcb.promotion_code_id
  WHERE pcb.promotion_id = p.id
    AND p.promotion_engine_version = 'promotion-engine.v2'
    AND (p.status, p.valid_from, p.valid_to, p.redemption_limit_global, p.redemption_limit_per_customer)
      IS DISTINCT FROM
      (pc.status, pc.valid_from, pc.valid_to, pc.redemption_limit_global, pc.redemption_limit_per_customer)$$,
  'backfill runs over existing bindings-joined v2 rows');
SELECT is((SELECT count(*)::int FROM public.promotions p
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_id=p.id
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='SUMMER80'
    AND p.promotion_engine_version='promotion-engine.v2' AND p.status='active'),2,
  'backfill brings a pre-lockstep active code''s bound v2 rows into active lockstep');
SELECT is((SELECT status FROM public.promotions
  WHERE id='ac700000-0000-4000-8000-000000000002'),'paused',
  'the backfill never touches an unbound v2 mirror row');

-- Idempotency + repair on a controlled single-row drift.
UPDATE public.promotions p SET status='draft'
FROM public.promotion_code_bindings pcb
JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
WHERE pcb.promotion_id=p.id AND pc.code_normalized='LOCKSTEP20'
  AND p.promotion_engine_version='promotion-engine.v2';
WITH backfill AS (
  UPDATE public.promotions p SET
    status = pc.status, valid_from = pc.valid_from, valid_to = pc.valid_to,
    redemption_limit_global = pc.redemption_limit_global,
    redemption_limit_per_customer = pc.redemption_limit_per_customer,
    updated_at = now()
  FROM public.promotion_code_bindings pcb
  JOIN public.promotion_codes pc ON pc.id = pcb.promotion_code_id
  WHERE pcb.promotion_id = p.id
    AND p.promotion_engine_version = 'promotion-engine.v2'
    AND (p.status, p.valid_from, p.valid_to, p.redemption_limit_global, p.redemption_limit_per_customer)
      IS DISTINCT FROM
      (pc.status, pc.valid_from, pc.valid_to, pc.redemption_limit_global, pc.redemption_limit_per_customer)
  RETURNING 1
)
SELECT is(count(*)::int,1,'backfill repairs exactly the one drifted v2 row')
FROM backfill;
SELECT is((SELECT p.status FROM public.promotions p
  JOIN public.promotion_code_bindings pcb ON pcb.promotion_id=p.id
  JOIN public.promotion_codes pc ON pc.id=pcb.promotion_code_id
  WHERE pc.code_normalized='LOCKSTEP20' AND p.promotion_engine_version='promotion-engine.v2'),
  'active','backfill restores the drifted bound v2 row to the code status');
WITH backfill AS (
  UPDATE public.promotions p SET
    status = pc.status, valid_from = pc.valid_from, valid_to = pc.valid_to,
    redemption_limit_global = pc.redemption_limit_global,
    redemption_limit_per_customer = pc.redemption_limit_per_customer,
    updated_at = now()
  FROM public.promotion_code_bindings pcb
  JOIN public.promotion_codes pc ON pc.id = pcb.promotion_code_id
  WHERE pcb.promotion_id = p.id
    AND p.promotion_engine_version = 'promotion-engine.v2'
    AND (p.status, p.valid_from, p.valid_to, p.redemption_limit_global, p.redemption_limit_per_customer)
      IS DISTINCT FROM
      (pc.status, pc.valid_from, pc.valid_to, pc.redemption_limit_global, pc.redemption_limit_per_customer)
  RETURNING 1
)
SELECT is(count(*)::int,0,'backfill is idempotent: a second pass updates zero rows')
FROM backfill;
SELECT is((SELECT status FROM public.promotions
  WHERE id='ac700000-0000-4000-8000-000000000002'),'paused',
  'the v2 mirror row remains paused after repeated backfill');

SELECT * FROM finish();
ROLLBACK;
