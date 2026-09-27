-- pgTAP: subscription dunning DISPATCH claim/mark RPCs (20260616140000).
--   * subscription_dunning_claim_batch leases a due customer notification
--     (queued, scheduled_at<=now), flipping it to 'sending' + send_attempts=1;
--   * a 'sending' row is NOT re-claimed within the lease, but mark_result('queued')
--     re-queues it and the next claim bumps send_attempts to 2;
--   * provider success plus a failed mark_sent is repaired from the one dunning
--     email_sends identity before lease reclaim;
--   * stale retries outside Resend's idempotency retention stop for manual review;
--   * mark_result rejects an invalid status;
--   * W10 (20260729190408): the claim RPC's manual-review terminalization also
--     reaches an already-LEASED row, even though that system writer sets no
--     claim-token GUC, while a stale worker still cannot skip or complete it.
--
-- The customer notification is minted naturally via
-- subscription_handle_payment_failure_dunning (open case) so the row shape is real.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(40);

INSERT INTO public.clients (id, email)
VALUES ('d4000000-0000-0000-0000-000000000001', 'dunning-dispatch@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('d4100000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001', 30, 'PLN', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');
INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('d41c0000-0000-0000-0000-000000000001', 'd4100000-0000-0000-0000-000000000001', 2, '2026-06-01T00:00:00Z', 'planned', 'dunning-dispatch-open', 1);
INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('d41d0000-0000-0000-0000-000000000001', 'd4000000-0000-0000-0000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 12999, 12999, 'subscription_cycle',
        'd4100000-0000-0000-0000-000000000001', 'd41c0000-0000-0000-0000-000000000001');

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'dunning-dispatch-intent', 'subscription_cycle', 'd41d0000-0000-0000-0000-000000000001',
  'd4100000-0000-0000-0000-000000000001', 'd41c0000-0000-0000-0000-000000000001', 12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

-- open case + a queued customer 'payment_failed' notification (retry 1).
SELECT public.subscription_handle_payment_failure_dunning(
  'dunning-dispatch-case',
  'd41c0000-0000-0000-0000-000000000001',
  'd4100000-0000-0000-0000-000000000001',
  'd41d0000-0000-0000-0000-000000000001',
  (SELECT intent_id FROM _intent),
  1, '2026-06-20T00:00:00Z'::timestamptz, 'card_declined', '2026-06-12T12:00:00Z'::timestamptz
);

CREATE TEMP TABLE _notif AS
SELECT id FROM public.subscription_dunning_notifications
 WHERE recipient_kind = 'customer'
 ORDER BY created_at
 LIMIT 1;

-- 1: claim leases exactly the one due customer notification.
CREATE TEMP TABLE _initial_claim AS
SELECT * FROM public.subscription_dunning_claim_batch(25, 300, 6);
SELECT is(
  (SELECT count(*)::int FROM _initial_claim),
  1, 'claim_batch leases the one due customer notification');

-- 2: it is now 'sending' with send_attempts = 1, an immutable provider clock,
-- and the same current fencing token returned by the claim RPC.
SELECT ok(
  (SELECT status = 'sending'
      AND send_attempts = 1
      AND resend_idempotency_started_at IS NOT NULL
      AND coalesce(payload->>'claimToken', '') <> ''
      AND payload->>'claimToken' = (
        SELECT payload->>'claimToken' FROM _initial_claim
      )
     FROM public.subscription_dunning_notifications
    WHERE id = (SELECT id FROM _notif)),
  'fresh claim returns the provider clock and new lease-fencing token stored on the row');

CREATE TEMP TABLE _first_claim AS
SELECT resend_idempotency_started_at, payload->>'claimToken' AS claim_token
  FROM _initial_claim;

-- 3: a fresh 'sending' row is NOT re-claimed within the lease.
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_claim_batch(25, 300, 6)),
  0, 'a fresh sending row is not re-claimed within the lease');

