-- Email execution ownership is admission → claim → identity commit → settlement.
BEGIN;
SELECT no_plan();
INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES
 ('a1240000-0000-4000-8000-000000000001','r4-admitter@example.invalid','admin',false),
 ('a1240000-0000-4000-8000-000000000002','r4-resumer@example.invalid','admin',false);
INSERT INTO public.platform_communication_operators(principal_id,active) VALUES
 ('a1240000-0000-4000-8000-000000000001',true),('a1240000-0000-4000-8000-000000000002',true);
INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES ('a1250000-0000-4000-8000-000000000001','r4-old@example.invalid','{}');
INSERT INTO public.clients(id,email,auth_user_id) VALUES
 ('a1260000-0000-4000-8000-000000000001','r4-old@example.invalid','a1250000-0000-4000-8000-000000000001');
CREATE TEMP TABLE _r4_claims(label text PRIMARY KEY,response jsonb);
GRANT SELECT,INSERT,UPDATE ON _r4_claims TO service_role;
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_admit_subject_email_v1('a1240000-0000-4000-8000-000000000001','a1260000-0000-4000-8000-000000000001',
 ' R4-OLD@example.invalid ',' R4-NEW@example.invalid ','r4-email-ordered',NULL)->>'outcome','admitted','normalized email admitted before identity writes');
SELECT is(public.customer_support_admit_subject_email_v1('a1240000-0000-4000-8000-000000000002','a1260000-0000-4000-8000-000000000001',
 'r4-old@example.invalid','r4-new@example.invalid','r4-email-ordered',NULL)->>'outcome','pending','another authorized human can resume the pending command');
INSERT INTO _r4_claims SELECT 'first',public.customer_support_claim_subject_email_v1('r4-email-ordered');
SELECT is((SELECT response->>'outcome' FROM _r4_claims WHERE label='first'),'claimed','service claim owns execution');
SELECT is(public.customer_support_claim_subject_email_v1('r4-email-ordered')->>'outcome','pending','live lease excludes a second claimant');
SELECT throws_ok($$SELECT public.customer_support_settle_subject_email_v1('r4-email-ordered','a1270000-0000-4000-8000-000000000099','complete')$$,
 '55000','customer_support_email_correction_claim_stale','different token cannot settle');
SELECT is(public.customer_support_settle_subject_email_v1('r4-email-ordered',(SELECT (response->>'claimToken')::uuid FROM _r4_claims WHERE label='first'),'release')->>'outcome',
 'pending','release clears execution authority without claiming completion');
INSERT INTO _r4_claims SELECT 'second',public.customer_support_claim_subject_email_v1('r4-email-ordered');
RESET ROLE;
SELECT isnt((SELECT response->>'claimToken' FROM _r4_claims WHERE label='first'),(SELECT response->>'claimToken' FROM _r4_claims WHERE label='second'),'reclaimed token is fresh');
SELECT throws_ok($q$DO $guard$ BEGIN
 UPDATE auth.users SET email='r4-new@example.invalid',raw_app_meta_data=jsonb_build_object('operator_email_correction',
 (SELECT jsonb_build_object('idempotencyKey','r4-email-ordered','claimToken',response->>'claimToken','sequence',response->>'sequence') FROM _r4_claims WHERE label='first'))
 WHERE id='a1250000-0000-4000-8000-000000000001';
 SET CONSTRAINTS ALL IMMEDIATE;
 END $guard$$q$,'55000','customer_support_email_correction_claim_stale','released provider claim cannot commit a delayed identity write');
SELECT is((SELECT email FROM auth.users WHERE id='a1250000-0000-4000-8000-000000000001'),'r4-old@example.invalid','stale claim rolls identity update back');
UPDATE public.customer_support_subscription_commands SET email_claim_until=clock_timestamp()-interval '1 second' WHERE idempotency_key='r4-email-ordered';
SELECT throws_ok($q$DO $guard$ BEGIN
 UPDATE auth.users SET email='r4-new@example.invalid',raw_app_meta_data=jsonb_build_object('operator_email_correction',
 (SELECT jsonb_build_object('idempotencyKey','r4-email-ordered','claimToken',response->>'claimToken','sequence',response->>'sequence') FROM _r4_claims WHERE label='second'))
 WHERE id='a1250000-0000-4000-8000-000000000001';
 SET CONSTRAINTS ALL IMMEDIATE;
 END $guard$$q$,'55000','customer_support_email_correction_claim_stale','expired execution lease cannot commit an identity write with its otherwise valid token');
