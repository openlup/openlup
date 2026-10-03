-- Reads shipped data before any test setup; replays the actual shipped forward.
BEGIN;
SELECT plan(13);
SELECT is((SELECT count(*)::integer FROM public.client_absorption_policy), 27,
  'the shipped forward installs the exact current FK policy inventory');
SELECT is((SELECT count(*)::integer FROM pg_constraint fk
  JOIN pg_class referencing ON referencing.oid = fk.conrelid
  JOIN pg_namespace ns ON ns.oid = referencing.relnamespace
  WHERE fk.contype = 'f' AND fk.confrelid = 'public.clients'::regclass AND ns.nspname = 'public'
  AND NOT EXISTS (SELECT 1 FROM public.client_absorption_policy p WHERE p.table_name = referencing.relname)), 0,
  'every installed clients FK is classified without a test policy seed');
SELECT is((SELECT count(*)::integer FROM public.platform_job_controls
  WHERE job_name IN ('accounting-invoice-issue','accounting-invoice-delivery','accounting-invoice-correction',
    'accounting-ksef-status','abandoned-cart-reminder','outbox-prune','promotion-claim-sweep') AND NOT enabled), 7,
  'all seven shipped jobs are disabled without activation');
SELECT is((SELECT count(*)::integer FROM public.outbox_dormant_event_types
  WHERE event_type IN ('commerce.subscription_payment.requested','commerce.payment_attempt.requested',
    'commerce.subscription_payment.retry_requested','commerce.subscription.resume_requested')), 4,
  'four declared exact dormant command identities are installed');
SELECT is((SELECT count(*)::integer FROM public.comms_notification_controls
  WHERE slug IN ('subscription-payment-recovered','subscription-payment-expired','subscription-payment-failed-*',
    'subscription-renewal-at-risk') AND enabled), 4,
  'four operator toggles preserve previous allow behavior');
SELECT is((SELECT array_agg(attname::text ORDER BY attnum)::text FROM pg_attribute
  WHERE attrelid = 'public.outbox_dormant_event_types'::regclass AND attnum > 0 AND NOT attisdropped),
  '{event_type,owner,reason,created_at,updated_at}',
  'positional forward is tied to the exact frozen five-column dormant relation');

SET LOCAL ROLE service_role;
CREATE TEMP TABLE _seed_sweep_claim AS SELECT * FROM public.platform_claim_job_run(
  'promotion-claim-sweep', 'vercel_cron', 120, '{}'::jsonb);
SELECT is((SELECT acquired::text || ':' || reason FROM _seed_sweep_claim), 'false:job_disabled',
  'actual service scheduler claim respects the shipped disabled sweep control');
RESET ROLE;
SELECT ok((SELECT lease_token IS NULL AND lease_until IS NULL AND lease_expires_at IS NULL
  FROM public.platform_job_controls WHERE job_name = 'promotion-claim-sweep'),
  'disabled sweep claim installs no execution lease');

-- Operator choices in this test stay transaction-local; no job is enabled.
UPDATE public.platform_job_controls SET active_driver = 'worker', metadata = '{"operatorChoice":true}'
  WHERE job_name = 'promotion-claim-sweep';
UPDATE public.comms_notification_controls SET enabled = false WHERE slug = 'subscription-payment-recovered';
UPDATE public.client_absorption_policy SET note = 'operator classification note' WHERE table_name = 'customer_account_events';
UPDATE public.outbox_dormant_event_types SET reason = 'operator dormant rationale'
  WHERE event_type = 'commerce.subscription.resume_requested';
CREATE TEMP TABLE _data_before_replay AS SELECT jsonb_build_object(
  'policies', (SELECT jsonb_agg(to_jsonb(r) ORDER BY table_name) FROM public.client_absorption_policy r),
  'jobs', (SELECT jsonb_agg(to_jsonb(r) ORDER BY job_name) FROM public.platform_job_controls r),
  'dormant', (SELECT jsonb_agg(to_jsonb(r) ORDER BY event_type) FROM public.outbox_dormant_event_types r),
  'notifications', (SELECT jsonb_agg(to_jsonb(r) ORDER BY slug) FROM public.comms_notification_controls r)
) AS state;
\ir ../migrations/20261003110000_required_platform_policy_data.sql
SELECT is(jsonb_build_object(
  'policies', (SELECT jsonb_agg(to_jsonb(r) ORDER BY table_name) FROM public.client_absorption_policy r),
  'jobs', (SELECT jsonb_agg(to_jsonb(r) ORDER BY job_name) FROM public.platform_job_controls r),
  'dormant', (SELECT jsonb_agg(to_jsonb(r) ORDER BY event_type) FROM public.outbox_dormant_event_types r),
  'notifications', (SELECT jsonb_agg(to_jsonb(r) ORDER BY slug) FROM public.comms_notification_controls r)
), (SELECT state FROM _data_before_replay), 'actual forward replay preserves every persisted row and operator override');
SELECT is((SELECT count(*)::integer FROM public.platform_job_controls WHERE enabled
  AND job_name IN ('accounting-invoice-issue','accounting-invoice-delivery','accounting-invoice-correction',
    'accounting-ksef-status','abandoned-cart-reminder','outbox-prune','promotion-claim-sweep')), 0,
  'replaying the shipped forward activates no job');

-- New foreign keys remain unclassified, rather than receiving a catch-all policy.
-- Behavioral absorption/rehome refusal remains in their existing role families;
-- this schema witness does not substitute owner execution for their invoker RPCs.
CREATE TABLE public.required_data_unclassified_probe (client_id uuid REFERENCES public.clients(id));
SELECT ok(NOT EXISTS (SELECT 1 FROM public.client_absorption_policy
  WHERE table_name = 'required_data_unclassified_probe'), 'future clients FK has no implicit permission policy');
INSERT INTO public.outbox_events (id, aggregate_type, aggregate_id, event_type, idempotency_key, created_at, payload) VALUES
  ('ee900000-0000-4000-8000-000000000091','subscription','ee900000-0000-4000-8000-000000000090',
    'test.required-data.unknown','required-data-unknown',now() - interval '2 minutes', '{}'::jsonb),
  ('ee900000-0000-4000-8000-000000000092','subscription','ee900000-0000-4000-8000-000000000090',
    'subscription.cancelled','required-data-ready',now() - interval '1 minute', '{}'::jsonb);
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.outbox_claim_batch_v3(
  ARRAY['subscription.cancelled'], ARRAY['subscription.cancelled'], 10, 300, 8)), 0,
  'actual service claim still blocks a known event behind unknown older work');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.outbox_events
  WHERE id IN ('ee900000-0000-4000-8000-000000000091','ee900000-0000-4000-8000-000000000092') AND status = 'pending'), 2,
  'unknown-order refusal leaves both rows pending without test-only dormancy');
SELECT * FROM finish();
ROLLBACK;
