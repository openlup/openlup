-- pgTAP: payment-recovery token hashing — SHA-256 only after the MD5 fallback drop
--   (20260627100000_payment_recovery_drop_md5_fallback.sql, cleanup of the
--    20260612210000 dual-hash transition).
--
--   * Node<->DB SHA-256 parity: encode(sha256(convert_to(t,'UTF8')),'hex') equals
--     the well-known SHA-256 hex (same value Node's createHash('sha256') produces).
--   * subscription_handle_payment_failure_dunning MINTS tokens as SHA-256.
--   * subscription_record_payment_recovery_request resolves a SHA-256 token and
--     now REJECTS a legacy MD5-hashed token as token-invalid (fallback removed).
--   * subscription_resume_from_dunning_with_cycle_order likewise rejects a legacy
--     MD5-hashed token as token-invalid, and still rejects an unknown token.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(39);

-- ---------------------------------------------------------------------------
-- 1. Node<->DB hash parity (deparser-independent anchor for the cutover).
-- ---------------------------------------------------------------------------
SELECT is(
  encode(sha256(convert_to('abc', 'UTF8')), 'hex'),
  'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  'SHA-256 hex matches Node crypto.createHash(sha256).update(t).digest(hex)'
);

-- ---------------------------------------------------------------------------
-- Shared fixture
-- ---------------------------------------------------------------------------
INSERT INTO public.clients (id, email)
VALUES ('d0000000-0000-0000-0000-000000000001', 'recovery-sha256@example.invalid');

-- ===========================================================================
-- OPEN case (repair_payment) — record RPC SHA-256 lookup
-- ===========================================================================
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('d1000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 30, 'PLN', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');
CREATE TEMP TABLE _fixture_money_unit AS
SELECT currency AS value
  FROM public.subscriptions
 WHERE id = 'd1000000-0000-0000-0000-000000000001';
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('d1c00000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000001', 2, '2026-06-01T00:00:00Z', 'planned', 'recovery-sha256-open', 1);
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('d10d0000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680, 'subscription_cycle',
        'd1000000-0000-0000-0000-000000000001', 'd1c00000-0000-0000-0000-000000000001');

CREATE TEMP TABLE _open_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'recovery-sha256-open-intent', 'subscription_cycle', 'd10d0000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000001', 'd1c00000-0000-0000-0000-000000000001', 2680, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

-- next_retry_at NOT NULL -> 'open' case + 'repair_payment' SHA-256 token.
CREATE TEMP TABLE _open AS
SELECT public.subscription_handle_payment_failure_dunning(
  'recovery-sha256-open-dunning',
  'd1c00000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000001',
  'd10d0000-0000-0000-0000-000000000001',
  (SELECT intent_id FROM _open_intent),
  1, '2026-06-20T00:00:00Z'::timestamptz, 'card_declined', '2026-06-12T12:00:00Z'::timestamptz
) AS r;

-- Raw token is recoverable from the recovery URL the RPC returns.
CREATE TEMP TABLE _open_token AS
SELECT
  (r->'subscriptionDunning'->>'caseId')::uuid AS case_id,
  split_part(r->'subscriptionDunning'->>'recoveryUrlPath', 'token=', 2) AS raw
FROM _open;

-- Keep the ordinary dunning retry in the future. Redeem alone must not make it
-- due until the exact subscription-bound provider method is durable.
UPDATE public.subscription_cycles
   SET status = 'retry_scheduled',
       next_retry_at = now() + interval '7 days'
 WHERE id = 'd1c00000-0000-0000-0000-000000000001';

-- 2 + 3: the minted token is stored as a 64-char SHA-256 hash of the raw token.
SELECT is(
  (SELECT length(token_hash) FROM public.subscription_payment_recovery_tokens
    WHERE case_id = (SELECT case_id FROM _open_token) AND purpose = 'repair_payment'),
  64, 'dunning RPC mints a 64-char SHA-256 token_hash (not 32-char MD5)'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.subscription_payment_recovery_tokens
     WHERE token_hash = encode(sha256(convert_to((SELECT raw FROM _open_token), 'UTF8')), 'hex')
  ),
  'minted token_hash equals encode(sha256(convert_to(raw,UTF8)),hex)'
);

-- 4 + 5: redeeming the SHA-256 token resolves via the SHA-256 lookup.
-- A pre-existing active method with the same provider ref is insufficient: only
-- the SetupIntent webhook may bind that ref to this exact recovery case.
INSERT INTO public.commerce_payment_method_refs (
  client_id, subscription_id, provider_kind, method_kind,
  provider_customer_ref, provider_method_ref, status, active,
  consent_snapshot
)
VALUES (
  'd0000000-0000-0000-0000-000000000001',
  'd1000000-0000-0000-0000-000000000001',
  'stripe', 'card', 'cus_sha_ref', 'pm_sha_ref', 'active', true,
  '{"source":"preexisting_method"}'::jsonb
);

