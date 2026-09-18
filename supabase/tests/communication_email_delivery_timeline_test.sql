-- pgTAP: customer-facing email delivery timeline links outbox, local send
-- ledger, and provider webhook evidence without storing raw provider payloads.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(34);

INSERT INTO public.clients (id, email, first_name, last_name, country, lifecycle_stage, acquisition_source)
VALUES (
  '11111111-2222-4222-8222-111111111111',
  'timeline-client@example.invalid',
  'Timeline',
  'Client',
  'PL',
  'lead',
  'test'
);

INSERT INTO public.commerce_orders (
  id, client_id, status, currency, subtotal_cents, discount_cents, shipping_cents, total_cents
)
VALUES (
  '22222222-2222-4222-8222-222222222222',
  '11111111-2222-4222-8222-111111111111',
  'paid',
  'PLN',
  12900,
  0,
  0,
  12900
);

INSERT INTO public.outbox_events (
  id,
  aggregate_type,
  aggregate_id,
  event_type,
  idempotency_key,
  payload,
  metadata,
  available_at
)
VALUES (
  '33333333-2222-4222-8222-333333333333',
  'commerce_order',
  '22222222-2222-4222-8222-222222222222',
  'commerce.order.paid.email',
  'timeline-paid-email',
  '{}'::jsonb,
  '{"source":"payment_webhook"}'::jsonb,
  '2026-06-17T10:00:00+00:00'
);

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE dedupe_key = 'outbox:33333333-2222-4222-8222-333333333333'),
  'planned',
  'outbox insert plans expected customer email delivery');

SELECT is(
  (SELECT template_slug FROM public.communication_email_deliveries WHERE dedupe_key = 'outbox:33333333-2222-4222-8222-333333333333'),
  'commerce-order-paid',
  'planned delivery derives the customer template slug from outbox event type');

SELECT is(
  (SELECT client_id::text FROM public.communication_email_deliveries WHERE dedupe_key = 'outbox:33333333-2222-4222-8222-333333333333'),
  '11111111-2222-4222-8222-111111111111',
  'planned delivery links the order client');

SELECT ok(
  public.communication_record_email_delivery(
    'outbox:33333333-2222-4222-8222-333333333333',
    'commerce-order-paid',
    'transactional',
    'send-adapter',
    'outbox_dispatch_send',
    'processing',
    'timeline-client@example.invalid',
    NULL,
    '11111111-2222-4222-8222-111111111111',
    NULL,
    'commerce_order',
    '22222222-2222-4222-8222-222222222222',
    '33333333-2222-4222-8222-333333333333',
    NULL,
    '2026-06-17T10:00:00+00:00',
    '2026-06-17T10:10:00+00:00',
    NULL,
    NULL,
    'resend',
    NULL,
    NULL,
    '{"source":"test"}'::jsonb
  ) IS NOT NULL,
  'send adapter receives a durable sendAttemptId before provider POST');

SELECT is(
  (SELECT outbox_event_id::text FROM public.communication_email_deliveries WHERE dedupe_key = 'outbox:33333333-2222-4222-8222-333333333333'),
  '33333333-2222-4222-8222-333333333333',
  'existing outbox event id is stored as durable evidence');

SELECT ok(
  public.communication_record_email_delivery(
    'outbox:44444444-2222-4222-8222-444444444444',
    'commerce-order-paid',
    'transactional',
    'send-adapter',
    'outbox_dispatch_send',
    'processing',
    'timeline-client@example.invalid',
    NULL,
    '11111111-2222-4222-8222-111111111111',
    NULL,
    'commerce_order',
    '22222222-2222-4222-8222-222222222222',
    '44444444-2222-4222-8222-444444444444',
    NULL,
    '2026-06-17T10:00:00+00:00',
    '2026-06-17T10:10:00+00:00',
    NULL,
    NULL,
    'resend',
    NULL,
    NULL,
    '{"source":"orphan-test"}'::jsonb
  ) IS NOT NULL,
  'missing outbox event id does not block required processing timeline');

