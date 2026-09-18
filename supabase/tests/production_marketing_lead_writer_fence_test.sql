-- pgTAP: the exceptional production release fence closes the live configurator
-- writer race without touching subscription, order, payment or fulfillment state.

CREATE EXTENSION IF NOT EXISTS pgtap;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
CREATE TEMP TABLE writer_fence_saved_migrations AS
SELECT * FROM supabase_migrations.schema_migrations
WHERE version IN ('20260824074602', '20260824152811');
DELETE FROM supabase_migrations.schema_migrations
WHERE version IN ('20260824074602', '20260824152811');

SELECT plan(18);
SELECT extensions.dblink_connect(
  'marketing_lead_writer',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'writer_fence_bootstrap',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=postgres password=postgres'
);
SELECT extensions.dblink_connect(
  'writer_fence_service_role',
  'host=' || host(inet_server_addr()) || ' port=' || inet_server_port()
    || ' dbname=' || current_database() || ' user=authenticator password=postgres'
);
SELECT extensions.dblink_exec('writer_fence_service_role', 'SET ROLE service_role');
CREATE FUNCTION public.writer_fence_test_drain()
RETURNS integer LANGUAGE plpgsql AS $drain$
BEGIN
  LOCK TABLE public.clients IN SHARE ROW EXCLUSIVE MODE;
  RETURN 1;
END$drain$;
SELECT extensions.dblink_exec('marketing_lead_writer', 'BEGIN');
SELECT extensions.dblink_exec('marketing_lead_writer',
  $remote$INSERT INTO public.clients (id, email, acquisition_source, identity_kind)
    VALUES ('f1000000-0000-4000-8000-000000000008', 'drain-proof@example.invalid',
            'operator', 'customer')$remote$
);
SELECT extensions.dblink_send_query(
  'writer_fence_bootstrap',
  'SELECT public.writer_fence_test_drain() AS marker'
);
SELECT pg_sleep(0.1);
SELECT is(
  extensions.dblink_is_busy('writer_fence_bootstrap'),
  1,
  'the bootstrap table lock waits for a pre-existing RowExclusive writer'
);
SELECT extensions.dblink_exec('marketing_lead_writer', 'ROLLBACK');
SELECT is(
  (SELECT marker FROM extensions.dblink_get_result('writer_fence_bootstrap') AS result(marker integer)),
  1,
  'the bootstrap table lock completes only after the earlier writer drains'
);
DROP FUNCTION public.writer_fence_test_drain();
SELECT extensions.dblink_disconnect('writer_fence_bootstrap');

BEGIN;
SET LOCAL lock_timeout = '2s';
LOCK TABLE public.clients IN SHARE ROW EXCLUSIVE MODE;
-- writer-fence-install-begin
CREATE FUNCTION public.production_marketing_lead_writer_fence_v1()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO pg_catalog AS $writer_fence$
DECLARE
  old_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE pg_catalog.to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE pg_catalog.to_jsonb(NEW) END;
  old_residual boolean := TG_OP <> 'INSERT'
    AND coalesce(old_row->>'identity_kind', 'customer') = 'customer'
    AND old_row->>'acquisition_source' = 'hidden_configurator'
    AND coalesce(old_row->>'auth_user_id', '') = '';
  new_residual boolean := TG_OP <> 'DELETE'
    AND coalesce(new_row->>'identity_kind', 'customer') = 'customer'
    AND new_row->>'acquisition_source' = 'hidden_configurator'
    AND coalesce(new_row->>'auth_user_id', '') = '';
  namespace_applied boolean;
  assertion_applied boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND old_residual
     AND new_row->>'identity_kind' = 'marketing_lead'
     AND new_row->>'acquisition_source' = 'hidden_configurator'
     AND coalesce(new_row->>'marketing_contact_id', '') <> ''
     AND coalesce(new_row->>'auth_user_id', '') = ''
     AND new_row->>'email' = 'lead+' || pg_catalog.replace(old_row->>'id', '-', '')
       || '@marketing.invalid' THEN
    RETURN NEW;
  END IF;
  IF old_residual OR new_residual THEN
    IF NOT pg_catalog.pg_try_advisory_xact_lock_shared(19860825, 152811) THEN
      RAISE EXCEPTION 'production_marketing_lead_writer_fence_active'
        USING ERRCODE = '55000';
    END IF;
    SELECT pg_catalog.count(*) FILTER (WHERE version = '20260824074602') = 1,
           pg_catalog.count(*) FILTER (WHERE version = '20260824152811') = 1
      INTO namespace_applied, assertion_applied
     FROM supabase_migrations.schema_migrations
     WHERE version IN ('20260824074602', '20260824152811');
    IF assertion_applied AND NOT namespace_applied THEN
      RAISE EXCEPTION 'production_marketing_lead_writer_fence_ledger_drift'
        USING ERRCODE = '55000';
    END IF;
    IF assertion_applied THEN
      IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
      RETURN NEW;
    END IF;
    IF namespace_applied THEN
      RAISE EXCEPTION 'production_marketing_lead_assertion_pending'
        USING ERRCODE = '55000';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END$writer_fence$;
