-- Supabase managed-environment test adapter for the stock PostgreSQL pgTAP lane.
--
-- TEST INFRASTRUCTURE ONLY. It is never applied to a real managed project and
-- no runtime, installer or migration chain applies it. scripts/public-ci-pgtap-postgres.mjs
-- runs it as the neutral bootstrap superuser on a disposable stock PostgreSQL 17
-- server, before the shared prerequisites and the managed baseline replay.
--
-- Every attribute, membership, setting, owner and grant below was recorded from
-- the pinned managed image (supabase/postgres 17.11.0.006 under Supabase CLI
-- 2.122.0, after GoTrue's schema init) with the environment fingerprint in
-- scripts/pgtap-parity.mjs. Accepted differences are listed in
-- docs/platform/plans/neutral-postgres-pgtap.md ("W1 evidence"): roles of absent
-- services (dashboard_user, pgbouncer, storage/realtime/functions admins, …) and
-- their grants, supautils/safeupdate preloads, GoTrue-only auth objects, LOGIN on
-- the placeholder identities, and preinstalled extensions nothing here uses.
-- Grant only what that fingerprint shows: an extra broad grant could mask a
-- missing platform grant. The file is idempotent.

-- Roles. postgres is an ordinary role, as on the managed host: not a superuser,
-- but CREATEROLE, CREATEDB, REPLICATION, BYPASSRLS and member of pg_read_all_data.
-- supabase_admin is the managed superuser identity; authenticator and
-- supabase_auth_admin are NOLOGIN placeholders that tests and grants name.
DO $$
DECLARE
  name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['supabase_admin', 'postgres', 'anon', 'authenticated', 'service_role', 'authenticator', 'supabase_auth_admin'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
      EXECUTE format('CREATE ROLE %I', name);
    END IF;
  END LOOP;
END $$;

ALTER ROLE supabase_admin SUPERUSER INHERIT CREATEROLE CREATEDB NOLOGIN REPLICATION BYPASSRLS;
ALTER ROLE postgres NOSUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS;
ALTER ROLE anon NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
ALTER ROLE authenticated NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
ALTER ROLE service_role NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION BYPASSRLS;
ALTER ROLE authenticator NOSUPERUSER NOINHERIT NOCREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;
ALTER ROLE supabase_auth_admin NOSUPERUSER NOINHERIT CREATEROLE NOCREATEDB NOLOGIN NOREPLICATION NOBYPASSRLS;

-- The managed value really is the identifier "\$user" (a literal backslash), not $user.
ALTER ROLE postgres SET search_path = "\$user", public, extensions;
ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE authenticated SET statement_timeout = '8s';
ALTER ROLE authenticator SET statement_timeout = '8s';
ALTER ROLE authenticator SET lock_timeout = '8s';
ALTER ROLE supabase_admin SET search_path = "\$user", public, auth, extensions;
ALTER ROLE supabase_admin SET log_statement = 'none';
ALTER ROLE supabase_auth_admin SET search_path = auth;
ALTER ROLE supabase_auth_admin SET idle_in_transaction_session_timeout = 60000;
ALTER ROLE supabase_auth_admin SET log_statement = 'none';

GRANT anon, authenticated, service_role, authenticator TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET TRUE;
GRANT pg_create_subscription, pg_monitor, pg_read_all_data, pg_signal_backend TO postgres WITH ADMIN TRUE, INHERIT TRUE, SET TRUE;
GRANT anon, authenticated, service_role TO authenticator WITH INHERIT FALSE, SET TRUE;

-- The managed host lets postgres set session_replication_role through supautils'
-- privileged-role settings; the native PostgreSQL equivalent is a parameter grant.
GRANT SET ON PARAMETER session_replication_role TO postgres;

-- Database and public schema.
ALTER DATABASE postgres OWNER TO postgres;
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
-- Managed defaults before the runner's default-privilege revocation; the
-- revocation leaves exactly the managed post-revocation entries.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres, anon, authenticated, service_role;

-- extensions schema: dblink and pgTAP install here, as on the managed host.
CREATE SCHEMA IF NOT EXISTS extensions AUTHORIZATION postgres;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions GRANT ALL ON TABLES TO postgres WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions GRANT ALL ON SEQUENCES TO postgres WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA extensions GRANT ALL ON FUNCTIONS TO postgres WITH GRANT OPTION;

-- dblink is a managed "privileged extension": supautils lets postgres create it
-- as the superuser identity. Stock PostgreSQL has no supautils, so it is created
-- here by that identity; the tests' CREATE EXTENSION IF NOT EXISTS then finds it.
SET ROLE supabase_admin;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
RESET ROLE;

-- auth schema: owned by supabase_admin, objects owned by supabase_auth_admin.
CREATE SCHEMA IF NOT EXISTS auth AUTHORIZATION supabase_admin;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role, postgres;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;

SET ROLE supabase_auth_admin;

-- Only the auth.users columns the platform SQL and tests use, with GoTrue's
-- types; the email uniqueness GoTrue enforces for non-SSO users is kept.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid NOT NULL PRIMARY KEY,
  email character varying(255),
  raw_app_meta_data jsonb,
  raw_user_meta_data jsonb,
  is_sso_user boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_partial_key ON auth.users (email) WHERE is_sso_user = false;

CREATE TABLE IF NOT EXISTS auth.identities (
  provider_id text NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  identity_data jsonb NOT NULL,
  provider text NOT NULL,
  last_sign_in_at timestamp with time zone,
  created_at timestamp with time zone,
  updated_at timestamp with time zone,
  email text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider)
);

-- Function definitions copied byte-for-byte from the managed image
-- (pg_get_functiondef), including the trailing space after `select`. They read
-- request.jwt.claims and fall back to the legacy scalar request.jwt.claim.* settings.
CREATE OR REPLACE FUNCTION auth.email()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$function$;

CREATE OR REPLACE FUNCTION auth.jwt()
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  select 
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$function$;

CREATE OR REPLACE FUNCTION auth.role()
 RETURNS text
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$function$;

CREATE OR REPLACE FUNCTION auth.uid()
 RETURNS uuid
 LANGUAGE sql
 STABLE
AS $function$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$function$;

RESET ROLE;

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.identities ENABLE ROW LEVEL SECURITY;
GRANT ALL ON TABLE auth.users, auth.identities TO postgres;
GRANT SELECT ON TABLE auth.users, auth.identities TO postgres WITH GRANT OPTION;
GRANT EXECUTE ON FUNCTION auth.jwt() TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON FUNCTIONS TO postgres;

-- pg_cron, created by the managed superuser identity. The server must preload
-- it with cron.database_name = postgres. postgres receives the managed
-- grant-option access; PUBLIC keeps only pg_cron's own table grants.
SET ROLE supabase_admin;
CREATE EXTENSION IF NOT EXISTS pg_cron;
RESET ROLE;
GRANT USAGE ON SCHEMA cron TO postgres WITH GRANT OPTION;
GRANT SELECT ON TABLE cron.job TO postgres WITH GRANT OPTION;
GRANT INSERT, SELECT, UPDATE, DELETE, TRUNCATE, REFERENCES, MAINTAIN ON TABLE cron.job_run_details TO postgres WITH GRANT OPTION;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA cron FROM PUBLIC;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cron TO postgres WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA cron GRANT ALL ON TABLES TO postgres WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA cron GRANT ALL ON SEQUENCES TO postgres WITH GRANT OPTION;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA cron GRANT ALL ON FUNCTIONS TO postgres WITH GRANT OPTION;