CREATE TEMP TABLE _rec_sha AS
SELECT public.subscription_record_payment_recovery_request(
  'recovery-sha256-redeem', (SELECT raw FROM _open_token), 'pm_sha_ref', 'card', '2026-06-13T00:00:00Z'::timestamptz
) AS r;
SELECT is(
  (SELECT r->'subscriptionPaymentRecovery'->>'nextAction' FROM _rec_sha),
  'retry_existing_cycle', 'SHA-256 token redeems (nextAction=retry_existing_cycle)'
);
SELECT isnt(
  (SELECT used_at FROM public.subscription_payment_recovery_tokens
    WHERE token_hash = encode(sha256(convert_to((SELECT raw FROM _open_token), 'UTF8')), 'hex')),
  NULL, 'SHA-256 token marked used after redeem'
);

SELECT ok(
  (SELECT next_retry_at > now()
     FROM public.subscription_cycles
    WHERE id = 'd1c00000-0000-0000-0000-000000000001'),
  'redeem does not retry against a method that the Stripe webhook has not bound yet'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_events
    WHERE subscription_id = 'd1000000-0000-0000-0000-000000000001'
      AND event_type = 'subscription.payment_recovered'),
  0,
  'redeem does not claim that payment recovered before money succeeds'
);

UPDATE public.commerce_payment_method_refs
   SET consent_snapshot = jsonb_build_object(
         'recoveryCaseId', (SELECT case_id FROM _open_token)
       ),
       updated_at = '2026-06-13T00:00:01Z'::timestamptz
 WHERE subscription_id = 'd1000000-0000-0000-0000-000000000001'
   AND provider_method_ref = 'pm_sha_ref';

SELECT public.subscription_try_schedule_recovery_retry(
  (SELECT case_id FROM _open_token),
  'pm_sha_ref',
  '2026-06-13T00:00:01Z'::timestamptz
);

SELECT ok(
  (SELECT next_retry_at <= now()
     FROM public.subscription_cycles
    WHERE id = 'd1c00000-0000-0000-0000-000000000001'),
  'webhook-side handshake makes the same failed cycle immediately due'
);

SELECT is(
  (SELECT retry_attempt
     FROM public.subscription_cycles
    WHERE id = 'd1c00000-0000-0000-0000-000000000001'),
  1,
  'recovery scheduling preserves the existing retry budget'
);

SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_events
    WHERE subscription_id = 'd1000000-0000-0000-0000-000000000001'
      AND event_type = 'subscription.retry_scheduled'
      AND idempotency_key = 'payment-recovery-retry:' || (SELECT case_id::text FROM _open_token)),
  1,
  'the retry event is emitted once only when both sides of the handshake are durable'
);

-- 6: a legacy MD5-hashed token on the SAME open case is NO LONGER accepted —
--    the dual-hash fallback was removed, so the SHA-256-only lookup misses it.
INSERT INTO public.subscription_payment_recovery_tokens
  (case_id, subscription_id, client_id, token_hash, purpose, expires_at)
VALUES (
  (SELECT case_id FROM _open_token),
  'd1000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001',
  md5('LEGACY-OPEN-TOKEN-0123456789abcdef'),
  'repair_payment', '2026-07-31T00:00:00Z'
);
SELECT throws_like(
  $$ SELECT public.subscription_record_payment_recovery_request(
       'recovery-md5-redeem', 'LEGACY-OPEN-TOKEN-0123456789abcdef', 'pm_legacy_ref', 'card',
       '2026-06-13T01:00:00Z'::timestamptz) $$,
  '%payment_recovery_token_invalid%',
  'legacy MD5 token rejected as token-invalid (SHA-256-only after fallback drop)'
);

