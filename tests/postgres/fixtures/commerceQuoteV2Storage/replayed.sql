SELECT plan(6);
SELECT results_eq('SELECT * FROM applied_prefix ORDER BY position', 'SELECT * FROM expected_prefix ORDER BY position',
  'replay contains exactly this forward and its prerequisites in the exact forward prefix');
SELECT ok(NOT EXISTS (SELECT FROM (VALUES
    ('tax_calculation_check_domain_v1', ARRAY['p_invocation','p_pin','p_seal','p_complete'],
      ARRAY['jsonb','jsonb','jsonb','boolean']::regtype[], 'text'::regtype, 'sql'),
    ('tax_calculation_terminal_v1', ARRAY['r'], ARRAY['public.tax_calculations']::regtype[], 'jsonb'::regtype, 'plpgsql')
  ) expected(name,argnames,argtypes,result,language)
  LEFT JOIN evaluation_routine_catalog p ON p.proname=expected.name
  WHERE (p.proargnames,ARRAY(SELECT unnest(p.proargtypes)::regtype),p.prorettype,p.lanname::text,
         p.proargmodes,p.pronargdefaults,p.proretset)
    IS DISTINCT FROM (expected.argnames,expected.argtypes,expected.result,expected.language,NULL::"char"[],0,false)),
  'names, named argument identities and types, return types and languages are exact');
SELECT ok(NOT EXISTS (SELECT FROM evaluation_routine_catalog p WHERE
  (p.proowner,p.provolatile,p.prosecdef,p.proconfig) IS DISTINCT FROM
    (current_user::regrole::oid,'s'::"char",false,ARRAY['search_path=pg_catalog, pg_temp'])),
  'both routines remain stable invoker with the exact path and migration owner');
SELECT ok((SELECT count(*) FROM predecessor_routines b JOIN evaluation_routine_catalog p ON p.oid=b.oid
  WHERE (to_jsonb(p) - ARRAY['prosrc','provolatile','prosecdef','proconfig'])
        = (to_jsonb(b) - ARRAY['prosrc','provolatile','prosecdef','proconfig'])
    AND p.prosrc <> b.prosrc) = 2, 'both changed bodies preserve predecessor catalog headers, owners, ACLs and effective grants');
SELECT ok(NOT EXISTS (SELECT FROM evaluation_routine_catalog p
  CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0)
  AND NOT EXISTS (SELECT FROM evaluation_routine_catalog p WHERE cardinality(p.effective_application_grants) <> 0),
  'PUBLIC, browser and runtime roles have no executable access to either helper');
SELECT is((SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')),
  (SELECT CASE WHEN present THEN 3 ELSE 0 END::bigint FROM replay_fixture_roles), 'optional roles match the selected replay');
SELECT * FROM finish();
