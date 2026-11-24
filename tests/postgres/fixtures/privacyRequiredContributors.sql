BEGIN;
SET LOCAL search_path = public, extensions;
SELECT plan(10);

SELECT is(public.identity_privacy_required_contributor_ids(),
  ARRAY['communication-events','customer-billing','customer-preferences','customer-saved-addresses',
    'destination-documents','destination-receipts','fulfillment-parcel-contacts','identity','subscriptions'],
  'owner reads the canonical nine declarations');
SELECT ok((SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_catalog.pg_class
  WHERE oid='public.identity_privacy_required_contributors'::regclass), 'RLS enabled');
SELECT is((SELECT count(*) FROM pg_catalog.pg_policy
  WHERE polrelid='public.identity_privacy_required_contributors'::regclass), 0::bigint, 'no runtime policy');
SELECT ok((SELECT prosecdef AND provolatile='s' AND proconfig=ARRAY['search_path=pg_catalog, pg_temp']
  FROM pg_catalog.pg_proc WHERE oid='public.identity_privacy_required_contributor_ids()'::regprocedure), 'pinned stable definer');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname <> current_user AND NOT r.rolsuper
  AND pg_catalog.left(r.rolname,3)<>'pg_' AND
  (pg_catalog.has_table_privilege(r.oid,'public.identity_privacy_required_contributors','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
   OR pg_catalog.has_any_column_privilege(r.oid,'public.identity_privacy_required_contributors','SELECT,INSERT,UPDATE,REFERENCES'))),
  'no effective non-owner table or column grants');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname IN ('anon','authenticated','authenticator')
  AND pg_catalog.has_function_privilege(r.oid,'public.identity_privacy_required_contributor_ids()','EXECUTE')), 'browser roles and authenticator lack reader access');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles r WHERE r.rolname='service_role' AND
  (NOT pg_catalog.has_function_privilege(r.oid,'public.identity_privacy_required_contributor_ids()','EXECUTE')
   OR pg_catalog.has_function_privilege(r.oid,'public.identity_privacy_required_contributor_ids()','EXECUTE WITH GRANT OPTION'))), 'service role gets execute without grant option when present');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, LATERAL pg_catalog.aclexplode(p.proacl) acl
  WHERE p.oid='public.identity_privacy_required_contributor_ids()'::regprocedure AND acl.grantee <> p.proowner
  AND (acl.grantee <> coalesce((SELECT oid FROM pg_catalog.pg_roles WHERE rolname='service_role'),0::oid) OR acl.grantee=0)),
  'function ACL grants only owner and existing service role');
SELECT ok(NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c, LATERAL pg_catalog.aclexplode(c.relacl) acl
  WHERE c.oid='public.identity_privacy_required_contributors'::regclass AND acl.grantee<>c.relowner),
  'declaration has no direct non-owner ACL');
SELECT ok(NOT pg_catalog.has_table_privilege('privacy_fixture_writer','public.identity_privacy_required_contributors','INSERT'),
  'an unrelated role cannot append');

SELECT * FROM finish();
ROLLBACK;
