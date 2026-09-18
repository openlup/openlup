-- pgTAP: subscription retention/cancellation read model.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(6);

SELECT has_view('public', 'subscription_retention_outcomes', 'Wave5: retention outcomes view exists');

INSERT INTO public.clients (id, email)
VALUES ('b5000000-0000-0000-0000-000000000001', 'wave5-retention@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at, template_version)
VALUES ('b5100000-0000-0000-0000-000000000001', 'b5000000-0000-0000-0000-000000000001', 28, 'PLN', 'cancelled', '2026-07-01T00:00:00Z', 1);

INSERT INTO public.subscription_events (id, subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES
  (
    'b5200000-0000-0000-0000-000000000001',
    'b5100000-0000-0000-0000-000000000001',
    'subscription.customer_self_service.cancel',
    'wave5-cancel-retention',
    jsonb_build_object(
      'action', 'cancel',
      'payload', jsonb_build_object(
        'survey', jsonb_build_object('reasonCode', 'too_expensive', 'comment', 'Too much'),
        'saveOffer', jsonb_build_object(
          'offerId', 'support-callback',
          'kind', 'support_callback',
          'accepted', false,
          'externalOfferRef', 'retention-provider:offer-1'
        )
      )
    ),
    '2026-06-16T10:00:00Z'::timestamptz
  ),
  (
    'b5200000-0000-0000-0000-000000000002',
    'b5100000-0000-0000-0000-000000000001',
    'subscription.customer_self_service.pause',
    'wave5-pause-save',
    jsonb_build_object(
      'action', 'pause',
      'payload', jsonb_build_object(
        'survey', jsonb_build_object('reasonCode', 'too_much_food', 'acceptedSaveOfferId', 'pause-2_weeks'),
        'saveOffer', jsonb_build_object('offerId', 'pause-2_weeks', 'kind', 'pause', 'accepted', true)
      )
    ),
    '2026-06-16T11:00:00Z'::timestamptz
  );

SELECT is(
  (SELECT cancel_reason_code FROM public.subscription_retention_outcomes WHERE event_id = 'b5200000-0000-0000-0000-000000000001'),
  'too_expensive',
  'Wave5: cancel reason is queryable');

SELECT is(
  (SELECT save_offer_kind FROM public.subscription_retention_outcomes WHERE event_id = 'b5200000-0000-0000-0000-000000000001'),
  'support_callback',
  'Wave5: retention outcome kind is queryable');

SELECT is(
  (SELECT external_offer_ref FROM public.subscription_retention_outcomes WHERE event_id = 'b5200000-0000-0000-0000-000000000001'),
  'retention-provider:offer-1',
  'Wave5: optional external offer reference is queryable without promo internals');

SELECT ok(
  (SELECT save_offer_accepted FROM public.subscription_retention_outcomes WHERE event_id = 'b5200000-0000-0000-0000-000000000002'),
  'Wave5: accepted pause-first save offer is queryable');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_price_agreements WHERE subscription_id = 'b5100000-0000-0000-0000-000000000001'),
  0,
  'Wave5: save offer evidence does not mutate price agreements');

SELECT * FROM finish();
ROLLBACK;