SELECT is(
  (SELECT outbox_event_id::text FROM public.communication_email_deliveries WHERE dedupe_key = 'outbox:44444444-2222-4222-8222-444444444444'),
  NULL,
  'missing outbox event id is stored as a null FK');

SELECT is(
  (SELECT metadata->>'outboxEventIdText' FROM public.communication_email_deliveries WHERE dedupe_key = 'outbox:44444444-2222-4222-8222-444444444444'),
  '44444444-2222-4222-8222-444444444444',
  'missing outbox evidence id is preserved as metadata text');

SELECT is(
  public.communication_record_email_delivery(
  'outbox:33333333-2222-4222-8222-333333333333',
  'commerce-order-paid',
  'transactional',
  'send-adapter',
  'outbox_dispatch_send',
  'sent',
  'timeline-client@example.invalid',
  NULL,
  '11111111-2222-4222-8222-111111111111',
  NULL,
  'commerce_order',
  '22222222-2222-4222-8222-222222222222',
  '33333333-2222-4222-8222-333333333333',
  NULL,
  '2026-06-17T10:00:00+00:00',
  '2026-06-17T10:10:00+00:00',
  NULL,
  NULL,
  'resend',
  'resend_paid_timeline',
  NULL,
  '{"source":"test"}'::jsonb
  )::text,
  (SELECT id::text FROM public.communication_email_deliveries WHERE dedupe_key = 'outbox:33333333-2222-4222-8222-333333333333'),
  'final provider outcome returns the same sendAttemptId');

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE provider_message_id = 'resend_paid_timeline'),
  'sent',
  'send adapter updates the planned row to sent');

SELECT ok(
  (SELECT recipient_fingerprint IS NOT NULL FROM public.communication_email_deliveries WHERE provider_message_id = 'resend_paid_timeline'),
  'timeline stores recipient fingerprint instead of raw recipient');

SELECT is(
  (SELECT attempt_count FROM public.communication_email_deliveries WHERE provider_message_id = 'resend_paid_timeline'),
  1,
  'processing plus final provider outcome counts as one provider attempt');

SELECT is(
  public.communication_update_email_delivery_from_provider(
    NULL,
    'resend_paid_timeline',
    'email.delivered',
    '2026-06-17T10:01:00+00:00',
    '{"source":"resend-webhook"}'::jsonb
  ),
  1,
  'provider webhook update links one delivery row');

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE provider_message_id = 'resend_paid_timeline'),
  'delivered',
  'provider webhook marks the timeline delivered');

INSERT INTO public.outbox_events (
  id, aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata, available_at
)
VALUES (
  '55555555-2222-4222-8222-555555555555',
  'commerce_order',
  '22222222-2222-4222-8222-222222222222',
  'commerce.order.paid.email',
  'timeline-processed-sent',
  '{}'::jsonb,
  '{"source":"payment_webhook"}'::jsonb,
  '2026-06-17T10:00:00+00:00'
);

UPDATE public.outbox_events
   SET status = 'processed',
       processed_at = '2026-06-17T10:01:00+00:00',
       metadata = metadata || '{"resendId":"resend_lifecycle_sent"}'::jsonb
 WHERE id = '55555555-2222-4222-8222-555555555555';

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE outbox_event_id = '55555555-2222-4222-8222-555555555555'),
  'sent',
  'processed outbox with provider id closes planned delivery as sent');

SELECT is(
  (SELECT provider_message_id FROM public.communication_email_deliveries WHERE outbox_event_id = '55555555-2222-4222-8222-555555555555'),
  'resend_lifecycle_sent',
  'processed outbox copies provider message id into the delivery timeline');

INSERT INTO public.outbox_events (
  id, aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata, available_at
)
VALUES (
  '66666666-2222-4222-8222-666666666666',
  'commerce_order',
  '22222222-2222-4222-8222-222222222222',
  'commerce.order.paid.email',
  'timeline-processed-skip',
  '{}'::jsonb,
  '{"source":"payment_webhook"}'::jsonb,
  '2026-06-17T10:00:00+00:00'
);