-- 4: mark_result requeues it with backoff.
SELECT public.subscription_dunning_mark_result(
  (SELECT id FROM _notif),
  (SELECT claim_token FROM _first_claim),
  'queued',
  'resend_unavailable',
  now() + interval '1 hour'
);
SELECT ok(
  (SELECT status = 'queued'
      AND scheduled_at > now() + interval '55 minutes'
      AND payload->>'claimToken' = (SELECT claim_token FROM _first_claim)
     FROM public.subscription_dunning_notifications
    WHERE id = (SELECT id FROM _notif)),
  'mark_result requeues with backoff without rotating the claim token');

-- 5: the future-scheduled row is not reclaimed immediately.
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_claim_batch(25, 300, 6)),
  0, 'a backoff-queued row is not immediately re-claimed');

UPDATE public.subscription_dunning_notifications
   SET scheduled_at = now() - interval '1 second'
 WHERE id = (SELECT id FROM _notif);

-- 6: once due again, the next claim bumps send_attempts to 2.
CREATE TEMP TABLE _second_claim AS
SELECT * FROM public.subscription_dunning_claim_batch(25, 300, 6);
SELECT is(
  (SELECT send_attempts FROM _second_claim),
  2, 're-queued row re-claims with send_attempts=2');

-- 7: a lease/requeue updates updated_at but cannot reset the provider clock.
SELECT is(
  (SELECT resend_idempotency_started_at::text FROM public.subscription_dunning_notifications
    WHERE id = (SELECT id FROM _notif)),
  (SELECT resend_idempotency_started_at::text FROM _first_claim),
  'reclaims preserve the first provider idempotency timestamp despite updated_at changes');

-- 8-11: a stale sending lease is taken over with a fresh token. The prior
-- worker cannot terminalize or requeue the row after takeover.
UPDATE public.subscription_dunning_notifications
   SET updated_at = now() - interval '6 minutes'
 WHERE id = (SELECT id FROM _notif);
CREATE TEMP TABLE _stale_takeover AS
SELECT * FROM public.subscription_dunning_claim_batch(25, 300, 6);
SELECT is(
  (SELECT status || ':' || send_attempts::text FROM _stale_takeover),
  'sending:3', 'a stale sending lease is taken over and increments attempts');
SELECT isnt(
  (SELECT payload->>'claimToken' FROM _stale_takeover),
  (SELECT payload->>'claimToken' FROM _second_claim),
  'stale-lease takeover mints a fresh fencing token');
SELECT is(
  public.subscription_dunning_mark_result(
    (SELECT id FROM _notif),
    (SELECT payload->>'claimToken' FROM _second_claim),
    'failed',
    'stale worker result',
    NULL
  ),
  false, 'a stale worker result is rejected by the claim-token fence');
SELECT is(
  public.subscription_dunning_mark_sent(
    (SELECT id FROM _notif),
    (SELECT payload->>'claimToken' FROM _second_claim),
    'stale-delivery-id'
  ),
  false, 'a stale worker sent mark is rejected by the claim-token fence');
SELECT is(
  (SELECT status || '|' || (payload->>'claimToken')
     FROM public.subscription_dunning_notifications
    WHERE id = (SELECT id FROM _notif)),
  (SELECT 'sending|' || (payload->>'claimToken') FROM _stale_takeover),
  'the current takeover lease remains unchanged after the stale mark');

-- 12-14: every transitional pre-fence overload is incapable of mutating a row
-- claimed with the new token. This keeps rollout compatibility from becoming a
-- service-role bypass if an older worker finishes after the migration lands.
SELECT public.subscription_dunning_mark_sent(
  (SELECT id FROM _notif),
  'legacy-delivery-id'
);
SELECT is(
  (SELECT status || '|' || (payload->>'claimToken')
     FROM public.subscription_dunning_notifications
    WHERE id = (SELECT id FROM _notif)),
  (SELECT 'sending|' || (payload->>'claimToken') FROM _stale_takeover),
  'legacy mark_sent cannot terminalize a newly tokened sending row');

SELECT public.subscription_dunning_mark_result(
  p_id => (SELECT id FROM _notif),
  p_status => 'failed',
  p_error => 'legacy four-argument result',
  p_reschedule_at => NULL
);
SELECT is(
  (SELECT status || '|' || (payload->>'claimToken')
     FROM public.subscription_dunning_notifications
    WHERE id = (SELECT id FROM _notif)),
  (SELECT 'sending|' || (payload->>'claimToken') FROM _stale_takeover),
  'legacy four-argument mark_result cannot mutate a newly tokened sending row');

