-- Managed attempt observation: real payment applications, canonical replay and authority fencing.
BEGIN;
SELECT no_plan();
INSERT INTO public.clients(id,email) VALUES
 ('a9100000-0000-4000-8000-000000000001','attempt-replay@example.invalid');
INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,status,started_at,next_cycle_at)
VALUES('a9200000-0000-4000-8000-000000000001','a9100000-0000-4000-8000-000000000001',28,'XTS','active',now()-interval '40 days',now()-interval '12 days');
INSERT INTO public.subscription_cycles(id,subscription_id,cycle_number,scheduled_at,status,engine_idempotency_key,retry_attempt)
VALUES('a9300000-0000-4000-8000-000000000001','a9200000-0000-4000-8000-000000000001',2,now()-interval '12 days','payment_failed','attempt-replay-cycle',0);
INSERT INTO public.commerce_orders(id,client_id,currency,region_code,status,total_cents,subtotal_cents,mode,subscription_id,subscription_cycle_id)
VALUES('a9400000-0000-4000-8000-000000000001','a9100000-0000-4000-8000-000000000001','XTS','ZZ','draft',2400,2400,'subscription_cycle','a9200000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-000000000001');
CREATE TEMP TABLE replay_intent AS SELECT (public.commerce_payment_control_create_intent(
 'attempt-replay-intent','subscription_cycle','a9400000-0000-4000-8000-000000000001',
 'a9200000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-000000000001',2400,'XTS','{}')#>>'{paymentIntent,id}')::uuid id;
UPDATE public.commerce_orders SET status='pending_payment' WHERE id='a9400000-0000-4000-8000-000000000001';
CREATE FUNCTION pg_temp.failed_attempt(key text) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.commerce_payment_control_record_attempt(key||':record',(SELECT id FROM replay_intent),'example',NULL,NULL,'processing',NULL,'{}','{}');
  result := public.commerce_payment_control_apply_result(key||':apply',(SELECT id FROM replay_intent),NULL,'failed',now(),'declined','soft_retryable','test');
  RETURN (result#>>'{paymentResult,paymentAttemptId}')::uuid;
END;
$$;
CREATE TEMP TABLE replay_attempts AS SELECT 'A'::text name, pg_temp.failed_attempt('attempt-A') id;
CREATE FUNCTION pg_temp.observe_attempt(key text, attempt uuid, rung integer DEFAULT NULL, class text DEFAULT 'soft_retryable') RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.subscription_handle_payment_failure_dunning('observation:'||key,
    'a9300000-0000-4000-8000-000000000001','a9200000-0000-4000-8000-000000000001',
    'a9400000-0000-4000-8000-000000000001',(SELECT id FROM replay_intent),
    COALESCE(rung,(SELECT retry_attempt FROM public.subscription_cycles WHERE id='a9300000-0000-4000-8000-000000000001')),
    (SELECT next_retry_at FROM public.subscription_cycles WHERE id='a9300000-0000-4000-8000-000000000001'),
    'declined',now(),class,attempt);
$$;
CREATE TEMP TABLE first_observation AS SELECT pg_temp.observe_attempt('first-A',(SELECT id FROM replay_attempts WHERE name='A')) result;
CREATE TEMP TABLE replay_case AS SELECT (result#>>'{subscriptionDunning,caseId}')::uuid id FROM first_observation;
UPDATE public.subscription_dunning_notifications SET status='sent',sent_at=now() WHERE case_id=(SELECT id FROM replay_case) AND recipient_kind='customer';
CREATE TEMP TABLE case_before AS SELECT to_jsonb(c) row FROM public.subscription_dunning_cases c WHERE id=(SELECT id FROM replay_case);
CREATE TEMP TABLE tokens_before AS SELECT jsonb_agg(to_jsonb(t) ORDER BY id) rows FROM public.subscription_payment_recovery_tokens t;
CREATE TEMP TABLE notice_count AS SELECT count(*) n FROM public.subscription_dunning_notifications;
CREATE TEMP TABLE duplicate_observation AS SELECT public.subscription_open_dunning_from_failed_payment_result(
 'webhook-A',(SELECT id FROM replay_intent),'event-A','changed diagnostic',now(),'hard_do_not_retry',(SELECT id FROM replay_attempts WHERE name='A')) result;
SELECT is((SELECT result#>>'{subscriptionWebhookDunning,replayed}' FROM duplicate_observation),'true','another observation key replays applied A');
SELECT is((SELECT to_jsonb(c) FROM public.subscription_dunning_cases c WHERE id=(SELECT id FROM replay_case)),(SELECT row FROM case_before),'duplicate preserves complete case, class and schedule');
SELECT is((SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM public.subscription_payment_recovery_tokens t),(SELECT rows FROM tokens_before),'duplicate preserves complete token authority');
SELECT is((SELECT count(*) FROM public.subscription_dunning_notifications),(SELECT n FROM notice_count),'duplicate sends no second notice');
SELECT is((SELECT response_payload#>>'{subscriptionDunning,recoveryUrlPath}' FROM public.commerce_idempotency_keys WHERE scope='subscription.dunning.failure' AND idempotency_key='webhook-A'),(SELECT result#>>'{subscriptionDunning,recoveryUrlPath}' FROM first_observation),'receipt returns original delivered link');
SELECT is((SELECT metadata->>'failedPaymentAttemptId' FROM public.commerce_idempotency_keys WHERE scope='subscription.dunning.failure' AND idempotency_key='webhook-A'),(SELECT id::text FROM replay_attempts WHERE name='A'),'receipt records exact attempt');
CREATE TEMP TABLE redeemed_link AS SELECT public.subscription_record_payment_recovery_request('redeem-A',
 (SELECT split_part(result#>>'{subscriptionDunning,recoveryUrlPath}','token=',2) FROM first_observation),'method-A','card',now()) result;
SELECT is((SELECT result#>>'{subscriptionPaymentRecovery,nextAction}' FROM redeemed_link),'retry_existing_cycle','original delivered link remains redeemable');
SELECT throws_ok($q$SELECT pg_temp.observe_attempt('first-A',(SELECT id FROM replay_attempts WHERE name='A'),3)$q$,'23505','subscription_dunning_idempotency_conflict','same-key fingerprint drift refuses');
SELECT throws_ok($q$SELECT pg_temp.observe_attempt('missing',NULL)$q$,'55000','subscription_dunning_failed_attempt_unattributed','missing attribution refuses');
SELECT ok((SELECT bool_and(revoked_at IS NULL) FROM public.subscription_payment_recovery_tokens),'refusal cannot revoke a used link');
INSERT INTO replay_attempts SELECT 'B',pg_temp.failed_attempt('attempt-B');
CREATE TEMP TABLE next_observation AS SELECT pg_temp.observe_attempt('new-B',(SELECT id FROM replay_attempts WHERE name='B')) result;
SELECT is((SELECT result#>>'{subscriptionDunning,replayed}' FROM next_observation),'false','a newer applied attempt advances');
SELECT is((SELECT count(*) FROM public.subscription_payment_recovery_tokens),2::bigint,'advance creates exactly one link');
SELECT ok((SELECT bool_and(revoked_at IS NOT NULL) FROM public.subscription_payment_recovery_tokens WHERE used_at IS NOT NULL),'advance revokes used older authority');
TRUNCATE case_before;
INSERT INTO case_before SELECT to_jsonb(c) FROM public.subscription_dunning_cases c WHERE id=(SELECT id FROM replay_case);
CREATE TEMP TABLE stale_observation AS SELECT pg_temp.observe_attempt('stale-A',(SELECT id FROM replay_attempts WHERE name='A'),NULL,'hard_do_not_retry') result;
SELECT is((SELECT result#>>'{subscriptionDunning,replayed}' FROM stale_observation),'true','stale A is a replay even when carrying current rung');
SELECT is((SELECT to_jsonb(c) FROM public.subscription_dunning_cases c WHERE id=(SELECT id FROM replay_case)),(SELECT row FROM case_before),'stale A cannot change B class, schedule or canonical result');
SELECT is((SELECT result#>>'{subscriptionDunning,recoveryUrlPath}' FROM stale_observation),(SELECT result#>>'{subscriptionDunning,recoveryUrlPath}' FROM next_observation),'stale A returns canonical B link');
CREATE TEMP TABLE rotated_authority AS SELECT public.subscription_rotate_payment_recovery_token(
 (SELECT id FROM replay_case),encode(sha256(convert_to('account-recovery-authority','UTF8')),'hex'),now()+interval '14 days','customer_payment_recovery_start') id;
SELECT pg_temp.observe_attempt('duplicate-after-rotation',(SELECT id FROM replay_attempts WHERE name='B'));
SELECT ok((SELECT revoked_at IS NULL FROM public.subscription_payment_recovery_tokens WHERE id=(SELECT id FROM rotated_authority)),'duplicate preserves separately rotated account link');
INSERT INTO public.commerce_payment_attempts(payment_intent_id,payment_id,provider,idempotency_key,status,amount_cents,currency)
 SELECT id,payment_id,'example','conflicting-B','failed',amount_cents,currency FROM public.commerce_payment_intents WHERE id=(SELECT id FROM replay_intent);
INSERT INTO public.subscription_events(subscription_id,cycle_id,event_type,payload)
 SELECT 'a9200000-0000-4000-8000-000000000001','a9300000-0000-4000-8000-000000000001','subscription.payment_failed',
 jsonb_build_object('paymentIntentId',(SELECT id FROM replay_intent),'paymentAttemptId',id,'retryAttempt',2,'source','payment.control.v0') FROM public.commerce_payment_attempts WHERE idempotency_key='conflicting-B';
SELECT throws_ok($q$SELECT pg_temp.observe_attempt('equal-rung-conflict',(SELECT id FROM public.commerce_payment_attempts WHERE idempotency_key='conflicting-B'))$q$,'55000','subscription_dunning_failed_attempt_ambiguous','equal-rung distinct identity refuses');
SELECT ok((SELECT revoked_at IS NULL FROM public.subscription_payment_recovery_tokens WHERE id=(SELECT id FROM rotated_authority)),'identity conflict preserves account authority');
SELECT * FROM finish();
ROLLBACK;
