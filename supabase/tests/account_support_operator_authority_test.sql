-- Managed operator link authority, recovery human fence and retired email entry.
BEGIN;
SELECT no_plan();
INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES
 ('a1200000-0000-4000-8000-000000000001','r4-human@example.invalid','admin',false),
 ('a1200000-0000-4000-8000-000000000002','r4-machine@example.invalid','admin',true),
 ('a1200000-0000-4000-8000-000000000003','r4-inactive@example.invalid','admin',false);
-- Both eligibility arms must be inactive: an active admin bypasses roster.active.
-- Revocation goes through the lifecycle guard's explicit revoke switch.
SET LOCAL app.admin_membership_revoke = 'true';
UPDATE public.admin_users SET membership_state='revoked',membership_revoked_at=now(),
 membership_revoked_by='a1200000-0000-4000-8000-000000000001'
WHERE id='a1200000-0000-4000-8000-000000000003';
RESET app.admin_membership_revoke;
INSERT INTO public.platform_communication_operators(principal_id,active) VALUES
 ('a1200000-0000-4000-8000-000000000001',true),('a1200000-0000-4000-8000-000000000002',true),
 ('a1200000-0000-4000-8000-000000000003',false);
INSERT INTO auth.users(id,email) VALUES
 ('a1210000-0000-4000-8000-000000000001','r4-customer@example.invalid'),
 ('a1210000-0000-4000-8000-000000000002','r4-foreign@example.invalid');
INSERT INTO public.clients(id,email,identity_kind,lifecycle_stage) VALUES
 ('a1220000-0000-4000-8000-000000000001','r4-customer@example.invalid','customer','customer');
INSERT INTO public.clients(id,email,identity_kind,lifecycle_stage,auth_user_id) VALUES
 ('a1220000-0000-4000-8000-000000000002','r4-foreign@example.invalid','customer','customer',
  'a1210000-0000-4000-8000-000000000002');
-- CD-9 changes only the link function's execution context and retains its owner.
SELECT is(
 (SELECT proowner FROM pg_catalog.pg_proc WHERE oid =
  'public.customer_support_link_subject_account_v1(uuid,uuid,text,uuid,text,timestamptz)'::regprocedure),
 (SELECT proowner FROM pg_catalog.pg_proc WHERE oid =
  'public.customer_support_admit_subject_email_v1(uuid,uuid,text,text,text,timestamptz)'::regprocedure),
 'link retains the sibling migration function owner');
SELECT is((SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid =
 'public.customer_support_link_subject_account_v1(uuid,uuid,text,uuid,text,timestamptz)'::regprocedure),
 true,'link alone uses definer authority under column-level service_role closure');
SELECT is((SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid =
 'public.customer_support_correct_subject_email_v1(uuid,uuid,text,text,text,timestamptz)'::regprocedure),
 false,'retired email correction retains invoker authority');
SELECT is((SELECT prosecdef FROM pg_catalog.pg_proc WHERE oid =
 'public.customer_support_issue_recovery(uuid,uuid,uuid,text,text,text,timestamptz,text)'::regprocedure),
 false,'recovery retains invoker authority');

-- Compare complete rows and tuple versions, including unrelated identities/receipts.
CREATE TEMP VIEW _r4_link_authority_rows AS
 SELECT 'clients'::text AS relation, xmin::text AS version, to_jsonb(c) AS row
 FROM public.clients c
 UNION ALL
 SELECT 'commands', xmin::text, to_jsonb(c)
 FROM public.customer_support_subscription_commands c
 UNION ALL
 SELECT 'audit', xmin::text, to_jsonb(c)
 FROM public.customer_support_subscription_audit_events c
 UNION ALL
 SELECT 'identities', xmin::text, to_jsonb(u)
 FROM auth.users u;
CREATE TEMP TABLE _r4_link_authority_before AS SELECT * FROM _r4_link_authority_rows;

SET LOCAL ROLE anon;
SELECT throws_ok($$SELECT public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-anon',NULL)$$,
 '42501','permission denied for function customer_support_link_subject_account_v1','anon cannot execute link');
RESET ROLE;
SELECT results_eq($$SELECT * FROM _r4_link_authority_rows ORDER BY relation,row$$,
 $$SELECT * FROM _r4_link_authority_before ORDER BY relation,row$$,
 'anon link denial writes no client, command or audit tuple');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-authenticated',NULL)$$,
 '42501','permission denied for function customer_support_link_subject_account_v1','authenticated cannot execute link');
