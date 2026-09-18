// Membership authority forwards against disposable PostgreSQL instances.
//
// The managed forward is deliberately applied to a minimal old-shape fixture,
// rather than to an already-current schema: that proves the ordered legacy
// backfill and the table ACL boundary on the rows it must actually preserve.
// The direct forward runs through the complete manifest runner, so the dormant
// human capability is exercised in the same catalog order an adopter receives.
// Both lanes skip loudly when a local Docker daemon is absent; they never stand
// in for a real database with a mock.

import { readFile } from "node:fs/promises";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import {
  dockerAvailable,
  runPostgresContainer,
  waitForPostgresTcpReady,
  type PostgresContainer,
} from "../helpers/postgresContainer.js";

const CONTAINER = `membership-authority-${process.pid}`;
const MANAGED_FORWARD = "supabase/migrations/20260901143000_admin_membership_authority_foundation.sql";
const FIXTURE_CLEANUP_FORWARD = "supabase/migrations/20260902090000_admin_oms_preview_fixture_cleanup.sql";
const AUDIT_ACL_FORWARD = "supabase/migrations/20260907201501_admin_audit_runtime_read_only.sql";
const DIRECT_FORWARD = "db/platform/migrations/20260901143000_admin_membership_authority_foundation.sql";
const MANAGED_DATABASE = "membership_managed";
const PLATFORM_DATABASE = "membership_platform";

const MANAGED_ADMIN = "d1000000-0000-4000-8000-000000000001";
const MANAGED_DISTRIBUTOR = "d1000000-0000-4000-8000-000000000002";
const MANAGED_MACHINE = "d1000000-0000-4000-8000-000000000003";
const FIXTURE_ADMIN = "d1000000-0000-4000-8000-000000000004";
const MISMATCH_FIXTURE_ADMIN = "d1000000-0000-4000-8000-000000000005";
const HUMAN_FIXTURE_SHAPED_ADMIN = "d1000000-0000-4000-8000-000000000006";
const ORDINARY_MACHINE_ADMIN = "d1000000-0000-4000-8000-000000000007";
const FIXTURE_EMAIL = "admin-oms-preview+fixture-run-deadbeef@example.invalid";
const MISMATCH_FIXTURE_EMAIL = "admin-oms-preview+mismatch-run-deadbeef@example.invalid";
const HUMAN_FIXTURE_SHAPED_EMAIL = "admin-oms-preview+human-run-deadbeef@example.invalid";
const ORDINARY_MACHINE_EMAIL = "ordinary-machine@example.invalid";
const DIRECT_ADMIN_A = "d2000000-0000-4000-8000-000000000001";
const DIRECT_ADMIN_B = "d2000000-0000-4000-8000-000000000002";
const DIRECT_DISTRIBUTOR = "d2000000-0000-4000-8000-000000000003";
const DIRECT_MACHINE = "d2000000-0000-4000-8000-000000000004";

let ready = false;
let managedPool: Pool | null = null;
let platformPool: Pool | null = null;
let adminPool: Pool | null = null;
let directApplied: string[] = [];
let container: PostgresContainer | null = null;

async function createPool(connectionString: string): Promise<Pool> {
  const pg = await import("pg");
  const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;
  return new PoolCtor({ connectionString });
}

