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

-- CD-13a: effective privileges cover every definer, including inherited grants.
SELECT ok(NOT has_function_privilege('openlup_mcp_reader', signature, 'EXECUTE'),
 'MCP reader cannot execute ' || signature)
FROM (VALUES
 ('public.customer_support_admit_subject_email_v1(uuid,uuid,text,text,text,timestamptz)'),
 ('public.customer_support_claim_subject_email_v1(text)'),
 ('public.customer_support_guard_identity_email_v1()'),
 ('public.customer_support_settle_subject_email_v1(text,uuid,text)'),
 ('public.customer_support_link_subject_account_v1(uuid,uuid,text,uuid,text,timestamptz)')
) AS definers(signature);
SELECT results_eq(
 $$SELECT p.oid::regprocedure::text, p.prosecdef, p.proconfig COLLATE "default",
   COALESCE((SELECT array_agg(r.rolname::text ORDER BY r.rolname)
     FROM pg_catalog.aclexplode(COALESCE(p.proacl,
       pg_catalog.acldefault('f',p.proowner))) a
     JOIN pg_catalog.pg_roles r ON r.oid=a.grantee
     WHERE a.grantee <> p.proowner AND a.privilege_type='EXECUTE'), ARRAY[]::text[]) COLLATE "default",
   EXISTS (SELECT 1 FROM pg_catalog.aclexplode(COALESCE(p.proacl,
     pg_catalog.acldefault('f',p.proowner))) a
     WHERE a.grantee=0 AND a.privilege_type='EXECUTE')
 FROM pg_catalog.pg_proc p WHERE p.oid IN (
  'public.customer_support_admit_subject_email_v1(uuid,uuid,text,text,text,timestamptz)'::regprocedure,
  'public.customer_support_claim_subject_email_v1(text)'::regprocedure,
  'public.customer_support_guard_identity_email_v1()'::regprocedure,
  'public.customer_support_settle_subject_email_v1(text,uuid,text)'::regprocedure,
  'public.customer_support_link_subject_account_v1(uuid,uuid,text,uuid,text,timestamptz)'::regprocedure)
 ORDER BY 1$$,
 $$VALUES
 ('customer_support_admit_subject_email_v1(uuid,uuid,text,text,text,timestamp with time zone)',true,ARRAY['search_path=public, pg_catalog'],ARRAY['service_role'],false),
 ('customer_support_claim_subject_email_v1(text)',true,ARRAY['search_path=public, pg_catalog'],ARRAY['service_role'],false),
 ('customer_support_guard_identity_email_v1()',true,ARRAY['search_path=public, pg_catalog'],ARRAY[]::text[],false),
 ('customer_support_link_subject_account_v1(uuid,uuid,text,uuid,text,timestamp with time zone)',true,ARRAY['search_path=pg_catalog, pg_temp'],ARRAY['service_role'],false),
 ('customer_support_settle_subject_email_v1(text,uuid,text)',true,ARRAY['search_path=public, pg_catalog'],ARRAY['service_role'],false)$$,
 'four donor paths and hardened link preserve service-only EXECUTE; guard is trigger-only');

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
-- CD-13a: fresh-key noop still reads operator, subject and identity state,
-- normalizes the supplied email and persists its own receipt/audit as service_role.
CREATE TEMP TABLE _r4_clean_link_result(response jsonb);
GRANT SELECT, INSERT ON _r4_clean_link_result TO service_role;
SET LOCAL ROLE service_role;
INSERT INTO _r4_clean_link_result
 SELECT public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 '  R4-CUSTOMER@EXAMPLE.INVALID  ','a1210000-0000-4000-8000-000000000001',
 'r4-link-clean-session',NULL);
SELECT is((SELECT response FROM _r4_clean_link_result),
 jsonb_build_object('outcome','noop','action','link_account',
 'subjectId','a1220000-0000-4000-8000-000000000001'::uuid),
 'clean granted-role link returns the complete expected result');
RESET ROLE;
CREATE SCHEMA r4_hostile_session AUTHORIZATION service_role;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE clients(id uuid);
CREATE FUNCTION pg_temp.lower(text) RETURNS text LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'hostile temporary lower called'; END $$;
CREATE FUNCTION pg_temp.btrim(text) RETURNS text LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'hostile temporary btrim called'; END $$;
CREATE FUNCTION r4_hostile_session.lower(text) RETURNS text LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'hostile caller lower called'; END $$;
CREATE FUNCTION r4_hostile_session.btrim(text) RETURNS text LANGUAGE plpgsql AS $$
 BEGIN RAISE EXCEPTION 'hostile caller btrim called'; END $$;
SET LOCAL search_path = r4_hostile_session, pg_catalog, pg_temp, public, extensions;
SELECT throws_ok($$SELECT lower('fixture')$$,'P0001','hostile caller lower called',
 'caller search_path really resolves the hostile lower');
SELECT throws_ok($$SELECT btrim('fixture')$$,'P0001','hostile caller btrim called',
 'caller search_path really resolves the hostile btrim');
SELECT is(to_regclass('clients'), 'pg_temp.clients'::regclass,
 'caller relation lookup really resolves the temporary clients shadow');
SELECT is(public.customer_support_link_subject_account_v1(
 'a1200000-0000-4000-8000-000000000001','a1220000-0000-4000-8000-000000000001',
 '  R4-CUSTOMER@EXAMPLE.INVALID  ','a1210000-0000-4000-8000-000000000001',
 'r4-link-hostile-session',NULL), (SELECT response FROM pg_temp._r4_clean_link_result),
 'hostile caller-session objects leave the granted-role link result identical to clean');
RESET ROLE;
SET LOCAL search_path = public, extensions;
SELECT results_eq(
 $$SELECT response FROM public.customer_support_subscription_commands
 WHERE idempotency_key IN ('r4-link-clean-session','r4-link-hostile-session')
 ORDER BY idempotency_key$$,
 $$SELECT response FROM _r4_clean_link_result UNION ALL SELECT response FROM _r4_clean_link_result$$,
 'both calls persist the identical complete response under separate fresh keys');
SELECT results_eq(
 $$SELECT outcome,value_before,value_after FROM public.customer_support_subscription_audit_events
 WHERE idempotency_key IN ('r4-link-clean-session','r4-link-hostile-session')
 ORDER BY idempotency_key$$,
 $$VALUES ('noop'::text,'a1210000-0000-4000-8000-000000000001'::text,'a1210000-0000-4000-8000-000000000001'::text),
 ('noop'::text,'a1210000-0000-4000-8000-000000000001'::text,'a1210000-0000-4000-8000-000000000001'::text)$$,
 'both granted-role calls audit the same linked identity without a shadow effect');
DROP SCHEMA r4_hostile_session CASCADE;
DROP TABLE pg_temp.clients;
DROP FUNCTION pg_temp.lower(text), pg_temp.btrim(text);

SELECT * FROM finish();
ROLLBACK;