RESET ROLE;
SELECT results_eq($$SELECT * FROM _r4_link_authority_rows ORDER BY relation,row$$,
 $$SELECT * FROM _r4_link_authority_before ORDER BY relation,row$$,
 'authenticated link denial writes no client, command or audit tuple');

SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000002','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-machine',NULL)$$,
 '42501','customer_support_command_requires_human','machine operator cannot link under service_role');
RESET ROLE;
SELECT results_eq($$SELECT * FROM _r4_link_authority_rows ORDER BY relation,row$$,
 $$SELECT * FROM _r4_link_authority_before ORDER BY relation,row$$,
 'machine link refusal writes no client, command or audit tuple');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000099','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-missing-operator',NULL)$$,
 '42501','communications_operator_inactive','missing operator cannot link under service_role');
RESET ROLE;
SELECT results_eq($$SELECT * FROM _r4_link_authority_rows ORDER BY relation,row$$,
 $$SELECT * FROM _r4_link_authority_before ORDER BY relation,row$$,
 'missing-operator link refusal writes no client, command or audit tuple');
SET LOCAL ROLE service_role;
SELECT throws_ok($$SELECT public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000003','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-inactive-operator',NULL)$$,
 '42501','communications_operator_inactive','inactive operator cannot link under service_role');
RESET ROLE;
SELECT results_eq($$SELECT * FROM _r4_link_authority_rows ORDER BY relation,row$$,
 $$SELECT * FROM _r4_link_authority_before ORDER BY relation,row$$,
 'inactive-operator link refusal writes no client, command or audit tuple');

-- RD-R4-4: subject refusals persist one receipt/audit pair, with no identity writes.
-- Keep each case's full-table baseline and replay snapshot separate.
CREATE TEMP TABLE _r4_link_refusal_after AS SELECT * FROM _r4_link_authority_rows WITH NO DATA;

-- Unknown subject: exact stored refusal and only its two durable rows.
TRUNCATE _r4_link_authority_before;
INSERT INTO _r4_link_authority_before SELECT * FROM _r4_link_authority_rows;
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000099',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-unknown-subject',NULL),
 jsonb_build_object('outcome','refused','action','link_account',
  'subjectId','a1220000-0000-4000-8000-000000000099'::uuid,'refusalCode','subject_not_found'),
 'unknown subject returns the frozen outcome and refusal code');
RESET ROLE;
SELECT results_eq(
 $$SELECT operator_id,subject_id,target_id,command_kind,response,created_at
 FROM public.customer_support_subscription_commands WHERE idempotency_key='r4-link-unknown-subject'$$,
 $$SELECT 'a1200000-0000-4000-8000-000000000001'::uuid,NULL::uuid,
 'a1220000-0000-4000-8000-000000000099'::uuid,'account_link'::text,
 jsonb_build_object('outcome','refused','action','link_account',
  'subjectId','a1220000-0000-4000-8000-000000000099'::uuid,'refusalCode','subject_not_found'),now()$$,
 'unknown subject stores exactly one refusal receipt for its key');
SELECT results_eq(
 $$SELECT operator_id,subject_id,target_id,command_kind,requested_action,outcome,
 refusal_code,value_before,value_after,occurred_at
 FROM public.customer_support_subscription_audit_events WHERE idempotency_key='r4-link-unknown-subject'$$,
 $$SELECT 'a1200000-0000-4000-8000-000000000001'::uuid,NULL::uuid,
 'a1220000-0000-4000-8000-000000000099'::uuid,'account_link'::text,'link_account'::text,
 'refused'::text,'subject_not_found'::text,NULL::text,NULL::text,now()$$,
 'unknown subject stores exactly one matching refusal audit for its key');
SELECT results_eq(
 $$SELECT * FROM _r4_link_authority_rows
 WHERE NOT (relation IN ('commands','audit') AND row->>'idempotency_key'='r4-link-unknown-subject')
 ORDER BY relation,row,version$$,
 $$SELECT * FROM _r4_link_authority_before ORDER BY relation,row,version$$,
 'unknown subject changes no clients, identities or other receipt/audit tuples');
