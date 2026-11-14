BEGIN;
SELECT plan(6);
INSERT INTO public.clients(id,email) VALUES('f1100000-0000-4000-8000-000000000001','duplicate-failure@example.invalid');
SELECT pg_temp.provider_order('f1200000-0000-4000-8000-000000000001','f1100000-0000-4000-8000-000000000001',100);
CREATE TEMP TABLE _duplicate AS SELECT (pg_temp.provider_intent('duplicate-intent','one_time_order','f1200000-0000-4000-8000-000000000001',NULL,NULL,100,'XXX','{}')#>>'{paymentIntent,id}')::uuid AS id;
SELECT public.payment_provider_attempt_record('duplicate-attempt',(SELECT id FROM _duplicate),'card_rail','pi_duplicate',NULL,'processing',NULL,'{}','{}');
SELECT pg_temp.provider_apply('duplicate-first',(SELECT id FROM _duplicate),NULL,'failed','2026-11-13T12:00:00Z','declined');
CREATE TEMP TABLE _duplicate_before AS SELECT count(*)::integer AS n FROM public.commerce_settlement_transitions WHERE intent_id=(SELECT id FROM _duplicate);
SELECT is((pg_temp.provider_apply('duplicate-second',(SELECT id FROM _duplicate),NULL,'failed','2026-11-13T12:00:00Z','declined')#>>'{paymentResult,kind}'),'ignored_duplicate_terminal_failure','duplicate failure is ignored under a different request key');
SELECT is((SELECT count(*)::integer FROM public.commerce_settlement_transitions WHERE intent_id=(SELECT id FROM _duplicate)),(SELECT n FROM _duplicate_before),'duplicate failure cannot emit a second settlement transition');
SELECT is((SELECT count(*)::integer FROM public.payment_truth_events WHERE settlement_intent_id=(SELECT id FROM _duplicate)),1,'duplicate failure cannot invoke the truth effect owner twice');
SELECT pg_temp.provider_subscription_order('f1300000-0000-4000-8000-000000000001','f1400000-0000-4000-8000-000000000001',
 'f1500000-0000-4000-8000-000000000001','f1100000-0000-4000-8000-000000000001','active');
CREATE TEMP TABLE _duplicate_sub AS SELECT (pg_temp.provider_intent('duplicate-sub-intent','subscription_cycle',
 'f1500000-0000-4000-8000-000000000001','f1300000-0000-4000-8000-000000000001','f1400000-0000-4000-8000-000000000001',12999,'XXX','{}')#>>'{paymentIntent,id}')::uuid AS id;
SELECT public.payment_provider_attempt_record('duplicate-sub-attempt',(SELECT id FROM _duplicate_sub),'card_rail','pi_duplicate_sub',NULL,'processing',NULL,'{}','{}');
SELECT pg_temp.provider_apply('duplicate-sub-first',(SELECT id FROM _duplicate_sub),NULL,'failed','2026-11-13T12:00:00Z','declined');
CREATE TEMP TABLE _duplicate_sub_before AS SELECT jsonb_build_array(
 (SELECT to_jsonb(c) FROM public.subscription_cycles c WHERE id='f1400000-0000-4000-8000-000000000001'),
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.subscription_dunning_cases d WHERE cycle_id='f1400000-0000-4000-8000-000000000001'),
 (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM public.subscription_dunning_notifications n WHERE case_id IN (SELECT id FROM public.subscription_dunning_cases WHERE cycle_id='f1400000-0000-4000-8000-000000000001')),
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.subscription_retry_obligations r WHERE cycle_id='f1400000-0000-4000-8000-000000000001')) AS value;
SELECT is(pg_temp.provider_apply('duplicate-sub-second',(SELECT id FROM _duplicate_sub),NULL,'failed','2026-11-14T12:00:00Z','different_writer')#>>'{paymentResult,kind}',
 'ignored_duplicate_terminal_failure','a second subscription failure cannot advance retries twice');
SELECT is(jsonb_build_array(
 (SELECT to_jsonb(c) FROM public.subscription_cycles c WHERE id='f1400000-0000-4000-8000-000000000001'),
 (SELECT jsonb_agg(to_jsonb(d) ORDER BY id) FROM public.subscription_dunning_cases d WHERE cycle_id='f1400000-0000-4000-8000-000000000001'),
 (SELECT jsonb_agg(to_jsonb(n) ORDER BY id) FROM public.subscription_dunning_notifications n WHERE case_id IN (SELECT id FROM public.subscription_dunning_cases WHERE cycle_id='f1400000-0000-4000-8000-000000000001')),
 (SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM public.subscription_retry_obligations r WHERE cycle_id='f1400000-0000-4000-8000-000000000001')),
 (SELECT value FROM _duplicate_sub_before),'duplicate subscription failure leaves cycle, retry and dunning effects unchanged');
SELECT is((SELECT count(*)::integer FROM public.payment_truth_events WHERE settlement_intent_id=(SELECT id FROM _duplicate_sub)),1,
 'duplicate subscription failure does not call the truth effect owner again');
SELECT * FROM finish();
ROLLBACK;