beforeAll(async () => {
  if (!(await dockerAvailable())) return;

  // No POSTGRES_DB: this suite creates its own databases below, so `postgres`
  // is the only database the probe could name. That is exactly why the probe
  // must be a host-side TCP connection rather than a `docker exec` one - the
  // bootstrap server serves `postgres` over the Unix socket long before the
  // real server publishes a TCP listener. See tests/helpers/postgresContainer.ts.
  container = await runPostgresContainer({ name: CONTAINER, password: "membership" });
  const baseConnection = `postgres://postgres:membership@127.0.0.1:${container.port}`;
  if (!(await waitForPostgresTcpReady(container.connectionString))) return;

  adminPool = await createPool(`${baseConnection}/postgres`);
  await adminPool.query(`CREATE DATABASE ${MANAGED_DATABASE}`);
  await adminPool.query(`CREATE DATABASE ${PLATFORM_DATABASE}`);

  // The direct manifest owns anon/authenticated role creation. Run it before
  // constructing the old managed fixture, which only needs those roles to
  // already exist in the cluster.
  platformPool = await createPool(`${baseConnection}/${PLATFORM_DATABASE}`);
  directApplied = (await createPostgresMigrationRunner(
    { connectionString: `${baseConnection}/${PLATFORM_DATABASE}` },
    { poolFactory: () => platformPool as Pool },
  ).apply()).applied;

  await adminPool.query("CREATE ROLE service_role NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS");
  await adminPool.query("GRANT service_role TO CURRENT_USER WITH INHERIT FALSE, SET TRUE, ADMIN FALSE");

  managedPool = await createPool(`${baseConnection}/${MANAGED_DATABASE}`);
  await installManagedOldShapeFixture(managedPool);
  await managedPool.query(await readFile(MANAGED_FORWARD, "utf8"));
  await managedPool.query(await readFile(FIXTURE_CLEANUP_FORWARD, "utf8"));
  // Reproduce the inherited predecessor grant: without it an ACL denial test
  // could pass even if the new forward were never applied.
  await managedPool.query("GRANT ALL ON TABLE public.admin_audit_events TO service_role");
  const before = await managedPool.query<{ allowed: boolean }>(
    "SELECT has_table_privilege('service_role', 'public.admin_audit_events', 'DELETE') AS allowed",
  );
  expect(before.rows).toEqual([{ allowed: true }]);
  await managedPool.query(await readFile(AUDIT_ACL_FORWARD, "utf8"));
  const after = await managedPool.query<{ allowed: boolean }>(
    "SELECT has_table_privilege('service_role', 'public.admin_audit_events', 'DELETE') AS allowed",
  );
  expect(after.rows).toEqual([{ allowed: false }]);
  ready = true;
}, 180_000);

afterAll(async () => {
  await Promise.all([
    managedPool?.end().catch(() => {}),
    platformPool?.end().catch(() => {}),
    adminPool?.end().catch(() => {}),
  ]);
  await container?.remove();
});