TRUNCATE _r4_link_refusal_after;
INSERT INTO _r4_link_refusal_after SELECT * FROM _r4_link_authority_rows;
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000099',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-unknown-subject',NULL),
 (SELECT response FROM public.customer_support_subscription_commands
 WHERE idempotency_key='r4-link-unknown-subject'),
 'unknown subject same-key replay returns the stored refusal unchanged');
RESET ROLE;
SELECT results_eq($$SELECT * FROM _r4_link_authority_rows ORDER BY relation,row,version$$,
 $$SELECT * FROM _r4_link_refusal_after ORDER BY relation,row,version$$,
 'unknown subject replay writes no client, identity, command or audit tuple');

-- Email expectation conflict: exact stored refusal and only its two durable rows.
TRUNCATE _r4_link_authority_before;
INSERT INTO _r4_link_authority_before SELECT * FROM _r4_link_authority_rows;
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'changed@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-email-conflict',NULL),
 jsonb_build_object('outcome','conflict','action','link_account',
  'subjectId','a1220000-0000-4000-8000-000000000001'::uuid,'refusalCode','email_expectation_conflict'),
 'email expectation conflict returns the frozen outcome and refusal code');
RESET ROLE;
SELECT results_eq(
 $$SELECT operator_id,subject_id,target_id,command_kind,response,created_at
 FROM public.customer_support_subscription_commands WHERE idempotency_key='r4-link-email-conflict'$$,
 $$SELECT 'a1200000-0000-4000-8000-000000000001'::uuid,'a1220000-0000-4000-8000-000000000001'::uuid,
 'a1220000-0000-4000-8000-000000000001'::uuid,'account_link'::text,
 jsonb_build_object('outcome','conflict','action','link_account',
  'subjectId','a1220000-0000-4000-8000-000000000001'::uuid,'refusalCode','email_expectation_conflict'),now()$$,
 'email expectation conflict stores exactly one refusal receipt for its key');
SELECT results_eq(
 $$SELECT operator_id,subject_id,target_id,command_kind,requested_action,outcome,
 refusal_code,value_before,value_after,occurred_at
 FROM public.customer_support_subscription_audit_events WHERE idempotency_key='r4-link-email-conflict'$$,
 $$SELECT 'a1200000-0000-4000-8000-000000000001'::uuid,'a1220000-0000-4000-8000-000000000001'::uuid,
 'a1220000-0000-4000-8000-000000000001'::uuid,'account_link'::text,'link_account'::text,
 'conflict'::text,'email_expectation_conflict'::text,NULL::text,NULL::text,now()$$,
 'email expectation conflict stores exactly one matching refusal audit for its key');
SELECT results_eq(
 $$SELECT * FROM _r4_link_authority_rows
 WHERE NOT (relation IN ('commands','audit') AND row->>'idempotency_key'='r4-link-email-conflict')
 ORDER BY relation,row,version$$,
 $$SELECT * FROM _r4_link_authority_before ORDER BY relation,row,version$$,
 'email expectation conflict changes no clients, identities or other receipt/audit tuples');
TRUNCATE _r4_link_refusal_after;
INSERT INTO _r4_link_refusal_after SELECT * FROM _r4_link_authority_rows;
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'changed@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-email-conflict',NULL),
 (SELECT response FROM public.customer_support_subscription_commands
 WHERE idempotency_key='r4-link-email-conflict'),
 'email expectation conflict same-key replay returns the stored refusal unchanged');
RESET ROLE;
SELECT results_eq($$SELECT * FROM _r4_link_authority_rows ORDER BY relation,row,version$$,
 $$SELECT * FROM _r4_link_refusal_after ORDER BY relation,row,version$$,
 'email expectation conflict replay writes no client, identity, command or audit tuple');

-- Identity owned by another subject: exact stored refusal and only its two durable rows.
TRUNCATE _r4_link_authority_before;
INSERT INTO _r4_link_authority_before SELECT * FROM _r4_link_authority_rows;
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000002','r4-link-foreign-identity',NULL),
 jsonb_build_object('outcome','conflict','action','link_account',
  'subjectId','a1220000-0000-4000-8000-000000000001'::uuid,'refusalCode','identity_linked_elsewhere'),
 'identity owned by another subject returns the frozen outcome and refusal code');
