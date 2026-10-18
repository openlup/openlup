-- Committed managed grants cannot enable transactional identity erasure.
BEGIN;
SELECT plan(4);
SELECT ok(NOT has_column_privilege('service_role', 'public.clients', 'first_name', 'UPDATE'), 'contact name erasure is not granted');
SELECT ok(NOT has_column_privilege('service_role', 'public.clients', 'country', 'SELECT'), 'country export remains explicitly unavailable');
SELECT ok(NOT has_column_privilege('service_role', 'public.admin_users', 'email', 'UPDATE'), 'membership pseudonymization is not granted');
SELECT ok(to_regclass('public.identity_privacy_erasures') IS NULL, 'no managed erasure receipt capability is installed');
SELECT * FROM finish();
ROLLBACK;
