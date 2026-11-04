import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { qualifiedPostgresStartupOptions } from "../../server/adapters/postgres/qualifiedInstall.js";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { allPublicRows } from "./subscriptionStockWaitCases.js";

const pairs = [
  ["fulfillment_reserve_subscription_renewal", "uuid,uuid,integer,timestamptz", "NULL,NULL,900,now()"],
  ["fulfillment_release_subscription_renewal", "uuid,uuid,text,timestamptz", "NULL,NULL,'synthetic',now()"],
  ["fulfillment_expire_subscription_renewals", "timestamptz,integer", "now(),100"],
  ["subscription_stock_wait_admit", "jsonb,jsonb,timestamptz", "'{}'::jsonb,'{}'::jsonb,now()"],
  ["subscription_stock_wait_recover_refusal", "uuid,text,text,timestamptz", "NULL,'synthetic','synthetic',now()"],
  ["subscription_stock_wait_deficits", "jsonb,uuid,timestamptz", "'{}'::jsonb,NULL,now()"],
] as const;
const installation = { generation: "qualified-v2", roleMode: "installer-managed", bootstrapLogin: "postgres", migrationLogin: "postgres", runtimeLogin: "renewal_gate_runtime", restoreLogin: "renewal_gate_restore" } as const;
const forward = readFileSync("db/platform/migrations/20261101230000_subscription_renewal_terminal_replay.sql", "utf8");
let container: PostgresContainer | undefined, owner: Pool, migration: Pool, runtime: Pool;
let beforeAcl: Record<string, unknown>[], priorRuntime: Record<string, unknown>[];
async function acl(db: { query(text: string, values?: unknown[]): Promise<QueryResult> }) {
  return (await db.query(`SELECT p.oid::regprocedure::text AS signature,p.proowner::regrole::text AS owner,
    ARRAY(SELECT (CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE a.grantee::regrole::text END)||':'||a.privilege_type||':'||a.is_grantable
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a ORDER BY 1) AS privileges
    FROM pg_proc p WHERE p.oid=ANY($1::regprocedure[]) ORDER BY signature`, [pairs.map(([name, args]) => `public.${name}(${args})`)])).rows;
}
beforeAll(async () => {
  container = await runPostgresContainer({ name: `renewal-gate-${process.pid}`, password: "synthetic-conformance" });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  owner = new Pool({ connectionString: container.connectionString });
  for (const role of [installation.runtimeLogin, installation.restoreLogin]) await owner.query(`CREATE ROLE ${role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD 'synthetic-conformance'`);
  migration = new Pool({ connectionString: container.connectionString, options: qualifiedPostgresStartupOptions(installation) });
  migration.on("connect", (db: PoolClient) => {
    const query = db.query.bind(db);
    db.query = (async (text: string, values?: unknown[]) => {
      if (text === forward && !beforeAcl) {
        beforeAcl = await acl({ query });
        priorRuntime = (await query("SELECT signature,has_function_privilege('service_role',signature,'EXECUTE') AS allowed FROM unnest($1::text[]) signature", [pairs.map(([name, args]) => `public.${name}(${args})`)])).rows;
      }
      return query(text, values);
    }) as typeof db.query;
  });
  await createPostgresMigrationRunner({ connectionString: container.connectionString }, { installation, poolFactory: () => migration }).apply();
  const url = new URL(container.connectionString); url.username = installation.runtimeLogin;
  runtime = new Pool({ connectionString: url.toString(), options: "-c role=service_role" });
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres(container, [owner, migration, runtime]); }, postgresTeardownTimeoutMs);

it("preserves the prior runtime capability set through owner-only wrappers and narrows only the three named original grants", async () => {
  expect((await runtime.query("SELECT current_user,session_user,(SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname=current_user) AS elevated")).rows)
    .toEqual([{ current_user: "service_role", session_user: installation.runtimeLogin, elevated: false }]);
  expect(priorRuntime).toHaveLength(6);
  expect(priorRuntime.every(row => row.allowed)).toBe(true);
  for (const [name, args] of pairs) expect((await runtime.query("SELECT has_function_privilege(current_user,$1,'EXECUTE') AS allowed", [`public.${name}_gated(${args})`])).rows).toEqual([{ allowed: true }]);
  const after = await acl(owner);
  expect(after).toEqual(beforeAcl.map(row => ({ ...row, privileges: (row.privileges as string[]).filter(value => !(String(row.signature).startsWith("subscription_stock_wait_") && value.startsWith("service_role:"))) })));
  const wrappers = (await owner.query("SELECT prosecdef,proconfig,proowner::regrole::text AS owner,proacl::text FROM pg_proc WHERE oid=ANY($1::regprocedure[])", [pairs.map(([name, args]) => `public.${name}_gated(${args})`)])).rows;
  expect(wrappers).toHaveLength(6);
  for (const row of wrappers) {
    expect(row).toMatchObject({ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"], owner: installation.migrationLogin });
    expect(row.proacl).toContain("service_role=X/"); expect(row.proacl).not.toMatch(/(?:^|[,{])=/);
  }
});
it.each(pairs.slice(3))("refuses direct runtime execution of %s", async (name, _args, values) => {
  await expect(runtime.query(`SELECT public.${name}(${values})`)).rejects.toMatchObject({ code: "42501" });
});
it("keeps the admission helper owner-only", async () => {
  await expect(runtime.query("SELECT public.inventory_admission_try_enter()")) .rejects.toMatchObject({ code: "42501" });
});
it("records the residual PUBLIC EXECUTE on the original reserve, release and expiry routines", async () => {
  for (const [name, args] of pairs.slice(0, 3)) {
    expect((await owner.query(`SELECT EXISTS(SELECT 1 FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=$1::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS allowed`, [`public.${name}(${args})`])).rows).toEqual([{ allowed: true }]);
  }
});
it.each(pairs)("fences %s before every delegated write while admission is busy", async (name, _args, values) => {
  const db = await owner.connect(), before = await allPublicRows(owner);
  try {
    await db.query("BEGIN"); await db.query("SELECT pg_advisory_xact_lock(846832106,1)");
    await expect(runtime.query(`SELECT public.${name}_gated(${values})`)).rejects.toMatchObject({ code: "55P03", message: "inventory_admission_busy" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await allPublicRows(owner)).toEqual(before);
});
it.each(pairs)("refuses unsupported isolation in %s before every delegated write", async (name, _args, values) => {
  const db = await runtime.connect(), before = await allPublicRows(owner);
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    await expect(db.query(`SELECT public.${name}_gated(${values})`)).rejects.toMatchObject({ code: "22023", message: "inventory_admission_isolation_unsupported" });
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await allPublicRows(owner)).toEqual(before);
});