SELECT public.subscription_dunning_mark_result(
  (SELECT id FROM _notif),
  'failed',
  'legacy three-argument result'
);
SELECT is(
  (SELECT status || '|' || (payload->>'claimToken')
     FROM public.subscription_dunning_notifications
    WHERE id = (SELECT id FROM _notif)),
  (SELECT 'sending|' || (payload->>'claimToken') FROM _stale_takeover),
  'legacy three-argument mark_result cannot mutate a newly tokened sending row');

-- 15: a legacy worker can still complete a genuinely pre-fence tokenless row;
-- the wrapper first gives it a one-use token and delegates to the strict mark.
INSERT INTO public.subscription_dunning_notifications (
  id, case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  idempotency_key, status, scheduled_at, recovery_url_path, payload,
  created_at, updated_at, send_attempts
)
SELECT
  'd4000000-0000-0000-0000-000000000003'::uuid,
  case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  'dunning-legacy-tokenless-test', 'sending', scheduled_at, recovery_url_path,
  coalesce(payload, '{}'::jsonb) - 'claimToken',
  now(), now(), 1
FROM public.subscription_dunning_notifications
WHERE id = (SELECT id FROM _notif);
SELECT public.subscription_dunning_mark_result(
  'd4000000-0000-0000-0000-000000000003'::uuid,
  'queued',
  'legacy tokenless result',
  now() + interval '1 hour'
);
SELECT is(
  (SELECT status FROM public.subscription_dunning_notifications
    WHERE id = 'd4000000-0000-0000-0000-000000000003'::uuid),
  'queued',
  'legacy mark_result delegates successfully for a pre-fence tokenless row');

INSERT INTO public.subscription_dunning_notifications (
  id, case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  idempotency_key, status, scheduled_at, recovery_url_path, payload,
  created_at, updated_at, send_attempts
)
SELECT
  'd4000000-0000-0000-0000-000000000004'::uuid,
  case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  'dunning-legacy-tokenless-sent-test', 'sending', scheduled_at, recovery_url_path,
  coalesce(payload, '{}'::jsonb) - 'claimToken',
  now(), now(), 1
FROM public.subscription_dunning_notifications
WHERE id = (SELECT id FROM _notif);
SELECT public.subscription_dunning_mark_sent(
  'd4000000-0000-0000-0000-000000000004'::uuid,
  'legacy-delivery-id'
);
SELECT is(
  (SELECT status FROM public.subscription_dunning_notifications
    WHERE id = 'd4000000-0000-0000-0000-000000000004'::uuid),
  'sent',
  'legacy mark_sent succeeds for a pre-fence tokenless row');

INSERT INTO public.subscription_dunning_notifications (
  id, case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  idempotency_key, status, scheduled_at, recovery_url_path, payload,
  created_at, updated_at, send_attempts
)
SELECT
  'd4000000-0000-0000-0000-000000000005'::uuid,
  case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  'dunning-service-role-token-test', 'sending', scheduled_at, recovery_url_path,
  jsonb_set(coalesce(payload, '{}'::jsonb), '{claimToken}', '"service-role-token"', true),
  now(), now(), 1
FROM public.subscription_dunning_notifications
WHERE id = (SELECT id FROM _notif);
SET LOCAL ROLE service_role;
SELECT public.subscription_dunning_mark_result(
  'd4000000-0000-0000-0000-000000000005'::uuid,
  'service-role-token',
  'skipped',
  'service role invoker proof',
  NULL
);
RESET ROLE;
SELECT ok(
  (SELECT status = 'skipped'
      AND coalesce(
        current_setting('app.subscription_dunning_claim_token', true),
        ''
      ) = ''
     FROM public.subscription_dunning_notifications
    WHERE id = 'd4000000-0000-0000-0000-000000000005'::uuid),
  'service_role applies a strict token-fenced result and clears its transaction marker');

