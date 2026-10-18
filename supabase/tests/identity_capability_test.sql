-- pgTAP: identity account links and operator activation use exact service-role columns.
-- Fixtures are owner-created; owner readback observes defaults and refused mutations.
BEGIN;
INSERT INTO auth.users(id) VALUES
 ('b9190000-0000-4000-8000-000000000001'),
 ('b9190000-0000-4000-8000-000000000002'),
 ('b9190000-0000-4000-8000-000000000003'),
 ('b9190000-0000-4000-8000-000000000004'),
 ('b9190000-0000-4000-8000-000000000005'),
 ('b9190000-0000-4000-8000-000000000006'),
 ('b9190000-0000-4000-8000-000000000007');
INSERT INTO public.clients(id,email,auth_user_id) VALUES
 ('b9191000-0000-4000-8000-000000000001','identity-link-unlinked@example.invalid',NULL),
 ('b9191000-0000-4000-8000-000000000002','identity-link-linked@example.invalid','b9190000-0000-4000-8000-000000000002'),
 ('b9191000-0000-4000-8000-000000000003','identity-link-victim@example.invalid',NULL);
INSERT INTO public.admin_users(id,email,role) VALUES
 ('b9190000-0000-4000-8000-000000000007','identity-operator-distributor@example.invalid','distributor');
SELECT plan(43);
SELECT is((SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid='public.clients'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('service_role',attrelid,attname,'INSERT')),ARRAY['acquisition_source','auth_user_id','email','lifecycle_stage']::text[],'service INSERT columns are exactly the reconcile-create set');
SELECT is((SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid='public.clients'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('service_role',attrelid,attname,'UPDATE')),ARRAY['auth_user_id','email','identity_kind','marketing_contact_id','metadata','updated_at']::text[],'service UPDATE columns are exactly account linking and existing runtime mutations');
SELECT ok(NOT has_table_privilege('service_role','public.clients','INSERT'),'service has no table-level clients INSERT');
SELECT ok(NOT has_table_privilege('service_role','public.clients','DELETE'),'service has no clients DELETE');
SELECT ok(NOT has_table_privilege('service_role','public.clients','TRUNCATE'),'service has no clients TRUNCATE');
SELECT ok(NOT has_any_column_privilege('anon','public.clients','INSERT'),'anon cannot insert any clients column');
SELECT ok(NOT has_any_column_privilege('anon','public.clients','UPDATE'),'anon cannot update any clients column');
SELECT ok(NOT has_any_column_privilege('authenticated','public.clients','INSERT'),'authenticated cannot insert any clients column');

SET LOCAL ROLE service_role;
WITH c AS (INSERT INTO public.clients(email,auth_user_id,acquisition_source,lifecycle_stage) VALUES ('identity-link-created@example.invalid','b9190000-0000-4000-8000-000000000003','identity_reconcile','customer') RETURNING id) SELECT is(count(*)::integer,1,'service reconcile creates a client with exactly four columns') FROM c;
SELECT throws_ok($q$INSERT INTO public.clients(email,auth_user_id,acquisition_source,lifecycle_stage,metadata) VALUES ('identity-link-denied-metadata@example.invalid',NULL,'identity_reconcile','customer','{}')$q$,'42501',NULL,'service cannot insert unlisted metadata');
SELECT throws_ok($q$INSERT INTO public.clients(email,auth_user_id,acquisition_source,lifecycle_stage,identity_kind) VALUES ('identity-link-denied-kind@example.invalid',NULL,'identity_reconcile','customer','customer')$q$,'42501',NULL,'service cannot insert unlisted identity_kind');
SELECT throws_ok($q$INSERT INTO public.clients(email,auth_user_id,acquisition_source,lifecycle_stage,first_name) VALUES ('identity-link-denied-name@example.invalid',NULL,'identity_reconcile','customer','unauthorized')$q$,'42501',NULL,'service cannot insert unlisted first_name');
WITH c AS (UPDATE public.clients SET auth_user_id='b9190000-0000-4000-8000-000000000001' WHERE id='b9191000-0000-4000-8000-000000000001' AND auth_user_id IS NULL RETURNING auth_user_id) SELECT is((SELECT auth_user_id::text FROM c),'b9190000-0000-4000-8000-000000000001','service links a still-unset principal reference');
WITH c AS (UPDATE public.clients SET auth_user_id='b9190000-0000-4000-8000-000000000001' WHERE id='b9191000-0000-4000-8000-000000000002' AND auth_user_id IS NULL RETURNING auth_user_id) SELECT is(count(*)::integer,0,'service conditional link preserves an already-linked client') FROM c;
SELECT throws_ok($q$UPDATE public.clients SET first_name='unauthorized' WHERE id='b9191000-0000-4000-8000-000000000001'$q$,'42501',NULL,'service cannot update unrelated first_name');
SELECT throws_ok($q$DELETE FROM public.clients WHERE id='b9191000-0000-4000-8000-000000000003'$q$,'42501',NULL,'service cannot delete a client');
RESET ROLE;