RESET ROLE;
SELECT results_eq(
 $$SELECT operator_id,subject_id,target_id,command_kind,response,created_at
 FROM public.customer_support_subscription_commands WHERE idempotency_key='r4-link-foreign-identity'$$,
 $$SELECT 'a1200000-0000-4000-8000-000000000001'::uuid,'a1220000-0000-4000-8000-000000000001'::uuid,
 'a1220000-0000-4000-8000-000000000001'::uuid,'account_link'::text,
 jsonb_build_object('outcome','conflict','action','link_account',
  'subjectId','a1220000-0000-4000-8000-000000000001'::uuid,'refusalCode','identity_linked_elsewhere'),now()$$,
 'identity owned by another subject stores exactly one refusal receipt for its key');
SELECT results_eq(
 $$SELECT operator_id,subject_id,target_id,command_kind,requested_action,outcome,
 refusal_code,value_before,value_after,occurred_at
 FROM public.customer_support_subscription_audit_events WHERE idempotency_key='r4-link-foreign-identity'$$,
 $$SELECT 'a1200000-0000-4000-8000-000000000001'::uuid,'a1220000-0000-4000-8000-000000000001'::uuid,
 'a1220000-0000-4000-8000-000000000001'::uuid,'account_link'::text,'link_account'::text,
 'conflict'::text,'identity_linked_elsewhere'::text,NULL::text,NULL::text,now()$$,
 'identity owned by another subject stores exactly one matching refusal audit for its key');
SELECT results_eq(
 $$SELECT * FROM _r4_link_authority_rows
 WHERE NOT (relation IN ('commands','audit') AND row->>'idempotency_key'='r4-link-foreign-identity')
 ORDER BY relation,row,version$$,
 $$SELECT * FROM _r4_link_authority_before ORDER BY relation,row,version$$,
 'identity owned by another subject changes no clients, identities or other receipt/audit tuples');
TRUNCATE _r4_link_refusal_after;
INSERT INTO _r4_link_refusal_after SELECT * FROM _r4_link_authority_rows;
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000002','r4-link-foreign-identity',NULL),
 (SELECT response FROM public.customer_support_subscription_commands
 WHERE idempotency_key='r4-link-foreign-identity'),
 'identity owned by another subject same-key replay returns the stored refusal unchanged');
RESET ROLE;
SELECT results_eq($$SELECT * FROM _r4_link_authority_rows ORDER BY relation,row,version$$,
 $$SELECT * FROM _r4_link_refusal_after ORDER BY relation,row,version$$,
 'identity owned by another subject replay writes no client, identity, command or audit tuple');

-- Subject already linked to a different identity: exact stored refusal and only its two durable rows.
TRUNCATE _r4_link_authority_before;
INSERT INTO _r4_link_authority_before SELECT * FROM _r4_link_authority_rows;
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000002',
 'r4-foreign@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-already-linked',NULL),
 jsonb_build_object('outcome','conflict','action','link_account',
  'subjectId','a1220000-0000-4000-8000-000000000002'::uuid,'refusalCode','subject_account_linked'),
 'subject already linked to a different identity returns the frozen outcome and refusal code');
RESET ROLE;
SELECT results_eq(
 $$SELECT operator_id,subject_id,target_id,command_kind,response,created_at
 FROM public.customer_support_subscription_commands WHERE idempotency_key='r4-link-already-linked'$$,
 $$SELECT 'a1200000-0000-4000-8000-000000000001'::uuid,'a1220000-0000-4000-8000-000000000002'::uuid,
 'a1220000-0000-4000-8000-000000000002'::uuid,'account_link'::text,
 jsonb_build_object('outcome','conflict','action','link_account',
  'subjectId','a1220000-0000-4000-8000-000000000002'::uuid,'refusalCode','subject_account_linked'),now()$$,
 'subject already linked to a different identity stores exactly one refusal receipt for its key');
SELECT results_eq(
 $$SELECT operator_id,subject_id,target_id,command_kind,requested_action,outcome,
 refusal_code,value_before,value_after,occurred_at
 FROM public.customer_support_subscription_audit_events WHERE idempotency_key='r4-link-already-linked'$$,
 $$SELECT 'a1200000-0000-4000-8000-000000000001'::uuid,'a1220000-0000-4000-8000-000000000002'::uuid,
 'a1220000-0000-4000-8000-000000000002'::uuid,'account_link'::text,'link_account'::text,
 'conflict'::text,'subject_account_linked'::text,'a1210000-0000-4000-8000-000000000002'::text,NULL::text,now()$$,
 'subject already linked to a different identity stores exactly one matching refusal audit for its key');
