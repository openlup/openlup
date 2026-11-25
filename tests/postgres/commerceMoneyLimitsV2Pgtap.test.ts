import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Expected the complete native catalogue.");
const routines = [
  "public.commerce_money_limits_v2_validate(jsonb)",
  "public.commerce_money_limits_read_v2(text,text,text,text,text,text,text)",
  "public.commerce_money_limits_v2_guard()",
];
const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
const slot = registry.nativeStoreForwardClass?.slots.find(entry => entry.createdFunctions.some(fn => fn.signature === routines[0]));
if (!slot) throw new Error("Payment limits forward is missing from the native slot registry.");
const position = manifest.forward.findIndex(unit => unit.file === slot.path);
if (position < 0) throw new Error("Payment limits forward is missing from the native plan.");
const unit = manifest.forward[position]!;
const sql = readFileSync(unit.file, "utf8");
const fixture = readFileSync("tests/postgres/fixtures/commerceMoneyLimitsV2/replayed.sql", "utf8");

let container: PostgresContainer | undefined, pool: Pool | undefined;
beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `money-limits-pgtap-${process.pid}`, password: "synthetic-conformance" });
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  await pool.query(`DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE;
    DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role;
    CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions`);
  for (const entry of [manifest.baseline, ...manifest.forward.slice(0, position)]) {
    const body = readFileSync(entry.file, "utf8");
    expect(createHash("sha256").update(body).digest("hex")).toBe(entry.sha256);
    await pool.query(body);
  }
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

const acl = `SELECT a.grantee,a.grantor,a.privilege_type,a.is_grantable
  FROM pg_class c CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
  WHERE c.oid=$1::regclass AND a.grantee<>c.relowner ORDER BY a.grantee,a.grantor,a.privilege_type,a.is_grantable`;
async function tap(db: PoolClient) {
  const results = await db.query(fixture);
  return (Array.isArray(results) ? results : [results]).flatMap(result =>
    result.rows.flatMap(row => Object.values(row).filter((value): value is string => typeof value === "string")));
}

it.each([true, false])("replays the exact routine and role contracts with optional roles present=%s", async roles => {
  const db = await pool!.connect();
  try {
    await db.query("BEGIN; SET LOCAL search_path=public,extensions");
    if (!roles) await db.query("DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
    await db.query(`CREATE TABLE public.money_limits_acl_control (id integer);
      CREATE FUNCTION public.money_limits_acl_control() RETURNS integer LANGUAGE sql AS 'SELECT 1';
      REVOKE ALL ON TABLE public.money_limits_acl_control FROM PUBLIC;
      REVOKE ALL ON FUNCTION public.money_limits_acl_control() FROM PUBLIC`);
    if (roles) await db.query(`REVOKE ALL ON TABLE public.money_limits_acl_control FROM anon,authenticated,service_role;
      REVOKE ALL ON FUNCTION public.money_limits_acl_control() FROM anon,authenticated,service_role`);
    expect(createHash("sha256").update(sql).digest("hex")).toBe(unit.sha256);
    expect(registry.nativeStoreForwards?.find(pin => pin.path === unit.file)?.sha256).toBe(unit.sha256);
    await db.query(sql);
    expect((await db.query(acl, ["public.commerce_money_limits_v2"])).rows)
      .toEqual((await db.query(acl, ["public.money_limits_acl_control"])).rows);

    if (roles) {
      const mutations = [
        ...routines.flatMap((routine, index) => [`ALTER FUNCTION ${routine} RESET search_path`,
          `ALTER FUNCTION ${routine} ${index === 2 ? "STABLE" : "VOLATILE"}`,
          `ALTER FUNCTION ${routine} SECURITY ${index === 1 ? "INVOKER" : "DEFINER"}`]
          .map(ddl => ({ ddl, expected: "the exact three routine headers and attributes are installed" }))),
        { ddl: `REVOKE EXECUTE ON FUNCTION ${routines[1]} FROM service_role`, expected: "only service_role can execute the reader" },
        { ddl: `GRANT EXECUTE ON FUNCTION ${routines[0]} TO PUBLIC`, expected: "routine ACLs match the administrative default and scoped reader grant" },
        { ddl: "GRANT SELECT (currency) ON public.commerce_money_limits_v2 TO service_role", expected: "application roles have zero effective table and column access" },
        { ddl: "GRANT SELECT ON public.commerce_money_limits_v2 TO anon", expected: "application roles have zero effective table and column access" },
        { ddl: "ALTER TABLE public.commerce_money_limits_v2 DISABLE ROW LEVEL SECURITY", expected: "private relation has non-FORCE RLS and zero policies" },
        { ddl: "ALTER TABLE public.commerce_money_limits_v2 DISABLE TRIGGER commerce_money_limits_v2_guard", expected: "the guard runs before row update or delete" },
      ];
      // Temporarily disabled each pinned routine attribute, access boundary and trigger in a disposable database.
      for (const { ddl, expected } of mutations) {
        await db.query("SAVEPOINT mutation");
        const lines = await (async () => { await db.query(ddl); return tap(db); })();
        expect(lines.filter(line => /^not ok /u.test(line)), ddl).toContainEqual(expect.stringContaining(expected));
        await db.query("ROLLBACK TO SAVEPOINT mutation; RELEASE SAVEPOINT mutation");
      }
    }

    const lines = await tap(db);
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^ok \d+/u.test(line))).toHaveLength(8);
  } finally { await db.query("ROLLBACK"); db.release(); }
}, postgresSetupTimeoutMs);

it("applies its own prefix from the prerequisite native catalogue", async () => {
  const predecessor = structuredClone(manifest);
  for (const plan of [predecessor, predecessor.qualified, predecessor.qualifiedAdmin]) {
    const own = plan.forward.findIndex(entry => entry.file === unit.file);
    expect(own).toBeGreaterThanOrEqual(0);
    plan.forward = plan.forward.slice(0, own);
  }
  const store = await withPlatformCatalog(predecessor, root => installAccountMutations("legacy", true, "money-limits-prefix", root));
  try {
    const ownEntry = () => store.owner.query(`SELECT catalog_path,sha256,position FROM public.platform_schema_migrations WHERE position=$1`, [position + 1]);
    expect((await ownEntry()).rows).toEqual([]);
    expect((await store.runner.apply()).applied.slice(0, 1)).toEqual([unit.file]);
    expect((await ownEntry()).rows).toEqual([{ catalog_path: unit.file, sha256: unit.sha256, position: position + 1 }]);
  } finally { await store.close(); }
}, postgresSetupTimeoutMs);
