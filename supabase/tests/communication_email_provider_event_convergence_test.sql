-- pgTAP: one provider event atomically converges the event ledger, send state,
-- and customer-visible delivery timeline without replay or chronology regressions.

BEGIN;
SELECT plan(74);

INSERT INTO public.testers (
  id, source, first_name, last_name, email, phone, street, postal_code, city
) VALUES (
  '40000000-0000-4000-8000-000000000004', 'manual', 'Fallback', 'Tester',
  'tester-fallback@example.com', '+48111111111', 'Testowa 1', '00-001', 'Warszawa'
);

INSERT INTO public.email_sends (id, template_slug, resend_id, sent_at, status, source, provider_response)
VALUES
  ('10000000-0000-4000-8000-000000000001', 'commerce-invoice-document', 'resend-converge-1', '2026-07-16T09:00:00Z', 'sent', 'test', '{}'::jsonb),
  ('10000000-0000-4000-8000-000000000002', 'commerce-invoice-document', 'resend-converge-2', '2026-07-16T09:00:00Z', 'sent', 'test', '{}'::jsonb),
  ('10000000-0000-4000-8000-000000000003', 'commerce-invoice-document', 'resend-converge-3', '2026-07-16T09:00:00Z', 'sent', 'test', '{}'::jsonb),
  ('10000000-0000-4000-8000-000000000004', 'commerce-invoice-document', 'resend-converge-4', '2026-07-16T09:00:00Z', 'sent', 'test', '{}'::jsonb),
  ('10000000-0000-4000-8000-000000000005', 'commerce-invoice-document', 'resend-converge-5', '2026-07-16T09:00:00Z', 'sent', 'test', '{}'::jsonb),
  ('10000000-0000-4000-8000-000000000006', 'commerce-invoice-document', 'resend-converge-6', '2026-07-16T09:00:00Z', 'sent', 'test', '{}'::jsonb);

UPDATE public.email_sends
   SET tester_id = '40000000-0000-4000-8000-000000000004'
 WHERE id = '10000000-0000-4000-8000-000000000004';

INSERT INTO public.communication_email_deliveries (
  id, purpose, template_slug, trigger_source, trigger_event, dedupe_key, status,
  email_send_id, provider_kind, provider_message_id, metadata
)
VALUES
  ('20000000-0000-4000-8000-000000000001', 'transactional', 'commerce-invoice-document', 'test', 'invoice.document.delivery', 'provider-converge-1', 'sent', '10000000-0000-4000-8000-000000000001', 'resend', 'resend-converge-1', '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000002', 'transactional', 'commerce-invoice-document', 'test', 'invoice.document.delivery', 'provider-converge-2', 'sent', '10000000-0000-4000-8000-000000000002', 'resend', 'resend-converge-2', '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000003', 'transactional', 'commerce-invoice-document', 'test', 'invoice.document.delivery', 'provider-converge-3', 'sent', '10000000-0000-4000-8000-000000000003', 'resend', 'resend-converge-3', '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000004', 'transactional', 'commerce-invoice-document', 'test', 'invoice.document.delivery', 'provider-converge-4', 'sent', '10000000-0000-4000-8000-000000000004', 'resend', 'resend-converge-4', '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000005', 'transactional', 'commerce-invoice-document', 'test', 'invoice.document.delivery', 'provider-converge-5', 'sent', '10000000-0000-4000-8000-000000000005', 'resend', 'resend-converge-5', '{}'::jsonb),
  ('20000000-0000-4000-8000-000000000090', 'transactional', 'commerce-invoice-document', 'test', 'invoice.document.delivery', 'provider-converge-wrong-kind', 'sent', NULL, 'fakturownia', 'resend-converge-1', '{}'::jsonb);

SELECT ok(
  (SELECT poll_last_attempt_at IS NULL FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'),
  'poll attempt timestamp defaults to null'
);

SELECT is(
  public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000001',
    'resend-converge-1',
    'email.delivered',
    '2026-07-16T10:00:00Z',
    jsonb_build_object(
      'providerEventId', 'evt-delivered-1',
      'source', 'resend-webhook',
      'eventTimeSource', 'provider_created_at',
      'link', 'https://example.invalid/provider-link',
      'eventMetadata', jsonb_build_object('safe', true)
    )
  ),
  1,
  'fresh provider event converges one linked delivery'
);