UPDATE public.outbox_events
   SET status = 'processed',
       processed_at = '2026-06-17T10:02:00+00:00',
       metadata = metadata || '{"skipped":"recipient_unresolved"}'::jsonb
 WHERE id = '66666666-2222-4222-8222-666666666666';

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE outbox_event_id = '66666666-2222-4222-8222-666666666666'),
  'skipped',
  'processed outbox without provider id but with skip reason closes as skipped');

SELECT is(
  (SELECT last_error_code FROM public.communication_email_deliveries WHERE outbox_event_id = '66666666-2222-4222-8222-666666666666'),
  'recipient_unresolved',
  'processed skip reason is preserved in the delivery timeline');

SELECT ok(
  (SELECT terminal_at IS NOT NULL FROM public.communication_email_deliveries WHERE outbox_event_id = '66666666-2222-4222-8222-666666666666'),
  'processed skip is terminal in the delivery timeline');

INSERT INTO public.outbox_events (
  id, aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata, available_at
)
VALUES (
  '77777777-2222-4222-8222-777777777777',
  'commerce_order',
  '22222222-2222-4222-8222-222222222222',
  'commerce.order.paid.email',
  'timeline-cleanup-discard',
  '{}'::jsonb,
  '{"source":"payment_webhook"}'::jsonb,
  '2026-06-17T10:00:00+00:00'
);

UPDATE public.outbox_events
   SET status = 'discarded',
       error = 'hidden_preview_checkout_contract_smoke_cleanup',
       metadata = metadata || '{"source":"hidden_preview_checkout_contract_smoke_cleanup"}'::jsonb
 WHERE id = '77777777-2222-4222-8222-777777777777';

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE outbox_event_id = '77777777-2222-4222-8222-777777777777'),
  'skipped',
  'cleanup/test discard closes planned delivery as skipped');

SELECT is(
  (SELECT last_error_code FROM public.communication_email_deliveries WHERE outbox_event_id = '77777777-2222-4222-8222-777777777777'),
  'discarded_by_test_cleanup',
  'cleanup/test discard has an explicit non-customer-impact reason');

-- An intentionally suppressed customer email is skipped, not failed.
-- subscription_sweep_unpaid_provisional (20260714210000) and the order-draft supersede
-- (20260714201101) pre-seed the trigger's exactly-once outbox row as DISCARDED, carrying
-- metadata.suppressedCustomerEmail, so the real customer email never dispatches: the
-- customer is not owed it. Inserting the row already-discarded mirrors those producers.
-- The mapper keys on outbox status + the metadata flag and never on event_type, so the
-- seeded commerce aggregate exercises the same branch the subscription sweep hits in prod.
INSERT INTO public.outbox_events (
  id, aggregate_type, aggregate_id, event_type, idempotency_key, status, payload, metadata, available_at
)
VALUES (
  '99999999-2222-4222-8222-999999999999',
  'commerce_order',
  '22222222-2222-4222-8222-222222222222',
  'commerce.order.paid.email',
  'timeline-suppressed-discard',
  'discarded',
  '{"suppressedReason":"provisional_activation_abandoned"}'::jsonb,
  '{"source":"subscription_sweep_unpaid_provisional","suppressedCustomerEmail":true}'::jsonb,
  '2026-06-17T10:00:00+00:00'
);

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE outbox_event_id = '99999999-2222-4222-8222-999999999999'),
  'skipped',
  'intentionally suppressed customer email closes as skipped, not failed');

SELECT is(
  (SELECT last_error_code FROM public.communication_email_deliveries WHERE outbox_event_id = '99999999-2222-4222-8222-999999999999'),
  'provisional_activation_abandoned',
  'suppressed customer email records the producer suppression reason');

