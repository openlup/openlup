import { readFileSync, readdirSync } from "node:fs";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readReviewedForwardRegistry, sqlSha256 } from "../../scripts/reviewed-platform-forward.js";
import { imageReference, readCiImage } from "../../scripts/ci-image-pull.mjs";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

// Working-tree behavioral proof, separate from the committed-byte CLI/catalog gates.
// Exact reviewed pins still bind every M10 unit; nothing assumes it is the last migration.
const probes = [
  ["20261024175000", "subscription_managed_atp_test.sql"],
  ["20261024180000", "subscription_stock_wait_test.sql"],
  ["20261024180000", "subscription_stock_wait_unpaid_discovery_test.sql"],
  ["20261024181000", "subscription_dunning_continuity_test.sql"],
  ["20261024182000", "subscription_list_due_for_winback_test.sql"],
  ["20261024185100", "stripe_refund_cumulative_snapshot_test.sql"],
  ["20261024185100", "order_refunded_outbox_event_test.sql"],
  ["20261024185100", "refunds_preserve_subscription_lifecycle_test.sql"],
  ["20261024180000", "subscription_continuity_delivery_alignment_test.sql"],
  ["20261024184000", "subscription_cycle_reservation_preflight_test.sql"],
] as const;
let container: PostgresContainer | undefined;
let pool: Pool;
let db: PoolClient;

beforeAll(async () => {
  const pin = readCiImage("managed-batch-postgres");
  container = await runPostgresContainer({ name: `m10-p5m-${process.pid}`, password: "synthetic-conformance",
    image: imageReference(pin, pin.sources.at(-1)) });
  expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1 });
  db = await pool.connect();
  await db.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
  for (const role of ["postgres", "supabase_admin"]) for (const scope of ["", " IN SCHEMA public"]) for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"]) {
    await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role`);
  }
  await db.query("SET ROLE postgres");
  const registry = readReviewedForwardRegistry(readFileSync("config/reviewed-platform-forwards.json"));
  const names = readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort();
  for (const [version] of probes) expect(names.some(name => name.startsWith(`${version}_`))).toBe(true);
  for (const name of names) {
    const bytes = readFileSync(`supabase/migrations/${name}`);
    const approval = registry.batchedForwards!.find(unit => unit.path === `supabase/migrations/${name}`);
    if (approval) {
      expect(sqlSha256(bytes)).toBe(approval.sha256);
      expect(bytes.equals(readFileSync(`scripts/fixtures/reviewed-m10/${approval.path}`))).toBe(true);
    }
    await db.query(bytes.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
  }
  await db.query("RESET ROLE; CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions");
  await db.query(`DO $$ DECLARE fn regprocedure; BEGIN
    FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p
      JOIN pg_depend d ON d.objid=p.oid AND d.classid='pg_proc'::regclass
      JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgtap' AND d.deptype='e'
    LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC',fn); END LOOP;
  END $$; SET ROLE postgres; SET search_path=public,extensions`);
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

it.each(probes)("managed %s behavior: %s", async (_version, file) => {
  try {
    const result = await db.query(readFileSync(`supabase/tests/${file}`, "utf8"));
    const tap = tapLines(result);
    expect(tap.length, `${file}: no pgTAP assertions`).toBeGreaterThan(1);
    expect(tap.filter(line => /^not ok |^# (?:Looks like|Failed)/u.test(line)), tap.join("\n")).toEqual([]);
    const assertions = tap.filter(line => /^ok /u.test(line));
    expect(tap.some(line => line === `1..${assertions.length}`), tap.join("\n")).toBe(true);
    process.stdout.write(`${file}: ${assertions.length} pgTAP assertions PASS\n`);
  } finally {
    await db.query("ROLLBACK; RESET ROLE; SET ROLE postgres; SET search_path=public,extensions");
  }
}, 120_000);

function tapLines(result: QueryResult | QueryResult[]): string[] {
  const results = Array.isArray(result) ? result : [result];
  return results.flatMap(part => part.rows.flatMap(row => Object.values(row)))
    .filter((value): value is string => typeof value === "string" && /^(?:ok |not ok |1\.\.|#)/u.test(value));
}

it("exact-cover managed renewal witness rejects unconditional soft-demand subtraction", async () => {
  const signature = "public.inventory_available_to_promise(uuid,timestamptz,boolean)";
  const original = (await db.query<{ body: string }>("SELECT pg_get_functiondef($1::regprocedure) AS body", [signature])).rows[0].body;
  const exemption = "CASE WHEN p_for_subscription_renewal IS TRUE THEN 0 ELSE soft_demand END";
  expect(original.split(exemption)).toHaveLength(2);
  await db.query("BEGIN");
  try {
    await db.query(original.replace(exemption, "soft_demand"));
    // Run the very same positive allocator witness, with the transaction owned
    // here so both its fixture rows and the altered function roll back together.
    const probe = readFileSync("supabase/tests/subscription_managed_atp_test.sql", "utf8")
      .replace(/^BEGIN;$/mu, "").replace(/^ROLLBACK;$/mu, "");
    const tap = tapLines(await db.query(probe));
    const failure = tap.find(line => /^not ok /u.test(line)
      && line.includes("inside-horizon: exact-cover renewal reserves its full protected quantity"));
    expect(failure, tap.join("\n")).toBeDefined();
    expect(tap.join("\n")).toContain("23514: inventory_external_provider_insufficient_available_stock");
    process.stdout.write(`Renewal-exemption mutant rejected: ${failure}\n23514: inventory_external_provider_insufficient_available_stock\n`);
  } finally {
    await db.query("ROLLBACK; RESET ROLE; SET ROLE postgres; SET search_path=public,extensions");
  }
  expect((await db.query<{ body: string }>("SELECT pg_get_functiondef($1::regprocedure) AS body", [signature])).rows[0].body).toBe(original);
}, 120_000);
