import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest, sha256, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { readReviewedForwardRegistry } from "../../scripts/reviewed-platform-forward.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Complete native catalogue required");
const own = manifest.forward.findIndex(entry => entry.file.endsWith("_order_money_v2_storage.sql"));
if (own < 0) throw new Error("Order money storage forward missing");
const unit = manifest.forward[own]!;
const sql = readFileSync(unit.file, "utf8");
const fixture = readFileSync("tests/postgres/fixtures/orderMoneyV2Storage/replayed.sql", "utf8");
const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));

let container: PostgresContainer | undefined, pool: Pool | undefined;
beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `order-money-storage-pgtap-${process.pid}`, password: "synthetic-conformance" });
  const url = new URL(container.connectionString);
  url.username = "supabase_admin";
  const bootstrap = new Pool({ connectionString: url.toString() });
  try {
    await bootstrap.query(`DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE;
      DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role`);
    await bootstrap.query("CREATE DATABASE order_money_storage WITH TEMPLATE template0");
  } finally { await bootstrap.end(); }
  // The image supplies pgTAP. The blank database supplies native defaults.
  url.pathname = "/order_money_storage";
  pool = new Pool({ connectionString: url.toString() });
  await pool.query("CREATE SCHEMA extensions; CREATE EXTENSION pgtap WITH SCHEMA extensions");
  for (const entry of [manifest.baseline, ...manifest.forward.slice(0, own)]) {
    const body = readFileSync(entry.file, "utf8");
    expect(sha256(body)).toBe(entry.sha256);
    await pool.query(body);
  }
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

async function tap(db: PoolClient) {
  const results = await db.query(fixture);
  return (Array.isArray(results) ? results : [results]).flatMap(result =>
    result.rows.flatMap(row => Object.values(row).filter((value): value is string => typeof value === "string")));
}

it.each([true, false])("installs the exact storage contract in PostgreSQL with optional roles present=%s", async roles => {
  const db = await pool!.connect();
  try {
    await db.query("BEGIN; SET LOCAL search_path=public,extensions");
    if (!roles) await db.query("DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
    expect((await db.query("SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname")).rows)
      .toEqual(roles ? [{ rolname: "anon" }, { rolname: "authenticated" }, { rolname: "service_role" }] : []);
    const supportedRoles = roles ? "PUBLIC, anon, authenticated, service_role" : "PUBLIC";
    // Grant application defaults on purpose so each narrowing statement must work.
    await db.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO ${supportedRoles}`);
    expect(sha256(sql)).toBe(unit.sha256);
    expect(registry.nativeStoreForwards?.find(pin => pin.path === unit.file)?.sha256).toBe(unit.sha256);

    if (roles) {
      // Temporarily disabled each revoke in a disposable database before installing the exact forward.
      const revokeMutations = [
        /^REVOKE ALL ON TABLE public\.commerce_order_tax_snapshots FROM PUBLIC;$/mu,
        ...["anon", "authenticated", "service_role"].map(role =>
          new RegExp(`DO \\$\\$ BEGIN IF EXISTS \\(SELECT 1 FROM pg_roles WHERE rolname='${role}'\\) THEN[\\s\\S]*?END IF; END; \\$\\$;`, "u")),
      ];
      for (const revoke of revokeMutations) {
        const mutated = sql.replace(revoke, "");
        expect(mutated).not.toBe(sql);
        await db.query("SAVEPOINT mutation");
        try {
          await db.query(mutated);
          expect((await tap(db)).filter(line => /^not ok /u.test(line))).toContainEqual(
            expect.stringContaining("table and column ACLs are owner-only"));
        } finally { await db.query("ROLLBACK TO SAVEPOINT mutation; RELEASE SAVEPOINT mutation"); }
      }
    }

    await db.query(sql);
    if (roles) {
      const mutations = [
        ["ALTER TABLE public.commerce_order_tax_snapshots DISABLE ROW LEVEL SECURITY", "non-FORCE RLS and zero policies"],
        ["ALTER TABLE public.commerce_order_line_sources FORCE ROW LEVEL SECURITY", "non-FORCE RLS and zero policies"],
        ["CREATE POLICY fixture ON public.commerce_order_fee_lines USING (false)", "non-FORCE RLS and zero policies"],
        ["GRANT SELECT (order_id) ON public.commerce_order_tax_positions TO service_role", "zero table and column access"],
        ["ALTER TABLE public.commerce_order_tax_positions ADD COLUMN payload text", "complete scalar column census"],
        ["ALTER TABLE public.commerce_orders ALTER COLUMN money_version SET DEFAULT 'example'", "incumbent additions are nullable"],
        ["ALTER TABLE public.commerce_order_items ALTER COLUMN line_key SET DEFAULT 'example'", "incumbent additions are nullable"],
        ["ALTER TABLE public.commerce_order_line_sources DROP CONSTRAINT commerce_order_line_sources_order_id_source_ordinal_key", "primary and unique keys"],
        ["DROP INDEX public.commerce_order_tax_positions_final_key", "final-only unique index"],
        ["ALTER TABLE public.commerce_order_tax_snapshots DROP CONSTRAINT commerce_order_money_v2_snapshots_accepted_quote_key", "named consumption keys"],
        ["ALTER TABLE public.commerce_order_tax_snapshots DROP CONSTRAINT commerce_order_money_v2_snapshots_calculation_key", "named consumption keys"],
        ["ALTER TABLE public.commerce_orders ALTER CONSTRAINT commerce_orders_money_snapshot_fkey NOT DEFERRABLE", "start deferred with NO ACTION"],
        ["ALTER TABLE public.commerce_order_items DROP CONSTRAINT commerce_order_items_money_source_fkey", "foreign keys link each exact target"],
      ];
      // Temporarily disabled each catalogue invariant in a disposable database.
      for (const [ddl, failure] of mutations) {
        await db.query("SAVEPOINT mutation");
        try {
          await db.query(ddl!);
          expect((await tap(db)).filter(line => /^not ok /u.test(line)), ddl).toContainEqual(expect.stringContaining(failure));
        } finally { await db.query("ROLLBACK TO SAVEPOINT mutation; RELEASE SAVEPOINT mutation"); }
      }
    }
    const results = await tap(db);
    expect(results.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(results.filter(line => /^ok \d+/u.test(line))).toHaveLength(10);
  } finally { await db.query("ROLLBACK"); db.release(); }
}, postgresSetupTimeoutMs);
