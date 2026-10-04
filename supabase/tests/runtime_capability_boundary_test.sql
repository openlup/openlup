-- Finite capabilities protect current callers; fixture owner only observes refused mutations.
-- pgTAP: admitted runtime capabilities stay finite and human fences run as the real caller.
BEGIN;
INSERT INTO public.admin_users(id,email,role,is_machine_actor)
VALUES ('b8700000-0000-4000-8000-000000000001','runtime-machine@example.invalid','admin',true);
INSERT INTO public.platform_communication_operators(principal_id,active)
VALUES ('b8700000-0000-4000-8000-000000000002',true);
INSERT INTO public.clients(id,email) VALUES
 ('b8800000-0000-4000-8000-000000000001','runtime-subject@example.invalid'),
 ('b8800000-0000-4000-8000-000000000002','runtime-lead@example.invalid');
INSERT INTO auth.users(id) VALUES ('b8900000-0000-4000-8000-000000000001');
UPDATE public.clients SET auth_user_id='b8900000-0000-4000-8000-000000000001'
 WHERE id='b8800000-0000-4000-8000-000000000001';

-- Fixtures are owner-created; every admission/refusal below executes as authenticated.
INSERT INTO auth.users(id) VALUES
 ('b8900000-0000-4000-8000-000000000002'),
 ('b8900000-0000-4000-8000-000000000003'),
 ('b8700000-0000-4000-8000-000000000001'),
 ('b8900000-0000-4000-8000-000000000004');
INSERT INTO public.admin_users(id,email,role) VALUES
 ('b8900000-0000-4000-8000-000000000002','runtime-distributor@example.invalid','distributor'),
 ('b8900000-0000-4000-8000-000000000003','runtime-admin@example.invalid','admin');
INSERT INTO public.admin_users(id,email,role,membership_state,membership_revoked_at,membership_revoked_by)
VALUES ('b8900000-0000-4000-8000-000000000004','runtime-revoked@example.invalid','admin',
 'revoked',now(),'b8900000-0000-4000-8000-000000000003');
INSERT INTO public.addresses(id,client_id,kind,line1,city,postal_code)
VALUES ('b8a00000-0000-4000-8000-000000000001','b8800000-0000-4000-8000-000000000002',
 'shipping','runtime original','runtime locality','00-001');
INSERT INTO public.customer_account_events(id,client_id,event_type,entity_type)
VALUES ('b8a00000-0000-4000-8000-000000000002','b8800000-0000-4000-8000-000000000002',
 'runtime_original','runtime_fixture');
INSERT INTO public.customer_orderer_profiles(id,client_id,full_name,email)
VALUES ('b8a00000-0000-4000-8000-000000000003','b8800000-0000-4000-8000-000000000002',
 'runtime original','runtime-orderer@example.invalid');
INSERT INTO public.pets(id,client_id,pet_type,name)
VALUES ('b8a00000-0000-4000-8000-000000000004','b8800000-0000-4000-8000-000000000002',
 'other','runtime original');
INSERT INTO public.address_canon_sources(source_key,status,display_name,official_url)
VALUES ('gus_teryt','active','runtime directory','https://example.invalid/runtime')
ON CONFLICT (source_key) DO NOTHING;
INSERT INTO public.address_canon_localities(id,source_key,terc_code,simc_code,name,normalized_name,active) VALUES
 ('b8b00000-0000-4000-8000-000000000001','gus_teryt','987001','987001','runtime active','runtime active',true),
 ('b8b00000-0000-4000-8000-000000000002','gus_teryt','987002','987002','runtime inactive','runtime inactive',false);
INSERT INTO public.address_canon_streets(id,source_key,locality_id,name,normalized_name,active) VALUES
 ('b8b00000-0000-4000-8000-000000000003','gus_teryt','b8b00000-0000-4000-8000-000000000001','runtime active','runtime active',true),
 ('b8b00000-0000-4000-8000-000000000004','gus_teryt','b8b00000-0000-4000-8000-000000000001','runtime inactive','runtime inactive',false);