async function installManagedOldShapeFixture(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
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
        ELSE (current_setting('request.jwt.claims', true)::jsonb ->> 'sub')::uuid
      END
    $$;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated;

    CREATE TABLE public.admin_users (
      id uuid PRIMARY KEY,
      email text NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now(),
      role text,
      is_machine_actor boolean NOT NULL DEFAULT false
    );
    ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
    CREATE POLICY admin_manage_admin_users ON public.admin_users
      FOR ALL TO authenticated USING (true) WITH CHECK (true);
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.admin_users TO authenticated, service_role;

    CREATE TABLE public.admin_audit_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      actor_admin_id uuid REFERENCES public.admin_users(id) ON DELETE RESTRICT,
      actor_email text,
      actor_kind text,
      action text NOT NULL,
      source text,
      entity_type text,
      entity_id text,
      target_admin_id uuid REFERENCES public.admin_users(id) ON DELETE RESTRICT,
      target_email text,
      old_value jsonb,
      new_value jsonb,
      idempotency_key text,
      request_id text,
      CONSTRAINT admin_audit_events_action_check CHECK (action IN ('role_change', 'invite', 'remove'))
    );
    CREATE UNIQUE INDEX admin_audit_events_entity_idempotency_key_unique
      ON public.admin_audit_events(entity_type, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE FUNCTION public.record_admin_audit_event(
      p_actor_id uuid,
      p_action text,
      p_source text,
      p_entity_type text,
      p_entity_id text,
      p_old jsonb,
      p_new jsonb,
      p_idempotency_key text DEFAULT NULL,
      p_request_id text DEFAULT NULL,
      p_target_admin_id uuid DEFAULT NULL,
      p_target_email text DEFAULT NULL
    )
    RETURNS uuid
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = pg_catalog, public
    AS $$
    DECLARE
      v_id uuid;
    BEGIN
      INSERT INTO public.admin_audit_events (
        actor_admin_id, actor_email, actor_kind, action, source,
        entity_type, entity_id, target_admin_id, target_email,
        old_value, new_value, idempotency_key, request_id
      )
      SELECT p_actor_id, admin_row.email,
             CASE WHEN admin_row.is_machine_actor THEN 'machine' ELSE 'human' END,
             p_action, p_source, p_entity_type, p_entity_id,
             p_target_admin_id, p_target_email, p_old, p_new,
             p_idempotency_key, p_request_id
      FROM public.admin_users AS admin_row
      WHERE admin_row.id = p_actor_id
      RETURNING id INTO v_id;
      RETURN v_id;
    END;
    $$;

    CREATE FUNCTION public.admin_users_prevent_last_admin_lockout()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    END;
    $$;
    CREATE TRIGGER trg_admin_users_prevent_last_admin_lockout
      BEFORE UPDATE OR DELETE ON public.admin_users
      FOR EACH ROW EXECUTE FUNCTION public.admin_users_prevent_last_admin_lockout();

    CREATE TABLE public.platform_communication_operators (
      principal_id uuid PRIMARY KEY,
      active boolean NOT NULL DEFAULT true
    );

    INSERT INTO public.admin_users (id, email, created_at, role, is_machine_actor) VALUES
      ('${MANAGED_ADMIN}', 'managed-admin@example.invalid', '2025-01-02T03:04:05Z', 'admin', false),
      ('${MANAGED_DISTRIBUTOR}', 'managed-distributor@example.invalid', '2025-01-03T03:04:05Z', 'distributor', false),
      ('${MANAGED_MACHINE}', 'managed-machine@example.invalid', '2025-01-04T03:04:05Z', 'admin', true);
  `);
}

function requirePostgres(ctx: { skip: (note?: string) => void }): void {
  if (!ready) ctx.skip("Docker or postgres:16 unavailable on this machine");
}

async function expectDatabaseError(query: Promise<unknown>, code: string, message: string): Promise<void> {
  await expect(query).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
}

async function expectDatabaseErrorAtSavepoint(
  client: PoolClient,
  query: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  await client.query("SAVEPOINT expected_database_error");
  try {
    await expectDatabaseError(query(), code, message);
  } finally {
    // PostgreSQL marks a transaction aborted after the expected statement error.
    // A savepoint is therefore part of the assertion, not a recovery shortcut:
    // it lets the next independent negative arm execute in the same role context.
    await client.query("ROLLBACK TO SAVEPOINT expected_database_error");
    await client.query("RELEASE SAVEPOINT expected_database_error");
  }
}

async function withClient<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

describe("membership authority migrations (real PostgreSQL)", () => {
  it("backfills old managed rows and keeps forged-GUC service DML outside the authority boundary", async (ctx) => {
    requirePostgres(ctx);

    const preserved = await managedPool!.query<{
      id: string;
      role: string;
      is_machine_actor: boolean;
      membership_state: string;
      membership_provenance: string;
      accepted_equals_created: boolean;
    }>(`
      SELECT id, role, is_machine_actor, membership_state, membership_provenance,
             membership_accepted_at = created_at AS accepted_equals_created
      FROM public.admin_users
      ORDER BY id
    `);
    expect(preserved.rows).toEqual([
      {
        id: MANAGED_ADMIN,
        role: "admin",
        is_machine_actor: false,
        membership_state: "active",
        membership_provenance: "legacy",
        accepted_equals_created: true,
      },
      {
        id: MANAGED_DISTRIBUTOR,
        role: "distributor",
        is_machine_actor: false,
        membership_state: "active",
        membership_provenance: "legacy",
        accepted_equals_created: true,
      },
      {
        id: MANAGED_MACHINE,
        role: "admin",
        is_machine_actor: true,
        membership_state: "active",
        membership_provenance: "legacy",
        accepted_equals_created: true,
      },
    ]);

    const humanAdmins = await managedPool!.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM public.admin_users
      WHERE membership_state = 'active' AND role = 'admin' AND is_machine_actor IS FALSE
    `);
    expect(humanAdmins.rows).toEqual([{ count: 1 }]);

    expect(await managedPool!.query(
      "SELECT has_table_privilege('service_role', 'public.admin_users', 'update') AS update_allowed, "
        + "has_table_privilege('service_role', 'public.admin_users', 'delete') AS delete_allowed",
    )).toMatchObject({ rows: [{ update_allowed: false, delete_allowed: false }] });

    await withClient(managedPool!, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE service_role");
        await client.query("SELECT set_config('app.admin_membership_revoke', 'true', true)");
        await expectDatabaseErrorAtSavepoint(client, () => client.query(`
          UPDATE public.admin_users
          SET membership_state = 'revoked',
              membership_revoked_at = clock_timestamp(),
              membership_revoked_by = '${MANAGED_ADMIN}',
              membership_revocation_reason = 'forged setting'
          WHERE id = '${MANAGED_DISTRIBUTOR}'
        `), "42501", "permission denied for table admin_users");
        await expectDatabaseErrorAtSavepoint(client, () => client.query(`
          DELETE FROM public.admin_users WHERE id = '${MANAGED_DISTRIBUTOR}'
        `), "42501", "permission denied for table admin_users");
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }
    });

    await withClient(managedPool!, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('request.jwt.claims', $1, true)", [
          JSON.stringify({ sub: MANAGED_ADMIN, role: "authenticated" }),
        ]);
        await client.query("SET LOCAL ROLE authenticated");
        const roleChanged = await client.query<{ role: string; membership_state: string }>(
          "SELECT role, membership_state FROM public.admin_update_admin_user_role($1::uuid, 'admin')",
          [MANAGED_DISTRIBUTOR],
        );
        expect(roleChanged.rows).toEqual([{ role: "admin", membership_state: "active" }]);
        await expectDatabaseErrorAtSavepoint(
          client,
          () => client.query("SELECT public.admin_revoke_admin_user($1::uuid, NULL)", [MANAGED_MACHINE]),
          "P0001",
          "machine_actor_revoke_forbidden",
        );
        const revoked = await client.query<{ membership_state: string }>(
          "SELECT membership_state FROM public.admin_revoke_admin_user($1::uuid, $2)",
          [MANAGED_DISTRIBUTOR, "operator action"],
        );
        expect(revoked.rows).toEqual([{ membership_state: "revoked" }]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });

    const roleAudit = await managedPool!.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM public.admin_audit_events
      WHERE action = 'role_change' AND target_admin_id = '${MANAGED_DISTRIBUTOR}'
    `);
    expect(roleAudit.rows).toEqual([{ count: 1 }]);

    const audit = await managedPool!.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM public.admin_audit_events
      WHERE action = 'revoke' AND target_admin_id = '${MANAGED_DISTRIBUTOR}'
    `);
    expect(audit.rows).toEqual([{ count: 1 }]);
  });

  it("cleans only an exact synthetic machine fixture through the service-role command", async (ctx) => {
    requirePostgres(ctx);

    const privileges = await managedPool!.query<{
      service_allowed: boolean;
      anon_allowed: boolean;
      authenticated_allowed: boolean;
      public_allowed: boolean;
    }>(`
      SELECT
        has_function_privilege('service_role',
          'public.admin_oms_preview_cleanup_fixture_admin(uuid, text)', 'execute') AS service_allowed,
        has_function_privilege('anon',
          'public.admin_oms_preview_cleanup_fixture_admin(uuid, text)', 'execute') AS anon_allowed,
        has_function_privilege('authenticated',
          'public.admin_oms_preview_cleanup_fixture_admin(uuid, text)', 'execute') AS authenticated_allowed,
        EXISTS (
          SELECT 1
          FROM pg_catalog.pg_proc AS proc
          CROSS JOIN LATERAL pg_catalog.aclexplode(
            COALESCE(proc.proacl, pg_catalog.acldefault('f', proc.proowner))
          ) AS acl
          WHERE proc.oid = 'public.admin_oms_preview_cleanup_fixture_admin(uuid, text)'::regprocedure
            AND acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
        ) AS public_allowed
    `);
    expect(privileges.rows).toEqual([{
      service_allowed: true,
      anon_allowed: false,
      authenticated_allowed: false,
      public_allowed: false,
    }]);

    await withClient(managedPool!, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE service_role");
        await client.query(
          "INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES ($1::uuid, $2, 'admin', true)",
          [FIXTURE_ADMIN, FIXTURE_EMAIL],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });

    await managedPool!.query(
      `INSERT INTO public.admin_users (id, email, role, is_machine_actor) VALUES
        ('${MISMATCH_FIXTURE_ADMIN}', '${MISMATCH_FIXTURE_EMAIL}', 'admin', true),
        ('${HUMAN_FIXTURE_SHAPED_ADMIN}', '${HUMAN_FIXTURE_SHAPED_EMAIL}', 'distributor', false),
        ('${ORDINARY_MACHINE_ADMIN}', '${ORDINARY_MACHINE_EMAIL}', 'admin', true);
       INSERT INTO public.admin_audit_events
         (actor_admin_id, actor_email, action, source, entity_type, entity_id, target_admin_id, target_email)
       VALUES
         ('${FIXTURE_ADMIN}', '${FIXTURE_EMAIL}', 'remove', 'test', 'fixture', 'actor', '${MANAGED_MACHINE}', 'managed-machine@example.invalid'),
         ('${MANAGED_MACHINE}', 'managed-machine@example.invalid', 'remove', 'test', 'fixture', 'target', '${FIXTURE_ADMIN}', '${FIXTURE_EMAIL}'),
         ('${MANAGED_MACHINE}', 'managed-machine@example.invalid', 'remove', 'test', 'fixture', 'unrelated', '${ORDINARY_MACHINE_ADMIN}', '${ORDINARY_MACHINE_EMAIL}');`,
    );

    await withClient(managedPool!, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE service_role");
        await client.query("SELECT public.admin_oms_preview_cleanup_fixture_admin($1::uuid, $2)", [FIXTURE_ADMIN, FIXTURE_EMAIL]);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });

    const cleanupOutcome = await managedPool!.query<{
      fixture_count: number;
      fixture_audit_count: number;
      unrelated_audit_count: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM public.admin_users WHERE id = '${FIXTURE_ADMIN}') AS fixture_count,
        (SELECT count(*)::integer FROM public.admin_audit_events
         WHERE actor_admin_id = '${FIXTURE_ADMIN}' OR target_admin_id = '${FIXTURE_ADMIN}') AS fixture_audit_count,
        (SELECT count(*)::integer FROM public.admin_audit_events
         WHERE actor_admin_id = '${MANAGED_MACHINE}' AND target_admin_id = '${ORDINARY_MACHINE_ADMIN}') AS unrelated_audit_count
    `);
    expect(cleanupOutcome.rows).toEqual([{
      fixture_count: 0,
      fixture_audit_count: 0,
      unrelated_audit_count: 1,
    }]);

    await withClient(managedPool!, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SET LOCAL ROLE service_role");
        await client.query("SELECT public.admin_oms_preview_cleanup_fixture_admin($1::uuid, $2)", [FIXTURE_ADMIN, FIXTURE_EMAIL]);
        await expectDatabaseErrorAtSavepoint(
          client,
          () => client.query(
            "SELECT public.admin_oms_preview_cleanup_fixture_admin($1::uuid, $2)",
            [MISMATCH_FIXTURE_ADMIN, "admin-oms-preview+other-run-deadbeef@example.invalid"],
          ),
          "42501",
          "admin_oms_preview_fixture_identity_mismatch",
        );
        await expectDatabaseErrorAtSavepoint(
          client,
          () => client.query(
            "SELECT public.admin_oms_preview_cleanup_fixture_admin($1::uuid, $2)",
            [HUMAN_FIXTURE_SHAPED_ADMIN, HUMAN_FIXTURE_SHAPED_EMAIL],
          ),
          "42501",
          "admin_oms_preview_fixture_cleanup_forbidden",
        );
        await expectDatabaseErrorAtSavepoint(
          client,
          () => client.query(
            "SELECT public.admin_oms_preview_cleanup_fixture_admin($1::uuid, $2)",
            [ORDINARY_MACHINE_ADMIN, ORDINARY_MACHINE_EMAIL],
          ),
          "22023",
          "admin_oms_preview_fixture_email_invalid",
        );
        await client.query("SELECT set_config('app.admin_oms_preview_fixture_cleanup', 'true', true)");
        await expectDatabaseErrorAtSavepoint(
          client,
          () => client.query("DELETE FROM public.admin_users WHERE id = $1::uuid", [MISMATCH_FIXTURE_ADMIN]),
          "42501",
          "permission denied for table admin_users",
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    });

    const refusedRows = await managedPool!.query<{ id: string }>(`
      SELECT id
      FROM public.admin_users
      WHERE id IN ('${MISMATCH_FIXTURE_ADMIN}', '${HUMAN_FIXTURE_SHAPED_ADMIN}', '${ORDINARY_MACHINE_ADMIN}')
      ORDER BY id
    `);
    expect(refusedRows.rows).toEqual([
      { id: MISMATCH_FIXTURE_ADMIN },
      { id: HUMAN_FIXTURE_SHAPED_ADMIN },
      { id: ORDINARY_MACHINE_ADMIN },
    ]);
  });

  it("runs the direct forward through the full manifest and preserves machine control authority", async (ctx) => {
    requirePostgres(ctx);
    expect(directApplied).toContain(DIRECT_FORWARD);

    await platformPool!.query(`
      INSERT INTO public.platform_control_operators (principal_id, active)
      VALUES ('${DIRECT_MACHINE}', true);
      INSERT INTO public.platform_human_principals (principal_id, email) VALUES
        ('${DIRECT_ADMIN_A}', 'direct-admin-a@example.invalid'),
        ('${DIRECT_ADMIN_B}', 'direct-admin-b@example.invalid'),
        ('${DIRECT_DISTRIBUTOR}', 'direct-distributor@example.invalid');
      INSERT INTO public.platform_human_memberships
        (principal_id, role, membership_state, membership_provenance, membership_accepted_at)
      VALUES
        ('${DIRECT_ADMIN_A}', 'admin', 'active', 'legacy', clock_timestamp()),
        ('${DIRECT_ADMIN_B}', 'admin', 'active', 'legacy', clock_timestamp()),
        ('${DIRECT_DISTRIBUTOR}', 'distributor', 'active', 'legacy', clock_timestamp());
    `);

    const machineBefore = await platformPool!.query<{ active: boolean; helper_active: boolean }>(`
      SELECT control.active,
             public.platform_control_operator_is_active(control.principal_id) AS helper_active
      FROM public.platform_control_operators AS control
      WHERE control.principal_id = '${DIRECT_MACHINE}'
    `);
    expect(machineBefore.rows).toEqual([{ active: true, helper_active: true }]);

    const firstRevoke = await platformPool!.query<{ membership_state: string }>(
      "SELECT membership_state FROM public.platform_revoke_human_membership($1::uuid, $2::uuid, $3)",
      [DIRECT_ADMIN_A, DIRECT_DISTRIBUTOR, "offboarding"],
    );
    expect(firstRevoke.rows).toEqual([{ membership_state: "revoked" }]);
    await platformPool!.query(
      "SELECT membership_state FROM public.platform_revoke_human_membership($1::uuid, $2::uuid, $3)",
      [DIRECT_ADMIN_A, DIRECT_DISTRIBUTOR, "replayed reason"],
    );

    const auditAfterReplay = await platformPool!.query<{ count: number }>(`
      SELECT count(*)::integer AS count
      FROM public.platform_human_membership_audit_events
      WHERE target_principal_id = '${DIRECT_DISTRIBUTOR}' AND action = 'revoke'
    `);
    expect(auditAfterReplay.rows).toEqual([{ count: 1 }]);

    await expectDatabaseError(
      platformPool!.query(
        "SELECT public.platform_revoke_human_membership($1::uuid, $1::uuid, NULL)",
        [DIRECT_ADMIN_A],
      ),
      "P0001",
      "platform_human_self_revoke_forbidden",
    );

    await platformPool!.query(
      "SELECT membership_state FROM public.platform_revoke_human_membership($1::uuid, $2::uuid, NULL)",
      [DIRECT_ADMIN_A, DIRECT_ADMIN_B],
    );

    await withClient(platformPool!, async (client) => {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.platform_human_membership_revoke', 'true', true)");
        await expectDatabaseError(client.query(`
          UPDATE public.platform_human_memberships
          SET membership_state = 'revoked',
              membership_revoked_at = clock_timestamp(),
              membership_revoked_by = '${DIRECT_ADMIN_B}',
              membership_revocation_reason = 'last administrator probe'
          WHERE principal_id = '${DIRECT_ADMIN_A}'
        `), "P0001", "platform_human_last_admin_lockout");
      } finally {
        await client.query("ROLLBACK").catch(() => {});
      }
    });

    const machineAfter = await platformPool!.query<{ active: boolean; helper_active: boolean }>(`
      SELECT control.active,
             public.platform_control_operator_is_active(control.principal_id) AS helper_active
      FROM public.platform_control_operators AS control
      WHERE control.principal_id = '${DIRECT_MACHINE}'
    `);
    expect(machineAfter.rows).toEqual([{ active: true, helper_active: true }]);
  });
});
