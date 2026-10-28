import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";
import { captureCompatiblePostgresRows, restoreCompatiblePostgresRows, type TransferPostgresQuery, type CompatiblePostgresTable } from "@openlup/platform/portability";

let source: Pool, target: Pool;
const containers: PostgresContainer[] = [];
const pools: Pool[] = [];
beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("M14 compatible-row proof requires owned disposable PostgreSQL");
  // Separate owned clusters: the immutable auth forward creates global roles.
  // A second database in one existing cluster is an explicit install gap.
  for (const label of ["source", "target"]) {
    const container = await runPostgresContainer({ name: `m14-compatible-${label}-${process.pid}`, password: "synthetic-transfer" });
    containers.push(container);
    if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("M14 PostgreSQL unavailable");
    pools.push(new Pool({ connectionString: container.connectionString }));
  }
  [source, target] = pools;
  for (const pool of [source, target]) {
    const runner = createPostgresMigrationRunner({ connectionString: "owned-test-pool" }, { poolFactory: () => pool });
    await runner.apply();
  }
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(containers, pools), postgresTeardownTimeoutMs);

async function transaction<T>(pool: Pool, readOnly: boolean, work: (db: TransferPostgresQuery) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN");
    const result = await work({ query: (sql, values) => client.query(sql, values ? [...values] : undefined) });
    await client.query("COMMIT"); return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
const snapshot = { withSnapshot: <T>(work: (db: TransferPostgresQuery) => Promise<T>) => transaction(source, true, work) };
const destination = { withTransaction: <T>(work: (db: TransferPostgresQuery) => Promise<T>) => transaction(target, false, work) };
const catalogueId = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")).objectInventorySha256 as string;
const capture = (tables: CompatiblePostgresTable[]) => captureCompatiblePostgresRows({ source: snapshot, sourceId: "owned-native-source", catalogueId, tables, maximumRows: 1000, maximumBytes: 1024 * 1024 });

it("moves compatible canonical rows atomically, preserves clocks/money/duties and resumes exact replay without touching the target catalogue", async () => {
  const client = randomUUID(), subscription = randomUUID(), event = randomUUID(), outbox = randomUUID();
  // Clients already exist identically: their canonical INSERT trigger is not
  // an import-safe history path. The transport must refuse copying that table.
  for (const pool of [source, target]) await pool.query("INSERT INTO public.clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
  await source.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES($1,$2,28,'2027-01-01T12:00:00.123456Z')", [subscription, client]);
  await source.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key,payload) VALUES($1,$2,'imported-history','history-key','{\"large\":9007199254740993}')", [event, subscription]);
  await source.query(`INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref)
    VALUES($1,'XXX','synthetic-stock','synthetic-channel','2026-10-26T12:00:00.654321Z','frozen-mandate')`, [subscription]);
  await source.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES($1,1,'synthetic-sku',1,9007199254740993)", [subscription]);
  await source.query(`INSERT INTO public.outbox_events(id,aggregate_type,aggregate_id,event_type,idempotency_key,payload,status,attempts)
    VALUES($1,'subscription',$2,'synthetic.owed','original-key','{"unknownEffect":true}','processing',3)`, [outbox, subscription]);
  const beforeLedger = (await target.query("SELECT to_jsonb(t)::text AS value FROM public.platform_schema_migrations t ORDER BY position")).rows;
  const beforeAcl = (await target.query("SELECT relname,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname")).rows;
  const tables: CompatiblePostgresTable[] = ["subscriptions", "subscription_events", "subscription_renewal_terms", "subscription_renewal_term_lines", "outbox_events"];
  const packet = await capture(tables);
  expect(packet.tables.find(table => table.table === "subscription_renewal_term_lines")?.rows.join("")).toContain("9007199254740993");
  expect(packet.tables.find(table => table.table === "subscriptions")?.rows.join("")).toContain("123456");
  const copyStarted = performance.now();
  const first = await restoreCompatiblePostgresRows({ target: destination, catalogueId, packet });
  const copyMs = performance.now() - copyStarted;
  expect(first.inserted).toBe(5);
  for (const table of tables) {
    // Independent row census; no JS Date or numeric deserialization.
    const sql = `SELECT to_jsonb(t)::text AS value FROM public.${table} t`;
    expect((await target.query(sql)).rows.map(row => row.value).sort()).toEqual((await source.query(sql)).rows.map(row => row.value).sort());
  }
  const tupleVersions = (await target.query("SELECT xmin::text FROM public.subscriptions WHERE id=$1", [subscription])).rows;
  const resumeStarted = performance.now();
  expect(await restoreCompatiblePostgresRows({ target: destination, catalogueId, packet })).toEqual({ inserted: 0, replayed: 5, sha256: packet.sha256 });
  console.info(`M14 local selected-row recovery rows=5 missing=0 bytes=${packet.tables.reduce((total, table) => total + table.rows.reduce((bytes, row) => bytes + Buffer.byteLength(row), 0), 0)} copyMs=${copyMs.toFixed(2)} replayMs=${(performance.now() - resumeStarted).toFixed(2)}`);
  expect((await target.query("SELECT xmin::text FROM public.subscriptions WHERE id=$1", [subscription])).rows).toEqual(tupleVersions);
  expect((await target.query("SELECT status,next_cycle_at::text FROM public.subscriptions WHERE id=$1", [subscription])).rows[0]).toMatchObject({ status: "active", next_cycle_at: "2027-01-01 12:00:00.123456+00" });
  expect((await target.query("SELECT status,attempts,payload FROM public.outbox_events WHERE id=$1", [outbox])).rows[0]).toEqual({ status: "processing", attempts: 3, payload: { unknownEffect: true } });
  expect((await target.query("SELECT to_jsonb(t)::text AS value FROM public.platform_schema_migrations t ORDER BY position")).rows).toEqual(beforeLedger);
  expect((await target.query("SELECT relname,relacl::text FROM pg_class WHERE relnamespace='public'::regnamespace ORDER BY relname")).rows).toEqual(beforeAcl);
  // Source catch-up may append compatible history. A changed retained row
  // refuses the whole new packet, including that new history.
  const secondEvent = randomUUID();
  await source.query("INSERT INTO public.subscription_events(id,subscription_id,event_type,idempotency_key) VALUES($1,$2,'later-history','later-key')", [secondEvent, subscription]);
  await source.query("UPDATE public.subscription_renewal_term_lines SET unit_amount_minor=42 WHERE subscription_id=$1", [subscription]);
  await expect(restoreCompatiblePostgresRows({ target: destination, catalogueId, packet: await capture(tables) })).rejects.toMatchObject({ code: "target_conflict", table: "subscription_renewal_term_lines" });
  expect((await target.query("SELECT 1 FROM public.subscription_events WHERE id=$1", [secondEvent])).rows).toEqual([]);
  expect((await target.query("SELECT unit_amount_minor::text FROM public.subscription_renewal_term_lines WHERE subscription_id=$1", [subscription])).rows[0].unit_amount_minor).toBe("9007199254740993");
});

it("refuses history-producing canonical INSERT triggers, schema drift, unbounded input and migration-ledger copying", async () => {
  const clientPacket = await capture(["clients"]);
  await expect(restoreCompatiblePostgresRows({ target: destination, catalogueId, packet: clientPacket })).rejects.toMatchObject({ code: "insert_trigger_requires_owner", table: "clients" });
  const cyclePacket = await capture(["subscription_cycles"]);
  await expect(restoreCompatiblePostgresRows({ target: destination, catalogueId, packet: cyclePacket })).rejects.toMatchObject({ code: "insert_trigger_requires_owner", table: "subscription_cycles" });
  const orderPacket = await capture(["commerce_orders"]);
  await expect(restoreCompatiblePostgresRows({ target: destination, catalogueId, packet: orderPacket })).rejects.toMatchObject({ code: "insert_trigger_requires_owner", table: "commerce_orders" });
  const packet = await capture(["subscriptions"]);
  await expect(restoreCompatiblePostgresRows({ target: destination, catalogueId: "different-selected-catalogue", packet })).rejects.toMatchObject({ code: "schema_conflict" });
  await expect(captureCompatiblePostgresRows({ source: snapshot, sourceId: "source", catalogueId, tables: ["platform_schema_migrations" as CompatiblePostgresTable], maximumRows: 10, maximumBytes: 1024 })).rejects.toMatchObject({ code: "unsupported_table" });
  await expect(captureCompatiblePostgresRows({ source: snapshot, sourceId: "source", catalogueId, tables: ["subscriptions"], maximumRows: 10001, maximumBytes: 1024 })).rejects.toMatchObject({ code: "invalid_input" });
});
