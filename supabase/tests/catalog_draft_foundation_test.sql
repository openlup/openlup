-- Isolated draft persistence: no fixture enters a current catalog relation.
BEGIN;
SELECT plan(35);
CREATE FUNCTION pg_temp.draft_apply(c jsonb) RETURNS jsonb LANGUAGE sql AS $$
  SELECT public.catalog_draft_apply(c::text,encode(sha256(convert_to(c::text,'UTF8')),'hex'))
$$;
CREATE TEMP TABLE draft_fixture AS SELECT
  'f2000000-0000-4000-8000-000000000001'::uuid draft_id,
  '{"schemaVersion":1,"product":{"id":"f2000000-0000-4000-8000-000000000002","type":{"key":"example:item","version":1},"dimensions":[],"sharedContent":{"title":"Shared content"}},"skus":[{"id":"f2000000-0000-4000-8000-000000000003","productId":"f2000000-0000-4000-8000-000000000002","code":"DRAFT-TEST-200","options":{},"netContent":{"dimension":"mass","unscaled":"200","scale":0,"unit":"metric:g"}}]}'::jsonb payload;
CREATE TEMP TABLE draft_commands AS SELECT jsonb_build_object('schemaVersion',1,'action','create','draftId',draft_id,
  'expectedRevision',0,'commandKey','initial','payload',payload) c FROM draft_fixture;
CREATE TEMP TABLE draft_witness AS SELECT jsonb_build_object(
  'products',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.catalog_products x),
  'skus',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.catalog_skus x),
  'documents',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.catalog_product_document_revisions x),
  'prices',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.catalog_prices x),
  'events',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY event_no),'[]') FROM public.catalog_publication_events x),
  'subscriptions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.subscriptions x)) value;
INSERT INTO public.admin_users(id,email,role,is_machine_actor) VALUES
  ('f2000000-0000-4000-8000-000000000010','draft-admin@example.invalid','admin',false),
  ('f2000000-0000-4000-8000-000000000011','draft-distributor@example.invalid','distributor',false);
SELECT is((SELECT count(*)::integer FROM public.catalog_draft_heads),0,'migration seeds no draft heads');
SELECT is((SELECT count(*)::integer FROM public.catalog_draft_revisions),0,'migration seeds no draft revisions');
SELECT ok(NOT EXISTS(SELECT FROM unnest(ARRAY['anon','authenticated','service_role']) role,
  unnest(ARRAY['catalog_draft_heads','catalog_draft_revisions','catalog_draft_command_receipts','catalog_draft_sku_reservations']) rel,
  unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) privilege
  WHERE has_table_privilege(role,'public.'||rel,privilege)),'all runtime table privileges are withdrawn');
SELECT ok(NOT EXISTS(SELECT FROM unnest(ARRAY['anon','service_role']) role,
  unnest(ARRAY['catalog_draft_apply(text,text)','catalog_draft_get(uuid,integer,text)','catalog_draft_list(uuid,integer)']) fn
  WHERE has_function_privilege(role,'public.'||fn,'EXECUTE')),'anonymous and service callers have no draft routine execution');
SELECT ok(NOT EXISTS(SELECT FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl
  WHERE p.proname LIKE 'catalog_draft_%' AND acl.grantee=0 AND acl.privilege_type='EXECUTE'),'PUBLIC cannot execute any draft routine');
