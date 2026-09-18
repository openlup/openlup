-- pgTAP: the Resend delivery poller's applyPolledEvent writes email_events rows
-- with BARE event_type names ('delivered'/'bounce'/'complaint'/...). This pins
-- them against the email_events CHECK constraint and proves the pre-fix 'email.*'
-- webhookType values are rejected — the regression guard for the constraint
-- violation that made every polled reconcile throw.
--
-- Run via: supabase test db

BEGIN;
SELECT plan(7);

INSERT INTO public.email_sends (id, resend_id, status, sent_at)
VALUES ('dddddddd-2222-4222-8222-dddddddddddd', 're_evt_contract', 'sent', now());

-- Every event_type the poller can emit (EVENT_TYPE_BY_WEBHOOK_TYPE) must be accepted.
SELECT lives_ok(
  $$INSERT INTO public.email_events (send_id, event_type) VALUES ('dddddddd-2222-4222-8222-dddddddddddd', 'delivered')$$,
  'delivered event_type is accepted');
SELECT lives_ok(
  $$INSERT INTO public.email_events (send_id, event_type) VALUES ('dddddddd-2222-4222-8222-dddddddddddd', 'bounce')$$,
  'bounce event_type is accepted (email.bounced -> bounce)');
SELECT lives_ok(
  $$INSERT INTO public.email_events (send_id, event_type) VALUES ('dddddddd-2222-4222-8222-dddddddddddd', 'complaint')$$,
  'complaint event_type is accepted (email.complained -> complaint)');
SELECT lives_ok(
  $$INSERT INTO public.email_events (send_id, event_type) VALUES ('dddddddd-2222-4222-8222-dddddddddddd', 'delivery_delayed')$$,
  'delivery_delayed event_type is accepted');
SELECT lives_ok(
  $$INSERT INTO public.email_events (send_id, event_type) VALUES ('dddddddd-2222-4222-8222-dddddddddddd', 'failed')$$,
  'failed event_type is accepted');

-- The pre-fix value (the raw 'email.*' webhookType) must be rejected — this is the
-- bug: applyPolledEvent used to insert it and threw on every reconcile.
SELECT throws_ok(
  $$INSERT INTO public.email_events (send_id, event_type) VALUES ('dddddddd-2222-4222-8222-dddddddddddd', 'email.delivered')$$,
  '23514', NULL,
  'raw email.* webhookType is rejected by the event_type CHECK');
SELECT throws_ok(
  $$INSERT INTO public.email_events (send_id, event_type) VALUES ('dddddddd-2222-4222-8222-dddddddddddd', 'email.bounced')$$,
  '23514', NULL,
  'raw email.bounced is rejected by the event_type CHECK');

SELECT * FROM finish();
ROLLBACK;