SET LOCAL ROLE anon;
SELECT throws_ok($q$INSERT INTO public.clients(email,auth_user_id,acquisition_source,lifecycle_stage) VALUES ('identity-link-denied-anon@example.invalid',NULL,'identity_reconcile','customer')$q$,'42501',NULL,'anon cannot create a client');
SELECT throws_ok($q$UPDATE public.clients SET auth_user_id='b9190000-0000-4000-8000-000000000004' WHERE id='b9191000-0000-4000-8000-000000000003' AND auth_user_id IS NULL RETURNING auth_user_id$q$,'42501',NULL,'anon cannot link a client');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"b9190000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT throws_ok($q$INSERT INTO public.clients(email,auth_user_id,acquisition_source,lifecycle_stage) VALUES ('identity-link-denied-authenticated@example.invalid','b9190000-0000-4000-8000-000000000004','identity_reconcile','customer')$q$,'42501',NULL,'authenticated cannot create a client');
WITH c AS (UPDATE public.clients SET auth_user_id='b9190000-0000-4000-8000-000000000004' WHERE id='b9191000-0000-4000-8000-000000000003' AND auth_user_id IS NULL RETURNING auth_user_id) SELECT is(count(*)::integer,0,'authenticated cannot link a foreign client through RLS') FROM c;
RESET ROLE;

SELECT is((SELECT auth_user_id::text FROM public.clients WHERE id='b9191000-0000-4000-8000-000000000001'),'b9190000-0000-4000-8000-000000000001','owner observes the newly linked principal');
SELECT is((SELECT auth_user_id::text FROM public.clients WHERE id='b9191000-0000-4000-8000-000000000002'),'b9190000-0000-4000-8000-000000000002','owner observes the original already-linked principal');
SELECT is((SELECT count(*)::integer FROM public.clients WHERE id='b9191000-0000-4000-8000-000000000003' AND auth_user_id IS NULL),1,'owner observes the victim still present and unlinked');
SELECT is((SELECT identity_kind FROM public.clients WHERE email='identity-link-created@example.invalid'),'customer','reconcile-created client keeps default customer identity_kind');
SELECT is((SELECT metadata FROM public.clients WHERE email='identity-link-created@example.invalid'),'{}'::jsonb,'reconcile-created client keeps default empty metadata');
-- Operator capabilities add only activation columns and the invitation email read.
SELECT is((SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid='public.admin_users'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('service_role',attrelid,attname,'INSERT')),ARRAY['email','id','membership_accepted_at','membership_provenance','membership_state','role']::text[],'service INSERT columns are exactly the operator activation set');
SELECT is((SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute WHERE attrelid='public.admin_users'::regclass AND attnum>0 AND NOT attisdropped AND has_column_privilege('service_role',attrelid,attname,'SELECT')),ARRAY['email','id','is_machine_actor','membership_state','role']::text[],'service SELECT columns are exactly email and existing membership reads');
SELECT ok(NOT has_table_privilege('service_role','public.admin_users','INSERT'),'service has no table-level admin_users INSERT');
SELECT ok(NOT has_any_column_privilege('service_role','public.admin_users','UPDATE'),'service cannot update any admin_users column');
SELECT ok(NOT has_table_privilege('service_role','public.admin_users','DELETE'),'service has no admin_users DELETE');
SELECT is((SELECT count(*)::integer FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) x WHERE a.attrelid='public.admin_users'::regclass AND x.grantee='anon'::regrole),0,'no anon column grant on admin_users');
SELECT ok(NOT has_any_column_privilege('authenticated','public.admin_users','INSERT'),'authenticated cannot insert any admin_users column');