SELECT results_eq(
 $$SELECT * FROM _r4_link_authority_rows
 WHERE NOT (relation IN ('commands','audit') AND row->>'idempotency_key'='r4-link-already-linked')
 ORDER BY relation,row,version$$,
 $$SELECT * FROM _r4_link_authority_before ORDER BY relation,row,version$$,
 'subject already linked to a different identity changes no clients, identities or other receipt/audit tuples');
TRUNCATE _r4_link_refusal_after;
INSERT INTO _r4_link_refusal_after SELECT * FROM _r4_link_authority_rows;
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000002',
 'r4-foreign@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-already-linked',NULL),
 (SELECT response FROM public.customer_support_subscription_commands
 WHERE idempotency_key='r4-link-already-linked'),
 'subject already linked to a different identity same-key replay returns the stored refusal unchanged');
RESET ROLE;
SELECT results_eq($$SELECT * FROM _r4_link_authority_rows ORDER BY relation,row,version$$,
 $$SELECT * FROM _r4_link_refusal_after ORDER BY relation,row,version$$,
 'subject already linked to a different identity replay writes no client, identity, command or audit tuple');

SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid','a1210000-0000-4000-8000-000000000001','r4-link-command',NULL)->>'outcome','applied','human links the confirmed customer');
RESET ROLE;
SELECT is((SELECT auth_user_id::text FROM public.clients WHERE id='a1220000-0000-4000-8000-000000000001'),
 'a1210000-0000-4000-8000-000000000001','stored identity is the one resolved for the customer');
CREATE TEMP TABLE _r4_link_before AS SELECT xmin::text AS version,to_jsonb(c) AS row FROM public.clients c WHERE id='a1220000-0000-4000-8000-000000000001';
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid',NULL,'r4-link-command',NULL)->>'outcome','replayed','post-link reread can replay with null identity');
RESET ROLE;
SELECT results_eq($$SELECT xmin::text,to_jsonb(c) FROM public.clients c WHERE id='a1220000-0000-4000-8000-000000000001'$$,
 $$SELECT version,row FROM _r4_link_before$$,'replay does not rewrite the customer tuple');
SELECT is((SELECT count(*)::int FROM public.customer_support_subscription_commands WHERE idempotency_key='r4-link-command'),1,'one link receipt');
SELECT is((SELECT count(*)::int FROM public.customer_support_subscription_audit_events WHERE idempotency_key='r4-link-command'),1,'one link audit');
SET LOCAL ROLE service_role;
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'changed@example.invalid',NULL,'r4-link-stale-email',NULL)->>'refusalCode','email_expectation_conflict','stale expected email refuses by name');
SELECT throws_ok($$SELECT public.customer_support_issue_recovery(
 'a1200000-0000-4000-8000-000000000002','a1220000-0000-4000-8000-000000000099',
 'a1230000-0000-4000-8000-000000000099','r4-machine-recovery',repeat('a',64),repeat('b',64),now()+interval '1 day','/repair')$$,
 '42501','customer_support_command_requires_human','machine recovery refuses before missing-subject reads');
SELECT throws_ok($$SELECT public.customer_support_correct_subject_email_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 'r4-customer@example.invalid','new@example.invalid','r4-retired-email',NULL)$$,
 '55000','customer_support_email_correction_requires_admission','retired combined email cannot move either copy');
SELECT is(public.customer_support_apply_subscription_action_v1(
 'a1200000-0000-4000-8000-000000000001','a1230000-0000-4000-8000-000000000099','pause','{}',1,'r4-managed-apply',now())->>'refusalCode',
 'subscription_not_found','managed authority reports its own refusal, never the native capability literal');
RESET ROLE;
SELECT is((SELECT count(*)::int FROM public.customer_support_recovery_commands WHERE idempotency_key='r4-machine-recovery'),0,'machine leaves no recovery receipt');
SELECT is((SELECT count(*)::int FROM public.customer_support_recovery_audit_events WHERE idempotency_key='r4-machine-recovery'),0,'machine leaves no recovery audit');
SELECT is((SELECT count(*)::int FROM public.customer_support_subscription_commands WHERE idempotency_key='r4-retired-email'),0,'retired entry leaves no receipt');
SELECT is((SELECT email FROM public.clients WHERE id='a1220000-0000-4000-8000-000000000001'),'r4-customer@example.invalid','retired entry preserves contact email');
SELECT * FROM finish();
ROLLBACK;
