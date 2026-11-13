import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
beforeAll(async () => {
  // Reuse the pinned extension-enabled PostgreSQL supply for the native pgTAP twins.
  container = await runManagedCompatPostgres({ name: `provider-native-pgtap-${process.pid}`, password: "synthetic-conformance" });
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  db = await pool.connect();
  // The native actor forward creates its own groups. Remove the extension
  // helper's managed groups so this suite executes the native SQL unchanged.
  await db.query("DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) await db.query(readFileSync(unit.file, "utf8"));
  await db.query("CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions; SET search_path=public,extensions");
  await db.query(readFileSync("tests/postgres/fixtures/paymentProvider/setup.sql", "utf8"));
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

it.each([
  ["durability.sql", 43], ["blockedPreflight.sql", 9], ["eventFingerprint.sql", 8], ["zeroAmountAndAttribution.sql", 44],
  ["notChargeableCleanup.sql", 13],
  ["terminalizedCycle.sql", 104],
  ["intentReplay.sql", 4], ["duplicateFailure.sql", 3],
] as const)("retains the native assertions in %s", async (file, count) => {
  try {
    const response = await db.query(readFileSync(`tests/postgres/fixtures/paymentProvider/${file}`, "utf8"));
    const results = Array.isArray(response) ? response : [response];
    const lines = results.flatMap(result => result.rows.flatMap((row: Record<string, unknown>) => Object.values(row).filter((value): value is string => typeof value === "string")));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^(?:ok|not ok) \d+/u.test(line))).toHaveLength(count);
  } finally { await db.query("ROLLBACK"); }
});