SELECT is((SELECT count(*)::integer FROM public.email_events WHERE resend_webhook_id = 'evt-delivered-1'), 1, 'fresh event is recorded once');
SELECT is((SELECT timestamp FROM public.email_events WHERE resend_webhook_id = 'evt-delivered-1'), '2026-07-16T10:00:00Z'::timestamptz, 'event uses provider occurrence time');
SELECT is((SELECT metadata->>'source' FROM public.email_events WHERE resend_webhook_id = 'evt-delivered-1'), 'resend-webhook', 'event preserves its source');
SELECT is((SELECT metadata->>'eventTimeSource' FROM public.email_events WHERE resend_webhook_id = 'evt-delivered-1'), 'provider_created_at', 'event preserves provider-time provenance');
SELECT is((SELECT link_url FROM public.email_events WHERE resend_webhook_id = 'evt-delivered-1'), 'https://example.invalid/provider-link', 'event preserves its link');
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'), 'delivered', 'send projection becomes delivered');
SELECT is((SELECT provider_response->>'lastProviderEventAt' FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'), '2026-07-16T10:00:00+00:00', 'send stores chronology watermark');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000001'), 'delivered', 'timeline becomes delivered');
SELECT is((SELECT delivered_at FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000001'), '2026-07-16T10:00:00Z'::timestamptz, 'timeline uses provider delivery time');
SELECT is(
  (SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000090'),
  'sent',
  'provider-message fallback cannot update a non-Resend timeline'
);

SELECT is(
  public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000002',
    'resend-wrong-replay-payload',
    'email.bounced',
    '2026-07-16T11:00:00Z',
    '{"providerEventId":"evt-delivered-1","source":"replay"}'::jsonb
  ),
  1,
  'duplicate replays converge through the canonical event'
);
SELECT is((SELECT count(*)::integer FROM public.email_events WHERE resend_webhook_id = 'evt-delivered-1'), 1, 'duplicate does not add an event');
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'), 'delivered', 'duplicate payload cannot replace canonical event type');
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'sent', 'duplicate payload cannot redirect canonical event to another send or provider id');

UPDATE public.email_sends
   SET status = 'sent', provider_response = '{}'::jsonb
 WHERE id = '10000000-0000-4000-8000-000000000001';
UPDATE public.communication_email_deliveries
   SET status = 'sent', delivered_at = NULL, terminal_at = NULL, metadata = '{}'::jsonb
 WHERE id = '20000000-0000-4000-8000-000000000001';

SELECT is(
  public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000001', 'resend-converge-1', 'email.bounced',
    '2026-07-16T11:00:00Z', '{"providerEventId":"evt-delivered-1","source":"replay"}'::jsonb
  ),
  1,
  'duplicate repairs projections after an old partial write'
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'), 'delivered', 'repair uses canonical delivered status');
SELECT is((SELECT delivered_at FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000001'), '2026-07-16T10:00:00Z'::timestamptz, 'repair uses canonical event time');

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000001', 'resend-converge-1', 'email.sent',
  '2026-07-16T09:30:00Z', '{"providerEventId":"evt-stale-sent-1","source":"resend-webhook"}'::jsonb
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'), 'delivered', 'late sent event does not regress send');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000001'), 'delivered', 'late sent event does not regress timeline');

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000001', 'resend-converge-1', 'email.bounced',
  '2026-07-16T09:45:00Z', '{"providerEventId":"evt-stale-bounce-1","source":"resend-webhook"}'::jsonb
);
SELECT is((SELECT count(*)::integer FROM public.email_events WHERE resend_webhook_id = 'evt-stale-bounce-1'), 1, 'stale negative event remains auditable');
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'), 'delivered', 'stale negative event does not regress send');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000001'), 'delivered', 'stale negative event does not regress timeline');

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000001', 'resend-converge-1', 'email.complained',
  '2026-07-16T10:30:00Z',
  '{"providerEventId":"evt-complaint-1","source":"resend-webhook","eventMetadata":{"to":["suppression-test@example.com"]}}'::jsonb
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'), 'complained', 'newer complaint advances send from delivered');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000001'), 'complained', 'newer complaint advances timeline from delivered');
SELECT is((SELECT terminal_at FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000001'), '2026-07-16T10:30:00Z'::timestamptz, 'negative terminal time is provider occurrence time');
SELECT is(
  (SELECT count(*)::integer FROM public.communication_provider_events WHERE provider_kind = 'resend' AND provider_event_id = 'evt-complaint-1'),
  1,
  'complaint is recorded once in the existing provider-event ledger'
);
SELECT is(
  (SELECT count(*)::integer
     FROM public.communication_permission_events permission_event
     JOIN public.communication_contacts contact ON contact.id = permission_event.contact_id
    WHERE contact.normalized_email = 'suppression-test@example.com'
      AND permission_event.state = 'suppressed'),
  2,
  'complaint atomically suppresses both marketing purposes'
);
SELECT is(
  public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000001', 'resend-converge-1', 'email.complained',
    '2026-07-16T11:30:00Z',
    '{"providerEventId":"evt-complaint-1","source":"replay","eventMetadata":{"email":"other@example.com"}}'::jsonb
  ),
  1,
  'complaint replay converges the canonical event'
);
SELECT is(
  (SELECT count(*)::integer
     FROM public.communication_permission_events permission_event
     JOIN public.communication_contacts contact ON contact.id = permission_event.contact_id
    WHERE contact.normalized_email = 'suppression-test@example.com'
      AND permission_event.state = 'suppressed'),
  2,
  'complaint replay does not duplicate permission events'
);

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000001', 'resend-converge-1', 'email.sent',
  '2026-07-16T12:00:00Z', '{"providerEventId":"evt-late-sent-2","source":"resend-webhook"}'::jsonb
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'), 'complained', 'terminal send status is absorbing');

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000001', 'resend-converge-1', 'email.opened',
  '2026-07-16T13:00:00Z', '{"providerEventId":"evt-open-1","source":"resend-webhook"}'::jsonb
);
SELECT is((SELECT count(*)::integer FROM public.email_events WHERE resend_webhook_id = 'evt-open-1'), 1, 'engagement event is recorded');
SELECT is((SELECT provider_response->>'lastProviderEventAt' FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000001'), '2026-07-16T10:30:00+00:00', 'engagement does not move delivery watermark');

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000002', 'resend-converge-2', 'email.delivery_delayed',
  '2026-07-16T12:00:00Z', '{"providerEventId":"poll:resend-converge-2:delivery_delayed","source":"resend-delivery-reconciliation"}'::jsonb
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'sent', 'delay keeps constraint-compatible send status');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), 'delivery_delayed', 'delay advances timeline');

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000002', 'resend-converge-2', 'email.bounced',
  '2026-07-16T11:00:00Z', '{"providerEventId":"evt-stale-bounce-after-delay","source":"resend-webhook"}'::jsonb
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'sent', 'stale bounce cannot advance a send after a newer delay');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), 'delivery_delayed', 'stale bounce cannot advance a timeline after a newer delay');

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000002', 'resend-converge-2', 'email.complained',
  '2026-07-16T11:00:00Z', '{"providerEventId":"evt-stale-complaint-after-delay","source":"resend-webhook"}'::jsonb
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'sent', 'stale complaint cannot advance a send after a newer delay');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), 'delivery_delayed', 'stale complaint cannot advance a timeline after a newer delay');

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000002', 'resend-converge-2', 'email.failed',
  '2026-07-16T11:00:00Z', '{"providerEventId":"evt-stale-failed-after-delay","source":"resend-webhook"}'::jsonb
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'sent', 'stale failure cannot advance a send after a newer delay');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), 'delivery_delayed', 'stale failure cannot advance a timeline after a newer delay');