-- ===========================================================================
-- EXPIRED case (resume_subscription) — resume RPC SHA-256 lookup
-- ===========================================================================
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('d2000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 30, 'PLN', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES
  ('d2c00000-0000-0000-0000-000000000002', 'd2000000-0000-0000-0000-000000000001', 1, '2026-05-01T00:00:00Z', 'payment_failed', 'recovery-sha256-expired-older', 2),
  ('d2c00000-0000-0000-0000-000000000001', 'd2000000-0000-0000-0000-000000000001', 2, '2026-06-01T00:00:00Z', 'planned', 'recovery-sha256-expired', 4);
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES
  ('d20d0000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001', (SELECT value FROM _fixture_money_unit), 'ZZ',
        '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment', 2680, 2680, 'subscription_cycle',
        'd2000000-0000-0000-0000-000000000001', 'd2c00000-0000-0000-0000-000000000002'),
  ('d20d0000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 2680, 2680, 'subscription_cycle',
        'd2000000-0000-0000-0000-000000000001', 'd2c00000-0000-0000-0000-000000000001');

CREATE TEMP TABLE _exp_older_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'recovery-sha256-expired-older-intent', 'subscription_cycle', 'd20d0000-0000-0000-0000-000000000002',
  'd2000000-0000-0000-0000-000000000001', 'd2c00000-0000-0000-0000-000000000002', 2680, (SELECT value FROM _fixture_money_unit), '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _exp_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'recovery-sha256-expired-intent', 'subscription_cycle', 'd20d0000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001', 'd2c00000-0000-0000-0000-000000000001', 2680, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

-- next_retry_at NULL at the ladder's last rung -> 'expired' case +
-- 'resume_subscription' SHA-256 token. The rung matters: attempts 1..3 are always
-- handed a schedule, so only attempt 4 pairs with NULL by exhaustion, and the
-- cycle above is seeded on that rung to match. (A NULL below rung 4 is a
-- deliberately cut-short ladder and yields an OPEN case instead.)
CREATE TEMP TABLE _exp AS
SELECT (public.subscription_handle_payment_failure_dunning(
  'recovery-sha256-expired-dunning',
  'd2c00000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  'd20d0000-0000-0000-0000-000000000001',
  (SELECT intent_id FROM _exp_intent),
  4, NULL, 'payment_expired', '2026-06-12T12:00:00Z'::timestamptz
) -> 'subscriptionDunning' ->> 'caseId')::uuid AS case_id;

-- The generic method-redeem boundary used to fail closed here, because it had
-- no way to resume an expired journey that did not leave the subscription
-- active and permanently absent from the renewal due-list. It has one now:
-- subscription_resume_after_expired_dunning skips the uncollected cycle instead
-- of minting a replacement from snapshots this boundary cannot build. The three
-- expectations below are re-pinned to that rail; they are the only
-- characterization changes in this wave.
INSERT INTO public.commerce_payment_method_refs (
  client_id, subscription_id, provider_kind, method_kind,
  provider_customer_ref, provider_method_ref, status, active
)
VALUES (
  'd0000000-0000-0000-0000-000000000001',
  'd2000000-0000-0000-0000-000000000001',
  'card_rail', 'card', 'cus_resume_ref', 'pm_resume_ref', 'active', true
);

-- trg_subscription_guard_active_requires_lines refuses paused -> active for a
-- line-less subscription, and a real resume always has its template. The
-- catalog rows exist only to give the line a variant to point at.
INSERT INTO public.catalog_products (id, slug, name, status)
VALUES ('d2c10000-0000-0000-0000-000000000001', 'resume-token-product', 'Resume Token Product', 'active');
INSERT INTO public.catalog_skus (id, product_id, sku, title, pet_type, status, net_weight_g, kcal_per_unit)
VALUES ('d2c20000-0000-0000-0000-000000000001', 'd2c10000-0000-0000-0000-000000000001',
        'RESUME-TOKEN-SKU', 'Resume Token SKU', 'dog', 'active', 400, 350);
INSERT INTO public.subscription_lines (subscription_id, variant_id, qty, sort_order, is_addon, template_version)
VALUES ('d2000000-0000-0000-0000-000000000001', 'd2c20000-0000-0000-0000-000000000001', 1, 0, false, 1);

-- The cycle is terminal when the ladder expires: the payment-control apply body
-- writes payment_failed, and the dunning RPC does not touch cycle status.
UPDATE public.subscription_cycles
   SET status = 'payment_failed', failure_reason = 'payment_expired'
 WHERE id = 'd2c00000-0000-0000-0000-000000000001';

INSERT INTO public.subscription_payment_recovery_tokens
  (case_id, subscription_id, client_id, token_hash, purpose, expires_at)
VALUES (
  (SELECT case_id FROM _exp),
  'd2000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001',
  encode(sha256(convert_to('EXPIRED-RESUME-NOT-WIRED-TOKEN', 'UTF8')), 'hex'),
  'resume_subscription', '2026-07-31T00:00:00Z'
);

SELECT is(
  (SELECT count(*)::integer FROM public.subscription_cycles
    WHERE subscription_id = 'd2000000-0000-0000-0000-000000000001'
      AND status IN ('payment_pending', 'retry_scheduled', 'payment_failed')),
  2,
  'the expired recovery fixture contains both the latest and an older stale unpaid cycle'
);

-- WAS: throws subscription_payment_recovery_resume_not_available.
-- NOW: the redeem resumes, and says so in the contract's own vocabulary.
SELECT is(
  (SELECT public.subscription_record_payment_recovery_request(
     'recovery-expired-generic-redeem', 'EXPIRED-RESUME-NOT-WIRED-TOKEN',
     'pm_resume_ref', 'card', '2026-06-13T01:30:00Z'::timestamptz)
   #>> '{subscriptionPaymentRecovery,nextAction}'),
  'resume_subscription',
  'generic payment recovery resumes an expired-dunning journey'
);
-- WAS: the token stays unused because the redeem refused.
-- NOW: it is consumed, because the redeem it authorises actually happened.
SELECT isnt(
  (SELECT used_at FROM public.subscription_payment_recovery_tokens
    WHERE token_hash = encode(sha256(convert_to('EXPIRED-RESUME-NOT-WIRED-TOKEN', 'UTF8')), 'hex')),
  NULL,
  'the redeemed expired-resume token is consumed'
);
SELECT is(
  (SELECT status FROM public.subscription_cycles WHERE id = 'd2c00000-0000-0000-0000-000000000002'),
  'skipped',
  'generic expired-token recovery terminalizes the older failed cycle'
);
SELECT is(
  (SELECT status FROM public.commerce_orders WHERE id = 'd20d0000-0000-0000-0000-000000000002'),
  'cancelled',
  'generic expired-token recovery cancels the older unpaid order'
);
SELECT is(
  (SELECT status FROM public.commerce_payment_intents WHERE id = (SELECT intent_id FROM _exp_older_intent)),
  'cancelled',
  'generic expired-token recovery cancels the older unpaid intent'
);
-- WAS: asserted the absence of a false `subscription.resumed` event, which was
-- the whole point when nothing could resume. NOW the meaningful assertion is
-- that the resume left no cycle status behind that excludes the subscription
-- from subscription_list_due_for_renewal -- the exact stranding this rail exists
-- to prevent.
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_cycles
    WHERE subscription_id = 'd2000000-0000-0000-0000-000000000001'
      AND status IN ('payment_pending', 'retry_scheduled', 'payment_failed')),
  0,
  'the redeemed expired resume leaves no cycle that strands the renewal lane'
);
-- The unreachability claim, stated against the due-list itself: before this rail
-- the resumed subscription was active and permanently absent from it.
SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_list_due_for_renewal(50, '2026-06-20T00:00:00Z'::timestamptz)
    WHERE subscription_id = 'd2000000-0000-0000-0000-000000000001'),
  1,
  'the redeemed expired resume is due-listable again'
);

