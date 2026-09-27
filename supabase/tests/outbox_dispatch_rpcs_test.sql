-- pgTAP: outbox dispatcher SQL contract (20260613000000).
--   * claim: allowlist mandatory, lease + claimToken + attempts-at-claim,
--     expired-lease reclaim, one-in-flight-per-aggregate anti-join, poison sweep
--   * marks: token-fenced processed/failed (retry backoff jitter, max-attempts
--     discard, permanent discard, snooze refund), wrong token -> false/'missed'
--   * release: pairwise token match + attempt refund; requeue: discarded-only
--     replay with audit trail + processing-aggregate guard
--   * queue_stats: all keys, expired-processing stall detection, malformed
--     discardedAt survival; grants deny anon/authenticated
--   * platform_job_controls seed (R-2): disabled-by-default skip, enabled
--     vercel_cron claim acquires (driver pin), pg_cron refused inactive_driver
--
-- Run via: supabase db reset && supabase test db

BEGIN;
SELECT no_plan();

-- ===========================================================================
-- claim: allowlist validation
-- ===========================================================================
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_batch(NULL) $$,
  '22023', 'outbox_claim_allowlist_required', 'claim with NULL allowlist raises 22023');
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_batch(ARRAY[]::text[]) $$,
  '22023', 'outbox_claim_allowlist_required', 'claim with empty allowlist raises 22023');

-- ===========================================================================
-- claim: basic lease semantics (synthetic event types; no FK on aggregate_id)
-- ===========================================================================
INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('e1000000-0000-0000-0000-000000000001', 'test_agg', 'aa000000-0000-0000-0000-000000000001', 'test.outbox.alpha', 'alpha-1', '{}'::jsonb),
  ('e2000000-0000-0000-0000-000000000001', 'test_agg', 'aa000000-0000-0000-0000-000000000002', 'test.outbox.beta',  'beta-1',  '{}'::jsonb);

CREATE TEMP TABLE _c1 AS
SELECT * FROM public.outbox_claim_batch(ARRAY['test.outbox.alpha'], 10, 300, 8);

SELECT is((SELECT count(*)::int FROM _c1), 1, 'claim returns only the allowlisted event');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'e2000000-0000-0000-0000-000000000001'),
  'pending', 'non-allowlisted event type is never claimed');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'e1000000-0000-0000-0000-000000000001'),
  'processing', 'claim sets status=processing');
SELECT is((SELECT attempts FROM public.outbox_events WHERE id = 'e1000000-0000-0000-0000-000000000001'),
  1, 'claim increments attempts');
SELECT ok((SELECT available_at > now() FROM public.outbox_events WHERE id = 'e1000000-0000-0000-0000-000000000001'),
  'claim pushes available_at into the future (visibility lease)');
SELECT ok((SELECT COALESCE(metadata->>'claimToken', '') <> '' FROM public.outbox_events WHERE id = 'e1000000-0000-0000-0000-000000000001'),
  'claim stamps a non-empty metadata claimToken');

SELECT is((SELECT count(*)::int FROM public.outbox_claim_batch(ARRAY['test.outbox.alpha'], 10, 300, 8)),
  0, 'immediate second claim returns zero rows (lease holds)');

-- force lease expiry -> reclaimable, attempts increments again
UPDATE public.outbox_events SET available_at = now() - interval '10 minutes'
 WHERE id = 'e1000000-0000-0000-0000-000000000001';
CREATE TEMP TABLE _c2 AS
SELECT * FROM public.outbox_claim_batch(ARRAY['test.outbox.alpha'], 10, 300, 8);
SELECT is((SELECT count(*)::int FROM _c2), 1, 'expired processing lease is reclaimable');
SELECT is((SELECT attempts FROM public.outbox_events WHERE id = 'e1000000-0000-0000-0000-000000000001'),
  2, 'attempts increments again at reclaim');

UPDATE public.outbox_events SET status = 'processed', processed_at = now()
 WHERE id = 'e1000000-0000-0000-0000-000000000001';

SELECT is((SELECT count(*)::int FROM public.outbox_claim_batch(ARRAY['test.outbox.alpha'], NULL, NULL, NULL)),
  0, 'NULL tuning params coalesce to defaults without raising');

-- ===========================================================================
-- claim: one-in-flight-per-aggregate anti-join
-- ===========================================================================
INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('a0000000-0000-0000-0000-000000000001', now() - interval '2 minutes', 'test_agg', 'bb000000-0000-0000-0000-000000000001', 'test.outbox.order', 'ord-1', '{}'::jsonb),
  ('a0000000-0000-0000-0000-000000000002', now() - interval '1 minute',  'test_agg', 'bb000000-0000-0000-0000-000000000001', 'test.outbox.order', 'ord-2', '{}'::jsonb);

CREATE TEMP TABLE _o1 AS
SELECT * FROM public.outbox_claim_batch(ARRAY['test.outbox.order'], 10, 300, 8);
SELECT is((SELECT count(*)::int FROM _o1), 1, 'one-in-flight: a single sibling claimed per aggregate');
SELECT is((SELECT id::text FROM _o1), 'a0000000-0000-0000-0000-000000000001',
  'the OLDER sibling is the one claimed');
SELECT is((SELECT count(*)::int FROM public.outbox_claim_batch(ARRAY['test.outbox.order'], 10, 300, 8)),
  0, 'younger sibling blocked while older sibling is processing');

UPDATE public.outbox_events SET status = 'failed', available_at = now() + interval '1 hour'
 WHERE id = 'a0000000-0000-0000-0000-000000000001';
SELECT is((SELECT count(*)::int FROM public.outbox_claim_batch(ARRAY['test.outbox.order'], 10, 300, 8)),
  0, 'younger sibling blocked while older is failed with future available_at');

UPDATE public.outbox_events SET status = 'processed', processed_at = now()
 WHERE id = 'a0000000-0000-0000-0000-000000000001';
CREATE TEMP TABLE _o2 AS
SELECT * FROM public.outbox_claim_batch(ARRAY['test.outbox.order'], 10, 300, 8);
SELECT is((SELECT id::text FROM _o2), 'a0000000-0000-0000-0000-000000000002',
  'younger sibling claimable once the older is processed');

INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, status, payload) VALUES
  ('a0000000-0000-0000-0000-000000000003', now() - interval '2 minutes', 'test_agg', 'bb000000-0000-0000-0000-000000000002', 'test.outbox.order2', 'ord2-1', 'discarded', '{}'::jsonb),
  ('a0000000-0000-0000-0000-000000000004', now() - interval '1 minute',  'test_agg', 'bb000000-0000-0000-0000-000000000002', 'test.outbox.order2', 'ord2-2', 'pending',   '{}'::jsonb);
SELECT is((SELECT id::text FROM public.outbox_claim_batch(ARRAY['test.outbox.order2'], 10, 300, 8)),
  'a0000000-0000-0000-0000-000000000004', 'younger sibling claimable when the older is discarded');

-- ===========================================================================
-- claim v2: dormant/unallowlisted siblings do not block runtime-ready events
-- ===========================================================================
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_batch_v2(NULL) $$,
  '22023', 'outbox_claim_allowlist_required', 'claim v2 with NULL allowlist raises 22023');
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_batch_v2(ARRAY[]::text[]) $$,
  '22023', 'outbox_claim_allowlist_required', 'claim v2 with empty allowlist raises 22023');

INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('a1000000-0000-0000-0000-000000000001', now() - interval '2 minutes', 'subscription', 'bb100000-0000-0000-0000-000000000001', 'commerce.subscription_payment.requested', 'v2-dormant-1', '{}'::jsonb),
  ('a1000000-0000-0000-0000-000000000002', now() - interval '1 minute',  'subscription', 'bb100000-0000-0000-0000-000000000001', 'subscription.cancelled',                  'v2-ready-1', '{}'::jsonb);

CREATE TEMP TABLE _v2_dormant AS
SELECT * FROM public.outbox_claim_batch_v2(ARRAY['subscription.cancelled'], 10, 300, 8);
SELECT is((SELECT id::text FROM _v2_dormant), 'a1000000-0000-0000-0000-000000000002',
  'claim v2 skips an older dormant subscription payment event and claims the later subscription.cancelled sibling');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a1000000-0000-0000-0000-000000000001'),
  'pending', 'claim v2 leaves the older dormant event pending and unclaimed');

INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('a1000000-0000-0000-0000-000000000003', now() - interval '2 minutes', 'subscription', 'bb100000-0000-0000-0000-000000000002', 'subscription.cancelled', 'v2-ready-2', '{}'::jsonb),
  ('a1000000-0000-0000-0000-000000000004', now() - interval '1 minute',  'subscription', 'bb100000-0000-0000-0000-000000000002', 'subscription.cancelled', 'v2-ready-3', '{}'::jsonb);

CREATE TEMP TABLE _v2_order AS
SELECT * FROM public.outbox_claim_batch_v2(ARRAY['subscription.cancelled'], 10, 300, 8);
SELECT is((SELECT id::text FROM _v2_order), 'a1000000-0000-0000-0000-000000000003',
  'claim v2 still claims the older allowlisted sibling first');
SELECT is((SELECT count(*)::int FROM public.outbox_claim_batch_v2(ARRAY['subscription.cancelled'], 10, 300, 8)),
  0, 'claim v2 still blocks the younger sibling while an older allowlisted sibling is processing');

-- ===========================================================================
-- claim v3: DB-approved dormant rows do not block; unknown rows fail closed
-- ===========================================================================
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_batch_v3(NULL) $$,
  '22023', 'outbox_claim_allowlist_required', 'claim v3 with NULL allowlist raises 22023');
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_batch_v3(ARRAY[]::text[]) $$,
  '22023', 'outbox_claim_allowlist_required', 'claim v3 with empty allowlist raises 22023');

SELECT ok(EXISTS (
    SELECT 1 FROM public.outbox_dormant_event_types
     WHERE event_type = 'commerce.subscription_payment.requested'),
  'claim v3 has an explicit DB dormant registry seed');

INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('a2000000-0000-0000-0000-000000000001', now() - interval '2 minutes', 'subscription', 'bb200000-0000-0000-0000-000000000001', 'commerce.subscription_payment.requested', 'v3-dormant-approved-1', '{}'::jsonb),
  ('a2000000-0000-0000-0000-000000000002', now() - interval '1 minute',  'subscription', 'bb200000-0000-0000-0000-000000000001', 'subscription.cancelled',                  'v3-ready-approved-1', '{}'::jsonb);

CREATE TEMP TABLE _v3_dormant AS
SELECT * FROM public.outbox_claim_batch_v3(
  p_event_types := ARRAY['subscription.cancelled'],
  p_known_event_types := ARRAY['subscription.cancelled', 'commerce.subscription_payment.requested'],
  p_batch_size := 10,
  p_visibility_seconds := 300,
  p_max_attempts := 8);
SELECT is((SELECT id::text FROM _v3_dormant), 'a2000000-0000-0000-0000-000000000002',
  'claim v3 skips an older approved dormant event and claims the later registered sibling');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a2000000-0000-0000-0000-000000000001'),
  'pending', 'claim v3 leaves approved dormant rows pending and unclaimed');

INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('a2000000-0000-0000-0000-000000000007', now() - interval '2 minutes', 'subscription', 'bb200000-0000-0000-0000-000000000004', 'commerce.order.review_request', 'v3-known-disabled-1', '{}'::jsonb),
  ('a2000000-0000-0000-0000-000000000008', now() - interval '1 minute',  'subscription', 'bb200000-0000-0000-0000-000000000004', 'subscription.cancelled', 'v3-ready-known-disabled-1', '{}'::jsonb);

CREATE TEMP TABLE _v3_known_disabled AS
SELECT * FROM public.outbox_claim_batch_v3(
  p_event_types := ARRAY['subscription.cancelled'],
  p_known_event_types := ARRAY['subscription.cancelled', 'commerce.order.review_request'],
  p_batch_size := 10,
  p_visibility_seconds := 300,
  p_max_attempts := 8);
SELECT is((SELECT id::text FROM _v3_known_disabled), 'a2000000-0000-0000-0000-000000000008',
  'claim v3 skips an older known-but-disabled event type and claims the later ready sibling');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a2000000-0000-0000-0000-000000000007'),
  'pending', 'claim v3 leaves known disabled rows pending and unclaimed');

INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('a2000000-0000-0000-0000-000000000003', now() - interval '2 minutes', 'subscription', 'bb200000-0000-0000-0000-000000000002', 'test.unknown.unapproved', 'v3-unknown-1', '{}'::jsonb),
  ('a2000000-0000-0000-0000-000000000004', now() - interval '1 minute',  'subscription', 'bb200000-0000-0000-0000-000000000002', 'subscription.cancelled', 'v3-ready-blocked-1', '{}'::jsonb);