SELECT public.communication_update_email_delivery_from_provider(
  '10000000-0000-4000-8000-000000000002', 'resend-converge-2', 'email.delivered',
  '2026-07-16T11:00:00Z', '{"providerEventId":"evt-stale-delivered-after-delay","source":"resend-webhook"}'::jsonb
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'sent', 'stale delivered cannot advance a send after a newer delay');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), 'delivery_delayed', 'stale delivered cannot advance a timeline after a newer delay');

SELECT is((SELECT provider_response->>'lastProviderEventAt' FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), '2026-07-16T12:00:00+00:00', 'poll observation remains the chronology high-water mark');
SELECT is((SELECT provider_response->>'lastProviderEventType' FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'email.delivery_delayed', 'send watermark type stays paired with its high-water time');
SELECT is((SELECT provider_response->>'lastProviderEventId' FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'poll:resend-converge-2:delivery_delayed', 'send watermark id stays paired with its high-water time');
SELECT is((SELECT provider_response->>'lastProviderEventSource' FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'resend-delivery-reconciliation', 'send watermark source stays paired with its high-water time');
SELECT is((SELECT metadata->>'lastProviderEventAt' FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), '2026-07-16T12:00:00+00:00', 'timeline keeps the delay high-water time');
SELECT is((SELECT metadata->>'lastProviderEventType' FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), 'email.delivery_delayed', 'timeline watermark type stays paired with its high-water time');
SELECT is((SELECT metadata->>'lastProviderEventId' FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), 'poll:resend-converge-2:delivery_delayed', 'timeline watermark id stays paired with its high-water time');
SELECT is((SELECT metadata->>'lastProviderEventSource' FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), 'resend-delivery-reconciliation', 'timeline watermark source stays paired with its high-water time');

INSERT INTO public.email_sends (id, template_slug, resend_id, status, source)
VALUES ('10000000-0000-4000-8000-000000000099', 'commerce-invoice-document', 'resend-converge-3', 'sent', 'collision-test');
SELECT throws_ok(
  $$SELECT public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000003', 'resend-converge-3', 'email.delivered', now(),
    '{"providerEventId":"evt-collision","source":"test"}'::jsonb
  )$$,
  '23505',
  'communication_email_provider_message_collision',
  'provider message id cannot belong to two sends'
);

INSERT INTO public.email_events (id, send_id, event_type, timestamp, metadata)
VALUES (
  '30000000-0000-4000-8000-000000000004',
  '10000000-0000-4000-8000-000000000004',
  'delivered',
  '2026-07-16T14:00:00Z',
  '{"source":"legacy-webhook"}'::jsonb
);
SELECT is(
  public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000004', 'resend-converge-4', 'email.delivered',
    '2026-07-16T14:00:00Z',
    '{"email_event_id":"30000000-0000-4000-8000-000000000004","source":"legacy-webhook"}'::jsonb
  ),
  1,
  'legacy pre-inserted webhook event remains compatible'
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000004'), 'delivered', 'legacy event converges send');

SELECT is(
  public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000004', 'resend-converge-4', 'email.suppressed',
    '2026-07-16T15:00:00Z', '{"providerEventId":"evt-tester-fallback","source":"test"}'::jsonb
  ),
  1,
  'suppression without provider recipient converges through tester fallback'
);
SELECT is(
  (SELECT normalized_email FROM public.communication_provider_events WHERE provider_kind = 'resend' AND provider_event_id = 'evt-tester-fallback'),
  'tester-fallback@example.com',
  'provider ledger records the tester fallback recipient'
);
SELECT is(
  (SELECT count(*)::integer
     FROM public.communication_permission_events permission_event
     JOIN public.communication_contacts contact ON contact.id = permission_event.contact_id
    WHERE contact.normalized_email = 'tester-fallback@example.com'
      AND permission_event.state = 'suppressed'),
  2,
  'tester fallback suppresses both marketing purposes once'
);

SELECT is(
  public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000006', 'resend-converge-6', 'email.delivered',
    '2026-07-16T15:00:00Z', '{"providerEventId":"evt-no-timeline","source":"test"}'::jsonb
  ),
  0,
  'send without a customer timeline keeps the legacy integer return contract'
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000006'), 'delivered', 'send without timeline still converges atomically');
SELECT is(
  public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000006', 'resend-converge-6', 'email.sent',
    '2026-07-16T14:30:00Z', '{"providerEventId":"evt-no-timeline-stale","source":"test"}'::jsonb
  ),
  0,
  'stale legacy send event keeps the no-timeline return contract'
);
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000006'), 'delivered', 'legacy send without timeline cannot regress after delivery');

