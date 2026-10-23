/** Real portable-store subset. No managed or adopter stock-wait parity claim. */
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool, type PoolClient } from "pg";
import { z } from "zod";
import { afterAll, beforeAll, expect, it } from "vitest";
import { INVENTORY_MIGRATIONS, createInventoryBindings, createPostgresAdminInventoryPort, createPostgresRenewalReservationPort } from "@openlup/platform/inventory";
import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.js";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const AT = "2026-10-20T12:00:00.000Z";
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
const units: { file: string; sha256: string }[] = [manifest.baseline, ...manifest.forward];
let container: PostgresContainer | undefined, pool: Pool;
const prefixContainers: PostgresContainer[] = [], prefixPools: Pool[] = [];
const executor = (db: Pool | PoolClient) => ({ query: (text: string, values?: unknown[]) => db.query(text, values) });
const read = (db: Pool | PoolClient = pool) => createPostgresAdminInventoryPort(executor(db), { stockMasterProvider: "fixture", providerSchema: z.literal("fixture") }, () => AT);
const reserve = (db: Pool | PoolClient = pool) => createPostgresRenewalReservationPort(executor(db));
const runner = (db = pool, root = process.cwd()) => createPostgresMigrationRunner({ connectionString: container!.connectionString }, { root, poolFactory: () => db });