SELECT is((SELECT count(*)::int FROM public.outbox_claim_batch_v3(
    p_event_types := ARRAY['subscription.cancelled'],
    p_known_event_types := ARRAY['subscription.cancelled'],
    p_batch_size := 10,
    p_visibility_seconds := 300,
    p_max_attempts := 8)),
  0, 'claim v3 fail-closes when an older same-aggregate event type is unknown/unapproved');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a2000000-0000-0000-0000-000000000004'),
  'pending', 'claim v3 leaves the later registered row pending while unknown older row blocks');

INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('a2000000-0000-0000-0000-000000000005', now() - interval '2 minutes', 'subscription', 'bb200000-0000-0000-0000-000000000003', 'subscription.cancelled', 'v3-ready-order-1', '{}'::jsonb),
  ('a2000000-0000-0000-0000-000000000006', now() - interval '1 minute',  'subscription', 'bb200000-0000-0000-0000-000000000003', 'subscription.cancelled', 'v3-ready-order-2', '{}'::jsonb);

CREATE TEMP TABLE _v3_order AS
SELECT * FROM public.outbox_claim_batch_v3(
  p_event_types := ARRAY['subscription.cancelled'],
  p_known_event_types := ARRAY['subscription.cancelled'],
  p_batch_size := 10,
  p_visibility_seconds := 300,
  p_max_attempts := 8);
SELECT is((SELECT id::text FROM _v3_order), 'a2000000-0000-0000-0000-000000000005',
  'claim v3 still claims the older registered sibling first');
SELECT is((SELECT count(*)::int FROM public.outbox_claim_batch_v3(
    p_event_types := ARRAY['subscription.cancelled'],
    p_known_event_types := ARRAY['subscription.cancelled'],
    p_batch_size := 10,
    p_visibility_seconds := 300,
    p_max_attempts := 8)),
  0, 'claim v3 still blocks a younger registered sibling while older registered sibling is processing');

-- ===========================================================================
-- Resend provider idempotency window: global claim recovery and terminal stop
-- ===========================================================================
SELECT ok(
  'subscription.activation_action_required' = ANY(private.outbox_resend_event_types()),
  'Resend idempotency classifier includes subscription activation-action-required lifecycle email');

INSERT INTO public.outbox_events (
  id, aggregate_type, aggregate_id, event_type, idempotency_key, payload
) VALUES (
  'a2000000-0000-0000-0000-000000000020',
  'commerce_order',
  'bb200000-0000-0000-0000-000000000020',
  'commerce.order.paid.email',
  'resend-window-stamp',
  '{}'::jsonb
);

CREATE TEMP TABLE _resend_window_stamp AS
SELECT * FROM public.outbox_claim_batch_v3(
  p_event_types := ARRAY['commerce.order.paid.email'],
  p_known_event_types := ARRAY['commerce.order.paid.email'],
  p_batch_size := 10,
  p_visibility_seconds := 300,
  p_max_attempts := 8
);
SELECT ok(
  (SELECT private.outbox_try_timestamptz(metadata->>'resendIdempotencyStartedAt') IS NOT NULL
     FROM public.outbox_events
    WHERE id = 'a2000000-0000-0000-0000-000000000020'),
  'global claim stamps a provider idempotency clock before the Resend POST');

UPDATE public.outbox_events
   SET status = 'failed',
       available_at = now() - interval '1 second',
       metadata = metadata || jsonb_build_object(
         'resendIdempotencyStartedAt', now() - interval '24 hours',
         'lastClaimedAt', now())
 WHERE id = 'a2000000-0000-0000-0000-000000000020';
SELECT is(
  (SELECT count(*)::int FROM public.outbox_claim_batch_v3(
    p_event_types := ARRAY['commerce.order.paid.email'],
    p_known_event_types := ARRAY['commerce.order.paid.email'],
    p_batch_size := 10,
    p_visibility_seconds := 300,
    p_max_attempts := 8
  )),
  0,
  'a stale ambiguous Resend attempt is never automatically re-claimed');
SELECT is(
  (SELECT status || '|' || (metadata->>'discardReason')
     FROM public.outbox_events
    WHERE id = 'a2000000-0000-0000-0000-000000000020'),
  'discarded|resend_idempotency_window_expired_manual_review',
  'global claim exposes a stale ambiguous provider attempt as manual-review work');

INSERT INTO public.outbox_events (
  id, aggregate_type, aggregate_id, event_type, idempotency_key, status, attempts, available_at, payload, metadata
) VALUES (
  'a2000000-0000-0000-0000-000000000021',
  'commerce_order',
  'bb200000-0000-0000-0000-000000000021',
  'commerce.order.paid.email',
  'resend-window-recovery',
  'processing',
  1,
  now() - interval '10 minutes',
  '{}'::jsonb,
  jsonb_build_object('resendIdempotencyStartedAt', now() - interval '24 hours')
);
INSERT INTO public.email_sends (
  template_slug, resend_id, sent_at, status, source, provider_response
) VALUES (
  'commerce-order-paid',
  're_outbox_window_recovery',
  now() - interval '2 minutes',
  'sent',
  'transactional-email',
  jsonb_build_object('id', 're_outbox_window_recovery', 'outboxEventId', 'a2000000-0000-0000-0000-000000000021')
);
SELECT is(
  (SELECT count(*)::int FROM public.outbox_claim_batch_v3(
    p_event_types := ARRAY['commerce.order.paid.email'],
    p_known_event_types := ARRAY['commerce.order.paid.email'],
    p_batch_size := 10,
    p_visibility_seconds := 300,
    p_max_attempts := 8
  )),
  0,
  'durable provider success is recovered before an expired provider key can be retried');
SELECT is(
  (SELECT status || '|' || (metadata->>'resendId')
     FROM public.outbox_events
    WHERE id = 'a2000000-0000-0000-0000-000000000021'),
  'processed|re_outbox_window_recovery',
  'global claim converges a durable Resend success into the outbox row');

SELECT ok(to_regclass('public.idx_outbox_events_v3_due_claim') IS NOT NULL,
  'claim v3 due-claim hot-path index exists');
SELECT ok(to_regclass('public.idx_outbox_events_v3_prior_check') IS NOT NULL,
  'claim v3 prior-check hot-path index exists');

INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, status, attempts, payload, metadata) VALUES
  ('a2000000-0000-0000-0000-000000000009', now() - interval '2 minutes', 'subscription', 'bb200000-0000-0000-0000-000000000005', 'subscription.cancelled', 'v3-preview-proof-1', 'pending', 8, '{}'::jsonb, '{"claimScope":"preview_matrix","runId":"matrix-run-1"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000010', now() - interval '1 minute',  'subscription', 'bb200000-0000-0000-0000-000000000006', 'subscription.cancelled', 'v3-preview-proof-2', 'pending', 0, '{}'::jsonb, '{"claimScope":"preview_matrix","runId":"matrix-run-2"}'::jsonb),
  ('a2000000-0000-0000-0000-000000000011', now() - interval '1 minute',  'subscription', 'bb200000-0000-0000-0000-000000000007', 'subscription.cancelled', 'v3-normal-after-proof', 'pending', 0, '{}'::jsonb, '{}'::jsonb);

CREATE TEMP TABLE _v3_preview_ignored AS
SELECT * FROM public.outbox_claim_batch_v3(
  p_event_types := ARRAY['subscription.cancelled'],
  p_known_event_types := ARRAY['subscription.cancelled'],
  p_batch_size := 10,
  p_visibility_seconds := 300,
  p_max_attempts := 8);
SELECT ok(NOT EXISTS (SELECT 1 FROM _v3_preview_ignored WHERE id IN (
    'a2000000-0000-0000-0000-000000000009',
    'a2000000-0000-0000-0000-000000000010')),
  'claim v3 ignores preview matrix proof rows, including rows at max attempts');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a2000000-0000-0000-0000-000000000009'),
  'pending', 'claim v3 does not poison-sweep preview matrix rows');

SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_preview_matrix_batch('', ARRAY['subscription.cancelled']) $$,
  '22023', 'outbox_preview_matrix_run_id_required', 'preview matrix claim requires run id');
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_preview_matrix_batch('matrix-run-1', ARRAY[]::text[]) $$,
  '22023', 'outbox_claim_allowlist_required', 'preview matrix claim requires event allowlist');

CREATE TEMP TABLE _preview_matrix_claim AS
SELECT * FROM public.outbox_claim_preview_matrix_batch(
  p_run_id := 'matrix-run-2',
  p_event_types := ARRAY['subscription.cancelled'],
  p_batch_size := 10,
  p_visibility_seconds := 300,
  p_max_attempts := 8);
SELECT is((SELECT count(*)::int FROM _preview_matrix_claim), 1,
  'preview matrix claim returns only rows for the exact run id');
SELECT is((SELECT id::text FROM _preview_matrix_claim), 'a2000000-0000-0000-0000-000000000010',
  'preview matrix claim does not claim normal or other-run rows');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a2000000-0000-0000-0000-000000000011'),
  'processing', 'normal claim still claimed the regular sibling');

-- ===========================================================================
-- aggregate claim: immediate paid-email drain scope
-- ===========================================================================
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_aggregate_batch(NULL, 'bb300000-0000-0000-0000-000000000001', ARRAY['commerce.order.paid.email']) $$,
  '22023', 'outbox_claim_aggregate_scope_required', 'aggregate claim requires aggregate type');
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_aggregate_batch('commerce_order', NULL, ARRAY['commerce.order.paid.email']) $$,
  '22023', 'outbox_claim_aggregate_scope_required', 'aggregate claim requires aggregate id');
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_claim_aggregate_batch('commerce_order', 'bb300000-0000-0000-0000-000000000001', ARRAY[]::text[]) $$,
  '22023', 'outbox_claim_allowlist_required', 'aggregate claim requires event allowlist');

INSERT INTO public.outbox_events (id, created_at, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('a3000000-0000-0000-0000-000000000001', now() - interval '4 minutes', 'commerce_order', 'bb300000-0000-0000-0000-000000000001', 'commerce.order.paid',       'aggregate-paid-fulfillment-1', '{}'::jsonb),
  ('a3000000-0000-0000-0000-000000000002', now() - interval '3 minutes', 'commerce_order', 'bb300000-0000-0000-0000-000000000001', 'commerce.order.paid.email', 'aggregate-paid-email-1', '{}'::jsonb),
  ('a3000000-0000-0000-0000-000000000003', now() - interval '2 minutes', 'commerce_order', 'bb300000-0000-0000-0000-000000000001', 'commerce.order.paid.email', 'aggregate-paid-email-2', '{}'::jsonb),
  ('a3000000-0000-0000-0000-000000000004', now() - interval '1 minute',  'commerce_order', 'bb300000-0000-0000-0000-000000000002', 'commerce.order.paid.email', 'aggregate-paid-email-other', '{}'::jsonb);

INSERT INTO public.outbox_events (
  id, aggregate_type, aggregate_id, event_type, idempotency_key, status, attempts, available_at, payload, metadata
) VALUES (
  'a3000000-0000-0000-0000-000000000005',
  'commerce_order',
  'bb300000-0000-0000-0000-000000000003',
  'commerce.order.paid.email',
  'aggregate-outside-scope-expired',
  'failed',
  1,
  now() - interval '1 second',
  '{}'::jsonb,
  jsonb_build_object('resendIdempotencyStartedAt', now() - interval '24 hours')
);

CREATE TEMP TABLE _aggregate_paid_1 AS
SELECT * FROM public.outbox_claim_aggregate_batch(
  p_aggregate_type := 'commerce_order',
  p_aggregate_id := 'bb300000-0000-0000-0000-000000000001',
  p_event_types := ARRAY['commerce.order.paid.email'],
  p_batch_size := 10,
  p_visibility_seconds := 300,
  p_max_attempts := 8);
SELECT is((SELECT count(*)::int FROM _aggregate_paid_1), 1,
  'aggregate claim returns one ready email row for the requested aggregate');
SELECT is((SELECT id::text FROM _aggregate_paid_1), 'a3000000-0000-0000-0000-000000000002',
  'aggregate claim preserves allowlisted per-aggregate ordering');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a3000000-0000-0000-0000-000000000001'),
  'pending', 'aggregate claim does not claim or block on non-allowlisted fulfillment rows');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a3000000-0000-0000-0000-000000000003'),
  'pending', 'aggregate claim leaves the younger allowlisted sibling pending while older is processing');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a3000000-0000-0000-0000-000000000004'),
  'pending', 'aggregate claim does not claim a different aggregate');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'a3000000-0000-0000-0000-000000000005'),
  'failed', 'aggregate provider-window recovery does not mutate another aggregate');