SELECT ok(has_function_privilege('service_role', 'public.communication_update_email_delivery_from_provider(uuid,text,text,timestamptz,jsonb)', 'EXECUTE'), 'service role can execute convergence RPC');
SELECT ok(NOT has_function_privilege('anon', 'public.communication_update_email_delivery_from_provider(uuid,text,text,timestamptz,jsonb)', 'EXECUTE'), 'anon cannot execute convergence RPC');
SELECT ok(NOT has_function_privilege('authenticated', 'public.communication_update_email_delivery_from_provider(uuid,text,text,timestamptz,jsonb)', 'EXECUTE'), 'authenticated cannot execute convergence RPC');

CREATE FUNCTION public.test_reject_email_delivery_update()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'forced_timeline_failure';
END;
$$;
CREATE TRIGGER test_reject_email_delivery_update
BEFORE UPDATE ON public.communication_email_deliveries
FOR EACH ROW
WHEN (OLD.id = '20000000-0000-4000-8000-000000000005'::uuid)
EXECUTE FUNCTION public.test_reject_email_delivery_update();

SELECT throws_ok(
  $$SELECT public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000005', 'resend-converge-5', 'email.delivered',
    '2026-07-16T16:00:00Z', '{"providerEventId":"evt-atomic-rollback","source":"test"}'::jsonb
  )$$,
  'P0001',
  'forced_timeline_failure',
  'timeline failure rolls back the atomic convergence statement'
);
SELECT is((SELECT count(*)::integer FROM public.email_events WHERE resend_webhook_id = 'evt-atomic-rollback'), 0, 'failed convergence rolls back event insert');
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000005'), 'sent', 'failed convergence rolls back send projection');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000005'), 'sent', 'failed convergence leaves timeline unchanged');