INSERT INTO public.subscription_dunning_notifications (
  id, case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  idempotency_key, status, scheduled_at, recovery_url_path, payload,
  created_at, updated_at, send_attempts
)
SELECT
  'd4000000-0000-0000-0000-000000000006'::uuid,
  case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  'dunning-service-role-sent-test', 'sending', scheduled_at, recovery_url_path,
  jsonb_set(coalesce(payload, '{}'::jsonb), '{claimToken}', '"service-role-sent-token"', true),
  now(), now(), 1
FROM public.subscription_dunning_notifications
WHERE id = (SELECT id FROM _notif);
SET LOCAL ROLE service_role;
SELECT public.subscription_dunning_mark_sent(
  'd4000000-0000-0000-0000-000000000006'::uuid,
  'service-role-sent-token',
  'strict-delivery-id'
);
RESET ROLE;
SELECT ok(
  (SELECT status = 'sent'
      AND coalesce(
        current_setting('app.subscription_dunning_claim_token', true),
        ''
      ) = ''
     FROM public.subscription_dunning_notifications
    WHERE id = 'd4000000-0000-0000-0000-000000000006'::uuid),
  'service_role applies a strict token-fenced sent mark and clears its transaction marker');

-- 18-19: a cached provider success writes one stable dunning ledger identity.
SELECT public.subscription_dunning_record_email_attempt(
  (SELECT template_slug FROM public.subscription_dunning_notifications WHERE id = (SELECT id FROM _notif)),
  (SELECT id FROM _notif),
  're_dunning_1',
  'sent',
  now(),
  NULL,
  jsonb_build_object('id', 're_dunning_1', 'notificationId', 'wrong-value')
);
SELECT public.subscription_dunning_record_email_attempt(
  (SELECT template_slug FROM public.subscription_dunning_notifications WHERE id = (SELECT id FROM _notif)),
  (SELECT id FROM _notif),
  're_dunning_1',
  'sent',
  now(),
  NULL,
  jsonb_build_object('id', 're_dunning_1')
);
SELECT is(
  (SELECT count(*)::int
     FROM public.email_sends
    WHERE source = 'subscription-dunning-dispatch'
      AND provider_response->>'notificationId' = (SELECT id::text FROM _notif)),
  1, 'cached provider successes converge on one dunning email_sends row');

SELECT is(
  (SELECT provider_response->>'notificationId'
     FROM public.email_sends
    WHERE source = 'subscription-dunning-dispatch'
      AND provider_response->>'notificationId' = (SELECT id::text FROM _notif)),
  (SELECT id::text FROM _notif), 'dunning ledger owns the notification identity');

-- 20-21: model a provider success followed by a failed mark_sent. Once the lease
-- expires, claim_batch repairs the row from email_sends instead of returning it
-- for another Resend POST.
UPDATE public.subscription_dunning_notifications
   SET updated_at = now() - interval '6 minutes'
 WHERE id = (SELECT id FROM _notif);
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_claim_batch(25, 300, 6)),
  0, 'lease reclaim does not re-send a notification with durable provider success');
SELECT is(
  (SELECT status || '|' || resend_id || '|' || (sent_at IS NOT NULL)::text
      || '|' || (payload->>'claimToken')
     FROM public.subscription_dunning_notifications WHERE id = (SELECT id FROM _notif)),
  (SELECT 'sent|re_dunning_1|true|' || (payload->>'claimToken') FROM _stale_takeover),
  'lease recovery marks sent from its ledger row without rotating the claim token');

-- 22: a sent row is never re-claimed.
SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_claim_batch(25, 300, 6)),
  0, 'a sent row is never re-claimed');

-- 23-24: a previous ambiguous attempt outside the provider's 24 hour retention
-- window becomes visible manual-review work, never a new automatic POST.
INSERT INTO public.subscription_dunning_notifications (
  id, case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  idempotency_key, status, scheduled_at, recovery_url_path, payload, created_at, updated_at, send_attempts,
  resend_idempotency_started_at
)
SELECT
  'd4000000-0000-0000-0000-000000000002'::uuid,
  case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  'dunning-retention-window-test', 'queued', now() - interval '24 hours',
  recovery_url_path, payload, now() - interval '24 hours', now(), 1, now() - interval '24 hours'
FROM public.subscription_dunning_notifications
WHERE id = (SELECT id FROM _notif);

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_claim_batch(25, 300, 6)),
  0, 'an ambiguous dunning retry older than the provider window is not auto-claimed');
