-- pgTAP: commerce_payment_method_ref_upsert replayed semantics (20260612231000).
--   * a new method ref reports replayed:false
--   * the same method ref under a new idempotency key reports replayed:true
--     (ON CONFLICT update -> nothing material created)
--   * the same idempotency key replayed reports replayed:true (cached payload)
--   * the replay returns the same method ref id (cached identity, no new row)
--   * a same-key replay / conflict update does not insert a duplicate row
--   * the active-ref deactivation side effect is preserved across the rewrite
--
-- Run via: supabase test db

BEGIN;
SELECT plan(7);

-- ---- Fixture --------------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('11111111-1111-1111-1111-111111111111', 'pmref-replayed@example.invalid');

-- ---- Calls (each executed exactly once, captured into temp tables) ---------
-- T1: brand new method ref, key k1.
CREATE TEMP TABLE _t1 AS
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-idem-k1', '11111111-1111-1111-1111-111111111111'::uuid, NULL,
  'tpay', 'blik_payid', NULL, 'method_ref_alpha', NULL, 'active',
  true, NULL, '{}'::jsonb, '{}'::jsonb) AS r;

-- T2: same provider_kind + method ref, NEW idempotency key k2 -> ON CONFLICT update.
CREATE TEMP TABLE _t2 AS
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-idem-k2', '11111111-1111-1111-1111-111111111111'::uuid, NULL,
  'tpay', 'blik_payid', NULL, 'method_ref_alpha', NULL, 'active',
  true, NULL, '{}'::jsonb, '{}'::jsonb) AS r;

-- T3: REPLAY of key k1 with the identical fingerprint -> cached payload, stamped.
CREATE TEMP TABLE _t3 AS
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-idem-k1', '11111111-1111-1111-1111-111111111111'::uuid, NULL,
  'tpay', 'blik_payid', NULL, 'method_ref_alpha', NULL, 'active',
  true, NULL, '{}'::jsonb, '{}'::jsonb) AS r;

-- T4: a SECOND distinct active ref for the same client (subscription_id NULL) ->
-- exercises the preserved deactivation of the other active ref (alpha).
CREATE TEMP TABLE _t4 AS
SELECT public.commerce_payment_method_ref_upsert(
  'pmref-idem-k3', '11111111-1111-1111-1111-111111111111'::uuid, NULL,
  'tpay', 'blik_payid', NULL, 'method_ref_beta', NULL, 'active',
  true, NULL, '{}'::jsonb, '{}'::jsonb) AS r;

-- ---- Assertions -----------------------------------------------------------
SELECT is(
  (SELECT r #>> '{paymentMethodRef,replayed}' FROM _t1),
  'false', 'new method ref -> replayed:false');

SELECT is(
  (SELECT r #>> '{paymentMethodRef,replayed}' FROM _t2),
  'true', 'same method ref + new idempotency key -> replayed:true (conflict update)');

SELECT is(
  (SELECT r #>> '{paymentMethodRef,replayed}' FROM _t3),
  'true', 'same idempotency key replay -> replayed:true (cached payload stamped)');

SELECT is(
  (SELECT r #>> '{paymentMethodRef,id}' FROM _t3),
  (SELECT r #>> '{paymentMethodRef,id}' FROM _t1),
  'key replay returns the original method ref id (cached identity)');

SELECT is(
  (SELECT r #>> '{paymentMethodRef,id}' FROM _t2),
  (SELECT r #>> '{paymentMethodRef,id}' FROM _t1),
  'conflict update targets the same row (no duplicate insert)');

SELECT is(
  (SELECT count(*)::int FROM public.commerce_payment_method_refs
    WHERE provider_kind = 'tpay' AND provider_method_ref = 'method_ref_alpha'),
  1, 'exactly one alpha row exists after replays + conflict update');

SELECT is(
  (SELECT active FROM public.commerce_payment_method_refs
    WHERE provider_kind = 'tpay' AND provider_method_ref = 'method_ref_alpha'),
  false, 'activating beta deactivated the prior active alpha ref (block preserved)');

SELECT * FROM finish();
ROLLBACK;