CREATE FUNCTION public.test_reject_suppression_permission()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.reason = 'email.suppressed' THEN
    RAISE EXCEPTION 'forced_suppression_failure';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER test_reject_suppression_permission
BEFORE INSERT ON public.communication_permission_events
FOR EACH ROW
EXECUTE FUNCTION public.test_reject_suppression_permission();

UPDATE public.email_sends
   SET status = 'sent'
 WHERE id = '10000000-0000-4000-8000-000000000002';
UPDATE public.communication_email_deliveries
   SET status = 'sent'
 WHERE id = '20000000-0000-4000-8000-000000000002';

SELECT throws_ok(
  $$SELECT public.communication_update_email_delivery_from_provider(
    '10000000-0000-4000-8000-000000000002', 'resend-converge-2', 'email.suppressed',
    '2026-07-16T17:00:00Z',
    '{"providerEventId":"evt-suppression-rollback","source":"test","eventMetadata":{"email":"rollback-suppression@example.com"}}'::jsonb
  )$$,
  'P0001',
  'forced_suppression_failure',
  'permission failure rolls back the whole convergence RPC'
);
SELECT is((SELECT count(*)::integer FROM public.email_events WHERE resend_webhook_id = 'evt-suppression-rollback'), 0, 'permission failure rolls back email event');
SELECT is((SELECT count(*)::integer FROM public.communication_provider_events WHERE provider_kind = 'resend' AND provider_event_id = 'evt-suppression-rollback'), 0, 'permission failure rolls back provider idempotency ledger');
SELECT is((SELECT status FROM public.email_sends WHERE id = '10000000-0000-4000-8000-000000000002'), 'sent', 'permission failure rolls back send projection');
SELECT is((SELECT status FROM public.communication_email_deliveries WHERE id = '20000000-0000-4000-8000-000000000002'), 'sent', 'permission failure rolls back timeline projection');

SELECT * FROM finish();
ROLLBACK;
