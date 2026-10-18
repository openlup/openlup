-- Public self-host actor-auth bootstrap.
--
-- This append-only platform forward establishes only the default-deny actor
-- roles and `auth.uid()` primitive required by a future actor-scoped
-- capability. The node-postgres runtime applies this exact manifest unit
-- before listening; it does not select the historical private compatibility
-- bootstrap. No customer mapping, table privilege, policy, verifier, managed
-- migration, service role, or additional auth helper is introduced here.
--
-- openlup:allow-grant: grants only auth schema usage and auth.uid() execution to the two
-- default-deny actor roles; fresh final-image Compose proof verifies their exact ACLs and RLS lane.

CREATE ROLE anon NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE authenticated NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

CREATE SCHEMA auth;

CREATE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN current_setting('request.jwt.claims', true) IS NULL THEN NULL
    WHEN current_setting('request.jwt.claims', true) = '' THEN NULL
    WHEN jsonb_typeof(current_setting('request.jwt.claims', true)::jsonb -> 'sub') <> 'string' THEN NULL
    WHEN current_setting('request.jwt.claims', true)::jsonb ->> 'sub'
      !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN NULL
    ELSE (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
  END
$$;

REVOKE ALL ON SCHEMA auth FROM PUBLIC;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;

GRANT anon TO CURRENT_USER WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
GRANT authenticated TO CURRENT_USER WITH INHERIT FALSE, SET TRUE, ADMIN FALSE;
