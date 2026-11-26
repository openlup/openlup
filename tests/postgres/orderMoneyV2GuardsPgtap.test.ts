import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest, sha256, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Expected native catalogue");
const index = manifest.forward.findIndex(entry => entry.file.endsWith("_order_money_v2_assert.sql"));
if (index < 0) throw new Error("Expected order money assertion forward");
const unit = manifest.forward[index]!;
const sql = readFileSync(unit.file, "utf8");
const fixture = readFileSync("tests/postgres/fixtures/orderMoneyV2Guards/replayed.sql", "utf8");
let container: PostgresContainer | undefined;
let pool: Pool | undefined;

beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `order-money-assert-pgtap-${process.pid}`, password: "synthetic-conformance" });
  const url = new URL(container.connectionString);
  url.username = "supabase_admin";
  const bootstrap = new Pool({ connectionString: url.toString() });
  try {
    await bootstrap.query("DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role");
    await bootstrap.query("CREATE DATABASE order_money_assert WITH TEMPLATE template0");
  } finally { await bootstrap.end(); }
  url.pathname = "/order_money_assert";
  pool = new Pool({ connectionString: url.toString() });
  await pool.query("CREATE SCHEMA extensions; CREATE EXTENSION pgtap WITH SCHEMA extensions");
  for (const entry of [manifest.baseline, ...manifest.forward.slice(0, index)]) {
    const body = readFileSync(entry.file, "utf8");
    expect(sha256(body)).toBe(entry.sha256);
    await pool.query(body);
  }
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

async function tap(db: PoolClient) {
  const result = await db.query(fixture);
  return (Array.isArray(result) ? result : [result]).flatMap(part =>
    part.rows.flatMap(row => Object.values(row).filter((value): value is string => typeof value === "string")));
}

it.each([true, false])("checks the installed assertion with optional writers present=%s", async optional => {
  const db = await pool!.connect();
  try {
    await db.query("BEGIN; SET LOCAL search_path=public,extensions");
    if (!optional) await db.query("DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
    expect(sha256(sql)).toBe(unit.sha256);
    await db.query(sql);
    if (optional) {
      // Temporarily disabled each routine property in a disposable database transaction.
      const signature = "public.commerce_order_money_v2_assert(uuid,boolean,boolean,jsonb,jsonb)";
      const mutants = [
        [`ALTER FUNCTION ${signature} SECURITY INVOKER`, "stable definer"],
        [`GRANT EXECUTE ON FUNCTION ${signature} TO PUBLIC`, "approved grantees"],
        [`REVOKE EXECUTE ON FUNCTION ${signature} FROM service_role`, "optional writers"],
        ["GRANT EXECUTE ON FUNCTION public.commerce_order_money_v2_live_body(uuid) TO PUBLIC", "live body reader is owner only"],
        ["GRANT EXECUTE ON FUNCTION public.commerce_order_money_v2_check_state(uuid,boolean,text,text) TO PUBLIC",
          "transaction check state helper is owner only"],
      ] as const;
      for (const [statement, failure] of mutants) {
        await db.query("SAVEPOINT mutation");
        try {
          await db.query(statement);
          expect((await tap(db)).filter(line => /^not ok /u.test(line))).toContainEqual(expect.stringContaining(failure));
        } finally { await db.query("ROLLBACK TO SAVEPOINT mutation; RELEASE SAVEPOINT mutation"); }
      }
    }
    const result = await tap(db);
    expect(result.filter(line => /^not ok/u.test(line))).toEqual([]);
    expect(result.filter(line => /^ok /u.test(line))).toHaveLength(9);
  } finally { await db.query("ROLLBACK"); db.release(); }
});
