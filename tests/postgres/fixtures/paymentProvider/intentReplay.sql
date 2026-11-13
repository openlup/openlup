BEGIN;
SELECT plan(4);
INSERT INTO public.clients(id,email) VALUES('f0100000-0000-4000-8000-000000000001','intent-replay@example.invalid');
SELECT pg_temp.provider_order('f0200000-0000-4000-8000-000000000001','f0100000-0000-4000-8000-000000000001',100);
SELECT pg_temp.provider_order('f0200000-0000-4000-8000-000000000002','f0100000-0000-4000-8000-000000000001',100);
CREATE TEMP TABLE _intent_replay AS SELECT pg_temp.provider_intent('intent-replay-key','one_time_order','f0200000-0000-4000-8000-000000000001',NULL,NULL,100,'XXX','{}') AS response;
SELECT is((pg_temp.provider_intent('intent-replay-key','one_time_order','f0200000-0000-4000-8000-000000000001',NULL,NULL,100,'XXX','{}')#>>'{paymentIntent,id}'),
 (SELECT response#>>'{paymentIntent,id}' FROM _intent_replay),'same intent request replays its exact identity');
SELECT throws_ok($$SELECT pg_temp.provider_intent('intent-replay-key','one_time_order','f0200000-0000-4000-8000-000000000001',NULL,NULL,101,'XXX','{}')$$,'23505','payment_control_intent_idempotency_conflict','intent replay binds money');
SELECT throws_ok($$SELECT pg_temp.provider_intent('intent-replay-key','one_time_order','f0200000-0000-4000-8000-000000000001',NULL,NULL,100,'XXX','{"changed":true}')$$,'23505','payment_control_intent_idempotency_conflict','intent replay binds metadata');
SELECT throws_ok($$SELECT pg_temp.provider_intent('intent-replay-key','one_time_order','f0200000-0000-4000-8000-000000000002',NULL,NULL,100,'XXX','{}')$$,'23505','payment_control_intent_idempotency_conflict','intent replay binds target');
SELECT * FROM finish();
ROLLBACK;
