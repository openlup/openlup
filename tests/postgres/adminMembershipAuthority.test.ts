// Portable human membership and separate machine control authority against the
// complete shipped migration manifest. Managed baseline RPC/ACL/replay proof
// remains in supabase/tests/admin_membership_authority_test.sql; this suite does
// not reconstruct historical managed upgrade or fixture-cleanup migrations.

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
const DIRECT_FORWARD = "db/platform/migrations/20260901143000_admin_membership_authority_foundation.sql";
const DIRECT_ADMIN_A = "d2000000-0000-4000-8000-000000000001";
const DIRECT_ADMIN_B = "d2000000-0000-4000-8000-000000000002";
const DIRECT_DISTRIBUTOR = "d2000000-0000-4000-8000-000000000003";
const DIRECT_MACHINE = "d2000000-0000-4000-8000-000000000004";

let ready = false;
let platformPool: Pool | null = null;
let directApplied: string[] = [];
let container: PostgresContainer | null = null;

async function createPool(connectionString: string): Promise<Pool> {
  const pg = await import("pg");
  const PoolCtor = (pg.default?.Pool ?? pg.Pool) as typeof import("pg").Pool;
  return new PoolCtor({ connectionString });
}

beforeAll(async () => {
  if (!(await dockerAvailable())) return;

  container = await runPostgresContainer({ name: CONTAINER, password: "membership" });
  if (!(await waitForPostgresTcpReady(container.connectionString))) return;
  platformPool = await createPool(container.connectionString);
  directApplied = (await createPostgresMigrationRunner(
    { connectionString: container.connectionString },
    { poolFactory: () => platformPool as Pool },
  ).apply()).applied;
  ready = true;
}, 180_000);

afterAll(async () => {
  await Promise.all([
    platformPool?.end().catch(() => {}),
  ]);
  await container?.remove();
});

function requirePostgres(ctx: { skip: (note?: string) => void }): void {
  if (!ready) ctx.skip("Docker or postgres:16 unavailable on this machine");
}

async function expectDatabaseError(query: Promise<unknown>, code: string, message: string): Promise<void> {
  await expect(query).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
}

async function withClient<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await operation(client);
  } finally {
    client.release();
  }
}

describe("portable membership authority migrations (real PostgreSQL)", () => {
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