SELECT is(
  (SELECT status || '|' || provider_error
     FROM public.subscription_dunning_notifications
    WHERE id = 'd4000000-0000-0000-0000-000000000002'::uuid),
  'failed|resend_idempotency_window_expired_manual_review',
  'expired provider idempotency retention becomes explicit manual-review work');

SELECT ok(
  to_regclass('public.idx_email_sends_dunning_notification_identity') IS NOT NULL,
  'dunning ledger identity index bounds per-claim repair to the candidate notification');

-- 26-28: the helper and mark signatures stay non-browser, invoker-only
-- service-role boundaries.
SELECT ok(
  NOT has_function_privilege('anon', 'public.subscription_dunning_stamp_claim_token()', 'EXECUTE')
  AND NOT has_function_privilege(
    'authenticated',
    'public.subscription_dunning_stamp_claim_token()',
    'EXECUTE'
  ),
  'claim-token trigger helper is not invocable by anon or authenticated');
SELECT ok(
  (SELECT bool_and(NOT function_row.prosecdef)
     FROM pg_proc function_row
    WHERE function_row.oid = ANY (ARRAY[
      'public.subscription_dunning_stamp_claim_token()'::regprocedure,
      'public.subscription_dunning_mark_sent(uuid,text,text)'::regprocedure,
      'public.subscription_dunning_mark_result(uuid,text,text,text,timestamptz)'::regprocedure
    ])),
  'dunning trigger and mark functions all use invoker privileges');
SELECT ok(
  (SELECT bool_and(
      has_function_privilege('service_role', function_row.oid, 'EXECUTE')
      AND NOT has_function_privilege('anon', function_row.oid, 'EXECUTE')
      AND NOT has_function_privilege('authenticated', function_row.oid, 'EXECUTE')
    )
     FROM pg_proc function_row
    WHERE function_row.oid = ANY (ARRAY[
      'public.subscription_dunning_mark_sent(uuid,text)'::regprocedure,
      'public.subscription_dunning_mark_sent(uuid,text,text)'::regprocedure,
      'public.subscription_dunning_mark_result(uuid,text,text)'::regprocedure,
      'public.subscription_dunning_mark_result(uuid,text,text,timestamptz)'::regprocedure,
      'public.subscription_dunning_mark_result(uuid,text,text,text,timestamptz)'::regprocedure
    ])),
  'every dunning mark signature is executable only by service_role');

-- 29: mark_result rejects an invalid status.
SELECT throws_ok(
  $$ SELECT public.subscription_dunning_mark_result(
       'd4000000-0000-0000-0000-000000000001',
       'claim-token',
       'bogus',
       NULL,
       NULL
     ) $$,
  '23514',
  NULL,
  'mark_result rejects an invalid status with check_violation');

-- 30-33 (W10): the lease fence must not swallow the SYSTEM writer that routes an
-- attempt outside the provider's idempotency retention to manual review. That
-- writer is a bulk UPDATE inside claim_batch, so it never sets the claim-token
-- GUC; before the fix it silently RETURN OLD'd on every 'sending' row, leaving it
-- leased and circling through stale-lease takeovers forever instead of becoming
-- visible manual-review work. The row below is leased by the REAL claim RPC, so
-- it carries a genuine minted token.
INSERT INTO public.subscription_dunning_notifications (
  id, case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  idempotency_key, status, scheduled_at, recovery_url_path, payload,
  created_at, updated_at, send_attempts
)
SELECT
  'd4000000-0000-0000-0000-000000000007'::uuid,
  case_id, subscription_id, cycle_id, order_id, payment_intent_id,
  recipient_kind, recipient_ref, notification_kind, template_slug, retry_attempt,
  'dunning-system-manual-review-test', 'queued', now() - interval '1 second',
  recovery_url_path, coalesce(payload, '{}'::jsonb) - 'claimToken',
  now(), now(), 0
FROM public.subscription_dunning_notifications
WHERE id = (SELECT id FROM _notif);