SELECT is((SELECT metadata->>'claimScope' FROM public.outbox_events WHERE id = 'a3000000-0000-0000-0000-000000000002'),
  'aggregate_immediate', 'aggregate claim stamps its immediate-dispatch scope');
SELECT is((SELECT count(*)::int FROM public.outbox_claim_aggregate_batch(
    p_aggregate_type := 'commerce_order',
    p_aggregate_id := 'bb300000-0000-0000-0000-000000000001',
    p_event_types := ARRAY['commerce.order.paid.email'],
    p_batch_size := 10,
    p_visibility_seconds := 300,
    p_max_attempts := 8)),
  0, 'aggregate claim blocks younger allowlisted sibling while older sibling is processing');

UPDATE public.outbox_events SET status = 'processed', processed_at = now()
 WHERE id = 'a3000000-0000-0000-0000-000000000002';
SELECT is((SELECT id::text FROM public.outbox_claim_aggregate_batch(
    p_aggregate_type := 'commerce_order',
    p_aggregate_id := 'bb300000-0000-0000-0000-000000000001',
    p_event_types := ARRAY['commerce.order.paid.email'],
    p_batch_size := 10,
    p_visibility_seconds := 300,
    p_max_attempts := 8)),
  'a3000000-0000-0000-0000-000000000003',
  'aggregate claim releases the next allowlisted sibling after the older row is terminal');

SELECT ok(
  private.outbox_try_timestamptz((SELECT metadata->>'resendIdempotencyStartedAt'
    FROM public.outbox_events
   WHERE id = 'a3000000-0000-0000-0000-000000000003')) IS NOT NULL,
  'aggregate immediate claim uses the same immutable provider idempotency clock');

-- ===========================================================================
-- claim: distinct poison sweep (never the happy paid-renewal/order fixture)
-- ===========================================================================
INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, status, attempts, available_at, payload, error)
VALUES ('c0000000-0000-0000-0000-000000000001', 'test_agg', 'bb000000-0000-0000-0000-000000000003', 'test.outbox.poison', 'poison-1', 'processing', 8, now() - interval '5 minutes', '{}'::jsonb, 'handler crashed');

CREATE TEMP TABLE _p AS
SELECT * FROM public.outbox_claim_batch(ARRAY['test.outbox.poison'], 10, 300, 8);
SELECT is((SELECT count(*)::int FROM _p), 0, 'poison row is not claimed');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'c0000000-0000-0000-0000-000000000001'),
  'discarded', 'poison sweep discards the crash-looped row at the next claim');
SELECT is((SELECT metadata->>'discardReason' FROM public.outbox_events WHERE id = 'c0000000-0000-0000-0000-000000000001'),
  'max_attempts', 'sweep records discardReason=max_attempts');
SELECT ok((SELECT error LIKE '%max_attempts_exhausted_at_claim' FROM public.outbox_events WHERE id = 'c0000000-0000-0000-0000-000000000001'),
  'sweep appends the exhaustion marker to error');
SELECT is(
  (SELECT count(*)::int
     FROM public.outbox_claim_batch(ARRAY['test.outbox.poison'], 10, 300, 8)),
  0, 'a later worker pass never retries the discarded poison fixture');

-- ===========================================================================
-- mark_processed: token fencing
-- ===========================================================================
INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload)
VALUES ('d0000000-0000-0000-0000-000000000001', 'test_agg', 'bb000000-0000-0000-0000-000000000004', 'test.outbox.mark', 'mark-1', '{}'::jsonb);
CREATE TEMP TABLE _m AS
SELECT * FROM public.outbox_claim_batch(ARRAY['test.outbox.mark'], 10, 300, 8);

SELECT ok(NOT public.outbox_mark_processed('d0000000-0000-0000-0000-000000000001', 'wrong-token'),
  'mark_processed with a wrong token returns false');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'd0000000-0000-0000-0000-000000000001'),
  'processing', 'row left intact after the wrong-token mark');
SELECT ok(public.outbox_mark_processed('d0000000-0000-0000-0000-000000000001',
    (SELECT metadata->>'claimToken' FROM _m), '{"detail":"ok"}'::jsonb),
  'mark_processed with the matching token returns true');
SELECT ok((SELECT status = 'processed' AND processed_at IS NOT NULL AND error IS NULL
             FROM public.outbox_events WHERE id = 'd0000000-0000-0000-0000-000000000001'),
  'row is processed with processed_at set and error cleared');
SELECT ok(NOT public.outbox_mark_processed('d0000000-0000-0000-0000-000000000001',
    (SELECT metadata->>'claimToken' FROM _m)),
  'mark_processed applies only once (terminal status fences the second call)');

-- ===========================================================================
-- mark_failed: retry backoff / max-attempts discard / discard / snooze / missed
-- ===========================================================================
INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload) VALUES
  ('f0000000-0000-0000-0000-000000000001', 'test_agg', 'cc000000-0000-0000-0000-000000000001', 'test.outbox.fail', 'fail-1', '{}'::jsonb),
  ('f0000000-0000-0000-0000-000000000002', 'test_agg', 'cc000000-0000-0000-0000-000000000002', 'test.outbox.fail', 'fail-2', '{}'::jsonb),
  ('f0000000-0000-0000-0000-000000000003', 'test_agg', 'cc000000-0000-0000-0000-000000000003', 'test.outbox.fail', 'fail-3', '{}'::jsonb),
  ('f0000000-0000-0000-0000-000000000004', 'test_agg', 'cc000000-0000-0000-0000-000000000004', 'test.outbox.fail', 'fail-4', '{}'::jsonb),
  ('f0000000-0000-0000-0000-000000000005', 'test_agg', 'cc000000-0000-0000-0000-000000000005', 'test.outbox.fail', 'fail-5', '{}'::jsonb);
CREATE TEMP TABLE _f AS
SELECT * FROM public.outbox_claim_batch(ARRAY['test.outbox.fail'], 10, 300, 8);

-- retry at attempts=1, base 100 -> delay in [50, 100] (equal jitter)
SELECT is(public.outbox_mark_failed('f0000000-0000-0000-0000-000000000001',
    (SELECT metadata->>'claimToken' FROM _f WHERE id = 'f0000000-0000-0000-0000-000000000001'),
    'transient boom', 'retry', 100, 3600, 8, 300),
  'failed', 'retry outcome returns failed');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000001'),
  'failed', 'retried row parked as failed');