SELECT set_config('request.jwt.claims','{"sub":"f2000000-0000-4000-8000-000000000011","role":"authenticated"}',true);
SELECT throws_ok($$SELECT public.catalog_draft_get('f2000000-0000-4000-8000-000000000001')$$,'42501','catalog_draft_admin_required','distributor cannot read drafts');
SELECT set_config('request.jwt.claims','{"sub":"f2000000-0000-4000-8000-000000000010","role":"authenticated"}',true);
CREATE TEMP TABLE draft_original AS SELECT pg_temp.draft_apply(c)->'record' record FROM draft_commands;
SELECT is((SELECT record->>'revision' FROM draft_original),'1','create commits revision one');
SELECT is((SELECT record->>'actorId' FROM draft_original),'f2000000-0000-4000-8000-000000000010','actor is derived from authenticated context');
SELECT is((SELECT pg_temp.draft_apply(c)->>'outcome' FROM draft_commands),'replayed','identical command replays');
SELECT is((SELECT pg_temp.draft_apply(jsonb_set(c,'{payload,product,sharedContent,title}','"changed"'))->>'reason' FROM draft_commands),'command_key_reused','same key different payload refuses');
SELECT is((SELECT pg_temp.draft_apply(c||'{"action":"revise","expectedRevision":1,"commandKey":"second"}')->'record'->>'revision' FROM draft_commands),'2','revision advances');
SELECT is((SELECT pg_temp.draft_apply(c)->'record' FROM draft_commands),(SELECT record FROM draft_original),'old command replays original record after moved head');
SELECT is(public.catalog_draft_get('f2000000-0000-4000-8000-000000000001',NULL,'initial'),(SELECT record FROM draft_original),'receipt readback resolves original lost response');
SELECT is((SELECT pg_temp.draft_apply(c||'{"action":"revise","expectedRevision":1,"commandKey":"stale"}')->>'reason' FROM draft_commands),'revision_conflict','stale save refuses');
SELECT is((SELECT pg_temp.draft_apply(jsonb_set(c||'{"action":"revise","expectedRevision":2,"commandKey":"foreign"}','{payload,skus,0,productId}','"f2000000-0000-4000-8000-000000000099"'))->>'reason' FROM draft_commands),'sku_reference_invalid','foreign SKU owner refuses');
SELECT is((SELECT pg_temp.draft_apply(jsonb_set(c||'{"action":"revise","expectedRevision":2,"commandKey":"primary"}','{payload,product,primarySkuId}','"f2000000-0000-4000-8000-000000000099"'))->>'reason' FROM draft_commands),'product_reference_invalid','foreign primary refuses');
SELECT is((SELECT pg_temp.draft_apply(jsonb_set(c||'{"action":"revise","expectedRevision":2,"commandKey":"document"}','{payload,product,documentRevision}','{"id":"f2000000-0000-4000-8000-000000000098","productId":"f2000000-0000-4000-8000-000000000099"}'))->>'reason' FROM draft_commands),'product_reference_invalid','foreign document owner refuses');
SELECT is((SELECT pg_temp.draft_apply(jsonb_set(c||'{"action":"revise","expectedRevision":2,"commandKey":"no-type"}','{payload,product,type}','null'))->>'reason' FROM draft_commands),'payload_invalid','missing type contract refuses');
SELECT is((SELECT pg_temp.draft_apply(jsonb_set(c||'{"action":"revise","expectedRevision":2,"commandKey":"no-dimensions"}','{payload,product,dimensions}','null'))->>'reason' FROM draft_commands),'payload_invalid','missing dimensions refuses');
SELECT is((SELECT pg_temp.draft_apply(jsonb_set(c||'{"action":"revise","expectedRevision":2,"commandKey":"no-options"}','{payload,skus,0,options}','null'))->>'reason' FROM draft_commands),'sku_reference_invalid','missing SKU options refuses');
SELECT is(public.catalog_draft_apply('{}',repeat('0',64))->>'reason','command_fingerprint_invalid','fingerprint must bind actual command bytes');
SELECT is((SELECT pg_temp.draft_apply(jsonb_set(c,'{payload,product,sharedContent}',to_jsonb(repeat('a',1048576))))->>'reason' FROM draft_commands),'command_fingerprint_invalid','oversize command refuses before storage');
SELECT is((SELECT pg_temp.draft_apply((c-'payload')||'{"action":"abandon","expectedRevision":2,"commandKey":"abandon"}')->'record'->>'status' FROM draft_commands),'abandoned','abandon appends durable revision');
SELECT is((SELECT pg_temp.draft_apply(c)->'record' FROM draft_commands),(SELECT record FROM draft_original),'abandon does not invalidate original replay');
SELECT is((SELECT count(*)::integer FROM public.catalog_draft_sku_reservations),1,'abandon retains SKU reservation');
SELECT is((SELECT pg_temp.draft_apply(c||'{"draftId":"f2000000-0000-4000-8000-000000000020","commandKey":"new"}')->>'outcome' FROM draft_commands),'conflict','another draft cannot claim retained product or SKU identity');
SELECT throws_ok($$UPDATE public.catalog_draft_revisions SET payload='{}'$$,'55000','catalog_draft_history_immutable','revision cannot be rewritten even by owner DML');
SELECT throws_ok($$UPDATE public.catalog_draft_command_receipts SET fingerprint=repeat('0',64)$$,'55000','catalog_draft_history_immutable','receipt cannot be rewritten even by owner DML');
SELECT is(jsonb_array_length(public.catalog_draft_list(NULL,1)->'items'),1,'bounded list returns one summary');
SELECT ok(NOT (public.catalog_draft_list(NULL,1)->'items'->0 ? 'payload'),'list omits potentially large draft payload');
SELECT throws_ok($$SELECT public.catalog_draft_list(NULL,101)$$,'22023','list_limit_invalid','page limit above one hundred refuses');
SET LOCAL ROLE authenticated;
SELECT throws_ok($$SELECT * FROM public.catalog_draft_revisions$$,'42501','permission denied for table catalog_draft_revisions','administrator cannot directly read immutable storage');
SELECT throws_ok($$TRUNCATE public.catalog_draft_command_receipts$$,'42501',NULL,'administrator cannot truncate receipts');
RESET ROLE;
SELECT is(jsonb_build_object(
  'products',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.catalog_products x),
  'skus',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.catalog_skus x),
  'documents',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.catalog_product_document_revisions x),
  'prices',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.catalog_prices x),
  'events',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY event_no),'[]') FROM public.catalog_publication_events x),
  'subscriptions',(SELECT coalesce(jsonb_agg(to_jsonb(x) ORDER BY id),'[]') FROM public.subscriptions x)),
  (SELECT value FROM draft_witness),'all managed live witnesses remain unchanged');
SELECT is((SELECT count(*)::integer FROM public.catalog_draft_command_receipts),3,'only three admitted commands own receipts');
SELECT * FROM finish();
ROLLBACK;
