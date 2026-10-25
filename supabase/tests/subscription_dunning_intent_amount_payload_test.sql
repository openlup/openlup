-- pgTAP: subscription payment-failed dunning payload uses the attempted
-- payment intent amount, not the order total snapshot.

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

SELECT plan(5);

INSERT INTO public.clients (id, email)
VALUES ('df000000-0000-0000-0000-000000000001', 'dunning-intent-amount@example.invalid');

INSERT INTO public.subscriptions (id, client_id, cadence_days, currency, status, started_at, next_cycle_at)
VALUES ('df100000-0000-0000-0000-000000000001', 'df000000-0000-0000-0000-000000000001', 30, 'PLN', 'active',
        '2026-05-01T00:00:00Z', '2026-06-01T00:00:00Z');

INSERT INTO public.subscription_cycles (id, subscription_id, cycle_number, scheduled_at, status, engine_idempotency_key, retry_attempt)
VALUES ('df1c0000-0000-0000-0000-000000000001', 'df100000-0000-0000-0000-000000000001', 2,
        '2026-06-01T00:00:00Z', 'planned', 'dunning-intent-amount-cycle', 1);

INSERT INTO public.commerce_orders (id, client_id, currency, region_code, size_constraint, status, total_cents, subtotal_cents, mode, subscription_id, subscription_cycle_id)
VALUES ('df1d0000-0000-0000-0000-000000000001', 'df000000-0000-0000-0000-000000000001', 'PLN', 'PL',
        '{"kind":"feeding_days","value":21}'::jsonb, 'draft', 12999, 12999, 'subscription_cycle',
        'df100000-0000-0000-0000-000000000001', 'df1c0000-0000-0000-0000-000000000001');

INSERT INTO public.commerce_payments (id, order_id, provider, provider_payment_id, status, amount_cents, currency)
VALUES ('df200000-0000-0000-0000-000000000001', 'df1d0000-0000-0000-0000-000000000001',
        'tpay', 'df-intent-amount-payment', 'failed', 7777, 'PLN');

INSERT INTO public.commerce_payment_intents (
  id,
  target_kind,
  order_id,
  subscription_id,
  subscription_cycle_id,
  payment_id,
  status,
  amount_cents,
  currency,
  provider_payment_id
)
VALUES (
  'df300000-0000-0000-0000-000000000001',
  'subscription_cycle',
  'df1d0000-0000-0000-0000-000000000001',
  'df100000-0000-0000-0000-000000000001',
  'df1c0000-0000-0000-0000-000000000001',
  'df200000-0000-0000-0000-000000000001',
  'failed',
  7777,
  'PLN',
  'df-intent-amount-payment'
);

SELECT public.subscription_handle_payment_failure_dunning(
  'dunning-intent-amount-case',
  'df1c0000-0000-0000-0000-000000000001',
  'df100000-0000-0000-0000-000000000001',
  'df1d0000-0000-0000-0000-000000000001',
  'df300000-0000-0000-0000-000000000001',
  1, '2026-06-20T00:00:00Z'::timestamptz, 'card_declined', '2026-06-12T12:00:00Z'::timestamptz
, NULL, pg_temp.fixture_failed_attempt('df300000-0000-0000-0000-000000000001', 'df1c0000-0000-0000-0000-000000000001', 1));

SELECT is(
  (SELECT count(*)::int FROM public.subscription_dunning_notifications
    WHERE recipient_kind = 'customer'
      AND template_slug = 'subscription-payment-failed-1'),
  1,
  'customer payment-failed notification is still queued for a confirmed failed attempt');

SELECT is(
  (SELECT (payload->>'amountMinor')::int FROM public.subscription_dunning_notifications
    WHERE recipient_kind = 'customer'
      AND template_slug = 'subscription-payment-failed-1'),
  7777,
  'customer amountMinor comes from the payment intent, not commerce_orders.total_cents');

SELECT is(
  (SELECT payload->>'currency' FROM public.subscription_dunning_notifications
    WHERE recipient_kind = 'customer'
      AND template_slug = 'subscription-payment-failed-1'),
  'PLN',
  'customer payload currency is retained from the payment intent');

SELECT is(
  (SELECT payload->>'amountSource' FROM public.subscription_dunning_notifications
    WHERE recipient_kind = 'customer'
      AND template_slug = 'subscription-payment-failed-1'),
  'commerce_payment_intents.amount_cents',
  'customer payload records the authoritative amount source');

SELECT isnt(
  (SELECT (payload->>'amountMinor')::int FROM public.subscription_dunning_notifications
    WHERE recipient_kind = 'customer'
      AND template_slug = 'subscription-payment-failed-1'),
  12999,
  'customer payload does not leak the stale order total');

SELECT * FROM finish();
ROLLBACK;