SELECT is((SELECT email FROM auth.users WHERE id='a1250000-0000-4000-8000-000000000001'),'r4-old@example.invalid','expired provider write rolls back independently of settlement');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.customer_support_settle_subject_email_v1('r4-email-ordered',(SELECT (response->>'claimToken')::uuid FROM _r4_claims WHERE label='second'),'complete')$$,
 '55000','customer_support_email_correction_claim_stale','expired lease cannot settle');
INSERT INTO _r4_claims SELECT 'third',public.customer_support_claim_subject_email_v1('r4-email-ordered');
RESET ROLE;
SELECT is((SELECT response->>'sequence' FROM _r4_claims WHERE label='third'),(SELECT response->>'sequence' FROM _r4_claims WHERE label='first'),'reclaim retains the original admission sequence');
UPDATE auth.users SET email='r4-new@example.invalid',raw_app_meta_data=jsonb_build_object('operator_email_correction',
 (SELECT jsonb_build_object('idempotencyKey','r4-email-ordered','claimToken',response->>'claimToken','sequence',response->>'sequence') FROM _r4_claims WHERE label='third'))
 WHERE id='a1250000-0000-4000-8000-000000000001';
SET CONSTRAINTS ALL IMMEDIATE;
SET CONSTRAINTS ALL DEFERRED;
SELECT ok((SELECT NOT (raw_app_meta_data ? 'operator_email_correction') FROM auth.users WHERE id='a1250000-0000-4000-8000-000000000001'),'guard consumes claim metadata before identity commit');
SELECT is((SELECT email FROM public.clients WHERE id='a1260000-0000-4000-8000-000000000001'),'r4-old@example.invalid','identity move alone does not settle the contact copy');
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_settle_subject_email_v1('r4-email-ordered',(SELECT (response->>'claimToken')::uuid FROM _r4_claims WHERE label='third'),'complete')->>'outcome',
 'applied','claimed identity and client settlement complete');
SELECT is(public.customer_support_admit_subject_email_v1('a1240000-0000-4000-8000-000000000001','a1260000-0000-4000-8000-000000000001',
 'r4-old@example.invalid','r4-new@example.invalid','r4-email-ordered',NULL)->>'outcome','replayed','original actor replays terminal key');
SELECT throws_ok($$SELECT public.customer_support_admit_subject_email_v1('a1240000-0000-4000-8000-000000000002','a1260000-0000-4000-8000-000000000001',
 'r4-old@example.invalid','r4-new@example.invalid','r4-email-ordered',NULL)$$,'23505','customer_support_idempotency_conflict','terminal key retains original actor ownership');
RESET ROLE;
SELECT is((SELECT operator_id::text FROM public.customer_support_subscription_commands WHERE idempotency_key='r4-email-ordered'),
 'a1240000-0000-4000-8000-000000000001','resumption never rewrites original attribution');
SELECT is((SELECT email FROM public.clients WHERE id='a1260000-0000-4000-8000-000000000001'),'r4-new@example.invalid','both email copies agree');
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_admit_subject_email_v1('a1240000-0000-4000-8000-000000000001','a1260000-0000-4000-8000-000000000001',
 'r4-new@example.invalid','r4-failed@example.invalid','r4-email-failed',NULL)->>'outcome','admitted','second correction admitted');
INSERT INTO _r4_claims SELECT 'failed',public.customer_support_claim_subject_email_v1('r4-email-failed');
SELECT is(public.customer_support_settle_subject_email_v1('r4-email-failed',(SELECT (response->>'claimToken')::uuid FROM _r4_claims WHERE label='failed'),'fail')->>'outcome',
 'failed','confirmed identity refusal records durable failure');
SELECT is(public.customer_support_claim_subject_email_v1('r4-email-failed')->>'outcome','failed','failed execution cannot be reclaimed');
RESET ROLE;
SELECT is((SELECT outcome FROM public.customer_support_subscription_audit_events WHERE idempotency_key='r4-email-failed'),'refused','failed execution has a refused support audit');
SELECT is((SELECT email FROM auth.users WHERE id='a1250000-0000-4000-8000-000000000001'),'r4-new@example.invalid','failed execution preserves the prior identity');
SELECT * FROM finish();
ROLLBACK;
