-- Vanilla-Postgres bootstrap prelude — auth schema shim (Tier P2).
-- Reproduces the Supabase `auth.*` helpers that RLS policies depend on (audit §2: ~50 files
-- using auth.uid()/auth.jwt()/auth.role()). The functions read `request.jwt.claims` — the exact
-- GUC PostgREST sets per request — so the app's DataGatewayPort `pg` adapter only has to
-- `SET LOCAL request.jwt.claims = '<json>'` inside a tx-per-request and existing RLS works unchanged.
-- IDEMPOTENT. vanilla-PG-only; never enters supabase/migrations/.

CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.jwt()
RETURNS jsonb
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT auth.jwt() ->> 'role'
$$;

CREATE OR REPLACE FUNCTION auth.email()
RETURNS text
LANGUAGE sql STABLE
AS $$
  SELECT auth.jwt() ->> 'email'
$$;

-- Optional shim for the 3 nullable FKs to auth.users (audit §1). The vanilla-PG identity
-- adapter populates id; the FKs are ON DELETE SET NULL so an empty table is harmless.
CREATE TABLE IF NOT EXISTS auth.users (
  id uuid PRIMARY KEY,
  email text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- RLS policies call auth.uid()/auth.jwt() AS the request role (anon/authenticated), so those
-- roles need schema USAGE + EXECUTE — Supabase grants this by default; replicate it here.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.jwt(), auth.uid(), auth.role(), auth.email()
  TO anon, authenticated, service_role;