beforeAll(async () => {
  if (!await dockerAvailable()) throw new Error("Inventory native proof requires Docker PostgreSQL");
  container = await runPostgresContainer({ name: `inventory-native-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("Inventory PostgreSQL unavailable");
  pool = new Pool({ connectionString: container.connectionString });
  // Acquire the secondary fixture before any test's 60s body can begin.
  const prefix = await runPostgresContainer({ name: `inventory-native-upgrade-${process.pid}`, password: "synthetic-conformance" });
  prefixContainers.push(prefix);
  if (!await waitForPostgresTcpReady(prefix.connectionString)) throw new Error("Prefix PostgreSQL unavailable");
  prefixPools.push(new Pool({ connectionString: prefix.connectionString }));
  await runner().apply();
}, postgresSetupTimeoutMs);
afterAll(async () => { await closePostgres([container, ...prefixContainers], [pool, ...prefixPools]); }, postgresTeardownTimeoutMs);

async function fixture(quantity = 2, available = 10, at = AT) {
  const client = randomUUID(), subscription = randomUUID(), skuId = randomUUID(), source = randomUUID(), sku = `SKU-${skuId}`;
  await pool.query("INSERT INTO public.clients(id,email) VALUES ($1,$2)", [client, `${client}@example.invalid`]);
  await pool.query("INSERT INTO public.subscriptions(id,client_id,cadence_days,next_cycle_at) VALUES ($1,$2,28,$3)", [subscription, client, at]);
  await pool.query("INSERT INTO public.catalog_products(id,slug,name) VALUES ($1,$2,'Fixture')", [skuId, sku]);
  await pool.query("INSERT INTO public.catalog_skus(id,product_id,sku,title) VALUES ($1,$1,$2,'Fixture')", [skuId, sku]);
  await pool.query(`INSERT INTO public.fulfillment_stock_current(source_key,sku,total_quantity,for_sale_quantity,reserved_unavailable_quantity,inventory_class,last_synced_at,stale_after,sync_run_id,idempotency_key,operation_fingerprint)
    VALUES ($1,$2,$3,$3,0,'sellable',$4,$5,'fixture',$1,$6)`, [source, sku, available, new Date(Date.parse(at) - 3_600_000).toISOString(), "2026-10-21T12:00:00Z", "a".repeat(64)]);
  const snapshot = { contractVersion: "platform.subscription.renewal.v1", subscriptionId: subscription, scheduledAt: at, cycleNumber: 2, currency: "XXX", stockSourceKey: source, totalAmountMinor: 200, lines: [{ sku, quantity }] };
  const identity = (await pool.query("SELECT public.subscription_renewal_identity($1,$2) AS key", [subscription, at])).rows[0].key;
  const claim = async (claimedAt = at, db: Pool | PoolClient = pool) => (await db.query("SELECT public.subscription_claim_due_renewal($1,$2,$3,'fixture',300,$4) AS result", [identity, "b".repeat(64), snapshot, claimedAt])).rows[0].result;
  const operation = await claim();
  const input = { operationId: operation.operationId, claimToken: operation.claimToken, now: at, holdSeconds: 60 };
  return { subscription, skuId, source, sku, snapshot, identity, claim, operation, input };
}
async function durable(subscription: string) {
  return (await pool.query(`SELECT to_jsonb(s) AS subscription,
    (SELECT jsonb_agg(to_jsonb(c)) FROM public.subscription_cycles c WHERE c.subscription_id=s.id) AS cycles,
    (SELECT jsonb_agg(to_jsonb(o)) FROM public.commerce_orders o JOIN public.subscription_renewal_operations r ON r.id=o.renewal_operation_id WHERE r.subscription_id=s.id) AS orders
    FROM public.subscriptions s WHERE s.id=$1`, [subscription])).rows;
}

it("installs the full catalogue, binds projections 27/33 and replays the canonical ledger/object inventory", async () => {
  expect(INVENTORY_MIGRATIONS.map(unit => unit.position)).toEqual([27, 33]);
  for (const unit of INVENTORY_MIGRATIONS) {
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
it("upgrades the exact complete prefix before unit 33 without rewriting installed history", async () => {
  const resource = prefixContainers[0], upgrade = prefixPools[0];
  const root = mkdtempSync(join(tmpdir(), "inventory-prefix-"));
  try {
    // The full-install cluster owns global roles. This clean prefix cluster is
    // separate, but its raw inventory probe can roll back roles and schema before
    // the real runner installs the same immutable prefix, avoiding a third boot.
    const db = await upgrade.connect();
    let payload: string;
    try {
      await db.query("BEGIN");
      for (const unit of units.slice(0, 33)) await db.query(readFileSync(unit.file, "utf8"));
      payload = selectedCatalogProjectionPayload(await readSelectedCatalogProjection(db));
    } finally { await db.query("ROLLBACK"); db.release(); }
    const prefix = { ...manifest, forward: manifest.forward.slice(0, 32), objectInventorySha256: createHash("sha256").update(payload).digest("hex") };
    for (const unit of units.slice(0, 33)) { const path = join(root, unit.file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, readFileSync(unit.file)); }
    mkdirSync(join(root, "config")); writeFileSync(join(root, "config/platform-migration-manifest.json"), JSON.stringify(prefix));
    await runner(upgrade, root).apply();
    const before = (await upgrade.query("SELECT * FROM public.platform_schema_migrations ORDER BY position")).rows;
    expect(before).toHaveLength(33);
    expect((await runner(upgrade).apply()).applied).toEqual(units.slice(33).map(unit => unit.file));
    expect((await upgrade.query("SELECT * FROM public.platform_schema_migrations WHERE position<33 ORDER BY position")).rows).toEqual(before);
    expect((await runner(upgrade).status()).pending).toEqual([]);
    expect(await runner(upgrade).apply()).toEqual({ applied: [] });
  } finally { await closePostgres(resource, upgrade); rmSync(root, { recursive: true, force: true }); }
}, 60_000);
it("projects fresh/stale/missing stock, held/committed/expired rows and aggregate demand while refusing adjustment", async () => {
  const f = await fixture();
  const selected = createInventoryBindings({ dataKind: "postgres", executor: executor(pool), provider: { stockMasterProvider: "fixture", providerSchema: z.literal("fixture") } });
  expect(selected.readiness.ready).toBe(true);
  expect(selected.newPurchaseStockReadPort).toBeNull();
  expect(selected.unsupported.newPurchaseStockRead).toBe("inventory_native_new_purchase_stock_read_unsupported");
  const held = await reserve().reserve(f.input);
  expect((await selected.readPort!.listReservations({ status: "reserved", page: 1, pageSize: 100 })).reservations).toContainEqual(expect.objectContaining({ id: held.reservationId, status: "reserved", kind: "subscription_retry_window" }));
  const stock = await read().listStock({ skuId: f.skuId, includeZero: true, page: 1, pageSize: 10 });
  expect(stock.stock).toMatchObject([{ onHand: 10, reserved: 2, unavailable: 0, safetyStock: 0, incoming: 0, lotId: null, expiresAt: null, availableNow: 8 }]);
  await pool.query("INSERT INTO public.subscription_renewal_terms(subscription_id,currency_code,stock_source_key,settlement_channel_key,unattended_charge_authorized_at,authorization_ref) VALUES ($1,'XXX',$2,'fixture',$3,'fixture')", [f.subscription, f.source, AT]);
  await pool.query("INSERT INTO public.subscription_renewal_term_lines(subscription_id,line_ordinal,sku,quantity,unit_amount_minor) VALUES ($1,1,$2,2,100)", [f.subscription, f.sku]);
  const forecast = async () => (await read().forecastSubscriptions({ horizonDays: 60, protectionDays: 45 })).skus.find(row => row.skuId === f.skuId);
  expect(await forecast()).toMatchObject({ stockStatus: "fresh", openHardReservations: 2, sellableNow: 8, activeSubscriptionDemand30: 2, activeSubscriptionDemand45: 2, activeSubscriptionDemand60: 2, plannedSupply: 0, coverageDays: null, shortageDate: null });
  await pool.query("UPDATE public.fulfillment_stock_current SET stale_after=$2 WHERE source_key=$1", [f.source, AT]);
  expect(await forecast()).toMatchObject({ stockStatus: "stale", sellableNow: 8 });
  const request = { contractVersion: "inventory.v0" as const, requestedAt: AT, orderMode: "one_time" as const, noSplitShipment: true, minShelfLifeDays: 0, lines: [{ skuId: f.skuId, sku: f.sku, quantity: 1 }] };
  expect(await read().checkAtp(request)).toMatchObject({ status: "insufficient" });
  await pool.query("UPDATE public.fulfillment_inventory_reservations SET status='committed',expires_at=NULL WHERE id=$1", [held.reservationId]);
  expect(await forecast()).toMatchObject({ openHardReservations: 2 });
  await pool.query("UPDATE public.fulfillment_inventory_reservations SET status='expired',terminal_reason='fixture' WHERE id=$1", [held.reservationId]);
  expect(await forecast()).toMatchObject({ openHardReservations: 0 });
  await pool.query("DELETE FROM public.fulfillment_stock_current WHERE source_key=$1", [f.source]);
  expect(await forecast()).toMatchObject({ stockStatus: "missing", providerCurrentForSale: null });
  await expect(read().adjustStock({} as never)).rejects.toThrow("Direct stock is externally observed");
});
it("reserves and releases once, preserving frozen snapshots, active subscription and due identity", async () => {
  const f = await fixture(), before = await durable(f.subscription);
  const first = await reserve().reserve(f.input);
  expect(first).toMatchObject({ reserved: true, replayed: false, status: "held" });
  expect(await reserve().reserve(f.input)).toEqual({ ...first, replayed: true });
  const release = { ...f.input, reason: "fixture_release" };
  expect(await reserve().releaseReservation(release)).toMatchObject({ reason: "released", terminalReason: "fixture_release" });
  expect(await reserve().releaseReservation(release)).toMatchObject({ replayed: true, reason: "terminal" });
  expect((await pool.query("SELECT * FROM public.subscription_renewal_outcomes WHERE renewal_operation_id=$1", [f.input.operationId])).rows).toHaveLength(1);
  expect((await pool.query("SELECT cycle_snapshot FROM public.subscription_renewal_operations WHERE id=$1", [f.input.operationId])).rows[0].cycle_snapshot).toEqual(f.snapshot);
  expect(await durable(f.subscription)).toEqual(before);
});
it("expires only eligible holds, skips a locked operation and preserves committed reservations", async () => {
  // Only this case creates holds before the other cases' AT. The global expiry
  // count therefore cannot include their rows, regardless of execution order.
  const at = "2026-10-19T12:00:00.000Z", later = "2026-10-19T12:02:00.000Z";
  const f = await fixture(2, 10, at), committed = await fixture(2, 10, at);
  const before = await durable(f.subscription);
  await reserve().reserve(f.input);
  const keep = await reserve().reserve(committed.input);
  await pool.query("UPDATE public.fulfillment_inventory_reservations SET status='committed',expires_at=NULL WHERE id=$1", [keep.reservationId]);
  const db = await pool.connect();
  try {
    await db.query("BEGIN"); await db.query("SELECT 1 FROM public.subscription_renewal_operations WHERE id=$1 FOR UPDATE", [f.input.operationId]);
    expect(await reserve().expireReservations({ now: later, limit: 100 })).toBe(0);
  } finally { await db.query("ROLLBACK"); db.release(); }
  expect(await reserve().expireReservations({ now: later })).toBe(1);
  expect(await reserve().expireReservations({ now: later })).toBe(0);
  expect((await pool.query("SELECT status FROM public.fulfillment_inventory_reservations WHERE id=$1", [keep.reservationId])).rows).toEqual([{ status: "committed" }]);
  expect(await durable(f.subscription)).toEqual(before);
});
it("fences stale claims and immutable identity conflicts without changing the basket or due date", async () => {
  const f = await fixture(), before = await durable(f.subscription);
  expect(await f.claim()).toMatchObject({ acquired: false, reason: "lease_active" });
  const taken = await f.claim("2026-10-20T12:06:00Z");
  expect(taken).toMatchObject({ acquired: true, claimGeneration: 2, cycleSnapshot: f.snapshot });
  await expect(reserve().reserve({ ...f.input, now: "2026-10-20T12:06:00Z" })).rejects.toMatchObject({ code: "40001" });
  await expect(pool.query("SELECT public.subscription_claim_due_renewal($1,$2,$3,'fixture',300,$4)", [f.identity, "c".repeat(64), f.snapshot, AT])).rejects.toMatchObject({ code: "23505" });
  expect(await durable(f.subscription)).toEqual(before);
});
it("serializes competing baskets without oversell and rolls back partial reservation effects", async () => {
  const f = await fixture(6, 10), g = await fixture(6, 10);
  await pool.query("UPDATE public.subscription_renewal_operations SET cycle_snapshot=jsonb_set(jsonb_set(cycle_snapshot,'{stockSourceKey}',to_jsonb($2::text)),'{lines}', $3::jsonb) WHERE id=$1", [g.input.operationId, f.source, JSON.stringify([{ sku: f.sku, quantity: 6 }])]);
  const results = await Promise.all([reserve().reserve(f.input), reserve().reserve(g.input)]);
  expect(results.map(result => result.status).sort()).toEqual(["held", "refused"]);
  expect((await pool.query("SELECT sum(l.quantity)::int AS quantity FROM public.fulfillment_inventory_reservation_lines l JOIN public.fulfillment_inventory_reservations r ON r.id=l.reservation_id WHERE r.source_key=$1", [f.source])).rows).toEqual([{ quantity: 6 }]);
  const rollback = await fixture(), db = await pool.connect();
  try {
    await db.query("BEGIN"); expect(await reserve(db).reserve(rollback.input)).toMatchObject({ status: "held" }); await db.query("ROLLBACK");
  } finally { db.release(); }
  expect((await pool.query("SELECT state FROM public.subscription_renewal_operations WHERE id=$1", [rollback.input.operationId])).rows).toEqual([{ state: "claimed" }]);
  expect((await pool.query("SELECT * FROM public.fulfillment_inventory_reservations WHERE renewal_operation_id=$1", [rollback.input.operationId])).rows).toEqual([]);
});
it("requires explicit relation privileges under native invoker rights and refuses unauthorized writes", async () => {
  const f = await fixture();
  await pool.query("CREATE ROLE inventory_denied NOLOGIN; CREATE ROLE inventory_reader NOLOGIN; GRANT SELECT ON public.catalog_skus,public.fulfillment_stock_current,public.fulfillment_inventory_reservations,public.fulfillment_inventory_reservation_lines TO inventory_reader");
  const db = await pool.connect();
  try {
    await db.query("SET ROLE inventory_denied");
    await expect(read(db).listStock({ includeZero: true, page: 1, pageSize: 10 })).rejects.toMatchObject({ code: "42501" });
    await expect(reserve(db).reserve(f.input)).rejects.toMatchObject({ code: "42501" });
    await db.query("RESET ROLE; SET ROLE inventory_reader");
    expect((await read(db).listStock({ skuId: f.skuId, includeZero: true, page: 1, pageSize: 10 })).stock).toHaveLength(1);
    await expect(reserve(db).releaseReservation({ ...f.input, reason: "denied" })).rejects.toMatchObject({ code: "42501" });
    await expect(db.query("UPDATE public.fulfillment_stock_current SET for_sale_quantity=0")).rejects.toMatchObject({ code: "42501" });
    await db.query("RESET ROLE");
    await pool.query(`CREATE ROLE inventory_runtime NOLOGIN;
      GRANT SELECT, UPDATE ON public.subscription_renewal_operations, public.fulfillment_stock_current TO inventory_runtime;
      GRANT SELECT, INSERT, UPDATE ON public.fulfillment_inventory_reservations TO inventory_runtime;
      GRANT SELECT, INSERT ON public.fulfillment_inventory_reservation_lines, public.subscription_renewal_outcomes TO inventory_runtime;
      GRANT SELECT ON public.subscription_cycles, public.commerce_orders, public.commerce_settlement_intents TO inventory_runtime`);
    await db.query("SET ROLE inventory_runtime");
    const held = await reserve(db).reserve(f.input);
    expect(held).toMatchObject({ reserved: true, status: "held", replayed: false });
    expect(await reserve(db).reserve(f.input)).toMatchObject({ reservationId: held.reservationId, replayed: true });
    expect(await reserve(db).releaseReservation({ ...f.input, reason: "runtime_granted" })).toMatchObject({ reason: "released" });
    expect(await reserve(db).releaseReservation({ ...f.input, reason: "runtime_granted" })).toMatchObject({ replayed: true });
  } finally { await db.query("RESET ROLE"); db.release(); }
});