-- A legacy in-flight MD5 resume token on the expired case.
INSERT INTO public.subscription_payment_recovery_tokens
  (case_id, subscription_id, client_id, token_hash, purpose, expires_at)
VALUES (
  (SELECT case_id FROM _exp),
  'd2000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001',
  md5('LEGACY-RESUME-TOKEN-fedcba9876543210'),
  'resume_subscription', '2026-07-31T00:00:00Z'
);

-- 7: legacy MD5 resume token is now rejected as token-invalid (fallback removed),
--    so it never reaches the stale-cycle-number guard.
SELECT throws_like(
  $$ SELECT public.subscription_resume_from_dunning_with_cycle_order(
       'recovery-md5-resume', 'LEGACY-RESUME-TOKEN-fedcba9876543210', 'pm_resume_ref', 'card',
       2, '2026-07-01T00:00:00Z'::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '2026-06-13T02:00:00Z'::timestamptz) $$,
  '%resume_token_invalid%',
  'legacy MD5 resume token rejected as token-invalid (fallback removed)'
);

-- 8: an unknown token is still rejected as token-invalid (SHA-256 lookup, no false positives).
SELECT throws_like(
  $$ SELECT public.subscription_resume_from_dunning_with_cycle_order(
       'recovery-bogus-resume', 'NOT-A-REAL-RECOVERY-TOKEN', 'pm_resume_ref', 'card',
       99, '2026-07-01T00:00:00Z'::timestamptz, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
       '2026-06-13T03:00:00Z'::timestamptz) $$,
  '%resume_token_invalid%',
  'unknown token rejected as token-invalid'
);

