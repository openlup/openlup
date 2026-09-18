-- pgTAP: the subscription self-service -> customer_account_events mirror trigger
-- (20260704160000).
--   * a self-service pause event yields one customer_account_events row
--     (subscription.paused) for the owning client;
--   * edit events, including generic bundle verbs, map to subscription.package_changed;
--   * a non-customer-facing event (subscription.cycle_paid) yields nothing.
--
-- Run via: supabase test db
BEGIN;
SELECT plan(12);

INSERT INTO public.clients (id, email, first_name)
VALUES ('e3000000-0000-0000-0000-0000000000a1', 'ss-account-event@example.invalid', 'Hist');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, next_cycle_at)
VALUES ('e3100000-0000-0000-0000-0000000000a1', 'e3000000-0000-0000-0000-0000000000a1', 21, 'PLN', 'active',
        '2026-09-01T00:00:00Z');

-- A self-service pause event mirrors to one subscription.paused history row.
INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES ('e3100000-0000-0000-0000-0000000000a1', 'subscription.customer_self_service.pause',
        'hist-pause-idem-1', jsonb_build_object('action', 'pause'), now());

SELECT is(
  (SELECT count(*)::int FROM public.customer_account_events
    WHERE client_id = 'e3000000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.paused'
      AND entity_id = 'e3100000-0000-0000-0000-0000000000a1'),
  1, 'self-service pause mirrors to one subscription.paused account event');

-- Edit events map to subscription.package_changed.
INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES ('e3100000-0000-0000-0000-0000000000a1', 'subscription.customer_self_service.update_recipe_mix',
        'hist-mix-idem-1', jsonb_build_object('action', 'update_recipe_mix'), now());

SELECT is(
  (SELECT count(*)::int FROM public.customer_account_events
    WHERE client_id = 'e3000000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.package_changed'),
  1, 'recipe-mix edit maps to subscription.package_changed account event');

INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES
  ('e3100000-0000-0000-0000-0000000000a1', 'subscription.customer_self_service.update_bundle',
   'hist-update-bundle-idem-1', jsonb_build_object('action', 'update_bundle'), now()),
  ('e3100000-0000-0000-0000-0000000000a1', 'subscription.customer_self_service.resize_bundle',
   'hist-resize-bundle-idem-1', jsonb_build_object('action', 'resize_bundle'), now());

SELECT is(
  (SELECT count(*)::int FROM public.customer_account_events
    WHERE client_id = 'e3000000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.package_changed'),
  3, 'generic bundle edits map to subscription.package_changed account events');

-- A non-customer-facing internal event does NOT create a history row.
INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES ('e3100000-0000-0000-0000-0000000000a1', 'subscription.cycle_paid',
        'hist-cycle-idem-1', jsonb_build_object('action', 'cycle_paid'), now());

SELECT is(
  (SELECT count(*)::int FROM public.customer_account_events
    WHERE client_id = 'e3000000-0000-0000-0000-0000000000a1'),
  4, 'non-customer-facing event (cycle_paid) adds no history row');

-- Auto-resume mirrors to subscription.resumed.
INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES ('e3100000-0000-0000-0000-0000000000a1', 'subscription.system.auto_resume',
        'hist-autoresume-idem-1', jsonb_build_object('action', 'auto_resume'), now());

SELECT is(
  (SELECT count(*)::int FROM public.customer_account_events
    WHERE client_id = 'e3000000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.resumed'),
  1, 'auto-resume mirrors to subscription.resumed account event');

-- Pause + resume/auto-resume also emit outbox events for the confirmation emails
-- (20260704170003). Pause emitted one subscription.paused; the manual + auto resume
-- both emit subscription.resumed (deduped per source event id, so 1 here from auto).
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE aggregate_id = 'e3100000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.paused'),
  1, 'pause emits one subscription.paused outbox event');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE aggregate_id = 'e3100000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.resumed'),
  1, 'auto-resume emits one subscription.resumed outbox event');

-- Edits (package_changed) now ALSO emit a confirmation email (20260707100000):
-- the recipe-mix and generic bundle edits emit subscription.package_changed outbox events. cancel
-- keeps its own cancelled email and is intentionally NOT emitted by this trigger.
SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE aggregate_id = 'e3100000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.package_changed'),
  3, 'recipe-mix and generic bundle edits emit subscription.package_changed outbox confirmations');

-- order_now and reactivate are customer-visible history, but this repair keeps
-- them out of the confirmation-email outbox until product copy/templates are
-- explicitly introduced for those exact actions.
INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES ('e3100000-0000-0000-0000-0000000000a1', 'subscription.customer_self_service.order_now',
        'hist-order-now-idem-1', jsonb_build_object('action', 'order_now'), now());

SELECT is(
  (SELECT count(*)::int FROM public.customer_account_events
    WHERE client_id = 'e3000000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.delivery_rescheduled'),
  1, 'order_now mirrors to delivery_rescheduled account history');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE aggregate_id = 'e3100000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.delivery_rescheduled'),
  0, 'order_now does not emit a delivery_rescheduled confirmation email');

INSERT INTO public.subscription_events (subscription_id, event_type, idempotency_key, payload, occurred_at)
VALUES ('e3100000-0000-0000-0000-0000000000a1', 'subscription.customer_self_service.reactivate',
        'hist-reactivate-idem-1', jsonb_build_object('action', 'reactivate'), now());

SELECT is(
  (SELECT count(*)::int FROM public.customer_account_events
    WHERE client_id = 'e3000000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.resumed'),
  2, 'reactivate mirrors to resumed account history');

SELECT is(
  (SELECT count(*)::int FROM public.outbox_events
    WHERE aggregate_id = 'e3100000-0000-0000-0000-0000000000a1'
      AND event_type = 'subscription.resumed'),
  1, 'reactivate does not add a second resumed confirmation email');

SELECT * FROM finish();
ROLLBACK;
