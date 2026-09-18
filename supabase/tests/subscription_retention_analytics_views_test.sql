-- pgTAP: subscription save-rate funnel + 90-day post-save retention read models (P0 S4).
--
-- Run via: supabase test db

BEGIN;
SELECT plan(8);

SELECT has_view('public', 'subscription_save_offer_funnel', 'S4: save-offer funnel view exists');
SELECT has_view('public', 'subscription_save_retention_90d', 'S4: 90-day save retention view exists');

INSERT INTO public.clients (id, email)
VALUES ('b6000000-0000-0000-0000-000000000001', 's4-retention@example.invalid');

-- Sub A: accepted save 200d ago, still active  -> retained_90d = true
-- Sub B: accepted save 200d ago, cancelled 150d ago (within window) -> retained_90d = false
-- Sub C: accepted save 10d ago, active (window open) -> retained_90d = NULL (pending)
INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at, template_version, started_at, ended_at)
VALUES
  ('b6100000-0000-0000-0000-00000000000a', 'b6000000-0000-0000-0000-000000000001', 28, 'PLN', 'active',    now() + interval '20 days', 1, now() - interval '210 days', NULL),
  ('b6100000-0000-0000-0000-00000000000b', 'b6000000-0000-0000-0000-000000000001', 28, 'PLN', 'cancelled', now() + interval '20 days', 1, now() - interval '210 days', now() - interval '150 days'),
  ('b6100000-0000-0000-0000-00000000000c', 'b6000000-0000-0000-0000-000000000001', 28, 'PLN', 'active',    now() + interval '20 days', 1, now() - interval '30 days', NULL);

-- Accepted pause saves (one per subscription).
INSERT INTO public.subscription_events (id, subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES
  ('b6200000-0000-0000-0000-00000000000a', 'b6100000-0000-0000-0000-00000000000a',
   'subscription.customer_self_service.pause', 's4-save-a',
   jsonb_build_object('action','pause','payload', jsonb_build_object(
     'survey', jsonb_build_object('reasonCode','too_much_food','acceptedSaveOfferId','pause-2_weeks'),
     'saveOffer', jsonb_build_object('offerId','pause-2_weeks','kind','pause','accepted',true))),
   now() - interval '200 days'),
  ('b6200000-0000-0000-0000-00000000000b', 'b6100000-0000-0000-0000-00000000000b',
   'subscription.customer_self_service.pause', 's4-save-b',
   jsonb_build_object('action','pause','payload', jsonb_build_object(
     'survey', jsonb_build_object('reasonCode','too_much_food','acceptedSaveOfferId','pause-2_weeks'),
     'saveOffer', jsonb_build_object('offerId','pause-2_weeks','kind','pause','accepted',true))),
   now() - interval '200 days'),
  ('b6200000-0000-0000-0000-00000000000c', 'b6100000-0000-0000-0000-00000000000c',
   'subscription.customer_self_service.pause', 's4-save-c',
   jsonb_build_object('action','pause','payload', jsonb_build_object(
     'survey', jsonb_build_object('reasonCode','too_much_food','acceptedSaveOfferId','pause-2_weeks'),
     'saveOffer', jsonb_build_object('offerId','pause-2_weeks','kind','pause','accepted',true))),
   now() - interval '10 days');

-- A declined hard-cancel on sub A (offered the pause kind, not accepted).
INSERT INTO public.subscription_events (id, subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES
  ('b6200000-0000-0000-0000-0000000000d1', 'b6100000-0000-0000-0000-00000000000a',
   'subscription.customer_self_service.cancel', 's4-decline-a',
   jsonb_build_object('action','cancel','payload', jsonb_build_object(
     'survey', jsonb_build_object('reasonCode','too_expensive','acceptedSaveOfferId', NULL),
     'saveOffer', jsonb_build_object('offerId','pause-1_month','kind','pause','accepted',false))),
   now() - interval '5 days');

-- 90-day retention outcomes
SELECT ok(
  (SELECT retained_90d FROM public.subscription_save_retention_90d WHERE event_id = 'b6200000-0000-0000-0000-00000000000a'),
  'S4: active subscription past the 90-day window counts as retained');
SELECT is(
  (SELECT retained_90d FROM public.subscription_save_retention_90d WHERE event_id = 'b6200000-0000-0000-0000-00000000000b'),
  false,
  'S4: subscription cancelled within 90 days of the save is not retained');
SELECT is(
  (SELECT retained_90d FROM public.subscription_save_retention_90d WHERE event_id = 'b6200000-0000-0000-0000-00000000000c'),
  NULL::boolean,
  'S4: save inside the still-open 90-day window is pending (NULL)');

-- funnel aggregates
SELECT is(
  (SELECT accepted FROM public.subscription_save_offer_funnel WHERE save_offer_kind = 'pause' AND cancel_reason_code = 'too_much_food'),
  3::bigint,
  'S4: funnel counts the three accepted pause saves');
SELECT is(
  (SELECT declined FROM public.subscription_save_offer_funnel WHERE save_offer_kind = 'pause' AND cancel_reason_code = 'too_expensive'),
  1::bigint,
  'S4: funnel counts the declined hard-cancel');
SELECT is(
  (SELECT offered FROM public.subscription_save_offer_funnel WHERE save_offer_kind = 'pause' AND cancel_reason_code = 'too_much_food'),
  3::bigint,
  'S4: funnel counts offered = rows with a save_offer_id');

SELECT * FROM finish();
ROLLBACK;
