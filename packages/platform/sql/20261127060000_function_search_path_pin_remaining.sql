DO $settings_owner_window$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles AS r WHERE r.rolname OPERATOR(pg_catalog.=) current_user) THEN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members AS a
      WHERE a.roleid OPERATOR(pg_catalog.=) (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname OPERATOR(pg_catalog.=) 'platform_acquisition_owner')
        AND a.member OPERATOR(pg_catalog.=) (SELECT r.oid FROM pg_catalog.pg_roles AS r WHERE r.rolname OPERATOR(pg_catalog.=) current_user)
        AND a.grantor OPERATOR(pg_catalog.=) a.member) THEN
      RAISE EXCEPTION 'installer already holds a self-granted membership in platform_acquisition_owner' USING ERRCODE = '42501',
        HINT = 'Revoke that membership with REVOKE platform_acquisition_owner FROM the installer GRANTED BY the installer, then rerun the migration.';
    END IF;
    EXECUTE pg_catalog.format('GRANT platform_acquisition_owner TO %I WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY %I', current_user, current_user);
  END IF;
END
$settings_owner_window$;
ALTER FUNCTION acquisition_private.case_projection(uuid) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION acquisition_private.keyed_digest(text,jsonb) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION acquisition_private.partner_case_projection(uuid) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION acquisition_private.refuse_append_only_mutation() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION auth.uid() SET search_path = pg_catalog, pg_temp;
DO $settings_owner_window$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles AS r WHERE r.rolname OPERATOR(pg_catalog.=) current_user) THEN
    EXECUTE pg_catalog.format('REVOKE platform_acquisition_owner FROM %I GRANTED BY %I', current_user, current_user);
  END IF;
END
$settings_owner_window$;
