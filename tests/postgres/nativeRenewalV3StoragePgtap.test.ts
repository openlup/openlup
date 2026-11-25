import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { transaction } from "./orderMoneyV2Storage.fixture.js";

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest;
const slot = manifest.forward.findIndex(unit => unit.file.endsWith("_native_renewal_v3_storage.sql"));
if (slot < 0) throw new Error("Renewal storage migration missing");
const sql = readFileSync(manifest.forward[slot]!.file, "utf8");
let container: PostgresContainer | undefined, pool: Pool | undefined;

beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `renewal-storage-pgtap-${process.pid}`, password: "synthetic-conformance" });
  const url = new URL(container.connectionString);
  url.username = "supabase_admin";
  const bootstrap = new Pool({ connectionString: url.toString() });
  try {
    await bootstrap.query("DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role");
    await bootstrap.query("CREATE DATABASE renewal_storage WITH TEMPLATE template0");
  }
  finally { await bootstrap.end(); }
  url.pathname = "/renewal_storage";
  pool = new Pool({ connectionString: url.toString() });
  await pool.query("CREATE SCHEMA extensions; CREATE EXTENSION pgtap WITH SCHEMA extensions");
  for (const entry of [manifest.baseline, ...manifest.forward.slice(0, slot)]) await pool.query(readFileSync(entry.file, "utf8"));
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

async function tap(db: PoolClient, roles: boolean) {
  const checks = await db.query(`SELECT plan(4);
    CREATE TEMP VIEW renewal_storage AS SELECT * FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relkind='r' AND starts_with(relname::text,'subscription_cycle_');
    SELECT ok((SELECT count(*)=11 AND bool_and(relrowsecurity AND NOT relforcerowsecurity AND relowner=current_user::regrole) FROM renewal_storage), 'ordinary owner relations enforce RLS');
    SELECT ok(NOT EXISTS (SELECT FROM renewal_storage c, LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) x
      WHERE x.grantee<>c.relowner), 'no direct table privilege escapes the owner');
    SELECT is((SELECT count(*)::int FROM pg_attribute a JOIN renewal_storage c ON c.oid=a.attrelid WHERE a.attacl IS NOT NULL), ${roles ? 1 : 0}, 'only installed census has column privileges');
    SELECT is((SELECT count(*)::int FROM pg_policy p JOIN renewal_storage c ON c.oid=p.polrelid
      WHERE p.polcmd='r' AND pg_get_expr(p.polqual,p.polrelid)='true' AND p.polwithcheck IS NULL), ${roles ? 1 : 0}, 'only installed census has a read policy');
    SELECT * FROM finish();`);
  return (Array.isArray(checks) ? checks : [checks]).flatMap(result => result.rows.flatMap(row =>
    Object.values(row).filter((value): value is string => typeof value === "string" && /^not ok /u.test(value))));
}

it.each([true, false])("narrows the installed native catalogue with optional role names present=%s", async roles => {
  await transaction(pool!, async db => {
    await db.query("SET LOCAL search_path=public,extensions");
    if (!roles) await db.query("ALTER ROLE anon RENAME TO fixture_anon; ALTER ROLE authenticated RENAME TO fixture_authenticated; ALTER ROLE service_role RENAME TO fixture_service");
    await db.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT ON TABLES TO PUBLIC");
    await db.query("SAVEPOINT mutation");
    // Temporarily disabled the occurrence PUBLIC revoke in a disposable database.
    await db.query(sql.replace("REVOKE ALL ON TABLE public.subscription_cycle_occurrences FROM PUBLIC;", ""));
    expect(await tap(db, roles)).toEqual([expect.stringContaining("not ok 2 - no direct table privilege escapes the owner")]);
    await db.query("ROLLBACK TO SAVEPOINT mutation; RELEASE SAVEPOINT mutation");
    await db.query(sql);
    expect(await tap(db, roles)).toEqual([]);
  }, "ROLLBACK");
});