-- ===========================================================================
-- DIRECT expired-token cycle-order resume — positive SHA-256 multi-cycle path
-- ===========================================================================
INSERT INTO public.subscriptions (
  id, client_id, cadence_days, currency, region_code, size_constraint, status,
  started_at, next_cycle_at, payment_method_ref, payment_method_kind
) VALUES (
  'd4000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
  30, (SELECT value FROM _fixture_money_unit), 'ZZ', '{"kind":"feeding_days","value":21}'::jsonb, 'active',
  '2026-04-01T00:00:00Z', '2026-05-01T00:00:00Z', 'pm_direct_old', 'card'
);

INSERT INTO public.subscription_lines (
  subscription_id, variant_id, qty, sort_order, is_addon, template_version
) VALUES (
  'd4000000-0000-0000-0000-000000000001', 'd2c20000-0000-0000-0000-000000000001',
  1, 0, false, 1
);

-- Fresh-cycle order items reserve through the provider stock oracle.
SELECT public.fulfillment_provider_upsert_stock_current(
  'direct-resume-stock-current', 'omnipack', 'RESUME-TOKEN-SKU',
  100, 100, 0, now(), now() + interval '6 hours',
  'direct-resume-stock-run',
  '{"source":"payment_recovery_sha256_test"}'::jsonb
);

INSERT INTO public.subscription_cycles (
  id, subscription_id, cycle_number, scheduled_at, status,
  engine_idempotency_key, retry_attempt, failure_reason
) VALUES
  ('d4c00000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001',
   1, '2026-05-01T00:00:00Z', 'payment_failed', 'direct-resume-older-cycle', 2, 'card_declined'),
  ('d4c00000-0000-0000-0000-000000000002', 'd4000000-0000-0000-0000-000000000001',
   2, '2026-06-01T00:00:00Z', 'planned', 'direct-resume-latest-cycle', 4, NULL);

INSERT INTO public.commerce_orders (
  id, client_id, currency, region_code, size_constraint, status,
  total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id
) VALUES
  ('d40d0000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001',
   (SELECT value FROM _fixture_money_unit), 'ZZ', '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment',
   2680, 2680, 'subscription_cycle', 'd4000000-0000-0000-0000-000000000001',
   'd4c00000-0000-0000-0000-000000000001'),
  ('d40d0000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
   (SELECT value FROM _fixture_money_unit), 'ZZ', '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment',
   2680, 2680, 'subscription_cycle', 'd4000000-0000-0000-0000-000000000001',
   'd4c00000-0000-0000-0000-000000000002');

CREATE TEMP TABLE _direct_older_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'direct-resume-older-intent', 'subscription_cycle', 'd40d0000-0000-0000-0000-000000000001',
  'd4000000-0000-0000-0000-000000000001', 'd4c00000-0000-0000-0000-000000000001',
  2680, (SELECT value FROM _fixture_money_unit), '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _direct_latest_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'direct-resume-latest-intent', 'subscription_cycle', 'd40d0000-0000-0000-0000-000000000002',
  'd4000000-0000-0000-0000-000000000001', 'd4c00000-0000-0000-0000-000000000002',
  2680, (SELECT value FROM _fixture_money_unit), '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _direct_case AS
SELECT (public.subscription_handle_payment_failure_dunning(
  'direct-resume-expired-dunning',
  'd4c00000-0000-0000-0000-000000000002',
  'd4000000-0000-0000-0000-000000000001',
  'd40d0000-0000-0000-0000-000000000002',
  (SELECT intent_id FROM _direct_latest_intent),
  4, NULL, 'payment_expired', '2026-06-12T12:00:00Z'::timestamptz
) -> 'subscriptionDunning' ->> 'caseId')::uuid AS case_id;

UPDATE public.subscription_cycles
   SET status = 'payment_failed', failure_reason = 'payment_expired'
 WHERE id = 'd4c00000-0000-0000-0000-000000000002';

INSERT INTO public.subscription_payment_recovery_tokens (
  case_id, subscription_id, client_id, token_hash, purpose, expires_at
) VALUES (
  (SELECT case_id FROM _direct_case),
  'd4000000-0000-0000-0000-000000000001',
  'd0000000-0000-0000-0000-000000000001',
  encode(sha256(convert_to('DIRECT-SHA256-RESUME-TOKEN', 'UTF8')), 'hex'),
  'resume_subscription', '2026-07-31T00:00:00Z'
);

