-- pgTAP: managed payment ingest persists canonical source evidence, replays an
-- identical delivery, and rejects the same event identity with drifted truth.

BEGIN;
SELECT plan(8);

CREATE TEMP TABLE _payment_truth_first AS
SELECT public.commerce_payment_control_ingest_event(
  p_provider => 'card_rail',
  p_provider_event_id => 'payment-truth-managed-event-1',
  p_event_type => 'payment.requires_action',
  p_provider_payment_id => NULL,
  p_payment_intent_id => NULL,
  p_payment_attempt_id => NULL,
  p_amount_cents => 2599,
  p_currency => 'XTS',
  p_signature_verified => true,
  p_payload => jsonb_build_object(
    'status', 'indeterminate',
    '__paymentTruth', jsonb_build_object(
      'fingerprint', repeat('a', 64),
      'evidence', '{"sourceKind":"accepted_event","sourceReference":"managed-event-1","observedStatus":"indeterminate"}'::jsonb
    )
  )
) AS result;

SELECT is(
  (SELECT result #>> '{paymentEvent,replayed}' FROM _payment_truth_first),
  'false', 'first canonical managed event is accepted');
SELECT is(
  (SELECT event_fingerprint FROM public.inbound_provider_events WHERE provider_event_id = 'payment-truth-managed-event-1'),
  repeat('a', 64), 'canonical fingerprint is durable');
SELECT is(
  (SELECT source_evidence->>'observedStatus' FROM public.inbound_provider_events WHERE provider_event_id = 'payment-truth-managed-event-1'),
  'indeterminate', 'provider-neutral source evidence is durable');
SELECT is(
  (SELECT payload FROM public.inbound_provider_events WHERE provider_event_id = 'payment-truth-managed-event-1'),
  '{"status":"indeterminate"}'::jsonb, 'reserved truth envelope is stripped from raw provider payload');

CREATE TEMP TABLE _payment_truth_legacy AS
SELECT public.commerce_payment_control_ingest_event(
  'card_rail', 'payment-truth-managed-legacy-1', 'payment.requires_action',
  NULL, NULL, NULL, 2599, 'XTS', true, '{"status":"indeterminate"}'::jsonb
) AS result;

SELECT is(
  (SELECT result #>> '{paymentEvent,replayed}' FROM _payment_truth_legacy),
  'false', 'pre-deploy caller without reserved envelope remains compatible');

CREATE TEMP TABLE _payment_truth_replay AS
SELECT public.commerce_payment_control_ingest_event(
  'card_rail', 'payment-truth-managed-event-1', 'payment.requires_action',
  NULL, NULL, NULL, 2599, 'XTS', true,
  jsonb_build_object(
    'status', 'indeterminate',
    '__paymentTruth', jsonb_build_object(
      'fingerprint', repeat('a', 64),
      'evidence', '{"sourceKind":"accepted_event","sourceReference":"managed-event-1","observedStatus":"indeterminate"}'::jsonb
    )
  )
) AS result;

SELECT is(
  (SELECT result #>> '{paymentEvent,replayed}' FROM _payment_truth_replay),
  'true', 'identical managed delivery replays');
SELECT is(
  (SELECT count(*)::integer FROM public.inbound_provider_events WHERE provider_event_id = 'payment-truth-managed-event-1'),
  1, 'managed replay creates no second event');
SELECT throws_ok(
  $$SELECT public.commerce_payment_control_ingest_event(
    'card_rail', 'payment-truth-managed-event-1', 'payment.requires_action',
    NULL, NULL, NULL, 2599, 'XTS', true,
    jsonb_build_object(
      'status', 'changed',
      '__paymentTruth', jsonb_build_object(
        'fingerprint', repeat('b', 64),
        'evidence', '{"sourceKind":"accepted_event","sourceReference":"managed-event-1","observedStatus":"changed"}'::jsonb
      )
    )
  )$$,
  '23505', 'commerce_payment_event_idempotency_conflict',
  'same managed event identity with another fingerprint conflicts');

SELECT * FROM finish();
ROLLBACK;
