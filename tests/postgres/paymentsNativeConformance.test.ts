/** Real portable-store subset. No managed-store parity claim. */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { PAYMENT_MIGRATIONS, createPostgresPaymentTruthPort } from "@openlup/platform/payments";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const AT = "2026-10-20T12:00:00.000Z";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const units: { file: string; sha256: string }[] = [manifest.baseline, ...manifest.forward];
let container: PostgresContainer | undefined, pool: Pool;
const prefixContainers: PostgresContainer[] = [], prefixPools: Pool[] = [];
const executor = (db: Pool | PoolClient) => ({ query: (text: string, values?: unknown[]) => db.query(text, values) });
const truth = (db: Pool | PoolClient = pool) => createPostgresPaymentTruthPort(executor(db), {
  dunningTemplateSlug: "payment_failed", recoveryUrlPath: "/recover", recoveryTemplateSlug: "payment_recovered",
});
const runner = (db = pool, root = process.cwd()) => createPostgresMigrationRunner({ connectionString: container!.connectionString }, { root, poolFactory: () => db });

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Payments native proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `payments-native-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Payments PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  // Acquire the secondary fixture before any test's 60s body can begin.
  const prefix = await runPostgresContainer({ name: `payments-native-upgrade-${process.pid}`, password: "synthetic-conformance" });
  prefixContainers.push(prefix);
  if (!await waitForPostgresTcpReady(prefix.connectionString)) throw new Error("Prefix PostgreSQL unavailable");
  prefixPools.push(new Pool({ connectionString: prefix.connectionString }));
  await runner().apply();
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres([container, ...prefixContainers], [pool, ...prefixPools]); }, postgresTeardownTimeoutMs);

it("installs the full catalogue, binds projections 10/35/56 and replays the canonical ledger/object inventory", async () => {
  expect(PAYMENT_MIGRATIONS.map(unit => unit.position)).toEqual([10, 35, 56]);
  for (const unit of PAYMENT_MIGRATIONS) {
    const bytes = readFileSync(unit.catalogPath);
    expect(readFileSync(unit.url)).toEqual(bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
    expect(units[unit.position]).toEqual({ file: unit.catalogPath, sha256: unit.sha256 });
  }
  const history = (await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
  expect(history.map(({ catalog_path, sha256, position }) => ({ file: catalog_path, sha256, position }))).toEqual(units.map((unit, position) => ({ ...unit, position })));
  expect(await runner().apply()).toEqual({ applied: [] });
  expect((await runner().status()).pending).toEqual([]);
  expect((await pool.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows).toEqual(history);
});
it("upgrades the exact complete prefix before unit 56 without rewriting installed history", async () => {
  const resource = prefixContainers[0], upgrade = prefixPools[0];
  const root = mkdtempSync(join(tmpdir(), "payments-prefix-"));
  try {
    // The full-install cluster owns global roles. This clean prefix cluster is
    // separate, but its raw inventory probe can roll back roles and schema before
    // the real runner installs the same immutable prefix, avoiding a third boot.
    const db = await upgrade.connect();
    let payload: string;
    try {
      await db.query("BEGIN");
      for (const unit of units.slice(0, 56)) await db.query(readFileSync(unit.file, "utf8"));
      payload = selectedCatalogProjectionPayload(await readSelectedCatalogProjection(db));
    } finally { await db.query("ROLLBACK"); db.release(); }
    const prefix = { ...manifest, forward: manifest.forward.slice(0, 55), objectInventorySha256: createHash("sha256").update(payload).digest("hex") };
    for (const unit of units.slice(0, 56)) { const path = join(root, unit.file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, readFileSync(unit.file)); }
    mkdirSync(join(root, "config")); writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(prefix));
    await runner(upgrade, root).apply();
    const before = (await upgrade.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
    expect(before).toHaveLength(56);
    expect((await runner(upgrade).apply()).applied).toEqual(units.slice(56).map(unit => unit.file));
    expect((await upgrade.query("SELECT * FROM public.platform_schema_migrations WHERE position<56 ORDER BY position")).rows).toEqual(before);
    expect((await runner(upgrade).status()).pending).toEqual([]);
    expect(await runner(upgrade).apply()).toEqual({ applied: [] });
  } finally { await closePostgres(resource, upgrade); rmSync(root, { recursive: true, force: true }); }
}, 60_000);

async function fixture(subscriptionDate?: string) {
  const client = randomUUID(), order = randomUUID(), intent = randomUUID();
  const subscription = randomUUID(), cycle = randomUUID();
  await pool.query("INSERT INTO public.clients(id,email) VALUES ($1,$2)", [client, `${client}@example.invalid`]);
  if (subscriptionDate) {
    await pool.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES ($1,$2,28,$3)", [subscription, client, subscriptionDate]);
    await pool.query("INSERT INTO public.subscription_cycles(id,subscription_id,scheduled_at) VALUES ($1,$2,'2026-08-01T12:00:00Z')", [cycle, subscription]);
  }
  const db = await pool.connect();
  try {
  await db.query("BEGIN");
  await db.query("INSERT INTO public.commerce_orders(id,client_id,subscription_cycle_id,currency_code,total_amount_minor) VALUES ($1,$2,$3,'XXX',900)", [order, client, subscriptionDate ? cycle : null]);
  await db.query("INSERT INTO public.commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES ($1,1,1,900,900)", [order]);
  await db.query("INSERT INTO public.commerce_settlement_intents(id,order_id,channel_key,amount_minor,currency_code,open_idempotency_key) VALUES ($1,$2,'provider-a',900,'XXX',$3)", [intent, order, `open-${intent}`]);
  await db.query("COMMIT");
  } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  const input = {
    sourceEventId: `provider-a:${intent}`, idempotencyKey: `event-${intent}`, settlementIntentId: intent,
    outcome: "captured" as const, amountMinor: 900, currency: "XXX", occurredAt: "2026-08-12T12:00:00.000Z", failure: null,
    evidence: { sourceKind: "accepted_event" as const, sourceReference: `provider-a:${intent}`,
      observedStatus: "captured", observedAt: "2026-08-12T12:00:00.000Z", payloadFingerprint: "a".repeat(64) },
  };
  return { input, order, subscription, cycle };
}

it("commits accepted truth before acknowledgement, replays once and refuses fingerprint conflict", async () => {
  const f = await fixture();
  // Simulate lost transport acknowledgement after the real committed SQL call.
  const lostAck = async () => { await truth().ingestEvent(f.input); throw new Error("ack_lost"); };
  await expect(lostAck()).rejects.toThrow("ack_lost");
  const replay = await truth().ingestEvent(f.input);
  expect(replay).toMatchObject({ event: { replayed: true, state: "settled", outcome: "captured" },
    effects: { paymentResultRecorded: true, accountingRequested: true }, financial: { orderStatus: "paid" } });
  await expect(truth().ingestEvent({ ...f.input, amountMinor: 901 })).rejects.toMatchObject({ code: "23505" });
  expect((await pool.query("SELECT * FROM public.commerce_settlement_transitions WHERE intent_id=$1", [f.input.settlementIntentId])).rows).toHaveLength(1);
  expect(await truth().readEvent(replay.event.id)).toMatchObject({ event: { replayed: false, state: "settled" } });
});
it("rolls back failed money application and caller transactions; unknown truth remains open until reconciliation", async () => {
  const f = await fixture();
  await expect(truth().ingestEvent({ ...f.input, amountMinor: 901 })).rejects.toMatchObject({ code: "22023" });
  expect((await pool.query("SELECT * FROM public.payment_truth_events WHERE source_event_id=$1", [f.input.sourceEventId])).rows).toEqual([]);
  const db = await pool.connect();
  try {
    await db.query("BEGIN"); await truth(db).ingestEvent(f.input); await db.query("ROLLBACK");
  } finally { db.release(); }
  expect((await pool.query("SELECT status FROM public.commerce_orders WHERE id=$1", [f.order])).rows).toEqual([{ status: "pending_payment" }]);
  expect(await truth().readEvent(randomUUID())).toBeNull();
  const unknown = await truth().ingestEvent({ ...f.input, outcome: "indeterminate" });
  expect(unknown).toMatchObject({ event: { state: "open", outcome: "indeterminate" }, effects: { paymentResultRecorded: false } });
  const readback = await truth().recordReconciliation({ eventId: unknown.event.id, idempotencyKey: `reconcile-${unknown.event.id}`,
    evidenceStatus: "observed", outcome: "captured", occurredAt: f.input.occurredAt, failure: null,
    evidence: { ...f.input.evidence, sourceKind: "reconciliation_read" } });
  expect(readback).toMatchObject({ event: { state: "settled" }, financial: { orderStatus: "paid" } });
  expect(await truth().sweepOpenEvents({ now: AT, limit: 100 })).toMatchObject({ claimed: 0 });
});
it("refuses an unprivileged actor and applies refused settlement without paying the order", async () => {
  const f = await fixture("2026-08-29T12:00:00Z"), db = await pool.connect();
  try {
    await pool.query("CREATE ROLE payments_denied NOLOGIN");
    await db.query("SET ROLE payments_denied");
    await expect(truth(db).ingestEvent(f.input)).rejects.toMatchObject({ code: "42501" });
    await expect(truth(db).readEvent(randomUUID())).rejects.toMatchObject({ code: "42501" });
  } finally { await db.query("RESET ROLE"); db.release(); }
  const refused = await truth().ingestEvent({ ...f.input, outcome: "refused", failure: { classification: "authorization_refused", reason: "refused" } });
  expect(refused).toMatchObject({ event: { state: "settled", outcome: "refused" }, financial: { orderStatus: "pending_payment", settlementStatus: "failed" } });
  expect(refused.effects.dunningOpened).toBe(true);
  expect((await pool.query("SELECT * FROM public.subscription_dunning_cases WHERE subscription_id=$1", [f.subscription])).rows).toHaveLength(1);
  expect((await pool.query("SELECT * FROM public.subscription_dunning_notifications WHERE case_id=(SELECT id FROM public.subscription_dunning_cases WHERE subscription_id=$1)", [f.subscription])).rows).toHaveLength(1);
  const recovered = await truth().ingestEvent({ ...f.input, sourceEventId: `${f.input.sourceEventId}:recovery`, idempotencyKey: `${f.input.idempotencyKey}:recovery` });
  expect(recovered.effects.accountingRequested).toBe(true);
  expect((await pool.query("SELECT status FROM public.subscription_dunning_cases WHERE subscription_id=$1", [f.subscription])).rows).toEqual([{ status: "recovered" }]);
});
it("serializes simultaneous identical events behind a row lock with exactly one financial effect", async () => {
  const f = await fixture(), db = await pool.connect();
  let pending: ReturnType<ReturnType<typeof truth>["ingestEvent"]> | undefined;
  try {
    await db.query("BEGIN");
    const first = await truth(db).ingestEvent(f.input);
    pending = truth().ingestEvent(f.input);
    await expect.poll(async () => Number((await pool.query(
      "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE 'SELECT public.payment_truth_ingest_event(%'",
    )).rows[0].count), { timeout: 5000 }).toBe(1);
    // The uncommitted event is invisible to a separate observer until commit.
    expect((await pool.query("SELECT * FROM public.payment_truth_events WHERE source_event_id=$1", [f.input.sourceEventId])).rows).toHaveLength(0);
    await db.query("COMMIT");
    expect(await pending).toEqual({ ...first, event: { ...first.event, replayed: true } });
  } finally { await db.query("ROLLBACK"); db.release(); await pending; }
  expect((await pool.query("SELECT * FROM public.commerce_settlement_transitions WHERE intent_id=$1", [f.input.settlementIntentId])).rows).toHaveLength(1);
});
it("shifts late cycles later once, clamps early payments and preserves an already later schedule", async () => {
  for (const [current, paidAt, expected] of [
    ["2026-08-29T12:00:00Z", "2026-08-12T12:00:00Z", "2026-09-09T12:00:00.000Z"],
    ["2026-08-29T12:00:00Z", "2026-07-31T12:00:00Z", "2026-08-29T12:00:00.000Z"],
    ["2026-10-01T12:00:00Z", "2026-08-12T12:00:00Z", "2026-10-01T12:00:00.000Z"],
  ]) {
    const f = await fixture(current), input = { ...f.input, occurredAt: paidAt };
    await truth().ingestEvent(input); await truth().ingestEvent(input);
    const row = (await pool.query("SELECT next_cycle_at FROM public.subscriptions WHERE id=$1", [f.subscription])).rows[0];
    expect(row.next_cycle_at.toISOString()).toBe(expected);
    expect((await pool.query("SELECT * FROM public.subscription_events WHERE subscription_id=$1 AND event_type='subscription.cycle_settled'", [f.subscription])).rows).toHaveLength(1);
  }
});
