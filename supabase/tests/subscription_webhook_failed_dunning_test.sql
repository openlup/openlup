-- pgTAP: webhook-only failed subscription renewal can open an idempotent dunning case.

BEGIN;

-- This isolated fixture states its failed-attempt evidence explicitly. Real applied
-- events take precedence; ambiguous fixture evidence fails instead of guessing.
CREATE FUNCTION pg_temp.fixture_failed_attempt(intent uuid, cycle uuid, rung integer)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_catalog AS $$
DECLARE attempt uuid; matches integer;
BEGIN
  IF cycle IS NULL THEN RETURN NULL; END IF;
  SELECT min(payload->>'paymentAttemptId')::uuid, count(DISTINCT payload->>'paymentAttemptId')
    INTO attempt, matches FROM public.subscription_events
    WHERE cycle_id=cycle AND payload->>'paymentIntentId'=intent::text
      AND payload->>'retryAttempt'=rung::text AND payload->>'source'='payment.control.v0'
      AND event_type IN ('subscription.retry_scheduled','subscription.payment_failed');
  IF matches=1 THEN RETURN attempt; END IF;
  IF matches>1 THEN RAISE EXCEPTION 'conflicting fixture failure evidence'; END IF;
  INSERT INTO public.commerce_payment_attempts(payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
    SELECT id,payment_id,'example','fixture-failure:'||cycle||':'||rung,'failed',amount_cents,currency
      FROM public.commerce_payment_intents WHERE id=intent RETURNING id INTO attempt;
  INSERT INTO public.subscription_events(subscription_id,cycle_id,event_type,payload)
    SELECT subscription_id,id,CASE WHEN next_retry_at IS NULL THEN 'subscription.payment_failed' ELSE 'subscription.retry_scheduled' END,
      jsonb_build_object('paymentIntentId',intent,'paymentAttemptId',attempt,'retryAttempt',rung,'source','payment.control.v0')
      FROM public.subscription_cycles WHERE id=cycle;
  RETURN attempt;
END;
$$;
GRANT EXECUTE ON FUNCTION pg_temp.fixture_failed_attempt(uuid,uuid,integer) TO service_role;

SELECT plan(6);

INSERT INTO public.clients (id, email)
VALUES ('d9010000-0000-4000-8000-000000000001', 'webhook-dunning@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('d9020000-0000-4000-8000-000000000001', 'd9010000-0000-4000-8000-000000000001', 30, 'PLN', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt, next_retry_at)
VALUES ('d9030000-0000-4000-8000-000000000001', 'd9020000-0000-4000-8000-000000000001', 2,
        '2026-06-01T00:00:00Z', 'retry_scheduled', 'webhook-dunning-cycle', 1,
        '2026-06-20T00:00:00Z'::timestamptz);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('d9040000-0000-4000-8000-000000000001', 'd9010000-0000-4000-8000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment', 12999, 12999, 'subscription_cycle',
        'd9020000-0000-4000-8000-000000000001', 'd9030000-0000-4000-8000-000000000001');

CREATE TEMP TABLE _intent AS
SELECT (public.commerce_payment_control_create_intent(
  'webhook-dunning-intent', 'subscription_cycle', 'd9040000-0000-4000-8000-000000000001',
  'd9020000-0000-4000-8000-000000000001', 'd9030000-0000-4000-8000-000000000001', 12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

CREATE TEMP TABLE _first AS
SELECT public.subscription_open_dunning_from_failed_payment_result(
  'webhook-dunning-event-1',
  (SELECT intent_id FROM _intent),
  'provider-event-1',
  'card_declined',
  '2026-06-12T12:00:00Z'::timestamptz
, NULL, pg_temp.fixture_failed_attempt((SELECT intent_id FROM _intent), (SELECT subscription_cycle_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _intent)), (SELECT retry_attempt FROM public.subscription_cycles WHERE id=(SELECT subscription_cycle_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _intent))))) AS result;

SELECT ok((SELECT (result #>> '{subscriptionWebhookDunning,opened}')::boolean FROM _first),
  'webhook failure opens subscription dunning');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_cases
    WHERE subscription_id='d9020000-0000-4000-8000-000000000001'),
  1,
  'one dunning case is created');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_notifications
    WHERE subscription_id='d9020000-0000-4000-8000-000000000001'
      AND recipient_kind='customer'),
  1,
  'customer dunning notification is queued');

CREATE TEMP TABLE _second AS
SELECT public.subscription_open_dunning_from_failed_payment_result(
  'webhook-dunning-event-1',
  (SELECT intent_id FROM _intent),
  'provider-event-1',
  'card_declined',
  '2026-06-12T12:00:00Z'::timestamptz
, NULL, pg_temp.fixture_failed_attempt((SELECT intent_id FROM _intent), (SELECT subscription_cycle_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _intent)), (SELECT retry_attempt FROM public.subscription_cycles WHERE id=(SELECT subscription_cycle_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _intent))))) AS result;

SELECT ok((SELECT (result #>> '{subscriptionWebhookDunning,replayed}')::boolean FROM _second),
  'replayed webhook dunning call is idempotent');

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_cases
    WHERE subscription_id='d9020000-0000-4000-8000-000000000001'),
  1,
  'replay does not create another case');

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode)
VALUES ('d9040000-0000-4000-8000-000000000002', 'd9010000-0000-4000-8000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'pending_payment', 12999, 12999, 'one_time');

CREATE TEMP TABLE _one_time_intent AS
SELECT (public.commerce_payment_control_create_intent(
  'webhook-dunning-one-time-intent', 'one_time_order', 'd9040000-0000-4000-8000-000000000002',
  NULL, NULL, 12999, 'PLN', '{}'::jsonb
) -> 'paymentIntent' ->> 'id')::uuid AS intent_id;

SELECT is(
  public.subscription_open_dunning_from_failed_payment_result(
    'webhook-dunning-one-time',
    (SELECT intent_id FROM _one_time_intent),
    'provider-event-no-sub',
    'card_declined',
    '2026-06-12T12:00:00Z'::timestamptz
  , NULL, pg_temp.fixture_failed_attempt((SELECT intent_id FROM _one_time_intent), (SELECT subscription_cycle_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _one_time_intent)), (SELECT retry_attempt FROM public.subscription_cycles WHERE id=(SELECT subscription_cycle_id FROM public.commerce_payment_intents WHERE id=(SELECT intent_id FROM _one_time_intent))))) #>> '{subscriptionWebhookDunning,reason}',
  'not_subscription_cycle',
  'one-time failed webhook is a dunning no-op'
);

SELECT * FROM finish();
ROLLBACK;