REVOKE ALL ON FUNCTION public.production_marketing_lead_writer_fence_v1()
  FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON FUNCTION public.production_marketing_lead_writer_fence_v1() IS
  'production-writer-fence-v1-sha256:b19495be8f2b4524b563b2cbbef4e5186efeeb5c3d88ef790817766d9d73316f';
CREATE TRIGGER production_marketing_lead_writer_fence_v1
BEFORE INSERT OR UPDATE OR DELETE ON public.clients
FOR EACH ROW EXECUTE FUNCTION public.production_marketing_lead_writer_fence_v1();
-- writer-fence-install-end
SELECT ok(
  pg_try_advisory_lock(19860825, 152811),
  'bootstrap owns the exclusive session lock before releasing its table lock'
);
COMMIT;

SELECT is(
  (SELECT tgtype::integer FROM pg_trigger
    WHERE tgrelid = 'public.clients'::regclass
      AND tgname = 'production_marketing_lead_writer_fence_v1'),
  31,
  'the real trigger covers row-level BEFORE INSERT/UPDATE/DELETE'
);
SELECT throws_ok(
  $$SELECT extensions.dblink_exec('marketing_lead_writer',
    $remote$INSERT INTO public.clients
      (id, email, acquisition_source, identity_kind)
    VALUES ('f1000000-0000-4000-8000-000000000001', 'fenced-one@example.invalid',
            'hidden_configurator', 'customer')$remote$)$$,
  '55000', 'production_marketing_lead_writer_fence_active',
  'a residual-shaped insert fails immediately while the release fence is active'
);
SELECT is((SELECT count(*)::integer FROM public.clients
  WHERE id = 'f1000000-0000-4000-8000-000000000001'), 0,
  'a refused insert leaves no partial client row');
SELECT lives_ok(
  $$SELECT extensions.dblink_exec('marketing_lead_writer',
    $remote$INSERT INTO public.clients (id, email, acquisition_source, identity_kind)
      VALUES ('f1000000-0000-4000-8000-000000000002', 'ordinary@example.invalid',
              'operator', 'customer')$remote$)$$,
  'ordinary customer writes do not participate in the exceptional fence'
);
SELECT lives_ok(
  $$SELECT extensions.dblink_exec('marketing_lead_writer',
    $remote$UPDATE public.clients SET first_name = 'Safe'
      WHERE id = 'f1000000-0000-4000-8000-000000000002'$remote$)$$,
  'ordinary customer updates remain available'
);

