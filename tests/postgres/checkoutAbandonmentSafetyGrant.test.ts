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
const entry = "public.commerce_checkout_abandonment_safe_runtime(uuid)";
const predicate = "public.commerce_initial_checkout_abandonment_safe(uuid)";
const password = "synthetic-abandonment-grant";
type Query = Pick<Pool, "query">;

/** Direct ACL entries, definition and effective EXECUTE for the roles that exist. */
async function privileges(db: Query, signature: string) {
  const { rows: [row] } = await db.query(`SELECT p.proacl::text AS acl, pg_get_functiondef(p.oid) AS definition,
      (SELECT jsonb_object_agg(r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE'))
        FROM pg_roles r WHERE r.rolname = ANY($2::text[])) AS execute
    FROM pg_proc p WHERE p.oid = to_regprocedure($1)`, [signature, ["anon", "authenticated", "service_role", "abandonment_plain"]]);
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

it("registers the abandonment safety entry once, after the predicate's last definition", () => {
  const files = manifest.forward.map(({ file }) => file);
  expect(files.filter(file => file.endsWith("_checkout_abandonment_safety_execute_grant.sql"))).toHaveLength(1);
  const definition = files.indexOf("db/platform/migrations/20261114100000_payment_provider_attempt_store.sql");
  expect(definition).toBeGreaterThanOrEqual(0);
  expect(files.indexOf(grant!.file)).toBeGreaterThan(definition);
});

it.each([false, true])("installs the abandonment safety entry on a legacy chain (service_role present: %s)", async service => {
  await withContainer(`abandonment-grant-legacy-${service}`, async (url, pool) => {
    const bootstrap = pool(url("postgres"));
    if (service) await bootstrap.query("CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS");
    const before: Record<string, string> = {};
    // Without service_role every conditional block is a no-op and the chain completes.
    for (const unit of [manifest.baseline, ...manifest.forward]) {
      if (unit.file === grant!.file) before.predicate = (await privileges(bootstrap, predicate)).acl;
      await bootstrap.query(readFileSync(unit.file, "utf8"));
    }
    await bootstrap.query("CREATE ROLE abandonment_plain NOLOGIN");
    const installed = await privileges(bootstrap, entry);
    expect(installed.execute.abandonment_plain).toBe(false);
    if (service) expect(installed.execute.service_role).toBe(true);
    else expect(installed.execute.service_role).toBeUndefined();
    // No PUBLIC entry: an ACL item that starts with "=".
    expect(installed.acl).not.toMatch(/[{,]=/u);
    // The predicate itself keeps its ACL; only the entry is granted.
    expect((await privileges(bootstrap, predicate)).acl).toBe(before.predicate);
    if (service) expect((await privileges(bootstrap, predicate)).execute.service_role).toBe(false);
    // Repeating the grant changes nothing, and replacing the predicate leaves the entry and its grants working.
    const grantBlocks = grantSql!.split("\n").filter(line => line.startsWith("DO $$") || line.startsWith("  EXECUTE") || line.startsWith("END IF"));
    await bootstrap.query(grantBlocks.join("\n"));
    expect(await privileges(bootstrap, entry)).toEqual(installed);
    await bootstrap.query((await privileges(bootstrap, predicate)).definition);
    expect(await privileges(bootstrap, entry)).toEqual(installed);
    expect((await bootstrap.query(`SELECT public.commerce_checkout_abandonment_safe_runtime('00000000-0000-4000-8000-000000000001'::uuid) AS safe`)).rows)
      .toEqual([{ safe: true }]);
  });
}, postgresSetupTimeoutMs);

it("lets the qualified runtime login evaluate the abandonment predicate only through its entry", async () => {
  await withContainer("abandonment-grant-qualified", async (url, pool) => {
    const bootstrap = pool(url("postgres"));
    for (const role of ["starter_runtime", "starter_restore"]) {
      await bootstrap.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
        NOREPLICATION NOBYPASSRLS PASSWORD '${password}'`);
    }
    const installation: QualifiedPostgresInstallation = { generation: "qualified-v2", roleMode: "installer-managed",
      bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "starter_runtime", restoreLogin: "starter_restore" };
    const migrator = pool(url("postgres"), qualifiedPostgresStartupOptions(installation));
    const runner = createPostgresMigrationRunner({ connectionString: url("postgres") }, { installation, poolFactory: () => migrator });
    await runner.apply();
    // The ledger applies the forward once; a second apply is a no-op.
    await runner.apply();
    const runtime = pool(url("starter_runtime"));
    expect((await runtime.query("SELECT current_user AS role")).rows).toEqual([{ role: "starter_runtime" }]);
    expect((await runtime.query(`SELECT public.commerce_checkout_abandonment_safe_runtime('00000000-0000-4000-8000-000000000001'::uuid) AS safe`)).rows)
      .toEqual([{ safe: true }]);
    await expect(runtime.query(`SELECT public.commerce_initial_checkout_abandonment_safe('00000000-0000-4000-8000-000000000001'::uuid)`))
      .rejects.toMatchObject({ code: "42501" });
    expect((await privileges(bootstrap, entry)).execute).toMatchObject({ anon: false, authenticated: false, service_role: true });
  });
}, postgresSetupTimeoutMs);
