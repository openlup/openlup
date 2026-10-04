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
SELECT plan(32);
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
SELECT * FROM finish();
ROLLBACK;