CREATE TEMP TABLE _system_claim AS
SELECT * FROM public.subscription_dunning_claim_batch(25, 300, 6);
SELECT is(
  (SELECT status || '|' || (coalesce(payload->>'claimToken', '') <> '')::text
     FROM public.subscription_dunning_notifications
    WHERE id = 'd4000000-0000-0000-0000-000000000007'::uuid),
  'sending|true',
  'W10: the real claim RPC leases the new row with a genuinely minted token');

-- The newly permitted terminal statuses are NOT a blanket opening: a stale worker
-- carrying its own error text still cannot terminalize or complete the row.
SELECT public.subscription_dunning_mark_result(
  'd4000000-0000-0000-0000-000000000007'::uuid,
  'skipped',
  'stale worker skip'
);
SELECT is(
  (SELECT status || '|' || (payload->>'claimToken')
     FROM public.subscription_dunning_notifications
    WHERE id = 'd4000000-0000-0000-0000-000000000007'::uuid),
  (SELECT 'sending|' || (payload->>'claimToken') FROM _system_claim),
  'W10: a stale worker skip with its own error text is still fenced out');
SELECT public.subscription_dunning_mark_sent(
  'd4000000-0000-0000-0000-000000000007'::uuid,
  'stale-worker-delivery-id'
);
SELECT is(
  (SELECT status || '|' || (payload->>'claimToken')
     FROM public.subscription_dunning_notifications
    WHERE id = 'd4000000-0000-0000-0000-000000000007'::uuid),
  (SELECT 'sending|' || (payload->>'claimToken') FROM _system_claim),
  'W10: a stale worker still cannot complete a leased row without email_sends evidence');

-- Age only the immutable provider clock (status stays 'sending', so no token is
-- rotated), then let the real claim RPC run its manual-review terminalization.
UPDATE public.subscription_dunning_notifications
   SET resend_idempotency_started_at = now() - interval '24 hours'
 WHERE id = 'd4000000-0000-0000-0000-000000000007'::uuid;
CREATE TEMP TABLE _system_terminalize AS
SELECT * FROM public.subscription_dunning_claim_batch(25, 300, 6);
SELECT is(
  (SELECT count(*)::int FROM _system_terminalize),
  0, 'W10: the terminalized row is no longer returned as claimable work');
SELECT is(
  (SELECT status || '|' || provider_error
     FROM public.subscription_dunning_notifications
    WHERE id = 'd4000000-0000-0000-0000-000000000007'::uuid),
  'failed|resend_idempotency_window_expired_manual_review',
  'W10: a leased sending row outside the provider window becomes manual-review work');

-- W3 (20260808090000): the payment-recovered notice is the newest customer-facing
-- message on this rail, and it must be silenceable like every sibling. The
-- delivery-shaping policy is fail-open, so a MISSING control row would read as
-- "allowed" and leave an operator with nothing to toggle.
SELECT is(
  (SELECT enabled FROM public.comms_notification_controls
    WHERE slug = 'subscription-payment-recovered'),
  true,
  'W3: the payment-recovered notice has an operator kill switch, seeded enabled');
SELECT is(
  (SELECT count(*)::int FROM public.comms_notification_controls
    WHERE slug IN ('subscription-payment-recovered',
                   'subscription-payment-expired',
                   'subscription-payment-failed-*')),
  3,
  'W3: every customer-facing dunning message is individually controllable');

-- W3 PR-3b (20260809090000): the at-risk pre-renewal warning is the only
-- per-slug stop that does NOT also silence the failure and recovery notices, so
-- its control row is what lets an operator kill a bad health classification
-- without taking the whole dunning rail down. Fail-open policy means a MISSING
-- row reads as "allowed" and leaves nothing to toggle.
SELECT is(
  (SELECT enabled FROM public.comms_notification_controls
    WHERE slug = 'subscription-renewal-at-risk'),
  true,
  'W3b: the at-risk renewal warning has an operator kill switch, seeded enabled');
SELECT is(
  (SELECT count(*)::int FROM public.comms_notification_controls
    WHERE slug IN ('subscription-renewal-at-risk',
                   'subscription-payment-recovered',
                   'subscription-payment-expired',
                   'subscription-payment-failed-*')),
  4,
  'W3b: every customer-facing dunning message is individually controllable');

SELECT * FROM finish();
ROLLBACK;