SET LOCAL ROLE service_role;
SELECT lives_ok($q$INSERT INTO public.admin_users(id,email,role,membership_state,membership_provenance,membership_accepted_at) VALUES ('b9190000-0000-4000-8000-000000000005','identity-operator-activated@example.invalid','admin','active','invitation',now())$q$,'service activation inserts exactly six membership columns');
SELECT is((SELECT email FROM public.admin_users WHERE id='b9190000-0000-4000-8000-000000000005'),'identity-operator-activated@example.invalid','service can read the operator email for invitation checks');
SELECT throws_ok($q$INSERT INTO public.admin_users(id,email,role,membership_state,membership_provenance,membership_accepted_at,is_machine_actor) VALUES ('b9190000-0000-4000-8000-000000000006','identity-operator-denied-machine@example.invalid','admin','active','invitation',now(),true)$q$,'42501',NULL,'service cannot insert unlisted is_machine_actor');
SELECT throws_ok($q$UPDATE public.admin_users SET email='unauthorized@example.invalid' WHERE id='b9190000-0000-4000-8000-000000000005'$q$,'42501',NULL,'service cannot update an operator');
SELECT throws_ok($q$DELETE FROM public.admin_users WHERE id='b9190000-0000-4000-8000-000000000005'$q$,'42501',NULL,'service cannot delete an operator');
RESET ROLE;

SET LOCAL ROLE anon;
SELECT throws_ok($q$INSERT INTO public.admin_users(id,email,role,membership_state,membership_provenance,membership_accepted_at) VALUES ('b9190000-0000-4000-8000-000000000006','identity-operator-denied-anon@example.invalid','admin','active','invitation',now())$q$,'42501',NULL,'anon cannot activate an operator');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','',true);
SELECT set_config('request.jwt.claims','{"sub":"b9190000-0000-4000-8000-000000000007","role":"authenticated"}',true);
SELECT throws_ok($q$INSERT INTO public.admin_users(id,email,role,membership_state,membership_provenance,membership_accepted_at) VALUES ('b9190000-0000-4000-8000-000000000006','identity-operator-denied-authenticated@example.invalid','admin','active','invitation',now())$q$,'42501',NULL,'authenticated cannot activate an operator');
SELECT is((SELECT email FROM public.admin_users WHERE id='b9190000-0000-4000-8000-000000000007'),'identity-operator-distributor@example.invalid','authenticated distributor can read their own operator email');
SELECT is((SELECT count(email)::integer FROM public.admin_users WHERE id='b9190000-0000-4000-8000-000000000005'),0,'authenticated distributor cannot read another operator email through RLS');
RESET ROLE;

SELECT is((SELECT is_machine_actor FROM public.admin_users WHERE id='b9190000-0000-4000-8000-000000000005'),false,'owner observes the activated operator keeps default non-machine status');
SELECT is((SELECT count(*)::integer FROM public.admin_users WHERE id='b9190000-0000-4000-8000-000000000006'),0,'owner observes refused operator inserts created no row');
SELECT * FROM finish();
ROLLBACK;