-- Regression guard: the suppression branch must not swallow real customer-impacting
-- discards. Without the flag a discard still fails the delivery and keeps paging.
INSERT INTO public.outbox_events (
  id, aggregate_type, aggregate_id, event_type, idempotency_key, status, payload, metadata, available_at
)
VALUES (
  'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
  'commerce_order',
  '22222222-2222-4222-8222-222222222222',
  'commerce.order.paid.email',
  'timeline-unflagged-discard',
  'discarded',
  '{}'::jsonb,
  '{"source":"payment_webhook"}'::jsonb,
  '2026-06-17T10:00:00+00:00'
);

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE outbox_event_id = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'),
  'failed',
  'discard without the suppression flag still closes the delivery as failed');

SELECT is(
  (SELECT last_error_code FROM public.communication_email_deliveries WHERE outbox_event_id = 'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa'),
  'outbox_discarded',
  'unflagged discard keeps its customer-impact reason code');

INSERT INTO public.outbox_events (
  id, aggregate_type, aggregate_id, event_type, idempotency_key, payload, metadata, available_at
)
VALUES (
  '88888888-2222-4222-8222-888888888888',
  'commerce_order',
  '22222222-2222-4222-8222-222222222222',
  'commerce.order.paid.email',
  'timeline-failed-reason',
  '{}'::jsonb,
  '{"source":"payment_webhook"}'::jsonb,
  '2026-06-17T10:00:00+00:00'
);

UPDATE public.outbox_events
   SET status = 'failed',
       error = 'Resend HTTP 422: bad domain'
 WHERE id = '88888888-2222-4222-8222-888888888888';

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE outbox_event_id = '88888888-2222-4222-8222-888888888888'),
  'failed',
  'failed outbox state closes the planned delivery with failure evidence');

SELECT is(
  (SELECT last_error_code FROM public.communication_email_deliveries WHERE outbox_event_id = '88888888-2222-4222-8222-888888888888'),
  'resend_http_422_bad_domain',
  'failed outbox state stores a sanitized reason code');

SELECT ok(
  public.communication_record_email_delivery(
    'janitor:real-overdue',
    'commerce-order-paid',
    'transactional',
    'test',
    'janitor_probe',
    'planned',
    NULL,
    NULL,
    NULL,
    NULL,
    'commerce_order',
    '22222222-2222-4222-8222-222222222222',
    NULL,
    NULL,
    '2026-06-17T09:00:00+00:00',
    '2026-06-17T09:10:00+00:00',
    NULL,
    NULL,
    'resend',
    NULL,
    NULL,
    '{}'::jsonb
  ) IS NOT NULL,
  'test creates one genuinely unrecoverable overdue planned delivery');

SELECT is(
  public.communication_mark_overdue_email_deliveries('2026-06-17T12:00:00+00:00', 15),
  1,
  'overdue janitor marks only genuine unrecoverable planned rows missed');

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE dedupe_key = 'janitor:real-overdue'),
  'missed',
  'real unrecoverable overdue row becomes missed');

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE outbox_event_id = '77777777-2222-4222-8222-777777777777'),
  'skipped',
  'cleanup/test discard is not reclassified as missed by the janitor');

UPDATE public.communication_email_deliveries
   SET status = 'planned',
       provider_message_id = NULL,
       sent_at = NULL,
       last_error_code = NULL
 WHERE outbox_event_id = '55555555-2222-4222-8222-555555555555';

SELECT is(
  public.communication_repair_email_delivery_outbox_lifecycle(100)->>'updatedDeliveries',
  '1',
  'repair closes one historical planned row whose outbox already processed');

SELECT is(
  public.communication_repair_email_delivery_outbox_lifecycle(100)->>'updatedDeliveries',
  '0',
  'repair is idempotent on replay');

SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE outbox_event_id = '55555555-2222-4222-8222-555555555555'),
  'sent',
  'repair restores the delivery lifecycle status from outbox state');

SELECT * FROM finish();
ROLLBACK;