INSERT INTO public.address_canon_postal_localities(postal_code,locality_id,source_key,confidence,active) VALUES
 ('98-701','b8b00000-0000-4000-8000-000000000001','gus_teryt','exact',true),
 ('98-702','b8b00000-0000-4000-8000-000000000001','gus_teryt','exact',false);
SELECT plan(129);
SELECT ok(NOT has_column_privilege('service_role','public.clients','country','SELECT'),'service cannot read unrelated clients.country');
SELECT ok(NOT has_column_privilege('service_role','public.clients','external_ref','SELECT'),'service cannot read unrelated clients.external_ref');
SELECT ok(NOT has_column_privilege('service_role','public.clients','preferences','SELECT'),'service cannot read unrelated clients.preferences');
SELECT ok(NOT has_column_privilege('service_role','public.admin_users','email','SELECT'),'service cannot read unrelated admin_users.email');
SELECT ok(NOT has_column_privilege('service_role','public.admin_users','created_at','SELECT'),'service cannot read unrelated admin_users.created_at');
SELECT ok(NOT has_column_privilege('service_role','public.subscription_events','payload','SELECT'),'service cannot read unrelated subscription_events.payload');
SELECT ok(NOT has_column_privilege('service_role','public.clients','auth_user_id','UPDATE'),'service cannot update unrelated clients.auth_user_id');
SELECT ok(NOT has_column_privilege('service_role','public.clients','acquisition_source','UPDATE'),'service cannot update unrelated clients.acquisition_source');
SELECT ok(NOT has_column_privilege('service_role','public.clients','first_name','UPDATE'),'service cannot update unrelated clients.first_name');
SELECT ok(NOT has_column_privilege('service_role','public.clients','last_name','UPDATE'),'service cannot update unrelated clients.last_name');
SELECT ok(NOT has_column_privilege('service_role','public.client_consents','granted','UPDATE'),'service cannot update unrelated client_consents.granted');
SELECT ok(NOT has_column_privilege('service_role','public.client_consents','captured_at','UPDATE'),'service cannot update unrelated client_consents.captured_at');
SELECT ok(NOT has_column_privilege('service_role','public.customer_personalization','owner_name_raw','UPDATE'),'service cannot update unrelated customer_personalization.owner_name_raw');
SELECT ok(NOT has_column_privilege('service_role','public.subscriptions','status','UPDATE'),'service cannot update unrelated subscriptions.status');
SELECT ok(NOT has_column_privilege('service_role','public.subscriptions','next_cycle_at','UPDATE'),'service cannot update unrelated subscriptions.next_cycle_at');
SELECT ok(NOT has_table_privilege('service_role','public.clients','INSERT'),'client runtime admission grants no INSERT');
SELECT ok(NOT has_table_privilege('service_role','public.clients','DELETE'),'client runtime admission grants no DELETE');
SELECT ok(NOT has_table_privilege('service_role','public.clients','TRUNCATE'),'client runtime admission grants no TRUNCATE');
SELECT ok(NOT has_table_privilege('service_role','public.admin_users','UPDATE'),'runtime roster read gives no membership write');
SELECT ok(NOT has_column_privilege('authenticated','public.clients','metadata','SELECT'),'browser cannot read private customer metadata');
SELECT ok(NOT has_column_privilege('authenticated','public.admin_users','membership_revoked_by','SELECT'),'browser cannot read unlisted membership audit column');
SELECT ok(NOT has_function_privilege('authenticated','public.customer_support_absorb_lead_v1(uuid,uuid,uuid,text,text,timestamptz)','EXECUTE'),'profile reads do not grant browser support execution');
SET LOCAL ROLE service_role;
SELECT throws_ok($q$SELECT public.customer_support_absorb_lead_v1('b8700000-0000-4000-8000-000000000001','b8800000-0000-4000-8000-000000000001','b8800000-0000-4000-8000-000000000002','runtime-lead@example.invalid','runtime-machine-absorb',NULL)$q$,'42501','customer_support_command_requires_human','machine admin cannot absorb under service role');
SELECT throws_ok($q$SELECT public.customer_support_correct_subject_email_v1('b8700000-0000-4000-8000-000000000001','b8800000-0000-4000-8000-000000000001','runtime-subject@example.invalid','runtime-new@example.invalid','runtime-machine-correction',NULL)$q$,'42501','customer_support_command_requires_human','machine admin cannot correct email under service role');
SELECT is(public.marketing_rehome_client_lead_v1('b8800000-0000-4000-8000-000000000099')->>'refusalCode','client_not_found','projected rehome preserves missing-row and default timestamp behavior');
SELECT is(public.customer_support_correct_subject_email_v1('b8700000-0000-4000-8000-000000000002','b8800000-0000-4000-8000-000000000099','missing@example.invalid','new@example.invalid','runtime-missing-subject',NULL)->>'refusalCode','subject_not_found','projected correction preserves missing-row and null timestamp behavior');
RESET ROLE;
SELECT is((SELECT count(*)::integer FROM public.customer_support_subscription_commands WHERE idempotency_key IN ('runtime-machine-absorb','runtime-machine-correction')),0,'machine refusals create no command receipt');
SELECT is((SELECT count(*)::integer FROM public.customer_support_subscription_audit_events WHERE idempotency_key IN ('runtime-machine-absorb','runtime-machine-correction')),0,'machine refusals create no audit mutation');
SELECT is((SELECT string_agg(email,',' ORDER BY id) FROM public.clients WHERE id IN ('b8800000-0000-4000-8000-000000000001','b8800000-0000-4000-8000-000000000002')),'runtime-subject@example.invalid,runtime-lead@example.invalid','machine refusals preserve both customer addresses');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"b8900000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT is((SELECT count(*)::integer FROM public.clients WHERE id='b8800000-0000-4000-8000-000000000001'),1,
 'authenticated reader sees its own current profile');
