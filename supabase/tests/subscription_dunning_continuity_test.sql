-- Managed M2: prospective exhaustion and one-use repair of the original obligation. These
-- assertions exercise actual due selection and provider admission, including a
-- newer competing method and the old webhook after an authorized attempt fails.
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

SELECT no_plan();
INSERT INTO public.clients(id,email) VALUES
 ('e1100000-0000-4000-8000-000000000001','active-repair@example.invalid'),
 ('e1100000-0000-4000-8000-000000000002','foreign-repair@example.invalid');
INSERT INTO public.subscriptions(id,client_id,cadence_days,currency,status,started_at,next_cycle_at)
VALUES('e1200000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001',28,'XTS','active',now()-interval '40 days',now()-interval '12 days');
INSERT INTO public.subscription_cycles(id,subscription_id,cycle_number,scheduled_at,status,engine_idempotency_key,retry_attempt)
VALUES('e1300000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000001',2,now()-interval '12 days','payment_failed','active-repair-original-cycle',4);
INSERT INTO public.commerce_orders(id,client_id,currency,region_code,status,total_cents,subtotal_cents,mode,subscription_id,subscription_cycle_id)
VALUES('e1400000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001','XTS','ZZ','draft',2680,2680,'subscription_cycle','e1200000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001');
SET LOCAL ROLE service_role;
CREATE TEMP TABLE _ari AS SELECT (public.commerce_payment_control_create_intent(
 'active-repair-intent','subscription_cycle','e1400000-0000-4000-8000-000000000001',
 'e1200000-0000-4000-8000-000000000001','e1300000-0000-4000-8000-000000000001',2680,'XTS','{}')#>>'{paymentIntent,id}')::uuid id;
RESET ROLE;
UPDATE public.commerce_orders SET status='pending_payment' WHERE id='e1400000-0000-4000-8000-000000000001';
SET LOCAL ROLE service_role;
CREATE TEMP TABLE _ard AS SELECT public.subscription_handle_payment_failure_dunning(
 'active-repair-exhaustion','e1300000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000001',
 'e1400000-0000-4000-8000-000000000001',(SELECT id FROM _ari),4,NULL,'card_declined',now(), NULL, pg_temp.fixture_failed_attempt((SELECT id FROM _ari), 'e1300000-0000-4000-8000-000000000001', 4)) r;
RESET ROLE;
CREATE TEMP TABLE _art AS SELECT (r#>>'{subscriptionDunning,caseId}')::uuid case_id,
 split_part(r#>>'{subscriptionDunning,recoveryUrlPath}','token=',2) raw FROM _ard;
GRANT SELECT ON TABLE _art TO service_role;
SELECT is((SELECT status FROM public.subscriptions WHERE id='e1200000-0000-4000-8000-000000000001'),'active','exhaustion preserves active subscription');
SELECT is((SELECT r#>>'{subscriptionDunning,status}' FROM _ard),'open','same case remains open');
SELECT is((SELECT next_retry_at FROM public.subscription_cycles WHERE id='e1300000-0000-4000-8000-000000000001'),NULL::timestamptz,'exhaustion retains null retry');
SELECT is((SELECT expired_at FROM public.subscription_dunning_cases WHERE id=(SELECT case_id FROM _art)),NULL::timestamptz,'open repair has no expiry stamp');
SELECT is((SELECT r#>>'{subscriptionDunning,recoveryTokenPurpose}' FROM _ard),'repair_payment','exhaustion authorizes repair, never legacy resume');
SELECT is((SELECT count(*)::integer FROM public.subscription_events WHERE subscription_id='e1200000-0000-4000-8000-000000000001' AND event_type='subscription.paused'),0,'no automatic pause event');
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.subscription_list_due_for_renewal(50,now()) WHERE subscription_id='e1200000-0000-4000-8000-000000000001'),0,'exhaustion creates no fifth automatic slot');
RESET ROLE;
INSERT INTO public.commerce_payment_method_refs(id,client_id,subscription_id,provider_kind,method_kind,provider_customer_ref,provider_method_ref,status,active,consent_snapshot,updated_at)
VALUES('e1500000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000001','example','card','cus_repair','pm_repair','active',true,jsonb_build_object('recoveryCaseId',(SELECT case_id FROM _art)),now());
SET LOCAL ROLE service_role;
SELECT is((public.subscription_try_schedule_recovery_retry((SELECT case_id FROM _art),'pm_repair',now(),'method_ref_webhook')->>'scheduled')::boolean,false,'usable method alone cannot reopen exhaustion');
RESET ROLE;
DELETE FROM public.commerce_payment_method_refs WHERE id='e1500000-0000-4000-8000-000000000001';
SET LOCAL ROLE service_role;
CREATE TEMP TABLE _arr AS SELECT public.subscription_record_payment_recovery_request('active-repair-redeem',(SELECT raw FROM _art),'pm_repair','card',now()) r;
RESET ROLE;
SELECT is((SELECT r#>>'{subscriptionPaymentRecovery,nextAction}' FROM _arr),'retry_existing_cycle','fresh redeem repairs original cycle');
SELECT is((SELECT next_retry_at FROM public.subscription_cycles WHERE id='e1300000-0000-4000-8000-000000000001'),NULL::timestamptz,'redeem without durable method cannot schedule');
INSERT INTO public.commerce_payment_method_refs(id,client_id,subscription_id,provider_kind,method_kind,provider_customer_ref,provider_method_ref,status,active,consent_snapshot,updated_at)
VALUES('e1500000-0000-4000-8000-000000000001','e1100000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000001','example','card','cus_repair','pm_repair','active',true,jsonb_build_object('recoveryCaseId',(SELECT case_id FROM _art)),now());
SET LOCAL ROLE service_role;
SELECT is((public.subscription_try_schedule_recovery_retry((SELECT case_id FROM _art),'pm_repair',now(),'method_ref_webhook')->>'scheduled')::boolean,true,'webhook after redeem converges on the same cycle');
RESET ROLE;

SELECT is((SELECT retry_attempt FROM public.subscription_cycles WHERE id='e1300000-0000-4000-8000-000000000001'),4,'authorization never resets retry budget');
SELECT is((SELECT total_cents FROM public.commerce_orders WHERE id='e1400000-0000-4000-8000-000000000001'),2680,'original frozen money is unchanged');
SELECT is((SELECT idempotency_key FROM public.subscription_events
 WHERE subscription_id='e1200000-0000-4000-8000-000000000001' AND event_type='subscription.retry_scheduled'),
 'payment-recovery-retry:' || (SELECT case_id::text FROM _art) || ':token:' ||
 (SELECT id::text FROM public.subscription_payment_recovery_tokens WHERE token_hash=encode(sha256(convert_to((SELECT raw FROM _art),'UTF8')),'hex')),
 'exhausted authorization event key is byte-for-byte case and one-use token identity');
-- A competing rotation is newer. It cannot replace the authorized method.
UPDATE public.commerce_payment_method_refs SET active=false WHERE id='e1500000-0000-4000-8000-000000000001';
INSERT INTO public.commerce_payment_method_refs(id,client_id,subscription_id,provider_kind,method_kind,provider_customer_ref,provider_method_ref,status,active,consent_snapshot,updated_at)
VALUES('e1500000-0000-4000-8000-000000000002','e1100000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000001','example','card','cus_rotated','pm_rotated','active',true,jsonb_build_object('recoveryCaseId',(SELECT case_id FROM _art)),now()+interval '1 minute');
SET LOCAL ROLE service_role;
SELECT is((SELECT provider_method_ref FROM public.subscription_list_due_for_renewal(50,now()) WHERE subscription_id='e1200000-0000-4000-8000-000000000001'),NULL::text,'due reader never substitutes the newer method after authorized method is deactivated');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.commerce_payment_control_prepare_provider_attempt('active-repair-wrongmethod',(SELECT id FROM _ari),'example','repair-provider-key-wrong','repair-fingerprint-wrong','off_session_payment','pm_rotated','{}')$$,'55000','payment_control_recovery_authority_invalid','actual admission refuses substituted method');
RESET ROLE;
UPDATE public.commerce_payment_method_refs SET active=false WHERE id='e1500000-0000-4000-8000-000000000002';
UPDATE public.commerce_payment_method_refs SET active=true WHERE id='e1500000-0000-4000-8000-000000000001';
UPDATE public.commerce_payment_method_refs SET client_id='e1100000-0000-4000-8000-000000000002' WHERE id='e1500000-0000-4000-8000-000000000001';
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.commerce_payment_control_prepare_provider_attempt('active-repair-foreign',(SELECT id FROM _ari),'example','repair-provider-key','repair-fingerprint','off_session_payment','pm_repair','{}')$$,'55000','payment_control_recovery_authority_invalid','actual admission refuses foreign client');
RESET ROLE;
UPDATE public.commerce_payment_method_refs SET client_id='e1100000-0000-4000-8000-000000000001',active=false WHERE id='e1500000-0000-4000-8000-000000000001';
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.commerce_payment_control_prepare_provider_attempt('active-repair-inactive',(SELECT id FROM _ari),'example','repair-provider-key','repair-fingerprint','off_session_payment','pm_repair','{}')$$,'55000','payment_control_recovery_authority_invalid','actual admission refuses inactive method');
RESET ROLE;
UPDATE public.commerce_payment_method_refs SET active=true WHERE id='e1500000-0000-4000-8000-000000000001';
UPDATE public.subscription_payment_recovery_tokens SET expires_at=now()-interval '1 second' WHERE case_id=(SELECT case_id FROM _art);
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.commerce_payment_control_prepare_provider_attempt('active-repair-expired',(SELECT id FROM _ari),'example','repair-provider-key','repair-fingerprint','off_session_payment','pm_repair','{}')$$,'55000','payment_control_recovery_authority_invalid','expired authority cannot reach provider');
RESET ROLE;
UPDATE public.subscription_payment_recovery_tokens SET expires_at=now()+interval '30 days' WHERE case_id=(SELECT case_id FROM _art);
UPDATE public.subscription_payment_recovery_tokens SET metadata=jsonb_set(metadata,'{authorizedRetryAttempt}','3') WHERE case_id=(SELECT case_id FROM _art);
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.commerce_payment_control_prepare_provider_attempt('active-repair-stale-rung',(SELECT id FROM _ari),'example','repair-stale-key','repair-stale-fingerprint','off_session_payment','pm_repair','{}')$$,'55000','payment_control_recovery_authority_invalid','authority from another retry rung cannot charge');
RESET ROLE;
UPDATE public.subscription_payment_recovery_tokens SET metadata=jsonb_set(metadata,'{authorizedRetryAttempt}','4') WHERE case_id=(SELECT case_id FROM _art);
SET LOCAL ROLE service_role;
CREATE TEMP TABLE _arp AS SELECT public.commerce_payment_control_prepare_provider_attempt('active-repair-prepare',(SELECT id FROM _ari),'example','repair-provider-key','repair-fingerprint','off_session_payment','pm_repair','{}') r;
RESET ROLE;
SELECT is((SELECT request_payload->>'paymentMethodRef' FROM public.commerce_payment_attempts WHERE id=(SELECT (r#>>'{paymentAttempt,id}')::uuid FROM _arp)),'pm_repair','durable dispatched attempt carries exact authorized method');
SET LOCAL ROLE service_role;
SELECT public.commerce_payment_control_finalize_provider_attempt('active-repair-finalize',(SELECT id FROM _ari),(SELECT (r#>>'{paymentAttempt,id}')::uuid FROM _arp),'repair-provider-key','repair-fingerprint','pi_repair_failed',NULL,'processing',NULL,'{}','{}');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT public.commerce_payment_control_apply_result('active-repair-failed',(SELECT id FROM _ari),NULL,'failed',now(),'card_declined','soft_retryable','advice_code');
RESET ROLE;
SELECT is((SELECT retry_attempt FROM public.subscription_cycles WHERE id='e1300000-0000-4000-8000-000000000001'),5,'failed authorized attempt advances existing counter');
SELECT is((SELECT next_retry_at FROM public.subscription_cycles WHERE id='e1300000-0000-4000-8000-000000000001'),NULL::timestamptz,'failure creates no new automatic attempt');
SET LOCAL ROLE service_role;
SELECT public.subscription_handle_payment_failure_dunning('active-repair-failed-dunning','e1300000-0000-4000-8000-000000000001','e1200000-0000-4000-8000-000000000001','e1400000-0000-4000-8000-000000000001',(SELECT id FROM _ari),5,NULL,'card_declined',now(), NULL, pg_temp.fixture_failed_attempt((SELECT id FROM _ari), 'e1300000-0000-4000-8000-000000000001', 5));
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT is((public.subscription_try_schedule_recovery_retry((SELECT case_id FROM _art),'pm_repair',now(),'method_ref_webhook')->>'scheduled')::boolean,false,'old webhook cannot rearm failed repair');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT is((public.subscription_record_payment_recovery_request('active-repair-redeem',(SELECT raw FROM _art),'pm_repair','card',now())#>>'{subscriptionPaymentRecovery,replayed}')::boolean,true,'exact old redeem is read-only replay');
RESET ROLE;
SELECT is((SELECT next_retry_at FROM public.subscription_cycles WHERE id='e1300000-0000-4000-8000-000000000001'),NULL::timestamptz,'replays preserve exhausted NULL schedule');
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.subscription_list_due_for_renewal(50,now()) WHERE subscription_id='e1200000-0000-4000-8000-000000000001'),0,'real due reader stays empty after failed repair and replay');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.subscription_cycles WHERE subscription_id='e1200000-0000-4000-8000-000000000001'),1,'no new debt cycle');
SELECT is((SELECT count(*)::integer FROM public.commerce_orders WHERE subscription_id='e1200000-0000-4000-8000-000000000001'),1,'no replacement unpaid order');
SELECT is((SELECT count(*)::integer FROM public.commerce_fulfillment_orders WHERE order_id='e1400000-0000-4000-8000-000000000001'),0,'no unpaid parcel');
-- Fresh authority admits another explicit attempt on that very same obligation.
CREATE TEMP TABLE _arnew AS SELECT split_part(recovery_url_path,'token=',2) raw FROM public.subscription_dunning_notifications
 WHERE case_id=(SELECT case_id FROM _art) AND recipient_kind='customer' AND retry_attempt=5;
GRANT SELECT ON TABLE _arnew TO service_role;
SET LOCAL ROLE service_role;
SELECT public.subscription_record_payment_recovery_request('active-repair-second-redeem',(SELECT raw FROM _arnew),'pm_repair','card',now());
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT is((SELECT count(*)::integer FROM public.subscription_list_due_for_renewal(50,now()) WHERE subscription_id='e1200000-0000-4000-8000-000000000001'),1,'fresh one-use authority admits same-cycle attempt');
RESET ROLE;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE _arp2 AS SELECT public.commerce_payment_control_prepare_provider_attempt('active-repair-prepare-second',(SELECT id FROM _ari),'example','repair-provider-key-second','repair-fingerprint-second','off_session_payment','pm_repair','{}') r;
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT public.commerce_payment_control_finalize_provider_attempt('active-repair-finalize-second',(SELECT id FROM _ari),(SELECT (r#>>'{paymentAttempt,id}')::uuid FROM _arp2),'repair-provider-key-second','repair-fingerprint-second','pi_repair_paid',NULL,'processing',NULL,'{}','{}');
RESET ROLE;
SET LOCAL ROLE service_role;
SELECT public.commerce_payment_control_apply_result('active-repair-paid',(SELECT id FROM _ari),NULL,'succeeded',now(),NULL);
RESET ROLE;
SELECT is((SELECT status FROM public.subscription_cycles WHERE id='e1300000-0000-4000-8000-000000000001'),'paid','same frozen cycle is actually settled');
SELECT is((SELECT status FROM public.subscription_dunning_cases WHERE id=(SELECT case_id FROM _art)),'recovered','money success closes the case');
SELECT ok((SELECT next_cycle_at >= now()+interval '27 days' FROM public.subscriptions WHERE id='e1200000-0000-4000-8000-000000000001'),'late success shifts cadence later');
SELECT * FROM finish();
ROLLBACK;
