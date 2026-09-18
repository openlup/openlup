-- pgTAP: platform watchdog delivery-attempt state stays additive and bounded.
BEGIN;
SELECT plan(8);

SELECT has_column('public', 'platform_alerts', 'last_notification_attempt_at',
  'alert ledger stores the last delivery decision timestamp');
SELECT has_column('public', 'platform_alerts', 'last_notification_status',
  'alert ledger stores the last delivery decision status');
SELECT has_column('public', 'platform_alerts', 'next_notification_attempt_at',
  'alert ledger stores the next permitted delivery attempt');
SELECT has_column('public', 'platform_alerts', 'notification_failure_count',
  'alert ledger stores consecutive webhook failures');

INSERT INTO public.platform_alerts (
  dedupe_key, severity, support_code, owner, runbook_url, title, message,
  last_notified_at
) VALUES (
  'pgtap:platform-alert-delivery-state', 'p1', 'OPS-PGTAP', 'platform/test',
  '/docs/platform/RUNTIME_AND_SELF_HOSTING.md', 'pgTAP delivery state', 'schema test',
  '2026-07-26T10:00:00Z'::timestamptz
);

SELECT is(
  (SELECT last_notified_at FROM public.platform_alerts
    WHERE dedupe_key = 'pgtap:platform-alert-delivery-state'),
  '2026-07-26T10:00:00Z'::timestamptz,
  'an unlinked alert timestamp is not cleared by the additive delivery-state defaults');
SELECT is(
  (SELECT last_notification_attempt_at FROM public.platform_alerts
    WHERE dedupe_key = 'pgtap:platform-alert-delivery-state'),
  NULL::timestamptz,
  'migration does not invent an immutable delivery attempt for a legacy timestamp');
SELECT is(
  (SELECT last_notification_status FROM public.platform_alerts
    WHERE dedupe_key = 'pgtap:platform-alert-delivery-state'),
  NULL::text,
  'migration does not invent a delivery outcome for a new alert');
SELECT is(
  (SELECT notification_failure_count FROM public.platform_alerts
    WHERE dedupe_key = 'pgtap:platform-alert-delivery-state'),
  0,
  'new alerts begin with zero consecutive delivery failures');

SELECT * FROM finish();
ROLLBACK;