CREATE TEMP TABLE _direct_order_snapshot AS
SELECT replace('{
    "contractVersion":"commerce.v0","source":"subscription.own_engine.v0",
    "status":"pending_payment","paymentStatus":"pending","currency":"__MONEY_UNIT__","taxIncluded":true,
    "lines":[{"sku":"RESUME-TOKEN-SKU","productSlug":"resume-token-product","quantity":1,
      "unitPriceGross":{"amountMinor":2680,"currency":"__MONEY_UNIT__"},
      "lineSubtotalGross":{"amountMinor":2680,"currency":"__MONEY_UNIT__"},
      "tax":{"vatRateBps":800,
        "netAmount":{"amountMinor":2481,"currency":"__MONEY_UNIT__"},
        "vatAmount":{"amountMinor":199,"currency":"__MONEY_UNIT__"},
        "grossAmount":{"amountMinor":2680,"currency":"__MONEY_UNIT__"}}}],
    "totals":{"subtotalGross":{"amountMinor":2680,"currency":"__MONEY_UNIT__"},
      "discountTotalGross":{"amountMinor":0,"currency":"__MONEY_UNIT__"},
      "netTotal":{"amountMinor":2481,"currency":"__MONEY_UNIT__"},
      "taxTotal":{"amountMinor":199,"currency":"__MONEY_UNIT__"},
      "totalGross":{"amountMinor":2680,"currency":"__MONEY_UNIT__"}}
  }', '__MONEY_UNIT__', (SELECT value FROM _fixture_money_unit))::jsonb AS payload;

CREATE TEMP TABLE _direct_resume AS
SELECT public.subscription_resume_from_dunning_with_cycle_order(
  'recovery-direct-resume', 'DIRECT-SHA256-RESUME-TOKEN', 'pm_direct_new', 'card',
  3, '2026-07-01T00:00:00Z'::timestamptz,
  public.subscription_current_template_snapshot('d4000000-0000-0000-0000-000000000001'),
  '{"source":"payment_recovery_sha256_test"}'::jsonb,
  (SELECT payload FROM _direct_order_snapshot),
  '2026-06-13T04:00:00Z'::timestamptz
) AS r;

