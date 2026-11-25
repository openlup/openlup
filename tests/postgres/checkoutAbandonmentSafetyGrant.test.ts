import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions, type QualifiedPostgresInstallation } from "../../server/adapters/postgres/qualifiedInstall.js";
import type { PlatformMigrationPlan } from "../../scripts/platform-migration-manifest.js";
import { closePostgres, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";

const manifest: PlatformMigrationPlan = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const grant = manifest.forward.find(({ file }) => file.endsWith("_checkout_abandonment_safety_execute_grant.sql"));
const grantSql = grant && readFileSync(grant.file, "utf8");
const predicate = "public.commerce_initial_checkout_abandonment_safe(uuid)";
const password = "synthetic-abandonment-grant";
type Query = Pick<Pool, "query">;

/** Direct ACL entries and effective EXECUTE for the roles that exist. */
async function privileges(db: Query) {
  const { rows: [row] } = await db.query(`SELECT p.proacl::text AS acl, pg_get_functiondef(p.oid) AS definition,
      (SELECT jsonb_object_agg(r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE'))
        FROM pg_roles r WHERE r.rolname = ANY($2::text[])) AS execute
    FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [predicate, ["anon", "authenticated", "service_role", "abandonment_plain"]]);
  return row as { acl: string; definition: string; execute: Record<string, boolean> };
}

async function withContainer(name: string, work: (url: (role: string) => string, pool: (url: string, options?: string) => Pool) => Promise<void>) {
  const container = await runPostgresContainer({ name: `${name}-${process.pid}`, password });
  const pools: Pool[] = [];
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const url = (role: string) => { const target = new URL(container.connectionString); target.username = role; return target.toString(); };
    await work(url, (connectionString, options) => { const created = new Pool({ connectionString, options }); pools.push(created); return created; });
  } finally { await closePostgres(container, pools); }
}

it("registers the abandonment safety grant once, after the predicate's last definition", () => {
  const files = manifest.forward.map(({ file }) => file);
  expect(files.filter(file => file.endsWith("_checkout_abandonment_safety_execute_grant.sql"))).toHaveLength(1);
  const definition = files.indexOf("db/platform/migrations/20261114100000_payment_provider_attempt_store.sql");
  expect(definition).toBeGreaterThanOrEqual(0);
  expect(files.indexOf(grant!.file)).toBeGreaterThan(definition);
});

it.each([false, true])("replays the abandonment safety grant on a legacy chain (service_role present: %s)", async service => {
  await withContainer(`abandonment-grant-legacy-${service}`, async (url, pool) => {
    const bootstrap = pool(url("postgres"));
    if (service) await bootstrap.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
    // Without service_role the conditional block is a no-op and the chain completes.
    for (const unit of [manifest.baseline, ...manifest.forward]) await bootstrap.query(readFileSync(unit.file, "utf8"));
    await bootstrap.query("CREATE ROLE abandonment_plain NOLOGIN");
    const applied = await privileges(bootstrap);
    expect(applied.execute.abandonment_plain).toBe(false);
    if (service) expect(applied.execute.service_role).toBe(true);
    else expect(applied.execute.service_role).toBeUndefined();
    // No PUBLIC entry: an ACL item that starts with "=".
    expect(applied.acl).not.toMatch(/[{,]=/u);
    // Applying the forward again changes nothing.
    await bootstrap.query(grantSql!);
    expect(await privileges(bootstrap)).toEqual(applied);
    // A later CREATE OR REPLACE of the same function keeps its grants.
    await bootstrap.query(applied.definition);
    expect(await privileges(bootstrap)).toEqual(applied);
  });
}, postgresSetupTimeoutMs);

it("lets the qualified runtime login evaluate the abandonment safety predicate through service_role", async () => {
  await withContainer("abandonment-grant-qualified", async (url, pool) => {
    const bootstrap = pool(url("postgres"));
    for (const role of ["starter_runtime", "starter_restore"]) {
      await bootstrap.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    const installation: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
      bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "starter_runtime", restoreLogin: "starter_restore" };
    const migrator = pool(url("postgres"), qualifiedPostgresStartupOptions(installation));
    await createPostgresMigrationRunner({ connectionString: url("postgres") }, { installation, poolFactory: () => migrator }).apply();
    const runtime = pool(url("starter_runtime"));
    expect((await runtime.query("SELECT current_user AS role")).rows).toEqual([{ role: "starter_runtime" }]);
    expect((await runtime.query(`SELECT public.commerce_initial_checkout_abandonment_safe('00000000-0000-4000-8000-000000000001'::uuid) AS safe`)).rows)
      .toEqual([{ safe: true }]);
    const installed = await privileges(bootstrap);
    expect(installed.execute).toMatchObject({ anon: false, authenticated: false, service_role: true });
  });
}, postgresSetupTimeoutMs);