SELECT ok(pg_advisory_unlock(19860825, 152811), 'the coordinator can release the session fence');
SELECT lives_ok(
  $$SELECT extensions.dblink_exec('writer_fence_service_role',
    $remote$INSERT INTO public.clients (id, email, acquisition_source, identity_kind)
      VALUES ('f1000000-0000-4000-8000-000000000007', 'role-proof@example.invalid',
              'hidden_configurator', 'customer')$remote$)$$,
  'the definer trigger reads the private ledger for a role without ledger access'
);
SELECT extensions.dblink_exec('marketing_lead_writer',
  $remote$INSERT INTO public.clients (id, email, acquisition_source, identity_kind)
    VALUES
      ('f1000000-0000-4000-8000-000000000003', 'residual-three@example.invalid', 'hidden_configurator', 'customer'),
      ('f1000000-0000-4000-8000-000000000004', 'residual-four@example.invalid', 'hidden_configurator', 'customer')$remote$
);
SELECT pg_advisory_lock(19860825, 152811);
INSERT INTO public.communication_contacts (id, normalized_email, display_email)
VALUES ('f2000000-0000-4000-8000-000000000003', 'residual-three@example.invalid', 'residual-three@example.invalid');
SELECT lives_ok(
  $$SELECT extensions.dblink_exec('marketing_lead_writer',
    $remote$UPDATE public.clients
      SET email = 'lead+f1000000000040008000000000000003@marketing.invalid',
          identity_kind = 'marketing_lead',
          marketing_contact_id = 'f2000000-0000-4000-8000-000000000003'
      WHERE id = 'f1000000-0000-4000-8000-000000000003'$remote$)$$,
  'the exact 074602 residual-to-marketing-lead transition bypasses the fence'
);
SELECT throws_ok(
  $$SELECT extensions.dblink_exec('marketing_lead_writer',
    $remote$DELETE FROM public.clients
      WHERE id = 'f1000000-0000-4000-8000-000000000004'$remote$)$$,
  '55000', 'production_marketing_lead_writer_fence_active',
  'deleting a residual cannot change the fenced snapshot'
);
SELECT throws_ok(
  $$SELECT extensions.dblink_exec('marketing_lead_writer',
    $remote$UPDATE public.clients SET acquisition_source = 'operator'
      WHERE id = 'f1000000-0000-4000-8000-000000000004'$remote$)$$,
  '55000', 'production_marketing_lead_writer_fence_active',
  'an update leaving the residual set cannot change the fenced snapshot'
);

SELECT pg_advisory_unlock(19860825, 152811);
INSERT INTO supabase_migrations.schema_migrations
SELECT * FROM writer_fence_saved_migrations WHERE version = '20260824074602';
SELECT throws_ok(
  $$SELECT extensions.dblink_exec('marketing_lead_writer',
    $remote$INSERT INTO public.clients
      (id, email, acquisition_source, identity_kind)
    VALUES ('f1000000-0000-4000-8000-000000000005', 'partial@example.invalid',
            'hidden_configurator', 'customer')$remote$)$$,
  '55000', 'production_marketing_lead_assertion_pending',
  'a partial namespace/assertion apply remains fail-closed after coordinator loss'
);
SELECT is((SELECT count(*)::integer FROM public.clients
  WHERE id = 'f1000000-0000-4000-8000-000000000005'), 0,
  'the partial-apply refusal leaves no client row');

INSERT INTO supabase_migrations.schema_migrations
SELECT * FROM writer_fence_saved_migrations WHERE version = '20260824152811';
SELECT pg_advisory_lock(19860825, 152811);
SELECT throws_ok(
  $$SELECT extensions.dblink_exec('marketing_lead_writer',
    $remote$INSERT INTO public.clients
      (id, email, acquisition_source, identity_kind)
    VALUES ('f1000000-0000-4000-8000-000000000006', 'post-assertion@example.invalid',
            'hidden_configurator', 'customer')$remote$)$$,
  '55000', 'production_marketing_lead_writer_fence_active',
  'an assertion-ledgered residual still fails while final fenced readback is active'
);
SELECT pg_advisory_unlock(19860825, 152811);
SELECT lives_ok(
  $$SELECT extensions.dblink_exec('marketing_lead_writer',
    $remote$INSERT INTO public.clients
      (id, email, acquisition_source, identity_kind)
    VALUES ('f1000000-0000-4000-8000-000000000006', 'post-assertion@example.invalid',
            'hidden_configurator', 'customer')$remote$)$$,
  'an assertion-ledgered residual is legal only after final fence release'
);
DELETE FROM public.clients WHERE id IN (
  'f1000000-0000-4000-8000-000000000002',
  'f1000000-0000-4000-8000-000000000003',
  'f1000000-0000-4000-8000-000000000004',
  'f1000000-0000-4000-8000-000000000006',
  'f1000000-0000-4000-8000-000000000007'
);
DELETE FROM public.communication_contacts WHERE id = 'f2000000-0000-4000-8000-000000000003';
DROP TRIGGER production_marketing_lead_writer_fence_v1 ON public.clients;
DROP FUNCTION public.production_marketing_lead_writer_fence_v1();
SELECT ok(
  to_regprocedure('public.production_marketing_lead_writer_fence_v1()') IS NULL,
  'cleanup removes the exact temporary function after assertion readback'
);
SELECT extensions.dblink_disconnect('marketing_lead_writer');
SELECT extensions.dblink_disconnect('writer_fence_service_role');
SELECT * FROM finish();
