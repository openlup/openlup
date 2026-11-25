import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest, sha256, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { expectSqlError, foreignKeyMessage, rejected } from "./orderMoneyV2Storage.fixture.js";
import { insertReceipt, lookup, receipts, vectorOwner } from "./orderDraftReceiptsV2.fixture.js";

const manifest = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (manifest?.schemaVersion !== 3) throw new Error("Expected the native catalogue");
const index = manifest.forward.findIndex(unit => unit.file.endsWith("_order_draft_receipts_v2.sql"));
const units = manifest.forward.slice(index, index + 2);
const fixture = readFileSync("tests/postgres/fixtures/orderDraftReceiptsV2/replayed.sql", "utf8");
let container: PostgresContainer | undefined;
let pool: Pool | undefined;

beforeAll(async () => {
  expect(units.map(unit => unit.file.split("/").at(-1)?.slice(15))).toStrictEqual(
    ["order_draft_receipts_v2.sql", "order_draft_receipt_privacy_v2.sql"]);
  container = await runManagedCompatPostgres({ name: `draft-receipt-pgtap-${process.pid}`, password: "synthetic-conformance" });
  const url = new URL(container.connectionString);
  url.username = "supabase_admin";
  const bootstrap = new Pool({ connectionString: url.toString() });
  try {
    await bootstrap.query("DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role");
    await bootstrap.query("CREATE DATABASE draft_receipts WITH TEMPLATE template0");
  } finally { await bootstrap.end(); }
  url.pathname = "/draft_receipts";
  pool = new Pool({ connectionString: url.toString() });
  await pool.query("CREATE SCHEMA extensions; CREATE EXTENSION pgtap WITH SCHEMA extensions");
  for (const entry of [manifest.baseline, ...manifest.forward.slice(0, index)]) {
    const body = readFileSync(entry.file, "utf8");
    expect(sha256(body)).toBe(entry.sha256);
    await pool.query(body);
  }
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

async function runTap(db: PoolClient) {
  const result = await db.query(fixture);
  return (Array.isArray(result) ? result : [result]).flatMap(part =>
    part.rows.flatMap(row => Object.values(row).filter((value): value is string => typeof value === "string")));
}

it.each([true, false])("installs both receipt forwards with optional roles present=%s", async optional => {
  const db = await pool!.connect();
  try {
    await db.query("BEGIN; SET LOCAL search_path=public,extensions");
    if (!optional) await db.query("DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
    for (const unit of units) {
      const sql = readFileSync(unit.file, "utf8");
      expect(sha256(sql)).toBe(unit.sha256);
      await db.query(sql);
    }
    if (optional) {
      // Temporarily disabled the ACL and trigger protections in a disposable database.
      for (const [mutation, failure] of [
        [`GRANT SELECT ON public.${receipts} TO PUBLIC`, "private receipt storage"],
        [`ALTER TABLE public.${receipts} DISABLE TRIGGER commerce_order_draft_receipt_v2_erasure_check`, "exact row trigger bindings"],
        ["GRANT EXECUTE ON FUNCTION public.commerce_read_order_draft_receipt_history_v2(text) TO PUBLIC", "only the three definer entries"],
      ]) {
        await db.query("SAVEPOINT mutation");
        await db.query(mutation!);
        const result = await runTap(db);
        expect(result.filter(line => /^not ok /u.test(line))).toStrictEqual([expect.stringContaining(failure!)]);
        await db.query("ROLLBACK TO SAVEPOINT mutation; RELEASE SAVEPOINT mutation");
      }
    }
    const lines = await runTap(db);
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^ok /u.test(line))).toHaveLength(8);
    await db.query("SAVEPOINT missing_snapshot");
    await insertReceipt(db, lookup(vectorOwner()), randomUUID());
    const constraint = "commerce_order_draft_receipts_v2_order_id_fkey";
    expectSqlError(await rejected(db.query("SET CONSTRAINTS ALL IMMEDIATE")), "23503", foreignKeyMessage(receipts, constraint), constraint);
    await db.query("ROLLBACK TO SAVEPOINT missing_snapshot; RELEASE SAVEPOINT missing_snapshot");
  } finally { await db.query("ROLLBACK"); db.release(); }
}, postgresSetupTimeoutMs);
