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
ALTER FUNCTION public.acquisition_case_active_count_v1() SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.acquisition_case_operator_get_v1(uuid,text) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.acquisition_case_operator_list_v1(uuid,timestamptz,uuid,integer) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.acquisition_case_submit_v1(text,text,text,text,boolean,text,text,text,text,text,text,text,text,timestamptz) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.acquisition_case_transition_v1(uuid,text,bigint,text,text,text,timestamptz) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.acquisition_newsletter_consent_v1(text,text,text,text,text,boolean,timestamptz,timestamptz) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.acquisition_survey_operator_list_v1(uuid,text,integer) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.acquisition_survey_submit_v1(text,text,text,jsonb,timestamptz) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.partner_acquisition_operator_list_v1(uuid,timestamptz,uuid,integer) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.partner_acquisition_submit_v1(text,text,text,text,text,text,text,text,text,text,text,timestamptz) SET search_path = pg_catalog, pg_temp;
ALTER FUNCTION public.partner_acquisition_transition_v1(uuid,text,bigint,text,text,timestamptz) SET search_path = pg_catalog, pg_temp;
DO $settings_owner_window$
BEGIN
  IF NOT (SELECT r.rolsuper FROM pg_catalog.pg_roles AS r WHERE r.rolname OPERATOR(pg_catalog.=) current_user) THEN
    EXECUTE pg_catalog.format('REVOKE platform_acquisition_owner FROM %I GRANTED BY %I', current_user, current_user);
  END IF;
END
$settings_owner_window$;
