SELECT plan(9);

SELECT ok((
  SELECT relowner = current_user::regrole AND relrowsecurity AND NOT relforcerowsecurity
    AND NOT EXISTS (SELECT FROM pg_policy WHERE polrelid = c.oid)
    AND NOT EXISTS (SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) WHERE grantee <> c.relowner)
    AND NOT EXISTS (SELECT FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) WHERE a.attrelid = c.oid)
  FROM pg_class c WHERE oid = 'public.commerce_order_draft_receipts_v2'::regclass
), 'private receipt storage');

SELECT ok((
  SELECT relowner = current_user::regrole AND relrowsecurity AND NOT relforcerowsecurity
    AND NOT EXISTS (SELECT FROM pg_policy WHERE polrelid = c.oid)
    AND NOT EXISTS (SELECT FROM aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) WHERE grantee <> c.relowner)
    AND NOT EXISTS (SELECT FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) WHERE a.attrelid = c.oid)
  FROM pg_class c WHERE oid = 'public.commerce_order_draft_receipt_erasure_marks'::regclass
), 'private erasure marks');

SELECT is((
  SELECT array_agg(attname::text ORDER BY attnum) FROM pg_attribute
  WHERE attrelid = 'public.commerce_order_draft_receipts_v2'::regclass AND attnum > 0 AND NOT attisdropped
), ARRAY['storage_key','installation_ref','principal_kind','principal_ref','customer_or_session_ref','command_digest','order_id','created_at'],
'closed receipt columns');

SELECT ok((
  SELECT condeferrable AND condeferred AND confdeltype = 'a' AND confupdtype = 'a'
    AND confrelid = 'public.commerce_order_tax_snapshots'::regclass
  FROM pg_constraint WHERE conrelid = 'public.commerce_order_draft_receipts_v2'::regclass
    AND conname = 'commerce_order_draft_receipts_v2_order_id_fkey'
), 'deferred NO ACTION snapshot foreign key');

SELECT is((
  SELECT array_agg(format('%s:%s:%s:%s', c.relname, a.amname, pg_get_indexdef(i.indexrelid,1,false),
    pg_get_expr(i.indpred,i.indrelid)) ORDER BY c.relname)
  FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_am a ON a.oid = c.relam
  WHERE i.indrelid = 'public.commerce_order_draft_receipts_v2'::regclass AND i.indpred IS NOT NULL
), ARRAY[
  'commerce_order_draft_receipts_v2_customer_idx:btree:customer_or_session_ref:(customer_or_session_ref IS NOT NULL)',
  'commerce_order_draft_receipts_v2_principal_idx:btree:principal_ref:(principal_ref IS NOT NULL)'
], 'two partial owner indexes');

SELECT is((
  SELECT array_agg(format('%s:%s:%s:%s:%s:%s',tgname,tgtype,tgdeferrable,tginitdeferred,tgenabled,tgfoid::regprocedure)
    ORDER BY tgname) FROM pg_trigger
  WHERE tgrelid = 'public.commerce_order_draft_receipts_v2'::regclass AND NOT tgisinternal
), ARRAY[
  'commerce_order_draft_receipt_v2_erasure_check:17:t:t:O:commerce_order_draft_receipt_v2_erasure_check()',
  'commerce_order_draft_receipt_v2_immutable:27:f:f:O:commerce_order_draft_receipt_v2_immutable()'
], 'exact row trigger bindings');

CREATE TEMP VIEW receipt_function_attributes AS
SELECT p.*, name, language, volatility, definer, service_entry
FROM (VALUES
  ('commerce_order_draft_storage_key_v2(jsonb,text)', 'sql', 's', false, false),
  ('commerce_order_draft_receipt_v2_immutable()', 'plpgsql', 'v', false, false),
  ('commerce_read_order_draft_receipt_history_v2(text)', 'sql', 's', false, false),
  ('commerce_order_draft_receipt_v2_consume_erasure_mark(uuid,uuid,uuid)', 'plpgsql', 'v', true, true),
  ('commerce_order_draft_receipt_v2_erasure_check()', 'plpgsql', 'v', false, false),
  ('commerce_order_draft_receipt_privacy_matches_v2(uuid,uuid,uuid)', 'sql', 's', false, false),
  ('commerce_export_order_draft_receipts_v2(uuid,uuid)', 'sql', 's', true, true),
  ('commerce_erase_order_draft_receipts_v2(uuid,uuid,uuid)', 'plpgsql', 'v', true, true),
  ('commerce_read_order_draft_receipt_v2(jsonb)', 'plpgsql', 's', true, true)
) AS expected(name,language,volatility,definer,service_entry)
JOIN pg_proc p ON p.oid = ('public.' || name)::regprocedure;

SELECT ok(count(*) = 9 AND bool_and(
  p.proowner = current_user::regrole AND l.lanname::text = p.language AND p.provolatile::text = p.volatility
    AND p.prosecdef = p.definer AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']
), 'pinned owner, language, volatility and security for nine functions')
FROM receipt_function_attributes p JOIN pg_language l ON l.oid = p.prolang;

SELECT ok(bool_and(
  NOT EXISTS (SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) WHERE grantee <> p.proowner
    AND NOT coalesce(p.service_entry AND grantee = to_regrole('service_role') AND privilege_type = 'EXECUTE' AND NOT is_grantable, false))
  AND CASE WHEN p.service_entry AND to_regrole('service_role') IS NOT NULL
    THEN has_function_privilege(to_regrole('service_role'),p.oid,'EXECUTE') ELSE true END
), 'only the four listed definers are executable by the optional service role')
FROM receipt_function_attributes p;

SELECT is((
  SELECT count(*)::int FROM public.identity_privacy_required_contributors WHERE contributor_id = 'order-draft-receipts'
), 1, 'declaration installed once');

SELECT * FROM finish();
