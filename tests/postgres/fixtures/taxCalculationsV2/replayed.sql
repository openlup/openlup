SELECT plan(12);
SELECT is((SELECT pg_get_userbyid(relowner)::text FROM pg_class WHERE oid='public.tax_calculations'::regclass), current_user::text, 'migration owner owns the evaluation relation');
SELECT ok((SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid='public.tax_calculations'::regclass), 'private table has non-FORCE row-level security');
SELECT is((SELECT count(*) FROM pg_policy WHERE polrelid='public.tax_calculations'::regclass), 0::bigint, 'no policy admits storage reads');
SELECT ok(NOT EXISTS(SELECT FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') AND
  (has_table_privilege(oid,'public.tax_calculations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
   has_any_column_privilege(oid,'public.tax_calculations','SELECT,INSERT,UPDATE,REFERENCES'))), 'browser and service roles have no effective table or column access');
SELECT ok(NOT EXISTS(SELECT FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) WHERE attrelid='public.tax_calculations'::regclass), 'no column grants');
SELECT ok((SELECT indisunique AND indpred IS NOT NULL FROM pg_index WHERE indexrelid='public.tax_calculations_provider_key'::regclass), 'provider marker has a named partial unique index');
SELECT ok((SELECT convalidated AND confmatchtype='f' AND cardinality(conkey)=3 FROM pg_constraint WHERE conrelid='public.tax_calculations'::regclass AND confrelid='public.tax_coverage_revisions'::regclass), 'coverage FK is validated and all-or-none');
SELECT ok((SELECT convalidated FROM pg_constraint WHERE conrelid='public.tax_calculations'::regclass AND confrelid='public.commerce_destination_v2_documents'::regclass), 'snapshot FK is validated');
SELECT ok(NOT EXISTS(SELECT FROM (VALUES
    ('public.tax_calculation_frame_v1(text,jsonb)','s',false,'pg_catalog, pg_temp'),
    ('public.tax_calculation_hash_v1(text,jsonb)','s',false,'pg_catalog, pg_temp'),
    ('public.tax_calculation_guard_v1()','v',false,'pg_catalog'),
    ('public.tax_calculation_terminal_v1(public.tax_calculations)','s',false,'pg_catalog, pg_temp'),
    ('public.tax_calculation_export_v1(uuid)','s',true,'pg_catalog, pg_temp'),
    ('public.tax_calculation_erase_v1(uuid)','v',true,'pg_catalog, pg_temp')
  ) expected(signature,volatility,definer,path)
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE (pg_get_userbyid(p.proowner)::text,p.provolatile::text,p.prosecdef,p.proconfig)
    IS DISTINCT FROM (current_user::text,expected.volatility,expected.definer,ARRAY['search_path='||expected.path])
), 'all six exact routines have the required attribute tuple');
SELECT is((SELECT count(*) FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.pronamespace='public'::regnamespace AND p.proname LIKE 'tax_calculation_%' AND a.grantee=0), 0::bigint, 'PUBLIC execute is revoked');
SELECT ok(to_regprocedure('public.tax_calculation_begin_v1(jsonb)') IS NULL, 'claim routine is absent');
SELECT ok(to_regprocedure('public.tax_calculation_complete_v1(jsonb)') IS NULL, 'seal routine is absent');
SELECT * FROM finish();