SELECT is(
  (SELECT r #>> '{subscriptionDunningResume,replayed}' FROM _direct_resume),
  'false', 'the direct SHA-256 resume executes instead of replaying initially'
);
SELECT is(
  (SELECT count(*)::integer FROM public.subscription_cycles
    WHERE id IN ('d4c00000-0000-0000-0000-000000000001', 'd4c00000-0000-0000-0000-000000000002')
      AND status = 'skipped'),
  2, 'the direct resume terminalizes both stale cycles'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_orders
    WHERE id IN ('d40d0000-0000-0000-0000-000000000001', 'd40d0000-0000-0000-0000-000000000002')
      AND status = 'cancelled'),
  2, 'the direct resume cancels both stale unpaid orders'
);
SELECT is(
  (SELECT count(*)::integer FROM public.commerce_payment_intents
    WHERE id IN ((SELECT intent_id FROM _direct_older_intent), (SELECT intent_id FROM _direct_latest_intent))
      AND status = 'cancelled'),
  2, 'the direct resume cancels both stale unpaid intents'
);
SELECT is(
  (SELECT status FROM public.subscription_dunning_cases WHERE id = (SELECT case_id FROM _direct_case)),
  'resumed_unpaid', 'the direct resume closes the expired case honestly'
);
SELECT is(
  (SELECT (cycle_number, status)::text FROM public.subscription_cycles
    WHERE id = (SELECT (r #>> '{subscriptionDunningResume,cycleOrder,cycleId}')::uuid FROM _direct_resume)),
  '(3,payment_pending)', 'the direct resume creates the requested fresh payment-pending cycle'
);
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.commerce_orders fresh_order
     WHERE fresh_order.id = (
       SELECT replace(r #>> '{subscriptionDunningResume,cycleOrder,orderId}', 'order_', '')::uuid
         FROM _direct_resume)
       AND fresh_order.subscription_cycle_id = (
         SELECT (r #>> '{subscriptionDunningResume,cycleOrder,cycleId}')::uuid FROM _direct_resume)
       AND fresh_order.status = 'pending_payment'
  ), 'the fresh cycle order is linked and payable'
);

CREATE TEMP TABLE _direct_replay AS
SELECT public.subscription_resume_from_dunning_with_cycle_order(
  'recovery-direct-resume', 'DIRECT-SHA256-RESUME-TOKEN', 'pm_direct_new', 'card',
  3, '2026-07-01T00:00:00Z'::timestamptz,
  public.subscription_current_template_snapshot('d4000000-0000-0000-0000-000000000001'),
  '{"source":"payment_recovery_sha256_test"}'::jsonb,
  (SELECT payload FROM _direct_order_snapshot),
  '2026-06-13T04:00:00Z'::timestamptz
) AS r;

SELECT is(
  (SELECT r #>> '{subscriptionDunningResume,replayed}' FROM _direct_replay),
  'true', 'the direct SHA-256 resume replays after the token has been consumed'
);
SELECT ok(
  (SELECT r #>> '{subscriptionDunningResume,cycleOrder,cycleId}' FROM _direct_replay)
    = (SELECT r #>> '{subscriptionDunningResume,cycleOrder,cycleId}' FROM _direct_resume)
  AND (SELECT r #>> '{subscriptionDunningResume,cycleOrder,orderId}' FROM _direct_replay)
    = (SELECT r #>> '{subscriptionDunningResume,cycleOrder,orderId}' FROM _direct_resume)
  AND (SELECT count(*) FROM public.subscription_cycles
        WHERE subscription_id = 'd4000000-0000-0000-0000-000000000001' AND cycle_number = 3) = 1,
  'the replay returns the same fresh cycle/order and creates no duplicate cycle'
);

-- ===========================================================================
-- 17-25: the SECOND entry to the same scheduling rail — a webhook-confirmed
-- method update on a subscription whose dunning case is open. No token is
-- redeemed here: the account's card-update flow has none, and the durable
-- evidence is the method-ref row the webhook wrote.
-- ===========================================================================
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('d3000000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 30, 'EUR', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('d3c00000-0000-0000-0000-000000000001', 'd3000000-0000-0000-0000-000000000001', 2, '2026-06-01T00:00:00Z', 'planned', 'recovery-update-open', 1);
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('d30d0000-0000-0000-0000-000000000001', 'd0000000-0000-0000-0000-000000000001', 'EUR', 'DE',
        '{"kind":"units","value":21}'::jsonb, 'draft', 2680, 2680, 'subscription_cycle',
        'd3000000-0000-0000-0000-000000000001', 'd3c00000-0000-0000-0000-000000000001');

CREATE TEMP TABLE _upd_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'recovery-update-open-intent', 'subscription_cycle', 'd30d0000-0000-0000-0000-000000000001',
  'd3000000-0000-0000-0000-000000000001', 'd3c00000-0000-0000-0000-000000000001', 2680, 'EUR', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _upd_case AS
SELECT (public.subscription_handle_payment_failure_dunning(
  'recovery-update-dunning',
  'd3c00000-0000-0000-0000-000000000001',
  'd3000000-0000-0000-0000-000000000001',
  'd30d0000-0000-0000-0000-000000000001',
  (SELECT intent_id FROM _upd_intent),
  1, '2026-06-20T00:00:00Z'::timestamptz, 'card_declined', '2026-06-12T12:00:00Z'::timestamptz
) -> 'subscriptionDunning' ->> 'caseId')::uuid AS case_id;

UPDATE public.subscription_cycles
   SET status = 'retry_scheduled',
       next_retry_at = now() + interval '7 days'
 WHERE id = 'd3c00000-0000-0000-0000-000000000001';

-- The method on file when the charge was refused. Same row shape a webhook
-- writes, deliberately stamped BEFORE the failure that opened the case.
INSERT INTO public.commerce_payment_method_refs (
  client_id, subscription_id, provider_kind, method_kind,
  provider_customer_ref, provider_method_ref, status, active,
  consent_snapshot, created_at, updated_at
)
VALUES (
  'd0000000-0000-0000-0000-000000000001',
  'd3000000-0000-0000-0000-000000000001',
  'card_rail', 'card', 'cus_upd_ref', 'pm_upd_ref', 'active', true,
  '{"source":"account.card-update"}'::jsonb,
  '2026-05-01T00:00:00Z'::timestamptz, '2026-05-01T00:00:00Z'::timestamptz
);

-- 17: the row that predates the failure IS the method that failed.
SELECT public.subscription_try_schedule_recovery_retry(
  (SELECT case_id FROM _upd_case), 'pm_upd_ref', '2026-06-13T00:00:00Z'::timestamptz, 'method_ref_webhook'
);
SELECT ok(
  (SELECT next_retry_at > now()
     FROM public.subscription_cycles
    WHERE id = 'd3c00000-0000-0000-0000-000000000001'),
  'a method the rail confirmed BEFORE the failure never pulls the retry forward'
);

-- The account card-update webhook lands: the same row, confirmed after the
-- failure. This is the only fact that changes.
UPDATE public.commerce_payment_method_refs
   SET updated_at = '2026-06-13T00:00:01Z'::timestamptz
 WHERE provider_method_ref = 'pm_upd_ref';

-- 18-20: the failed cycle becomes due now, and the subscription's method mirror
-- converges on exactly what the redeem rail leaves behind.
SELECT public.subscription_try_schedule_recovery_retry(
  (SELECT case_id FROM _upd_case), 'pm_upd_ref', '2026-06-13T00:00:01Z'::timestamptz, 'method_ref_webhook'
);
SELECT ok(
  (SELECT next_retry_at <= now()
     FROM public.subscription_cycles
    WHERE id = 'd3c00000-0000-0000-0000-000000000001'),
  'a webhook-confirmed method update makes the same failed cycle immediately due'
);
SELECT is(
  (SELECT (payment_method_ref, payment_method_kind)::text
     FROM public.subscriptions WHERE id = 'd3000000-0000-0000-0000-000000000001'),
  '(pm_upd_ref,card)',
  'the account rail now writes the subscription method mirror it used to skip'
);
SELECT is(
  (SELECT (payment_method_ref, payment_method_kind)::text
     FROM public.subscriptions WHERE id = 'd1000000-0000-0000-0000-000000000001'),
  '(pm_sha_ref,card)',
  'the redeem rail leaves the same two columns, in the same shape, unchanged'
);

-- 21-22: webhook redelivery is not a second schedule.
CREATE TEMP TABLE _upd_due AS
SELECT next_retry_at FROM public.subscription_cycles
 WHERE id = 'd3c00000-0000-0000-0000-000000000001';
SELECT public.subscription_try_schedule_recovery_retry(
  (SELECT case_id FROM _upd_case), 'pm_upd_ref', '2026-06-13T00:00:02Z'::timestamptz, 'method_ref_webhook'
);
SELECT is(
  (SELECT next_retry_at FROM public.subscription_cycles
    WHERE id = 'd3c00000-0000-0000-0000-000000000001'),
  (SELECT next_retry_at FROM _upd_due),
  'a redelivered method webhook cannot move an already-due retry'
);
SELECT is(
  (SELECT count(*)::integer
     FROM public.subscription_events
    WHERE subscription_id = 'd3000000-0000-0000-0000-000000000001'
      AND event_type = 'subscription.retry_scheduled'),
  1,
  'the retry event stays emitted exactly once across the redelivery'
);

-- 23: a method the rail retired never schedules, however fresh its row is.
UPDATE public.commerce_payment_method_refs
   SET status = 'inactive', active = false, deactivated_at = now(), updated_at = now()
 WHERE provider_method_ref = 'pm_upd_ref';
UPDATE public.subscription_cycles
   SET next_retry_at = now() + interval '7 days'
 WHERE id = 'd3c00000-0000-0000-0000-000000000001';
SELECT public.subscription_try_schedule_recovery_retry(
  (SELECT case_id FROM _upd_case), 'pm_upd_ref', '2026-06-13T00:00:03Z'::timestamptz, 'method_ref_webhook'
);
SELECT ok(
  (SELECT next_retry_at > now()
     FROM public.subscription_cycles
    WHERE id = 'd3c00000-0000-0000-0000-000000000001'),
  'a revoked or expired method never schedules a retry'
);

-- 24: a method update on a subscription with no OPEN case is a no-op.
UPDATE public.commerce_payment_method_refs
   SET status = 'active', active = true, deactivated_at = NULL, updated_at = now()
 WHERE provider_method_ref = 'pm_upd_ref';
UPDATE public.subscription_dunning_cases
   SET status = 'recovered', recovered_at = now()
 WHERE id = (SELECT case_id FROM _upd_case);
SELECT public.subscription_try_schedule_recovery_retry(
  (SELECT case_id FROM _upd_case), 'pm_upd_ref', '2026-06-13T00:00:04Z'::timestamptz, 'method_ref_webhook'
);
SELECT ok(
  (SELECT next_retry_at > now()
     FROM public.subscription_cycles
    WHERE id = 'd3c00000-0000-0000-0000-000000000001'),
  'a stored method update against a subscription with no open case changes nothing'
);

-- 25: an entry condition nobody published is refused, never defaulted.
SELECT throws_ok(
  $$SELECT public.subscription_try_schedule_recovery_retry(
      'd3f00000-0000-0000-0000-0000000000ff'::uuid, 'pm_upd_ref',
      '2026-06-13T00:00:05Z'::timestamptz, 'trust_me')$$,
  '22023',
  'subscription_recovery_retry_invalid_input',
  'an unrecognised entry condition raises instead of quietly taking the default'
);

SELECT * FROM finish();
ROLLBACK;