SELECT ok((SELECT available_at > now() + interval '49 seconds'
              AND available_at < now() + interval '101 seconds'
             FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000001'),
  'retry backoff lands in the [base/2, base] jitter window');

-- retry with attempts already at max -> discarded (max_attempts)
SELECT is(public.outbox_mark_failed('f0000000-0000-0000-0000-000000000002',
    (SELECT metadata->>'claimToken' FROM _f WHERE id = 'f0000000-0000-0000-0000-000000000002'),
    'still failing', 'retry', 60, 3600, 1, 300),
  'discarded', 'retry at max attempts returns discarded');
SELECT is((SELECT metadata->>'discardReason' FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000002'),
  'max_attempts', 'max-attempts discard records discardReason=max_attempts');

-- discard outcome -> permanent_error
SELECT is(public.outbox_mark_failed('f0000000-0000-0000-0000-000000000003',
    (SELECT metadata->>'claimToken' FROM _f WHERE id = 'f0000000-0000-0000-0000-000000000003'),
    'permanent parse error', 'discard'),
  'discarded', 'discard outcome returns discarded');
SELECT is((SELECT metadata->>'discardReason' FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000003'),
  'permanent_error', 'permanent discard records discardReason=permanent_error');

-- snooze -> attempt refunded + snoozeCount
SELECT is(public.outbox_mark_failed('f0000000-0000-0000-0000-000000000004',
    (SELECT metadata->>'claimToken' FROM _f WHERE id = 'f0000000-0000-0000-0000-000000000004'),
    'provider outage', 'snooze'),
  'snoozed', 'snooze outcome returns snoozed');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000004'),
  'failed', 'snoozed row parked as failed');
SELECT is((SELECT attempts FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000004'),
  0, 'snooze refunds the attempt taken at claim');
SELECT is((SELECT (metadata->>'snoozeCount')::int FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000004'),
  1, 'snooze increments snoozeCount');

-- wrong token -> 'missed', row untouched
SELECT is(public.outbox_mark_failed('f0000000-0000-0000-0000-000000000005', 'wrong-token', 'x', 'retry'),
  'missed', 'mark_failed with a wrong token returns missed');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000005'),
  'processing', 'row keeps its lease after the missed mark');

SELECT throws_ok(
  $$ SELECT public.outbox_mark_failed('f0000000-0000-0000-0000-000000000005', 'any-token', 'x', 'explode') $$,
  '22023', 'outbox_mark_failed_invalid_outcome', 'invalid outcome raises 22023');

-- ===========================================================================
-- release_unprocessed: pairwise token match + attempt refund
-- ===========================================================================
SELECT is(public.outbox_release_unprocessed(
    ARRAY['f0000000-0000-0000-0000-000000000005']::uuid[],
    ARRAY[(SELECT metadata->>'claimToken' FROM _f WHERE id = 'f0000000-0000-0000-0000-000000000005')],
    0),
  1, 'release returns the affected-row count');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000005'),
  'pending', 'released row returns to pending');
SELECT is((SELECT attempts FROM public.outbox_events WHERE id = 'f0000000-0000-0000-0000-000000000005'),
  0, 'release refunds the attempt taken at claim');

INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload)
VALUES ('ee000000-0000-0000-0000-000000000001', 'test_agg', 'cc000000-0000-0000-0000-000000000006', 'test.outbox.release', 'rel-1', '{}'::jsonb);
CREATE TEMP TABLE _r AS
SELECT * FROM public.outbox_claim_batch(ARRAY['test.outbox.release'], 10, 300, 8);
SELECT is(public.outbox_release_unprocessed(
    ARRAY['ee000000-0000-0000-0000-000000000001']::uuid[], ARRAY['wrong-token'], 0),
  0, 'release with a mismatched token releases nothing');
SELECT is((SELECT status FROM public.outbox_events WHERE id = 'ee000000-0000-0000-0000-000000000001'),
  'processing', 'row keeps its lease after the mismatched release');

SELECT throws_ok(
  $$ SELECT public.outbox_release_unprocessed(
       ARRAY['ee000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000005']::uuid[],
       ARRAY['only-one'], 0) $$,
  '22023', 'outbox_release_invalid_input', 'mismatched array lengths raise 22023');
SELECT throws_ok(
  $$ SELECT public.outbox_release_unprocessed(NULL, NULL, 0) $$,
  '22023', 'outbox_release_invalid_input', 'NULL arrays raise 22023');

-- ===========================================================================
-- claim/release: negative + out-of-range params hit the clamp floors
-- ===========================================================================
INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, payload)
VALUES ('92000000-0000-0000-0000-000000000001', 'test_agg', 'cc000000-0000-0000-0000-000000000007', 'test.outbox.clamp', 'clamp-1', '{}'::jsonb);
CREATE TEMP TABLE _cl AS
SELECT * FROM public.outbox_claim_batch(ARRAY['test.outbox.clamp'], -5, 10, 0);
SELECT is((SELECT count(*)::int FROM _cl), 1,
  'batch_size -5 and max_attempts 0 clamp up to 1 (exactly one row claimed)');
SELECT ok((SELECT available_at >= now() + interval '299 seconds'
             FROM public.outbox_events WHERE id = '92000000-0000-0000-0000-000000000001'),
  'visibility 10 clamps up to the 300 s floor');
SELECT is(public.outbox_release_unprocessed(
    ARRAY['92000000-0000-0000-0000-000000000001']::uuid[],
    ARRAY[(SELECT metadata->>'claimToken' FROM _cl)], -1),
  1, 'release with a negative delay succeeds');
SELECT ok((SELECT available_at <= now() + interval '1 second'
             FROM public.outbox_events WHERE id = '92000000-0000-0000-0000-000000000001'),
  'negative release delay clamps to the 0 floor (row immediately available)');

-- ===========================================================================
-- requeue_discarded: filter mandatory, discarded-only, guard, audit trail
-- ===========================================================================
SELECT throws_ok(
  $$ SELECT * FROM public.outbox_requeue_discarded() $$,
  '22023', 'outbox_requeue_filter_required', 'requeue without any filter raises 22023');

INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, status, attempts, payload, error) VALUES
  ('90000000-0000-0000-0000-000000000001', 'test_agg', 'dd000000-0000-0000-0000-000000000001', 'test.outbox.requeue', 'rq-1', 'discarded',  5, '{}'::jsonb, 'old error'),
  ('90000000-0000-0000-0000-000000000002', 'test_agg', 'dd000000-0000-0000-0000-000000000002', 'test.outbox.requeue', 'rq-2', 'failed',     3, '{}'::jsonb, 'still failing'),
  ('90000000-0000-0000-0000-000000000003', 'test_agg', 'dd000000-0000-0000-0000-000000000003', 'test.outbox.requeue', 'rq-3', 'discarded',  4, '{}'::jsonb, 'guarded'),
  ('90000000-0000-0000-0000-000000000004', 'test_agg', 'dd000000-0000-0000-0000-000000000003', 'test.outbox.requeue', 'rq-4', 'processing', 1, '{}'::jsonb, NULL);

CREATE TEMP TABLE _rq AS
SELECT * FROM public.outbox_requeue_discarded(NULL, 'test.outbox.requeue', 100, 'pgtap', 'replay test');
SELECT is((SELECT count(*)::int FROM _rq), 1, 'only the unguarded discarded row is requeued');
SELECT is((SELECT status FROM public.outbox_events WHERE id = '90000000-0000-0000-0000-000000000001'),
  'pending', 'requeued row returns to pending');
SELECT is((SELECT attempts FROM public.outbox_events WHERE id = '90000000-0000-0000-0000-000000000001'),
  0, 'requeue resets attempts to 0');
SELECT ok((SELECT error IS NULL FROM public.outbox_events WHERE id = '90000000-0000-0000-0000-000000000001'),
  'requeue clears the error');
SELECT is((SELECT jsonb_array_length(metadata->'requeues') FROM public.outbox_events WHERE id = '90000000-0000-0000-0000-000000000001'),
  1, 'a requeues audit entry is appended');
SELECT is((SELECT metadata#>>'{requeues,0,previousAttempts}' FROM public.outbox_events WHERE id = '90000000-0000-0000-0000-000000000001'),
  '5', 'the audit entry records previousAttempts');
SELECT is((SELECT metadata#>>'{requeues,0,previousError}' FROM public.outbox_events WHERE id = '90000000-0000-0000-0000-000000000001'),
  'old error', 'the audit entry records previousError');
SELECT is((SELECT status FROM public.outbox_events WHERE id = '90000000-0000-0000-0000-000000000003'),
  'discarded', 'the processing-same-aggregate guard skips the requeue');
SELECT is((SELECT status FROM public.outbox_events WHERE id = '90000000-0000-0000-0000-000000000002'),
  'failed', 'non-discarded rows are never touched by requeue');

-- ===========================================================================
-- queue_stats: keys, expired-processing stall detection, malformed discardedAt
-- ===========================================================================
INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, status, available_at, payload) VALUES
  ('91000000-0000-0000-0000-000000000001', 'test_agg', 'dd000000-0000-0000-0000-000000000004', 'test.outbox.stats', 'st-1', 'processing', now() - interval '2 hours', '{}'::jsonb);
INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, status, payload, metadata) VALUES
  ('91000000-0000-0000-0000-000000000002', 'test_agg', 'dd000000-0000-0000-0000-000000000005', 'test.outbox.stats', 'st-2', 'discarded', '{}'::jsonb, jsonb_build_object('discardedAt', 'not-a-timestamp'));

SELECT lives_ok(
  $$ SELECT public.outbox_queue_stats() $$,
  'queue_stats survives a malformed metadata discardedAt value');

CREATE TEMP TABLE _stats AS SELECT public.outbox_queue_stats() AS s;
SELECT ok((SELECT s ?& ARRAY['pending','processing','processed','failed','discarded','oldestClaimableSeconds','discardedLast24h'] FROM _stats),
  'queue_stats returns all expected keys');
SELECT ok((SELECT (s->>'oldestClaimableSeconds')::bigint >= 7200 FROM _stats),
  'an expired processing row is counted in oldestClaimableSeconds');
SELECT ok((SELECT (s->>'discardedLast24h')::int >= 1 FROM _stats),
  'discardedLast24h counts well-formed recent discards');

-- ===========================================================================
-- prune: disabled-by-default control row + service-role RPC contract
-- ===========================================================================
INSERT INTO public.outbox_events (id, created_at, processed_at, aggregate_type, aggregate_id, event_type, idempotency_key, status, payload, metadata) VALUES
  ('93000000-0000-0000-0000-000000000001', now() - interval '100 days', now() - interval '40 days', 'test_agg', 'ee000000-0000-0000-0000-000000000001', 'test.outbox.prune', 'prune-processed', 'processed', '{"kept":"until-compaction"}'::jsonb, '{}'::jsonb),
  ('93000000-0000-0000-0000-000000000002', now() - interval '100 days', NULL, 'test_agg', 'ee000000-0000-0000-0000-000000000002', 'test.outbox.prune', 'prune-discarded-missing', 'discarded', '{"kept":"missing-discarded-at"}'::jsonb, '{}'::jsonb),
  ('93000000-0000-0000-0000-000000000003', now() - interval '100 days', NULL, 'test_agg', 'ee000000-0000-0000-0000-000000000003', 'test.outbox.prune', 'prune-discarded-old', 'discarded', '{"kept":"until-compaction"}'::jsonb, jsonb_build_object('discardedAt', now() - interval '100 days')),
  ('93000000-0000-0000-0000-000000000004', now() - interval '100 days', NULL, 'test_agg', 'ee000000-0000-0000-0000-000000000004', 'test.outbox.prune', 'prune-discarded-malformed', 'discarded', '{"kept":"malformed-discarded-at"}'::jsonb, jsonb_build_object('discardedAt', '2026-not-a-timestamp'));

CREATE TEMP TABLE _prune AS
SELECT public.outbox_prune(now() - interval '30 days', now() - interval '90 days', 10) AS result;

SELECT is((SELECT (result->>'compacted')::int FROM _prune), 2,
  'outbox_prune compacts old terminal rows while preserving idempotency keys');
SELECT is((SELECT (result->>'processed')::int FROM _prune), 1,
  'outbox_prune reports the processed compaction count');
SELECT is((SELECT (result->>'discarded')::int FROM _prune), 1,
  'outbox_prune reports the discarded compaction count');
SELECT ok((SELECT EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE id = '93000000-0000-0000-0000-000000000001'
       AND payload = '{}'::jsonb
       AND metadata ? 'retentionCompactedAt')),
  'outbox_prune preserves the processed outbox row for idempotency history');
SELECT ok((SELECT EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE id = '93000000-0000-0000-0000-000000000003'
       AND payload = '{}'::jsonb
       AND metadata ? 'retentionCompactedAt')),
  'outbox_prune compacts discarded rows with a valid old discardedAt timestamp');
