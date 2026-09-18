-- Vanilla-Postgres bootstrap: Supabase-managed extension shims (Platform Portability, W10).
--
-- The shared supabase/migrations set assumes three Supabase-managed extensions that do NOT exist in a
-- plain postgres:16 image: pg_cron (in-DB scheduler), pg_net (HTTP-from-DB), and Vault (encrypted
-- secrets). In the node-postgres bundle those responsibilities move OUT of the database to app-layer
-- ports: SchedulerPort (node-cron) replaces pg_cron, the Node host's outbox dispatch replaces
-- net.http_post, and env / a secrets manager replaces Vault. So here we create INERT, idempotent stubs
-- for the schemas + objects the migrations reference, purely so the DDL replays cleanly. The
-- MigrationRunner separately neutralizes the two `CREATE EXTENSION pg_cron|pg_net` statements (no
-- control file exists to install). These stubs are no-ops by design — they must NEVER silently take
-- over real scheduling / HTTP / secret behavior; that lives in the application layer.

CREATE SCHEMA IF NOT EXISTS cron;
CREATE SCHEMA IF NOT EXISTS net;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE SCHEMA IF NOT EXISTS extensions;

-- ---- pg_cron stub (cron.schedule / cron.unschedule) -------------------------------------------------
-- Real pg_cron registers jobs in the DB; here scheduling is owned by SchedulerPort, so these are
-- no-ops returning a synthetic job id / success. Both arities the migrations call are provided.
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
  RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE OR REPLACE FUNCTION cron.schedule(schedule text, command text)
  RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text)
  RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_id bigint)
  RETURNS boolean LANGUAGE sql AS $$ SELECT true $$;

-- ---- pg_net stub (net.http_post) -------------------------------------------------------------------
-- Real pg_net performs async HTTP from the DB; here outbound calls are owned by the Node host's outbox
-- dispatch. The stub matches pg_net's named-arg signature and returns a synthetic request id without
-- making any network call (DB-side HTTP is inert in the vanilla-pg bundle).
CREATE OR REPLACE FUNCTION net.http_post(
  url text,
  body jsonb DEFAULT '{}'::jsonb,
  params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint LANGUAGE sql AS $$ SELECT 0::bigint $$;

-- ---- Vault stub (vault.decrypted_secrets) ----------------------------------------------------------
-- Real Vault decrypts secrets stored in the DB; here secrets come from env / a secrets manager. The
-- migrations only read `SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = '...'`, so an
-- empty table satisfies the DDL replay; at runtime the DB-side HTTP triggers that read it are inert.
CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (
  id uuid,
  name text,
  description text,
  decrypted_secret text
);

-- Grant the Supabase-style roles access so SECURITY DEFINER / RLS functions that touch these stubs
-- resolve under any principal (mirrors how the managed extensions grant to anon/authenticated/service).
GRANT USAGE ON SCHEMA cron, net, vault, extensions TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA cron, net TO anon, authenticated, service_role;
GRANT SELECT ON vault.decrypted_secrets TO anon, authenticated, service_role;