SELECT is((SELECT count(*)::integer FROM public.clients WHERE id='b8800000-0000-4000-8000-000000000002'),0,
 'new profile reads still refuse another customer through RLS');
WITH changed AS (UPDATE public.clients SET first_name='unauthorized'
 WHERE id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,
 'existing browser update capability still refuses another customer through RLS');
RESET ROLE;

-- active distributor: real browser caller; membership visibility cannot expand customer authority.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"b8900000-0000-4000-8000-000000000002","role":"authenticated"}',true);
SELECT is((SELECT count(*)::integer FROM public.admin_users WHERE id='b8900000-0000-4000-8000-000000000002'),1,'active distributor: own membership visibility');
SELECT is((SELECT count(*)::integer FROM public.clients WHERE id='b8800000-0000-4000-8000-000000000002'),0,'active distributor: cross-customer profile read refused');
WITH changed AS (UPDATE public.clients SET first_name='unauthorized' WHERE id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active distributor: cross-customer profile update refused');
SELECT is((SELECT count(*)::integer FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'active distributor: cross-customer addresses read refused');
WITH changed AS (UPDATE public.addresses SET line1='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active distributor: cross-customer addresses update refused');
SELECT throws_ok($q$INSERT INTO public.addresses(client_id,kind,line1,city,postal_code) VALUES ('b8800000-0000-4000-8000-000000000002','shipping','unauthorized','runtime locality','00-001')$q$,'42501','new row violates row-level security policy for table "addresses"','active distributor: cross-customer addresses insert refused by RLS');
WITH changed AS (DELETE FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active distributor: cross-customer addresses delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'active distributor: cross-customer customer_orderer_profiles read refused');
WITH changed AS (UPDATE public.customer_orderer_profiles SET full_name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active distributor: cross-customer customer_orderer_profiles update refused');
SELECT throws_ok($q$INSERT INTO public.customer_orderer_profiles(client_id,full_name,email) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime-refused@example.invalid')$q$,'42501','new row violates row-level security policy for table "customer_orderer_profiles"','active distributor: cross-customer customer_orderer_profiles insert refused by RLS');
WITH changed AS (DELETE FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active distributor: cross-customer customer_orderer_profiles delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_account_events WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'active distributor: cross-customer account events read refused');
SELECT throws_ok($q$INSERT INTO public.customer_account_events(client_id,event_type,entity_type) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime_fixture')$q$,'42501','new row violates row-level security policy for table "customer_account_events"','active distributor: cross-customer account event insert refused by RLS');
SELECT throws_ok($q$SELECT id FROM public.pets WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','active distributor: pets read refused by existing ACL');
SELECT throws_ok($q$INSERT INTO public.pets(client_id,pet_type,name) VALUES ('b8800000-0000-4000-8000-000000000002','other','unauthorized')$q$,'42501','new row violates row-level security policy for table "pets"','active distributor: cross-customer pet insert refused by RLS');
SELECT throws_ok($q$UPDATE public.pets SET name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','active distributor: cross-customer pet update refused by existing read ACL');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000001' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000003' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-701' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'1,1,1','active distributor: canonical active entries remain visible');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000002' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000004' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-702' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'0,0,0','active distributor: canonical inactive entries remain hidden');
RESET ROLE;

-- active admin: real browser caller; membership visibility cannot expand customer authority.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"b8900000-0000-4000-8000-000000000003","role":"authenticated"}',true);
SELECT is((SELECT count(*)::integer FROM public.admin_users WHERE id='b8900000-0000-4000-8000-000000000003'),1,'active admin: own membership visibility');
SELECT is((SELECT count(*)::integer FROM public.clients WHERE id='b8800000-0000-4000-8000-000000000002'),0,'active admin: cross-customer profile read refused');
WITH changed AS (UPDATE public.clients SET first_name='unauthorized' WHERE id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active admin: cross-customer profile update refused');
SELECT is((SELECT count(*)::integer FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'active admin: cross-customer addresses read refused');
WITH changed AS (UPDATE public.addresses SET line1='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active admin: cross-customer addresses update refused');
SELECT throws_ok($q$INSERT INTO public.addresses(client_id,kind,line1,city,postal_code) VALUES ('b8800000-0000-4000-8000-000000000002','shipping','unauthorized','runtime locality','00-001')$q$,'42501','new row violates row-level security policy for table "addresses"','active admin: cross-customer addresses insert refused by RLS');
WITH changed AS (DELETE FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active admin: cross-customer addresses delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'active admin: cross-customer customer_orderer_profiles read refused');
WITH changed AS (UPDATE public.customer_orderer_profiles SET full_name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active admin: cross-customer customer_orderer_profiles update refused');
SELECT throws_ok($q$INSERT INTO public.customer_orderer_profiles(client_id,full_name,email) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime-refused@example.invalid')$q$,'42501','new row violates row-level security policy for table "customer_orderer_profiles"','active admin: cross-customer customer_orderer_profiles insert refused by RLS');
WITH changed AS (DELETE FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'active admin: cross-customer customer_orderer_profiles delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_account_events WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'active admin: cross-customer account events read refused');
SELECT throws_ok($q$INSERT INTO public.customer_account_events(client_id,event_type,entity_type) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime_fixture')$q$,'42501','new row violates row-level security policy for table "customer_account_events"','active admin: cross-customer account event insert refused by RLS');
SELECT throws_ok($q$SELECT id FROM public.pets WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','active admin: pets read refused by existing ACL');
SELECT throws_ok($q$INSERT INTO public.pets(client_id,pet_type,name) VALUES ('b8800000-0000-4000-8000-000000000002','other','unauthorized')$q$,'42501','new row violates row-level security policy for table "pets"','active admin: cross-customer pet insert refused by RLS');
SELECT throws_ok($q$UPDATE public.pets SET name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','active admin: cross-customer pet update refused by existing read ACL');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000001' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000003' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-701' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'1,1,1','active admin: canonical active entries remain visible');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000002' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000004' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-702' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'0,0,0','active admin: canonical inactive entries remain hidden');
RESET ROLE;

-- machine admin: real browser caller; membership visibility cannot expand customer authority.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"b8700000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT is((SELECT count(*)::integer FROM public.admin_users WHERE id='b8700000-0000-4000-8000-000000000001'),1,'machine admin: own membership visibility');
SELECT is((SELECT count(*)::integer FROM public.clients WHERE id='b8800000-0000-4000-8000-000000000002'),0,'machine admin: cross-customer profile read refused');
WITH changed AS (UPDATE public.clients SET first_name='unauthorized' WHERE id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'machine admin: cross-customer profile update refused');
SELECT is((SELECT count(*)::integer FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'machine admin: cross-customer addresses read refused');
WITH changed AS (UPDATE public.addresses SET line1='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'machine admin: cross-customer addresses update refused');
SELECT throws_ok($q$INSERT INTO public.addresses(client_id,kind,line1,city,postal_code) VALUES ('b8800000-0000-4000-8000-000000000002','shipping','unauthorized','runtime locality','00-001')$q$,'42501','new row violates row-level security policy for table "addresses"','machine admin: cross-customer addresses insert refused by RLS');
WITH changed AS (DELETE FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'machine admin: cross-customer addresses delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'machine admin: cross-customer customer_orderer_profiles read refused');
WITH changed AS (UPDATE public.customer_orderer_profiles SET full_name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'machine admin: cross-customer customer_orderer_profiles update refused');
SELECT throws_ok($q$INSERT INTO public.customer_orderer_profiles(client_id,full_name,email) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime-refused@example.invalid')$q$,'42501','new row violates row-level security policy for table "customer_orderer_profiles"','machine admin: cross-customer customer_orderer_profiles insert refused by RLS');
WITH changed AS (DELETE FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'machine admin: cross-customer customer_orderer_profiles delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_account_events WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'machine admin: cross-customer account events read refused');
SELECT throws_ok($q$INSERT INTO public.customer_account_events(client_id,event_type,entity_type) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime_fixture')$q$,'42501','new row violates row-level security policy for table "customer_account_events"','machine admin: cross-customer account event insert refused by RLS');
SELECT throws_ok($q$SELECT id FROM public.pets WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','machine admin: pets read refused by existing ACL');
SELECT throws_ok($q$INSERT INTO public.pets(client_id,pet_type,name) VALUES ('b8800000-0000-4000-8000-000000000002','other','unauthorized')$q$,'42501','new row violates row-level security policy for table "pets"','machine admin: cross-customer pet insert refused by RLS');
SELECT throws_ok($q$UPDATE public.pets SET name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','machine admin: cross-customer pet update refused by existing read ACL');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000001' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000003' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-701' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'1,1,1','machine admin: canonical active entries remain visible');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000002' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000004' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-702' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'0,0,0','machine admin: canonical inactive entries remain hidden');
RESET ROLE;

-- revoked membership: real browser caller; membership visibility cannot expand customer authority.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"b8900000-0000-4000-8000-000000000004","role":"authenticated"}',true);
SELECT is((SELECT count(*)::integer FROM public.admin_users WHERE id='b8900000-0000-4000-8000-000000000004'),0,'revoked membership: own membership visibility');
SELECT is((SELECT count(*)::integer FROM public.clients WHERE id='b8800000-0000-4000-8000-000000000002'),0,'revoked membership: cross-customer profile read refused');
WITH changed AS (UPDATE public.clients SET first_name='unauthorized' WHERE id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'revoked membership: cross-customer profile update refused');
SELECT is((SELECT count(*)::integer FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'revoked membership: cross-customer addresses read refused');
WITH changed AS (UPDATE public.addresses SET line1='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'revoked membership: cross-customer addresses update refused');
SELECT throws_ok($q$INSERT INTO public.addresses(client_id,kind,line1,city,postal_code) VALUES ('b8800000-0000-4000-8000-000000000002','shipping','unauthorized','runtime locality','00-001')$q$,'42501','new row violates row-level security policy for table "addresses"','revoked membership: cross-customer addresses insert refused by RLS');
WITH changed AS (DELETE FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'revoked membership: cross-customer addresses delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'revoked membership: cross-customer customer_orderer_profiles read refused');
WITH changed AS (UPDATE public.customer_orderer_profiles SET full_name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'revoked membership: cross-customer customer_orderer_profiles update refused');
SELECT throws_ok($q$INSERT INTO public.customer_orderer_profiles(client_id,full_name,email) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime-refused@example.invalid')$q$,'42501','new row violates row-level security policy for table "customer_orderer_profiles"','revoked membership: cross-customer customer_orderer_profiles insert refused by RLS');
WITH changed AS (DELETE FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'revoked membership: cross-customer customer_orderer_profiles delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_account_events WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'revoked membership: cross-customer account events read refused');
SELECT throws_ok($q$INSERT INTO public.customer_account_events(client_id,event_type,entity_type) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime_fixture')$q$,'42501','new row violates row-level security policy for table "customer_account_events"','revoked membership: cross-customer account event insert refused by RLS');
SELECT throws_ok($q$SELECT id FROM public.pets WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','revoked membership: pets read refused by existing ACL');
SELECT throws_ok($q$INSERT INTO public.pets(client_id,pet_type,name) VALUES ('b8800000-0000-4000-8000-000000000002','other','unauthorized')$q$,'42501','new row violates row-level security policy for table "pets"','revoked membership: cross-customer pet insert refused by RLS');
SELECT throws_ok($q$UPDATE public.pets SET name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','revoked membership: cross-customer pet update refused by existing read ACL');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000001' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000003' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-701' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'1,1,1','revoked membership: canonical active entries remain visible');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000002' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000004' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-702' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'0,0,0','revoked membership: canonical inactive entries remain hidden');
RESET ROLE;

-- plain customer: real browser caller; membership visibility cannot expand customer authority.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"b8900000-0000-4000-8000-000000000001","role":"authenticated"}',true);
SELECT is((SELECT count(*)::integer FROM public.admin_users WHERE id='b8900000-0000-4000-8000-000000000001'),0,'plain customer: own membership visibility');
SELECT is((SELECT count(*)::integer FROM public.clients WHERE id='b8800000-0000-4000-8000-000000000002'),0,'plain customer: cross-customer profile read refused');
WITH changed AS (UPDATE public.clients SET first_name='unauthorized' WHERE id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'plain customer: cross-customer profile update refused');
SELECT is((SELECT count(*)::integer FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'plain customer: cross-customer addresses read refused');
WITH changed AS (UPDATE public.addresses SET line1='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'plain customer: cross-customer addresses update refused');
SELECT throws_ok($q$INSERT INTO public.addresses(client_id,kind,line1,city,postal_code) VALUES ('b8800000-0000-4000-8000-000000000002','shipping','unauthorized','runtime locality','00-001')$q$,'42501','new row violates row-level security policy for table "addresses"','plain customer: cross-customer addresses insert refused by RLS');
WITH changed AS (DELETE FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'plain customer: cross-customer addresses delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'plain customer: cross-customer customer_orderer_profiles read refused');
WITH changed AS (UPDATE public.customer_orderer_profiles SET full_name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'plain customer: cross-customer customer_orderer_profiles update refused');
SELECT throws_ok($q$INSERT INTO public.customer_orderer_profiles(client_id,full_name,email) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime-refused@example.invalid')$q$,'42501','new row violates row-level security policy for table "customer_orderer_profiles"','plain customer: cross-customer customer_orderer_profiles insert refused by RLS');
WITH changed AS (DELETE FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),0,'plain customer: cross-customer customer_orderer_profiles delete refused');
SELECT is((SELECT count(*)::integer FROM public.customer_account_events WHERE client_id='b8800000-0000-4000-8000-000000000002'),0,'plain customer: cross-customer account events read refused');
SELECT throws_ok($q$INSERT INTO public.customer_account_events(client_id,event_type,entity_type) VALUES ('b8800000-0000-4000-8000-000000000002','unauthorized','runtime_fixture')$q$,'42501','new row violates row-level security policy for table "customer_account_events"','plain customer: cross-customer account event insert refused by RLS');
SELECT throws_ok($q$SELECT id FROM public.pets WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','plain customer: pets read refused by existing ACL');
SELECT throws_ok($q$INSERT INTO public.pets(client_id,pet_type,name) VALUES ('b8800000-0000-4000-8000-000000000002','other','unauthorized')$q$,'42501','new row violates row-level security policy for table "pets"','plain customer: cross-customer pet insert refused by RLS');
SELECT throws_ok($q$UPDATE public.pets SET name='unauthorized' WHERE client_id='b8800000-0000-4000-8000-000000000002'$q$,'42501','permission denied for table pets','plain customer: cross-customer pet update refused by existing read ACL');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000001' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000003' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-701' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'1,1,1','plain customer: canonical active entries remain visible');
SELECT is((SELECT string_agg(n::text,',' ORDER BY source) FROM (SELECT 1 AS source,count(*) AS n FROM public.address_canon_localities WHERE id='b8b00000-0000-4000-8000-000000000002' UNION ALL SELECT 2,count(*) FROM public.address_canon_streets WHERE id='b8b00000-0000-4000-8000-000000000004' UNION ALL SELECT 3,count(*) FROM public.address_canon_postal_localities WHERE postal_code='98-702' AND locality_id='b8b00000-0000-4000-8000-000000000001') visible),'0,0,0','plain customer: canonical inactive entries remain hidden');
RESET ROLE;

-- Positive own-profile update preserves the existing customer seam.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims','{"sub":"b8900000-0000-4000-8000-000000000001","role":"authenticated"}',true);
WITH changed AS (UPDATE public.clients SET first_name='runtime own'
 WHERE id='b8800000-0000-4000-8000-000000000001' RETURNING id)
SELECT is((SELECT count(*)::integer FROM changed),1,'plain customer can still update its own profile');
RESET ROLE;
-- Owner observes persisted state only, never substitutes for a runtime caller.
SELECT is((SELECT first_name FROM public.clients WHERE id='b8800000-0000-4000-8000-000000000001'),
 'runtime own','own customer update persisted');
SELECT ok((SELECT first_name IS NULL FROM public.clients WHERE id='b8800000-0000-4000-8000-000000000002'),
 'all cross-customer profile updates leave owner-observed state unchanged');
SELECT is((SELECT string_agg(line1,',' ORDER BY id) FROM public.addresses WHERE client_id='b8800000-0000-4000-8000-000000000002'),
 'runtime original','refused address inserts updates and deletes leave exactly the original row');
SELECT is((SELECT string_agg(event_type,',' ORDER BY id) FROM public.customer_account_events WHERE client_id='b8800000-0000-4000-8000-000000000002'),
 'runtime_original','refused account events leave exactly the original row');
SELECT is((SELECT string_agg(full_name,',' ORDER BY id) FROM public.customer_orderer_profiles WHERE client_id='b8800000-0000-4000-8000-000000000002'),
 'runtime original','refused orderer inserts updates and deletes leave exactly the original row');
SELECT is((SELECT string_agg(name,',' ORDER BY id) FROM public.pets WHERE client_id='b8800000-0000-4000-8000-000000000002'),
 'runtime original','refused pet writes leave exactly the original row');
SELECT * FROM finish();
ROLLBACK;