SELECT ok((SELECT NOT EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE id = '93000000-0000-0000-0000-000000000002'
       AND metadata ? 'retentionCompactedAt')),
  'outbox_prune does not compact discarded rows without a valid old discardedAt timestamp');
SELECT ok((SELECT NOT EXISTS (
    SELECT 1 FROM public.outbox_events
     WHERE id = '93000000-0000-0000-0000-000000000004'
       AND metadata ? 'retentionCompactedAt')),
  'outbox_prune survives and skips malformed discardedAt timestamps');
SELECT ok(EXISTS (
    SELECT 1 FROM public.platform_job_controls
     WHERE job_name = 'outbox-prune'
       AND enabled = false
       AND active_driver = 'vercel_cron'),
  'outbox-prune control row is seeded disabled with the vercel_cron driver');

-- ===========================================================================
-- grants: anon + authenticated must lack EXECUTE on all outbox functions
-- ===========================================================================
SELECT ok(
  NOT (
       has_function_privilege('anon', 'public.outbox_claim_batch(text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_claim_batch_v2(text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_claim_batch_v3(text[],text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_claim_aggregate_batch(text,uuid,text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_claim_preview_matrix_batch(text,text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_mark_processed(uuid,text,jsonb)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_mark_failed(uuid,text,text,text,integer,integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_release_unprocessed(uuid[],text[],integer)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_requeue_discarded(uuid[],text,integer,text,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_queue_stats()', 'EXECUTE')
    OR has_function_privilege('anon', 'private.outbox_try_timestamptz(text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.outbox_prune(timestamptz,timestamptz,integer)', 'EXECUTE')
  ),
  'anon lacks EXECUTE on all outbox dispatch functions');
SELECT ok(
  NOT (
       has_function_privilege('authenticated', 'public.outbox_claim_batch(text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_claim_batch_v2(text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_claim_batch_v3(text[],text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_claim_aggregate_batch(text,uuid,text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_claim_preview_matrix_batch(text,text[],integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_mark_processed(uuid,text,jsonb)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_mark_failed(uuid,text,text,text,integer,integer,integer,integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_release_unprocessed(uuid[],text[],integer)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_requeue_discarded(uuid[],text,integer,text,text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_queue_stats()', 'EXECUTE')
    OR has_function_privilege('authenticated', 'private.outbox_try_timestamptz(text)', 'EXECUTE')
    OR has_function_privilege('authenticated', 'public.outbox_prune(timestamptz,timestamptz,integer)', 'EXECUTE')
  ),
  'authenticated lacks EXECUTE on all outbox dispatch functions');

-- ===========================================================================
-- platform_job_controls seed (R-3): ENABLED-by-default posture + vercel_cron pin
-- ===========================================================================
-- The activation migration (20260710120000_outbox_dispatch_enable) flips the
-- seed enabled=true so production go-live needs no manual toggle; the env var
-- COMMERCE_OUTBOX_DISPATCH_ENABLED is the only opt-out (kill-switch).
SELECT ok(EXISTS (
    SELECT 1 FROM public.platform_job_controls
     WHERE job_name = 'outbox-dispatch'
       AND enabled = true
       AND active_driver = 'vercel_cron'),
  'outbox-dispatch control row seeded enabled (activation migration) with the vercel_cron driver');

-- Kill-switch path: a disabled row skips as job_disabled (no lease yet to mask it).
UPDATE public.platform_job_controls SET enabled = false
 WHERE job_name = 'outbox-dispatch';
CREATE TEMP TABLE _job AS
SELECT * FROM public.platform_claim_job_run('outbox-dispatch', 'vercel_cron', 120, '{}'::jsonb);
SELECT ok(NOT (SELECT acquired FROM _job),
  'kill-switched outbox-dispatch claim does not acquire');
SELECT is((SELECT reason FROM _job),
  'job_disabled', 'disabled control row skips as job_disabled (kill-switch posture pinned)');

-- Re-enable: only an ACQUIRED vercel_cron claim pins the seed driver (a row
-- mis-seeded active_driver='pg_cron' would also have skipped as job_disabled
-- above — the enabled check precedes the driver check in platform_claim_job_run).
UPDATE public.platform_job_controls SET enabled = true
 WHERE job_name = 'outbox-dispatch';
CREATE TEMP TABLE _job2 AS
SELECT * FROM public.platform_claim_job_run('outbox-dispatch', 'vercel_cron', 120, '{}'::jsonb);
SELECT ok((SELECT acquired FROM _job2),
  'enabled outbox-dispatch claim acquires for vercel_cron (seed driver pinned)');
-- Driver mismatch is checked BEFORE the active lease in platform_claim_job_run,
-- so the lease taken by _job2 does not mask the inactive_driver reason.
CREATE TEMP TABLE _job3 AS
SELECT * FROM public.platform_claim_job_run('outbox-dispatch', 'pg_cron', 120, '{}'::jsonb);
SELECT ok(NOT (SELECT acquired FROM _job3),
  'pg_cron claim against the vercel_cron row does not acquire');
SELECT is((SELECT reason FROM _job3),
  'inactive_driver', 'pg_cron claim is refused as inactive_driver (wrong-driver posture pinned)');

-- Worker cutover path: the migration only teaches the shared ledger about the
-- worker driver. Operators still switch the row explicitly after staging
-- evidence; once switched, the same job lease fences cron as the inactive
-- driver.
UPDATE public.platform_job_controls
   SET active_driver = 'worker',
       lease_token = NULL,
       lease_until = NULL,
       lease_expires_at = NULL
 WHERE job_name = 'outbox-dispatch';
CREATE TEMP TABLE _job4 AS
SELECT * FROM public.platform_claim_job_run('outbox-dispatch', 'worker', 120, '{}'::jsonb);
SELECT ok((SELECT acquired FROM _job4),
  'enabled outbox-dispatch claim acquires for worker after explicit control-row cutover');
CREATE TEMP TABLE _job5 AS
SELECT * FROM public.platform_claim_job_run('outbox-dispatch', 'vercel_cron', 120, '{}'::jsonb);
SELECT ok(NOT (SELECT acquired FROM _job5),
  'vercel_cron claim against the worker row does not acquire');
SELECT is((SELECT reason FROM _job5),
  'inactive_driver', 'vercel_cron claim is refused as inactive_driver after worker cutover');

SELECT * FROM finish();
ROLLBACK;
